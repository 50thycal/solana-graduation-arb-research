# CLAUDE.md — Mission & Operating Instructions 

## MISSION

Build a profitable trading bot on post-graduation PumpFun tokens.

The open research question is:

> **Which single filter or combination of filters — from the full v2 filter search space — yields a profitable bot after all costs (gap penalties, round-trip slippage), on n ≥ 100 samples, with regime-stable edge?**

Velocity 5–20 sol/min + 10% SL / 30–50% TP was the old baseline (+1.4% avg return, n=80). **The current baseline is `vel < 20 + top5 < 10%` — promoted at sim +6.44% (n=111, STABLE regime, 2026-04-12); live sim return drifts as data grows, check `/api/best-combos` for the current value.** Any new filter or combination is fair game — single filters, pairs, triples, cross-dimension combos — as long as each candidate is evaluated against the baseline and the same rigor (sample size, regime stability, cost modeling).

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

### Current Best-Known Baseline
- **`vel < 20 + top5 < 10%` + T+30 gate (+5% to +100%) + 10% SL / 50% TP**: sim **+6.44%** avg return at promotion (n=111, win rate 72.1%), regime **STABLE** (WR StdDev < 8). Promoted 2026-04-12. **This is the floor to beat.**
- **Note on sim return drift**: The recorded +6.44% was the value at the moment of promotion. As more data accumulates, the live sim return will drift (up or down) — this is expected and not a bug. `snapshot.json` always shows the live value from the leaderboard. Use the promotion value (+6.44%, n=111) as the historical anchor for CLAUDE.md; the live `/api/best-combos` value is what matters for current decisions.
- Former baseline: vel 5-20 @ 10% SL / 50% TP: +1.4% avg return (n=80, 2026-04). Retired.
- Former baseline sim returns for reference: vel 5-20 @ 30% TP: +0.8%; vel 5-20 @ 75% TP: +1.0%; BC age >10min + vel<20 @ 10%SL: +0.8% (n=103)

### Leaderboard Leaders (as of 1,964 total grads, 2026-04-12)
All results below include the T+30 entry gate (+5% to +100%) and model 10% SL / 50% TP with per-token round-trip slippage. Source: `/api/best-combos`. Regime stability now available via Panel 11 on `/filter-analysis-v2`.

**Best single filter with n ≥ 100:** No single filter currently appears in the top 20 — all are dominated by two-filter combos.

**Best combos with n ≥ 100:**
1. `vel < 20 + top5 < 10%` — n=111, sim +6.44%, win rate 72.1% — **STABLE regime — CURRENT BASELINE (promoted 2026-04-12)**
2. `holders >= 18 + top5 < 10%` — n=127, sim +5.68%, win rate 69.3% — **regime check pending (use Panel 11)**

**Top combos by sim return (insufficient n — watch for n=100):**
1. `vel 10-20 + buy_ratio > 0.6` — n=33, sim +8.90%, win rate 72.7% — needs ~67 more samples
2. `vel 20-50 + dd > -10%` — n=24, sim +8.67%, win rate 70.8% — new entrant; avg raw return +54% (pump-heavy)
3. `vel 10-20 + top5 < 10%` — n=51, sim +8.08%, win rate 74.5% — subset of #1 leader, higher return
4. `vel 5-20 + top5 < 10%` — n=76, sim +7.07%, win rate 75.0% — needs ~24 more samples

**Interpretation:** `vel < 20 + top5 < 10%` is the only n≥100 combo with beats_baseline=true AND the highest sim return at that sample size. `top5 < 10%` appears in 3 of the top 4 combos by sim return — it is the strongest individual signal component. The `vel 10-20` narrowing consistently outperforms `vel 5-20` when paired with `top5 < 10%` (sim +8.08% vs +7.07%), suggesting the lower velocity floor is noise. Regime checks for the two n≥100 leaders are the next required step before promoting either as the new baseline.

### Promising Leads (priority order — beat +6.44% on n ≥ 100 with STABLE regime)
1. **`vel 10-20 + top5 < 10%`** (n=51, sim +8.08%): Best sim return of the top5<10% family. ~49 samples from n=100. If it holds, it supersedes the new baseline.
2. **`vel 5-20 + top5 < 10%`** (n=76, sim +7.07%): ~24 samples from n=100. Should validate or refine #1 above.
3. **`vel 10-20 + buy_ratio > 0.6`** (n=33, sim +8.90%): Highest sim return in catalog. ~67 samples from n=100.
4. **`vel 20-50 + dd > -10%`** (n=24, sim +8.67%): Extreme raw return (+54%) suggests pump-outlier bias; monitor as n grows.
5. **`holders >= 18 + top5 < 10%`** (n=127, sim +5.68%): Already at n≥100. Regime check via Panel 11 — if STABLE, compare against new baseline.
- **Regime stability**: Panel 11 now live on `/filter-analysis-v2` — use it for regime checks. New baseline `vel < 20 + top5 < 10%` confirmed STABLE (WR StdDev < 8).
- **Tail risk**: 10% SL is mandatory for any strategy. Do not run without it.

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
- Avg return beats current baseline by at least +0.3 percentage points after all costs (gap penalties + round-trip slippage)
- Regime std-dev < 15% across available time windows
- `/api/diagnose` returns `HEALTHY`
- Output: "NEW BASELINE — `<filter spec>` beats `<old baseline>` by `<delta>` on n=`<n>`. Updating CLAUDE.md baseline section and promoting in `/api/best-combos`."

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
| Filter | `vel < 20 + top5 < 10%` — **CURRENT BASELINE** (promoted 2026-04-12) |
| Stop-loss | 10% from entry (with 20% adverse gap penalty modeled) |
| Take-profit | 50% from entry (with 10% adverse gap penalty modeled) |
| Round-trip costs | Per-token measured slippage, fallback 3% |
| Baseline avg return | **+6.44%** per trade sim (n=111, 10%SL/50%TP, STABLE regime) — replaces +1.4% (vel 5-20, n=80) |
| Next candidates | `vel 10-20 + top5 < 10%` sim +8.08% (n=51); `vel 10-20 + buy_ratio > 0.6` sim +8.90% (n=33) |
| Promotion bar | Beat **+6.44%** by ≥ +0.3 pp on n ≥ 100 with regime std-dev < 15% |
| Price source | PumpSwap pool ONLY (not bonding curve) |
| Execution | Research only — no live trades |
| Monthly revenue target | ~$490/month at 0.5 SOL position size (covers AI/infra costs) |

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
2. **`snapshot.json`** → read counts, scorecard, data quality, last 10 graduations, last error.
3. **`best-combos.json`** → leaderboard ranked by sim return. Pick the next hypothesis.
4. **`panel11.json`** → regime stability for the top combos — check `stability` and `wr_std_dev` alongside sim return.
5. **`panel3.json`** → regime stability for individual filters — useful when evaluating single-dimension signals.
6. **`price-path-stats.json`** → mean price paths by label, Cohen's d effect sizes for path features, entry timing optimization.
7. **`trades.json`** → paper trading performance: stats, by-strategy breakdown, recent trades.

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
- **`wallet-rep-analysis.json`** — top 20 combos × creator-wallet-rep modifiers (clean_dev, fresh_dev, repeat_dev_3plus, profitable_dev, not_rapid_fire, …). Each cell = sim-return delta in pp with n retention; `summary[]` ranks rep filters by mean Δ. Use after a combo is identified in `/api/best-combos` to see whether a creator-rep overlay improves profitability enough to justify the sample-size hit.

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
| `wallet-rep-analysis.json` | `/api/wallet-rep-analysis` | Top 20 combos × creator-wallet-rep modifiers: matrix of sim-return deltas + rep filter leaderboard ranked by mean Δ. Use to pick a creator-rep modifier that improves profitability without collapsing sample size. |

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
