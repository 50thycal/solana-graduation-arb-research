import Database from 'better-sqlite3';
import WebSocket from 'ws';
import {
  mergeLiveTallies, promoteLiveTapeWallets, evictStaleLiveTallies, getLiveTapeSummary,
  LiveTallyDelta,
} from './queries';
import { parseSwapForOwner, wsNotificationToTx, swapTradersOf } from './parse-swap';
import { usageTracker } from '../utils/usage-tracker';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('live-tape-harvester');

/**
 * Live-tape harvester (Idea 1) — push discovery + zero-RPC pre-filter.
 *
 * Subscribes to the PumpSwap program tape via Helius Enhanced WebSockets
 * `transactionSubscribe` (accountInclude = the program) and parses EVERY swap
 * straight off the push (zero RPC — same WS-payload parse the follower uses),
 * maintaining a cheap rolling per-wallet activity tally. This is the only
 * discovery path that surfaces wallets the OG seed structurally can't see: the OG
 * seed and co-trade both read competition_signals (the 0-30s post-grad window),
 * whereas this watches the FULL post-grad tape, so it finds active traders we
 * otherwise never record.
 *
 * Discipline: the tally is a SCREEN, not a verdict (sol_in/out are gross, no FIFO
 * cost basis). Wallets that pass a cheap activity+profitability screen are promoted
 * into wallet_candidates(source='live_tape') and judged by the existing FIFO scorer
 * on the same money-edge bar as every other wallet. So this changes WHO we score,
 * never WHAT counts as smart.
 *
 * Safety (it shares the process + WS infra with the live pipeline):
 *   - zero RPC, so it can't touch the Helius credit budget;
 *   - a parse-rate cap (LIVE_TAPE_MAX_PARSE_PER_SEC) samples under a firehose so it
 *     can't peg the event loop and starve graduation/copy latency;
 *   - the in-memory tally is per-flush-window and wallet-capped, then merged to DB
 *     and cleared, so memory is bounded;
 *   - own WS connection (independent of the graduation listener + follower probe).
 *
 * COST (learned the hard way 2026-... — a usage spike): Helius bills Enhanced /
 * "LaserStream" WebSocket credits PER DELIVERED MESSAGE. The PumpSwap program tape
 * is ~550 msg/s, so a CONTINUOUS subscription is ~1.4 BILLION credits/month —
 * wildly over the 10-20M plan. The parse-rate cap only bounds CPU, NOT credits
 * (Helius bills every message it pushes, parsed or not). So this is now:
 *   - OPT-IN: runs only if LIVE_TAPE_ENABLED=true (default OFF). LIVE_TAPE_DISABLED
 *     remains a hard kill that overrides everything.
 *   - DUTY-CYCLED with a HARD per-cycle MESSAGE BUDGET: connect, sample until
 *     LIVE_TAPE_MAX_MSGS_PER_CYCLE messages (≈ that many credits) OR the sample
 *     window elapses, then DISCONNECT (no messages delivered = no billing) and
 *     idle for LIVE_TAPE_CYCLE_HOURS before sampling again. The message budget is
 *     the real guardrail; the time window is just an upper bound. Defaults below
 *     keep the harvester ≈3M credits/mo (a thin daily sample), env-tunable up once
 *     scoring has caught up with discovery. Program-tape discovery on a
 *     per-message-billed plan is fundamentally a SAMPLE, not continuous coverage.
 */

const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

const FLUSH_MS = 3 * 60 * 1000;        // merge tally → DB + promote + evict
const FLUSH_CHUNK = 500;               // wallets per DB transaction — keep each
                                       // synchronous flush chunk short (better-sqlite3
                                       // blocks the loop) and yield between chunks
const MAX_RECONNECT_MS = 60_000;
const SEEN_MAX = 8192;
const MAX_WALLETS_PER_WINDOW = 100_000; // memory guard within a flush window
const MAX_MINTS_PER_WALLET = 64;        // cap the per-wallet mint set
const STATUS_KEY = 'live_tape_status';

// Duty-cycle budget — DETERMINISTIC monthly ceiling. The harvester samples at most
// ONE window per cycle (restart-guarded via bot_settings), each capped at
// MAX_MSGS_PER_CYCLE delivered messages. So the absolute monthly max is
//   MAX_MSGS_PER_CYCLE × (30×24 / CYCLE_HOURS) messages.
// At the defaults below: 40k × 30 = 1.2M msgs/mo. Helius bills ≈2-2.5 credits/msg
// (observed ~1.8; we size conservatively at 2.5), so ≤ ~3M credits/month. Trimmed
// from 6M (2026-06-29): discovery was out-running scoring — 1,724 wallets promoted,
// 0 scored — so budget shifted from discovery to scoring. Raise
// LIVE_TAPE_MAX_MSGS_PER_CYCLE only once scoring has caught up.
const DEFAULT_MAX_MSGS_PER_CYCLE = 40_000;
const DEFAULT_CYCLE_HOURS = 24;
const DEFAULT_SAMPLE_MAX_MIN = 15;      // hard upper bound on a sample window
const CREDITS_PER_MSG_EST = 2.5;        // conservative, for the monthly projection
const LAST_CYCLE_KEY = 'live_tape_last_cycle_ts';

// Promotion screen — ACTIVITY-based, not profit-based. Under ~9% tape sampling the
// rough per-wallet net is dominated by unmatched sells, so it can't rank profit;
// the screen just surfaces wallets active enough to be worth FIFO-scoring, and the
// scorer judges profitability. The FIFO scorer is the real bar.
const PROMOTE = { minBuys: 5, minSells: 3, cap: 200 };
// Evict un-promoted, low-activity, stale rows older than this.
const EVICT_STALE_SEC = 24 * 3600;
const EVICT_MIN_ACTIVITY = 3;

function intEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

interface WalletAgg {
  buys: number; sells: number;
  solIn: number; solOut: number;
  mints: Set<string>;
  firstSeen: number; lastSeen: number;
}

export class LiveTapeHarvester {
  private readonly db: Database.Database;
  private ws: WebSocket | null = null;
  private stopped = false;
  private subRequestId = 1;
  private subId: number | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;

  // duty-cycle state
  private cycleActive = false;          // currently in a sampling window
  private intentionalClose = false;     // closeWs() we triggered (don't reconnect)
  private cycleMsgs = 0;                 // messages received this cycle (≈ credits)
  private cycleTimer: ReturnType<typeof setTimeout> | null = null;
  private sampleStopTimer: ReturnType<typeof setTimeout> | null = null;
  private cyclesRun = 0;
  private totalCycleMsgs = 0;            // lifetime billed messages (≈ credits)
  private readonly maxMsgsPerCycle: number;
  private readonly cycleMs: number;
  private readonly sampleMaxMs: number;

  private tally = new Map<string, WalletAgg>();
  private seen = new Map<string, number>();
  private readonly maxParsePerSec: number;
  private secWindowStart = 0;
  private parsedThisSec = 0;

  // lifetime counters (status)
  private totalNotifications = 0;
  private totalParsed = 0;
  private totalSwaps = 0;
  private droppedRate = 0;     // notifications skipped by the parse-rate cap
  private droppedDup = 0;
  private droppedUnparsed = 0;
  private lastPromoted = 0;
  private lastFlushAt: number | null = null;

  constructor(opts: { db: Database.Database }) {
    this.db = opts.db;
    this.maxParsePerSec = intEnv('LIVE_TAPE_MAX_PARSE_PER_SEC', 50);
    this.maxMsgsPerCycle = intEnv('LIVE_TAPE_MAX_MSGS_PER_CYCLE', DEFAULT_MAX_MSGS_PER_CYCLE);
    this.cycleMs = intEnv('LIVE_TAPE_CYCLE_HOURS', DEFAULT_CYCLE_HOURS) * 3600_000;
    this.sampleMaxMs = intEnv('LIVE_TAPE_SAMPLE_MAX_MIN', DEFAULT_SAMPLE_MAX_MIN) * 60_000;
  }

  start(): void {
    // OPT-IN: Helius bills LaserStream WS per delivered message, and the program
    // tape is a firehose, so this stays off unless explicitly enabled. The DISABLED
    // flag is a hard override that wins even if ENABLED is set.
    if (process.env.LIVE_TAPE_DISABLED === 'true' || process.env.LIVE_TAPE_ENABLED !== 'true') {
      logger.info('LiveTapeHarvester off (set LIVE_TAPE_ENABLED=true to opt in; LIVE_TAPE_DISABLED overrides)');
      return;
    }
    if (!process.env.HELIUS_WS_URL) {
      logger.warn('HELIUS_WS_URL not set — live-tape harvester cannot subscribe');
      return;
    }
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => logger.warn('flush error: %s', err instanceof Error ? err.message : String(err)));
    }, FLUSH_MS);
    logger.info('LiveTapeHarvester started (budget=%d msgs/cycle, cycle=%dh, sampleMax=%dm)',
      this.maxMsgsPerCycle, this.cycleMs / 3600_000, this.sampleMaxMs / 60_000);
    this.beginCycle();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    if (this.cycleTimer) { clearTimeout(this.cycleTimer); this.cycleTimer = null; }
    if (this.sampleStopTimer) { clearTimeout(this.sampleStopTimer); this.sampleStopTimer = null; }
    this.flush().catch(() => { /* best-effort on shutdown */ });
    this.intentionalClose = true;
    this.closeWs();
  }

  private readLastCycleTs(): number {
    try {
      const r = this.db.prepare(`SELECT value FROM bot_settings WHERE key = ?`).get(LAST_CYCLE_KEY) as { value: string } | undefined;
      return r ? parseInt(r.value, 10) || 0 : 0;
    } catch { return 0; }
  }

  private writeLastCycleTs(ts: number): void {
    try {
      this.db.prepare(`
        INSERT INTO bot_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(LAST_CYCLE_KEY, String(ts));
    } catch { /* non-fatal */ }
  }

  /** Open a bounded sampling window: connect, and arm a hard stop at the sample
   *  window's max duration. The per-message budget (checked per message) usually
   *  ends it sooner. RESTART-GUARDED: if < one cycle has elapsed since the last
   *  sample (persisted), defer — so a restart loop can't re-open the firehose and
   *  blow the deterministic monthly ceiling. */
  private beginCycle(): void {
    if (this.stopped) return;
    const now = Date.now();
    const last = this.readLastCycleTs();
    const elapsed = now - last;
    if (last > 0 && elapsed < this.cycleMs) {
      const wait = this.cycleMs - elapsed;
      logger.info('Live-tape: %dm since last sample (<%dh) — deferring',
        Math.round(elapsed / 60000), this.cycleMs / 3600_000);
      this.cycleTimer = setTimeout(() => this.beginCycle(), wait);
      return;
    }
    // Stamp the cycle start BEFORE connecting so a crash mid-window still counts
    // this cycle's quota (conservative — never double-samples a period).
    this.writeLastCycleTs(now);
    this.cycleActive = true;
    this.cycleMsgs = 0;
    this.intentionalClose = false;
    this.connect();
    this.sampleStopTimer = setTimeout(() => this.endCycle('window'), this.sampleMaxMs);
  }

  /** Close the WS (stops billing), persist, and schedule the next sample window. */
  private endCycle(reason: 'budget' | 'window'): void {
    if (!this.cycleActive) return;
    this.cycleActive = false;
    if (this.sampleStopTimer) { clearTimeout(this.sampleStopTimer); this.sampleStopTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.intentionalClose = true;
    this.closeWs();
    this.cyclesRun++;
    this.totalCycleMsgs += this.cycleMsgs;
    logger.info('Live-tape cycle ended (%s): %d msgs this cycle, next in %dh',
      reason, this.cycleMsgs, this.cycleMs / 3600_000);
    this.flush().catch(() => { /* best-effort */ });
    if (!this.stopped) {
      this.cycleTimer = setTimeout(() => this.beginCycle(), this.cycleMs);
    }
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(process.env.HELIUS_WS_URL!);
    } catch (err) {
      logger.warn('WS construct failed: %s', err instanceof Error ? err.message : String(err));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      const id = ++this.subRequestId;
      const msg = {
        jsonrpc: '2.0', id, method: 'transactionSubscribe',
        params: [
          { accountInclude: [PUMPSWAP_PROGRAM], failed: false, vote: false },
          { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 0 },
        ],
      };
      try { ws.send(JSON.stringify(msg)); } catch { /* surfaces via close */ }
      this.connected = true;
      this.reconnectDelay = 1000;
      logger.info('transactionSubscribe sent for PumpSwap program tape');
    });

    ws.on('message', (data: WebSocket.RawData) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(data.toString()) as Record<string, unknown>; } catch { return; }
      if (typeof (msg as { result?: unknown }).result === 'number') { this.subId = (msg as { result: number }).result; return; }
      if ((msg as { method?: string }).method === 'transactionNotification') {
        usageTracker.recordWs('discovery_livetape_ws'); // LaserStream billing attribution
        this.onTapeNotification((msg as { params?: unknown }).params);
      }
    });

    ws.on('error', () => { /* 'close' drives reconnect */ });
    ws.on('close', () => {
      this.connected = false;
      // Only reconnect if the window is still active AND we didn't close on purpose
      // (budget/window end). Otherwise a reconnect would re-open the firehose.
      if (!this.stopped && this.cycleActive && !this.intentionalClose) this.scheduleReconnect();
    });
  }

  private closeWs(): void {
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
    this.connected = false;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
  }

  /** Parse-rate cap: allow at most maxParsePerSec notifications/sec to be parsed;
   *  the rest are sampled out so a firehose can't peg the event loop. */
  private rateAllows(): boolean {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec !== this.secWindowStart) { this.secWindowStart = nowSec; this.parsedThisSec = 0; }
    if (this.parsedThisSec >= this.maxParsePerSec) { this.droppedRate++; return false; }
    this.parsedThisSec++;
    return true;
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

  /** One delivered (billed) tape message: enforce the per-cycle message budget
   *  BEFORE doing any work, then parse. The budget — not the parse-rate cap — is
   *  what bounds Helius credits, since every delivered message is billed. */
  private onTapeNotification(params: unknown): void {
    if (!this.cycleActive) return; // window closed; ignore stragglers
    this.totalNotifications++;
    this.cycleMsgs++;
    if (this.cycleMsgs >= this.maxMsgsPerCycle) { this.endCycle('budget'); return; }
    this.handleNotification(params);
  }

  private handleNotification(params: unknown): void {
    if (!this.rateAllows()) return;
    const p = params as { result?: Record<string, unknown> } | undefined;
    const result = p?.result ?? {};
    const value = (result as { value?: Record<string, unknown> }).value ?? result;

    const sig =
      (value as { signature?: string }).signature ??
      (value as { transaction?: { transaction?: { signatures?: string[] } } }).transaction?.transaction?.signatures?.[0];
    if (sig && this.isDup(sig)) { this.droppedDup++; return; }

    const tx = wsNotificationToTx(value);
    if (!tx) { this.droppedUnparsed++; return; }
    this.totalParsed++;

    const nowSec = Math.floor(Date.now() / 1000);
    for (const owner of swapTradersOf(tx)) {
      const swap = parseSwapForOwner(tx, owner);
      if (!swap) continue;
      this.totalSwaps++;
      this.record(owner, swap.action, Math.abs(swap.solDelta), swap.mint, nowSec);
    }
  }

  private record(owner: string, action: 'buy' | 'sell', sol: number, mint: string, nowSec: number): void {
    let a = this.tally.get(owner);
    if (!a) {
      if (this.tally.size >= MAX_WALLETS_PER_WINDOW) return; // window memory guard
      a = { buys: 0, sells: 0, solIn: 0, solOut: 0, mints: new Set(), firstSeen: nowSec, lastSeen: nowSec };
      this.tally.set(owner, a);
    }
    if (action === 'buy') { a.buys++; a.solIn += sol; } else { a.sells++; a.solOut += sol; }
    if (a.mints.size < MAX_MINTS_PER_WALLET) a.mints.add(mint);
    a.lastSeen = nowSec;
  }

  /** Merge the window's tally → DB in CHUNKS (yielding to the event loop between
   *  each so the synchronous SQLite writes can't stall graduation/copy latency),
   *  promote screen-passers to the scorer, evict stale rows, then clear the
   *  in-memory window (cumulative state lives in DB). */
  private async flush(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    try {
      if (this.tally.size > 0) {
        const deltas: LiveTallyDelta[] = [];
        for (const [address, a] of this.tally) {
          deltas.push({
            address, buys: a.buys, sells: a.sells, solIn: a.solIn, solOut: a.solOut,
            mints: [...a.mints], firstSeen: a.firstSeen, lastSeen: a.lastSeen,
          });
        }
        this.tally.clear();
        for (let i = 0; i < deltas.length; i += FLUSH_CHUNK) {
          mergeLiveTallies(this.db, deltas.slice(i, i + FLUSH_CHUNK), now);
          if (i + FLUSH_CHUNK < deltas.length) await new Promise((r) => setTimeout(r, 0));
        }
      }
      this.lastPromoted = promoteLiveTapeWallets(this.db, PROMOTE, now);
      evictStaleLiveTallies(this.db, { staleBefore: now - EVICT_STALE_SEC, minActivity: EVICT_MIN_ACTIVITY });
      this.lastFlushAt = Date.now();
      this.writeStatus();
      if (this.lastPromoted > 0) logger.info('Live-tape flush: promoted %d new candidates', this.lastPromoted);
    } catch (err) {
      logger.warn('Live-tape flush failed: %s', err instanceof Error ? err.message : String(err));
    }
  }

  private writeStatus(): void {
    try {
      const status = {
        connected: this.connected,
        sub_id: this.subId,
        cycle_active: this.cycleActive,
        cycle_msgs: this.cycleMsgs,            // messages this sampling window
        max_msgs_per_cycle: this.maxMsgsPerCycle,
        cycles_run: this.cyclesRun,
        total_billed_msgs: this.totalCycleMsgs, // lifetime messages (≈ credits/2.5)
        cycle_hours: this.cycleMs / 3600_000,
        // Deterministic ceiling: max one capped window per cycle → fixed monthly max.
        est_monthly_credits_max: Math.round(
          this.maxMsgsPerCycle * (30 * 24 / (this.cycleMs / 3600_000)) * CREDITS_PER_MSG_EST,
        ),
        window_wallets: this.tally.size,
        total_notifications: this.totalNotifications,
        total_parsed: this.totalParsed,
        total_swaps: this.totalSwaps,
        dropped_rate: this.droppedRate,
        dropped_dup: this.droppedDup,
        dropped_unparsed: this.droppedUnparsed,
        max_parse_per_sec: this.maxParsePerSec,
        last_promoted: this.lastPromoted,
        last_flush_at: this.lastFlushAt,
        updated_at: Date.now(),
      };
      this.db.prepare(`
        INSERT INTO bot_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(STATUS_KEY, JSON.stringify(status));
    } catch { /* non-fatal */ }
  }
}

/** Read-only summary for the /copy-trades page + bot-status. Cheap SQL. */
export function computeLiveTape(db: Database.Database): unknown {
  let status: Record<string, unknown> | null = null;
  try {
    const s = db.prepare(`SELECT value FROM bot_settings WHERE key = ?`).get(STATUS_KEY) as { value: string } | undefined;
    status = s ? JSON.parse(s.value) : null;
  } catch { /* ignore */ }
  return {
    generated_at: new Date().toISOString(),
    method: 'live-tape-harvester',
    venue: 'pumpswap',
    note: 'Zero-RPC discovery: parses the full PumpSwap post-grad tape off the WS push, tallies per-wallet activity, and promotes screen-passers (source=live_tape) into the scorer. These are wallets the 0-30s OG seed never sees. The tally is a screen; the FIFO scorer is the real bar.',
    status,
    summary: getLiveTapeSummary(db),
  };
}
