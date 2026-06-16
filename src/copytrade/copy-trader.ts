import Database from 'better-sqlite3';
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchVaultPrice } from '../trading/executor';
import { SIM_DEFAULT_COST_PCT } from '../api/sim-constants';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { computeCopyRegime, currentRegimeScore, COPY_REGIME_BASELINE } from './copy-regime';
import { computeMacroRegime, currentMacroScore } from './macro-regime';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('copy-trader');

/**
 * Shadow copy-trader (Option B, Phase 2).
 *
 * When a followed ("smart") wallet buys a graduated token, each armed copy
 * strategy opens a SHADOW position (no real funds) at the current pool price —
 * which already reflects the lead wallet's market impact, since we detect ~1.1s
 * after their fill. Positions are tracked until they exit per the strategy rule.
 * net P&L is modeled after the SIM round-trip cost.
 *
 * Exit engine supports: fixed TP/SL, follow-the-lead's-sell, max-hold, a
 * breakeven stop, a tiered ratchet (raise the stop as the position climbs),
 * scale-out (sell a fraction at +X%, let the rest ride), and entry-side
 * conviction gates (only copy top-ranked leads, or tokens with consensus).
 * High-water mark + scale-out state persist on the row so restarts resume
 * correctly. Default-on, shadow only (COPY_TRADER_DISABLED to turn off).
 *
 * Self-contained: does NOT use the live PositionManager / trades_v2 path. Pool/
 * vaults resolved from graduations.new_pool_address (so only tokens we tracked
 * are copyable — a deliberate, expandable limitation).
 */

const POOL_BASE_VAULT_OFFSET = 139;   // matches PriceCollector / graduation-listener
const POOL_QUOTE_VAULT_OFFSET = 171;

export interface RatchetTier { atPct: number; stopPct: number; } // once HWM >= entry*(1+atPct), stop to entry*(1+stopPct)

export interface CopyStrategy {
  id: string;
  tpPct: number | null;
  slPct: number | null;        // base stop; may be raised by breakeven/ratchet
  exitFollow: boolean;
  maxHoldSec: number | null;   // null = hold indefinitely
  breakevenAtPct?: number;     // once HWM >= +this%, raise stop to entry + breakevenBufferPct
  breakevenBufferPct?: number; // default 3 (entry + cost)
  ratchet?: RatchetTier[];     // tiered raised cutoff
  scaleOut?: { atPct: number; fraction: number }; // sell fraction at +atPct, rest rides
  minLeadRank?: number;        // only copy if lead wallet's follow_list rank <= this
  minConsensusRecent?: number; // only copy if >= N distinct smart wallets bought this mint in last 10min
  walletAllowlist?: string[];  // only copy if the lead wallet is in this set (copy-best-wallet)
  entryPenaltyPct?: number;    // worsen entry price by this % to model realistic copy lag (shadow enters at the
                               // optimistic ~1.1s pool snapshot; a real tx confirms seconds later, after the
                               // token has run further — so we fill higher). TP/SL/HWM all key off the penalized entry.
                               // ASSUMED drift — kept as a control; prefer entryDelaySec, which measures it.
  exitPenaltyPct?: number;     // worsen the exit fill by this % (sell lands 1-2 blocks after the trigger price,
                               // after the token has moved against us). Applied uniformly to every exit reason
                               // and to scale-out partials; the penalized fill is what gets stored + netted.
                               // ASSUMED drift — kept as a control; prefer followSellDelaySec for follow exits.
  entryDelaySec?: number;      // measured-lag entry: wait this long after lead-buy detection, re-fetch the pool
                               // price, and enter at THAT price. Detection is ~1.1s post-fill, so delay 5 ≈ a
                               // ~6s real copy execution. Drift is measured (stored in entry_drift_pct), not assumed.
  followSellDelaySec?: number; // follow_sell exits only: wait this long after the lead-sell detection, re-fetch,
                               // and close at that price. Bot-triggered exits (TP/SL/timeout/trail) are NOT
                               // delayed — they come from our own polling, not from seeing the lead's tx.
  maxEntryDriftPct?: number;   // drift gate (needs entryDelaySec): at delayed-entry time, skip the copy if the
                               // price ran more than this % ABOVE the detection snapshot (don't chase). Skips
                               // are recorded as status='skipped' rows with the measured drift.
  minLeadBuySol?: number;      // conviction gate: only copy when the lead's own buy was >= this many SOL
                               // (parsed from their tx). Small buys are spam/probing; size = conviction.
  hotLeadGate?: { lastN: number; minTrades: number; minNetSol: number };
                               // lead-momentum gate: look at OUR last `lastN` closed baseline copies of this
                               // lead; require >= minTrades of history and sum(net_sol) > minNetSol. Benches
                               // leads who are currently losing us money; new leads with no history are skipped.
  regimeGateMinScore?: number; // regime gate: only enter when the current 1-10 window score (computed from
                               // the roster-stable baseline; 10 best, 1 worst, 5 neutral) is >= this. Tests
                               // "skip the bad windows" — the copy book swings hard (-31/+44/-35 SOL days)
                               // and this rides only the favorable tape.
  macroGateMinScore?: number;  // macro gate: only enter when the broad-crypto-market score (1-10 from BTC/SOL
                               // 7d trend + Fear & Greed; macro-regime.ts) is >= this. Tests "only trade when
                               // the overall market is rising". Missing macro data scores 5 (doesn't block).
}

export const COPY_STRATEGIES: CopyStrategy[] = [
  // ── KEEP: the three robust variants (positive net + the only ones whose edge
  //    survives drop_top3 / exit-stress) plus the paired baseline they're compared to.
  { id: 'copy-followsell',        tpPct: null, slPct: null, exitFollow: true,  maxHoldSec: null },
  { id: 'copy-tp100-sl30',        tpPct: 100,  slPct: 30,   exitFollow: false, maxHoldSec: null }, // PAIRED_BASELINE — keep
  { id: 'copy-conviction-consensus2', tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null, minConsensusRecent: 2 },
  // ── WATCH: fat-tail hold variants — strongly positive net but negative drop_top3
  //    (lottery-driven). Kept on watch, not promotable as-is.
  { id: 'copy-hold30m',           tpPct: null, slPct: 30,   exitFollow: false, maxHoldSec: 1800 },
  { id: 'copy-hold2h',            tpPct: null, slPct: 30,   exitFollow: false, maxHoldSec: 7200 },
  // ── F: measured-lag twins of the three robust variants (followsell / tp100-sl30 /
  //    consensus2). The flat-% cons twins above ASSUME 5% entry drift; these WAIT
  //    entryDelaySec after detection and re-fetch the real pool price, so drift is
  //    measured per-trade. Detection ~1.1s post-fill + 5s wait ≈ 6s real copy latency
  //    (middle of the observed 5-7s). followSellDelaySec applies the same wait to
  //    follow_sell exits only; TP/SL exits are bot-triggered and stay undelayed.
  { id: 'copy-tp100-sl30-lag',  tpPct: 100,  slPct: 30,   exitFollow: false, maxHoldSec: null, entryDelaySec: 5 },
  { id: 'copy-followsell-lag',  tpPct: null, slPct: null, exitFollow: true,  maxHoldSec: null, entryDelaySec: 5, followSellDelaySec: 5 },
  { id: 'copy-consensus2-lag',  tpPct: 100,  slPct: 30,   exitFollow: false, maxHoldSec: null, minConsensusRecent: 2, entryDelaySec: 5 },
  // ── G: drift-skip — same measured-lag twins, but skip the copy when the price has
  //    already run >X% above the detection snapshot during the wait (don't chase the
  //    pump we just watched happen). Skips are recorded, so the skip rate is visible.
  { id: 'copy-tp100-sl30-lag-drift10', tpPct: 100,  slPct: 30,   exitFollow: false, maxHoldSec: null, entryDelaySec: 5, maxEntryDriftPct: 10 },
  { id: 'copy-followsell-lag-drift10', tpPct: null, slPct: null, exitFollow: true,  maxHoldSec: null, entryDelaySec: 5, followSellDelaySec: 5, maxEntryDriftPct: 10 },
  { id: 'copy-consensus2-lag-drift5',  tpPct: 100,  slPct: 30,   exitFollow: false, maxHoldSec: null, minConsensusRecent: 2, entryDelaySec: 5, maxEntryDriftPct: 5 },
  { id: 'copy-consensus2-lag-drift10', tpPct: 100,  slPct: 30,   exitFollow: false, maxHoldSec: null, minConsensusRecent: 2, entryDelaySec: 5, maxEntryDriftPct: 10 },
  // ── H (2026-06-12): smart-wallet-data gates, all on the conservative lag+drift10
  //    base (the best early construction). Each isolates ONE new signal:
  // H1 regime gate — only enter when the 1-10 window score is favorable. Direct
  //    test of "the edge is real but only in good windows" (book swings -31/+44/-35
  //    SOL/day). Two thresholds bracket the question: -hi (>=7, only strong windows)
  //    and -mid (>=5, just avoid the below-average tape). The old net>0 gate (now
  //    copy-regime-green, removed) was too strict — it sat out everything (n=0).
  { id: 'copy-regime-hi',   tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, regimeGateMinScore: 7 },
  { id: 'copy-regime-mid',  tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, regimeGateMinScore: 5 },
  // H4 (2026-06-15) macro gate — only enter when the broad crypto market is a
  //    tailwind (BTC/SOL 7d trend + Fear & Greed, 1-10). copy-macro isolates the
  //    macro signal; copy-macro-regime requires BOTH macro AND copy-internal regime
  //    favorable (the "both green" the operator asked for). Macro data is free/cached
  //    (market_daily) so these add no RPC.
  { id: 'copy-macro',        tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, macroGateMinScore: 6 },
  { id: 'copy-macro-regime', tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, macroGateMinScore: 6, regimeGateMinScore: 5 },
  // H2 hot-lead gate — only copy leads whose last <=10 baseline copies made us
  //    money (>=3 trades of history). Benches cold hands; tests whether lead-level
  //    performance persists short-term.
  { id: 'copy-hotlead',       tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, hotLeadGate: { lastN: 10, minTrades: 3, minNetSol: 0 } },
  // H3 conviction-size gate — only copy lead buys >= 2 SOL. Small buys are
  //    spam/probing; size = conviction. lead_buy_sol is stored on every row, so
  //    the threshold is tunable from data after a week.
  { id: 'copy-bigbuy',        tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, minLeadBuySol: 2 },
  // ── I (2026-06-15): copy-hotlead is the one signal clearing all three robustness
  //    checks (net+drop3+stress, 48% WR). The two working levers are LEAD selection
  //    (hotlead) and WINDOW selection (regime). Indiscriminate copying bleeds. So:
  //    double down on hotlead × one orthogonal second factor. All on the lag+drift10
  //    base, all heavily gated (fire rarely → negligible RPC). Each isolates whether
  //    the second factor compounds with lead quality.
  // I1 lead × window — stack the two independently-working filters: a hot lead in a
  //    non-bad window. If both edges are real and independent, this should be cleanest.
  { id: 'copy-hotlead-regime',    tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, hotLeadGate: { lastN: 10, minTrades: 3, minNetSol: 0 }, regimeGateMinScore: 5 },
  // I2 lead × token — hotlead picks good WHO; consensus picks good WHAT (>=2 smart
  //    wallets buying the same token). Two orthogonal quality signals stacked.
  { id: 'copy-hotlead-consensus', tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, hotLeadGate: { lastN: 10, minTrades: 3, minNetSol: 0 }, minConsensusRecent: 2 },
  // I3 lead × runner-capture exit — the holds (hold30m/2h) have huge net but terrible
  //    drop3 (lottery: profit is 3 moonshots). Hypothesis: good leads pick the runners,
  //    so applying lead selection to a 30m hold should CONCENTRATE the winners and turn
  //    the lottery into positive drop3. Same hold30m exit (SL30, no TP, 30m timeout) but
  //    only on hot leads.
  { id: 'copy-hotlead-hold30m',   tpPct: null, slPct: 30, exitFollow: false, maxHoldSec: 1800,
    entryDelaySec: 5, maxEntryDriftPct: 10, hotLeadGate: { lastN: 10, minTrades: 3, minNetSol: 0 } },
  // I4 hotlead parameter sweep — copy-hotlead works at {last10, >=3, net>0}; bracket
  //    the calibration. -strict raises the net floor (lead must be clearly profitable
  //    recently, not marginally positive); -deep uses a longer, more stable lookback.
  { id: 'copy-hotlead-strict', tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, hotLeadGate: { lastN: 10, minTrades: 3, minNetSol: 0.5 } },
  { id: 'copy-hotlead-deep',   tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, hotLeadGate: { lastN: 20, minTrades: 5, minNetSol: 0 } },
  // ── KILLED 2026-06-11 (no edge): copy-tp50-sl20, copy-tp200-sl40, copy-tp100-sl50-follow,
  //    copy-be10-plus3 (net ~0, drop3 deeply negative, WR 10%), copy-ratchet (-20),
  //    copy-scaleout50, copy-conviction-toplead (-4.9), copy-hold6h (-25.7).
  // ── KILLED 2026-06-11 (no signal): the copy-best-wallet group (copy-igiybn-follow,
  //    copy-igiybn-ratchet, copy-2snlnx-follow, copy-buwg6b-follow). These mirror a
  //    single allowlisted wallet each; all three wallets went dormant (~4d since last
  //    active per wallet-leaderboard), so igiybn produced ZERO copyable buys and the
  //    other two only 17-18 (both slightly negative). Single-wallet mirroring can't
  //    generate evaluable signal frequency — not a config-strictness issue (igiybn-follow
  //    AND igiybn-ratchet were both 0, so the ratchet exit was never the bottleneck).
  // ── KILLED 2026-06-13 (purpose served): copy-tp100-sl30-cons, copy-followsell-cons.
  //    The assumed flat-5%-entry/2%-exit penalty controls. The measured-lag twins
  //    (entryDelaySec) showed real detection->fill drift is ~0% median (not +5%), so
  //    the cons twins' deep losses (-15.5 / -15.4) were a wrong-assumption artifact.
  //    The lag twins are the honest cost model now; the cons controls are redundant.
];

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

const STRAT_BY_ID = new Map(COPY_STRATEGIES.map((s) => [s.id, s]));

const COPY_SIZE_SOL = parseFloat(process.env.COPY_SIZE_SOL || '0.5');
const MAX_CONCURRENT_PER_STRATEGY = parseInt(process.env.COPY_MAX_CONCURRENT || '40', 10);
const POLL_INTERVAL_MS = parseInt(process.env.COPY_POLL_MS || '15000', 10);
const CONSENSUS_WINDOW_MS = 10 * 60 * 1000;

interface OpenPos {
  id: number;
  strategyId: string;
  mint: string;
  pool: string;
  baseVault: string;
  quoteVault: string;
  entryPrice: number;
  sizeSol: number;
  tpPrice: number | null;
  baseSlPrice: number | null;
  exitFollow: boolean;
  maxHoldSec: number | null;
  entryTs: number;          // unix sec
  highPrice: number;        // HWM (persisted)
  scaledOut: boolean;       // persisted
  realizedPartial: number;  // SOL already realized via scale-out (persisted)
  lastWrittenPrice?: number; // in-memory dedupe for last_price_sol writes
}

interface PoolVaults { pool: string; baseVault: string; quoteVault: string; }

/** Current effective stop price from base SL + breakeven + ratchet (HWM-based).
 *  Pure + exported for testability. Returns null if no stop applies. */
export function effectiveStopPrice(entryPrice: number, highPrice: number, s: CopyStrategy): number | null {
  let stop: number | null = s.slPct != null ? entryPrice * (1 - s.slPct / 100) : null;
  const hwmUpPct = (highPrice / entryPrice - 1) * 100;
  if (s.breakevenAtPct != null && hwmUpPct >= s.breakevenAtPct) {
    const be = entryPrice * (1 + (s.breakevenBufferPct ?? 3) / 100);
    stop = stop == null ? be : Math.max(stop, be);
  }
  for (const t of s.ratchet ?? []) {
    if (hwmUpPct >= t.atPct) {
      const lvl = entryPrice * (1 + t.stopPct / 100);
      stop = stop == null ? lvl : Math.max(stop, lvl);
    }
  }
  return stop;
}

/** net SOL for a portion of `size` exiting at `exitPrice` from `entryPrice`,
 *  after the round-trip cost (%). Pure + exported for testability. */
export function tradeNetSol(entryPrice: number, exitPrice: number, size: number, costPct: number): number {
  const grossPct = entryPrice > 0 ? (exitPrice / entryPrice - 1) * 100 : 0;
  return size * ((grossPct - costPct) / 100);
}

export class CopyTrader {
  private readonly db: Database.Database;
  private readonly getConnection: () => Connection | null;
  private positions = new Map<number, OpenPos>();
  private poolCache = new Map<string, PoolVaults | null>();
  private leadRank = new Map<string, number>();
  // Delayed entries in flight, keyed `${strategyId}:${mint}` — blocks duplicate
  // opens while the entryDelaySec wait runs. In-memory only: a restart drops
  // pending entries (acceptable; the window is ~5s).
  private pendingEntries = new Set<string>();
  // Last lead-sell detection per mint, so a delayed entry that lands AFTER the
  // lead already sold knows it bought into the dump and exits honestly.
  private lastLeadSellMs = new Map<string, number>();
  // Gate-skip funnel: cumulative count of WHY each strategy passed on a lead buy,
  // keyed `${strategyId}|${reason}`. Loaded from bot_settings on start, flushed
  // back periodically. Answers "why is this strategy's n low" (too strict vs no
  // qualifying events). In-memory accumulator + ~60s flush keeps it cheap.
  private skipCounts = new Map<string, number>();
  private lastSkipFlush = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private polling = false;
  private enabled = false;

  constructor(opts: { db: Database.Database; getConnection: () => Connection | null }) {
    this.db = opts.db;
    this.getConnection = opts.getConnection;
  }

  start(): void {
    if (process.env.COPY_TRADER_DISABLED === 'true') {
      logger.info('CopyTrader disabled via COPY_TRADER_DISABLED=true');
      return;
    }
    this.enabled = true;
    this.refreshLeadRanks();
    this.loadOpenPositions();
    this.loadSkipCounts();
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => logger.warn('poll error: %s', err instanceof Error ? err.message : String(err)));
      this.flushSkipCounts();
    }, POLL_INTERVAL_MS);
    logger.info(`CopyTrader started (shadow): ${COPY_STRATEGIES.length} strategies, size=${COPY_SIZE_SOL} SOL, resumed ${this.positions.size} open positions`);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  isEnabled(): boolean { return this.enabled; }

  private refreshLeadRanks(): void {
    try {
      const rows = this.db.prepare(`SELECT address, rank FROM follow_list`).all() as Array<{ address: string; rank: number | null }>;
      this.leadRank = new Map(rows.filter((r) => r.rank != null).map((r) => [r.address, r.rank as number]));
    } catch { /* table may be empty */ }
  }

  private recordSkip(strategyId: string, reason: string): void {
    const k = `${strategyId}|${reason}`;
    this.skipCounts.set(k, (this.skipCounts.get(k) ?? 0) + 1);
  }

  /** Load cumulative skip counts from bot_settings so they survive restarts. */
  private loadSkipCounts(): void {
    try {
      const row = this.db.prepare(`SELECT value FROM bot_settings WHERE key = 'copy_gate_skips'`).get() as { value: string } | undefined;
      if (row?.value) {
        const obj = JSON.parse(row.value) as Record<string, number>;
        this.skipCounts = new Map(Object.entries(obj));
      }
    } catch { /* table may not exist yet / bad JSON — start fresh */ }
  }

  /** Flush the cumulative skip counts to bot_settings (throttled ~60s). */
  private flushSkipCounts(): void {
    const now = Date.now();
    if (now - this.lastSkipFlush < 60_000 || this.skipCounts.size === 0) return;
    this.lastSkipFlush = now;
    try {
      const obj = Object.fromEntries(this.skipCounts);
      this.db.prepare(`INSERT OR REPLACE INTO bot_settings (key, value, updated_at) VALUES ('copy_gate_skips', ?, unixepoch())`)
        .run(JSON.stringify(obj));
    } catch { /* noop — non-critical telemetry */ }
  }

  private loadOpenPositions(): void {
    const rows = this.db.prepare(`SELECT * FROM copy_trades WHERE status = 'open'`).all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      if (!r.base_vault || !r.quote_vault) continue;
      const entry = r.entry_price_sol as number;
      this.positions.set(r.id as number, {
        id: r.id as number,
        strategyId: r.strategy_id as string,
        mint: r.mint as string,
        pool: (r.pool_address as string) ?? '',
        baseVault: r.base_vault as string,
        quoteVault: r.quote_vault as string,
        entryPrice: entry,
        sizeSol: r.size_sol as number,
        tpPrice: (r.tp_price_sol as number) ?? null,
        baseSlPrice: (r.sl_price_sol as number) ?? null,
        exitFollow: r.exit_follow === 1,
        maxHoldSec: (r.max_hold_sec as number) ?? null,
        entryTs: r.entry_ts as number,
        highPrice: (r.high_price_sol as number) ?? entry,
        scaledOut: r.scaled_out === 1,
        realizedPartial: (r.realized_partial_sol as number) ?? 0,
      });
    }
  }

  /** Current 1-10 regime score for the regime gate — cached 60s so a burst of lead
   *  buys doesn't re-run the SQL every time. */
  private regimeCache: { ts: number; score: number } | null = null;
  private regimeScore(): number {
    const now = Date.now();
    if (this.regimeCache && now - this.regimeCache.ts < 60_000) return this.regimeCache.score;
    const score = currentRegimeScore(this.db);
    this.regimeCache = { ts: now, score };
    return score;
  }

  /** Current 1-10 macro-market score — cached 5min (macro data is daily, moves slowly). */
  private macroCache: { ts: number; score: number } | null = null;
  private macroScore(): number {
    const now = Date.now();
    if (this.macroCache && now - this.macroCache.ts < 300_000) return this.macroCache.score;
    const score = currentMacroScore(this.db);
    this.macroCache = { ts: now, score };
    return score;
  }

  /** Lead-momentum stats: OUR realized net over the last N closed baseline copies
   *  of this lead. Cached 60s per wallet. */
  private hotLeadCache = new Map<string, { ts: number; n: number; net: number }>();
  private leadRecentStats(leadWallet: string, lastN: number): { n: number; net: number } {
    const now = Date.now();
    const hit = this.hotLeadCache.get(leadWallet);
    if (hit && now - hit.ts < 60_000) return hit;
    let res = { n: 0, net: 0 };
    try {
      const row = this.db.prepare(`
        SELECT COUNT(*) AS n, COALESCE(SUM(net_sol), 0) AS net FROM (
          SELECT net_sol FROM copy_trades
          WHERE status = 'closed' AND strategy_id = ? AND lead_wallet = ? AND net_sol IS NOT NULL
          ORDER BY exit_ts DESC LIMIT ?
        )
      `).get(COPY_REGIME_BASELINE, leadWallet, lastN) as { n: number; net: number };
      res = { n: row.n, net: row.net };
    } catch { /* table may be empty */ }
    this.hotLeadCache.set(leadWallet, { ts: now, ...res });
    if (this.hotLeadCache.size > 2000) {
      for (const [k, v] of this.hotLeadCache) if (now - v.ts > 600_000) this.hotLeadCache.delete(k);
    }
    return res;
  }

  /** A followed wallet bought `mint` — open shadow copies for armed strategies.
   *  `leadBuySol` is the size of the lead's own buy (|SOL delta| from their tx). */
  async onLeadBuy(mint: string, leadWallet: string, leadTier: string, detectionLagSec: number | null, leadBuySol: number | null = null): Promise<void> {
    if (!this.enabled || this.stopped) return;
    const pv = await this.resolvePool(mint);
    if (!pv) return; // not a tracked-grad mint / pool unresolved
    const conn = this.getConnection();
    if (!conn) return;
    if (!(await globalRpcLimiter.throttleOrDropPriority(20))) return;
    const price = await fetchVaultPrice(conn, pv.baseVault, pv.quoteVault);
    if (!price || price.priceSol <= 0) return;

    const leadRank = this.leadRank.get(leadWallet) ?? Infinity;
    let consensusRecent: number | null = null; // computed lazily, once per call
    const nowSec = Math.floor(Date.now() / 1000);
    const detectMs = Date.now();

    for (const s of COPY_STRATEGIES) {
      const pendingKey = `${s.id}:${mint}`;
      const open = [...this.positions.values()].filter((p) => p.strategyId === s.id);
      // already-positioned / in-flight / at-capacity: not an interesting "gate" skip
      if (open.some((p) => p.mint === mint)) { this.recordSkip(s.id, 'already_open'); continue; }
      if (this.pendingEntries.has(pendingKey)) { this.recordSkip(s.id, 'already_open'); continue; }
      if (open.length >= MAX_CONCURRENT_PER_STRATEGY) { this.recordSkip(s.id, 'at_capacity'); continue; }
      // conviction gates — record the FIRST gate that rejects (funnel semantics)
      if (s.walletAllowlist && !s.walletAllowlist.includes(leadWallet)) { this.recordSkip(s.id, 'wallet_allowlist'); continue; }
      if (s.minLeadRank != null && leadRank > s.minLeadRank) { this.recordSkip(s.id, 'lead_rank'); continue; }
      if (s.minConsensusRecent != null) {
        if (consensusRecent == null) consensusRecent = this.countRecentSmartBuyers(mint);
        if (consensusRecent < s.minConsensusRecent) { this.recordSkip(s.id, 'consensus'); continue; }
      }
      // smart-wallet-data gates (H cohort) — all pure SQL/cached, no RPC
      if (s.minLeadBuySol != null && (leadBuySol == null || leadBuySol < s.minLeadBuySol)) { this.recordSkip(s.id, 'lead_buy_size'); continue; }
      if (s.regimeGateMinScore != null && this.regimeScore() < s.regimeGateMinScore) { this.recordSkip(s.id, 'regime'); continue; }
      if (s.macroGateMinScore != null && this.macroScore() < s.macroGateMinScore) { this.recordSkip(s.id, 'macro'); continue; }
      if (s.hotLeadGate) {
        const st = this.leadRecentStats(leadWallet, s.hotLeadGate.lastN);
        if (st.n < s.hotLeadGate.minTrades || st.net <= s.hotLeadGate.minNetSol) { this.recordSkip(s.id, 'hotlead'); continue; }
      }

      // Measured-lag entry — wait, re-fetch the real price, enter at that.
      if (s.entryDelaySec) {
        this.pendingEntries.add(pendingKey);
        this.openDelayed(s, mint, pv, leadWallet, leadTier, detectionLagSec, price.priceSol, detectMs, leadBuySol)
          .catch((err) => logger.warn('delayed entry error %s %s: %s', s.id, mint.slice(0, 6), err instanceof Error ? err.message : String(err)))
          .finally(() => this.pendingEntries.delete(pendingKey));
        continue;
      }

      // Penalized entry — models a realistic confirmation lag (fill higher than the
      // optimistic ~1.1s snapshot). Default 0 = enter at snapshot price as before.
      const entryP = s.entryPenaltyPct ? price.priceSol * (1 + s.entryPenaltyPct / 100) : price.priceSol;
      const tpPrice = s.tpPct != null ? entryP * (1 + s.tpPct / 100) : null;
      const slPrice = s.slPct != null ? entryP * (1 - s.slPct / 100) : null;
      const id = this.insertOpen({
        strategyId: s.id, mint, pool: pv.pool, baseVault: pv.baseVault, quoteVault: pv.quoteVault,
        leadWallet, leadTier, entryTs: nowSec, entryPrice: entryP, sizeSol: COPY_SIZE_SOL,
        tpPrice, slPrice, exitFollow: s.exitFollow, maxHoldSec: s.maxHoldSec, detectionLagSec,
        detectPrice: price.priceSol, entryDelaySec: null, entryDriftPct: null, leadBuySol,
      });
      if (id == null) continue;
      this.positions.set(id, {
        id, strategyId: s.id, mint, pool: pv.pool, baseVault: pv.baseVault, quoteVault: pv.quoteVault,
        entryPrice: entryP, sizeSol: COPY_SIZE_SOL, tpPrice, baseSlPrice: slPrice,
        exitFollow: s.exitFollow, maxHoldSec: s.maxHoldSec, entryTs: nowSec,
        highPrice: entryP, scaledOut: false, realizedPartial: 0,
      });
    }
  }

  /** Measured-lag entry: wait entryDelaySec after detection, re-fetch the pool price,
   *  apply the drift gate, and enter at the delayed (real) price. The drift between
   *  the detection snapshot and the delayed fill is stored per-trade. */
  private async openDelayed(
    s: CopyStrategy, mint: string, pv: PoolVaults, leadWallet: string, leadTier: string,
    detectionLagSec: number | null, detectPrice: number, detectMs: number,
    leadBuySol: number | null = null,
  ): Promise<void> {
    await sleep((s.entryDelaySec ?? 0) * 1000);
    if (this.stopped) return;
    const conn = this.getConnection();
    if (!conn) return;
    if (!(await globalRpcLimiter.throttleOrDropPriority(20))) return;
    const price = await fetchVaultPrice(conn, pv.baseVault, pv.quoteVault);
    if (!price || price.priceSol <= 0) return;
    const driftPct = +((price.priceSol / detectPrice - 1) * 100).toFixed(3);
    const nowSec = Math.floor(Date.now() / 1000);

    // Drift gate — the price already ran past what we'd chase. Record the skip.
    if (s.maxEntryDriftPct != null && driftPct > s.maxEntryDriftPct) {
      this.insertSkip({
        strategyId: s.id, mint, pool: pv.pool, leadWallet, leadTier, entryTs: nowSec,
        observedPrice: price.priceSol, detectPrice, entryDelaySec: s.entryDelaySec ?? 0,
        entryDriftPct: driftPct, detectionLagSec,
      });
      logger.info('Copy drift-skip %s %s drift=%s%% (gate %s%%)', s.id, mint.slice(0, 6), driftPct, s.maxEntryDriftPct);
      return;
    }

    // Re-check capacity/dedupe — the roster may have changed during the wait.
    const open = [...this.positions.values()].filter((p) => p.strategyId === s.id);
    if (open.some((p) => p.mint === mint) || open.length >= MAX_CONCURRENT_PER_STRATEGY) return;

    const entryP = price.priceSol;
    const tpPrice = s.tpPct != null ? entryP * (1 + s.tpPct / 100) : null;
    const slPrice = s.slPct != null ? entryP * (1 - s.slPct / 100) : null;
    const id = this.insertOpen({
      strategyId: s.id, mint, pool: pv.pool, baseVault: pv.baseVault, quoteVault: pv.quoteVault,
      leadWallet, leadTier, entryTs: nowSec, entryPrice: entryP, sizeSol: COPY_SIZE_SOL,
      tpPrice, slPrice, exitFollow: s.exitFollow, maxHoldSec: s.maxHoldSec, detectionLagSec,
      detectPrice, entryDelaySec: s.entryDelaySec ?? 0, entryDriftPct: driftPct, leadBuySol,
    });
    if (id == null) return;
    const pos: OpenPos = {
      id, strategyId: s.id, mint, pool: pv.pool, baseVault: pv.baseVault, quoteVault: pv.quoteVault,
      entryPrice: entryP, sizeSol: COPY_SIZE_SOL, tpPrice, baseSlPrice: slPrice,
      exitFollow: s.exitFollow, maxHoldSec: s.maxHoldSec, entryTs: nowSec,
      highPrice: entryP, scaledOut: false, realizedPartial: 0,
    };
    this.positions.set(id, pos);

    // Lead sold while our buy was in flight — a real copy bot would have bought
    // into the dump and then chased the exit. Model exactly that: follow-sell out
    // after the same exit delay instead of pretending the entry never happened.
    const soldAtMs = this.lastLeadSellMs.get(mint);
    if (s.exitFollow && soldAtMs != null && soldAtMs >= detectMs) {
      this.scheduleFollowSellClose([pos], s.followSellDelaySec ?? 0);
    }
  }

  /** A followed wallet sold `mint` — close every follow-exit position in it.
   *  Strategies with followSellDelaySec close at the price re-fetched AFTER the
   *  delay (our sell tx lands seconds behind theirs); the rest close at the
   *  detection-time price as before. */
  async onLeadSell(mint: string): Promise<void> {
    if (!this.enabled || this.stopped) return;
    this.lastLeadSellMs.set(mint, Date.now());
    if (this.lastLeadSellMs.size > 2000) {
      const cutoff = Date.now() - 3600_000;
      for (const [m, ts] of this.lastLeadSellMs) if (ts < cutoff) this.lastLeadSellMs.delete(m);
    }
    const toClose = [...this.positions.values()].filter((p) => p.mint === mint && p.exitFollow);
    if (toClose.length === 0) return;
    const immediate = toClose.filter((p) => !STRAT_BY_ID.get(p.strategyId)?.followSellDelaySec);
    const delayed = toClose.filter((p) => STRAT_BY_ID.get(p.strategyId)?.followSellDelaySec);
    if (delayed.length > 0) {
      // group by delay so one re-fetch serves every position with the same lag
      const byDelay = new Map<number, OpenPos[]>();
      for (const p of delayed) {
        const d = STRAT_BY_ID.get(p.strategyId)!.followSellDelaySec!;
        if (!byDelay.has(d)) byDelay.set(d, []);
        byDelay.get(d)!.push(p);
      }
      for (const [d, ps] of byDelay) this.scheduleFollowSellClose(ps, d);
    }
    if (immediate.length === 0) return;
    const conn = this.getConnection();
    let exitPrice: number | null = null;
    if (conn && (await globalRpcLimiter.throttleOrDropPriority(20))) {
      const price = await fetchVaultPrice(conn, immediate[0].baseVault, immediate[0].quoteVault);
      exitPrice = price?.priceSol ?? null;
    }
    for (const p of immediate) this.closePosition(p, 'follow_sell', exitPrice ?? p.entryPrice);
  }

  /** Close positions as follow_sell after `delaySec`, at the price observed THEN.
   *  Positions already closed by TP/SL/timeout during the wait are left alone. */
  private scheduleFollowSellClose(positions: OpenPos[], delaySec: number): void {
    (async () => {
      if (delaySec > 0) await sleep(delaySec * 1000);
      if (this.stopped) return;
      const alive = positions.filter((p) => this.positions.has(p.id));
      if (alive.length === 0) return;
      const conn = this.getConnection();
      let exitPrice: number | null = null;
      if (conn && (await globalRpcLimiter.throttleOrDropPriority(20))) {
        const price = await fetchVaultPrice(conn, alive[0].baseVault, alive[0].quoteVault);
        exitPrice = price?.priceSol ?? null;
      }
      for (const p of alive) this.closePosition(p, 'follow_sell', exitPrice ?? p.entryPrice);
    })().catch((err) => logger.warn('delayed follow-sell error: %s', err instanceof Error ? err.message : String(err)));
  }

  private countRecentSmartBuyers(mint: string): number {
    try {
      const since = Date.now() - CONSENSUS_WINDOW_MS;
      const row = this.db.prepare(
        `SELECT COUNT(DISTINCT wallet_address) AS c FROM copy_probe_events WHERE mint = ? AND action = 'buy' AND detected_at >= ?`,
      ).get(mint, since) as { c: number };
      return row.c;
    } catch { return 0; }
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped || this.positions.size === 0) return;
    this.polling = true;
    try {
      this.refreshLeadRanks();
      const now = Math.floor(Date.now() / 1000);
      const byVault = new Map<string, OpenPos[]>();
      for (const p of this.positions.values()) {
        if (!byVault.has(p.baseVault)) byVault.set(p.baseVault, []);
        byVault.get(p.baseVault)!.push(p);
      }
      for (const ps of byVault.values()) {
        const conn = this.getConnection();
        let price: number | null = null;
        if (conn && (await globalRpcLimiter.throttleOrDropPriority(15))) {
          const r = await fetchVaultPrice(conn, ps[0].baseVault, ps[0].quoteVault);
          price = r?.priceSol ?? null;
        }
        for (const p of ps) {
          const s = STRAT_BY_ID.get(p.strategyId);
          // Strategy removed from the roster (killed) — wind the open bag down at the
          // current price instead of stranding it 'open' forever. One-time cleanup.
          if (!s) { this.closePosition(p, 'strategy_removed', price ?? p.lastWrittenPrice ?? p.highPrice ?? p.entryPrice); continue; }
          // max-hold doesn't need a price
          if (p.maxHoldSec != null && now - p.entryTs >= p.maxHoldSec) {
            this.closePosition(p, 'timeout', price ?? p.highPrice ?? p.entryPrice);
            continue;
          }
          if (price == null || price <= 0) continue;
          // update HWM (persist on new high)
          if (price > p.highPrice) {
            p.highPrice = price;
            try { this.db.prepare(`UPDATE copy_trades SET high_price_sol = ? WHERE id = ?`).run(price, p.id); } catch { /* noop */ }
          }
          // persist last seen price so copy-trades.json can mark open positions
          // to market. Skip the write when unchanged beyond 0.1% to keep poll cheap.
          if (p.lastWrittenPrice == null || Math.abs(price / p.lastWrittenPrice - 1) > 0.001) {
            p.lastWrittenPrice = price;
            try {
              this.db.prepare(`UPDATE copy_trades SET last_price_sol = ?, last_price_ts = ? WHERE id = ?`).run(price, now, p.id);
            } catch { /* noop */ }
          }
          // scale-out (partial realize, runner continues) — partial fill takes the
          // same exit penalty as a full close.
          if (s.scaleOut && !p.scaledOut && price >= p.entryPrice * (1 + s.scaleOut.atPct / 100)) {
            const portion = p.sizeSol * s.scaleOut.fraction;
            const fill = s.exitPenaltyPct ? price * (1 - s.exitPenaltyPct / 100) : price;
            const partialNet = +tradeNetSol(p.entryPrice, fill, portion, SIM_DEFAULT_COST_PCT).toFixed(5);
            p.realizedPartial += partialNet;
            p.scaledOut = true;
            try {
              this.db.prepare(`UPDATE copy_trades SET scaled_out = 1, realized_partial_sol = ? WHERE id = ?`)
                .run(p.realizedPartial, p.id);
            } catch { /* noop */ }
            logger.info('Copy scale-out %s %s +%d%% partial=%s SOL', p.strategyId, p.mint.slice(0, 6), s.scaleOut.atPct, partialNet);
          }
          // exits on the remainder
          const stop = effectiveStopPrice(p.entryPrice, p.highPrice, s);
          if (p.tpPrice != null && price >= p.tpPrice) { this.closePosition(p, 'take_profit', price); continue; }
          if (stop != null && price <= stop) {
            const raised = p.baseSlPrice == null || stop > p.baseSlPrice;
            this.closePosition(p, raised ? 'trail_stop' : 'stop_loss', price);
            continue;
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private closePosition(p: OpenPos, reason: string, rawExitPrice: number): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const remainingSize = this.remainderSize(p);
    // Penalized fill — the trigger price is what we observed; a real sell lands
    // ~1-2 blocks later. Stored + netted on the penalized fill (mirrors entry penalty).
    const exitPen = STRAT_BY_ID.get(p.strategyId)?.exitPenaltyPct ?? 0;
    const exitPrice = exitPen ? rawExitPrice * (1 - exitPen / 100) : rawExitPrice;
    const grossPct = p.entryPrice > 0 ? (exitPrice / p.entryPrice - 1) * 100 : 0;
    const remainderNet = tradeNetSol(p.entryPrice, exitPrice, remainingSize, SIM_DEFAULT_COST_PCT);
    const netSol = +(p.realizedPartial + remainderNet).toFixed(5);
    const holdSec = nowSec - p.entryTs;
    try {
      this.db.prepare(`
        UPDATE copy_trades
        SET status = 'closed', exit_ts = @exit_ts, exit_price_sol = @exit_price,
            exit_reason = @reason, gross_pct = @gross, net_sol = @net, hold_sec = @hold
        WHERE id = @id
      `).run({
        id: p.id, exit_ts: nowSec, exit_price: exitPrice, reason,
        gross: +grossPct.toFixed(3), net: netSol, hold: holdSec,
      });
    } catch (err) {
      logger.warn('closePosition db error: %s', err instanceof Error ? err.message : String(err));
    }
    this.positions.delete(p.id);
    logger.info('Copy close %s %s %s net=%s SOL hold=%ds', p.strategyId, p.mint.slice(0, 6), reason, netSol, holdSec);
  }

  /** Remaining (un-scaled) size of a position. */
  private remainderSize(p: OpenPos): number {
    if (!p.scaledOut) return p.sizeSol;
    const s = STRAT_BY_ID.get(p.strategyId);
    const frac = s?.scaleOut?.fraction ?? 0;
    return p.sizeSol * (1 - frac);
  }

  private async resolvePool(mint: string): Promise<PoolVaults | null> {
    if (this.poolCache.has(mint)) return this.poolCache.get(mint) ?? null;
    const row = this.db.prepare(
      `SELECT new_pool_address AS pool FROM graduations WHERE mint = ? AND new_pool_address IS NOT NULL`,
    ).get(mint) as { pool: string } | undefined;
    if (!row?.pool) { this.poolCache.set(mint, null); return null; }
    let pk: PublicKey;
    try { pk = new PublicKey(row.pool); } catch { this.poolCache.set(mint, null); return null; }
    const conn = this.getConnection();
    if (!conn) return null;
    if (!(await globalRpcLimiter.throttleOrDropPriority(20))) return null;
    let info;
    try { info = await conn.getAccountInfo(pk); } catch { return null; }
    if (!info || info.data.length < POOL_QUOTE_VAULT_OFFSET + 32) { this.poolCache.set(mint, null); return null; }
    const baseVault = new PublicKey(info.data.subarray(POOL_BASE_VAULT_OFFSET, POOL_BASE_VAULT_OFFSET + 32)).toBase58();
    const quoteVault = new PublicKey(info.data.subarray(POOL_QUOTE_VAULT_OFFSET, POOL_QUOTE_VAULT_OFFSET + 32)).toBase58();
    const pv: PoolVaults = { pool: row.pool, baseVault, quoteVault };
    this.poolCache.set(mint, pv);
    return pv;
  }

  private insertOpen(d: {
    strategyId: string; mint: string; pool: string; baseVault: string; quoteVault: string;
    leadWallet: string; leadTier: string; entryTs: number; entryPrice: number; sizeSol: number;
    tpPrice: number | null; slPrice: number | null; exitFollow: boolean; maxHoldSec: number | null;
    detectionLagSec: number | null;
    detectPrice: number | null; entryDelaySec: number | null; entryDriftPct: number | null;
    leadBuySol?: number | null;
  }): number | null {
    const res = this.db.prepare(`
      INSERT OR IGNORE INTO copy_trades
        (strategy_id, mint, pool_address, base_vault, quote_vault, lead_wallet, lead_tier,
         entry_ts, entry_price_sol, size_sol, tp_price_sol, sl_price_sol, exit_follow,
         max_hold_sec, detection_lag_sec, high_price_sol, scaled_out, realized_partial_sol, status,
         detect_price_sol, entry_delay_sec, entry_drift_pct, lead_buy_sol)
      VALUES
        (@strategy_id, @mint, @pool, @base_vault, @quote_vault, @lead_wallet, @lead_tier,
         @entry_ts, @entry_price, @size, @tp, @sl, @exit_follow,
         @max_hold, @lag, @entry_price, 0, 0, 'open',
         @detect_price, @entry_delay, @entry_drift, @lead_buy)
    `).run({
      strategy_id: d.strategyId, mint: d.mint, pool: d.pool, base_vault: d.baseVault, quote_vault: d.quoteVault,
      lead_wallet: d.leadWallet, lead_tier: d.leadTier, entry_ts: d.entryTs, entry_price: d.entryPrice,
      size: d.sizeSol, tp: d.tpPrice, sl: d.slPrice, exit_follow: d.exitFollow ? 1 : 0,
      max_hold: d.maxHoldSec, lag: d.detectionLagSec,
      detect_price: d.detectPrice, entry_delay: d.entryDelaySec, entry_drift: d.entryDriftPct,
      lead_buy: d.leadBuySol ?? null,
    });
    return res.changes > 0 ? (res.lastInsertRowid as number) : null;
  }

  /** Record a drift-gate rejection as a status='skipped' row — excluded from all
   *  P&L (open/closed filters), but the skip rate + drift distribution stay visible. */
  private insertSkip(d: {
    strategyId: string; mint: string; pool: string; leadWallet: string; leadTier: string;
    entryTs: number; observedPrice: number; detectPrice: number; entryDelaySec: number;
    entryDriftPct: number; detectionLagSec: number | null;
  }): void {
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO copy_trades
          (strategy_id, mint, pool_address, lead_wallet, lead_tier, entry_ts, entry_price_sol,
           size_sol, exit_follow, detection_lag_sec, status, exit_reason,
           detect_price_sol, entry_delay_sec, entry_drift_pct)
        VALUES
          (@strategy_id, @mint, @pool, @lead_wallet, @lead_tier, @entry_ts, @observed_price,
           0, 0, @lag, 'skipped', 'drift_skip',
           @detect_price, @entry_delay, @entry_drift)
      `).run({
        strategy_id: d.strategyId, mint: d.mint, pool: d.pool, lead_wallet: d.leadWallet,
        lead_tier: d.leadTier, entry_ts: d.entryTs, observed_price: d.observedPrice,
        lag: d.detectionLagSec, detect_price: d.detectPrice, entry_delay: d.entryDelaySec,
        entry_drift: d.entryDriftPct,
      });
    } catch (err) {
      logger.warn('insertSkip db error: %s', err instanceof Error ? err.message : String(err));
    }
  }
}

// ── Published summary (read-only; cheap SQL) ──────────────────────────────
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Per-lead-wallet copy performance, measured on the roster-stable baseline
 * (copy-tp100-sl30) — the same series the hotlead gate keys off. Lead selection
 * is the strongest signal in the book, so this makes it legible: which wallets
 * are making us money, which are bleeding, and which currently pass the hotlead
 * gate (last >=3 of the trailing 10 copies net-positive). Pure SQL, no RPC.
 */
export function computeLeadPerformance(db: Database.Database, baseline = COPY_REGIME_BASELINE): unknown {
  let rows: Array<{ lead: string; net: number; ts: number }> = [];
  try {
    rows = db.prepare(`
      SELECT lead_wallet AS lead, net_sol AS net, exit_ts AS ts
      FROM copy_trades
      WHERE status = 'closed' AND strategy_id = ? AND lead_wallet IS NOT NULL AND net_sol IS NOT NULL
      ORDER BY exit_ts ASC
    `).all(baseline) as typeof rows;
  } catch {
    return { pending: true };
  }
  const byLead = new Map<string, { net: number; wins: number; nets: number[] }>();
  for (const r of rows) {
    let g = byLead.get(r.lead);
    if (!g) { g = { net: 0, wins: 0, nets: [] }; byLead.set(r.lead, g); }
    g.net += r.net; if (r.net > 0) g.wins += 1; g.nets.push(r.net);
  }
  const leads = [...byLead.entries()].map(([lead, g]) => {
    const n = g.nets.length;
    const last10 = g.nets.slice(-10);
    const last10Net = last10.reduce((a, b) => a + b, 0);
    const hot = last10.length >= 3 && last10Net > 0; // matches hotLeadGate default
    return {
      lead: lead.slice(0, 8), n, net_sol: +g.net.toFixed(3), win_rate: +(g.wins / n).toFixed(3),
      last10_net_sol: +last10Net.toFixed(3), hot,
    };
  });
  const byNet = [...leads].sort((a, b) => b.net_sol - a.net_sol);
  return {
    baseline,
    n_leads: leads.length,
    n_hot: leads.filter((l) => l.hot).length,
    n_cold: leads.filter((l) => !l.hot && l.n >= 3).length,
    top: byNet.slice(0, 12),
    bottom: byNet.slice(-8).reverse(),
  };
}

/**
 * Copy-trade promotion readiness — the copy analogue of the T+30 promotion bar.
 * Formalizes when a copy strategy is ready for a live-micro test. A strategy is
 * PROMOTABLE when ALL gates clear: n>=100, drop_top3>0, exit_stress>0,
 * monthly_run_rate>=3.75 SOL (~$300/mo, the same floor as the main book).
 * Exit-stress replaces the T+30 walk-forward gate — for copy it's the realistic-
 * fill robustness check. Readiness score (0-100) ranks all strategies by how
 * close they are. `summaries` is the by_strategy map already computed.
 */
const COPY_MONTHLY_BAR = 3.75;
function computeCopyPromotion(summaries: Record<string, any>): unknown {
  const rows = Object.entries(summaries).map(([id, s]) => {
    const n = s.n ?? 0;
    const net = s.total_net_sol ?? 0;
    const drop3 = s.total_net_sol_drop_top3 ?? 0;
    const stress = s.total_net_sol_exit_stress ?? 0;
    // monthly run rate from the per-strategy daily series (distinct active days)
    const days = (s.daily ?? []).filter((d: any) => (d.n ?? 0) > 0);
    const activeDays = days.length;
    const monthly = activeDays > 0 ? +((net / activeDays) * 30).toFixed(2) : 0;
    const gates = {
      n_ge_100: n >= 100,
      drop3_positive: drop3 > 0,
      stress_positive: stress > 0,
      monthly_ge_bar: monthly >= COPY_MONTHLY_BAR,
    };
    const promotable = Object.values(gates).every(Boolean);
    // 0-100 readiness: sample 25 + drop3 30 + stress 25 + monthly 20
    const score = +(
      Math.min(1, n / 100) * 25 +
      (drop3 > 0 ? Math.min(1, drop3 / 2) * 30 : 0) +
      (stress > 0 ? Math.min(1, stress / 2) * 25 : 0) +
      Math.max(0, Math.min(1, monthly / COPY_MONTHLY_BAR)) * 20
    ).toFixed(1);
    return { id, n, net_sol: +net.toFixed(3), drop_top3: +drop3.toFixed(3),
      exit_stress: +stress.toFixed(3), monthly_run_rate_sol: monthly, gates, promotable, score };
  });
  rows.sort((a, b) => b.score - a.score);
  return { monthly_bar_sol: COPY_MONTHLY_BAR, n_promotable: rows.filter((r) => r.promotable).length, rows };
}


/** Uniform exit-fill stress: re-net the remainder leg with the exit price worsened
 *  by `penPct`%. Scale-out partials are kept as recorded (their exit prices aren't
 *  stored), so scale-out strategies are slightly under-stressed — noted in the JSON. */
const EXIT_STRESS_PCT = 2;
function stressedNet(r: Record<string, unknown>, s: CopyStrategy | undefined, penPct: number): number | null {
  const entry = r.entry_price_sol as number;
  const exit = r.exit_price_sol as number;
  const size = r.size_sol as number;
  if (typeof entry !== 'number' || typeof exit !== 'number' || typeof size !== 'number' || entry <= 0) return null;
  const frac = r.scaled_out === 1 ? (s?.scaleOut?.fraction ?? 0) : 0;
  const partial = (r.realized_partial_sol as number) ?? 0;
  return partial + tradeNetSol(entry, exit * (1 - penPct / 100), size * (1 - frac), SIM_DEFAULT_COST_PCT);
}

/** Mark an open position to its last polled pool price (after round-trip cost). */
function unrealizedNet(r: Record<string, unknown>, s: CopyStrategy | undefined): number | null {
  const entry = r.entry_price_sol as number;
  const last = r.last_price_sol as number;
  const size = r.size_sol as number;
  if (typeof entry !== 'number' || typeof last !== 'number' || typeof size !== 'number' || entry <= 0 || last <= 0) return null;
  const frac = r.scaled_out === 1 ? (s?.scaleOut?.fraction ?? 0) : 0;
  const partial = (r.realized_partial_sol as number) ?? 0;
  return partial + tradeNetSol(entry, last, size * (1 - frac), SIM_DEFAULT_COST_PCT);
}

export function computeCopyTrades(db: Database.Database): unknown {
  let closed: Array<Record<string, unknown>> = [];
  let open: Array<Record<string, unknown>> = [];
  let skipped: Array<Record<string, unknown>> = [];
  try {
    closed = db.prepare(`SELECT * FROM copy_trades WHERE status = 'closed'`).all() as Array<Record<string, unknown>>;
    open = db.prepare(`SELECT * FROM copy_trades WHERE status = 'open'`).all() as Array<Record<string, unknown>>;
    skipped = db.prepare(`SELECT strategy_id, entry_drift_pct FROM copy_trades WHERE status = 'skipped'`).all() as Array<Record<string, unknown>>;
  } catch {
    return { generated_at: new Date().toISOString(), phase: 'phase2-shadow-copy', pending: true };
  }

  // Gate-skip funnel: cumulative per-strategy skip-by-reason from bot_settings
  // (written by the live CopyTrader). Answers "why is this strategy's n low".
  const gateSkips: Record<string, Record<string, number>> = {};
  try {
    const row = db.prepare(`SELECT value FROM bot_settings WHERE key = 'copy_gate_skips'`).get() as { value: string } | undefined;
    if (row?.value) {
      for (const [k, v] of Object.entries(JSON.parse(row.value) as Record<string, number>)) {
        const i = k.lastIndexOf('|');
        if (i < 0) continue;
        const sid = k.slice(0, i); const reason = k.slice(i + 1);
        (gateSkips[sid] ??= {})[reason] = v;
      }
    }
  } catch { /* no skip data yet */ }

  // Measured entry drift (detection snapshot → delayed fill) for lag strategies:
  // the empirical answer to "what does 5-7s of copy latency actually cost".
  const driftStats = (rows: Array<Record<string, unknown>>) => {
    const ds = rows.map((r) => r.entry_drift_pct as number).filter((v) => typeof v === 'number');
    if (!ds.length) return null;
    return {
      n: ds.length,
      avg_pct: +(ds.reduce((a, b) => a + b, 0) / ds.length).toFixed(2),
      median_pct: +(median(ds) ?? 0).toFixed(2),
      max_pct: +Math.max(...ds).toFixed(2),
    };
  };

  const utcDay = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10);

  const summarize = (rows: Array<Record<string, unknown>>) => {
    const nets = rows.map((r) => r.net_sol as number).filter((v) => typeof v === 'number');
    const total = +nets.reduce((a, b) => a + b, 0).toFixed(4);
    const top3 = [...nets].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
    const wins = nets.filter((v) => v > 0).length;
    const holds = rows.map((r) => r.hold_sec as number).filter((v) => typeof v === 'number');
    const lags = rows.map((r) => r.detection_lag_sec as number).filter((v) => typeof v === 'number');
    const byReason: Record<string, number> = {};
    for (const r of rows) byReason[(r.exit_reason as string) ?? 'unknown'] = (byReason[(r.exit_reason as string) ?? 'unknown'] ?? 0) + 1;
    // exit-fill stress (uniform, on top of any per-strategy penalty already baked in)
    let stressTotal = 0;
    for (const r of rows) {
      const v = stressedNet(r, STRAT_BY_ID.get(r.strategy_id as string), EXIT_STRESS_PCT);
      if (v != null) stressTotal += v;
    }
    // per-UTC-day P&L so regime stability is visible on a young dataset
    const dayMap = new Map<string, { n: number; net: number }>();
    for (const r of rows) {
      const ts = r.exit_ts as number;
      const net = r.net_sol as number;
      if (typeof ts !== 'number' || typeof net !== 'number') continue;
      const d = utcDay(ts);
      const cur = dayMap.get(d) ?? { n: 0, net: 0 };
      cur.n += 1; cur.net += net;
      dayMap.set(d, cur);
    }
    const daily = [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, n: v.n, net_sol: +v.net.toFixed(4) }));
    return {
      n: rows.length,
      total_net_sol: total,
      total_net_sol_drop_top3: +(total - top3).toFixed(4),
      total_net_sol_exit_stress: +stressTotal.toFixed(4),
      win_rate: rows.length ? +(wins / rows.length).toFixed(3) : null,
      median_hold_sec: median(holds),
      avg_detection_lag_sec: lags.length ? +(lags.reduce((a, b) => a + b, 0) / lags.length).toFixed(2) : null,
      by_exit_reason: byReason,
      daily,
    };
  };

  // Open-position mark-to-market — kills the survivorship blind spot where
  // indefinite-hold strategies park losers as open bags outside closed-only P&L.
  const summarizeOpen = (rows: Array<Record<string, unknown>>) => {
    let unrealized = 0;
    let priced = 0;
    for (const r of rows) {
      const v = unrealizedNet(r, STRAT_BY_ID.get(r.strategy_id as string));
      if (v != null) { unrealized += v; priced += 1; }
    }
    return {
      open_positions: rows.length,
      open_priced: priced,
      open_unrealized_sol: +unrealized.toFixed(4),
    };
  };

  // Paired comparison vs a fixed baseline: every strategy copies the same lead-buy
  // events (keyed mint+entry_ts), so totals across strategies are NOT independent.
  // delta_net_sol on common events is the honest exit-variant comparison.
  const PAIRED_BASELINE = 'copy-tp100-sl30';
  const baseByEvent = new Map<string, number>();
  for (const r of closed) {
    if (r.strategy_id !== PAIRED_BASELINE) continue;
    if (typeof r.net_sol !== 'number') continue;
    baseByEvent.set(`${r.mint}:${r.entry_ts}`, r.net_sol as number);
  }
  const pairedVsBaseline: Record<string, unknown> = {};
  for (const s of COPY_STRATEGIES) {
    if (s.id === PAIRED_BASELINE) continue;
    let nCommon = 0;
    let delta = 0;
    for (const r of closed) {
      if (r.strategy_id !== s.id || typeof r.net_sol !== 'number') continue;
      const base = baseByEvent.get(`${r.mint}:${r.entry_ts}`);
      if (base == null) continue;
      nCommon += 1;
      delta += (r.net_sol as number) - base;
    }
    if (nCommon > 0) {
      pairedVsBaseline[s.id] = {
        n_common_events: nCommon,
        delta_net_sol: +delta.toFixed(4),
        avg_delta_sol_per_event: +(delta / nCommon).toFixed(5),
      };
    }
  }

  const byStrategy: Record<string, unknown> = {};
  for (const s of COPY_STRATEGIES) {
    const rows = closed.filter((r) => r.strategy_id === s.id);
    const openForStrat = open.filter((r) => r.strategy_id === s.id);
    const skipsForStrat = skipped.filter((r) => r.strategy_id === s.id);
    const closedSummary = summarize(rows);
    // keep the per-strategy day series bounded; the overall block keeps full history
    closedSummary.daily = closedSummary.daily.slice(-14);
    const openSummary = summarizeOpen(openForStrat);
    const entered = [...rows, ...openForStrat];
    byStrategy[s.id] = {
      config: {
        tp_pct: s.tpPct, sl_pct: s.slPct, exit_follow: s.exitFollow, max_hold_sec: s.maxHoldSec,
        breakeven_at_pct: s.breakevenAtPct ?? null, ratchet: s.ratchet ?? null,
        scale_out: s.scaleOut ?? null, min_lead_rank: s.minLeadRank ?? null, min_consensus: s.minConsensusRecent ?? null,
        entry_penalty_pct: s.entryPenaltyPct ?? null, exit_penalty_pct: s.exitPenaltyPct ?? null,
        entry_delay_sec: s.entryDelaySec ?? null, follow_sell_delay_sec: s.followSellDelaySec ?? null,
        max_entry_drift_pct: s.maxEntryDriftPct ?? null,
        min_lead_buy_sol: s.minLeadBuySol ?? null, hot_lead_gate: s.hotLeadGate ?? null,
        regime_gate_min_score: s.regimeGateMinScore ?? null,
        macro_gate_min_score: s.macroGateMinScore ?? null,
      },
      ...openSummary,
      total_incl_open_sol: +(closedSummary.total_net_sol + openSummary.open_unrealized_sol).toFixed(4),
      ...closedSummary,
      drift_skips: skipsForStrat.length,
      entry_drift: driftStats(entered),
      skipped_drift: driftStats(skipsForStrat),
      // gate funnel: how many lead-buys this strategy passed on, by reason (drift
      // folded in from the 'skipped' rows). entered = closed + open.
      entered: closedSummary.n + (openSummary.open_positions ?? 0),
      gate_skips: { ...(gateSkips[s.id] ?? {}), ...(skipsForStrat.length ? { drift: skipsForStrat.length } : {}) },
    };
  }

  // Overall = ACTIVE strategies only. Killed/retired strategies leave their closed
  // rows in the DB forever; summing all of them turned `overall` into a graveyard
  // (e.g. 2026-06-13: all-rows −81 SOL vs +8 for the 13 live strategies). The
  // header reflects what's actually running; retired history is reported separately.
  const activeIds = new Set(COPY_STRATEGIES.map((s) => s.id));
  const activeClosed = closed.filter((r) => activeIds.has(r.strategy_id as string));
  const activeOpen = open.filter((r) => activeIds.has(r.strategy_id as string));
  const retiredClosed = closed.filter((r) => !activeIds.has(r.strategy_id as string));
  const overallClosed = summarize(activeClosed);
  const overallOpen = summarizeOpen(activeOpen);
  const retiredNet = +retiredClosed.reduce((a, r) => a + ((r.net_sol as number) ?? 0), 0).toFixed(4);

  return {
    generated_at: new Date().toISOString(),
    phase: 'phase2-shadow-copy',
    note: 'SHADOW copy trades — no real funds. Entry at pool price ~1.1s after the lead wallet; net_sol after the SIM round-trip cost (scale-out partials folded in). Coverage limited to tokens in our graduations table. OVERALL counts ACTIVE strategies only (killed strategies leave closed rows in the DB; retired_summary reports those separately). CAVEATS: strategies share entry signals — totals are not independent (see paired_vs_baseline); total_net_sol_exit_stress re-nets every closed remainder leg with the exit fill worsened by ' + EXIT_STRESS_PCT + '% (scale-out partials kept as recorded); open_unrealized_sol marks open positions to the last polled pool price (open_priced = how many have one); total_incl_open_sol = closed + unrealized. MEASURED-LAG (-lag) variants wait entry_delay_sec after detection and enter at the re-fetched price (entry_drift = measured detection→fill drift); follow_sell exits on those variants are re-fetched after follow_sell_delay_sec; -drift variants skip entries whose measured drift exceeds max_entry_drift_pct (drift_skips + skipped_drift report the gate).',
    size_sol: COPY_SIZE_SOL,
    paired_baseline: PAIRED_BASELINE,
    // 1-10 window score + hourly series — "is NOW a good time to copy trade".
    // Baseline series = copy-tp100-sl30 (roster-stable).
    regime: computeCopyRegime(db),
    // 1-10 macro-market score (broad crypto tailwind/headwind) from market_daily.
    macro: computeMacroRegime(db),
    // Per-lead-wallet copy P&L on the baseline — makes the lead-selection signal
    // (the book's strongest) legible: who's hot, who's cold.
    lead_performance: computeLeadPerformance(db),
    // Copy promotion bar (n>=100 · drop3>0 · stress>0 · monthly>=3.75) + readiness.
    promotion: computeCopyPromotion(byStrategy),
    overall: {
      ...overallOpen,
      total_incl_open_sol: +(overallClosed.total_net_sol + overallOpen.open_unrealized_sol).toFixed(4),
      ...overallClosed,
      drift_skips: skipped.filter((r) => activeIds.has(r.strategy_id as string)).length,
      entry_drift: driftStats([...activeClosed, ...activeOpen]),
    },
    // Killed/retired strategies' lingering closed rows — kept out of `overall` so
    // the header isn't dragged down by strategies we already cut.
    retired_summary: { n: retiredClosed.length, net_sol: retiredNet },
    by_strategy: byStrategy,
    paired_vs_baseline: pairedVsBaseline,
    recent_closed: closed
      .sort((a, b) => (b.exit_ts as number ?? 0) - (a.exit_ts as number ?? 0))
      .slice(0, 30)
      .map((r) => ({
        strategy_id: r.strategy_id, mint: (r.mint as string).slice(0, 8), lead: (r.lead_wallet as string ?? '').slice(0, 6),
        tier: r.lead_tier, scaled_out: r.scaled_out === 1, entry_price_sol: r.entry_price_sol, exit_price_sol: r.exit_price_sol,
        exit_reason: r.exit_reason, gross_pct: r.gross_pct, net_sol: r.net_sol, hold_sec: r.hold_sec,
      })),
  };
}
