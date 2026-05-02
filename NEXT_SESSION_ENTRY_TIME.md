# Handoff: Find the Optimal Entry Time

**Created 2026-05-01.** Pass this doc to the next AI session as context. The session that wrote it ran out of obvious next steps and is handing off the structural change.

## TL;DR

The bot currently fixed-enters every trade at **T+30** post-graduation. Three observations make this brittle:

1. **80%+ rejection rate.** Of 21 graduations recorded over a recent 3-hour window, only 4 got the T+30 callback fired. The rest arrived via the slow RPC poll path (p50 = 56s, p95 = 98s) — past the original `STALE_THRESHOLD_SEC = 25` cutoff. Bumped to 120s in this session for data collection (`src/collector/price-collector.ts:354`), but strategies still can't trade them because their T+30 snapshot moment has already passed.
2. **Path-shape filters can't be evaluated on late arrivals.** Filters like `monotonicity_0_30`, `max_drawdown_0_30`, `sum_abs_returns_0_30`, `acceleration_t30` need price snapshots at every 5s from T+0 to T+30. If observation starts at T+45, those moments are gone — the columns are NULL and `filter-pipeline.ts` treats null as fail. Strategies skip those rows entirely.
3. **The 5-second poll discretization at T+30 entry inflates returns on pumps** (see graduation 18481, +700% gross because the strategy "took profit" at the 5s tick after a 7× pump that started right after entry). Real-world execution at T+30 with measured slippage on the spike would deliver far less than +700%.

The fix is to **stop hard-coding T+30 as the entry time** and instead let strategies pick their own entry checkpoint, then run a systematic analysis to find the optimal one across the historical data.

## What needs to change

### 1. Code: late-entry mode for strategies

**Goal:** strategies declare `entryTimingSec: 30 | 60 | 90 | 120` in their config. PriceCollector fires a separate callback at each canonical checkpoint. StrategyManager dispatches each strategy at its declared time.

**Files to touch:**
- `src/collector/price-collector.ts` — currently has one `onT30Callback` (search for `setT30Callback`). Generalize to `setCheckpointCallback(sec, fn)` keyed by checkpoint second. Or just add three more: `setT60Callback`, `setT90Callback`, `setT120Callback`. The first option is cleaner.
- `src/trading/config.ts` — add `entryTimingSec` to `StrategyParams` (validate against `[30, 60, 90, 120]`). Default `30` for backwards compat.
- `src/trading/strategy-manager.ts` — `attachToPriceCollector` currently registers one T+30 callback. Refactor to register each strategy's chosen checkpoint via the new generalized API. The existing `fanOutT30` becomes `fanOutCheckpoint(sec, ...)`.
- `src/trading/trade-evaluator.ts` — `onT30(...)` becomes `onCheckpoint(checkpointSec, ...)`. The price passed in is the price at that checkpoint, not necessarily T+30.
- `src/db/schema.ts` — no schema change needed; `trades_v2` already has `entry_timestamp` so we can reconstruct.

**Wiring nuance:** late-arriving observations skip earlier checkpoints. Currently `price-collector.ts:380` filters out past checkpoints from the snapshot schedule. The callbacks need to follow the same logic — only fire for checkpoints that actually got a snapshot. A strategy declaring `entryTimingSec: 30` on an observation that started at T+45 would never receive a callback. That's correct behavior — that strategy can't trade that grad. A strategy with `entryTimingSec: 90` would still fire.

### 2. Research: matrix analysis of entry times × filters

**Goal:** for every existing FILTER_CATALOG entry (and combos), compute the per-combo opt return at each of T+30, T+60, T+90, T+120, T+180, T+240 entry times. Build a heatmap. Identify the entry time that's best **on average across filters** (the new default), and the per-filter optima (some filters might want different entry times).

**Where to add:** new module like `src/api/entry-time-matrix.ts`. Mirrors the structure of `src/api/exit-sim-matrix.ts`. Output schema:

```ts
{
  generated_at: string;
  rows: Array<{
    filter_spec: string;          // "vel < 5 + dev < 3%"
    n_total: number;              // population size at each entry time may vary
    by_entry_time: {
      30:  { n, opt_tp, opt_sl, opt_avg_ret, opt_win_rate };
      60:  { n, opt_tp, opt_sl, opt_avg_ret, opt_win_rate };
      90:  { ... };
      120: { ... };
      180: { ... };
    };
    best_entry_sec: number;       // entry time with highest opt_avg_ret
    best_opt_avg_ret: number;
    delta_vs_t30_pp: number;      // best - T+30, in pp
  }>;
  summary: {
    overall_best_entry_sec: number;
    overall_best_pct_of_combos: number;  // % of combos for which this entry is best
    by_filter_group: Map<group, best_entry_sec>;
  };
}
```

**SQL twist:** `simulateCombo` in `src/api/aggregates.ts:435` currently anchors returns at `pct_t30 → pct_t300` and uses `ENTRY_GATE` (still `+5..+100` after the failed alignment attempt earlier this session). To support entry at T+60/90/120, refactor `simulateCombo` to take an `entrySec` parameter that picks `pct_t<entrySec>` as the entry baseline. Returns become `(1 + pct_t300/100) / (1 + pct_t<entrySec>/100) - 1`. Also: the entry gate would need to apply to `pct_t<entrySec>` instead of `pct_t30` — or stay on `pct_t30` if you want to filter at a fixed gate but enter later.

**Sample-size caveat:** later entry times have fewer rows because not every observation reaches T+120 with non-null data (full 5s grid coverage was 15.5% of complete observations earlier — much higher now after several days of new graduations, but still uneven). The matrix should report `n` per cell so the analyst can spot small-n cells.

### 3. Research: backfill 0-30s path data for late arrivals (separate question)

**Currently:** if observation starts at T+45, columns `pct_t5`/`pct_t10`/.../`pct_t30` are NULL. Path-shape filters fail null-check in `filter-pipeline.ts:42`. Late arrivals are unfilterable.

**Options:**
- **Accept the loss.** Late arrivals are observable for T+60+ checkpoints; that's enough to trade with a `entryTimingSec >= 60` strategy and a non-path-shape filter set.
- **Backfill from on-chain history.** Query `getSignaturesForAddress(poolAddress)` for the 0-30s window after migration_timestamp, parse swap prices, reconstruct the `pct_tN` checkpoints retroactively. This is similar to what `competition-detector.ts:detectBuyPressure` already does for T+0..T+30 swap aggregates — it COULD be extended to derive prices too. Adds a backfill stage at T+35 alongside `detectBuyPressure`. Cost: more RPC calls per graduation (~50-100 extra), might hit Helius rate limits.

The matrix analysis (#2) will tell you whether late-entry strategies need path-shape filters at all. If T+90 entry with non-path filters wins, you don't need the backfill.

## Concrete next steps for the next session

1. **Read `snapshot.json` directPriceCollector stats and `pipeline_health.verdict`** to confirm whether the 80% rejection problem is still active. (It was as of 2026-05-01 23:00 UTC, but pumpFun WS rates fluctuate.)
2. **Implement #2 first (matrix analysis).** Pure research — no code changes to trading flow, just adds a new panel. Lets you see whether moving entry actually helps before building #1.
3. **Pick the winner from #2** — likely T+60 or T+90 — and decide if it's worth implementing #1 (the late-entry trading mode).
4. **If yes, implement #1.** Push two new shadow strategies that mirror v10-snipers-base and v10-best-double but with `entryTimingSec` set to the matrix winner. Compare side-by-side with the T+30 originals.

## Things NOT to retry without thinking carefully

- **Do not widen `ENTRY_GATE` in `aggregates.ts`** to match the trading default `-99..1000`. That was tried (commit 04dff56), the heavy-cache recompute deadlocked Railway, and the bot went down for 2 hours. See the comment block at `aggregates.ts:407` and the BASELINE PARAMETERS section in CLAUDE.md. If you want them aligned, you need to first batch the simulator (paginate rows) or move heavy compute off the sync path.
- **Do not naively bump `STALE_THRESHOLD_SEC` further than 120s** without understanding the path-shape filter implication. Late observations have NULL path-shape data; if your strategy depends on them it skips the row anyway.
- **Be careful with the 5s polling discretization on TP fills.** Strategies appear more profitable than they are because spikes between polls get captured at the post-spike price. See graduation 18481 / mint `DunC6ovDYKoHe…` for the canonical example. Median, not mean, is the honest read — `strategy-percentiles.json` already exposes median.

## Useful files this session left behind

- `src/api/sniper-panel.ts` + `sniper-panel.json` on bot-status — sniper count + wallet velocity research panel
- `src/api/strategy-percentiles.ts` + `strategy-percentiles.json` on bot-status — per-strategy median/p10/p90/min/max with top winners + losers
- 8 v6/v7/v8 strategies disabled (clear losers, kept history but off the panel)
- 28 v4/v5 strategies deleted (kept only `v4-sumabs-opt` + `v5-velmono-opt`)
- v10 cohort still running: `v10-snipers-base`, `v10-best-single`, `v10-best-double`

## Current bar to clear (no change)

Beat `baseline_avg_return_pct` (currently ~−10.5%) by ≥ +0.3 pp on **n ≥ 100** with **median in line with mean** (no single-trade outlier driving the result) **AND** Panel 11 regime std-dev < 15% **AND** Panel 7 walk-forward NOT OVERFIT. No combo currently clears all four. The matrix analysis from this handoff might surface one — or it might not, in which case the answer is "this isn't a tradable edge yet, keep iterating."
