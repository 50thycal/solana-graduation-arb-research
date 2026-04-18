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
 */

/** Adverse price-ratio gap applied when an exit triggers at an SL / stop level. */
export const SIM_SL_GAP_PENALTY = 0.30;

/** Adverse price-ratio gap applied when an exit triggers at a TP / take-profit level. */
export const SIM_TP_GAP_PENALTY = 0.10;

/** Conservative per-trade round-trip cost when `round_trip_slippage_pct` is null on the row. */
export const SIM_DEFAULT_COST_PCT = 3.0;
