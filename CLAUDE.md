# CLAUDE.md — Mission & Operating Instructions

## MISSION

Build a profitable trading bot on post-graduation PumpFun tokens.

The open research question is:

> **Which single filter or combination of filters — from the full v2 filter search space — yields a profitable bot after all costs (gap penalties, round-trip slippage), on n ≥ 100 samples, with regime-stable edge?**

Velocity 5–20 sol/min + 10% SL / 30–50% TP is the current **best-known baseline** (+1.4% avg return, n=80). It is a floor to beat, not the goal. Any new filter or combination is fair game — single filters, pairs, triples, cross-dimension combos — as long as each candidate is evaluated against the baseline and the same rigor (sample size, regime stability, cost modeling).

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
- **vel 5-20 sol/min + T+30 gate (+5% to +100%) + 10% SL / 50% TP**: +1.4% avg return (n=80, recorded 2026-04). At n=202 the raw T+30→T+300 return is +0.57% (sim TP/SL return not yet recalculated for n=202). **+1.4% sim return is the floor to beat until recalculated.**
- vel 5-20 @ 10% SL / 30% TP: +0.8% avg return (n=80)
- vel 5-20 @ 10% SL / 75% TP: +1.0% avg return (n=80)
- BC age >10 min + vel <20 @ 10% SL: +0.8% avg return (n=103)

### Leaderboard Leaders (as of 1,964 total grads, 2026-04-12)
All results below include the T+30 entry gate (+5% to +100%) and model 10% SL / 50% TP with per-token round-trip slippage. Source: `/api/best-combos`. Regime stability now available via Panel 11 on `/filter-analysis-v2`.

**Best single filter with n ≥ 100:** No single filter currently appears in the top 20 — all are dominated by two-filter combos.

**Best combos with n ≥ 100 (beats_baseline = true):**
1. `vel < 20 + top5 < 10%` — n=111, sim +6.44%, win rate 72.1% — **regime check pending (use Panel 11)**
2. `holders >= 18 + top5 < 10%` — n=127, sim +5.68%, win rate 69.3% — **regime check pending (use Panel 11)**

**Top combos by sim return (insufficient n — watch for n=100):**
1. `vel 10-20 + buy_ratio > 0.6` — n=33, sim +8.90%, win rate 72.7% — needs ~67 more samples
2. `vel 20-50 + dd > -10%` — n=24, sim +8.67%, win rate 70.8% — new entrant; avg raw return +54% (pump-heavy)
3. `vel 10-20 + top5 < 10%` — n=51, sim +8.08%, win rate 74.5% — subset of #1 leader, higher return
4. `vel 5-20 + top5 < 10%` — n=76, sim +7.07%, win rate 75.0% — needs ~24 more samples

**Interpretation:** `vel < 20 + top5 < 10%` is the only n≥100 combo with beats_baseline=true AND the highest sim return at that sample size. `top5 < 10%` appears in 3 of the top 4 combos by sim return — it is the strongest individual signal component. The `vel 10-20` narrowing consistently outperforms `vel 5-20` when paired with `top5 < 10%` (sim +8.08% vs +7.07%), suggesting the lower velocity floor is noise. Regime checks for the two n≥100 leaders are the next required step before promoting either as the new baseline.

### Promising Leads (priority order)
1. **`vel < 20 + top5 < 10%`** (n=111, sim +6.44%): Run regime check via Panel 11. If WR StdDev < 15% → **NEW BASELINE**.
2. **`vel 5-20 + top5 < 10%`** (n=76, sim +7.07%): ~24 samples from n=100. Similar pattern to #1 — will validate or challenge it.
3. **`vel 10-20 + top5 < 10%`** (n=51, sim +8.08%): Best sim return of any top5<10% combo. ~49 samples from n=100.
4. **`vel 10-20 + buy_ratio > 0.6`** (n=33, sim +8.90%): Highest sim return in catalog. ~67 samples from n=100.
5. **`vel 20-50 + dd > -10%`** (n=24, sim +8.67%): New entrant. Raw avg return is extreme (+54%) — likely driven by outlier pumps; monitor for regime stability as n grows.
- **Regime stability**: Overall std dev 7.7% (stable); vel 5-20 at 13.9% (moderate). Panel 11 now live for regime checks on all combos.
- **Tail risk**: 18.2% of vel 5-20 trades lose >50%. The 10% SL is mandatory for any strategy.

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
| Filter | BC velocity 5-20 sol/min (operative baseline); leading candidate: vel < 20 + top5 < 10% (n=111, sim +6.44%) |
| Stop-loss | 10% from entry (with 20% adverse gap penalty modeled) |
| Take-profit | 50% from entry (with 10% adverse gap penalty modeled) |
| Round-trip costs | Per-token measured slippage, fallback 3% |
| Baseline avg return | +1.4% per trade (n=80, sim 10%SL/50%TP) — raw return at n=202 is +0.57%; sim not yet recalculated |
| Leading candidate | `vel < 20 + top5 < 10%`: sim +6.44%, n=111, win 72.1% — **pending regime check via Panel 11** |
| #2 candidate | `holders >= 18 + top5 < 10%`: sim +5.68%, n=127, win 69.3% — pending regime check |
| Best sim return (low n) | `vel 10-20 + buy_ratio > 0.6`: sim +8.90%, n=33 — needs ~67 more samples |
| Promotion bar | Beat baseline by ≥ +0.3 pp on n ≥ 100 with regime std-dev < 15% |
| Price source | PumpSwap pool ONLY (not bonding curve) |
| Execution | Research only — no live trades |
| Monthly revenue target | ~$490/month at 0.5 SOL position size (covers AI/infra costs) |

### Filter dimensions currently exposed in the search:
See `SEARCH SPACE` section above. Any dimension there is fair game; add new ones freely.

---

## SELF-SERVICE DATA ACCESS

**Rule: Claude self-serves all bot data via JSON endpoints. The human operator does NOT screenshot dashboards, query the DB, or pull Railway logs anymore.**

The bot's Express server exposes a JSON API under `/api/*`. The base URL is the Railway deployment URL (store it in `RAILWAY_URL` or `.claude/settings.json`). Hit these endpoints with `WebFetch` at the start of every session.

### Session-start protocol (do this first, every time)

1. **`GET /api/diagnose`** → confirm `verdict: "HEALTHY"`. If not, fix the reported level before doing anything else. The verdict encodes the Bug Triage Protocol below.
2. **`GET /api/snapshot`** → read counts, scorecard, data quality, last 10 graduations, last error.
3. **`GET /api/best-combos?min_n=50&top=20`** → see the current leaderboard of filters and pairs ranked by simulated 10% SL / 50% TP EV. Pick the next hypothesis from here — or propose a new filter not yet in the catalog.

Only after those three calls should you consider fetching narrower data.

### Endpoint catalogue

| Endpoint | Description |
|---|---|
| `GET /api` | Index of all `/api/*` endpoints |
| `GET /api/diagnose` | Level 1–4 bug triage verdict (see mapping below) |
| `GET /api/snapshot` | One-call dashboard summary: counts, scorecard, data quality, recent graduations, last error |
| `GET /api/best-combos?min_n=50&top=20&pairs=true` | Leaderboard of filters + cross-group pairs ranked by 10%SL/50%TP simulated avg return. `min_n` defaults 20, `top` defaults 20, `pairs=false` disables pair combos. |
| `GET /api/filter-catalog` | All filter definitions (`FILTER_CATALOG` in `src/api/aggregates.ts`) — the search space best-combos runs over |
| `GET /api/graduations?limit=50&label=PUMP&vel_min=5&vel_max=20` | Filtered graduation rows (all params optional) |
| `GET /api/trades?limit=50&status=open\|closed\|all` | Recent paper trades + stats |
| `GET /api/skips?limit=50` | Recent skipped candidates + reason counts |
| `GET /api/logs?level=warn&limit=500&grep=<substr>&since=<epoch_ms>` | In-process log ring buffer (~5000 entries, resets on redeploy) |
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
