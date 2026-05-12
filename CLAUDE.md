# CLAUDE.md — Mission & Operating Instructions

> **This doc is process-only.** All numbers — leaderboard, baselines, "currently best" combos, "promising leads" — live in the `bot-status` JSON files, not here. If you find yourself reading numbers in CLAUDE.md, read those files instead. The doc tells you *how* to run the loop; the data tells you *what* to do this cycle.

## MISSION

Build a profitable trading bot on post-graduation PumpFun tokens.

The open research question:

> Which single filter or combination of filters from the v2 search space yields a strategy that **accumulates SOL** after all costs (gap penalties, round-trip slippage), on n ≥ 100 trades, with regime-stable edge, and with the apparent profit not driven by 1–3 lottery-ticket trades?

The bot is free to hypothesize, test, and adopt new filters without asking permission. Beat the bar (defined below), survive regime checks, and never claim victory on small n or on outlier-driven means.

The human operator is the code-review and deploy loop — they don't write code, screenshot dashboards, or query the database. Claude self-serves all data via the `bot-status` branch.

---

## WHERE STATE LIVES (READ THIS FIRST)

| Question | File on `bot-status` |
|---|---|
| What's the current leaderboard? | `best-combos.json` |
| Which strategies are running, what params? | `strategies.json` |
| What did paper/shadow trading do recently? | `trades.json`, `trading.json` |
| Which strategies are closest to clearing the bar? | `report.json → today_auto.promotion_readiness_all` (or `_top5` for the trimmed view) |
| What's each strategy's day-over-day score trend? | `report.json → recent_reports[i].summary.by_strategy_daily` (per-strategy snapshot per day) |
| What changed in the strategy roster since yesterday? | `report.json → roster_diff_vs_yesterday` |
| What does each strategy's outlier-stripped P&L look like? | `leave-one-out-pnl.json` |
| Cross-session memory — what did yesterday's session decide? | `report.json` |
| Is the bot healthy? | `diagnose.json` |

The pattern: every cycle, read those files first. Form a hypothesis from the data they contain. CLAUDE.md only tells you the rules of the game — the data tells you what to do.

---

## HOW TO EVALUATE A CANDIDATE (IN PRIORITY ORDER)

When considering whether to promote, kill, or keep a strategy, evaluate in this order. Each item is more important than the next.

0. **Composite readiness score (0–100) — the headline metric.** `report.json → today_auto.promotion_readiness_all` ranks every enabled strategy on one number that consolidates items 1–4 below: sample_size (20) + drop_top3_pnl (30) + total_net_sol (20) + monthly_run_rate (20) + win_rate_sanity (10). The component breakdown is in each row's `components` object — consult those only to explain WHY a score is high or low, not as separate primary signals. Headline / "By Strategy" panel on /report and the /daily-report skill both lead with this score.
1. **Net SOL accumulated** (after measured costs). The bot's purpose is making SOL — this is the primary monetary metric and the heaviest single contributor to the composite. Look at `total_net_sol` in `leave-one-out-pnl.json`.
2. **Outlier robustness — drop top 1 / top 3 winners.** If `total_net_sol_drop_top3 ≤ 0`, you don't have edge, you have 1–3 lottery tickets. Reported per-strategy in `leave-one-out-pnl.json`. This is the *real* outlier check; median is a noisy proxy for it.
3. **Monthly run rate ≥ 3.75 SOL** (≈ $300/month at current SOL price). `monthly_run_rate_sol` in `leave-one-out-pnl.json`. A strategy that takes 3 months to earn 0.5 SOL clears the absolute floor but doesn't pay the bills.
4. **Win rate** as a distribution-shape sanity check, not a kill criterion. High WR + losing money = tail problem; low WR + winning = cluster risk. Don't kill a fat-tail strategy just because WR is 35%.
5. **Mean + trimmed mean** (drop top/bottom 5%) per trade. `trimmed_mean_net_pct` in `leave-one-out-pnl.json`. If the trimmed mean diverges from the raw mean by a lot, the trade-level distribution is fat-tailed — confirm with leave-one-out before trusting it.
6. **Sample size + regime stability + walk-forward.** n ≥ 100, Panel 11 regime std-dev < 15%, Panel 7 verdict NOT OVERFIT. These are the "is the edge real" gates.
7. **Median is a diagnostic, not a kill criterion.** A negative median + positive `total_net_sol_drop_top3` is a legitimate fat-tail strategy. Memecoins are definitionally fat-tailed; demanding a positive median over-indexes on a single past bug (graduation 18481, +700% / 5s-poll discretization). The right outlier check is leave-one-out, not median tracking.

---

## PROMOTION BAR

A strategy is **promotable** when ALL of these clear:

| Gate | Source |
|---|---|
| `n_trades ≥ 100` | `leave-one-out-pnl.json → rows[].n_trades` |
| `total_net_sol_drop_top3 > 0` | same file |
| `total_net_sol ≥ 0.5` | same file |
| `monthly_run_rate_sol ≥ 3.75` | same file |
| Panel 7 walk-forward NOT OVERFIT | `panel7.json` |
| Panel 11 regime std-dev < 15% | `panel11.json` |

The first four are computed and ranked in `report.json → today_auto.promotion_readiness_all` with a 0–100 composite score and per-component breakdown. `_top5` is the same list truncated for narrative use. Read `_all` at session start.

The old "+0.3 pp lift over baseline" framing has been retired. Absolute net-SOL accumulation replaces relative-edge-vs-baseline because (a) it maps to actual money, and (b) the rolling baseline + per-combo TP/SL grid was making "lift" a moving target.

**Recommendations are proposals, never executed actions.** The `/daily-report` skill writes `report-upsert` + `action-item-update` only — it never adds, removes, or toggles strategies. Strategy roster changes require explicit operator approval via a separate `strategy-commands.json` push containing `upsert` / `delete` / `toggle`. Recommendations in `report.json → today_report.recommendations` should always read as future-tense proposals ("recommend killing X"), not as past-tense reports of executed work ("killed X"). The 2026-05-12 v17/v18 narrative confusion came from past-tense phrasing — don't repeat. The "Strategy Roster Changes Since Yesterday" panel on /report is the authoritative view of what actually changed.

---

## CANDIDATE OUTCOMES

Every candidate ends as one of:

- **PROMOTABLE.** All 4 gates clear + regime stable + walk-forward NOT OVERFIT. Action: promote to live (or write a new shadow strategy + journal entry if not yet shadow). Update `report.json` with a journal-upsert + report-upsert.
- **INVALID.** n ≥ 100 and at least one hard gate fails (drop_top3 ≤ 0, total < 0.5, or monthly < 3.75), OR regime std-dev ≥ 15%, OR walk-forward verdict OVERFIT. Action: kill via `strategy-commands.json` delete, document in the daily report.
- **WATCH.** n < 100 but trending toward the bar. Action: keep, log target n + kill criterion via journal-upsert.
- **BLOCKED.** Data quality issue persists after 3+ fix cycles on the same Level 1–4 bug, OR schema is missing a field needed to test the candidate. Action: document the blocker in the daily report's `recommendations` block.

Never declare victory on n < 100. Never keep an INVALID candidate running.

---

## SEARCH SPACE

Free to explore (see `FILTER_PRESET_GROUPS` in `src/utils/html-renderer.ts:3050` and `FILTER_CATALOG` in `src/api/aggregates.ts` for live thresholds):

- **Velocity** (`bc_velocity_sol_per_min`): <5, 5–10, 5–20, 10–20, <20, <50, 20–50, 50–200, >200
- **BC Age** (`token_age_seconds`): <10 min, >10 min, >30 min, >1 hr, >1 day
- **Holders** (`holder_count`): ≥5, ≥10, ≥15, ≥18
- **Top 5 wallet concentration** (`top5_wallet_pct`): <10%, <15%, <20%, <30%, <40%
- **Dev wallet** (`dev_wallet_pct`): <3%, <5%
- **Liquidity at T+30** (`liquidity_sol_t30`): >50, >100, >150
- **Path shape (0–30s window)**: monotonicity, max_drawdown_0_30, sum_abs_returns_0_30, acceleration_t30
- **Buy pressure** (computed at T+35): `buy_pressure_unique_buyers`, `buy_pressure_buy_ratio`, `buy_pressure_whale_pct`
- **Snipers** (`sniper_count_t0_t2`, T+35): ≤2, ≤5, >5, >10
- **Sniper wallet velocity** (`sniper_wallet_velocity_avg`, T+35): <5, <10, <20, ≥20 (avg # of EARLIER graduations these snipers also sniped — PRIOR-only)
- **Creator reputation** (`creator_prior_*`): fresh_dev, repeat_dev≥3, clean_dev, serial_rugger, rapid_fire
- **Cross-dimension combos** — any pair, triple, or N-way combination
- **New dimensions** — add any field on `graduation_momentum`; if a useful field isn't captured, add it to the schema and backfill

**Look-ahead leak rule (permanent guardrail):** never add a `where` clause that references a column with a `_t300`, `_t600`, `_0_300`, `_0_600`, `max_relret_*`, or any other field whose value is only known AFTER T+30. Those columns may exist for backwards-looking research (e.g. `exit-sim.ts` uses `liquidity_sol_t300` for whale-sell exit simulation) but they MUST NOT appear in `FILTER_CATALOG`. The `liq_t300 / liq_retained` look-ahead bias bug (fixed 2026-05-01) inflated an apparent +36% baseline to a tautology — don't repeat.

---

## THE ITERATION LOOP

Each cycle follows this exact pattern:

1. **Fetch live state** via `report.json`, `diagnose.json`, `best-combos.json`, `leave-one-out-pnl.json` (see `## SELF-SERVICE DATA ACCESS`). No human screenshots.
2. **Pick the next hypothesis** — a filter or combo to test, a strategy to promote, a strategy to kill, a bug to fix — based on `report.json → today_auto.promotion_readiness_top5` and the diagnose verdict, not on what a previous session said.
3. **Push a code update** (new filter, new panel, bug fix, schema addition) OR **push a strategy command** (`strategy-commands.json` upsert/delete/toggle).
4. **Bot redeploys / picks up the command and collects data.**
5. **Next cycle starts at step 1.**

Never skip straight to "the new signal is working" without checking the diagnose verdict first. Assume bugs exist until `diagnose.json` says `HEALTHY`.

---

## YOUR ROLE AS CODING AGENT

Responsible for:

1. Writing and updating bot code
2. Maintaining the dashboard JSON files so a future Claude session can read state at a glance
3. Diagnosing bugs from the JSON output alone
4. Keeping the bot focused on the thesis — do not drift
5. Declaring an outcome (PROMOTABLE / INVALID / WATCH / BLOCKED) when the data is sufficient

NOT responsible for:
- Running the bot (human does that)
- Trading execution (research + paper + shadow only until a strategy clears the bar)

---

## BUG TRIAGE PROTOCOL

When `diagnose.json` is not HEALTHY, diagnose in order. Fix bugs in order — do not skip levels.

- **Level 1** — Is the bot running and detecting graduations? If no graduations in 10+ min: connection/subscription bug.
- **Level 2** — Is price data being captured correctly? Check price source flag, nulls. PumpSwap pool price ONLY, never bonding curve.
- **Level 3** — Are timestamps correct? T+300s relative to graduation detection, not wall clock.
- **Level 4** — Is the label logic correct? PUMP = >+10% at T+300s from open, DUMP = <-10%, else STABLE.
- **Level 5** — Only after Levels 1–4 are clean: is the signal real or noise?

### Level → `/api/diagnose` mapping

`diagnose.json → verdict` is one of: `HEALTHY`, `NO_DATA`, `LEVEL1_FAIL`, `LEVEL2_FAIL`, `LEVEL3_FAIL`, `LEVEL4_FAIL`. The first failing level short-circuits the verdict. `next_action` is always set to the most useful next thing.

- **Level 1** → `level1_bot_running` — passes if there's at least 1 graduation and `last_graduation_seconds_ago < 600`.
- **Level 2** → `level2_price_capture` — passes if null-rate on `open_price_sol` and missing-pool rate on the last 50 rows are both < 50%.
- **Level 3** → `level3_timestamps` — passes if the last 20 complete rows have consistent `price_t30/60/120/300` checkpoints.
- **Level 4** → `level4_label_logic` — passes if on 20 labeled rows the re-derived PUMP/DUMP/STABLE rule matches every stored label.

---

## OPERATIONAL CONSTANTS (rare changes)

These are the few stable parameters that aren't in any JSON file. Everything else (TP, SL, gates, filters, gap penalties) is per-strategy and lives in `strategies.json` or per-combo in `best-combos.json`.

- **Entry timing**: T+30 post-graduation on PumpSwap pool.
- **Price source**: PumpSwap pool ONLY (never bonding curve).
- **Position monitor**: `five_second` (`src/trading/position-manager.ts`). 5s polling can over-collect on fast pumps via discretization (see graduation 18481's +700% trade) — known limitation, mainly affects shadow stats not live execution math. Use leave-one-out to detect.
- **Simulator constants**: `SIM_TP_GRID`, `SIM_SL_GRID`, `SIM_DEFAULT_COST_PCT`, gap penalties — exported from `src/api/sim-constants.ts`. Changes propagate everywhere — do not re-hardcode in new code paths.
- **Entry gate split**: research uses `pct_t30 >= 5 AND pct_t30 <= 100` (`src/api/aggregates.ts`); trading default is `-99..1000` (`src/trading/config.ts`). Asymmetry is intentional — wider research gate deadlocked the heavy-cache recompute. Promotion-bar comparisons are approximate; call out in writeups.
- **Monthly target**: ~3.75 SOL net per month per live strategy — covers AI/infra costs (~$300/month).

---

## SELF-SERVICE DATA ACCESS

**Rule:** Claude self-serves all bot data via the `bot-status` branch on GitHub. The human operator does NOT screenshot dashboards, query the DB, or pull Railway logs.

**Do NOT use `WebFetch` against the Railway deployment URL — it returns 403.** Read data from the `bot-status` branch, which the bot pushes every ~2 minutes. Two methods (prefer GitHub MCP, fall back to raw URL):

### Method 1: GitHub MCP tool (preferred)
Use `mcp__github__get_file_contents` with `owner=50thycal`, `repo=solana-graduation-arb-research`, `ref=refs/heads/bot-status`, and `path=<filename>.json`. Pipe through `python3` for large files (see workaround below).

### Method 2: raw.githubusercontent.com (fallback)
Use `WebFetch` against `https://raw.githubusercontent.com/50thycal/solana-graduation-arb-research/refs/heads/bot-status/<file>.json`. Note: WebFetch summarizes large responses — use Method 1 for full fidelity.

### Session-start protocol (do this every time, in order)

1. **`diagnose.json`** → confirm `verdict: "HEALTHY"`. If not, fix the reported level before doing anything else.
2. **`report.json`** → cross-session memory. Read `today_auto.promotion_readiness_top5` first (top 5 closest-to-bar with composite scores), then `today_report.recommendations`, `open_action_items`, and `lessons[]`. Tells you what was proposed yesterday, what was acted on, and persistent institutional memory.
3. **`leave-one-out-pnl.json`** → outlier-robust per-strategy P&L: `total_net_sol`, `total_net_sol_drop_top1/3`, `monthly_run_rate_sol`, trimmed mean. Use as the canonical evaluation source — never call a strategy "winning" without checking drop_top3 here.
4. **`snapshot.json`** → counts, scorecard, data quality, recent graduations, last error.
5. **`best-combos.json`** → leaderboard ranked by `opt_avg_ret` at each combo's own TP/SL optimum. `baseline_avg_return_pct` is the rolling entry-gated floor (informational; the live promotion bar is in leave-one-out-pnl.json).
6. **`strategy-percentiles.json`** → per-strategy median / p10 / p25 / p75 / p90 / std dev / min / max + `top_winners` and `top_losers` (top 3 each, with mint + graduation_id). Diagnostic — surfaces the *shape* of the return distribution.
7. **`panel11.json`** / **`panel3.json`** → regime stability (combos and singles, respectively).
8. **`panel7.json`** → walk-forward verdict (ROBUST / DEGRADED / OVERFIT).
9. **`trades.json`** → paper + shadow trading: stats, by-strategy breakdown, recent trades.
10. **`exit-sim-matrix.json`** → for a promising combo from step 5, see whether any dynamic exit strategy beats the combo's static optimum. `best_delta_pp > 0` = signal.

### Drill-down files (consult on specific questions)

- **`panel1.json` / `panel2.json` / `panel5.json`** — single-feature comparison + return percentiles + Wilson CI / bootstrap significance.
- **`panel4.json`** — TP/SL EV simulator with 12×10 grid + T+60/T+120 hold variants.
- **`panel6.json`** — auto-scanned top pairs leaderboard (1378 two-way combos).
- **`panel8.json`** — loss tail & risk metrics (CVaR, worst trade, max consecutive losses).
- **`panel9.json`** — equity curve & drawdown simulation.
- **`panel10.json`** — DPM optimizer: per-filter optimum + top 10 runners-up.
- **`panelv3_*`** — v3 crash-prediction research panels (rug-exclusion, max_dd, sum_abs_returns, three-filter combos).
- **`price-path-stats.json` / `price-path-detail.json`** — mean paths by label, Cohen's d, entry-timing heatmap, raw overlay (≤200 paths).
- **`peak-analysis.json`** — peak CDF, peak time histogram, suggested TP per filter.
- **`trading.json`** — full /trading dashboard: open positions, per-strategy performance, recent trades + skips.
- **`wallet-rep-analysis.json`** — top 20 combos × creator-rep modifiers (clean_dev, fresh_dev, serial_rugger, …).
- **`sniper-panel.json`** — sniper threshold sweeps + histograms.
- **`exit-sim.json`** — single-universe dynamic-exit simulator (5 strategies: momentum_reversal / scale_out / vol_adaptive / time_decayed_tp / whale_liq).
- **`entry-time-matrix.json`** — single filters + combos × 6 entry checkpoints (T+30 → T+240). `best_entry_sec` + `delta_vs_t30_pp`.
- **`journal.json`** — strategy hypothesis + prediction + auto_status (OPEN / ON-TRACK / DEGRADING / HIT-KILL / NO-DATA / PROMOTED / KILLED / PAUSED).
- **`edge-decay.json`** — per-strategy rolling mean+median windows + 12-bin sparkline + DECAYING / STRENGTHENING / STABLE flag.
- **`counterfactual.json`** — per-strategy filter contribution + TP/SL grid sweep.
- **`loss-postmortem.json`** — worst-20 closed trades clustered by entry-time feature deviation.

### Example: reading data via GitHub MCP + python3

```
# 1. Fetch via MCP
mcp__github__get_file_contents(owner=50thycal, repo=solana-graduation-arb-research,
    path=leave-one-out-pnl.json, ref=refs/heads/bot-status)

# 2. Parse the MCP response (it wraps content in [{type, text}] array)
python3 -c "
import json
with open('<temp_file_path>') as f:
    raw = json.load(f)
text = raw[1]['text']
data = json.loads(text[text.find('{'):])
# Top 10 by monthly run rate, enabled only
rows = [r for r in data['rows'] if r['enabled']]
rows.sort(key=lambda r: r['monthly_run_rate_sol'], reverse=True)
for r in rows[:10]:
    print(f\"{r['label']:30s} n={r['n_trades']:4d} total={r['total_net_sol']:+.3f} drop3={r['total_net_sol_drop_top3']:+.3f} monthly={r['monthly_run_rate_sol']:+.2f}\")
"
```

### Large-file workaround (trades.json, panel4.json, panel9.json, panel10.json, price-path-detail.json, trading.json)

When the MCP tool says `"Error: result (N characters) exceeds maximum allowed tokens. Output has been saved to <path>.txt"`, do NOT try to `Read()` the file directly — it will also exceed the limit. Use Bash + python3 to extract only what you need:

```bash
python3 -c "
import json
with open('<path_from_error_message>.txt') as f:
    raw = json.load(f)
text = raw[1]['text']
data = json.loads(text[text.find('{'):])
print('Stats:', json.dumps(data['stats'], indent=2))
"
```

Some files (notably `panel4.json` ~1.2MB+) are large enough that MCP returns a `raw.githubusercontent.com` URL instead of saving locally. Fetch with `curl` (NOT WebFetch — it summarizes), then parse with python3:

```bash
curl -sL "https://raw.githubusercontent.com/50thycal/solana-graduation-arb-research/refs/heads/bot-status/panel4.json" -o /tmp/panel4.json
python3 -c "
import json
with open('/tmp/panel4.json') as f: data = json.load(f)
# Pull only the cells you need — iterating all 120 cells × 59 filters is what blew the inline limit
"
```

### Pushing strategy commands

Claude manages strategies via `strategy-commands.json` on the **main branch**. The bot polls every sync cycle (~2 min), applies commands, and deletes the file. Use `mcp__github__create_or_update_file` to push.

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
    { "action": "toggle", "id": "some-strategy", "enabled": false },
    {
      "action": "journal-upsert",
      "id": "v15-vel-dev-tight",
      "strategy_id": "v15-vel-dev-tight",
      "cohort_label": "v15",
      "hypothesis": "vel<5 + dev<3% should accumulate >= 0.5 SOL with drop_top3 > 0 on n>=125.",
      "prediction": {
        "target_n": 125,
        "target_days": 14,
        "kill_criterion": "n>=50 and median<-5"
      },
      "status": "OPEN"
    },
    { "action": "journal-update", "id": "v15-vel-dev-tight", "note": "n=42 after 5 days — pacing fine." },
    { "action": "journal-delete", "id": "v9-stale-entry" }
  ]
}
```

**Strategy actions:** `upsert`, `delete`, `toggle`. Applied in order.

**Journal actions** — `journal-upsert` (create or replace by `id`), `journal-update` (append a `note`), `journal-delete`. Required: `id`, `strategy_id`, `hypothesis` for upsert; `id` + `note` for update; `id` for delete. `prediction.kill_criterion` recognized forms: `"n>=N and median<X"`, `"median<X"`, `"win_rate<X"`. Other forms parse as text and never trip HIT-KILL automatically.

**Daily-report actions** — `report-upsert`, `report-append`, `action-item-update` (status: PROPOSED / EXECUTED / DEFERRED / REJECTED), `lesson-upsert`, `lesson-archive`. The routine `/daily-report` slash command does the analysis + push for you on a daily cadence.

**Latency:** ~2 minutes (next sync cycle). Confirm via `strategies.json` / `journal.json` / `report.json` on bot-status. Per-batch outcomes are also in `command-results.json`.

### Live-only endpoints (NOT synced to bot-status)

These require direct Railway access (currently 403 from Claude sessions). If you need this data, ask the human operator.

| Endpoint | Description |
|---|---|
| `GET /api/filter-catalog` | All filter definitions (`FILTER_CATALOG` in `src/api/aggregates.ts`) |
| `GET /api/graduations?limit=50&label=PUMP&vel_min=5&vel_max=20` | Filtered graduation rows |
| `GET /api/skips?limit=50` | Recent skipped candidates + reason counts |
| `GET /api/logs?level=warn&limit=500&grep=<substr>&since=<epoch_ms>` | In-process log ring buffer |
| `GET /api/bot-errors?limit=20` | Recent uncaught exceptions + unhandled rejections |

---

## ADDING NEW FILTERS

If you want to test a filter not in `/api/filter-catalog`, add it to `FILTER_CATALOG` in `src/api/aggregates.ts`. Entry shape: `{name, group, where}` where `where` is a SQL condition that's safe to concatenate (no user input). Cross-group pairs are auto-generated by `/api/best-combos?pairs=true`. Commit and redeploy — the leaderboard picks it up on the next call.

If the filter needs a DB field that isn't on `graduation_momentum` yet, add the column in `src/db/schema.ts` (safe ALTER TABLE migration pattern), backfill where possible, and start collecting it on new rows.

Never add a `where` clause referencing a post-T+30 column — see the look-ahead leak rule in the SEARCH SPACE section.
