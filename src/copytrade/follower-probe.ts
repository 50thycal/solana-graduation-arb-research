import Database from 'better-sqlite3';
import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import WebSocket from 'ws';
import { getFollowListAddresses, getSmartSetAddresses, insertProbeEvent, updateProbeEventLag } from './queries';
import { getCopyNetSelectedAddresses } from './leaderboard-v2';
import { refreshSourceSets } from './discovery-sources';
import { parseSwapForOwner, wsNotificationToTx } from './parse-swap';
import type { CopyTrader } from './copy-trader';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { usageTracker } from '../utils/usage-tracker';
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

// ── Helius credit governors (2026-07-04, budget cap Jul 4→22) ──
// WS is billed per delivered message and scales ~linearly with watchlist size, so we
// bound the subscription. Tier priority when trimming: follow_list > smart set > copy-net >
// discovery-source (quarantined) — we keep the wallets we actually copy and drop the tail.
// 0 = uncapped (pre-2026-07-04 behaviour). Env-tunable so it can be dialed back after Jul 22.
const WATCHLIST_MAX = (() => {
  const v = parseInt(process.env.COPY_WATCHLIST_MAX || '140', 10);
  return Number.isFinite(v) && v >= 0 ? v : 140;
})();
// scheduleLagFill fires a getBlockTime RPC purely for the detection-lag TELEMETRY (post-dispatch,
// zero trading impact). At full rate it was ~8.8% of the entire Helius bill. Sample 1-in-N eligible
// events — a few thousand samples/day still yields valid lag percentiles. 0 disables it entirely.
const LAGFILL_SAMPLE = (() => {
  const v = parseInt(process.env.COPY_LAGFILL_SAMPLE || '20', 10);
  return Number.isFinite(v) && v >= 0 ? v : 20;
})();

export class CopyFollowerProbe {
  private readonly db: Database.Database;
  private readonly getConnection: () => Connection | null;
  private ws: WebSocket | null = null;
  private stopped = false;
  private watchlist: string[] = [];       // union: follow_list ∪ smart set ∪ copy-net ∪ discovery-source sets
  private promotableSet = new Set<string>(); // strict follow_list subset (for tier tagging)
  // Discovery-source-ONLY wallets (in a source set, not in the OG universe), tagged
  // `src_<sourceId>` — the tier keeps their probe events out of the consensus/crowd
  // counts so newly-watched source wallets can't perturb existing strategies' series.
  private sourceTier = new Map<string, string>();
  private subRequestId = 1;
  private subId: number | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchlistTimer: ReturnType<typeof setInterval> | null = null;
  private lagFillCounter = 0;             // 1-in-LAGFILL_SAMPLE governor for scheduleLagFill
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private seen = new Map<string, number>();
  private totalNotifications = 0;
  private totalEvents = 0;
  private lastEventAt: number | null = null;
  private connected = false;
  // How the swap was parsed: ws = straight off the WS push (fast, no RPC),
  // rpc = fell back to getParsedTransaction because the push was unusable.
  private parsedWs = 0;
  private parsedRpc = 0;
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
    // Watch the follow_list (promotable), the broader money-edge smart set (V1), the
    // copy-net selection set (V2), AND the discovery-source smart sets. The union is the
    // subscription; tier is tagged per event. V2 is added so leads the copy-net method
    // selects (but own-P&L doesn't) still generate lead events for the copy-select-v2 A/B
    // strategy — otherwise the V2 arm could never enter a V2-only lead. The source sets
    // are added (2026-07-04) because the relaxed source gate admits wallets the global
    // smart set doesn't — without subscribing them the copy-src-* probes could never see
    // a lead event and sat at n=0 by construction.
    let promotable: string[] = [];
    let smart: string[] = [];
    let copyNet: string[] = [];
    let sourceSets = new Map<string, Set<string>>();
    try { promotable = getFollowListAddresses(this.db); } catch { /* may be empty */ }
    try { smart = getSmartSetAddresses(this.db); } catch { /* may be empty */ }
    try { copyNet = getCopyNetSelectedAddresses(this.db); } catch { /* may be empty */ }
    try { sourceSets = refreshSourceSets(this.db); } catch { /* may be empty */ }
    this.promotableSet = new Set(promotable);
    const ogUnion = new Set([...promotable, ...smart, ...copyNet]);
    this.sourceTier = new Map();
    for (const [srcId, set] of sourceSets) {
      for (const a of set) {
        if (ogUnion.has(a) || this.sourceTier.has(a)) continue;
        this.sourceTier.set(a, `src_${srcId}`);
      }
    }
    // Tier-priority union (highest edge first): follow_list → smart set → copy-net →
    // discovery-source. WATCHLIST_MAX bounds Helius WS spend by truncating the LOW-priority
    // tail — the discovery-source (quarantined) wallets drop before any wallet we copy.
    const ordered: string[] = [];
    const pushUnique = (addrs: Iterable<string>) => { for (const a of addrs) if (!ordered.includes(a)) ordered.push(a); };
    pushUnique(promotable);
    pushUnique(smart);
    pushUnique(copyNet);
    pushUnique(this.sourceTier.keys());
    const capped = WATCHLIST_MAX > 0 ? ordered.slice(0, WATCHLIST_MAX) : ordered;
    const dropped = ordered.length - capped.length;
    // Keep the sourceTier tags consistent with what we actually subscribe to.
    if (dropped > 0) {
      const kept = new Set(capped);
      for (const a of [...this.sourceTier.keys()]) if (!kept.has(a)) this.sourceTier.delete(a);
    }
    const wl = [...capped].sort();
    const changed = wl.length !== this.watchlist.length || wl.some((a, i) => a !== this.watchlist[i]);
    if (!changed) return;
    this.watchlist = wl;
    logger.info('Watchlist updated: %d wallets (%d promotable, %d smart-set, %d copy-net, %d discovery-source; %d dropped by cap=%d)',
      wl.length, promotable.length, smart.length, copyNet.length, this.sourceTier.size, dropped, WATCHLIST_MAX);
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
        usageTracker.recordWs('copy_follower_ws'); // LaserStream billing attribution
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

  /**
   * Handle a transactionNotification. FAST PATH: the subscription requests
   * `transactionDetails: 'full', encoding: 'jsonParsed'`, so the full parsed tx
   * is already in the push — we parse it in-process and dispatch the copy with
   * ZERO RPC and no confirm-fetch wait (which previously gated every copy by
   * 1.1s + up to 4×1.5s of getParsedTransaction retries). block_time isn't in the
   * processed-commitment push, so the transport lags are backfilled async via a
   * cheap getBlockTime(slot) AFTER the copy already fired. FALLBACK: if the push
   * is unusable, fetch + parse via RPC as before (so detection never regresses).
   */
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
    const slot =
      (value as { slot?: number }).slot ??
      (result as { context?: { slot?: number } }).context?.slot ?? null;

    // ── FAST PATH: parse straight off the WS push (no RPC) ──
    const built = this.buildTxFromNotification(value);
    if (built) {
      this.parsedWs++;
      // processed push has no block_time → transport lags filled async below.
      this.processTx(built, signature, slot, built.blockTime ?? null, detectedAtMs);
      if (built.blockTime == null && slot != null &&
          LAGFILL_SAMPLE > 0 && (this.lagFillCounter++ % LAGFILL_SAMPLE) === 0) {
        this.scheduleLagFill(signature, slot, detectedAtMs);
      }
      this.writeStatus();
      return;
    }

    // ── FALLBACK: push unusable — fetch + parse via RPC (legacy path) ──
    const connection = this.getConnection();
    if (!connection) { this.drops.no_connection++; return; }
    let tx = null as Awaited<ReturnType<typeof connection.getParsedTransaction>>;
    for (let attempt = 0; attempt < 4 && tx == null; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
      if (!(await globalRpcLimiter.throttleOrDropPriority(20, 'follower_probe'))) continue;
      try {
        tx = await connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      } catch { /* retry */ }
    }
    if (!tx) { this.drops.fetch_null++; return; }
    this.parsedRpc++;
    this.processTx(tx, signature, slot, tx.blockTime ?? null, detectedAtMs);
    this.writeStatus();
  }

  /** All watchlist wallets present in a tx, from both static account keys and
   *  address-lookup-table loaded addresses (router swaps are versioned). */
  private accountKeysOf(tx: ParsedTransactionWithMeta): string[] {
    const keys = tx.transaction.message.accountKeys.map((k) =>
      typeof (k as { pubkey?: { toBase58(): string } }).pubkey !== 'undefined'
        ? (k as { pubkey: { toBase58(): string } }).pubkey.toBase58()
        : String(k));
    for (const arr of [tx.meta?.loadedAddresses?.writable, tx.meta?.loadedAddresses?.readonly]) {
      for (const k of arr ?? []) keys.push(typeof k === 'string' ? k : k.toBase58());
    }
    return keys;
  }

  /** Record one probe event per watched wallet that swapped, and dispatch the
   *  shadow copy. decision_lag_ms = our processing time (push arrival → dispatch);
   *  total_lag_sec = block_time → dispatch. block_time may be null on the fast
   *  path (backfilled later); the copy itself never waits on it. */
  private processTx(
    tx: ParsedTransactionWithMeta,
    signature: string,
    slot: number | null,
    blockTime: number | null,
    detectedAtMs: number,
  ): void {
    const watch = new Set(this.watchlist);
    const involved = this.accountKeysOf(tx).filter((k) => watch.has(k));
    if (involved.length === 0) { this.drops.no_involved++; return; }

    const dispatchMs = Date.now();
    const decisionLagMs = +(dispatchMs - detectedAtMs).toFixed(1);
    const detectionLagSec = blockTime != null ? +(detectedAtMs / 1000 - blockTime).toFixed(2) : null;
    const totalLagSec = blockTime != null ? +(dispatchMs / 1000 - blockTime).toFixed(2) : null;

    for (const wallet of involved) {
      const swap = parseSwapForOwner(tx, wallet);
      // Source-only wallets carry their `src_<id>` tier: routing in copy-trader is
      // independent (sourceSets membership), but the tier keeps their events OUT of
      // the consensus/crowd counts (countRecentSmartBuyers/Sellers filter on it).
      const tier = this.promotableSet.has(wallet)
        ? 'promotable'
        : this.sourceTier.get(wallet) ?? 'smart';
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
        detection_lag_sec: detectionLagSec,
        decision_lag_ms: decisionLagMs,
        total_lag_sec: totalLagSec,
        slot,
      });
      this.totalEvents++;
      this.lastEventAt = detectedAtMs;
      if (swap) {
        logger.info('Probe: %s %s %s %s lag=%ss dec=%sms',
          wallet.slice(0, 6), swap.action, swap.venue, (swap.mint ?? '').slice(0, 6), detectionLagSec ?? '?', decisionLagMs);
        // Drive the shadow copy-trader (no real funds). Fire-and-forget.
        if (this.copyTrader) {
          if (swap.action === 'buy') {
            // |solDelta| = the SOL the lead spent — conviction-size signal.
            this.copyTrader.onLeadBuy(swap.mint, wallet, tier, detectionLagSec, Math.abs(swap.solDelta)).catch(() => { /* logged inside */ });
          } else if (swap.action === 'sell') {
            this.copyTrader.onLeadSell(swap.mint).catch(() => { /* logged inside */ });
          }
        }
      }
    }
  }

  /** Normalize a transactionNotification push into a ParsedTransactionWithMeta.
   *  Delegates to the shared wsNotificationToTx so the probe and the live-tape
   *  harvester parse pushes identically. Returns null (→ RPC fallback) if the
   *  push lacks meta/message. */
  private buildTxFromNotification(value: Record<string, unknown>):
    (ParsedTransactionWithMeta & { blockTime: number | null }) | null {
    return wsNotificationToTx(value);
  }

  /** Off-hot-path backfill of the transport lags once block_time is resolvable.
   *  getBlockTime(slot) is one light call vs a full getParsedTransaction, and it
   *  runs AFTER the copy has already dispatched, so it never adds entry latency. */
  private scheduleLagFill(signature: string, slot: number, detectedAtMs: number): void {
    void (async () => {
      const conn = this.getConnection();
      if (!conn) return;
      if (!(await globalRpcLimiter.throttleOrDropPriority(20, 'probe_blocktime'))) return;
      let bt: number | null = null;
      try { bt = await conn.getBlockTime(slot); } catch { return; }
      if (bt == null) return;
      const detectionLagSec = +(detectedAtMs / 1000 - bt).toFixed(2);
      try { updateProbeEventLag(this.db, { signature, their_block_time: bt, detection_lag_sec: detectionLagSec }); }
      catch { /* non-fatal */ }
    })();
  }

  private writeStatus(): void {
    try {
      const status = {
        connected: this.connected,
        sub_id: this.subId,
        watchlist_size: this.watchlist.length,
        watchlist_source_wallets: this.sourceTier.size, // discovery-source-only subscriptions
        total_notifications: this.totalNotifications,
        total_events: this.totalEvents,
        last_event_at: this.lastEventAt,
        // Parse source split — ws = fast WS-push parse (no RPC), rpc = fallback
        // fetch. ws should dominate; a rising rpc share means the push shape
        // changed and we're paying the latency/credit cost again.
        parsed_ws: this.parsedWs,
        parsed_rpc: this.parsedRpc,
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

  const lagSummary = (rs: Array<Record<string, unknown>>, col: string) => {
    const xs = rs.map((r) => r[col]).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
    if (!xs.length) return null;
    return { n: xs.length, p50: percentile(xs, 0.5), p95: percentile(xs, 0.95), max: xs[xs.length - 1], mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) };
  };

  const summarize = (rs: Array<Record<string, unknown>>) => {
    const swaps = rs.filter((r) => r.action === 'buy' || r.action === 'sell');
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
      // transport = lead block_time → our WS notification; decision = notification
      // → copy dispatch (our processing, ~ms since the WS-push parse landed);
      // total = block_time → dispatch (the real latency disadvantage).
      detection_lag_sec: lagSummary(rs, 'detection_lag_sec'),
      decision_lag_ms: lagSummary(rs, 'decision_lag_ms'),
      total_lag_sec: lagSummary(rs, 'total_lag_sec'),
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
