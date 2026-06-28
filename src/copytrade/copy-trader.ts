import Database from 'better-sqlite3';
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchVaultPrice } from '../trading/executor';
import { SIM_DEFAULT_COST_PCT } from '../api/sim-constants';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { computeCopyRegime, currentRegimeScore, COPY_REGIME_BASELINE } from './copy-regime';
import { computeMacroRegime, currentMacroScore } from './macro-regime';
import { computeWalletLeaderboard } from './leaderboard';
import { CopyLiveExecutor } from './copy-live-executor';
import { MICRO_TRADE_SIZE_SOL } from '../trading/config';
import { getOgSmartSetAddresses, getCotradeSmartSetAddresses } from './queries';
import { getCotradeDiscovery } from './cotrade-discovery';
import { computeLiveTape } from './live-tape-harvester';
import {
  MAX_SELL_ATTEMPTS_BEFORE_TERMINAL,
  sellSlippageBpsForAttempt,
  sellTipMultiplierForAttempt,
  TERMINAL_SELL_ERROR_PATTERNS,
} from '../trading/sell-retry';
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
  trailingTp?: { atPct: number; dropPct: number }; // runner take-profit: once HWM >= entry*(1+atPct),
                                                    // exit the remainder when price falls dropPct% below
                                                    // the high-water mark. Pair with tpPct:null to let the
                                                    // winner ride past the static TP and trail the peak.
  minLeadRank?: number;        // only copy if lead wallet's follow_list rank <= this
  minConsensusRecent?: number; // only copy if >= N distinct smart wallets bought this mint in last 10min
  walletAllowlist?: string[];  // only copy if the lead wallet is in this set (copy-best-wallet)
  leadCohort?: 'og_smart' | 'cotrade';
                               // DISCOVERY-METHOD A/B (Idea 2): only copy when the lead wallet was found by
                               // this discovery method. 'og_smart' = surfaced by the existing DB seed;
                               // 'cotrade' = surfaced by co-trade graph snowball (cotrade-discovery.ts). The
                               // two cohorts are disjoint by wallet_candidates.source, so a cotrade-only and an
                               // og_smart-only strategy with identical params isolate the discovery method's edge.
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
  eliteLeadGate?: { minTrades: number; minNetSol: number };
                               // CUMULATIVE lead-quality gate: lead's all-time baseline copy net must exceed
                               // minNetSol over >= minTrades total copies. Unlike hotLeadGate (noisy last-10
                               // recency), this keys on stable lifetime reputation — the lead data shows the
                               // best leads by cumulative net aren't always "hot" by recency.
  regimeGateMinScore?: number; // regime gate: only enter when the current 1-10 window score (computed from
                               // the roster-stable baseline; 10 best, 1 worst, 5 neutral) is >= this. Tests
                               // "skip the bad windows" — the copy book swings hard (-31/+44/-35 SOL days)
                               // and this rides only the favorable tape.
  macroGateMinScore?: number;  // macro gate: only enter when the broad-crypto-market score (1-10 from BTC/SOL
                               // 7d trend + Fear & Greed; macro-regime.ts) is >= this. Tests "only trade when
                               // the overall market is rising". Missing macro data scores 5 (doesn't block).
  dailyLossCapSol?: number;    // daily-loss circuit breaker (research, 2026-06-23): once THIS strategy's realized
                               // net for the current UTC day is <= -dailyLossCapSol, halt NEW entries for the rest
                               // of the day (resets 00:00 UTC). Reactive, not predictive — regime can't tell a +54
                               // day from a -74 day (backtested), but a loss cap keeps the good days and caps the
                               // disasters. Open positions still close normally.
  executionMode?: 'shadow' | 'live_micro';
                               // 'shadow' (default) = modeled fills, no funds. 'live_micro' = submit REAL 0.05
                               // SOL swaps via CopyLiveExecutor — but ONLY when COPY_LIVE_ENABLED=true + wallet;
                               // otherwise it's shadowed. Pair a live_micro strategy with an identical shadow
                               // twin to measure the real-fill-vs-model execution gap (live-vs-shadow panel).
  tradeSizeSol?: number;       // explicit trade-size override (SOL). Default: COPY_SIZE_SOL (shadow). A
                               // pair-shadow twin sets MICRO_TRADE_SIZE_SOL (0.05) so it's apples-to-apples
                               // with its live (no size-scaling in the comparison).
  drivenBy?: string;           // PAIR-SHADOW-DRIVEN LIVE: if set, this (live) strategy does NOT self-gate in
                               // onLeadBuy. Its entries are spawned 1:1 by its pair shadow (id in drivenBy)
                               // at the moment that shadow opens, and it follows the pair shadow's exits.
                               // Live keeps its own SL/TP/maxHold as a SOONER-ONLY safety backstop (recommendation
                               // A). Guarantees live ⊆ pair shadow — live can never enter a lead-buy the pair
                               // shadow didn't, so no "rogue" un-twinned live trades.
}

// Pair-shadow-driven live cohort generator. From a base config, emit a dedicated
// 0.05-SOL PAIR SHADOW (modeled) + a 0.05-SOL LIVE that the pair shadow drives 1:1:
// the live enters when the pair shadow enters (same lead-buy event, shared copy_event_id)
// and follows its exits, keeping its own SL/TP/maxHold only as a SOONER-ONLY safety
// backstop. The ORIGINAL base strategy (0.5) is NOT emitted here — it stays elsewhere as
// a trend benchmark only. This is the correct twin pattern: the live can never enter a
// lead-buy its pair shadow didn't, so there are no "rogue" un-twinned live trades.
function makeLivePair(base: CopyStrategy): CopyStrategy[] {
  const pairId = `${base.id}-pair-shadow`;
  return [
    { ...base, id: pairId, tradeSizeSol: MICRO_TRADE_SIZE_SOL },
    { ...base, id: `${base.id}-live-micro`, tradeSizeSol: MICRO_TRADE_SIZE_SOL,
      executionMode: 'live_micro', drivenBy: pairId },
  ];
}

export const COPY_STRATEGIES: CopyStrategy[] = [
  // ── KEEP: the three robust variants (positive net + the only ones whose edge
  //    survives drop_top3 / exit-stress) plus the paired baseline they're compared to.
  // ── KILLED 2026-06-23 (INVALID): copy-followsell — n=2210, drop_top3 -25, exit_stress
  //    -36 (idealized 1:1 follow baseline; net is tail-driven, no robust edge). Operator kill.
  { id: 'copy-tp100-sl30',        tpPct: 100,  slPct: 30,   exitFollow: false, maxHoldSec: null }, // PAIRED_BASELINE / COPY_REGIME_BASELINE — load-bearing, keep
  { id: 'copy-conviction-consensus2', tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null, minConsensusRecent: 2 },
  // ── KILLED 2026-06-23 (INVALID): copy-hold30m (n=1919, drop_top3 -14), copy-hold2h —
  //    fat-tail hold variants; strong raw net but drop_top3 deeply negative (lottery, not
  //    edge). Operator kill.
  // ── F: measured-lag twins of the three robust variants (followsell / tp100-sl30 /
  //    consensus2). The flat-% cons twins above ASSUME 5% entry drift; these WAIT
  //    entryDelaySec after detection and re-fetch the real pool price, so drift is
  //    measured per-trade. Detection ~1.1s post-fill + 5s wait ≈ 6s real copy latency
  //    (middle of the observed 5-7s). followSellDelaySec applies the same wait to
  //    follow_sell exits only; TP/SL exits are bot-triggered and stay undelayed.
  // ── G: drift-skip — same measured-lag twins, but skip the copy when the price has
  //    already run >X% above the detection snapshot during the wait (don't chase the
  //    pump we just watched happen). Skips are recorded, so the skip rate is visible.
  // ── KILLED 2026-06-20 (INVALID): copy-consensus2-lag-drift5 — n=281, drop_top3 -0.81
  //    (negative) and declining; fails the robustness gate. The fresh static twin
  //    copy-c2rr-control covers the same realistic consensus2 entry going forward.
  // ── KILLED 2026-06-19 (operator request — pause live trading). Removed the ONLY
  //    live_micro copy strategy from the roster. Consequences on next redeploy:
  //      • Any open live_micro position reloaded from copy_trades has no matching
  //        strategy, so the poll loop's `strategy_removed` branch winds it down via a
  //        REAL sell (exitPosition → closeLivePosition) — provided COPY_LIVE_ENABLED is
  //        still true + wallet present at that point. Leave the env ON until the open
  //        bag liquidates, THEN flip COPY_LIVE_ENABLED=false.
  //      • No new live entries arm regardless of the env flag.
  //    The shadow twin `copy-consensus2-lag-drift5` (above) keeps the research arm alive.
  //    To resume live-micro, restore the entry below after a deliberate, reviewed go-live:
  //    { id: 'copy-consensus2-lag-drift5-live-micro', tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null, minConsensusRecent: 2, entryDelaySec: 5, maxEntryDriftPct: 5, executionMode: 'live_micro' },
  // ── H (2026-06-12): smart-wallet-data gates, all on the conservative lag+drift10
  //    base (the best early construction). Each isolates ONE new signal:
  // H1 regime gate — only enter when the 1-10 window score is favorable. Direct
  //    test of "the edge is real but only in good windows" (book swings -31/+44/-35
  //    SOL/day). Two thresholds bracket the question: -hi (>=7, only strong windows)
  //    and -mid (>=5, just avoid the below-average tape). The old net>0 gate (now
  //    copy-regime-green, removed) was too strict — it sat out everything (n=0).
  // ── KILLED 2026-06-20 (INVALID): copy-regime-hi, copy-regime-mid — both net-negative
  //    (-4.4 / -4.8) with drop3 and exit-stress negative at n≥100. The regime-score gate
  //    sits out good tape without avoiding bad: window-timing is not a usable edge here.
  // H4 (2026-06-15) macro gate — only enter when the broad crypto market is a
  //    tailwind (BTC/SOL 7d trend + Fear & Greed, 1-10). copy-macro isolates the
  //    macro signal; copy-macro-regime requires BOTH macro AND copy-internal regime
  //    favorable (the "both green" the operator asked for). Macro data is free/cached
  //    (market_daily) so these add no RPC.
  // ── KILLED 2026-06-20 (INVALID): copy-macro, copy-macro-regime — net-negative
  //    (-2.4 / -2.2), all robustness metrics negative. Macro-market gating (BTC/SOL
  //    trend + F&G) adds no edge; stacking it with regime ("both green") only sat out more.
  // H2 hot-lead gate — only copy leads whose last <=10 baseline copies made us
  //    money (>=3 trades of history). Benches cold hands; tests whether lead-level
  //    performance persists short-term.
  { id: 'copy-hotlead',       tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, hotLeadGate: { lastN: 10, minTrades: 3, minNetSol: 0 } },
  // H3 conviction-size gate — only copy lead buys >= 2 SOL. Small buys are
  //    spam/probing; size = conviction. lead_buy_sol is stored on every row, so
  //    the threshold is tunable from data after a week.
  // ── KILLED 2026-06-20 (INVALID): copy-bigbuy — net -3.1, 16% WR, all robustness
  //    negative. Lead buy size >=2 SOL is not a conviction signal that survives costs.
  // ── I (2026-06-15): copy-hotlead is the one signal clearing all three robustness
  //    checks (net+drop3+stress, 48% WR). The two working levers are LEAD selection
  //    (hotlead) and WINDOW selection (regime). Indiscriminate copying bleeds. So:
  //    double down on hotlead × one orthogonal second factor. All on the lag+drift10
  //    base, all heavily gated (fire rarely → negligible RPC). Each isolates whether
  //    the second factor compounds with lead quality.
  // I1 lead × window — stack the two independently-working filters: a hot lead in a
  //    non-bad window. If both edges are real and independent, this should be cleanest.
  // ── KILLED 2026-06-20 (INVALID): copy-hotlead-regime — net -1.7 vs plain copy-hotlead
  //    +12.4 on the SAME lead signal: the regime overlay flips a winner negative.
  //    Confirms window-timing destroys edge; keep lead selection, drop regime stacking.
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
  // ── KILLED 2026-06-23 (operator request): copy-hotlead-deep-live-micro. It was the
  //    one live strategy paired to the ORIGINAL research strategy (copy-hotlead-deep)
  //    instead of a dedicated same-age twin — every other live strategy maps to a
  //    `-shadow` twin, this one didn't. The original has its own 4-day-older timeline +
  //    independent already_open holding state, so it skipped lead-buys live took, making
  //    the live↔shadow comparison invalid (live "rogue" trades with no control). Killing
  //    it to rebuild with a TRUE pair-shadow that drives live entries/exits 1:1 (see the
  //    pair-shadow infra below). On redeploy, any open live_micro position has no matching
  //    strategy → the poll loop's `strategy_removed` branch winds it down via a REAL sell
  //    (needs COPY_LIVE_ENABLED + wallet). For an IMMEDIATE stop before deploy, the
  //    operator can set COPY_LIVE_ENABLED=false. Re-add a live entry only via the new
  //    pair-shadow-driven path after a reviewed go-live.
  // { id: 'copy-hotlead-deep-live-micro', tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
  //   entryDelaySec: 5, maxEntryDriftPct: 10, hotLeadGate: { lastN: 20, minTrades: 5, minNetSol: 0 }, executionMode: 'live_micro' },
  // ── J (2026-06-16): consensus2 is the one PROMOTABLE strategy; token-level
  //    consensus (>=N smart wallets on the same mint) is the durable edge — it beats
  //    regime/macro/lead-recency timing. hotlead regressed as n grew (recency is
  //    noisy). So: double down on consensus, and replace recency with CUMULATIVE
  //    lead quality. All on the lag+drift10 realistic base.
  // J1 stronger consensus — >=3 smart wallets (vs 2). Higher conviction token signal.
  // ── KILLED 2026-06-20 (INVALID): copy-consensus3 — n=126, net +2.4 but drop_top3 -4.1
  //    (top-3-trade lottery) and declining. >=3 smart-wallet consensus over-filters; the
  //    >=2 base (copy-c2rr-control / copy-conviction-consensus2) is the durable version.
  // J2 cumulative lead quality — only copy leads with all-time baseline net > 0 over
  //    >=10 copies. The data: best leads by cumulative net aren't flagged "hot" by
  //    recency, so a stable-reputation gate should beat hotlead.
  { id: 'copy-elitelead',       tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, eliteLeadGate: { minTrades: 10, minNetSol: 0 } },
  // J3 stack the two proven-durable signals — good token (consensus) x proven lead
  //    (cumulative quality). Both are token/lead-intrinsic, not timing.
  { id: 'copy-consensus2-elite', tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, minConsensusRecent: 2, eliteLeadGate: { minTrades: 10, minNetSol: 0 } },
  // ── K (2026-06-19) → KILLED 2026-06-24 (cohort retired, findings ported forward, operator request):
  //    the c2rr ratchet/runner EXIT sweep on the realistic consensus2 entry (>=2 smart wallets,
  //    entryDelaySec:5 + drift5). 10 ids — control / breakeven / ratchet-tp / ratchet-run /
  //    scaleout-50 / scaleout-run / trailtp-tight / trailtp-wide / scaleout-trailtp / ratchet-trailtp.
  //    Ran 06-19→06-24, n=145-270 each. FINDINGS:
  //      • Every variant beat the static control (control: net -2.2, drop3 -6.8, stress -4.6) —
  //        exit engineering IS additive on this entry — but NONE cleared drop3>0, so none was
  //        promotable. The cons2-realistic entry is too weak a base for any exit to rescue.
  //      • TRAILING-TP is the load-bearing mechanic: every stress-positive variant uses it. Pure
  //        static TP100/SL30 and the breakeven stop were the worst (stress-negative).
  //      • Robustness ranking: scaleout-trailtp (drop3 -2.1, stress +2.6, WR .44 — least tail-
  //        dependent) > trailtp-wide (net +7.1, stress +5.2) ≈ ratchet-trailtp (net +7.1, stress
  //        +5.0). Scale-out adds drop3 robustness; trailing-TP adds net+stress.
  //      • ratchet-run (net +8.4 / drop3 -13.4) and scaleout-run (drop3 -10.4) are LOTTERY TRAPS —
  //        one carry day each, profit is 3 moonshots. High raw net, no robust edge. Avoid.
  //    → Section O grafts the 3 robust exits onto the entries that already clear the bar.

  // ── O (2026-06-24): EXIT × ENTRY cross. The c2rr sweep proved the exit SHAPE but on a base too
  //    weak to promote. So graft the 3 best c2rr exits (scaleout-trailtp / trailtp-wide /
  //    ratchet-trailtp — all tpNull + SL30 runners, trailing-TP based) onto the 3 PROMOTABLE
  //    entry edges (hotlead, hotlead-hold30m, consensus2-elite). 3 entries × 3 exits = 9. Each
  //    keeps its ENTRY untouched — including the lead/elite drift10 gate, NOT c2rr's drift5 — and
  //    swaps ONLY the exit. The hotlead-hold30m arm KEEPS maxHoldSec:1800 as a time-stop backstop
  //    under the trail (the 30m cap is its identity vs plain hotlead; the trail/scale-out/ratchet
  //    fire first if they trigger, else the 30m timeout force-closes a slow position).
  //    Hypothesis: a promotable entry × a robust runner-exit pushes drop3 clearly positive and
  //    lifts the monthly run-rate above the static TP100/SL30 these entries ship today.
  //    Kill criterion per id: n>=100 and drop3 < its static-exit twin's drop3 (the runner exit
  //    must beat the entry's current TP100/SL30 on robustness, not just on raw net).
  // hotlead entry (lastN10 / >=3 trades / net>0, drift10) × 3 runner exits
  { id: 'copy-hotlead-scaleout-trailtp', tpPct: null, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, hotLeadGate: { lastN: 10, minTrades: 3, minNetSol: 0 },
    scaleOut: { atPct: 50, fraction: 0.5 }, trailingTp: { atPct: 80, dropPct: 30 } },
  { id: 'copy-hotlead-trailtp-wide', tpPct: null, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, hotLeadGate: { lastN: 10, minTrades: 3, minNetSol: 0 },
    trailingTp: { atPct: 50, dropPct: 30 } },
  { id: 'copy-hotlead-ratchet-trailtp', tpPct: null, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, hotLeadGate: { lastN: 10, minTrades: 3, minNetSol: 0 },
    ratchet: [{ atPct: 25, stopPct: 5 }, { atPct: 60, stopPct: 35 }], trailingTp: { atPct: 80, dropPct: 30 } },
  // hotlead entry + 30m time-stop backstop (maxHoldSec:1800) × 3 runner exits
  { id: 'copy-hotlead-hold30m-scaleout-trailtp', tpPct: null, slPct: 30, exitFollow: false, maxHoldSec: 1800,
    entryDelaySec: 5, maxEntryDriftPct: 10, hotLeadGate: { lastN: 10, minTrades: 3, minNetSol: 0 },
    scaleOut: { atPct: 50, fraction: 0.5 }, trailingTp: { atPct: 80, dropPct: 30 } },
  { id: 'copy-hotlead-hold30m-trailtp-wide', tpPct: null, slPct: 30, exitFollow: false, maxHoldSec: 1800,
    entryDelaySec: 5, maxEntryDriftPct: 10, hotLeadGate: { lastN: 10, minTrades: 3, minNetSol: 0 },
    trailingTp: { atPct: 50, dropPct: 30 } },
  { id: 'copy-hotlead-hold30m-ratchet-trailtp', tpPct: null, slPct: 30, exitFollow: false, maxHoldSec: 1800,
    entryDelaySec: 5, maxEntryDriftPct: 10, hotLeadGate: { lastN: 10, minTrades: 3, minNetSol: 0 },
    ratchet: [{ atPct: 25, stopPct: 5 }, { atPct: 60, stopPct: 35 }], trailingTp: { atPct: 80, dropPct: 30 } },
  // consensus2 × elite-lead entry (>=2 smart wallets + cumulative-positive lead >=10 trades, drift10) × 3 runner exits
  { id: 'copy-cons2elite-scaleout-trailtp', tpPct: null, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, minConsensusRecent: 2, eliteLeadGate: { minTrades: 10, minNetSol: 0 },
    scaleOut: { atPct: 50, fraction: 0.5 }, trailingTp: { atPct: 80, dropPct: 30 } },
  { id: 'copy-cons2elite-trailtp-wide', tpPct: null, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, minConsensusRecent: 2, eliteLeadGate: { minTrades: 10, minNetSol: 0 },
    trailingTp: { atPct: 50, dropPct: 30 } },
  { id: 'copy-cons2elite-ratchet-trailtp', tpPct: null, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, minConsensusRecent: 2, eliteLeadGate: { minTrades: 10, minNetSol: 0 },
    ratchet: [{ atPct: 25, stopPct: 5 }, { atPct: 60, stopPct: 35 }], trailingTp: { atPct: 80, dropPct: 30 } },
  // ── KILLED 2026-06-23 (INVALID): copy-fatwallet-{tp100,follow,runner,hightp,scaleout} —
  //    the fat-tail-wallet allowlist cohort (9LxM/2o9U/5hYs, WR<60). After ~20 trades each
  //    ALL five variants fail the bar: drop_top3 negative (-1.0 to -2.0), WR 9-19%, no exit
  //    style recovered an edge. Their fat-tail winners live mostly in BONDING-CURVE entries
  //    we can't copy; the post-grad PumpSwap slice we CAN copy is just the drift. Lesson:
  //    rank copy targets by post-grad Swap% + drop3, not raw WR/net.
  // ── M (2026-06-22): SINGLE-WALLET one-to-one copy of 3eG16XXd…pBde — the cleanest
  //    copy target on the board: 99% PumpSwap (copyable), drop_top3 +126 ≈ total +135
  //    (broad-based edge, NOT a lottery), WR 90%, 11.5-min avg hold, median RT +798%
  //    (holds for big runners). A standard TP would chop that median — so follow its
  //    sell / let it run. 3 variants share the SAME allowlist + realistic entry and
  //    differ ONLY in exit. Promotable → in follow_list → already watched by the probe.
  //    NB: last active ~7d ago — signal flow needs it to keep trading.
  //  -follow = ONE-TO-ONE: enter on its buy, exit on its sell (mirror its exit timing);
  //    loose SL only as rug protection.
  { id: 'copy-3eg1-follow',  tpPct: null, slPct: 50, exitFollow: true, maxHoldSec: 3600,
    entryDelaySec: 5, maxEntryDriftPct: 10,
    walletAllowlist: ['3eG16XXd779xVsqZwhSS31L3bw7QBBRaixBAmEWEpBde'] },
  //  -runner = no TP, trail the peak — capture the runner without waiting for its sell.
  { id: 'copy-3eg1-runner',  tpPct: null, slPct: 35, exitFollow: false, maxHoldSec: 3600,
    entryDelaySec: 5, maxEntryDriftPct: 10, trailingTp: { atPct: 100, dropPct: 30 },
    walletAllowlist: ['3eG16XXd779xVsqZwhSS31L3bw7QBBRaixBAmEWEpBde'] },
  //  -tp100 = CONTROL (standard exit — expected to cap this wallet's huge median run).
  { id: 'copy-3eg1-tp100',   tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: 3600,
    entryDelaySec: 5, maxEntryDriftPct: 10,
    walletAllowlist: ['3eG16XXd779xVsqZwhSS31L3bw7QBBRaixBAmEWEpBde'] },
  // ── N (2026-06-23): DAILY-LOSS CIRCUIT BREAKER test. Backtest (regime-analysis ×
  //    copy daily P&L) showed a regime/rug-rate pause CAN'T work — the +54 SOL day and
  //    the -74 SOL day had identical regime, so pausing on rug-rate skips the winners
  //    too and loses net. A REACTIVE daily-loss cap does work in the backtest: keep the
  //    good days, cap the disasters. Test it on 3 base strategies, each as a -cap variant
  //    (dailyLossCapSol=3: halt this strategy's new entries for the UTC day once its
  //    realized net <= -3 SOL) vs an identical -ctrl twin (no cap). Matched pairs start
  //    fresh together → clean one-to-one. Win = -cap has a higher floor (smaller worst
  //    day) AND net >= its -ctrl twin (the cap shouldn't cost net). Run >= 7 days.
  { id: 'copy-hotlead-cap',  tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, hotLeadGate: { lastN: 10, minTrades: 3, minNetSol: 0 }, dailyLossCapSol: 3 },
  { id: 'copy-hotlead-ctrl', tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, hotLeadGate: { lastN: 10, minTrades: 3, minNetSol: 0 } },
  { id: 'copy-elitelead-cap',  tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, eliteLeadGate: { minTrades: 10, minNetSol: 0 }, dailyLossCapSol: 3 },
  { id: 'copy-elitelead-ctrl', tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, eliteLeadGate: { minTrades: 10, minNetSol: 0 } },
  { id: 'copy-hotlead-consensus-cap',  tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, hotLeadGate: { lastN: 10, minTrades: 3, minNetSol: 0 }, minConsensusRecent: 2, dailyLossCapSol: 3 },
  { id: 'copy-hotlead-consensus-ctrl', tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null,
    entryDelaySec: 5, maxEntryDriftPct: 10, hotLeadGate: { lastN: 10, minTrades: 3, minNetSol: 0 }, minConsensusRecent: 2 },
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
  // ── KILLED 2026-06-17 (decisive realistic-execution failure, n>=100, RPC cleanup):
  //    copy-tp100-sl30-lag (n=378, -10.59), copy-tp100-sl30-lag-drift10 (n=335, -7.38),
  //    copy-followsell-lag (n=554, -3.29), copy-followsell-lag-drift10 (n=450, drop3
  //    -4.54), copy-consensus2-lag-drift10 (n=117, drop3 -4.63 — drift10 too tight for
  //    consensus). Plain TP/SL and follow-sell don't survive realistic execution; these
  //    were the book's biggest open-position consumers (~100 open) on a tight RPC budget.
  //    Kept: consensus2-lag-drift5 (best realistic candidate).
  // ── KILLED 2026-06-17 (redundant, dominated): copy-consensus2-lag (n=183, drop3 -3.84).
  //    Same consensus2 signal as consensus2-lag-drift5 but WITHOUT the drift gate; drift5
  //    is strictly better on every metric (drop3 -0.90 vs -3.84). Positive net (+2.99) but
  //    fails the robustness check decisively at scale — keeping both just doubled the RPC
  //    for a worse twin. consensus2-lag-drift5 is the realistic consensus2 test we keep.
  // ── KILLED 2026-06-13 (purpose served): copy-tp100-sl30-cons, copy-followsell-cons.
  //    The assumed flat-5%-entry/2%-exit penalty controls. The measured-lag twins
  //    (entryDelaySec) showed real detection->fill drift is ~0% median (not +5%), so
  //    the cons twins' deep losses (-15.5 / -15.4) were a wrong-assumption artifact.
  //    The lag twins are the honest cost model now; the cons controls are redundant.
  // ── N (2026-06-23): PAIR-SHADOW-DRIVEN LIVE — first strategy on the corrected twin
  //    architecture. makeLivePair emits a dedicated 0.05-SOL pair shadow + a 0.05-SOL
  //    live it drives 1:1. Based on copy-hotlead-hold30m (its original 0.5 research
  //    strategy, above, kept as the trend benchmark). The pair shadow always runs
  //    (modeled); the live submits REAL 0.05 swaps ONLY when COPY_LIVE_ENABLED=true +
  //    a funded wallet. Emits copy-hotlead-hold30m-pair-shadow + -live-micro.
  ...makeLivePair({ id: 'copy-hotlead-hold30m', tpPct: null, slPct: 30, exitFollow: false, maxHoldSec: 1800,
    entryDelaySec: 5, maxEntryDriftPct: 10, hotLeadGate: { lastN: 10, minTrades: 3, minNetSol: 0 } }),
  // ── O (2026-06-26, corrected 2026-06-28): CO-TRADE SIGNAL A/B (Idea 2). Two
  //    strategies with IDENTICAL params to the load-bearing baseline (copy-tp100-sl30)
  //    that split the PROVEN smart set by the co-trade signal:
  //      • copy-cotrade-tp100-sl30 — smart wallets that co-trade with >=N distinct
  //        proven winners ("run with the winner-crowd").
  //      • copy-ogsmart-tp100-sl30 — the rest of the smart set.
  //    leadCohort gates each on its disjoint cohort (cotrade_candidates score split,
  //    see queries.ts), so comparing their copy_trades P&L isolates "do smart wallets
  //    that cluster with other winners outperform the ones that don't?" — same
  //    TP/SL/size/exit, only the wallet selection differs. (The original source-based
  //    split was always empty: co-trade reads the same 0-30s pool as the OG seed.)
  //    The un-gated baseline above stays as the "all smart wallets" benchmark.
  { id: 'copy-ogsmart-tp100-sl30', tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null, leadCohort: 'og_smart' },
  { id: 'copy-cotrade-tp100-sl30', tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null, leadCohort: 'cotrade' },
];

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

const STRAT_BY_ID = new Map(COPY_STRATEGIES.map((s) => [s.id, s]));

const COPY_SIZE_SOL = parseFloat(process.env.COPY_SIZE_SOL || '0.5');
// Concurrency cap (revert to 40, 2026-06-17): with the budget now copy's alone,
// raising this only let the idealized REFERENCE strategies (copy-followsell,
// copy-tp100-sl30) hoard positions and add vault-poll RPC — the live -lag/
// consensus candidates are gated + low-volume and never hit the cap. 40 keeps
// their data complete without spending budget on over-sampled references.
const MAX_CONCURRENT_PER_STRATEGY = parseInt(process.env.COPY_MAX_CONCURRENT || '40', 10);
// Tight cap on concurrent OPEN live_micro positions (total real exposure bound).
// Default 5 × 0.05 SOL = 0.25 SOL max at risk in open positions at once. Raise via
// COPY_LIVE_MAX_CONCURRENT once the micro test is trusted.
const COPY_LIVE_MAX_CONCURRENT = parseInt(process.env.COPY_LIVE_MAX_CONCURRENT || '5', 10);
// After a live buy exhausts all 3 retry attempts on a mint, suppress further
// live entries on that SAME mint for this long. The dominant failure pattern was
// one bad token (disabled-buy / honeypot / dead pool) getting re-triggered by
// every consensus lead and single-shot-failing each time (one mint failed 10×).
// 3 escalating attempts already failed, so a near-term re-try almost certainly
// fails too — stop burning Jito tips + ATA rent on it. In-memory (clears on
// restart, which is fine — a restart is rare and the stale entries are cheap).
const COPY_LIVE_FAIL_COOLDOWN_SEC = parseInt(process.env.COPY_LIVE_FAIL_COOLDOWN_SEC || '600', 10);
// Self-cadence between consecutive live-sell retries on the SAME position. A
// transiently-failed sell no longer waits for the next 25s poll —
// closeLivePosition schedules its OWN retry this many ms after the failure
// confirms (and again after each consecutive failure) via scheduleLiveSellRetry.
// This burns the escalating-slippage ladder (sell-retry.ts) down in seconds so
// the exit lands near its trigger instead of riding the price ~25s per attempt —
// the gap that converted a modeled +106% TP winner into a realized -95% stop-loss
// on a token that round-tripped in ~2min (mint 9fMPboAS, 2026-06-20). Also gates
// the 25s poll from firing a redundant attempt while the self-loop owns the exit.
// Default 1s; tune via LIVE_SELL_RETRY_DELAY_MS.
const LIVE_SELL_RETRY_DELAY_MS = parseInt(process.env.LIVE_SELL_RETRY_DELAY_MS || '1000', 10);
// Poll interval raised 15s -> 25s (2026-06-17): position polling (1 batched vault
// fetch per UNIQUE open vault per cycle) is the dominant sustained RPC consumer.
// At 15s the book ran ~4.5 calls/s ≈ 11.7M credits/mo — over the 10M plan. 25s
// halves it to ~2.9 calls/s ≈ 7.5M/mo, under budget, while keeping copy unthrottled
// (the rps CAP is a ceiling, not the driver). Cost: TP/SL exit detection is up to
// 25s coarser — acceptable for shadow research. Lower COPY_POLL_MS if the budget
// has room; raise toward 30s if Helius runs hot.
const POLL_INTERVAL_MS = parseInt(process.env.COPY_POLL_MS || '25000', 10);
// Global hard ceiling on how long ANY copy position is tracked before it's
// force-closed at the last known price — regardless of the strategy's own
// maxHoldSec (which is often null = hold indefinitely). Matches the live-trading
// max hold so shadow and live wind positions down on the same clock. Without it,
// follow positions whose lead never sold sat open for days (max observed ~7.5d),
// inflating the open book and the per-cycle poll RPC. 8h default.
const GLOBAL_MAX_HOLD_SEC = parseInt(process.env.COPY_MAX_HOLD_SEC || '28800', 10);
// Proactive reconciliation of open live_micro positions against the REAL wallet
// token balance. The exit path only discovers a vanished balance when it ATTEMPTS
// a sell (TP/SL/follow trigger, or the 8h GLOBAL_MAX_HOLD_SEC cap). A position
// whose triggers never fire (maxHoldSec=null, price between SL and TP) can hold a
// phantom 'open' row for hours after its tokens leave the wallet out-of-band
// (manual sell, token clawback, or a sell that landed on-chain but was misread as
// failed). This sweep reads the actual balance and closes any confirmed-empty
// position so the dashboard matches the wallet. Slow cadence + tiny candidate set
// (open live positions only, usually 1-3) keeps it within the RPC budget.
const RECONCILE_INTERVAL_MS = parseInt(process.env.COPY_RECONCILE_MS || '300000', 10);
// Don't reconcile a position younger than this — give a fresh buy time to settle
// and be visible at 'confirmed' on the read node before we'd act on a zero.
const RECONCILE_MIN_AGE_SEC = parseInt(process.env.COPY_RECONCILE_MIN_AGE_SEC || '180', 10);
const CONSENSUS_WINDOW_MS = 10 * 60 * 1000;

// ── Hot-poll (fast exit detection for the live copy strategy + its shadow twin) ──
// The 25s base poll is too coarse for the dangerous tail: copy-hotlead-deep TP
// exits move at p90≈1.3%/s (≈32% per 25s poll) and up to 5.5%/s, so a token can
// spike toward — and reverse off — its TP entirely inside one poll gap (the
// 9fMPboAS round-trip, +106%→-95% in ~2.5min). A second timer re-checks ONLY
// positions that are BOTH near a trigger AND moving fast, on a tight cadence, so
// the exit is detected near its peak instead of up to 25s late. Velocity-gated +
// banded so the slow majority (median ~0.12%/s) keeps riding the cheap 25s poll —
// that's what bounds the extra RPC. Scoped to the live strategy + its identical
// shadow twin (live + shadow on the same mint share a vault → one fetch serves
// both, keeping the live-vs-shadow comparison apples-to-apples). Calibrated
// 2026-06-20 from copy-hotlead-deep exit-velocity distributions; all env-tunable.
const HOT_POLL_MS = parseInt(process.env.COPY_HOT_POLL_MS || '2000', 10);
// Fast-poll when the last-known price is within this % of the TP or effective stop
// (≈ one 25s-poll of a p90 mover, so the position is already armed before the cross).
const HOT_POLL_BAND_PCT = parseFloat(process.env.COPY_HOT_POLL_BAND_PCT || '30');
// …and only when recent |Δprice%|/sec exceeds this (above ~p70 of the velocity
// distribution; excludes the slow median so it isn't fast-polled needlessly).
const HOT_POLL_MIN_VEL_PCT_PER_S = parseFloat(process.env.COPY_HOT_POLL_MIN_VEL || '0.3');
// Strategies eligible for hot-polling — auto-derived: every live_micro copy strategy
// + its pair shadow (driven twin). A live + its pair shadow on the same mint share a
// vault, so one fast fetch serves both, keeping the comparison apples-to-apples. Adding
// a makeLivePair() entry auto-enrolls it — no stale hardcoded ids. Env override
// (comma-separated COPY_HOT_POLL_STRATEGIES) wins when set.
const HOT_POLL_STRATEGY_IDS = new Set(
  process.env.COPY_HOT_POLL_STRATEGIES
    ? process.env.COPY_HOT_POLL_STRATEGIES.split(',').map((s) => s.trim()).filter(Boolean)
    : COPY_STRATEGIES.flatMap((s) => s.executionMode === 'live_micro'
        ? [s.id, ...(s.drivenBy ? [s.drivenBy] : [])] : []),
);

// ── Follow-shadow exits (entry-gap + stop mitigation) ──
// When a shadow twin (key) closes via a PRICE-TRIGGER exit (take_profit / stop_loss
// / trail variants), mirror that exit on the paired live position (value) on the
// same mint — so live exits at the shadow's decision point instead of waiting for
// its OWN trigger, which the entry gap (live's real fill differing from the shadow's
// modeled fill) can shift out of position. On the TP side this rescues a winner live
// would otherwise miss (the BvmRJMTv case: shadow +107%, live held for an unreachable
// TP and stopped at -46%); on the SL side it caps the loss when live entered cheaper
// (its lower stop would otherwise let it ride further down than the shadow).
// ADDITIVE: live keeps its own SL + TP as independent triggers, so the follow can
// only make live exit SOONER, never later. Fires only on a same-entry pairing
// (entry_ts within FOLLOW_PAIR_WINDOW_SEC) so a stale live position from an earlier
// entry on the same mint is never closed by mistake. Inverse of the live↔shadow
// pairing in live-training-data.ts.
// Auto-derived from the pair-shadow cohort: pairShadowId → liveId (the shadow whose
// exits the live mirrors) and pairShadowId → live CopyStrategy (the live to spawn 1:1
// when the pair shadow opens). Built from every strategy declaring `drivenBy`, so adding
// a makeLivePair() entry wires both the entry-spawn and the exit-follow with no manual map.
const SHADOW_FOLLOW_LIVE: Record<string, string> = Object.fromEntries(
  COPY_STRATEGIES.filter((s) => s.drivenBy).map((s) => [s.drivenBy as string, s.id]),
);
const DRIVER_TO_LIVE: Map<string, CopyStrategy> = new Map(
  COPY_STRATEGIES.filter((s) => s.drivenBy).map((s) => [s.drivenBy as string, s]),
);
// Pair-shadow exit reasons that drive the live mirror. Price triggers + the hold-timeout
// (max_hold_cap/timeout) so a hold-style pair shadow exits its live with it. Admin exits
// (strategy_removed) and follow_sell are NOT mirrored; live has its own handling. Live
// also keeps its OWN SL/TP/maxHold as independent triggers, so the follow can only ever
// make live exit SOONER, never later (recommendation A: sooner-only safety backstop).
const FOLLOW_SHADOW_EXIT_REASONS = new Set(['take_profit', 'stop_loss', 'trail_stop', 'trailing_tp', 'timeout', 'max_hold_cap']);
const FOLLOW_PAIR_WINDOW_SEC = parseInt(process.env.COPY_FOLLOW_PAIR_WINDOW_SEC || '120', 10);

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
  executionMode?: 'shadow' | 'live_micro'; // 'live_micro' positions hold real tokens + exit via real sell
  liveTokens?: number;      // real token qty bought (live_micro) — sold back at exit
  // Live-sell retry state (in-memory; live_micro only). sellFailureCount is the
  // number of consecutive failed exit attempts → drives the escalating-slippage
  // schedule and the terminal cap. nextSellRetryTs gates back-to-back attempts.
  // parked = terminal (unsellable / cap hit); the row is closed and removed.
  sellFailureCount?: number;
  nextSellRetryTs?: number;
  parked?: boolean;
  // Hot-poll velocity tracking (in-memory): last observed price + wall-clock ms,
  // and the derived recent |Δprice%|/sec used by the hot-poll gate.
  lastObsPrice?: number;
  lastObsTs?: number;
  recentVelPctPerSec?: number;
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

/** Trailing take-profit exit price (runner exit). Once the high-water mark clears
 *  entry*(1+atPct), returns the trail line dropPct% below the HWM — exit when price
 *  falls to/through it. Returns null if no trailingTp configured or not yet armed.
 *  Pure + exported for testability. */
export function trailingTpExitPrice(entryPrice: number, highPrice: number, s: CopyStrategy): number | null {
  if (s.trailingTp == null) return null;
  const hwmUpPct = (highPrice / entryPrice - 1) * 100;
  if (hwmUpPct < s.trailingTp.atPct) return null;        // not armed yet
  return highPrice * (1 - s.trailingTp.dropPct / 100);   // trail line below the peak
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
  // Discovery-method cohorts (Idea 2 A/B), refreshed alongside leadRank. Disjoint
  // by construction (wallet_candidates.source). A leadCohort-gated strategy only
  // fires when the lead wallet is in its cohort.
  private ogSmartSet = new Set<string>();
  private cotradeSet = new Set<string>();
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
  // Hot-poll telemetry (cumulative; persisted to bot_settings alongside skipCounts,
  // surfaced in copy-trades.json → live_execution.hot_poll). Confirms the fast
  // exit-detection loop is actually engaging: active_cycles = hot-poll ticks that
  // found >=1 near-trigger fast-moving position, fetches = extra vault re-prices it
  // did, exits = exits it triggered. All zero ⇒ the band/velocity gate never fired.
  private hotPollStats = { active_cycles: 0, fetches: 0, exits: 0 };
  // Real-money execution for live_micro strategies (gated by COPY_LIVE_ENABLED + wallet).
  private readonly liveExec: CopyLiveExecutor;
  // Positions with a live sell in flight — prevents double-submitting the exit swap.
  private closingLive = new Set<number>();
  // Per-mint cooldown after a live buy exhausted all retries — `mint -> epoch_ms
  // until which live entries on that mint are suppressed`. Stops a dead/honeypot
  // token from being re-triggered and single-shot-failing repeatedly. In-memory.
  private liveFailCooldownUntil = new Map<string, number>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private hotPollTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private polling = false;
  private hotPolling = false;
  private reconciling = false;
  private enabled = false;

  constructor(opts: { db: Database.Database; getConnection: () => Connection | null }) {
    this.db = opts.db;
    this.getConnection = opts.getConnection;
    this.liveExec = new CopyLiveExecutor(opts);
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
    // Fast exit-detection timer for the scoped strategies' near-trigger, fast-moving
    // positions (see HOT_POLL_* constants). Cheap when nothing qualifies — the gate
    // short-circuits before any RPC.
    this.hotPollTimer = setInterval(() => {
      this.hotPoll().catch((err) => logger.warn('hot-poll error: %s', err instanceof Error ? err.message : String(err)));
    }, HOT_POLL_MS);
    // Proactive wallet reconciliation (see RECONCILE_* constants). Periodic +
    // an initial sweep ~30s after start so a phantom 'open' whose tokens left
    // before this process booted (e.g. resumed from a prior run) clears promptly
    // instead of waiting a full interval.
    this.reconcileTimer = setInterval(() => {
      this.reconcileLivePositions().catch((err) => logger.warn('reconcile error: %s', err instanceof Error ? err.message : String(err)));
    }, RECONCILE_INTERVAL_MS);
    setTimeout(() => {
      this.reconcileLivePositions().catch((err) => logger.warn('initial reconcile error: %s', err instanceof Error ? err.message : String(err)));
    }, 30_000);
    logger.info(`CopyTrader started (shadow): ${COPY_STRATEGIES.length} strategies, size=${COPY_SIZE_SOL} SOL, resumed ${this.positions.size} open positions`);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.hotPollTimer) { clearInterval(this.hotPollTimer); this.hotPollTimer = null; }
    if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = null; }
  }

  isEnabled(): boolean { return this.enabled; }

  private refreshLeadRanks(): void {
    try {
      const rows = this.db.prepare(`SELECT address, rank FROM follow_list`).all() as Array<{ address: string; rank: number | null }>;
      this.leadRank = new Map(rows.filter((r) => r.rank != null).map((r) => [r.address, r.rank as number]));
    } catch { /* table may be empty */ }
    // Refresh the discovery-method cohorts for the A/B. Both apply the money-edge
    // gate; they differ only by how the wallet was discovered.
    try { this.ogSmartSet = new Set(getOgSmartSetAddresses(this.db)); } catch { /* empty */ }
    try { this.cotradeSet = new Set(getCotradeSmartSetAddresses(this.db)); } catch { /* empty */ }
  }

  private recordSkip(strategyId: string, reason: string): void {
    const k = `${strategyId}|${reason}`;
    this.skipCounts.set(k, (this.skipCounts.get(k) ?? 0) + 1);
  }

  /** Load cumulative skip counts + hot-poll stats from bot_settings (survive restarts). */
  private loadSkipCounts(): void {
    try {
      const row = this.db.prepare(`SELECT value FROM bot_settings WHERE key = 'copy_gate_skips'`).get() as { value: string } | undefined;
      if (row?.value) {
        const obj = JSON.parse(row.value) as Record<string, number>;
        this.skipCounts = new Map(Object.entries(obj));
      }
    } catch { /* table may not exist yet / bad JSON — start fresh */ }
    try {
      const row = this.db.prepare(`SELECT value FROM bot_settings WHERE key = 'copy_hotpoll_stats'`).get() as { value: string } | undefined;
      if (row?.value) {
        const obj = JSON.parse(row.value) as Partial<{ active_cycles: number; fetches: number; exits: number }>;
        this.hotPollStats = { active_cycles: obj.active_cycles ?? 0, fetches: obj.fetches ?? 0, exits: obj.exits ?? 0 };
      }
    } catch { /* start fresh */ }
  }

  /** Flush the cumulative skip counts + hot-poll stats to bot_settings (throttled ~60s). */
  private flushSkipCounts(): void {
    const now = Date.now();
    if (now - this.lastSkipFlush < 60_000) return;
    this.lastSkipFlush = now;
    try {
      if (this.skipCounts.size > 0) {
        this.db.prepare(`INSERT OR REPLACE INTO bot_settings (key, value, updated_at) VALUES ('copy_gate_skips', ?, unixepoch())`)
          .run(JSON.stringify(Object.fromEntries(this.skipCounts)));
      }
      this.db.prepare(`INSERT OR REPLACE INTO bot_settings (key, value, updated_at) VALUES ('copy_hotpoll_stats', ?, unixepoch())`)
        .run(JSON.stringify(this.hotPollStats));
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
        executionMode: (r.execution_mode as 'shadow' | 'live_micro') ?? 'shadow',
        liveTokens: (r.live_tokens as number) ?? undefined,
      });
    }
    // Crash reconciliation: a resumed live_micro 'open' row may hold real tokens
    // (buy landed before a crash). It's loaded here and will exit via a real sell
    // when it next hits a trigger — the executor reads the actual wallet balance,
    // so even a row with no recorded live_tokens gets sold down correctly.
  }

  /** Proactive reconciliation of live_micro position tracking against the REAL
   *  wallet, against ONE full-wallet token snapshot per sweep (see RECONCILE_*
   *  constants). The snapshot makes the open book self-verifying and catches BOTH
   *  drift directions:
   *
   *   1. PHANTOM (bot open, wallet empty): a confirmed-empty open position older
   *      than RECONCILE_MIN_AGE_SEC is closed directly as `reconciled_no_tokens`
   *      (net_sol=NULL). It does NOT submit a sell — the tokens are gone, so a
   *      sell would just fail "no tokens" and burn RPC.
   *   2. ORPHAN (wallet holds tokens for a mint the bot live-traded but no longer
   *      tracks as open): surfaced for manual review (NOT auto-acted) — these are
   *      tokens a sell/terminal-close left behind (e.g. a transient-RPC false
   *      "no tokens" close, or a sell that reverted on-chain).
   *
   *  Safety: it NEVER acts on an unconfirmed read. walletTokenBalances() returns
   *  null on a live-off / no-wallet / RPC-error condition and the whole sweep is
   *  skipped — only a mint ABSENT from a SUCCESSFUL snapshot counts as zero, so a
   *  transient RPC blip can't kill a real position. Phantom closes also require
   *  the position to be aged + not already closing, so it can't race a fresh buy's
   *  settlement or a sell in flight. Per-position balances + the orphan list are
   *  persisted to bot_settings('copy_live_recon') and surfaced on /copy-trades so
   *  the open book can be eyeballed against the wallet without DB/chain access. */
  private async reconcileLivePositions(): Promise<void> {
    if (this.reconciling || this.stopped || !this.enabled) return;
    if (!this.liveExec.isLive()) return; // no real wallet → nothing to reconcile
    const walletBal = await this.liveExec.walletTokenBalances();
    if (walletBal == null) return; // unknown (RPC error / off) — never reconcile on no data
    this.reconciling = true;
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const livePositions = [...this.positions.values()].filter((p) => p.executionMode === 'live_micro');
      const openMints = new Set(livePositions.map((p) => p.mint));
      const positionObs: Array<Record<string, unknown>> = [];
      for (const p of livePositions) {
        if (this.stopped) break;
        const walletRaw = walletBal.get(p.mint) ?? 0;
        const walletTokens = +(walletRaw / 1e6).toFixed(2);
        const aged = (nowSec - p.entryTs) >= RECONCILE_MIN_AGE_SEC;
        let status: string;
        if (walletRaw > 0) {
          status = 'held'; // chain-confirmed — the open row matches the wallet
        } else if (!aged) {
          status = 'settling'; // confirmed-empty but too fresh — re-check next sweep
        } else if (this.closingLive.has(p.id) || !this.positions.has(p.id)) {
          status = 'closing'; // a normal exit is already handling it
        } else {
          // Confirmed-empty + aged → close the phantom row directly (no sell).
          this.closingLive.add(p.id);
          try {
            this.db.prepare(`UPDATE copy_trades SET status='closed', exit_ts=?, exit_reason='reconciled_no_tokens', net_sol=NULL, live_error=? WHERE id=?`)
              .run(nowSec, 'proactive reconcile: wallet token balance 0 — tokens left out-of-band (no bot sell recorded)', p.id);
          } catch { /* noop — non-critical */ }
          p.parked = true;
          this.positions.delete(p.id);
          this.closingLive.delete(p.id);
          status = 'reconciled_closed';
          logger.warn(
            'Copy LIVE reconcile CLOSE %s %s id=%d (age %ds) — wallet balance 0, closed reconciled_no_tokens, net_sol NULL (manual review: tokens left out-of-band)',
            p.strategyId, p.mint.slice(0, 6), p.id, nowSec - p.entryTs,
          );
        }
        positionObs.push({
          id: p.id, mint: p.mint.slice(0, 8), strategy_id: p.strategyId, entry_ts: p.entryTs,
          tracked_tokens: p.liveTokens ?? null, wallet_tokens: walletTokens, status,
        });
      }
      // Orphans: wallet mints with a balance that the bot has live-traded but does
      // NOT currently track as open. Restrict to live-traded mints so a shared
      // wallet's main-path / manual holdings aren't flagged as copy drift.
      let liveTradedMints = new Set<string>();
      try {
        const rows = this.db.prepare(`SELECT DISTINCT mint FROM copy_trades WHERE execution_mode = 'live_micro'`).all() as Array<{ mint: string }>;
        liveTradedMints = new Set(rows.map((r) => r.mint));
      } catch { /* noop */ }
      const orphans: Array<Record<string, unknown>> = [];
      for (const [mint, raw] of walletBal) {
        if (raw > 0 && !openMints.has(mint) && liveTradedMints.has(mint)) {
          orphans.push({ mint: mint.slice(0, 8), tokens: +(raw / 1e6).toFixed(2) });
        }
      }
      orphans.sort((a, b) => (b.tokens as number) - (a.tokens as number));
      if (orphans.length) {
        logger.warn('Copy LIVE reconcile: %d orphan token balance(s) — live-traded mints held in wallet but not tracked as open (manual review)', orphans.length);
      }
      try {
        this.db.prepare(`INSERT OR REPLACE INTO bot_settings (key, value, updated_at) VALUES ('copy_live_recon', ?, unixepoch())`)
          .run(JSON.stringify({
            checked_at: nowSec,
            positions: positionObs,
            orphans: orphans.slice(0, 50),
            orphan_count: orphans.length,
          }));
      } catch { /* noop — non-critical telemetry */ }
    } finally {
      this.reconciling = false;
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

  /** Cumulative (all-time) baseline copy stats for a lead — the eliteLeadGate's
   *  signal. Cached 5min per wallet (lifetime stats move slowly). */
  private eliteLeadCache = new Map<string, { ts: number; n: number; net: number }>();
  private leadLifetimeStats(leadWallet: string): { n: number; net: number } {
    const now = Date.now();
    const hit = this.eliteLeadCache.get(leadWallet);
    if (hit && now - hit.ts < 300_000) return hit;
    let res = { n: 0, net: 0 };
    try {
      const row = this.db.prepare(`
        SELECT COUNT(*) AS n, COALESCE(SUM(net_sol), 0) AS net FROM copy_trades
        WHERE status = 'closed' AND strategy_id = ? AND lead_wallet = ? AND net_sol IS NOT NULL
      `).get(COPY_REGIME_BASELINE, leadWallet) as { n: number; net: number };
      res = { n: row.n, net: row.net };
    } catch { /* table may be empty */ }
    this.eliteLeadCache.set(leadWallet, { ts: now, ...res });
    if (this.eliteLeadCache.size > 2000) {
      for (const [k, v] of this.eliteLeadCache) if (now - v.ts > 900_000) this.eliteLeadCache.delete(k);
    }
    return res;
  }

  /** This strategy's realized net for the current UTC day (sum of net_sol on closed
   *  copies that exited today). Drives the dailyLossCapSol breaker. Cached 60s per
   *  strategy; the day-start cutoff moves forward at 00:00 UTC so it resets daily. */
  private dailyNetCache = new Map<string, { ts: number; dayStart: number; net: number }>();
  private strategyDailyRealizedNet(strategyId: string): number {
    const now = Date.now();
    const dayStart = Math.floor(now / 86_400_000) * 86_400; // 00:00 UTC today, unix sec
    const hit = this.dailyNetCache.get(strategyId);
    if (hit && hit.dayStart === dayStart && now - hit.ts < 60_000) return hit.net;
    let net = 0;
    try {
      const row = this.db.prepare(`
        SELECT COALESCE(SUM(net_sol), 0) AS net FROM copy_trades
        WHERE strategy_id = ? AND status = 'closed' AND net_sol IS NOT NULL AND exit_ts >= ?
      `).get(strategyId, dayStart) as { net: number };
      net = row.net;
    } catch { /* table may be empty */ }
    this.dailyNetCache.set(strategyId, { ts: now, dayStart, net });
    return net;
  }

  /** A followed wallet bought `mint` — open shadow copies for armed strategies.
   *  `leadBuySol` is the size of the lead's own buy (|SOL delta| from their tx). */
  async onLeadBuy(mint: string, leadWallet: string, leadTier: string, detectionLagSec: number | null, leadBuySol: number | null = null): Promise<void> {
    if (!this.enabled || this.stopped) return;
    const pv = await this.resolvePool(mint);
    if (!pv) return; // not a tracked-grad mint / pool unresolved
    const conn = this.getConnection();
    if (!conn) return;
    if (!(await globalRpcLimiter.throttleOrDropPriority(20, 'copy_trade'))) return;
    const price = await fetchVaultPrice(conn, pv.baseVault, pv.quoteVault);
    if (!price || price.priceSol <= 0) return;

    const leadRank = this.leadRank.get(leadWallet) ?? Infinity;
    let consensusRecent: number | null = null; // computed lazily, once per call
    const nowSec = Math.floor(Date.now() / 1000);
    const detectMs = Date.now();
    // One id per lead-buy event, shared by EVERY row this call spawns (each armed
    // strategy + its live_micro twin). Deterministic 1:1 join key for the
    // Live-vs-Shadow pairing — copy rows have no graduation_id, so without this the
    // matcher falls back to mint+time and under-matches re-entries / offset fills.
    const copyEventId = `${detectMs}-${mint.slice(0, 10)}-${leadWallet.slice(0, 8)}`;

    for (const s of COPY_STRATEGIES) {
      // Pair-shadow-driven live strategies do NOT self-gate: their entries are spawned
      // 1:1 by their pair shadow when it opens (see openDelayed). Skip them here so live
      // can never independently enter a lead-buy the pair shadow didn't take.
      if (s.drivenBy) continue;
      const pendingKey = `${s.id}:${mint}`;
      const open = [...this.positions.values()].filter((p) => p.strategyId === s.id);
      // already-positioned / in-flight / at-capacity: not an interesting "gate" skip
      if (open.some((p) => p.mint === mint)) { this.recordSkip(s.id, 'already_open'); continue; }
      if (this.pendingEntries.has(pendingKey)) { this.recordSkip(s.id, 'already_open'); continue; }
      if (open.length >= MAX_CONCURRENT_PER_STRATEGY) { this.recordSkip(s.id, 'at_capacity'); continue; }
      // daily-loss circuit breaker: halt new entries once today's realized net <= -cap (reset at 00:00 UTC)
      if (s.dailyLossCapSol != null && this.strategyDailyRealizedNet(s.id) <= -s.dailyLossCapSol) {
        this.recordSkip(s.id, 'daily_loss_cap'); continue;
      }
      // conviction gates — record the FIRST gate that rejects (funnel semantics)
      if (s.walletAllowlist && !s.walletAllowlist.includes(leadWallet)) { this.recordSkip(s.id, 'wallet_allowlist'); continue; }
      // Discovery-method cohort gate (Idea 2 A/B): only fire on wallets this
      // strategy's discovery method surfaced. Disjoint cohorts → clean comparison.
      if (s.leadCohort) {
        const inCohort = s.leadCohort === 'cotrade'
          ? this.cotradeSet.has(leadWallet)
          : this.ogSmartSet.has(leadWallet);
        if (!inCohort) { this.recordSkip(s.id, 'cohort'); continue; }
      }
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
      if (s.eliteLeadGate) {
        const st = this.leadLifetimeStats(leadWallet);
        if (st.n < s.eliteLeadGate.minTrades || st.net <= s.eliteLeadGate.minNetSol) { this.recordSkip(s.id, 'elitelead'); continue; }
      }

      // Measured-lag entry — wait, re-fetch the real price, enter at that.
      if (s.entryDelaySec) {
        this.pendingEntries.add(pendingKey);
        this.openDelayed(s, mint, pv, leadWallet, leadTier, detectionLagSec, price.priceSol, detectMs, leadBuySol, copyEventId)
          .catch((err) => logger.warn('delayed entry error %s %s: %s', s.id, mint.slice(0, 6), err instanceof Error ? err.message : String(err)))
          .finally(() => this.pendingEntries.delete(pendingKey));
        continue;
      }

      // Penalized entry — models a realistic confirmation lag (fill higher than the
      // optimistic ~1.1s snapshot). Default 0 = enter at snapshot price as before.
      const entryP = s.entryPenaltyPct ? price.priceSol * (1 + s.entryPenaltyPct / 100) : price.priceSol;
      const size = s.tradeSizeSol ?? COPY_SIZE_SOL;
      const tpPrice = s.tpPct != null ? entryP * (1 + s.tpPct / 100) : null;
      const slPrice = s.slPct != null ? entryP * (1 - s.slPct / 100) : null;
      const id = this.insertOpen({
        strategyId: s.id, mint, pool: pv.pool, baseVault: pv.baseVault, quoteVault: pv.quoteVault,
        leadWallet, leadTier, entryTs: nowSec, entryPrice: entryP, sizeSol: size,
        tpPrice, slPrice, exitFollow: s.exitFollow, maxHoldSec: s.maxHoldSec, detectionLagSec,
        detectPrice: price.priceSol, entryDelaySec: null, entryDriftPct: null, leadBuySol,
        copyEventId,
      });
      if (id == null) continue;
      this.positions.set(id, {
        id, strategyId: s.id, mint, pool: pv.pool, baseVault: pv.baseVault, quoteVault: pv.quoteVault,
        entryPrice: entryP, sizeSol: size, tpPrice, baseSlPrice: slPrice,
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
    leadBuySol: number | null = null, copyEventId: string | null = null,
  ): Promise<void> {
    await sleep((s.entryDelaySec ?? 0) * 1000);
    if (this.stopped) return;
    const conn = this.getConnection();
    if (!conn) { this.recordSkip(s.id, 'no_conn'); return; }
    // RPC-limiter drop: when many strategies queue a delayed entry on the SAME
    // consensus event, they all race this limiter 5s later. Strategies late in
    // COPY_STRATEGIES lose the token race and were silently abandoned here — record
    // it so the funnel shows the drop instead of an unexplained gap (entered=0 with
    // pendings created). See the c2rr cohort starvation, 2026-06-19.
    if (!(await globalRpcLimiter.throttleOrDropPriority(20, 'copy_trade'))) { this.recordSkip(s.id, 'rpc_drop'); return; }
    const price = await fetchVaultPrice(conn, pv.baseVault, pv.quoteVault);
    if (!price || price.priceSol <= 0) { this.recordSkip(s.id, 'price_fail'); return; }
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
    if (open.some((p) => p.mint === mint) || open.length >= MAX_CONCURRENT_PER_STRATEGY) { this.recordSkip(s.id, 'raced'); return; }

    // LIVE-MICRO: submit a real buy. Only when COPY_LIVE_ENABLED + wallet; otherwise
    // this strategy falls through to the shadow path below (runs as a second shadow).
    if (s.executionMode === 'live_micro' && this.liveExec.isLive()) {
      await this.openLive(s, mint, pv, leadWallet, leadTier, detectionLagSec, detectPrice, price.priceSol, driftPct, nowSec, copyEventId);
      return;
    }

    const entryP = price.priceSol;
    const size = s.tradeSizeSol ?? COPY_SIZE_SOL;
    const tpPrice = s.tpPct != null ? entryP * (1 + s.tpPct / 100) : null;
    const slPrice = s.slPct != null ? entryP * (1 - s.slPct / 100) : null;
    const id = this.insertOpen({
      strategyId: s.id, mint, pool: pv.pool, baseVault: pv.baseVault, quoteVault: pv.quoteVault,
      leadWallet, leadTier, entryTs: nowSec, entryPrice: entryP, sizeSol: size,
      tpPrice, slPrice, exitFollow: s.exitFollow, maxHoldSec: s.maxHoldSec, detectionLagSec,
      detectPrice, entryDelaySec: s.entryDelaySec ?? 0, entryDriftPct: driftPct, leadBuySol,
      copyEventId,
    });
    if (id == null) return;
    const pos: OpenPos = {
      id, strategyId: s.id, mint, pool: pv.pool, baseVault: pv.baseVault, quoteVault: pv.quoteVault,
      entryPrice: entryP, sizeSol: size, tpPrice, baseSlPrice: slPrice,
      exitFollow: s.exitFollow, maxHoldSec: s.maxHoldSec, entryTs: nowSec,
      highPrice: entryP, scaledOut: false, realizedPartial: 0,
    };
    this.positions.set(id, pos);

    // ENTRY MIRROR: this pair shadow just opened — spawn its driven live's REAL buy on
    // the SAME lead-buy event (shared copyEventId), so live ⊆ pair shadow by construction.
    // Real money only when COPY_LIVE_ENABLED + wallet (liveExec.isLive()); otherwise the
    // pair shadow still recorded the entry and the live is simply "missed" (no real fill).
    // openLive applies its own real-money safety gates (preflight/capacity/cooldown).
    const drivenLive = DRIVER_TO_LIVE.get(s.id);
    if (drivenLive && this.liveExec.isLive()) {
      await this.openLive(drivenLive, mint, pv, leadWallet, leadTier, detectionLagSec,
        detectPrice, price.priceSol, driftPct, nowSec, copyEventId)
        .catch((err) => logger.warn('pair-shadow live spawn error %s %s: %s',
          drivenLive.id, mint.slice(0, 6), err instanceof Error ? err.message : String(err)));
    }

    // Lead sold while our buy was in flight — a real copy bot would have bought
    // into the dump and then chased the exit. Model exactly that: follow-sell out
    // after the same exit delay instead of pretending the entry never happened.
    const soldAtMs = this.lastLeadSellMs.get(mint);
    if (s.exitFollow && soldAtMs != null && soldAtMs >= detectMs) {
      this.scheduleFollowSellClose([pos], s.followSellDelaySec ?? 0);
    }
  }

  /** Real-money entry for a live_micro strategy. Row-first (crash-safety): persist
   *  the open row BEFORE the swap, then submit, then write the real fill back — so
   *  a crash mid-buy leaves a row that resume-then-sell can clean up. */
  private async openLive(
    s: CopyStrategy, mint: string, pv: PoolVaults, leadWallet: string, leadTier: string,
    detectionLagSec: number | null, detectPrice: number, snapshotPrice: number, driftPct: number, nowSec: number,
    copyEventId: string | null = null,
  ): Promise<void> {
    // Tight live exposure cap (separate from the shadow concurrency cap).
    const openLiveCount = [...this.positions.values()].filter((p) => p.strategyId === s.id && p.executionMode === 'live_micro').length;
    if (openLiveCount >= COPY_LIVE_MAX_CONCURRENT) {
      this.recordSkip(s.id, 'live_at_capacity');
      return;
    }
    // Suppress mints that just exhausted all buy retries (dead pool / honeypot /
    // disabled-buy). Checked before the preflight so we skip the wallet-balance
    // RPC too. Prune the expired entry lazily on read.
    const cdUntil = this.liveFailCooldownUntil.get(mint);
    if (cdUntil != null) {
      if (Date.now() < cdUntil) {
        this.recordSkip(s.id, 'live_fail_cooldown');
        return;
      }
      this.liveFailCooldownUntil.delete(mint);
    }
    const block = await this.liveExec.preflightBuy();
    if (block) {
      this.recordSkip(s.id, 'live_blocked');
      logger.warn('Copy LIVE buy blocked %s %s: %s', s.id, mint.slice(0, 6), block);
      return;
    }
    // 1) Provisional row at the snapshot price (real fill overwrites it post-buy).
    const tpP = s.tpPct != null ? snapshotPrice * (1 + s.tpPct / 100) : null;
    const slP = s.slPct != null ? snapshotPrice * (1 - s.slPct / 100) : null;
    const id = this.insertOpen({
      strategyId: s.id, mint, pool: pv.pool, baseVault: pv.baseVault, quoteVault: pv.quoteVault,
      leadWallet, leadTier, entryTs: nowSec, entryPrice: snapshotPrice, sizeSol: MICRO_TRADE_SIZE_SOL,
      tpPrice: tpP, slPrice: slP, exitFollow: s.exitFollow, maxHoldSec: s.maxHoldSec, detectionLagSec,
      detectPrice, entryDelaySec: s.entryDelaySec ?? 0, entryDriftPct: driftPct, leadBuySol: null,
      executionMode: 'live_micro', copyEventId,
    });
    if (id == null) return;
    // 2) Submit the real buy.
    const poolCtx = { poolAddress: pv.pool, baseVault: pv.baseVault, quoteVault: pv.quoteVault };
    let res;
    try {
      res = await this.liveExec.buy(mint, poolCtx, snapshotPrice);
    } catch (err) {
      res = { success: false, effectivePrice: 0, tokensReceived: 0, dryRun: false, errorMessage: err instanceof Error ? err.message : String(err) } as Awaited<ReturnType<CopyLiveExecutor['buy']>>;
    }
    if (!res.success || res.tokensReceived <= 0) {
      const rentLoss = -(res.ataRentCostSol ?? 0) - (res.jitoTipSol ?? 0);
      try {
        this.db.prepare(`UPDATE copy_trades SET status='closed', exit_ts=?, exit_reason='live_buy_failed',
          net_sol=?, live_error=?, jito_tip_sol=?, ata_rent_sol=? WHERE id=?`)
          .run(Math.floor(Date.now() / 1000), +rentLoss.toFixed(6), (res.errorMessage ?? 'unknown').slice(0, 300), res.jitoTipSol ?? 0, res.ataRentCostSol ?? 0, id);
      } catch { /* noop */ }
      // Cool the mint down so it isn't re-triggered + re-failed on the next lead.
      this.liveFailCooldownUntil.set(mint, Date.now() + COPY_LIVE_FAIL_COOLDOWN_SEC * 1000);
      logger.warn('Copy LIVE buy FAILED %s %s: %s (cooldown %ds)', s.id, mint.slice(0, 6), res.errorMessage, COPY_LIVE_FAIL_COOLDOWN_SEC);
      return;
    }
    // 3) Write the real fill back; TP/SL key off the effective entry price.
    const effEntry = res.effectivePrice;
    const tpPrice = s.tpPct != null ? effEntry * (1 + s.tpPct / 100) : null;
    const slPrice = s.slPct != null ? effEntry * (1 - s.slPct / 100) : null;
    try {
      this.db.prepare(`UPDATE copy_trades SET entry_price_sol=?, high_price_sol=?, tp_price_sol=?, sl_price_sol=?,
        live_tokens=?, tx_sig_entry=?, jito_tip_sol=?, ata_rent_sol=?, tx_land_ms=?, entry_land_path=? WHERE id=?`)
        .run(effEntry, effEntry, tpPrice, slPrice, res.tokensReceived, res.txSignature ?? null, res.jitoTipSol ?? 0, res.ataRentCostSol ?? 0, res.txLandMs ?? null, res.landPath ?? null, id);
    } catch { /* noop */ }
    this.positions.set(id, {
      id, strategyId: s.id, mint, pool: pv.pool, baseVault: pv.baseVault, quoteVault: pv.quoteVault,
      entryPrice: effEntry, sizeSol: MICRO_TRADE_SIZE_SOL, tpPrice, baseSlPrice: slPrice,
      exitFollow: s.exitFollow, maxHoldSec: s.maxHoldSec, entryTs: nowSec,
      highPrice: effEntry, scaledOut: false, realizedPartial: 0,
      executionMode: 'live_micro', liveTokens: res.tokensReceived,
    });
    logger.warn('Copy LIVE buy OK %s %s tokens=%s tip=%s sig=%s', s.id, mint.slice(0, 6), res.tokensReceived, res.jitoTipSol, (res.txSignature ?? '').slice(0, 12));
  }

  /** Real-money exit for a live_micro position. Sells the held tokens via the
   *  shared escalating-slippage schedule (`sell-retry.ts`). On a transient failure
   *  it leaves the position open and schedules its OWN fast retry
   *  LIVE_SELL_RETRY_DELAY_MS later (scheduleLiveSellRetry) with wider slippage —
   *  NOT the next 25s poll, so a fast-reversing token doesn't ride the price down a
   *  full poll per attempt. On a TERMINAL failure (a known-unsellable error like
   *  "no tokens in wallet", or the 9-attempt cap) it closes the row and removes the
   *  position so the loop self-terminates.
   *
   *  This terminal handling is the 2026-06-19 bleed-stop: previously ANY failure
   *  just left the row open and re-attempted every poll forever, so two orphaned
   *  positions (a manually-sold one → "no tokens", and a reverting one → Custom
   *  6053) hammered the RPC limiter until the Helius credit budget blew. Guarded
   *  so an exit swap is never submitted twice for the same position. */
  private async closeLivePosition(p: OpenPos, reason: string, rawExitPrice: number): Promise<void> {
    if (p.parked || this.closingLive.has(p.id) || !this.positions.has(p.id)) return;
    // Don't fire a redundant attempt while a self-scheduled retry is pending (the
    // 25s poll, or a lead-sell trigger landing mid-cycle, can race the fast loop).
    // The scheduled retry fires AT nextSellRetryTs, so it always passes this guard.
    if (p.nextSellRetryTs != null && Date.now() < p.nextSellRetryTs) return;
    this.closingLive.add(p.id);
    try {
      const attemptNumber = (p.sellFailureCount ?? 0) + 1;
      const poolCtx = { poolAddress: p.pool, baseVault: p.baseVault, quoteVault: p.quoteVault };
      let res;
      try {
        res = await this.liveExec.sell(p.mint, p.liveTokens ?? 0, poolCtx, rawExitPrice, {
          slippageBpsOverride: sellSlippageBpsForAttempt(attemptNumber),
          jitoTipMultiplier: sellTipMultiplierForAttempt(attemptNumber),
          attemptNumber,
        });
      } catch (err) {
        res = { success: false, effectivePrice: 0, tokensReceived: 0, dryRun: false, errorMessage: err instanceof Error ? err.message : String(err) } as Awaited<ReturnType<CopyLiveExecutor['sell']>>;
      }
      if (!res.success) {
        const errMsg = res.errorMessage ?? 'unknown';
        const lowerErr = errMsg.toLowerCase();
        const matchedPattern = TERMINAL_SELL_ERROR_PATTERNS.find((pat) => lowerErr.includes(pat));
        const scheduleExhausted = attemptNumber >= MAX_SELL_ATTEMPTS_BEFORE_TERMINAL;
        if (matchedPattern || scheduleExhausted) {
          // Terminal — close the row so it leaves this.positions and is never
          // reloaded (loadOpenPositions reads only status='open'). net_sol stays
          // NULL: the outcome is genuinely unknown (tokens gone out-of-band, or
          // the position is parked still holding illiquid tokens) and summarize()
          // excludes non-numeric net_sol from P&L — we don't fabricate a result.
          // Park keeps any still-held tokens in the wallet for manual exit; the
          // loud warn is the manual-review signal.
          const termReason = matchedPattern
            ? (lowerErr.includes('no tokens') ? 'reconciled_no_tokens' : 'sell_terminal_dead_pool')
            : 'sell_parked_unsellable';
          try {
            this.db.prepare(`UPDATE copy_trades SET status='closed', exit_ts=?, exit_reason=?, net_sol=NULL, live_error=? WHERE id=?`)
              .run(Math.floor(Date.now() / 1000), termReason, errMsg.slice(0, 300), p.id);
          } catch { /* noop */ }
          p.parked = true;
          this.positions.delete(p.id);
          logger.warn('Copy LIVE sell TERMINAL %s %s id=%d after %d attempt(s): %s — %s, no further retries',
            p.strategyId, p.mint.slice(0, 6), p.id, attemptNumber, termReason, errMsg);
          return;
        }
        // Transient — escalate + retry on our OWN fast cadence
        // (LIVE_SELL_RETRY_DELAY_MS after this failure), not the next 25s poll.
        // nextSellRetryTs keeps the poll from firing a redundant attempt until the
        // self-scheduled retry runs.
        p.sellFailureCount = attemptNumber;
        p.nextSellRetryTs = Date.now() + LIVE_SELL_RETRY_DELAY_MS;
        this.scheduleLiveSellRetry(p, reason);
        logger.warn('Copy LIVE sell FAILED %s %s id=%d attempt %d/%d: %s — retry in %dms (slip→%d bps)',
          p.strategyId, p.mint.slice(0, 6), p.id, attemptNumber, MAX_SELL_ATTEMPTS_BEFORE_TERMINAL, errMsg, LIVE_SELL_RETRY_DELAY_MS, sellSlippageBpsForAttempt(attemptNumber + 1));
        return;
      }
      // net = size * (effExit/effEntry - 1) - real costs (sell tip; buy tip+rent already on the row).
      const effExit = res.effectivePrice;
      const grossPct = p.entryPrice > 0 ? (effExit / p.entryPrice - 1) * 100 : 0;
      const sellTip = res.jitoTipSol ?? 0;
      const row = this.db.prepare(`SELECT jito_tip_sol, ata_rent_sol FROM copy_trades WHERE id=?`).get(p.id) as { jito_tip_sol: number; ata_rent_sol: number } | undefined;
      const priorCosts = (row?.jito_tip_sol ?? 0) + (row?.ata_rent_sol ?? 0);
      const net = +((p.sizeSol * grossPct / 100) - sellTip - priorCosts).toFixed(6);
      const nowSec = Math.floor(Date.now() / 1000);
      try {
        this.db.prepare(`UPDATE copy_trades SET status='closed', exit_ts=?, exit_price_sol=?, exit_reason=?,
          gross_pct=?, net_sol=?, hold_sec=?, tx_sig_exit=?, jito_tip_sol=? WHERE id=?`)
          .run(nowSec, effExit, reason, +grossPct.toFixed(3), net, nowSec - p.entryTs, res.txSignature ?? null, (row?.jito_tip_sol ?? 0) + sellTip, p.id);
      } catch { /* noop */ }
      this.positions.delete(p.id);
      logger.warn('Copy LIVE sell OK %s %s %s net=%s sig=%s', p.strategyId, p.mint.slice(0, 6), reason, net, (res.txSignature ?? '').slice(0, 12));
    } finally {
      this.closingLive.delete(p.id);
    }
  }

  /** Fast self-retry for a transiently-failed live sell. Fires
   *  LIVE_SELL_RETRY_DELAY_MS after the failure confirms — and again after each
   *  consecutive failure (closeLivePosition re-schedules) — instead of waiting for
   *  the next 25s poll. Re-fetches the pool price so the re-derived exit reason
   *  matches the market at fill time (closeLivePosition→liveSell already re-reads
   *  reserves for the min-out, so the fresh price here only keeps the stored reason
   *  honest, not the fill). Once an exit is in flight we keep retrying until it
   *  lands or hits the terminal cap, regardless of price band — the position
   *  (removed on success, parked on terminal) is re-checked before every re-fire,
   *  so the loop self-terminates and a closed/removed position never re-fires. */
  private scheduleLiveSellRetry(p: OpenPos, fallbackReason: string): void {
    setTimeout(() => {
      void (async () => {
        if (this.stopped || p.parked || !this.positions.has(p.id)) return;
        const conn = this.getConnection();
        let price: number | null = null;
        if (conn && (await globalRpcLimiter.throttleOrDropPriority(15))) {
          const r = await fetchVaultPrice(conn, p.baseVault, p.quoteVault);
          price = r?.priceSol ?? null;
        }
        const exitPrice = price ?? p.lastWrittenPrice ?? p.highPrice ?? p.entryPrice;
        // Re-derive the reason from the fresh price (matches the poll's exit logic):
        // TP if still at/above target, else stop if at/below the effective stop,
        // else carry the reason that first triggered the exit.
        let reason = fallbackReason;
        const s = STRAT_BY_ID.get(p.strategyId);
        if (price != null && s) {
          const stop = effectiveStopPrice(p.entryPrice, p.highPrice, s);
          if (p.tpPrice != null && price >= p.tpPrice) reason = 'take_profit';
          else if (stop != null && price <= stop) reason = (p.baseSlPrice == null || stop > p.baseSlPrice) ? 'trail_stop' : 'stop_loss';
        }
        await this.closeLivePosition(p, reason, exitPrice);
      })().catch((err) => logger.warn('live sell retry error %s: %s', p.mint.slice(0, 6), err instanceof Error ? err.message : String(err)));
    }, LIVE_SELL_RETRY_DELAY_MS);
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
    if (conn && (await globalRpcLimiter.throttleOrDropPriority(20, 'copy_trade'))) {
      const price = await fetchVaultPrice(conn, immediate[0].baseVault, immediate[0].quoteVault);
      exitPrice = price?.priceSol ?? null;
    }
    for (const p of immediate) this.exitPosition(p, 'follow_sell', exitPrice ?? p.entryPrice);
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
      if (conn && (await globalRpcLimiter.throttleOrDropPriority(20, 'copy_trade'))) {
        const price = await fetchVaultPrice(conn, alive[0].baseVault, alive[0].quoteVault);
        exitPrice = price?.priceSol ?? null;
      }
      for (const p of alive) this.exitPosition(p, 'follow_sell', exitPrice ?? p.entryPrice);
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
        if (conn && (await globalRpcLimiter.throttleOrDropPriority(15, 'copy_poll'))) {
          const r = await fetchVaultPrice(conn, ps[0].baseVault, ps[0].quoteVault);
          price = r?.priceSol ?? null;
        }
        for (const p of ps) this.evaluatePosition(p, price, now);
      }
    } finally {
      this.polling = false;
    }
  }

  /** Evaluate ONE position against an observed pool price (null when the fetch was
   *  skipped/failed): update HWM + last price + recent velocity, then run the exit
   *  ladder. Shared by the 25s poll and the fast hot-poll. Synchronous — the only
   *  async hop is the fire-and-forget exitPosition; the leading membership check +
   *  the per-exit guards make a double-evaluate (poll racing hot-poll) a no-op.
   *  `now` is unix seconds. */
  private evaluatePosition(p: OpenPos, price: number | null, now: number): void {
    if (!this.positions.has(p.id)) return; // closed since the snapshot was taken
    const s = STRAT_BY_ID.get(p.strategyId);
    // Strategy removed from the roster (killed) — wind the open bag down at the
    // current price instead of stranding it 'open' forever. One-time cleanup.
    if (!s) { this.exitPosition(p, 'strategy_removed', price ?? p.lastWrittenPrice ?? p.highPrice ?? p.entryPrice); return; }
    // max-hold doesn't need a price. The per-strategy maxHoldSec (when set) still
    // applies; on top of it we enforce a GLOBAL ceiling (default 8h) so positions
    // whose strategy holds indefinitely (maxHoldSec=null) or longer than the cap
    // stop being tracked, matching the live-trading max hold.
    const effectiveMaxHoldSec = p.maxHoldSec != null
      ? Math.min(p.maxHoldSec, GLOBAL_MAX_HOLD_SEC)
      : GLOBAL_MAX_HOLD_SEC;
    if (now - p.entryTs >= effectiveMaxHoldSec) {
      const reason = (p.maxHoldSec != null && p.maxHoldSec <= GLOBAL_MAX_HOLD_SEC)
        ? 'timeout' : 'max_hold_cap';
      this.exitPosition(p, reason, price ?? p.highPrice ?? p.entryPrice);
      return;
    }
    if (price == null || price <= 0) return;
    // recent velocity (|Δprice%| per second) — drives the hot-poll gate. Computed
    // from the gap since the last observation (25s on the base poll, ~HOT_POLL_MS
    // once fast-polling), so it tracks the move's current speed, not the lifetime avg.
    // Seed the baseline from the entry fill on the first observation so the first
    // poll already yields a velocity (don't wait two polls to arm the gate).
    const nowMs = Date.now();
    const prevPrice = p.lastObsPrice ?? p.entryPrice;
    const prevTsMs = p.lastObsTs ?? p.entryTs * 1000;
    if (prevPrice > 0 && nowMs > prevTsMs) {
      p.recentVelPctPerSec = Math.abs(price / prevPrice - 1) * 100 / ((nowMs - prevTsMs) / 1000);
    }
    p.lastObsPrice = price; p.lastObsTs = nowMs;
    // update HWM (persist on new high)
    if (price > p.highPrice) {
      p.highPrice = price;
      try { this.db.prepare(`UPDATE copy_trades SET high_price_sol = ? WHERE id = ?`).run(price, p.id); } catch { /* noop */ }
    }
    // persist last seen price so copy-trades.json can mark open positions to
    // market. Skip the write when unchanged beyond 0.1% to keep the poll cheap.
    if (p.lastWrittenPrice == null || Math.abs(price / p.lastWrittenPrice - 1) > 0.001) {
      p.lastWrittenPrice = price;
      try {
        this.db.prepare(`UPDATE copy_trades SET last_price_sol = ?, last_price_ts = ? WHERE id = ?`).run(price, now, p.id);
      } catch { /* noop */ }
    }
    // scale-out (partial realize, runner continues) — partial fill takes the same
    // exit penalty as a full close.
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
    // trailing take-profit (runner): once armed at +atPct, exit the remainder on a
    // dropPct% fall from the HWM. Checked before the stop so the runner-trail reason
    // wins when both would trigger on the same tick.
    const ttpExit = trailingTpExitPrice(p.entryPrice, p.highPrice, s);
    if (ttpExit != null && price <= ttpExit) { this.exitPosition(p, 'trailing_tp', price); return; }
    // exits on the remainder
    const stop = effectiveStopPrice(p.entryPrice, p.highPrice, s);
    if (p.tpPrice != null && price >= p.tpPrice) { this.exitPosition(p, 'take_profit', price); return; }
    if (stop != null && price <= stop) {
      const raised = p.baseSlPrice == null || stop > p.baseSlPrice;
      this.exitPosition(p, raised ? 'trail_stop' : 'stop_loss', price);
      return;
    }
  }

  /** A position qualifies for fast (hot) polling when it belongs to a scoped
   *  strategy, its last-known price is within HOT_POLL_BAND_PCT of its TP or
   *  effective stop, AND it's moving faster than HOT_POLL_MIN_VEL_PCT_PER_S. The
   *  slow majority fails the velocity gate and rides the cheap 25s poll; only the
   *  fast tail near a trigger is fast-polled, which is what bounds the extra RPC. */
  private isHotCandidate(p: OpenPos): boolean {
    if (!HOT_POLL_STRATEGY_IDS.has(p.strategyId)) return false;
    if ((p.recentVelPctPerSec ?? 0) < HOT_POLL_MIN_VEL_PCT_PER_S) return false;
    const px = p.lastWrittenPrice ?? p.highPrice ?? p.entryPrice;
    if (px <= 0) return false;
    const nearTp = p.tpPrice != null && px >= p.tpPrice * (1 - HOT_POLL_BAND_PCT / 100);
    const s = STRAT_BY_ID.get(p.strategyId);
    const stop = s ? effectiveStopPrice(p.entryPrice, p.highPrice, s) : p.baseSlPrice;
    const nearStop = stop != null && px <= stop * (1 + HOT_POLL_BAND_PCT / 100);
    return nearTp || nearStop;
  }

  /** Fast exit-detection pass: re-price ONLY the hot candidates (scoped strategy,
   *  near a trigger, moving fast) and run the exit ladder on the fresh price, so a
   *  spike that would reverse inside a 25s gap is caught near its peak. Live + its
   *  shadow twin on the same mint share a vault → one fetch serves both. */
  private async hotPoll(): Promise<void> {
    if (this.hotPolling || this.stopped || this.positions.size === 0) return;
    this.hotPolling = true;
    try {
      const hot = [...this.positions.values()].filter(
        (p) => !this.closingLive.has(p.id) && this.isHotCandidate(p),
      );
      if (hot.length === 0) return;
      this.hotPollStats.active_cycles += 1;
      const now = Math.floor(Date.now() / 1000);
      const byVault = new Map<string, OpenPos[]>();
      for (const p of hot) {
        if (!byVault.has(p.baseVault)) byVault.set(p.baseVault, []);
        byVault.get(p.baseVault)!.push(p);
      }
      for (const ps of byVault.values()) {
        const conn = this.getConnection();
        if (!conn || !(await globalRpcLimiter.throttleOrDropPriority(12))) continue;
        const r = await fetchVaultPrice(conn, ps[0].baseVault, ps[0].quoteVault);
        const price = r?.priceSol ?? null;
        if (price == null) continue;
        this.hotPollStats.fetches += 1;
        for (const p of ps) {
          this.evaluatePosition(p, price, now);
          // An exit just dispatched on this fast pass (shadow removed synchronously;
          // live's sell guarded into closingLive) — credit the hot-poll for the catch.
          if (!this.positions.has(p.id) || this.closingLive.has(p.id)) this.hotPollStats.exits += 1;
        }
      }
    } finally {
      this.hotPolling = false;
    }
  }

  /** Exit dispatcher: live_micro positions exit via a real sell (async, guarded);
   *  everything else closes synchronously as a modeled shadow exit. */
  private exitPosition(p: OpenPos, reason: string, rawExitPrice: number): void {
    if (p.executionMode === 'live_micro' && this.liveExec.isLive()) {
      this.closeLivePosition(p, reason, rawExitPrice)
        .catch((err) => logger.warn('live close error %s: %s', p.mint.slice(0, 6), err instanceof Error ? err.message : String(err)));
      return;
    }
    this.closePosition(p, reason, rawExitPrice);
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
    if (FOLLOW_SHADOW_EXIT_REASONS.has(reason)) this.followShadowExit(p, rawExitPrice);
  }

  /** When a shadow twin closes via a price-trigger exit (TP / SL / trail), mirror it
   *  on the paired live position (same mint, same-entry pairing) so live exits at the
   *  shadow's decision point rather than waiting for its own — possibly entry-gap-
   *  shifted — trigger. Routes through exitPosition → closeLivePosition (real sell,
   *  guarded against double submit; reason 'follow_shadow'). Additive: live's own
   *  TP/SL still fire on their own in the poll, so the follow can only exit live
   *  sooner. No-op unless the shadow is a SHADOW_FOLLOW_LIVE key. */
  private followShadowExit(shadow: OpenPos, rawExitPrice: number): void {
    const liveId = SHADOW_FOLLOW_LIVE[shadow.strategyId];
    if (!liveId) return;
    for (const lp of this.positions.values()) {
      if (lp.strategyId !== liveId || lp.mint !== shadow.mint) continue;
      if (lp.executionMode !== 'live_micro') continue;
      // Same-entry pairing only — never close a stale live position from a prior
      // entry on the same mint.
      if (Math.abs(lp.entryTs - shadow.entryTs) > FOLLOW_PAIR_WINDOW_SEC) continue;
      this.exitPosition(lp, 'follow_shadow', rawExitPrice);
    }
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
    if (!(await globalRpcLimiter.throttleOrDropPriority(20, 'copy_trade'))) return null;
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
    leadBuySol?: number | null; executionMode?: 'shadow' | 'live_micro';
    copyEventId?: string | null;
  }): number | null {
    const res = this.db.prepare(`
      INSERT OR IGNORE INTO copy_trades
        (strategy_id, mint, pool_address, base_vault, quote_vault, lead_wallet, lead_tier,
         entry_ts, entry_price_sol, size_sol, tp_price_sol, sl_price_sol, exit_follow,
         max_hold_sec, detection_lag_sec, high_price_sol, scaled_out, realized_partial_sol, status,
         detect_price_sol, entry_delay_sec, entry_drift_pct, lead_buy_sol, execution_mode, copy_event_id)
      VALUES
        (@strategy_id, @mint, @pool, @base_vault, @quote_vault, @lead_wallet, @lead_tier,
         @entry_ts, @entry_price, @size, @tp, @sl, @exit_follow,
         @max_hold, @lag, @entry_price, 0, 0, 'open',
         @detect_price, @entry_delay, @entry_drift, @lead_buy, @exec_mode, @copy_event_id)
    `).run({
      strategy_id: d.strategyId, mint: d.mint, pool: d.pool, base_vault: d.baseVault, quote_vault: d.quoteVault,
      lead_wallet: d.leadWallet, lead_tier: d.leadTier, entry_ts: d.entryTs, entry_price: d.entryPrice,
      size: d.sizeSol, tp: d.tpPrice, sl: d.slPrice, exit_follow: d.exitFollow ? 1 : 0,
      max_hold: d.maxHoldSec, lag: d.detectionLagSec,
      detect_price: d.detectPrice, entry_delay: d.entryDelaySec, entry_drift: d.entryDriftPct,
      lead_buy: d.leadBuySol ?? null, exec_mode: d.executionMode ?? 'shadow',
      copy_event_id: d.copyEventId ?? null,
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
    // Does this strategy model OUR real execution? Idealized mirrors (no
    // entryDelaySec) fill at the optimistic ~1.1s detection snapshot — a price we
    // cannot actually achieve. Only delayed-entry strategies are promotable; the
    // idealized ones are an UPPER BOUND (best case at zero latency), never a
    // live-micro candidate. This is the consensus2 trap: the idealized mirror
    // scored 100 while its realistic lag-twins don't clear drop3.
    const realisticExecution = (s.config?.entry_delay_sec ?? null) != null;
    // monthly run rate from the per-strategy daily series (distinct active days)
    const days = (s.daily ?? []).filter((d: any) => (d.n ?? 0) > 0);
    const activeDays = days.length;
    const monthly = activeDays > 0 ? +((net / activeDays) * 30).toFixed(2) : 0;
    const gates = {
      realistic_execution: realisticExecution,
      n_ge_100: n >= 100,
      drop3_positive: drop3 > 0,
      stress_positive: stress > 0,
      monthly_ge_bar: monthly >= COPY_MONTHLY_BAR,
    };
    const promotable = Object.values(gates).every(Boolean);
    // 0-100 readiness: realistic_execution 20 + sample 20 + drop3 25 + stress 20 +
    // monthly 15. Realistic execution is a SCORED component, so an idealized mirror
    // (no 5s entry delay) caps at 80 and can never reach 100 — only a strategy that
    // models our real ~6s fill can be a perfect-score live candidate.
    const score = +(
      (realisticExecution ? 20 : 0) +
      Math.min(1, n / 100) * 20 +
      (drop3 > 0 ? Math.min(1, drop3 / 2) * 25 : 0) +
      (stress > 0 ? Math.min(1, stress / 2) * 20 : 0) +
      Math.max(0, Math.min(1, monthly / COPY_MONTHLY_BAR)) * 15
    ).toFixed(1);
    return { id, n, age_days: s.age_days ?? null, first_entry_ts: s.first_entry_ts ?? null,
      active_days: activeDays,
      net_sol: +net.toFixed(3), drop_top3: +drop3.toFixed(3),
      exit_stress: +stress.toFixed(3), monthly_run_rate_sol: monthly,
      max_win_streak: s.max_win_streak ?? 0, max_loss_streak: s.max_loss_streak ?? 0,
      max_drawdown_sol: s.max_drawdown_sol ?? 0,
      realistic_execution: realisticExecution, gates, promotable, score };
  });
  rows.sort((a, b) => b.score - a.score);
  return {
    monthly_bar_sol: COPY_MONTHLY_BAR,
    n_promotable: rows.filter((r) => r.promotable).length,
    note: 'PROMOTABLE requires realistic execution (entryDelaySec set) — idealized 1:1 mirrors fill at the optimistic ~1.1s snapshot and are an upper bound only, never a live candidate.',
    rows,
  };
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

/** Bucket a persisted `live_error` string into a coarse failure class for the
 *  live_execution.failure_reasons histogram (2026-06-19). Lets a session tell
 *  retry-salvageable failures (slippage_6004, rent, not_landed) from terminal
 *  ones (disabled_buy, no_token_delta, thin_liquidity) before/after the retry
 *  fix lands. Substring/regex match, most-specific first — order matters
 *  (pool_read before thin_liquidity so "pool reserves read failed" doesn't fall
 *  into the liquidity bucket). */
export function classifyLiveBuyFailure(err: string): string {
  const e = err.toLowerCase();
  if (!e) return 'unknown';
  if (/buy_failed_after_\d+_attempts/.test(e)) {
    // Retry-exhausted wrapper — classify by the underlying error it carries.
    return classifyLiveBuyFailure(e.replace(/^.*buy_failed_after_\d+_attempts:\s*/, ''));
  }
  if (/6004|exceededslippage/.test(e)) return 'slippage_6004';
  if (/insufficientfundsforrent|\brent\b/.test(e)) return 'rent';
  if (/wallet_low|insufficient_balance|insufficient lamports/.test(e)) return 'wallet_low';
  if (/6020|disabledbuy/.test(e)) return 'disabled_buy';
  if (/pool reserves read failed|pool context|pool_read/.test(e)) return 'pool_read';
  if (/6003|6016|liquidity/.test(e)) return 'thin_liquidity';
  if (/no balance delta|no tokens|transfer.?hook|no_token/.test(e)) return 'no_token_delta';
  if (/did not land|jito|\brpc\b|timeout|blockhash|not land/.test(e)) return 'not_landed';
  return 'other';
}

/** Per-(strategy, lead_wallet) P&L attribution from active closed copy trades.
 *  Surfaces, per strategy, WHICH lead wallets drive the wins (TP) vs losses (SL)
 *  and how concentrated the profit is. Basis for a per-strategy walletAllowlist —
 *  copy only the leads that actually work for THAT strategy, dropping the SL tail. */
function computeLeadAttribution(activeClosed: Array<Record<string, unknown>>): unknown[] {
  type Lead = { wallet: string; n: number; net: number; n_tp: number; n_sl: number; n_win: number };
  const byStrat = new Map<string, Map<string, Lead>>();
  for (const r of activeClosed) {
    const sid = r.strategy_id as string;
    const lw = r.lead_wallet as string | null;
    const net = r.net_sol as number | null;
    if (!sid || !lw || net == null) continue;
    let leads = byStrat.get(sid);
    if (!leads) { leads = new Map(); byStrat.set(sid, leads); }
    let a = leads.get(lw);
    if (!a) { a = { wallet: lw, n: 0, net: 0, n_tp: 0, n_sl: 0, n_win: 0 }; leads.set(lw, a); }
    a.n++; a.net += net;
    const reason = r.exit_reason as string;
    if (reason === 'take_profit') a.n_tp++;
    else if (reason === 'stop_loss' || reason === 'trail_stop') a.n_sl++;
    if (net > 0) a.n_win++;
  }
  const out: Array<Record<string, unknown>> = [];
  for (const [sid, leads] of byStrat) {
    const arr = [...leads.values()];
    const nTrades = arr.reduce((s, a) => s + a.n, 0);
    if (nTrades < 20) continue; // too thin to attribute meaningfully
    const grossWin = arr.reduce((s, a) => s + Math.max(0, a.net), 0);
    arr.sort((a, b) => b.net - a.net);
    const top = arr[0];
    const top3GrossWin = arr.slice(0, 3).reduce((s, a) => s + Math.max(0, a.net), 0);
    const round = (a: Lead) => ({ ...a, net: +a.net.toFixed(4) });
    out.push({
      strategy_id: sid,
      n_leads: arr.length,
      n_trades: nTrades,
      total_net: +arr.reduce((s, a) => s + a.net, 0).toFixed(4),
      gross_win: +grossWin.toFixed(4),
      gross_loss: +arr.reduce((s, a) => s + Math.min(0, a.net), 0).toFixed(4),
      // % of gross PROFIT delivered by the single best / top-3 leads — high = the
      // edge is a handful of wallets (allowlist them); low = broadly distributed.
      top_wallet_share_pct: grossWin > 0 ? +(Math.max(0, top.net) / grossWin * 100).toFixed(1) : 0,
      top3_share_pct: grossWin > 0 ? +(top3GrossWin / grossWin * 100).toFixed(1) : 0,
      top_leads: arr.slice(0, 6).map(round),
      worst_leads: arr.filter((a) => a.net < 0).slice(-5).reverse().map(round),
    });
  }
  out.sort((a, b) => (b.total_net as number) - (a.total_net as number));
  return out;
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

  // Streak + drawdown profile: walk a strategy's closed trades in time order
  // (by exit_ts) and find the longest run of consecutive wins, the longest run of
  // consecutive losses, and the deepest peak-to-trough decline in cumulative net
  // SOL. These are the live-trading-readiness metrics for a low-win-rate, fat-tail
  // strategy — the worst losing streak + drawdown you'd actually have to sit through.
  const streakProfile = (rows: Array<Record<string, unknown>>) => {
    const seq = rows
      .filter((r) => typeof r.net_sol === 'number' && typeof r.exit_ts === 'number')
      .sort((a, b) => (a.exit_ts as number) - (b.exit_ts as number));
    let maxWin = 0, maxLoss = 0, curWin = 0, curLoss = 0;
    let cum = 0, peak = 0, maxDD = 0;
    for (const r of seq) {
      const net = r.net_sol as number;
      if (net > 0) { curWin += 1; curLoss = 0; if (curWin > maxWin) maxWin = curWin; }
      else { curLoss += 1; curWin = 0; if (curLoss > maxLoss) maxLoss = curLoss; }
      cum += net;
      if (cum > peak) peak = cum;
      if (cum - peak < maxDD) maxDD = cum - peak; // most-negative trough below the running peak
    }
    return { max_win_streak: maxWin, max_loss_streak: maxLoss, max_drawdown_sol: +maxDD.toFixed(3) };
  };

  const summarize = (rows: Array<Record<string, unknown>>) => {
    const nets = rows.map((r) => r.net_sol as number).filter((v) => typeof v === 'number');
    const total = +nets.reduce((a, b) => a + b, 0).toFixed(4);
    const top3 = [...nets].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
    const wins = nets.filter((v) => v > 0).length;
    const holds = rows.map((r) => r.hold_sec as number).filter((v) => typeof v === 'number');
    const lags = rows.map((r) => r.detection_lag_sec as number).filter((v) => typeof v === 'number');
    const byReason: Record<string, number> = {};
    for (const r of rows) byReason[(r.exit_reason as string) ?? 'unknown'] = (byReason[(r.exit_reason as string) ?? 'unknown'] ?? 0) + 1;
    // Hold-time distribution PER exit reason — answers "how long until a position
    // pumps to TP" (take_profit), vs how long SL/timeout take. Overall median_hold
    // mixes all three and is misleading. {n, min, avg, median, max} in seconds.
    const holdByReason: Record<string, number[]> = {};
    for (const r of rows) {
      const h = r.hold_sec as number;
      if (typeof h !== 'number') continue;
      (holdByReason[(r.exit_reason as string) ?? 'unknown'] ??= []).push(h);
    }
    const holdByExit: Record<string, { n: number; min: number; avg: number; median: number; max: number }> = {};
    for (const [reason, hs] of Object.entries(holdByReason)) {
      if (!hs.length) continue;
      holdByExit[reason] = {
        n: hs.length, min: Math.min(...hs), max: Math.max(...hs),
        avg: Math.round(hs.reduce((a, b) => a + b, 0) / hs.length),
        median: Math.round(median(hs) ?? 0),
      };
    }
    // Max favorable excursion (MFE) per exit reason — the peak % gain a position
    // reached (stored high_price_sol vs entry) BEFORE it exited. Calibrates the two
    // open design questions from data instead of guessing:
    //   • ratchet: among stop_loss/timeout exits, what fraction first ran to
    //     +25/+50/+75/+100%? Those are the losers a raised stop would have saved.
    //   • runner: among no-TP exits (timeout/follow_sell), how far past +100% do
    //     winners actually go (p75/p90/max)? That sets a trailing-TP distance.
    // Note: high_price_sol is sampled at the poll cadence (25s), so fast intraday
    // spikes between polls are under-counted — read these as a floor on the peak.
    const pctile = (arr: number[], p: number): number => {
      if (!arr.length) return 0;
      const srt = [...arr].sort((a, b) => a - b);
      return srt[Math.min(srt.length - 1, Math.floor((p / 100) * srt.length))];
    };
    const frac = (arr: number[], thr: number): number =>
      arr.length ? +(arr.filter((v) => v >= thr).length / arr.length).toFixed(3) : 0;
    const mfeByReason: Record<string, number[]> = {};
    for (const r of rows) {
      const entry = r.entry_price_sol as number;
      const high = r.high_price_sol as number;
      if (typeof entry !== 'number' || entry <= 0 || typeof high !== 'number' || high <= 0) continue;
      (mfeByReason[(r.exit_reason as string) ?? 'unknown'] ??= []).push((high / entry - 1) * 100);
    }
    const mfeByExit: Record<string, {
      n: number; median: number; p75: number; p90: number; max: number;
      frac_ge_25: number; frac_ge_50: number; frac_ge_75: number; frac_ge_100: number;
    }> = {};
    for (const [reason, vs] of Object.entries(mfeByReason)) {
      if (!vs.length) continue;
      mfeByExit[reason] = {
        n: vs.length,
        median: +(median(vs) ?? 0).toFixed(1),
        p75: +pctile(vs, 75).toFixed(1),
        p90: +pctile(vs, 90).toFixed(1),
        max: +Math.max(...vs).toFixed(1),
        frac_ge_25: frac(vs, 25), frac_ge_50: frac(vs, 50),
        frac_ge_75: frac(vs, 75), frac_ge_100: frac(vs, 100),
      };
    }
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
      hold_by_exit: holdByExit,
      mfe_by_exit: mfeByExit,
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

  // Live-vs-shadow: pair each live_micro strategy's REAL trades with its identical
  // shadow twin on the SAME lead-buy event. Preferred join is copy_event_id (one id
  // per onLeadBuy(), written to both rows — exact 1:1). Pre-migration rows that lack
  // it fall back to same mint + entry within a widened window. The gap is pure
  // execution — real fills/slippage/fees/timing vs the modeled shadow. Mirrors the
  // /live-training panel, copy-side. Empty until real live trades exist.
  const LIVE_SHADOW_PAIRS = [
    { live: 'copy-hotlead-deep-live-micro', shadow: 'copy-hotlead-deep' },
  ];
  const COPY_LVS_WINDOW_SEC = 60; // tight mint+time fallback (genuine same-event twins enter <=5s apart)
  // Compare on RETURN % (net / size), not absolute SOL — live trades at 0.05 and
  // the shadow twin at 0.5, so only size-normalized returns are apples-to-apples.
  const retPct = (r: Record<string, unknown>) => {
    const net = r.net_sol as number; const size = r.size_sol as number;
    return (typeof net === 'number' && typeof size === 'number' && size > 0) ? (net / size) * 100 : 0;
  };
  const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const wr = (rows: Array<Record<string, unknown>>) => rows.length ? +(rows.filter((r) => (r.net_sol as number) > 0).length / rows.length).toFixed(3) : null;
  const liveVsShadow = LIVE_SHADOW_PAIRS.map(({ live, shadow }) => {
    const liveRows = closed.filter((r) => r.strategy_id === live && r.execution_mode === 'live_micro');
    const shadowRows = closed.filter((r) => r.strategy_id === shadow);
    const mLive: Array<Record<string, unknown>> = []; const mShadow: Array<Record<string, unknown>> = [];
    const usedShadow = new Set<number>();
    const shadowByEvent = new Map<string, Record<string, unknown>>();
    for (const sr of shadowRows) {
      const ev = sr.copy_event_id as string | null;
      if (ev) shadowByEvent.set(ev, sr);
    }
    for (const lr of liveRows) {
      const lts = lr.entry_ts as number; const lmint = lr.mint as string;
      const lev = lr.copy_event_id as string | null;
      let best: Record<string, unknown> | null = null;
      if (lev) {
        // Deterministic: both rows from the same onLeadBuy() share copy_event_id.
        const ex = shadowByEvent.get(lev);
        if (ex && !usedShadow.has(ex.id as number)) best = ex;
      } else {
        // Pre-migration rows only: same mint, closest entry within the window.
        let bestDiff = COPY_LVS_WINDOW_SEC + 1;
        for (const sr of shadowRows) {
          if (usedShadow.has(sr.id as number) || sr.mint !== lmint || sr.copy_event_id) continue;
          const diff = Math.abs((sr.entry_ts as number) - lts);
          if (diff <= COPY_LVS_WINDOW_SEC && diff < bestDiff) { best = sr; bestDiff = diff; }
        }
      }
      if (best) { usedShadow.add(best.id as number); mLive.push(lr); mShadow.push(best); }
    }
    const liveRet = mLive.map(retPct); const shadowRet = mShadow.map(retPct);
    const sum = (xs: number[]) => +xs.reduce((a, b) => a + b, 0).toFixed(4);
    return {
      live_id: live, shadow_id: shadow,
      n_live_total: liveRows.length, matched: mLive.length,
      live: { total_net_sol: sum(mLive.map((r) => (r.net_sol as number) ?? 0)), avg_return_pct: +mean(liveRet).toFixed(2), win_rate: wr(mLive) },
      shadow: { total_net_sol: sum(mShadow.map((r) => (r.net_sol as number) ?? 0)), avg_return_pct: +mean(shadowRet).toFixed(2), win_rate: wr(mShadow) },
      // execution gap in percentage points: live avg return − shadow avg return.
      // Negative = live underperforms the model (the real-world cost of going live).
      exec_gap_pp: +(mean(liveRet) - mean(shadowRet)).toFixed(2),
    };
  });

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
    // strategy age = now − earliest copy (entry_ts is unix sec, NOT NULL on copy_trades).
    // null when the strategy has never traded (deployed but no fills yet).
    const entryTsList = entered.map((r) => r.entry_ts as number).filter((t) => Number.isFinite(t));
    const firstEntryTs = entryTsList.length ? Math.min(...entryTsList) : null;
    const ageDays = firstEntryTs != null
      ? +(((Date.now() / 1000) - firstEntryTs) / 86_400).toFixed(1)
      : null;
    byStrategy[s.id] = {
      config: {
        tp_pct: s.tpPct, sl_pct: s.slPct, exit_follow: s.exitFollow, max_hold_sec: s.maxHoldSec,
        breakeven_at_pct: s.breakevenAtPct ?? null, ratchet: s.ratchet ?? null,
        scale_out: s.scaleOut ?? null, min_lead_rank: s.minLeadRank ?? null, min_consensus: s.minConsensusRecent ?? null,
        entry_penalty_pct: s.entryPenaltyPct ?? null, exit_penalty_pct: s.exitPenaltyPct ?? null,
        entry_delay_sec: s.entryDelaySec ?? null, follow_sell_delay_sec: s.followSellDelaySec ?? null,
        max_entry_drift_pct: s.maxEntryDriftPct ?? null,
        min_lead_buy_sol: s.minLeadBuySol ?? null, hot_lead_gate: s.hotLeadGate ?? null,
        elite_lead_gate: s.eliteLeadGate ?? null,
        regime_gate_min_score: s.regimeGateMinScore ?? null,
        macro_gate_min_score: s.macroGateMinScore ?? null,
      },
      ...openSummary,
      total_incl_open_sol: +(closedSummary.total_net_sol + openSummary.open_unrealized_sol).toFixed(4),
      ...closedSummary,
      ...streakProfile(rows),
      first_entry_ts: firstEntryTs,
      age_days: ageDays,
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
    // End-to-end follower latency over the last 7d of probe events. transport =
    // lead block_time → our WS notification; decision = notification → copy
    // dispatch (our in-process parse, ~ms since we stopped blocking on a
    // confirm-fetch); total = block_time → dispatch (the real disadvantage we'd
    // carry into live execution, before the on-chain land gap).
    latency: (() => {
      let rows: Array<{ detection_lag_sec: number | null; decision_lag_ms: number | null; total_lag_sec: number | null }> = [];
      try {
        rows = db.prepare(`
          SELECT detection_lag_sec, decision_lag_ms, total_lag_sec
          FROM copy_probe_events WHERE detected_at > ?
        `).all(Date.now() - 7 * 86400_000) as typeof rows;
      } catch { return null; }
      const sum = (vals: Array<number | null>) => {
        const s = vals.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
        if (!s.length) return null;
        const pc = (q: number) => +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(2);
        return { n: s.length, mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2), p50: pc(0.5), p95: pc(0.95), max: +s[s.length - 1].toFixed(2) };
      };
      return {
        window_days: 7,
        transport_lag_sec: sum(rows.map((r) => r.detection_lag_sec)),
        decision_lag_ms: sum(rows.map((r) => r.decision_lag_ms)),
        total_lag_sec: sum(rows.map((r) => r.total_lag_sec)),
      };
    })(),
    paired_baseline: PAIRED_BASELINE,
    // 1-10 window score + hourly series — "is NOW a good time to copy trade".
    // Baseline series = copy-tp100-sl30 (roster-stable).
    regime: computeCopyRegime(db),
    // 1-10 macro-market score (broad crypto tailwind/headwind) from market_daily.
    macro: computeMacroRegime(db),
    // Per-lead-wallet copy P&L on the baseline — makes the lead-selection signal
    // (the book's strongest) legible: who's hot, who's cold.
    lead_performance: computeLeadPerformance(db),
    // Wallet-discovery funnel (mirrors wallet-leaderboard.json) so the copy page
    // shows the smart-wallet pool growing over time without leaving the page.
    wallet_discovery: (() => {
      const wl = computeWalletLeaderboard(db, 50) as {
        summary?: unknown; gate?: unknown; rows?: Array<{ passed_gate?: boolean }>;
      };
      return {
        summary: wl.summary ?? null,
        gate: wl.gate ?? null,
        top_promotable: (wl.rows ?? []).filter((r) => r.passed_gate).slice(0, 8),
      };
    })(),
    // Co-trade discovery (Idea 2) funnel — how many wallets the winner-graph
    // snowball surfaced, how many are cotrade-EXCLUSIVE (OG never found them), and
    // how many of those cleared the money-edge gate (the tradeable cotrade cohort
    // that copy-cotrade-tp100-sl30 trades against copy-ogsmart-tp100-sl30).
    cotrade_discovery: getCotradeDiscovery(db),
    // Live-tape harvester (Idea 1) — zero-RPC PumpSwap-tape discovery funnel:
    // wallets tallied → promoted to the scorer → scored → passing the bar. These
    // are genuinely-new wallets the 0-30s OG seed never sees.
    live_tape: computeLiveTape(db),
    // Per-strategy lead-wallet P&L attribution — who drives TP vs SL per strategy.
    lead_attribution: computeLeadAttribution(activeClosed),
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
    live_vs_shadow: liveVsShadow,
    // Definitive "is real money trading?" signal: a copy_trades row with
    // execution_mode='live_micro' only exists when COPY_LIVE_ENABLED + wallet
    // were active AND a real buy was submitted (a shadow fallback writes
    // execution_mode='shadow'). So any open/closed live_micro row = confirmed live.
    live_execution: (() => {
      const lo = open.filter((r) => r.execution_mode === 'live_micro');
      const lc = closed.filter((r) => r.execution_mode === 'live_micro');
      // Latest wallet-reconciliation snapshot (written by the live CopyTrader's
      // reconcileLivePositions sweep). Lets the open book be eyeballed against the
      // REAL wallet — per-position chain balance + status, plus orphan mints.
      const recon = (() => {
        try {
          const row = db.prepare(`SELECT value FROM bot_settings WHERE key = 'copy_live_recon'`).get() as { value: string } | undefined;
          return row?.value ? JSON.parse(row.value) as { checked_at?: number; positions?: Array<{ id: number; wallet_tokens: number; status: string }>; orphans?: unknown[]; orphan_count?: number } : null;
        } catch { return null; }
      })();
      const reconById = new Map<number, { wallet_tokens: number; status: string }>(
        (recon?.positions ?? []).map((p) => [p.id, { wallet_tokens: p.wallet_tokens, status: p.status }]),
      );
      return {
        confirmed_live: lo.length + lc.length > 0,
        open_live_positions: lo.length,
        closed_live_trades: lc.length,
        // Positions closed by the proactive wallet reconciler (tokens left the
        // wallet out-of-band; net_sol NULL, excluded from P&L). A non-zero count
        // here is the "phantom open got cleaned up" signal — see reconcileLivePositions.
        reconciled_no_tokens: lc.filter((r) => r.exit_reason === 'reconciled_no_tokens').length,
        // Wallet reconciliation: per-position chain balance + orphan mints (tokens
        // the bot live-traded, no longer tracks as open, but still in the wallet).
        // checked_at null = the reconciler hasn't run yet (live off / pre-deploy).
        reconciliation: recon ? {
          checked_at: recon.checked_at ?? null,
          orphan_count: recon.orphan_count ?? (recon.orphans?.length ?? 0),
          orphans: recon.orphans ?? [],
        } : { checked_at: null, orphan_count: 0, orphans: [] },
        // Uncapped (was slice(0,10), which under-showed the true open count — the
        // 2026-06-23 "table 10 vs header 11" mismatch). wallet_tokens/recon_status
        // come from the latest reconciliation snapshot (— = not yet checked).
        open_detail: lo.slice(0, 100).map((r) => {
          const rc = reconById.get(r.id as number);
          return {
            mint: (r.mint as string).slice(0, 8),
            entry_ts: r.entry_ts, entry_price_sol: r.entry_price_sol,
            live_tokens: r.live_tokens ?? null,
            wallet_tokens: rc?.wallet_tokens ?? null,
            recon_status: rc?.status ?? null,
            tx_sig_entry: ((r.tx_sig_entry as string) ?? '').slice(0, 20) || null,
          };
        }),
        // Per-closed-live-trade ACTUAL SOL spent (entry_price_sol × live_tokens =
        // swapCostSol from the executor) vs the 0.05-SOL target. Surfaces fills
        // that escaped the ~5% slippage band — the "0.01 SOL worth" buys. A healthy
        // exact-token-out fill lands ~0.0475 (95% of target, the -5% token floor);
        // anything below ~0.93× means the expected-tokens math under-bought.
        target_spend_sol: MICRO_TRADE_SIZE_SOL,
        anomalous_fills: lc.filter((r) => {
          const px = r.entry_price_sol as number; const tok = (r.live_tokens as number) ?? 0;
          if (typeof px !== 'number' || typeof tok !== 'number' || tok <= 0) return false;
          const pct = (px * tok) / MICRO_TRADE_SIZE_SOL;
          return pct < 0.93 || pct > 1.07;
        }).length,
        closed_detail: lc
          .sort((a, b) => (b.exit_ts as number ?? 0) - (a.exit_ts as number ?? 0))
          .slice(0, 30)
          .map((r) => {
            const px = r.entry_price_sol as number;
            const tok = (r.live_tokens as number) ?? 0;
            const spend = typeof px === 'number' && typeof tok === 'number' && tok > 0
              ? +(px * tok).toFixed(5) : null;
            const pct = spend != null && MICRO_TRADE_SIZE_SOL > 0
              ? +(spend / MICRO_TRADE_SIZE_SOL).toFixed(3) : null;
            return {
              mint: (r.mint as string).slice(0, 8),
              exit_ts: r.exit_ts, exit_reason: r.exit_reason,
              live_tokens: tok || null, entry_price_sol: px ?? null,
              actual_spend_sol: spend, spend_pct_of_target: pct,
              within_band: pct != null ? pct >= 0.93 && pct <= 1.07 : null,
              net_sol: r.net_sol ?? null,
              live_error: ((r.live_error as string) ?? '').slice(0, 120) || null,
              tx_sig_entry: ((r.tx_sig_entry as string) ?? '').slice(0, 20) || null,
            };
          }),
        // Failure-reason histogram (2026-06-19). live_buy_failed was ~41% of
        // closed live trades; classify the persisted live_error so a session can
        // see which failures the 3-attempt retry should salvage (slippage_6004 /
        // rent / not_landed) vs the terminal ones the per-mint cooldown handles
        // (disabled_buy / no_token_delta / thin_liquidity).
        failure_reasons: (() => {
          const fails = lc.filter((r) => r.exit_reason === 'live_buy_failed');
          const byClass: Record<string, number> = {};
          const otherSamples: string[] = [];
          for (const r of fails) {
            const raw = ((r.live_error as string) ?? '').trim();
            const cls = classifyLiveBuyFailure(raw);
            byClass[cls] = (byClass[cls] ?? 0) + 1;
            if ((cls === 'other' || cls === 'unknown') && raw && otherSamples.length < 5) {
              otherSamples.push(raw.slice(0, 120));
            }
          }
          return { total: fails.length, by_class: byClass, other_samples: otherSamples };
        })(),
        // Hot-poll engagement (persisted by the live CopyTrader). active_cycles>0
        // means the fast near-trigger re-pricing loop is firing; exits>0 means it
        // caught exits the 25s poll would have seen later. All zero = gate never met.
        hot_poll: (() => {
          try {
            const row = db.prepare(`SELECT value FROM bot_settings WHERE key = 'copy_hotpoll_stats'`).get() as { value: string } | undefined;
            return row?.value ? JSON.parse(row.value) : { active_cycles: 0, fetches: 0, exits: 0 };
          } catch { return { active_cycles: 0, fetches: 0, exits: 0 }; }
        })(),
      };
    })(),
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
