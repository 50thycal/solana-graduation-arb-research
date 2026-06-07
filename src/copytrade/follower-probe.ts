import Database from 'better-sqlite3';
import { Connection } from '@solana/web3.js';
import WebSocket from 'ws';
import { getFollowListAddresses, getSmartSetAddresses, insertProbeEvent } from './queries';
import { parseSwapForOwner } from './parse-swap';
import type { CopyTrader } from './copy-trader';
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
 * Default-ON; set COPY_FOLLOWER_DISABLED=true to turn it off. Uses the `ws`
 * package (not Node's global WebSocket — production runs node:20 which lacks it)
 * for the Helius-specific transactionSubscribe method (web3.js Connection only
 * does logsSubscribe). getParsedTransaction calls go through globalRpcLimiter so
 * the probe never starves the graduation pipeline.
 */

const PROBE_STATUS_KEY = 'copy_probe_status';
const WATCHLIST_REFRESH_MS = 10 * 60 * 1000;
const MAX_RECONNECT_MS = 60_000;
const SEEN_MAX = 4096;

export class CopyFollowerProbe {
  private readonly db: Database.Database;
  private readonly getConnection: () => Connection | null;
  private ws: WebSocket | null = null;
  private stopped = false;
  private watchlist: string[] = [];       // union: smart set ∪ follow_list
  private promotableSet = new Set<string>(); // strict follow_list subset (for tier tagging)
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
  // Per-stage drop counters — surfaced in status so we can see WHERE
  // notifications are lost between arrival and a recorded event.
  private drops = { sig_missing: 0, dup: 0, no_connection: 0, fetch_null: 0, no_involved: 0 };
  private readonly copyTrader?: CopyTrader;

  constructor(opts: { db: Database.Database; getConnection: () => Connection | null; copyTrader?: CopyTrader }) {
    this.db = opts.db;
    this.getConnection = opts.getConnection;
    this.copyTrader = opts.copyTrader;
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
    // Watch BOTH tiers: the strict follow_list (promotable) and the broader
    // money-edge smart set. Their union is the subscription; tier is tagged per
    // event so we can compare strict vs broad copy methods from one dataset.
    let promotable: string[] = [];
    let smart: string[] = [];
    try { promotable = getFollowListAddresses(this.db); } catch { /* may be empty */ }
    try { smart = getSmartSetAddresses(this.db); } catch { /* may be empty */ }
    this.promotableSet = new Set(promotable);
    const wl = [...new Set([...promotable, ...smart])].sort();
    const changed = wl.length !== this.watchlist.length || wl.some((a, i) => a !== this.watchlist[i]);
    if (!changed) return;
    this.watchlist = wl;
    logger.info('Watchlist updated: %d wallets (%d promotable, %d smart-set)', wl.length, promotable.length, smart.length);
    this.writeStatus();
    if (connectIfChanged) {
      // Reconnect to re-subscribe with the new accountInclude set.
      this.closeWs();
      if (wl.length > 0) this.connect();
    }
  }

  private connect(): void {
    if (this.stopped || this.watchlist.length === 0) return;
    const url = process.env.HELIUS_WS_URL!;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      logger.warn('WS construct failed: %s', err instanceof Error ? err.message : String(err));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
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
      try { ws.send(JSON.stringify(msg)); } catch { /* will surface via close */ }
      this.connected = true;
      this.reconnectDelay = 1000;
      logger.info('transactionSubscribe sent for %d wallets', this.watchlist.length);
      this.writeStatus();
    });

    ws.on('message', (data: WebSocket.RawData) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(data.toString()) as Record<string, unknown>; } catch { return; }
      if (typeof (msg as { result?: unknown }).result === 'number') {
        this.subId = (msg as { result: number }).result;
        return;
      }
      if ((msg as { method?: string }).method === 'transactionNotification') {
        this.totalNotifications++;
        this.handleNotification((msg as { params?: unknown }).params).catch((err) =>
          logger.debug('probe notification error: %s', err instanceof Error ? err.message : String(err)));
      }
    });

    ws.on('error', () => { /* 'close' will follow and drive reconnect */ });
    ws.on('close', () => {
      this.connected = false;
      this.writeStatus();
      if (!this.stopped) this.scheduleReconnect();
    });
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
    if (!signature) { this.drops.sig_missing++; return; }
    if (this.isDup(signature)) { this.drops.dup++; return; }
    const slot = (value as { slot?: number }).slot ?? null;

    const connection = this.getConnection();
    if (!connection) { this.drops.no_connection++; return; }

    // The notification fires at 'processed'; getParsedTransaction('confirmed')
    // right then often returns null until the slot confirms. Retry a few times
    // with backoff (each gated by the RPC limiter so we never starve grads).
    let tx = null as Awaited<ReturnType<typeof connection.getParsedTransaction>>;
    for (let attempt = 0; attempt < 4 && tx == null; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
      if (!(await globalRpcLimiter.throttleOrDrop(20))) continue;
      try {
        tx = await connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      } catch { /* retry */ }
    }
    if (!tx) { this.drops.fetch_null++; return; }

    const blockTime = tx.blockTime ?? null;
    const lag = blockTime != null ? +(detectedAtMs / 1000 - blockTime).toFixed(2) : null;

    // Build the account-key set from BOTH static keys and address-lookup-table
    // loaded addresses, so versioned txs (common for router swaps) still match.
    const watch = new Set(this.watchlist);
    const keys = tx.transaction.message.accountKeys.map((k) =>
      typeof (k as { pubkey?: { toBase58(): string } }).pubkey !== 'undefined'
        ? (k as { pubkey: { toBase58(): string } }).pubkey.toBase58()
        : String(k));
    for (const arr of [tx.meta?.loadedAddresses?.writable, tx.meta?.loadedAddresses?.readonly]) {
      for (const k of arr ?? []) keys.push(typeof k === 'string' ? k : k.toBase58());
    }
    const involved = keys.filter((k) => watch.has(k));
    if (involved.length === 0) { this.drops.no_involved++; return; }

    for (const wallet of involved) {
      const swap = parseSwapForOwner(tx, wallet);
      const tier = this.promotableSet.has(wallet) ? 'promotable' : 'smart';
      insertProbeEvent(this.db, {
        wallet_address: wallet,
        signature,
        mint: swap?.mint ?? null,
        action: swap?.action ?? null,
        sol_delta: swap?.solDelta ?? null,
        venue: swap?.venue ?? null,
        tier,
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
        // Drive the shadow copy-trader (no real funds). Fire-and-forget.
        if (this.copyTrader) {
          if (swap.action === 'buy') {
            this.copyTrader.onLeadBuy(swap.mint, wallet, tier, lag).catch(() => { /* logged inside */ });
          } else if (swap.action === 'sell') {
            this.copyTrader.onLeadSell(swap.mint).catch(() => { /* logged inside */ });
          }
        }
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
        drops: { ...this.drops },
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

  const summarize = (rs: Array<Record<string, unknown>>) => {
    const swaps = rs.filter((r) => r.action === 'buy' || r.action === 'sell');
    const lags = rs.map((r) => r.detection_lag_sec).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
    const byAction: Record<string, number> = {};
    const byVenue: Record<string, number> = {};
    const byWallet: Record<string, number> = {};
    for (const r of rs) {
      byAction[(r.action as string) ?? 'unknown'] = (byAction[(r.action as string) ?? 'unknown'] ?? 0) + 1;
      if (r.venue) byVenue[r.venue as string] = (byVenue[r.venue as string] ?? 0) + 1;
      byWallet[r.wallet_address as string] = (byWallet[r.wallet_address as string] ?? 0) + 1;
    }
    return {
      total_events: rs.length,
      swaps: swaps.length,
      by_action: byAction,
      by_venue: byVenue,
      by_wallet: byWallet,
      detection_lag_sec: lags.length
        ? { n: lags.length, p50: percentile(lags, 0.5), p95: percentile(lags, 0.95), max: lags[lags.length - 1], mean: +(lags.reduce((a, b) => a + b, 0) / lags.length).toFixed(2) }
        : null,
    };
  };

  const promotableRows = rows.filter((r) => r.tier === 'promotable');
  const smartOnlyRows = rows.filter((r) => r.tier !== 'promotable');

  return {
    generated_at: new Date().toISOString(),
    phase: 'phase2-latency-probe',
    note: 'Latency probe only — no positions taken. detection_lag_sec = our WS-notification time − tx block time; live execution adds a further ~1-2 block land gap on top. Two methods to compare: STRICT = by_tier.promotable; BROAD = summary (whole smart set = all events). smart_only = the extra wallets BROAD adds over STRICT.',
    status,
    watchlist,
    // BROAD method (whole money-edge smart set) = all events.
    summary: summarize(rows),
    by_tier: {
      promotable: summarize(promotableRows), // STRICT method
      smart_only: summarize(smartOnlyRows),  // the wallets BROAD adds
    },
    recent_events: rows.slice(0, 30).map((r) => ({
      wallet: (r.wallet_address as string).slice(0, 8),
      tier: r.tier,
      action: r.action,
      venue: r.venue,
      mint: r.mint ? (r.mint as string).slice(0, 8) : null,
      sol_delta: r.sol_delta,
      detection_lag_sec: r.detection_lag_sec,
      detected_at: r.detected_at,
    })),
  };
}
