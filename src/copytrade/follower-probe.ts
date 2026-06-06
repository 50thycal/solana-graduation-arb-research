import Database from 'better-sqlite3';
import { Connection } from '@solana/web3.js';
import { getFollowListAddresses, insertProbeEvent } from './queries';
import { parseSwapForOwner } from './parse-swap';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('copy-follower-probe');

/**
 * Copy-follower LATENCY PROBE (Option B, Phase 2 pre-work).
 *
 * Subscribes to the strict follow-list wallets via Helius Enhanced WebSockets
 * `transactionSubscribe` (available on the Developer plan) and, for every swap
 * those wallets fire, records how late we detected it
 * (detection_lag_sec = our WS-notification time − the tx's on-chain block time).
 * It takes NO positions — its only job is to (a) prove the subscription works on
 * our plan and (b) quantify our latency disadvantage before building the real
 * shadow-copy executor.
 *
 * Default-ON; set COPY_FOLLOWER_DISABLED=true to turn it off. Uses Node's global
 * WebSocket (Node ≥21, no new dependency) for the Helius-specific
 * transactionSubscribe method (web3.js Connection only does logsSubscribe).
 * getParsedTransaction calls go through globalRpcLimiter so the probe never
 * starves the graduation pipeline.
 */

interface MinimalWS {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  readyState: number;
}
const WSCtor = (globalThis as unknown as { WebSocket?: new (url: string) => MinimalWS }).WebSocket;

const PROBE_STATUS_KEY = 'copy_probe_status';
const WATCHLIST_REFRESH_MS = 10 * 60 * 1000;
const MAX_RECONNECT_MS = 60_000;
const SEEN_MAX = 4096;

export class CopyFollowerProbe {
  private readonly db: Database.Database;
  private readonly getConnection: () => Connection | null;
  private ws: MinimalWS | null = null;
  private stopped = false;
  private watchlist: string[] = [];
  private subRequestId = 1;
  private subId: number | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchlistTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private seen = new Map<string, number>();
  private totalNotifications = 0;
  private totalEvents = 0;
  private lastEventAt: number | null = null;
  private connected = false;

  constructor(opts: { db: Database.Database; getConnection: () => Connection | null }) {
    this.db = opts.db;
    this.getConnection = opts.getConnection;
  }

  start(): void {
    if (process.env.COPY_FOLLOWER_DISABLED === 'true') {
      logger.info('CopyFollowerProbe disabled via COPY_FOLLOWER_DISABLED=true');
      return;
    }
    if (!process.env.HELIUS_WS_URL) {
      logger.warn('HELIUS_WS_URL not set — copy-follower probe cannot subscribe');
      return;
    }
    if (!WSCtor) {
      logger.warn('global WebSocket unavailable (Node <21?) — copy-follower probe disabled');
      return;
    }
    this.refreshWatchlist(/*connectIfChanged*/ true);
    this.watchlistTimer = setInterval(() => this.refreshWatchlist(true), WATCHLIST_REFRESH_MS);
    this.heartbeatTimer = setInterval(() => this.writeStatus(), 60_000);
    logger.info('CopyFollowerProbe started');
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.watchlistTimer) { clearInterval(this.watchlistTimer); this.watchlistTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.closeWs();
  }

  private refreshWatchlist(connectIfChanged: boolean): void {
    let wl: string[] = [];
    try { wl = getFollowListAddresses(this.db); } catch { /* table may be empty */ }
    const changed = wl.length !== this.watchlist.length || wl.some((a, i) => a !== this.watchlist[i]);
    if (!changed) return;
    this.watchlist = wl;
    logger.info('Watchlist updated: %d wallets', wl.length);
    this.writeStatus();
    if (connectIfChanged) {
      // Reconnect to re-subscribe with the new accountInclude set.
      this.closeWs();
      if (wl.length > 0) this.connect();
    }
  }

  private connect(): void {
    if (this.stopped || this.watchlist.length === 0 || !WSCtor) return;
    const url = process.env.HELIUS_WS_URL!;
    let ws: MinimalWS;
    try {
      ws = new WSCtor(url);
    } catch (err) {
      logger.warn('WS construct failed: %s', err instanceof Error ? err.message : String(err));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      const id = ++this.subRequestId;
      const msg = {
        jsonrpc: '2.0',
        id,
        method: 'transactionSubscribe',
        params: [
          { accountInclude: this.watchlist, failed: false, vote: false },
          { commitment: 'processed', encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 0 },
        ],
      };
      try { ws.send(JSON.stringify(msg)); } catch { /* will surface via onclose */ }
      this.connected = true;
      this.reconnectDelay = 1000;
      logger.info('transactionSubscribe sent for %d wallets', this.watchlist.length);
      this.writeStatus();
    };

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(ev.data)) as Record<string, unknown>; } catch { return; }
      if (typeof (msg as { result?: unknown }).result === 'number') {
        this.subId = (msg as { result: number }).result;
        return;
      }
      if ((msg as { method?: string }).method === 'transactionNotification') {
        this.totalNotifications++;
        this.handleNotification((msg as { params?: unknown }).params).catch((err) =>
          logger.debug('probe notification error: %s', err instanceof Error ? err.message : String(err)));
      }
    };

    ws.onerror = () => { /* onclose will follow and drive reconnect */ };
    ws.onclose = () => {
      this.connected = false;
      this.writeStatus();
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private closeWs(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.connected = false;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
  }

  private isDup(sig: string): boolean {
    if (this.seen.has(sig)) return true;
    this.seen.set(sig, Date.now());
    if (this.seen.size > SEEN_MAX) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return false;
  }

  /** Parse a transactionNotification, fetch the tx for block time + a clean
   *  parse, and record one probe event per watched wallet that swapped. */
  private async handleNotification(params: unknown): Promise<void> {
    const detectedAtMs = Date.now();
    const p = params as { result?: Record<string, unknown> } | undefined;
    const result = p?.result ?? {};
    const value = (result as { value?: Record<string, unknown> }).value ?? result;

    const signature =
      (value as { signature?: string }).signature ??
      (value as { transaction?: { transaction?: { signatures?: string[] } } }).transaction?.transaction?.signatures?.[0] ??
      (value as { transaction?: { signatures?: string[] } }).transaction?.signatures?.[0];
    if (!signature || this.isDup(signature)) return;
    const slot = (value as { slot?: number }).slot ?? null;

    const connection = this.getConnection();
    if (!connection) return;
    if (!(await globalRpcLimiter.throttleOrDrop(20))) return;

    let tx;
    try {
      tx = await connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    } catch { return; }
    if (!tx) return;

    const blockTime = tx.blockTime ?? null;
    const lag = blockTime != null ? +(detectedAtMs / 1000 - blockTime).toFixed(2) : null;

    const watch = new Set(this.watchlist);
    const keys = tx.transaction.message.accountKeys.map((k) =>
      typeof (k as { pubkey?: { toBase58(): string } }).pubkey !== 'undefined'
        ? (k as { pubkey: { toBase58(): string } }).pubkey.toBase58()
        : String(k));
    const involved = keys.filter((k) => watch.has(k));
    if (involved.length === 0) return;

    for (const wallet of involved) {
      const swap = parseSwapForOwner(tx, wallet);
      insertProbeEvent(this.db, {
        wallet_address: wallet,
        signature,
        mint: swap?.mint ?? null,
        action: swap?.action ?? null,
        sol_delta: swap?.solDelta ?? null,
        venue: swap?.venue ?? null,
        their_block_time: blockTime,
        detected_at: detectedAtMs,
        detection_lag_sec: lag,
        slot,
      });
      this.totalEvents++;
      this.lastEventAt = detectedAtMs;
      if (swap) {
        logger.info('Probe: %s %s %s %s lag=%ss',
          wallet.slice(0, 6), swap.action, swap.venue, (swap.mint ?? '').slice(0, 6), lag ?? '?');
      }
    }
    this.writeStatus();
  }

  private writeStatus(): void {
    try {
      const status = {
        connected: this.connected,
        sub_id: this.subId,
        watchlist_size: this.watchlist.length,
        total_notifications: this.totalNotifications,
        total_events: this.totalEvents,
        last_event_at: this.lastEventAt,
        updated_at: Date.now(),
      };
      this.db.prepare(`
        INSERT INTO bot_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(PROBE_STATUS_KEY, JSON.stringify(status));
    } catch { /* non-fatal */ }
  }
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(2);
}

/** Read-only summary of the probe for publication to bot-status. Cheap SQL. */
export function computeCopyProbe(db: Database.Database): unknown {
  let watchlist: string[] = [];
  let status: Record<string, unknown> | null = null;
  let rows: Array<Record<string, unknown>> = [];
  try {
    watchlist = getFollowListAddresses(db);
    const s = db.prepare(`SELECT value FROM bot_settings WHERE key = ?`).get(PROBE_STATUS_KEY) as { value: string } | undefined;
    status = s ? JSON.parse(s.value) : null;
    rows = db.prepare(`SELECT * FROM copy_probe_events ORDER BY detected_at DESC LIMIT 1000`).all() as Array<Record<string, unknown>>;
  } catch {
    return { generated_at: new Date().toISOString(), phase: 'phase2-latency-probe', pending: true };
  }

  const swaps = rows.filter((r) => r.action === 'buy' || r.action === 'sell');
  const lags = rows.map((r) => r.detection_lag_sec).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
  const byWallet: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  const byVenue: Record<string, number> = {};
  for (const r of rows) {
    byWallet[r.wallet_address as string] = (byWallet[r.wallet_address as string] ?? 0) + 1;
    byAction[(r.action as string) ?? 'unknown'] = (byAction[(r.action as string) ?? 'unknown'] ?? 0) + 1;
    if (r.venue) byVenue[r.venue as string] = (byVenue[r.venue as string] ?? 0) + 1;
  }

  return {
    generated_at: new Date().toISOString(),
    phase: 'phase2-latency-probe',
    note: 'Latency probe only — no positions taken. detection_lag_sec = our WS-notification time − tx block time. Live execution adds a further ~1-2 block land gap on top of this.',
    status,
    watchlist,
    summary: {
      total_events: rows.length,
      swaps: swaps.length,
      by_action: byAction,
      by_venue: byVenue,
      by_wallet: byWallet,
      detection_lag_sec: lags.length
        ? { n: lags.length, p50: percentile(lags, 0.5), p95: percentile(lags, 0.95), max: lags[lags.length - 1], mean: +(lags.reduce((a, b) => a + b, 0) / lags.length).toFixed(2) }
        : null,
    },
    recent_events: rows.slice(0, 30).map((r) => ({
      wallet: (r.wallet_address as string).slice(0, 8),
      action: r.action,
      venue: r.venue,
      mint: r.mint ? (r.mint as string).slice(0, 8) : null,
      sol_delta: r.sol_delta,
      detection_lag_sec: r.detection_lag_sec,
      detected_at: r.detected_at,
    })),
  };
}
