import Database from 'better-sqlite3';
import WebSocket from 'ws';
import {
  mergeLiveTallies, promoteLiveTapeWallets, evictStaleLiveTallies, getLiveTapeSummary,
  LiveTallyDelta,
} from './queries';
import { parseSwapForOwner, wsNotificationToTx, swapTradersOf } from './parse-swap';
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
 *   - own WS connection (independent of the graduation listener + follower probe);
 *   - kill switch: LIVE_TAPE_DISABLED=true.
 */

const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

const FLUSH_MS = 3 * 60 * 1000;        // merge tally → DB + promote + evict
const MAX_RECONNECT_MS = 60_000;
const SEEN_MAX = 8192;
const MAX_WALLETS_PER_WINDOW = 100_000; // memory guard within a flush window
const MAX_MINTS_PER_WALLET = 64;        // cap the per-wallet mint set
const STATUS_KEY = 'live_tape_status';

// Promotion screen (loose — the FIFO scorer is the real bar).
const PROMOTE = { minBuys: 3, minSells: 2, minDistinctMints: 3, minNetSol: 0, cap: 200 };
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
  }

  start(): void {
    if (process.env.LIVE_TAPE_DISABLED === 'true') {
      logger.info('LiveTapeHarvester disabled via LIVE_TAPE_DISABLED=true');
      return;
    }
    if (!process.env.HELIUS_WS_URL) {
      logger.warn('HELIUS_WS_URL not set — live-tape harvester cannot subscribe');
      return;
    }
    this.connect();
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    logger.info('LiveTapeHarvester started (maxParse/s=%d, flush=%ds)', this.maxParsePerSec, FLUSH_MS / 1000);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    this.flush();
    this.closeWs();
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
        this.totalNotifications++;
        this.handleNotification((msg as { params?: unknown }).params);
      }
    });

    ws.on('error', () => { /* 'close' drives reconnect */ });
    ws.on('close', () => { this.connected = false; if (!this.stopped) this.scheduleReconnect(); });
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

  /** Merge the window's tally → DB, promote screen-passers to the scorer, evict
   *  stale rows, then clear the in-memory window (cumulative state lives in DB). */
  private flush(): void {
    const now = Math.floor(Date.now() / 1000);
    try {
      if (this.tally.size > 0) {
        const deltas: LiveTallyDelta[] = [];
        for (const [address, a] of this.tally) {
          deltas.push({
            address, buys: a.buys, sells: a.sells, solIn: a.solIn, solOut: a.solOut,
            distinctMints: a.mints.size, firstSeen: a.firstSeen, lastSeen: a.lastSeen,
          });
        }
        mergeLiveTallies(this.db, deltas, now);
        this.tally.clear();
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
