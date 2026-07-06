import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { ParsedTransactionWithMeta } from '@solana/web3.js';
import { parseSwapForOwner, wsNotificationToTx } from './parse-swap';
import { upsertCandidate } from './queries';
import { usageTracker } from '../utils/usage-tracker';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('winner-prefilter');

/**
 * Winner-sniper PRE-FILTER (operator pipeline, 2026-07-04) — stage 2 of the funnel:
 *
 *   stage 1 (winner-sniper.ts): a wallet takes PROFIT on a graduation we observed
 *     winning → it clears the tally bar → enrollPrefilterWallet() puts it here.
 *   stage 2 (THIS MODULE): the wallet is WATCHED — not traded, not scored — via its
 *     own Helius `transactionSubscribe` (accountInclude = the watching set, zero RPC:
 *     swaps parse straight off the push). We tally its FORWARD per-mint P&L across
 *     ANY PumpSwap token (venue='pumpswap' swaps only — not just our tracked
 *     graduations). Because flows only accumulate from enrollment onward, the test is
 *     out-of-sample by construction: the trigger token proved one profit; the
 *     pre-filter demands the wallet keep profiting on OTHER tokens.
 *   stage 3: PASS (>= minOtherWins profitable CLOSED positions on non-trigger mints
 *     AND summed realized >= minNetSol, inside the TTL) → promoted into
 *     wallet_candidates(source='winner_sniper') for the expensive FIFO scorer; the
 *     relaxed source gate on wallet_scores then decides tradability
 *     (discovery-sources.ts signalSet → the copy-src-winner-sniper probe).
 *
 * WHY: the FIFO scorer costs ~300 RPC/wallet and the follower watchlist bills WS per
 * message — we cannot listen to everyone. Each stage is cheap and buys admission to
 * the next, more expensive stage; the pool is hard-capped (PREFILTER_MAX_WALLETS) and
 * wallets that stop performing fail out on TTL, so the WS spend is bounded and the
 * scorer only ever sees wallets with TWO independent profitability proofs.
 *
 * Accounting notes (deliberately conservative screen, not a verdict):
 *   - realized P&L is only counted on CLOSED positions (tok_out >= closeFraction ×
 *     tok_in): realized = sol_out − sol_in. Open bags neither pass nor fail a wallet
 *     (no unrealized marks — that would need price RPC).
 *   - downtime loses flow legs (WS-only capture); a missed sell leaves a position
 *     "open" and simply doesn't count. Honest under-count, never an over-count.
 */

const STATUS_KEY = 'winner_prefilter_status';
const MAX_RECONNECT_MS = 60_000;
const SEEN_MAX = 4096;
const PUMPSWAP_VENUE = 'pumpswap';

function numEnv(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] || '');
  return Number.isFinite(v) ? v : fallback;
}

export const PREFILTER_CFG = {
  /** Hard cap on concurrently-watched wallets (bounds the WS subscription + spend). */
  maxWallets: numEnv('PREFILTER_MAX_WALLETS', 200),
  /** A wallet must pass within this window of being enrolled, else it fails out. */
  ttlHours: numEnv('PREFILTER_TTL_HOURS', 120),
  /** PASS bar: profitable CLOSED positions on this many DISTINCT non-trigger mints... */
  minOtherWins: numEnv('PREFILTER_MIN_OTHER_WINS', 2),
  /** ...AND summed realized SOL across closed non-trigger positions at least this. */
  minNetSol: numEnv('PREFILTER_MIN_NET_SOL', 0.25),
  /** EARLY FAIL when summed closed realized drops to or below −maxLossSol. */
  maxLossSol: numEnv('PREFILTER_MAX_LOSS_SOL', 1.0),
  /** A position counts as CLOSED once tok_out >= closeFraction × tok_in. */
  closeFraction: numEnv('PREFILTER_CLOSE_FRACTION', 0.9),
  /** Resolve/refresh cadence. */
  resolveTickMs: numEnv('PREFILTER_RESOLVE_TICK_MS', 60_000),
  /** Failed rows (and their flows) are deleted after this, freeing re-enrollment. */
  failRetentionDays: numEnv('PREFILTER_FAIL_RETENTION_DAYS', 14),
};

export function ensurePrefilterTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS winner_prefilter (
      address TEXT PRIMARY KEY,
      entered_at INTEGER NOT NULL,
      trigger_mints TEXT NOT NULL DEFAULT '[]',  -- graduation mints that earned entry (excluded from "other tokens")
      status TEXT NOT NULL DEFAULT 'watching',   -- watching | passed | failed
      resolved_at INTEGER,
      fail_reason TEXT,
      origin TEXT NOT NULL DEFAULT 'winner_sniper'  -- which discovery source enrolled the wallet (gradspec 2026-07-06)
    );
    CREATE INDEX IF NOT EXISTS idx_winner_prefilter_status ON winner_prefilter(status);
    CREATE TABLE IF NOT EXISTS winner_prefilter_flows (
      address TEXT NOT NULL,
      mint TEXT NOT NULL,
      buys INTEGER NOT NULL DEFAULT 0,
      sells INTEGER NOT NULL DEFAULT 0,
      sol_in REAL NOT NULL DEFAULT 0,
      sol_out REAL NOT NULL DEFAULT 0,
      tok_in REAL NOT NULL DEFAULT 0,
      tok_out REAL NOT NULL DEFAULT 0,
      first_ts INTEGER NOT NULL,
      last_ts INTEGER NOT NULL,
      PRIMARY KEY (address, mint)
    );
  `);
  // Migration for DBs created before the origin column (2026-07-06, gradspec source).
  // Existing rows were all winner-sniper enrollments, so the default backfills correctly.
  try { db.exec(`ALTER TABLE winner_prefilter ADD COLUMN origin TEXT NOT NULL DEFAULT 'winner_sniper'`); }
  catch { /* column already exists */ }
}

/**
 * Enroll a wallet into the pre-filter (called by winner-sniper's finalize when a
 * wallet clears the profitable-hit tally bar, and by the gradspec harvester when a
 * wallet clears the archetype bar). Pure SQL — safe to call even if the watcher isn't
 * running (the wallet just waits, and TTL-fails if never watched).
 * Existing watching rows accumulate additional trigger mints; passed/failed rows are
 * left alone (failed rows free up for re-enrollment after failRetentionDays cleanup).
 * `origin` records WHICH discovery source enrolled the wallet — it decides which
 * source's candidate tag / signal set a passer feeds (first enroller wins on collision).
 * `triggerMint` may be null for sources whose seed is behavioral (gradspec) rather than
 * a specific token: with no trigger mints, EVERY forward flow counts toward the bar —
 * still out-of-sample, since flows only accumulate after enrollment.
 */
export function enrollPrefilterWallet(
  db: Database.Database,
  address: string,
  triggerMint: string | null,
  now: number,
  origin: string = 'winner_sniper',
): 'enrolled' | 'updated' | 'exists' | 'full' {
  ensurePrefilterTables(db);
  const row = db.prepare(
    `SELECT status, trigger_mints FROM winner_prefilter WHERE address = ?`,
  ).get(address) as { status: string; trigger_mints: string } | undefined;
  if (row) {
    if (row.status !== 'watching' || triggerMint == null) return 'exists';
    let mints: string[] = [];
    try { mints = JSON.parse(row.trigger_mints); } catch { mints = []; }
    if (mints.includes(triggerMint)) return 'exists';
    mints.push(triggerMint);
    db.prepare(`UPDATE winner_prefilter SET trigger_mints = ? WHERE address = ?`)
      .run(JSON.stringify(mints), address);
    return 'updated';
  }
  const watching = (db.prepare(
    `SELECT COUNT(*) AS n FROM winner_prefilter WHERE status = 'watching'`,
  ).get() as { n: number }).n;
  if (watching >= PREFILTER_CFG.maxWallets) return 'full';
  db.prepare(`
    INSERT INTO winner_prefilter (address, entered_at, trigger_mints, status, origin)
    VALUES (?, ?, ?, 'watching', ?)
  `).run(address, now, JSON.stringify(triggerMint ? [triggerMint] : []), origin);
  return 'enrolled';
}

/** Count of currently-watched pre-filter wallets enrolled by one origin (sub-cap checks). */
export function countPrefilterWatchingByOrigin(db: Database.Database, origin: string): number {
  try {
    return (db.prepare(
      `SELECT COUNT(*) AS n FROM winner_prefilter WHERE status = 'watching' AND origin = ?`,
    ).get(origin) as { n: number }).n;
  } catch {
    return 0;
  }
}

export function getPrefilterPassedAddresses(db: Database.Database): string[] {
  try {
    return (db.prepare(
      `SELECT address FROM winner_prefilter WHERE status = 'passed'`,
    ).all() as Array<{ address: string }>).map((r) => r.address);
  } catch {
    return [];
  }
}

interface ForwardStats {
  mintsTraded: number;
  closed: number;
  closedWins: number;
  closedNetSol: number;
}

/** Forward stats for one watched wallet: closed-position P&L on non-trigger mints. */
function computeForwardStats(db: Database.Database, address: string, triggerMints: Set<string>): ForwardStats {
  const rows = db.prepare(
    `SELECT mint, sol_in, sol_out, tok_in, tok_out FROM winner_prefilter_flows WHERE address = ?`,
  ).all(address) as Array<{ mint: string; sol_in: number; sol_out: number; tok_in: number; tok_out: number }>;
  const s: ForwardStats = { mintsTraded: 0, closed: 0, closedWins: 0, closedNetSol: 0 };
  for (const r of rows) {
    if (triggerMints.has(r.mint)) continue;
    s.mintsTraded += 1;
    if (r.tok_in <= 0) continue; // sell-only leg (unmatched buy missed offline) — never counts
    if (r.tok_out < PREFILTER_CFG.closeFraction * r.tok_in) continue; // still open — neither pass nor fail
    const realized = r.sol_out - r.sol_in;
    s.closed += 1;
    if (realized > 0) s.closedWins += 1;
    s.closedNetSol += realized;
  }
  return s;
}

export class WinnerPrefilterWatcher {
  private readonly db: Database.Database;
  private ws: WebSocket | null = null;
  private stopped = false;
  private watching: string[] = [];
  private watchSet = new Set<string>();
  private triggerByWallet = new Map<string, Set<string>>();
  private subRequestId = 1;
  private subId: number | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private seen = new Map<string, number>();
  // lifetime counters (status)
  private totalNotifications = 0;
  private totalSwapsRecorded = 0;
  private droppedNonPumpswap = 0;
  private droppedDup = 0;
  private droppedUnparsed = 0;
  private totalPassed = 0;
  private totalFailed = 0;

  constructor(opts: { db: Database.Database }) {
    this.db = opts.db;
  }

  start(): void {
    if (process.env.PREFILTER_DISABLED === 'true') {
      logger.warn('WinnerPrefilterWatcher disabled via PREFILTER_DISABLED (enrolled wallets will TTL-fail unwatched)');
      return;
    }
    if (!process.env.HELIUS_WS_URL) {
      logger.warn('HELIUS_WS_URL not set — winner-prefilter watcher cannot subscribe');
      return;
    }
    ensurePrefilterTables(this.db);
    this.refreshWatchSet(/*connectIfChanged*/ true);
    this.resolveTimer = setInterval(() => {
      try {
        this.resolve();
        this.refreshWatchSet(true);
        this.writeStatus();
      } catch (err) {
        logger.warn('resolve tick failed: %s', err instanceof Error ? err.message : String(err));
      }
    }, PREFILTER_CFG.resolveTickMs);
    logger.info(
      'WinnerPrefilterWatcher started: cap=%d, TTL=%dh, pass = >=%d profitable closed non-trigger mints AND net >= %s SOL, early-fail at -%s',
      PREFILTER_CFG.maxWallets, PREFILTER_CFG.ttlHours, PREFILTER_CFG.minOtherWins,
      PREFILTER_CFG.minNetSol, PREFILTER_CFG.maxLossSol,
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.resolveTimer) { clearInterval(this.resolveTimer); this.resolveTimer = null; }
    this.closeWs();
  }

  private refreshWatchSet(connectIfChanged: boolean): void {
    let rows: Array<{ address: string; trigger_mints: string }> = [];
    try {
      rows = this.db.prepare(
        `SELECT address, trigger_mints FROM winner_prefilter WHERE status = 'watching' ORDER BY address`,
      ).all() as typeof rows;
    } catch { rows = []; }
    this.triggerByWallet = new Map(rows.map((r) => {
      let mints: string[] = [];
      try { mints = JSON.parse(r.trigger_mints); } catch { mints = []; }
      return [r.address, new Set(mints)];
    }));
    const wl = rows.map((r) => r.address);
    const changed = wl.length !== this.watching.length || wl.some((a, i) => a !== this.watching[i]);
    if (!changed) return;
    this.watching = wl;
    this.watchSet = new Set(wl);
    logger.info('Pre-filter watch set updated: %d wallets', wl.length);
    if (connectIfChanged) {
      this.closeWs();
      if (wl.length > 0) this.connect();
    }
  }

  private connect(): void {
    if (this.stopped || this.watching.length === 0) return;
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
          { accountInclude: this.watching, failed: false, vote: false },
          { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 0 },
        ],
      };
      try { ws.send(JSON.stringify(msg)); } catch { /* surfaces via close */ }
      this.connected = true;
      this.reconnectDelay = 1000;
      logger.info('transactionSubscribe sent for %d pre-filter wallets', this.watching.length);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(data.toString()) as Record<string, unknown>; } catch { return; }
      if (typeof (msg as { result?: unknown }).result === 'number') { this.subId = (msg as { result: number }).result; return; }
      if ((msg as { method?: string }).method === 'transactionNotification') {
        usageTracker.recordWs('discovery_prefilter_ws'); // LaserStream billing attribution
        this.totalNotifications++;
        this.handleNotification((msg as { params?: unknown }).params);
      }
    });

    ws.on('error', () => { /* 'close' drives reconnect */ });
    ws.on('close', () => {
      this.connected = false;
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private closeWs(): void {
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
    this.connected = false;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Re-read the watch set before reconnecting — it may have resolved empty.
      this.refreshWatchSet(false);
      if (this.watching.length > 0) this.connect();
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

  /** Watched wallets present in a tx (static keys + lookup-table loaded addresses). */
  private involvedWatched(tx: ParsedTransactionWithMeta): string[] {
    const keys: string[] = tx.transaction.message.accountKeys.map((k) =>
      typeof (k as { pubkey?: { toBase58(): string } }).pubkey !== 'undefined'
        ? (k as { pubkey: { toBase58(): string } }).pubkey.toBase58()
        : String(k));
    for (const arr of [tx.meta?.loadedAddresses?.writable, tx.meta?.loadedAddresses?.readonly]) {
      for (const k of arr ?? []) keys.push(typeof k === 'string' ? k : k.toBase58());
    }
    return keys.filter((k) => this.watchSet.has(k));
  }

  private handleNotification(params: unknown): void {
    const p = params as { result?: Record<string, unknown> } | undefined;
    const result = p?.result ?? {};
    const value = (result as { value?: Record<string, unknown> }).value ?? result;

    const sig =
      (value as { signature?: string }).signature ??
      (value as { transaction?: { transaction?: { signatures?: string[] } } }).transaction?.transaction?.signatures?.[0];
    if (sig && this.isDup(sig)) { this.droppedDup++; return; }

    const tx = wsNotificationToTx(value as Record<string, unknown>);
    if (!tx) { this.droppedUnparsed++; return; }

    const nowSec = Math.floor(Date.now() / 1000);
    for (const wallet of this.involvedWatched(tx)) {
      const swap = parseSwapForOwner(tx, wallet);
      if (!swap) continue;
      // Operator spec: forward profit is measured on PumpSwap-protocol tokens only.
      if (swap.venue !== PUMPSWAP_VENUE) { this.droppedNonPumpswap++; continue; }
      this.recordFlow(wallet, swap.mint, swap.action, Math.abs(swap.solDelta), Math.abs(swap.tokenDelta), nowSec);
      this.totalSwapsRecorded++;
    }
  }

  private recordFlow(address: string, mint: string, action: 'buy' | 'sell', sol: number, tokens: number, nowSec: number): void {
    try {
      this.db.prepare(`
        INSERT INTO winner_prefilter_flows (address, mint, buys, sells, sol_in, sol_out, tok_in, tok_out, first_ts, last_ts)
        VALUES (@address, @mint, @buy, @sell, @solIn, @solOut, @tokIn, @tokOut, @now, @now)
        ON CONFLICT(address, mint) DO UPDATE SET
          buys = buys + excluded.buys,
          sells = sells + excluded.sells,
          sol_in = sol_in + excluded.sol_in,
          sol_out = sol_out + excluded.sol_out,
          tok_in = tok_in + excluded.tok_in,
          tok_out = tok_out + excluded.tok_out,
          last_ts = excluded.last_ts
      `).run({
        address, mint, now: nowSec,
        buy: action === 'buy' ? 1 : 0, sell: action === 'sell' ? 1 : 0,
        solIn: action === 'buy' ? sol : 0, solOut: action === 'sell' ? sol : 0,
        tokIn: action === 'buy' ? tokens : 0, tokOut: action === 'sell' ? tokens : 0,
      });
    } catch (err) {
      logger.warn('flow write failed: %s', err instanceof Error ? err.message : String(err));
    }
  }

  /** Pass/fail every watching wallet against the forward bar; clean up old failures. */
  private resolve(): void {
    const now = Math.floor(Date.now() / 1000);
    let rows: Array<{ address: string; entered_at: number; trigger_mints: string; origin: string | null }> = [];
    try {
      rows = this.db.prepare(
        `SELECT address, entered_at, trigger_mints, origin FROM winner_prefilter WHERE status = 'watching'`,
      ).all() as typeof rows;
    } catch { return; }

    const pass = this.db.prepare(
      `UPDATE winner_prefilter SET status = 'passed', resolved_at = ? WHERE address = ?`,
    );
    const fail = this.db.prepare(
      `UPDATE winner_prefilter SET status = 'failed', resolved_at = ?, fail_reason = ? WHERE address = ?`,
    );

    for (const r of rows) {
      let trigger = new Set<string>();
      try { trigger = new Set(JSON.parse(r.trigger_mints) as string[]); } catch { /* empty */ }
      const s = computeForwardStats(this.db, r.address, trigger);
      // Pass is checked FIRST so a wallet that clears the bar right at the TTL edge still passes.
      if (s.closedWins >= PREFILTER_CFG.minOtherWins && s.closedNetSol >= PREFILTER_CFG.minNetSol) {
        pass.run(now, r.address);
        upsertCandidate(this.db, r.address, r.origin ?? 'winner_sniper', now);
        this.totalPassed++;
        logger.info('PASS %s: %d profitable closed mints, net %s SOL → promoted to scorer',
          r.address.slice(0, 8), s.closedWins, s.closedNetSol.toFixed(3));
        continue;
      }
      if (s.closedNetSol <= -PREFILTER_CFG.maxLossSol) {
        fail.run(now, 'loss', r.address);
        this.totalFailed++;
        continue;
      }
      if (now - r.entered_at > PREFILTER_CFG.ttlHours * 3600) {
        fail.run(now, 'ttl', r.address);
        this.totalFailed++;
      }
    }

    // Cleanup: failed rows (and their flows) age out so a wallet can earn re-entry later.
    try {
      const cutoff = now - PREFILTER_CFG.failRetentionDays * 86_400;
      this.db.prepare(`
        DELETE FROM winner_prefilter_flows WHERE address IN (
          SELECT address FROM winner_prefilter WHERE status = 'failed' AND COALESCE(resolved_at, 0) < ?
        )
      `).run(cutoff);
      this.db.prepare(
        `DELETE FROM winner_prefilter WHERE status = 'failed' AND COALESCE(resolved_at, 0) < ?`,
      ).run(cutoff);
    } catch { /* best-effort */ }
  }

  private writeStatus(): void {
    try {
      const counts = this.db.prepare(`
        SELECT
          SUM(CASE WHEN status = 'watching' THEN 1 ELSE 0 END) AS watching,
          SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS passed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM winner_prefilter
      `).get() as { watching: number | null; passed: number | null; failed: number | null };
      const status = {
        connected: this.connected,
        sub_id: this.subId,
        watching: counts.watching ?? 0,
        passed: counts.passed ?? 0,
        failed: counts.failed ?? 0,
        total_notifications: this.totalNotifications,
        total_swaps_recorded: this.totalSwapsRecorded,
        dropped_non_pumpswap: this.droppedNonPumpswap,
        dropped_dup: this.droppedDup,
        dropped_unparsed: this.droppedUnparsed,
        session_passed: this.totalPassed,
        session_failed: this.totalFailed,
        updated_at: Date.now(),
      };
      this.db.prepare(`
        INSERT INTO bot_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(STATUS_KEY, JSON.stringify(status));
    } catch { /* non-fatal */ }
  }
}

/** Pre-filter panel for copy-trades.json (nested under winner_sniper). Cheap SQL. */
export function getWinnerPrefilterSummary(db: Database.Database): unknown {
  const now = Math.floor(Date.now() / 1000);
  try {
    ensurePrefilterTables(db);
    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'watching' THEN 1 ELSE 0 END) AS watching,
        SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS passed,
        SUM(CASE WHEN status = 'failed' AND fail_reason = 'ttl' THEN 1 ELSE 0 END) AS failed_ttl,
        SUM(CASE WHEN status = 'failed' AND fail_reason = 'loss' THEN 1 ELSE 0 END) AS failed_loss,
        SUM(CASE WHEN entered_at >= ? THEN 1 ELSE 0 END) AS entered_24h
      FROM winner_prefilter
    `).get(now - 86_400) as Record<string, number | null>;
    // Per-origin funnel split (winner_sniper vs gradspec) — how each enrolling source's
    // wallets are faring through the shared forward gate.
    let byOrigin: Array<Record<string, unknown>> = [];
    try {
      byOrigin = db.prepare(`
        SELECT COALESCE(origin, 'winner_sniper') AS origin,
          SUM(CASE WHEN status = 'watching' THEN 1 ELSE 0 END) AS watching,
          SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS passed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM winner_prefilter GROUP BY 1 ORDER BY 1
      `).all() as Array<Record<string, unknown>>;
    } catch { /* origin column may not exist yet */ }
    let status: Record<string, unknown> | null = null;
    try {
      const s = db.prepare(`SELECT value FROM bot_settings WHERE key = ?`).get(STATUS_KEY) as { value: string } | undefined;
      status = s ? JSON.parse(s.value) : null;
    } catch { /* ignore */ }
    // Progress of the currently-watched wallets (top by observed activity).
    const watching = (db.prepare(`
      SELECT address, entered_at, trigger_mints FROM winner_prefilter WHERE status = 'watching'
    `).all() as Array<{ address: string; entered_at: number; trigger_mints: string }>);
    const progress = watching.map((w) => {
      let trigger = new Set<string>();
      try { trigger = new Set(JSON.parse(w.trigger_mints) as string[]); } catch { /* empty */ }
      const s = computeForwardStats(db, w.address, trigger);
      return {
        address: w.address,
        hours_in: +((now - w.entered_at) / 3600).toFixed(1),
        mints_traded: s.mintsTraded,
        closed: s.closed,
        closed_wins: s.closedWins,
        closed_net_sol: +s.closedNetSol.toFixed(4),
      };
    }).sort((a, b) => b.mints_traded - a.mints_traded).slice(0, 15);
    const recentPasses = (db.prepare(`
      SELECT address, entered_at, resolved_at FROM winner_prefilter
      WHERE status = 'passed' ORDER BY resolved_at DESC LIMIT 10
    `).all() as Array<{ address: string; entered_at: number; resolved_at: number }>).map((r) => ({
      address: r.address,
      hours_to_pass: +((r.resolved_at - r.entered_at) / 3600).toFixed(1),
    }));
    return {
      note:
        'Stage-2 forward pre-filter (operator pipeline 2026-07-04): wallets that took profit on an ' +
        'observed winner are WATCHED (own transactionSubscribe, zero RPC) across ALL PumpSwap tokens. ' +
        `PASS = >=${PREFILTER_CFG.minOtherWins} profitable CLOSED positions on non-trigger mints AND ` +
        `net >= ${PREFILTER_CFG.minNetSol} SOL within ${PREFILTER_CFG.ttlHours}h (early-fail at -${PREFILTER_CFG.maxLossSol}). ` +
        'Passing promotes the wallet to the FIFO scorer; the relaxed source gate then decides tradability.',
      config: PREFILTER_CFG,
      watching: counts.watching ?? 0,
      passed: counts.passed ?? 0,
      failed_ttl: counts.failed_ttl ?? 0,
      failed_loss: counts.failed_loss ?? 0,
      entered_24h: counts.entered_24h ?? 0,
      by_origin: byOrigin,
      watcher: status,
      watching_progress: progress,
      recent_passes: recentPasses,
    };
  } catch {
    return { note: 'pre-filter tables not yet created (no wallet has cleared the stage-1 bar)' };
  }
}
