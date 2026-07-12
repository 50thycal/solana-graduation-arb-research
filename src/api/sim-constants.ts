/**
 * src/api/sim-constants.ts
 *
 * Shared constants for all in-memory simulators (Panel 4, Panel 10,
 * computeBestCombos in aggregates.ts, computeExitSim in exit-sim.ts).
 * Prevents drift when these values are recalibrated — change once here
 * and every simulator moves together.
 *
 * Recalibration history:
 *   2026-04-15: SL gap 0.20 -> 0.30 after live SL fills observed at -34% to -40%.
 *   2026-04-21: Added TP/SL grid constants so aggregates.ts can run the same
 *               12×10 optimizer that Panel 4 / Panel 6 use, instead of a
 *               fixed 10%SL/50%TP single point.
 *   2026-07-12: SIM_DEFAULT_COST_PCT 3.0 -> 6.0 (D3 live-cost-recon,
 *               docs/live-cost-recon-2026-07-12.md). The clean 324-pair hold30m
 *               live-vs-shadow join measured ~3.1pp of ENTRY slippage alone beyond
 *               the modeled entry — i.e. the old 3% round-trip assumption under-priced
 *               entry by itself. Real round trip ~= entry (~3.1pp measured) + exit
 *               (~3pp estimated for a TP100/SL30 limit-ish fill) ~= 6%. This makes the
 *               shadow scoreboard + wallet scoring honest about LIVE viability, which is
 *               the whole gate for going live (operator: no live-micro until a shadow
 *               looks promising, so the shadow must price execution realistically).
 *               Sample is June-era + stale; recalibrate from a modern live burst if one
 *               ever runs (the number could move up or down).
 */

/** Adverse price-ratio gap applied when an exit triggers at an SL / stop level. */
export const SIM_SL_GAP_PENALTY = 0.30;

/** Adverse price-ratio gap applied when an exit triggers at a TP / take-profit level. */
export const SIM_TP_GAP_PENALTY = 0.10;

/**
 * Per-trade round-trip cost when `round_trip_slippage_pct` is null on the row.
 * 6.0 as of 2026-07-12 (D3 live-cost-recon) — was 3.0; live fills measured ~3.1pp entry
 * slippage alone, so 3% under-priced the round trip by ~half. Shared by the copy shadow
 * sim (copy-trader.ts) AND wallet scoring (wallet-pnl.ts): raising it drops every shadow
 * strategy's future net + tightens the wallet gate, so the scoreboard reflects what we'd
 * actually net LIVE. See the recalibration note in the file header.
 */
export const SIM_DEFAULT_COST_PCT = 6.0;

// ──────────────────────────────────────────────────────────────
// TP/SL grid — shared with Panel 4 (filter-v2-data.ts) and
// computeBestCombos (aggregates.ts). Must stay in sync.
// ──────────────────────────────────────────────────────────────

/** Take-profit levels (% gain from entry) scanned by the grid optimizer. */
export const SIM_TP_GRID = [10, 15, 20, 25, 30, 35, 40, 50, 60, 75, 100, 150] as const;

/** Stop-loss levels (% loss from entry) scanned by the grid optimizer. */
export const SIM_SL_GRID = [3, 4, 5, 7.5, 10, 12.5, 15, 20, 25, 30] as const;

/** Minimum n required before we publish a per-combo optimum (guards against low-data overfit). */
export const SIM_MIN_N_FOR_OPTIMUM = 30;

/** Minimum TP-hit count in a cell before it qualifies as the optimum (guards against single-trade outliers). */
export const SIM_MIN_TP_HITS_FOR_OPTIMUM = 3;

/**
 * Fine-resolution checkpoint columns walked by the grid simulator. Every 5s
 * between T+40 and T+295, ending at T+300. The T+30 column is the entry point
 * and is handled separately (it's the denominator, not a checkpoint).
 * Rows with null checkpoints are skipped at walk-time.
 */
export const SIM_CHECKPOINT_COLUMNS: readonly `pct_t${number}`[] = (() => {
  const cps: `pct_t${number}`[] = [];
  for (let sec = 40; sec <= 295; sec += 5) cps.push(`pct_t${sec}` as const);
  cps.push('pct_t300' as const);
  return cps;
})();
