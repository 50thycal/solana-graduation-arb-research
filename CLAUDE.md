# CLAUDE.md — Mission & Operating Instructions

## MISSION

Build a profitable trading bot on post-graduation PumpFun tokens.

The open research question is:

> **Which single filter or combination of filters — from the full v2 filter search space — yields a profitable bot after all costs (gap penalties, round-trip slippage), on n ≥ 100 samples, with regime-stable edge?**

**Ranking framework (updated 2026-04-21):** `/api/best-combos` and `wallet-rep-analysis` no longer evaluate every combo at a fixed 10% SL / 50% TP. They now run each candidate through the same 12×10 TP×SL grid Panel 4/Panel 6 use and report the combo at its own **opt TP / opt SL / opt avg return**. This mirrors Panel 6's `top_pairs` logic and matches how we'd actually deploy each filter — every combo exits at its own best-fit TP/SL, not a one-size-fits-all point. The fixed-10/50 framework is retired.

**Current baseline:** rolling "all labeled rows (entry-gated only)" at its own optimal TP/SL. Live value lives in `best-combos.json → baseline_avg_return_pct`. Any combo that beats it by ≥ +0.3 pp on n ≥ 100 with regime-stable WR is a promotion candidate. Any new filter or combination is fair game — single filters, pairs, triples, cross-dimension combos — as long as each candidate is evaluated against the rolling baseline and the same rigor (sample size, regime stability, cost modeling).

The bot is free to hypothesize, test, and adopt new filters without asking permission. The only rules are: beat the baseline, survive regime checks, and never claim victory on small n.

The human operator is the code-review and deploy loop — they do not write code, screenshot dashboards, or query the database. Claude self-serves all data via the `/api/*` JSON endpoints (see `## SELF-SERVICE DATA ACCESS` below). Move fast.

---

## RESEARCH FINDINGS (refreshed 2026-05-01, n~6,000 trades / 4,500 labeled grads)

These are prior results. They are **starting knowledge**, not constraints. If newer data contradicts anything here, update the doc — don't twist the data to fit.

### Confirmed Dead (do not revisit without strong reason)
- **Raw buy-and-hold T+30 to T+300**: negative EV. Mean ALL path bottoms at ~−2% around T+50–T+75 then drifts to ~−1% by T+300.
- **SL-only strategies (no TP)**: All negative EV. The asymmetry kills you — winners give +19%, losers take -59%. TP is mandatory.
- **SOL raised filters**: All tokens graduate at ~85 SOL. No discriminating power.
- **Raw holder count filters**: No signal in isolation. All ~38% win rate regardless of threshold. (Useful in combos.)
- **Raw top5 wallet concentration filters**: Actively negative in isolation — higher concentration = worse. (Useful in combos.)
- **Momentum continuation** (T+300 > T+30): Only 47%. Not a signal.
- **liq_t300 / liq_retained as entry filters** (REMOVED 2026-05-01): These look at T+300 liquidity to make T+30 entry decisions — pure look-ahead bias. The +36% / +46% "baselines" they produced were tautological artifacts. Removed from `FILTER_CATALOG` in `src/api/aggregates.ts:369-372`. Field stays in schema for backwards-looking exit-strategy research only (`exit-sim.ts:656,701`).
- **Single-filter strategies**: Panel 7 walk-forward (test split) shows every standalone filter has negative test-set return. Best is `dev > 5%` at −5.78% test. **Single filters cannot clear the bar — combos required.**

### Current Best-Known Baseline (per-combo opt framework)
- **Baseline**: rolling ALL-entry-gated population at its own grid optimum — `/api/best-combos → baseline_avg_return_pct`. Reported afresh every sync. As of 2026-05-01: ~−10.5%.
- **Entry gate split (2026-05-01)**: research-side ENTRY_GATE is `pct_t30 >= 5 AND pct_t30 <= 100` (`src/api/aggregates.ts:407`). Trading default is `pct_t30 >= -99 AND pct_t30 <= 1000` (`src/trading/config.ts:177-178`). They were briefly aligned at the wider range but the heavy-cache recompute deadlocked Railway — Panel 4/6/7 simulators iterate eligible rows × SIM_TP_GRID × SIM_SL_GRID, and a 3× row expansion blew the budget. Reverted. Asymmetry means promotion-bar comparisons (`opt_avg_ret > baseline_avg_return_pct + 0.3 pp`) are approximate — research baseline is computed on a tighter population than what shadow strategies actually trade. Call out in writeups.
- **Promotion bar**: a combo qualifies for promotion when `opt_avg_ret > baseline_avg_return_pct + 0.3 pp` on n ≥ 100 with regime std-dev < 15% (Panel 11). Positive returns are not required — beating the rolling floor is.
- **Median check (added 2026-05-01)**: With the open entry gate, single trades can register +700% returns due to 5s-poll discretization on fast pumps (see graduation 18481, mint `DunC6ovDYKoHe…`). Mean is unreliable. Cross-check with `strategy-percentiles.json` median before promoting any candidate. If median << mean, the strategy is outlier-driven, not edge.
- **Shadow vs paper costs**: Paper applies a static 20% gap penalty on SL fills which is too pessimistic; paper book runs ~−14%. Shadow (measured slippage) is the realistic cost model and runs ~−8 to −9%. **Compare candidates against shadow baseline, not paper.**

### Leaderboard Leaders (snapshot 2026-05-01, post-liq-fix)
Top of `/api/best-combos` ranked by `opt_avg_ret`:

**Currently beating baseline at n ≥ 100:**
1. `vel < 5 + dev < 3%` — n=125, opt @ 100/30, opt_avg_ret **+3.09%** (~13.5 pp lift over baseline). The first true honest-leaderboard winner since the framework refactor.
2. `age > 10min + dev < 3%` — n=170, opt @ 150/30, opt_avg_ret +1.46%
3. `vel < 20 + top5 < 10%` — n=182, opt @ 75/30, opt_avg_ret +0.60%

**High opt but n<100 (watch):**
1. `vel 20-50 + dd > -10%` — n=92 (8 from promotion), opt @ 150/25, opt_avg_ret **+7.58%**, 65% WR. Highest opt in the catalog.
2. `vel < 5 + top5 < 10%` — n=65, opt @ 75/30, opt_avg_ret +6.42%
3. `vel 10-20 + liq > 100` — n=52, opt @ 30/25, opt_avg_ret +2.34%, 71% WR

**Active live cohort (shadow mode, 2026-05-01):**
- `v9shadow-vel5-10` — n=9, **median +7.99%**, 7 TPs / 2 SLs. Best live strategy by far.
- `v9shadow-vol-30-60` — n=17, median +3.83%
- `v9shadow-vel50-liq` — n=11, median +2.95%
- `v10-snipers-base` (`snipers <= 2`) — n=11, median **−10.59%** (mean of −1.09% was misleading; baseline-equivalent in reality)
- `v10-best-single` (`top5 < 10%`) — n=8, mean +55% but median **−19.59%** — single trade outlier (graduation 18481) drove the mean

### Promising Leads (priority order — beat the shadow-baseline ~−9% by ≥ +0.3 pp on n ≥ 100 with stable regime)
1. **`vel 20-50 + dd > -10%`** (n=92, opt @ 150/25, +7.58%): Closest to promotion. ~8 samples to n=100. Already deployed as `v10-best-double` shadow but matches < 6% of grads — slow accumulator. **Top promotion candidate.**
2. **`vel < 5 + dev < 3%`** (n=125, opt @ 100/30, +3.09%, beats_baseline=true): Already qualifies on numerics. Needs Panel 11 regime check before promoting. If stable, deploy as live shadow strategy.
3. **`v9shadow-vel5-10` live cohort** (n=9, median +7.99%): Tightest distribution and only positive median in the live cohort. Direction is unambiguous — needs n ≥ 50 to call.
4. **Sniper combos**: `snipers <= 2 + wallet_vel_avg < 20` had +7.9 pp lift in early sniper-panel readings but coverage on the historical population is sparse (~8% then, ~15-20% now). Re-pull `sniper-panel.json` periodically as new graduations populate sniper data live (T+35).
5. **Holders / top5 / dev as exclusion filters**: `serial_rugger`, `repeat_dev >= 3`, `rapid_fire`, `top5 > 30%` all cluster at −20 to −27% test return in Panel 7 — strong exclusion candidates. Cumulative skip on these may lift the entry-gated population by a few pp without picking specific filters.

**Don't promote on these alone:**
- `top5 < 10%` standalone (was a promising lead pre-2026-05-01) — Panel 7 shows DEGRADED on test (−16% test), and the `v10-best-single` live test confirmed median −19.59%.
- Mean-positive strategies whose median is negative — the +55% / +63% on `v10-best-single` and `+11/+12% means` on v6 sumabs strategies are entirely driven by graduation 18481's +700% trade (a 5s-poll artifact on a 7× pump in 104s, not real edge).

## SEARCH SPACE

The full space Claude is free to explore (see `FILTER_PRESET_GROUPS` in `src/utils/html-renderer.ts:3050` for exact thresholds, and `/filter-analysis-v2` Panels 1–11 for current combinatorial coverage; Panel 11 = combo regime stability):

- **Velocity** (`bc_velocity_sol_per_min`): <5, 5–10, 5–20, 10–20, <20, <50, 20–50, 50–200, >200
- **BC Age** (`token_age_seconds`): <10 min, >10 min, >30 min, >1 hr, >1 day
- **Holders** (`holder_count`): ≥5, ≥10, ≥15, ≥18
- **Top 5 Wallet Concentration** (`top5_wallet_pct`): <10%, <15%, <20%, <30%, <40%
- **Dev Wallet** (`dev_wallet_pct`): <3%, <5%
- **Liquidity at T+30** (`liquidity_sol_t30`): >50, >100, >150
- **Path shape (0–30s window)**: monotonicity, max_drawdown_0_30, sum_abs_returns_0_30, acceleration_t30
- **Buy pressure** (computed at T+35 — strategies auto-delay 5s): `buy_pressure_unique_buyers`, `buy_pressure_buy_ratio`, `buy_pressure_whale_pct`
- **Snipers** (`sniper_count_t0_t2`, computed at T+35): ≤2, ≤5, >5, >10
- **Sniper wallet velocity** (`sniper_wallet_velocity_avg`, also T+35): <5, <10, <20, ≥20 (avg # of EARLIER graduations these snipers also sniped — PRIOR-only by construction)
- **Creator reputation** (`creator_prior_*`, derived from self-join): fresh_dev, repeat_dev≥3, clean_dev, serial_rugger, rapid_fire
- **T+30 entry gate**: research uses `+5..+100` (defined in aggregates.ts ENTRY_GATE); trading default is `-99..1000`. Asymmetry is intentional — wider research gate deadlocked the heavy-cache compute and was reverted.
- **Cross-dimension combos** — any pair, triple, or N-way combination of the above
- **New dimensions** — add any field already captured on `graduation_momentum` as a candidate filter; if a useful field isn't captured yet, add it to the schema and backfill

**Look-ahead leak rule (added 2026-05-01):** Never add a `where` clause that references a column with a `_t300`, `_t600`, `_0_300`, `_0_600`, `max_relret_*`, or any other field whose value is only known AFTER T+30. Those columns may exist in the schema for backwards-looking research (e.g. `exit-sim.ts` uses `liquidity_sol_t300` for whale-sell exit simulation) but they MUST NOT appear in `FILTER_CATALOG`. The `liq_t300 / liq_retained` look-ahead bias bug (fixed 2026-05-01) inflated the leaderboard's apparent +36% baseline to a tautology — don't repeat.

For each candidate, the evaluation protocol is fixed: compute avg return, win rate, and regime std-dev on n ≥ 100, across the same TP/SL grid as the baseline, with the same cost model. No special pleading.

---

## THE ITERATION LOOP (REPEAT EVERY CYCLE)

Each cycle follows this exact pattern:

1. **Claude fetches live state** via `/api/diagnose`, `/api/snapshot`, and `/api/best-combos` (see `## SELF-SERVICE DATA ACCESS`). No human screenshots.
2. **Claude picks the next hypothesis** — a filter or combo to test, or a bug to fix — based on the leaderboard and diagnose verdict, not on what a previous session said.
3. **Claude pushes a code update** (new filter, new panel, bug fix, schema addition).
4. **Bot redeploys and collects data.**
5. **Next cycle starts at step 1.**

Never skip straight to "the new signal is working" without checking the diagnose verdict first. Assume bugs exist until `/api/diagnose` says `HEALTHY`.

---

## YOUR ROLE AS CODING AGENT

You are responsible for:

1. Writing and updating the bot code
2. Maintaining a LIVE dashboard the human can read at a glance
3. Diagnosing bugs from dashboard output alone
4. Keeping the bot focused on the thesis — do not drift
5. Declaring a conclusion when the data is sufficient

You are NOT responsible for:
- Running the bot (human does that)
- Deciding when to stop (you will declare when data is sufficient)
- Trading execution (research only for now)

---

## DASHBOARD REQUIREMENTS (CRITICAL)

The dashboard is the primary communication channel between the bot and the AI. Build it well. Update it every iteration.

The dashboard MUST always show:

### HEADER
- Bot status: RUNNING / ERROR / STALLED
- Uptime
- Graduations detected (total)
- Graduations with complete price data (T+300s captured)

### THESIS SCORECARD
- Total labeled: PUMP / DUMP / STABLE counts
- Raw win rate % (PUMP / total labeled)
- Best TP+SL combo EV + filtered win rate %
- Vel 5-20 sample count and progress toward n=200

### LAST 10 GRADUATIONS TABLE
Columns: GradID | Open Price | T+60s | T+300s | % Change | Label | Holders | Top5% | DevWallet% | BC Age (min) | BC Velocity

### DATA QUALITY FLAGS
- Price source: PumpSwap pool? YES / NO (flag if NO)
- Any null fields in last 10 rows? List them
- Timestamp drift detected? YES / NO
- Last graduation detected: X seconds ago (flag if >5 min)

### CURRENT CODE VERSION + LAST CHANGE SUMMARY
- What changed in this version
- What bug it was fixing
- What to watch for in next dashboard read

---

## BUG TRIAGE PROTOCOL

When the human feeds back a dashboard screenshot, diagnose in order:

- **LEVEL 1** — Is the bot even running and detecting graduations?
  - If no graduations in 10+ min: connection/subscription bug
- **LEVEL 2** — Is price data being captured correctly?
  - Check price source flag. Check for nulls. PumpSwap pool price ONLY. Not BC price.
- **LEVEL 3** — Are timestamps correct?
  - T+300s should be relative to graduation detection, not wall clock
- **LEVEL 4** — Is the label logic correct?
  - PUMP = >+10% at T+300s from open
  - DUMP = <-10% at T+300s from open
- **LEVEL 5** — Is the signal real or noise?
  - Only ask this question after Levels 1-4 are confirmed clean

Fix bugs in order. Do not skip levels.

---

## CONCLUSION RULES (per candidate strategy)

Every candidate filter or combo passes, fails, or is inconclusive on these rules. The mission as a whole is never "done" — it ends only when a **shipped profitable strategy** is running.

### CANDIDATE VALID (adopt as new baseline)
- n ≥ 100 samples
- `opt_avg_ret` beats `baseline_avg_return_pct` (from best-combos.json) by at least +0.3 percentage points, each evaluated at its own grid optimum (per-combo TP/SL)
- Regime std-dev < 15% across available time windows (Panel 11)
- Walk-forward (Panel 7) verdict is ROBUST or DEGRADED, NOT OVERFIT
- `/api/diagnose` returns `HEALTHY`
- Output: "NEW BASELINE — `<filter spec>` at tp=`<opt_tp>` sl=`<opt_sl>` beats `<baseline>` by `<delta>` on n=`<n>`. Updating CLAUDE.md baseline section and promoting in `/api/best-combos`."

### CANDIDATE INVALID (drop and try next)
- n ≥ 100 and avg return ≤ baseline − 0 pp, OR
- Regime std-dev ≥ 15% (edge too unstable), OR
- Tail loss rate >20% of trades losing >50% despite SL
- Output: "`<filter spec>` — no edge. Avg return `<X>`, std dev `<Y>`. Moving to next candidate."

### BLOCKED
- Data quality issues persist after 3+ fix cycles on the same Level 1–4 bug
- Graduation detection too sparse (less than ~30/day) to collect data in reasonable time
- Schema is missing a field needed to test the next candidate
- Output: "BLOCKED — `<specific technical blocker>`. Options: `<A>`, `<B>`."

Never declare victory on n < 100. Never keep a candidate running past a clear invalidation.

---

## BASELINE PARAMETERS (current best-known — update whenever a new winner is promoted)

| Parameter | Value |
|---|---|
| Entry timing | T+30 post-graduation on PumpSwap pool |
| Entry gate (split) | Research: `pct_t30 >= 5 AND pct_t30 <= 100` (`aggregates.ts:407`). Trading default: `-99 / +1000` (`config.ts:177-178`). Briefly aligned 2026-05-01 but the wider research gate deadlocked the heavy-cache recompute — reverted. Promotion-bar comparisons are approximate as a result. |
| Filter | One n≥100 combo beats baseline: `vel < 5 + dev < 3%` (n=125, opt @ 100/30, +3.09%, beats_baseline=true). Watch `vel 20-50 + dd > -10%` at n=92 (opt +7.58% @ 150/25) — closest to promotion at n=100. |
| Stop-loss | Per-combo `opt_sl` from `SIM_SL_GRID = [3, 4, 5, 7.5, 10, 12.5, 15, 20, 25, 30]` — no longer fixed. 30% adverse gap penalty modeled on SL fills. |
| Take-profit | Per-combo `opt_tp` from `SIM_TP_GRID = [10, 15, 20, 25, 30, 35, 40, 50, 60, 75, 100, 150]` — no longer fixed. 10% adverse gap penalty modeled on TP fills. |
| Round-trip costs | Per-token measured slippage, fallback 3% (`SIM_DEFAULT_COST_PCT`). Shadow strategies use measured entry+exit slippage from on-chain pool state — more accurate than paper's static 20% gap penalty. **Compare candidates against shadow baseline (~−9%), not paper (~−14%).** |
| Baseline avg return | **Rolling** — published live as `baseline_avg_return_pct` in `best-combos.json`. Recomputed every 2 min against the current entry-gated labeled population at its own opt TP/SL. ~−10.5% as of 2026-05-01. |
| Promotion bar | Beat `baseline_avg_return_pct` by ≥ +0.3 pp on n ≥ 100 with Panel 11 regime std-dev < 15% AND Panel 7 walk-forward NOT OVERFIT AND `strategy-percentiles.json` median in line with mean (no single-trade outlier driving the result). |
| Price source | PumpSwap pool ONLY (not bonding curve) |
| Execution | Research + paper + shadow. **No live trades yet** — bar to clear is profitable shadow strategy at n ≥ 100 by both mean AND median. |
| Monthly revenue target | ~$490/month at 0.5 SOL position size (covers AI/infra costs) |
| Position monitoring | All enabled strategies use `five_second` mode (`src/trading/position-manager.ts`). 5s polling can over-collect on fast pumps via discretization (see graduation 18481 +700% trade) — known limitation, mainly affects shadow stats not live execution math. |

Simulator constants are exported from `src/api/sim-constants.ts` and shared across `computeBestCombos` (aggregates.ts), Panel 4 / Panel 6 / Panel 10 (filter-v2-data.ts), and the wallet-rep analysis. Changes to grid or gap penalties there propagate everywhere — do not re-hardcode values in new code paths.

### Filter dimensions currently exposed in the search:
See `SEARCH SPACE` section above. Any dimension there is fair game; add new ones freely.

---

## SELF-SERVICE DATA ACCESS

**Rule: Claude self-serves all bot data via the `bot-status` branch on GitHub. The human operator does NOT screenshot dashboards, query the DB, or pull Railway logs anymore.**

**IMPORTANT: Do NOT use `WebFetch` against the Railway deployment URL — it returns 403.** Instead, read data from the `bot-status` branch, which the bot pushes to every 2 minutes. Two methods are available (prefer GitHub MCP, fall back to raw URL):

#### Method 1: GitHub MCP tool (preferred — returns full JSON)
Use `mcp__github__get_file_contents` with `owner=50thycal`, `repo=solana-graduation-arb-research`, `ref=refs/heads/bot-status`, and `path=<filename>.json`. The result may be large — pipe through `python3`/`jq` to extract what you need (see examples below).

#### Method 2: raw.githubusercontent.com (fallback — may be summarized by WebFetch)
Use `WebFetch` against the `GIST_*_URL` values in `.claude/settings.json`. These are `raw.githubusercontent.com` URLs pointing at the same `bot-status` branch files. Note: WebFetch passes content through a summarizer, so you may lose detail on large responses.

### Session-start protocol (do this first, every time)

1. **`diagnose.json`** → confirm `verdict: "HEALTHY"`. If not, fix the reported level before doing anything else.
2. **`snapshot.json`** → read counts, scorecard, data quality, last 10 graduations, last error. Note `best_known_baseline` carries `opt_tp_pct` / `opt_sl_pct` (per-combo).
3. **`best-combos.json`** → leaderboard ranked by `opt_avg_ret` at each combo's own TP/SL optimum (mirrors Panel 6 `top_pairs`). `baseline_avg_return_pct` is the rolling entry-gated floor the top row has to beat by +0.3 pp on n≥100 to promote. **Note: research uses `+5..+100` entry gate, but trading strategies default to `-99..1000` — the comparison is approximate.** Pick the next hypothesis from here.
4. **`strategy-percentiles.json`** → per-active-strategy median / p10 / p25 / p75 / p90 / min / max for both gross and net. Plus `top_winners` and `top_losers` (top 3 each, with mint + graduation_id). **Use this BEFORE celebrating any positive mean** — single-trade outliers (see graduation 18481) have inflated several mean returns past the median and the median is the honest read.
5. **`panel11.json`** → regime stability for the top combos — check `stability` and `wr_std_dev` alongside `opt_avg_ret`.
6. **`panel3.json`** → regime stability for individual filters — useful when evaluating single-dimension signals.
7. **`price-path-stats.json`** → mean price paths by label, Cohen's d effect sizes for path features, entry timing optimization.
8. **`trades.json`** → paper + shadow trading performance: stats, by-strategy breakdown (filtered to ENABLED strategies only as of 2026-05-01 — disabled strategies' history stays in DB but drops from the panel), recent trades.
9. **`sniper-panel.json`** → threshold sweeps + histograms for `sniper_count_t0_t2` and `sniper_wallet_velocity_avg`, plus the slice of `/api/best-combos` rows that include a sniper filter. Coverage is growing (was ~8% of historical rows on 2026-05-01, all new graduations populate live at T+35).
10. **`exit-sim-matrix.json`** → when you have a promising combo from step 3, check here to see whether any dynamic exit strategy (momentum_reversal / scale_out / vol_adaptive / time_decayed_tp / whale_liq) beats the combo's own static optimum. A positive `best_delta_pp` is the promotion signal for a live dynamic-exit strategy. (Note: `whale_liq` consistently underperforms — confirmed 2026-05-01.)

#### Drill-down files (consult when a specific question comes up)

- **`panel1.json` / `panel2.json` / `panel5.json`** — single-feature filter comparison (with T+60/T+120 variants), return percentiles (MAE/MFE/Final), Wilson CI + bootstrap significance. Use when evaluating whether an apparent edge is statistically real.
- **`panel4.json`** — TP/SL EV simulator with 12×10 grid + T+60/T+120 hold variants. Use when tuning TP/SL for a promising filter.
- **`panel6.json`** — auto-scanned top pairs leaderboard (1378 two-way combos, plus T+60/T+120). Use when hunting for cross-dimension combos beyond `/api/best-combos`.
- **`panel7.json`** — walk-forward validation (train 70% / test 30%). Use to check whether a filter's optimum is robust or overfit.
- **`panel8.json`** — loss tail & risk metrics (CVaR, worst trade, max consecutive losses). Use when a candidate has a suspicious win-rate vs avg-return profile.
- **`panel9.json`** — equity curve & drawdown simulation. Use for the portfolio-level view of a filter.
- **`panel10.json`** — DPM optimizer results: per-filter optimum + top 10 runners-up + category/overall aggregates. Use when tuning trailing SL, breakeven, SL delay etc. on top of fixed 30/10 base TP/SL.
- **`price-path-detail.json`** — full `/price-path` data: overlay (≤200 raw token paths), mean paths ±1 SD, Cohen's d, acceleration histogram, entry-timing heatmap, monotonicity buckets. Use when designing path-shape filters.
- **`trading.json`** — full `/trading` dashboard: open positions, performance by strategy, recent trades (50), skips + reasons, active configs. Use to monitor live paper trading.
- **`wallet-rep-analysis.json`** — top 20 combos × creator-wallet-rep modifiers (clean_dev, fresh_dev, repeat_dev_3plus, profitable_dev, not_rapid_fire, …). Each cell = `opt_avg_ret` delta in pp (`delta_opt_ret_pp`) with n retention; `summary[]` ranks rep filters by mean Δ. Both the base and rep-modified subsets are evaluated at their own per-combo TP/SL optimum — use after a combo is identified in `/api/best-combos` to see whether a creator-rep overlay improves profitability enough to justify the sample-size hit.
- **`exit-sim.json`** — single-universe dynamic-exit simulator (pinned to `vel<20 + top5<10%` as a reference universe — NOT the current baseline). Shape: `{universe: {label, n_rows}, baseline_static: {params:{sl_pct:10, tp_pct:50}, avg_return_pct, win_rate_pct, exit_reason_breakdown}, strategies: {momentum_reversal, scale_out, vol_adaptive, time_decayed_tp, whale_liq}}`. Each strategy carries `grid[]` (all param permutations) + `best` (top cell by avg_return_pct). The 5 strategies and their param grids:
  - `momentum_reversal` — drop_from_hwm_pct (3/5/7/10) × min_hwm_pct (10/20/30), fixed sl_pct=10. Exits when price drops `drop_from_hwm_pct%` from the high-water mark after crossing `min_hwm_pct%`.
  - `scale_out` — first_tp_pct (15/25/35) × size_pct (0.5/0.67) × runner_trail_pct (5/10), fixed sl_pct=10. Partial exit at first_tp, runner trails by runner_trail_pct.
  - `vol_adaptive` — k (1/1.5/2/2.5/3), fixed sl_pct=10. Trailing SL at k × path_smoothness. Skips rows missing path_smoothness.
  - `time_decayed_tp` — preset (aggressive/linear/exponential/conservative) × sl_pct=10. TP ladder decays over time — aggressive starts at 50% and drops fast, conservative holds 75% for 90s.
  - `whale_liq` — liq_drop_pct (20/30/40) × whale_sell_sol (0.5/1/2), fixed sl_pct=10, tp_pct=50. Exit on liquidity drop or whale sell event. Skips rows missing whale/liq event data.

  Use to pick a dynamic exit shape for the reference universe. For a different universe pass `?universe=...` to /exit-sim, or use exit-sim-matrix below for the top 20 combos at once.
- **`exit-sim-matrix.json`** — top 20 combos × 5 dynamic-exit strategies. Shape: `{min_n_per_cell, rows[]}`. Each row carries the combo's `filter_spec`, `n_rows`, `static_10_50_return_pct` (reference 10%SL/50%TP reconciliation column — same value as the old leaderboard), `static_optimal_return_pct / _win_rate / _sl / _tp` (per-combo best static cell across SIM_TP_GRID × SIM_SL_GRID — this IS the opt baseline), `leaderboard_opt_return_pct` (opt_avg_ret from /api/best-combos — sanity check), `strategies[5]` with each strategy's best cell and `delta_vs_static_pp` (Δ vs the combo's own static optimum — the fair baseline), plus overall `best_delta_pp` and `best_strategy`. A positive `best_delta_pp` means dynamic exits beat the combo's own static optimum — that's the signal you're looking for when designing trailing/momentum/vol-based exits on top of a promising combo.

#### Example: reading trades data via GitHub MCP + python3
```
# 1. Fetch via MCP (result saved to a temp file when large)
mcp__github__get_file_contents(owner=50thycal, repo=solana-graduation-arb-research,
    path=trades.json, ref=refs/heads/bot-status)

# 2. Parse the MCP response (it wraps content in [{type, text}] array)
python3 -c "
import json
with open('<temp_file_path>') as f:
    raw = json.load(f)
text = raw[1]['text']
data = json.loads(text[text.find('{'):])
print(json.dumps(data['by_strategy'], indent=2))
"
```

#### IMPORTANT: trades.json large-file workaround

`trades.json` grows large as paper trading accumulates. The MCP tool will exceed context limits and save the result to a local temp file instead of returning it inline. When this happens:

1. **The MCP call will say:** `"Error: result (N characters) exceeds maximum allowed tokens. Output has been saved to <path>.txt"`
2. **Do NOT try to Read() the file directly** — it will also exceed the limit.
3. **Instead, use Bash + python3 to extract only what you need:**

```bash
python3 -c "
import json
with open('<path_from_error_message>.txt') as f:
    raw = json.load(f)
text = raw[1]['text']
data = json.loads(text[text.find('{'):])
# Extract specific fields — don't print the whole thing
print('Stats:', json.dumps(data['stats'], indent=2))
print('By strategy:', json.dumps(data['by_strategy'], indent=2))
print('Recent trades count:', len(data.get('trades', [])))
# For last N trades:
for t in data.get('trades', [])[-5:]:
    print(json.dumps({k: t[k] for k in ['id','strategy_id','exit_reason','net_return_pct','net_profit_sol']}, indent=2))
"
```

#### IMPORTANT: panel4.json curl + python workaround (1.2MB+)

`panel4.json` is too large for the MCP tool to save locally — instead of a temp-file redirect, MCP returns a `raw.githubusercontent.com` URL. The same is true for any other file that exceeds MCP's save threshold in the future. Fetch these with `curl` (NOT WebFetch — WebFetch passes content through a summarizer and drops detail on large JSON files), then parse with python3:

```bash
# 1. Download via curl — URL comes from the MCP "too large to display" error message.
curl -sL "https://raw.githubusercontent.com/50thycal/solana-graduation-arb-research/refs/heads/bot-status/panel4.json" -o /tmp/panel4.json

# 2. Extract only the fields you need. Panel 4 shape:
#    data.panel4.grid                — {tp_levels, sl_levels, default_tp, default_sl}
#    data.panel4.constants           — cost/gap model constants
#    data.panel4.baseline            — {n, combos, optimal}
#    data.panel4.filters[]           — each filter's {n, combos: {avg_ret, med_ret, win_rate}, optimal: {tp, sl, avg_ret, win_rate}}
#    data.panel4_t60 / data.panel4_t120  — same shape, T+60 / T+120 hold horizons
python3 -c "
import json
with open('/tmp/panel4.json') as f: data = json.load(f)
p = data['panel4']
print('Grid:', p['grid'])
# Top 10 single filters by opt avg_ret
rows = [(f['filter'], f['n'], f['optimal']) for f in p['filters']
        if f.get('optimal') and f['optimal'].get('avg_ret') is not None]
rows.sort(key=lambda x: x[2]['avg_ret'], reverse=True)
for name, n, opt in rows[:10]:
    print(f'{name:30s} n={n:4d} tp={opt[\"tp\"]:3d} sl={opt[\"sl\"]:3d} avg_ret={opt[\"avg_ret\"]:+.2f} wr={opt[\"win_rate\"]:.0f}')
"
```

`panel4.filters[i].combos` is a dict of flat arrays (`avg_ret`, `med_ret`, `win_rate`), each length 120, indexed `[ti * 10 + si]` where `ti` is the TP index into `grid.tp_levels` and `si` is the SL index into `grid.sl_levels`. Only pull the combo row(s) you need — iterating all 120 cells per filter across 59 filters is what blew the MCP inline limit in the first place. Same `curl → python3` pattern works for `panel9.json`, `panel10.json`, `price-path-detail.json`, and `trading.json` when they grow past the MCP inline threshold.

This pattern works reliably. The file path comes from the MCP error message — copy it exactly.

### File catalogue (on `bot-status` branch)

Core / session-start:

| File | Corresponding API | Description |
|---|---|---|
| `diagnose.json` | `/api/diagnose` | Level 1–4 bug triage verdict |
| `snapshot.json` | `/api/snapshot` | Dashboard summary: counts, scorecard, data quality, recent graduations |
| `best-combos.json` | `/api/best-combos` | Filter + combo leaderboard ranked by sim return |
| `trades.json` | `/api/trades` | Paper trading: stats, by-strategy breakdown, recent trades |
| `strategies.json` | `/api/strategies` | All strategy configs incl. DPM params (TP/SL, trailing SL, breakeven, etc.) |

Filter-analysis-v2 panels (one file per panel family; variants like T+60/T+120 grouped into the parent panel file):

| File | Corresponding API | Description |
|---|---|---|
| `panel1.json` | `/api/panel1` | Single-feature filter comparison + T+60 and T+120 horizon variants |
| `panel2.json` | `/api/panel2` | T+30-anchored return percentiles (MAE / MFE / Final) + Sharpe-ish |
| `panel3.json` | `/api/panel3` | Single-filter regime stability across time buckets |
| `panel4.json` | `/api/panel4` | TP/SL EV simulator (12×10 grid) + T+60 / T+120 hold variants |
| `panel5.json` | `/api/panel5` | Wilson CI + bootstrap significance at per-filter optimum |
| `panel6.json` | `/api/panel6` | Multi-filter intersection — top pairs (auto-scanned) for T+300, T+60, T+120 |
| `panel7.json` | `/api/panel7` | Walk-forward validation — train 70% / test 30% |
| `panel8.json` | `/api/panel8` | Loss tail & risk metrics at per-filter optimum (CVaR, worst trade, max loss streak) |
| `panel9.json` | `/api/panel9` | Equity curve & drawdown simulation (sparkline, max DD, Sharpe, Kelly) |
| `panel10.json` | `/api/panel10` | DPM optimizer — per-filter optimum + top 10 runners-up + category/overall aggregates |
| `panel11.json` | `/api/panel11` | Combo filter regime stability (cross-group pairs) |

Filter-analysis-v3 panels (extension of v2 — crash-prediction research):

| File | Corresponding API | Description |
|---|---|---|
| `panelv3_1.json` | `/api/panelv3_1` | v3 Panel 1 — top 20 three-filter combos (focused scan around Panel 6 top pairs), per horizon (T+300 / T+120 / T+60) |
| `panelv3_2.json` | `/api/panelv3_2` | v3 Panel 2 — max_dd_0_30 gate stacked on top 5 singles + top 5 pairs across {−5, −10, −15, −20, −25} thresholds |
| `panelv3_3.json` | `/api/panelv3_3` | v3 Panel 3 — crash survival curves: P(min rel-ret > {−5, −10, −20}%) at 8 timepoints T+30→T+300, for top 10 pairs + top 10 triples |
| `panelv3_4.json` | `/api/panelv3_4` | v3 Panel 4 — max_tick_drop_0_30 (worst single 5s pre-entry drop), standalone + stacked on baseline |
| `panelv3_5.json` | `/api/panelv3_5` | v3 Panel 5 — velocity × liquidity heatmap (5×4 buckets) showing opt_avg_ret per cell |
| `panelv3_6.json` | `/api/panelv3_6` | v3 Panel 6 — sum_abs_returns_0_30 (pre-entry realized vol proxy), < and > thresholds standalone + stacked on baseline |
| `panelv3_7.json` | `/api/panelv3_7` | v3 Panel 7 — regime stability + walk-forward validation for top 10 pairs + top 10 triples from v3 leaderboards. Each row has `wf_verdict` (ROBUST/DEGRADED/OVERFIT/INSUFFICIENT) and `regime_stability` (STABLE/MODERATE/CLUSTERED/INSUFFICIENT). Promote only when both are green. |

Price-path dashboard:

| File | Corresponding API | Description |
|---|---|---|
| `price-path-stats.json` | `/api/price-path-stats` | Compact price path stats: mean paths by label, Cohen's d, entry timing |
| `price-path-detail.json` | `/api/price-path-detail` | Full /price-path data: overlay (≤200 raw token paths), mean paths ±1 SD, derived metrics, acceleration histogram, entry-timing heatmap, monotonicity buckets |

Peak analysis and trading:

| File | Corresponding API | Description |
|---|---|---|
| `peak-analysis.json` | `/api/peak-analysis` | Peak CDF, peak time histogram, per-filter peak bucket, suggested TP |
| `trading.json` | `/api/trading` | Full /trading dashboard: open positions, per-strategy performance (enabled-only as of 2026-05-01), recent trades (50), skip reasons + recent skips, active strategy configs, top filter combos |
| `wallet-rep-analysis.json` | `/api/wallet-rep-analysis` | Top 20 combos × creator-wallet-rep modifiers: matrix of opt_avg_ret deltas + rep filter leaderboard ranked by mean Δ. Use to pick a creator-rep modifier that improves profitability without collapsing sample size. |
| `sniper-panel.json` | `/api/sniper-panel` | Sniper-window analytics: population coverage, baseline at own opt TP/SL, threshold sweep for `snipers <= N` and `wallet_vel_avg < N`, sniper-count + wallet-velocity histograms, top 20 best-combos rows that include a sniper filter. Added 2026-05-01. |
| `strategy-percentiles.json` | `/api/strategy-percentiles` | Per-active-strategy percentile breakdown of closed trade returns (median, p10/p25/p75/p90, std dev, min/max, exit-reason breakdown, avg execution cost in pp) for both gross and net. Plus `top_winners` + `top_losers` (top 3 each, with mint + graduation_id + held_seconds) for outlier drill-down. Sorted by median net return desc. Added 2026-05-01. **Always cross-check leaderboard means with this panel's medians before promoting.** |

Exit-strategy simulators (dynamic exits: trailing, scale-out, vol-adaptive, time-decayed TP, whale/liq-drop):

| File | Corresponding API | Description |
|---|---|---|
| `exit-sim.json` | `/api/exit-sim` | Single-universe view — evaluates all 5 dynamic-exit strategies on one filter (default: `vel<20 + top5<10%` as a fixed reference universe, NOT the current baseline). Each strategy carries `grid[]` of param permutations + `best` cell. Use to pick a dynamic exit shape for the reference universe. |
| `exit-sim-matrix.json` | `/api/exit-sim-matrix` | Top 20 combos × 5 strategies matrix — for each combo, reports `static_10_50_return_pct` (reference), `static_optimal_{return,win_rate,sl,tp}` (combo's own static opt), `leaderboard_opt_return_pct` (sanity-check vs /api/best-combos), and each strategy's `best` cell + `delta_vs_static_pp`. `best_delta_pp > 0` means dynamic exits beat the combo's own static optimum — the signal you want before promoting a filter to a live dynamic-exit strategy. |

### Pushing strategy commands (create/update/delete strategies remotely)

Claude can manage strategies without direct Railway API access by pushing a `strategy-commands.json` file to the **main branch**. The bot polls for this file every sync cycle (~2 min), applies the commands, and deletes the file.

**How to push commands:** Use `mcp__github__create_or_update_file` to write `strategy-commands.json` to the main branch, or commit it via git push.

**File format:**
```json
{
  "commands": [
    {
      "action": "upsert",
      "id": "my-strategy",
      "label": "My Strategy",
      "enabled": true,
      "params": {
        "tradeSizeSol": 0.5,
        "maxConcurrentPositions": 1,
        "entryGateMinPctT30": 5,
        "entryGateMaxPctT30": 100,
        "takeProfitPct": 50,
        "stopLossPct": 10,
        "maxHoldSeconds": 300,
        "slGapPenaltyPct": 20,
        "tpGapPenaltyPct": 10,
        "filters": [
          {"field": "bc_velocity_sol_per_min", "operator": "<", "value": 20, "label": "vel<20"},
          {"field": "top5_wallet_pct", "operator": "<", "value": 10, "label": "top5<10%"}
        ],
        "positionMonitorMode": "five_second",
        "trailingSlActivationPct": 0,
        "trailingSlDistancePct": 5,
        "slActivationDelaySec": 0,
        "trailingTpEnabled": false,
        "trailingTpDropPct": 5,
        "tightenSlAtPctTime": 0,
        "tightenSlTargetPct": 7,
        "tightenSlAtPctTime2": 0,
        "tightenSlTargetPct2": 5,
        "breakevenStopPct": 0
      }
    },
    { "action": "delete", "id": "old-strategy" },
    { "action": "toggle", "id": "some-strategy", "enabled": false }
  ]
}
```

**Actions:** `upsert` (create or update), `delete` (remove), `toggle` (enable/disable). Commands are applied in order. The file is deleted from the repo after processing.

**Latency:** Commands are picked up within ~2 minutes (next sync cycle). Check `strategies.json` on bot-status to confirm they were applied.

### Live-only endpoints (not synced to bot-status)

These endpoints are only available on the Railway deployment and are NOT synced to the `bot-status` branch. They require direct Railway access (which currently returns 403 from Claude sessions). If you need this data, ask the human operator to check the dashboard directly.

| Endpoint | Description |
|---|---|
| `GET /api/filter-catalog` | All filter definitions (`FILTER_CATALOG` in `src/api/aggregates.ts`) |
| `GET /api/graduations?limit=50&label=PUMP&vel_min=5&vel_max=20` | Filtered graduation rows |
| `GET /api/skips?limit=50` | Recent skipped candidates + reason counts |
| `GET /api/logs?level=warn&limit=500&grep=<substr>&since=<epoch_ms>` | In-process log ring buffer |
| `GET /api/bot-errors?limit=20` | Recent uncaught exceptions + unhandled rejections |

### Bug Triage Protocol → `/api/diagnose` mapping

`CLAUDE.md` Level → `/api/diagnose` field → meaning:

- **Level 1 (bot running & detecting graduations)** → `level1_bot_running` — passes if there's at least 1 graduation and `last_graduation_seconds_ago < 600`
- **Level 2 (price data captured correctly)** → `level2_price_capture` — passes if null-rate on `open_price_sol` and missing-pool rate on the last 50 rows are both < 50%
- **Level 3 (timestamps correct)** → `level3_timestamps` — passes if the last 20 complete rows have consistent `price_t30/60/120/300` checkpoints
- **Level 4 (label logic correct)** → `level4_label_logic` — passes if on 20 labeled rows the re-derived `PUMP/DUMP/STABLE` rule (PUMP = pct_t300 > 10, DUMP = < -10, else STABLE) matches every stored label

`verdict` is one of `HEALTHY`, `NO_DATA`, `LEVEL1_FAIL`, `LEVEL2_FAIL`, `LEVEL3_FAIL`, `LEVEL4_FAIL`. `next_action` is always set to the most useful next thing. Levels are checked in order — the first failure short-circuits the verdict.

### Adding new filters to the search space

If you want to test a filter not in `/api/filter-catalog`, add it to `FILTER_CATALOG` in `src/api/aggregates.ts`. The entry is `{name, group, where}` where `where` is a SQL condition that's safe to concatenate (no user input). Cross-group pairs are automatically generated by `/api/best-combos?pairs=true`. Commit and redeploy — the leaderboard picks it up on the next call.

If the filter needs a DB field that isn't on `graduation_momentum` yet, add the column in `src/db/schema.ts` (safe ALTER TABLE migration pattern already used), backfill the value from existing data where possible, and start collecting it on new rows.
