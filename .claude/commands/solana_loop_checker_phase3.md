---
description: Phase-3 copy-trading monitor loop — one iteration of the recurring 8h advisory check. Reports all active strategies + data-collection/execution health, tracks a carried-forward Updates & Ideas ledger, and separates each loop with a large banner. READ-ONLY (proposes, never acts). Times in CDT.
---

# /solana_loop_checker_phase3 — copy-strategy monitor loop (Phase 3)

The recurring **advisory** monitor for the copy-trading subsystem. One invocation = one loop iteration.
Driven on an 8h cadence by a durable Routine (Claude-Code-Remote trigger, `cron 7 */8 * * *`) that fires
into the operator's ongoing session; also runnable on demand with `/solana_loop_checker_phase3`.

> **HARD GUARDRAIL — READ-ONLY.** This loop OBSERVES and PROPOSES only. Never edit code, push, open/modify
> PRs, run ops DB writes, or enact any roster/execution change. The operator acts separately with **Fable 5**.
> If something is urgent, write it as a ledger item — do not act on it here. Phrase everything in proposal voice.

> **Always report time in CDT.** Convert every timestamp to US Central. In python:
> `from zoneinfo import ZoneInfo; import datetime; datetime.datetime.now(ZoneInfo("America/Chicago")).strftime("%Y-%m-%d %I:%M %p %Z")`
> (`%Z` renders `CDT`/`CST` automatically — it will read `CDT` in summer.)

---

## STEP 0 — Banner + carry-forward check

**Emit a large banner first** so each loop is visually separated in the transcript. Print exactly this shape
(80-wide, three solid rows of `#` above and below a centered title line), filling in the loop number and the
current CDT time:

```
################################################################################
################################################################################
################################################################################
                  COPY-LOOP #<N>   ·   <YYYY-MM-DD  hh:mm AM/PM CDT>
################################################################################
################################################################################
################################################################################
```

`<N>` = previous loop number + 1 (carried in the ledger; start at 1 if none found).

Then **CARRY-FORWARD CHECK**: find the "Updates & Ideas ledger" from the previous COPY-LOOP report (most recent
prior loop message; if absent, rebuild from conversation context). Re-evaluate every open item against the fresh
data below and mark each **STILL-VALID / UPDATED (evidence moved) / RESOLVED / DROPPED**, noting what changed
since the last loop.

## STEP 1 — Fetch

Use `curl -sL` (NOT WebFetch — it summarizes) and parse with `python3`. From the `bot-status` branch raw URLs:
`copy-trades.json`, `diagnose.json`, `copy-probe.json`.
(`https://raw.githubusercontent.com/50thycal/solana-graduation-arb-research/refs/heads/bot-status/<file>.json`)

## STEP 2 — Run the checks

**A) ALL ACTIVE STRATEGIES** — compact table from `promotion.rows` + `experiment_arena.rows`:
id · role · n · net · drop3 · stress · monthly · promo_score · net/trade · drop3/trade · arena verdict.
Always include `copy-fable-freshdip`. Note day-over-day deltas vs the previous loop where visible.

**B) DATA-COLLECTION ISSUES** — one line each, then a verdict:
- `diagnose.verdict == HEALTHY`, `ws_connected`, `last_graduation_sec_ago` (<300 good), `last_candidate_sec_ago` (<300 good)
- `copy-trades` `generated_at` freshness (<~10 min = sync loop alive)
- `copy-probe`: `watchlist_size`, last-event freshness, `parsed_ws > 0` (lead detection alive)
- `rpc_usage`: est credits/30d + `warming_up` flag (flag if trending toward a ceiling)
- `wallet_discovery`: scored + promotable counts moving; `discovery_scorecard` funnels (candidates→scored→smart_copyable) + verdicts
- Flag anything stale or zero-that-should-be-nonzero; else one "all nominal" line.

**C) EXECUTION ISSUES** — for each active strategy confirm entries are both **opening AND closing**
(`open_positions` sane, `by_exit_reason` populating), `entry_drift` within its gate, and the `gate_skips` funnel
looks sane (no single reason unexpectedly starving a strategy; `drift`/`raced`/`price_fail`/`rpc_drop` not spiking).
If any `live_micro` strategy exists, check `live_execution` land-rate / rent-fail / slippage; if none, note
"no live execution — shadow only."

**D) HOW STRATEGIES ARE DOING** — who is promotable, who is the leading challenger and why, who is a lottery
(net-positive but drop3-negative), the trend vs prior loops, and where `copy-fable-freshdip` sits toward n≥100.

## STEP 3 — Updates & Ideas ledger

Carry it forward from Step 0 and **RE-EMIT IN FULL every loop** so the newest copy always lives in the latest
message. Each item:

`[ID] STATUS(NEW/STILL-VALID/UPDATED/RESOLVED/DROPPED) · idea/change to the overall system · the data trigger/threshold that makes it actionable · latest supporting datapoint`

Add new ideas the patterns surface; retire stale ones. These are **PROPOSALS ONLY** for a later Fable 5 session —
do not act on any of them here. Keep the whole report skimmable (tables + short bullets, not prose). End the turn
after emitting the report; the next loop fires in ~8h.

---

### Reference — the promotion bar (what "doing well" means)
A strategy is PROMOTABLE only when ALL clear (computed in `copy-trades.json → promotion`): realistic execution
(`entryDelaySec`) · n≥100 · `drop_top3 > 0` · `exit_stress > 0` · `monthly_run_rate ≥ 3.75` SOL. Idealized 1:1
mirrors (no lag) are upper bounds only, capped at score 80 — never live candidates. Don't call a
realistic strategy promotable OR dead before n≥100 unless catastrophic (net < −3 at n≥40).
