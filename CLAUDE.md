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

## RESEARCH FINDINGS (as of n=630)

These are prior results. They are **starting knowledge**, not constraints. If newer data contradicts anything here, update the doc — don't twist the data to fit.

### Confirmed Dead (do not revisit without strong reason)
- **Raw buy-and-hold T+30 to T+300**: -6.2% avg return. Dead.
- **SL-only strategies (no TP)**: All negative EV. The asymmetry kills you — winners give +19%, losers take -59%. TP is mandatory for any strategy.
- **SOL raised filters**: All tokens graduate at ~85 SOL. No discriminating power.
- **Raw holder count filters**: No signal in isolation. All ~38% win rate regardless of threshold. (Holders may still matter as part of a combination — do not exclude from combo search.)
- **Raw top5 wallet concentration filters**: Actively negative in isolation — higher concentration = worse. (Same caveat: may have value in combos.)
- **Momentum continuation** (T+300 > T+30): Only 47%. Not a signal.

### Current Best-Known Baseline (per-combo opt framework)
- **Baseline**: rolling ALL-entry-gated population at its own grid optimum — i.e. `/api/best-combos → baseline_avg_return_pct`. Reported afresh every sync. As of the 2026-04-21 refactor it's negative (~−12% range) — the raw graduation population is unprofitable even at its best TP/SL.
- **Promotion bar**: a combo qualifies for promotion when `opt_avg_ret > baseline_avg_return_pct + 0.3 pp` on n ≥ 100 with regime std-dev < 15% (Panel 11). Positive returns are not required — beating the rolling floor is.
- **Retired 2026-04-21**: the fixed 10% SL / 50% TP ranking, the +6.44% promotion value for `vel<20 + top5<10%`, and the +1.4% vel 5-20 anchor. None of these reference points are used anymore. The fields `sim_avg_return_10sl_50tp_pct` / `sim_win_rate_10sl_50tp_pct` no longer exist on best-combos rows — use `opt_tp`, `opt_sl`, `opt_avg_ret`, `opt_win_rate`.

### Leaderboard Leaders (snapshot at 2026-04-21 refactor cutover, n~3,378 labeled)
Panel 6 `top_pairs` (which computeBestCombos now mirrors) shows these at their own opt TP/SL. These are the candidates to watch as n grows.

**Best with n ≥ 100 (all are negative — bar to beat is the rolling baseline, not zero):**
1. `top5 < 10% + dev > 5%` — n=50 (still under 100, watching) opt_tp=50, opt_sl=20, opt_avg_ret **+12.6%** — highest-return pair in the catalog; needs ~50 more samples
2. `holders >= 18 + top5 < 10%` — n=352, opt_tp=50, opt_sl=30, opt_avg_ret −0.6% (but lift +11.1 pp over single-filter optima)
3. `vel < 20 + top5 < 10%` — n=293, opt_tp=150, opt_sl=30, opt_avg_ret −1.1% (lift +8.6 pp)
4. `holders >= 15/10/5 + top5 < 10%` cluster — n=360–373, opt ~150/30, opt_avg_ret in the −0.5 to −3 pp range

**Top combos with positive opt return (insufficient n — watch):**
1. `top5 < 10% + dev > 5%` — n=50, opt @ 50/20 → **+12.6%**, 70% WR
2. `vel 20-50 + max_dd > -10%` — n=71, opt @ 100/30 → +6.4%, 54% WR
3. `bc_age > 1 day + max_dd > -10%` — n=66, opt @ 100/30 → +3.7%, 45% WR
4. `liq > 150 + vol > 60%` — n=45, opt @ 150/30 → +3.5%, 33% WR (but extremely high variance)
5. `vel 20-50 + liq > 100` — n=61, opt @ 75/30 → +2.1%, 56% WR

**Interpretation (post-refactor):** `top5 < 10%` is still the most repeated component across the top pairs, but the optimal TP/SL for it in combination is often 50/20 or 150/30 — NOT the old 10%SL/50%TP the fixed framework assumed. `dev > 5%` as a co-filter (against the grain of earlier "dev < 3%" hypotheses) keeps surfacing at the top — likely because insider-held tokens run harder when they work. Watch `top5<10% + dev>5%` toward n=100.

### Promising Leads (priority order — beat the rolling baseline on n ≥ 100 with STABLE regime)
1. **`top5 < 10% + dev > 5%`** (n=50, opt @ 50/20, +12.6%): Highest opt_avg_ret in the catalog. ~50 more samples to n=100. If it holds it's the first positive-EV combo at n≥100 since the framework changed.
2. **`vel 20-50 + max_dd > -10%`** (n=71, opt @ 100/30, +6.4%): Second-highest opt. ~29 samples from n=100.
3. **`vel 20-50 + mono > 0.5/0.66`** (n=120 each, opt @ 150/30, +1.2%): Already n≥100 but marginal vs baseline — regime-check in Panel 11 before promotion.
4. **`holders >= 18 + top5 < 10%`** (n=352, opt @ 50/30, −0.6%): Close to the baseline and the widest-n candidate — if baseline drifts lower this one clears the promotion bar without new data.
5. **Everything with `top5 < 10%` in it**: strongest repeated component. Check Panels 7 (walk-forward) + 11 (regime) before claiming an edge.
- **Regime stability**: Panel 11 remains the check for combo stability. Panel 7 walk-forward still uses the same SIM_TP_GRID / SIM_SL_GRID — an "OVERFIT" verdict on test means the opt TP/SL is train-dependent.
- **Tail risk**: SL in the 10–30% range is mandatory. `opt_sl` will tell you which level fits each combo; do not run without one.

## SEARCH SPACE

The full space Claude is free to explore (see `FILTER_PRESET_GROUPS` in `src/utils/html-renderer.ts:3050` for exact thresholds, and `/filter-analysis-v2` Panels 1–11 for current combinatorial coverage; Panel 11 = combo regime stability):

- **Velocity** (`bc_velocity_sol_per_min`): <5, 5–10, 5–20, 10–20, <20, <50, 20–50, 50–200, >200
- **BC Age** (`token_age_seconds`): <10 min, >10 min, >30 min, >1 hr, >1 day
- **Holders** (`holder_count`): ≥5, ≥10, ≥15, ≥18
- **Top 5 Wallet Concentration** (`top5_wallet_pct`): <10%, <15%, <20%, <30%, <40%
- **Liquidity at T+30** (pool SOL reserves)
- **T+30 entry gate** (PumpSwap pool price move from open)
- **Cross-dimension combos** — any pair, triple, or N-way combination of the above
- **New dimensions** — add any field already captured on `graduation_momentum` as a candidate filter; if a useful field isn't captured yet, add it to the schema and backfill

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
| Entry gate | T+30 price between +5% and +100% from open |
| Filter | No n≥100 combo currently beats the rolling baseline — searching. Watch `top5 < 10% + dev > 5%` at n=50 (opt +12.6% @ 50/20) and `vel 20-50 + max_dd > -10%` at n=71 (opt +6.4% @ 100/30). |
| Stop-loss | Per-combo `opt_sl` from `SIM_SL_GRID = [3, 4, 5, 7.5, 10, 12.5, 15, 20, 25, 30]` — no longer fixed. 30% adverse gap penalty modeled on SL fills. |
| Take-profit | Per-combo `opt_tp` from `SIM_TP_GRID = [10, 15, 20, 25, 30, 35, 40, 50, 60, 75, 100, 150]` — no longer fixed. 10% adverse gap penalty modeled on TP fills. |
| Round-trip costs | Per-token measured slippage, fallback 3% (`SIM_DEFAULT_COST_PCT`) |
| Baseline avg return | **Rolling** — published live as `baseline_avg_return_pct` in `best-combos.json`. Recomputed every 2 min against the current entry-gated labeled population at its own opt TP/SL. |
| Promotion bar | Beat `baseline_avg_return_pct` by ≥ +0.3 pp on n ≥ 100 with Panel 11 regime std-dev < 15% AND Panel 7 walk-forward NOT OVERFIT |
| Price source | PumpSwap pool ONLY (not bonding curve) |
| Execution | Research only — no live trades |
| Monthly revenue target | ~$490/month at 0.5 SOL position size (covers AI/infra costs) |

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
2. **`snapshot.json`** → read counts, scorecard, data quality, last 10 graduations, last error. Note `best_known_baseline` now carries `opt_tp_pct` / `opt_sl_pct` (per-combo) instead of fixed 10/50.
3. **`best-combos.json`** → leaderboard ranked by `opt_avg_ret` at each combo's own TP/SL optimum (mirrors Panel 6 `top_pairs`). `baseline_avg_return_pct` is the rolling entry-gated floor the top row has to beat by +0.3 pp on n≥100 to promote. Pick the next hypothesis from here.
4. **`panel11.json`** → regime stability for the top combos — check `stability` and `wr_std_dev` alongside `opt_avg_ret`.
5. **`panel3.json`** → regime stability for individual filters — useful when evaluating single-dimension signals.
6. **`price-path-stats.json`** → mean price paths by label, Cohen's d effect sizes for path features, entry timing optimization.
7. **`trades.json`** → paper trading performance: stats, by-strategy breakdown, recent trades.
8. **`exit-sim-matrix.json`** → when you have a promising combo from step 3, check here to see whether any dynamic exit strategy (momentum_reversal / scale_out / vol_adaptive / time_decayed_tp / whale_liq) beats the combo's own static optimum. A positive `best_delta_pp` is the promotion signal for a live dynamic-exit strategy.

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
| `trading.json` | `/api/trading` | Full /trading dashboard: open positions, per-strategy performance, recent trades (50), skip reasons + recent skips, active strategy configs, top filter combos |
| `wallet-rep-analysis.json` | `/api/wallet-rep-analysis` | Top 20 combos × creator-wallet-rep modifiers: matrix of opt_avg_ret deltas + rep filter leaderboard ranked by mean Δ. Use to pick a creator-rep modifier that improves profitability without collapsing sample size. |

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
