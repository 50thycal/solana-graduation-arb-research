---
description: Routine daily run — analyze trading performance, identify patterns, push narrative + recommendations to /report via report-upsert.
---

# /daily-report — Cross-session memory builder

This is the routine analyst run. It reads bot-status, looks across the last 7 days of trading + reports, identifies winners/losers/anomalies, proposes strategy actions, audits yesterday's action items, and pushes a single `strategy-commands.json` containing one `report-upsert` (with `auto_journal: true`) plus any `action-item-update` follow-ups.

Run on demand or via `/loop 24h /daily-report` for daily cadence.

> **Evaluation regime (effective 2026-05-10):** the bar is **net SOL accumulated**, not median per-trade return. See CLAUDE.md "How to evaluate a candidate" for the priority order. The promotion bar is `n>=100 AND total_net_sol_drop_top3 > 0 AND total_net_sol >= 0.5 AND monthly_run_rate_sol >= 3.75`. Do not kill strategies on negative median alone — fat-tail memecoin strategies legitimately live there.

> **Headline metric (effective 2026-05-12):** the **composite readiness score (0–100)** in `report.json → today_auto.promotion_readiness_all` is the single primary evaluation number. It consolidates sample size, drop-top3 P&L, total Net SOL, monthly run rate, and a win-rate sanity check into one rankable score. Median per-trade return is a distribution-shape diagnostic only — never use it as a primary kill or promote signal.

> **Recommendations are PROPOSALS, never executed actions (effective 2026-05-12).** The /daily-report skill ONLY writes `report-upsert` + `action-item-update` commands. It NEVER pushes `upsert` / `delete` / `toggle` strategy commands. Strategy roster changes require explicit operator approval and a separate `strategy-commands.json` push. Phrase every recommendation in proposal-voice ("recommend killing X because Y") — never past-tense ("killed X"). The 2026-05-12 narrative confusion came from past-tense phrasing that read as if the skill had executed; don't repeat.

## Step 0 — Today's date

The report key is the **UTC date** in `YYYY-MM-DD` form. Use today's UTC date.

## Step 0.5 — Capture today's roster snapshot

Read `strategies.json` and `leave-one-out-pnl.json` from `bot-status`. Build two arrays you'll persist with this run's `report-upsert`:

- `active_strategies_snapshot`: every entry in `strategies.json` as `{ strategy_id, label, enabled }`. This snapshot is what tomorrow's session will diff against to detect kills, adds, and toggles.
- `by_strategy_daily`: join `leave-one-out-pnl.json → rows[]` with the enabled-strategies set. Per-entry shape: `{ strategy_id, execution_mode, label, enabled, n_trades_today, n_trades_yesterday, net_sol_today, net_sol_yesterday, readiness_score, readiness_score_yesterday, readiness_score_alltime_high, readiness_score_alltime_low, promotable, n_trades_lifetime, total_net_sol_lifetime, total_net_sol_drop_top3, monthly_run_rate_sol }`. **Key by `(strategy_id, execution_mode)`** — a strategy running both paper + shadow gets two entries (one per mode). `n_trades_today` + `net_sol_today` come from `today_auto.by_strategy_daily_snapshot[i]`; the field is already populated server-side, so the simplest path is to copy it into the upsert verbatim. Same for `active_strategies_snapshot`.

These two arrays go into the `report-upsert` payload as top-level fields (see Step 8). The bot stores them inside `patterns_json` for back-compat, so no schema change is needed. Pre-rollout days lack these fields — that's OK; renderers tolerate `undefined`.

## Step 1 — Fetch state

Read these files from `bot-status` (use `mcp__github__get_file_contents` with `owner=50thycal`, `repo=solana-graduation-arb-research`, `ref=refs/heads/bot-status`):

- `report.json` — the existing report state, including `today_auto` (auto-stats + `promotion_readiness_top5`), the previous `recent_reports`, `lessons`, and `open_action_items`. **This is your primary input.**
- `leave-one-out-pnl.json` — **canonical evaluation source.** Per-strategy `total_net_sol`, `total_net_sol_drop_top1/3`, `monthly_run_rate_sol`, `top1/top3_contribution_pct`, `trimmed_mean_net_pct`. Use this for every promote/kill decision.
- `diagnose.json` — health verdict + next action
- `trades.json` — recent trades + by-strategy breakdown
- `journal.json` — current hypotheses + auto_status
- `best-combos.json` — leaderboard ranked by `opt_avg_ret`. Note: `baseline_avg_return_pct` and `beats_baseline` are informational; the live promotion bar is in `leave-one-out-pnl.json`.
- `edge-decay.json` — DECAYING / STABLE / STRENGTHENING flags per strategy
- `strategy-percentiles.json` — distribution-shape diagnostics (p10/p25/p75/p90, top_winners, top_losers). Use for *shape* checks, not as the primary kill signal.
- `loss-postmortem.json` — dominant loss patterns per strategy
- `panel11.json` — combo regime stability (use before promoting)
- `panel7.json` — walk-forward verdict (ROBUST / DEGRADED / OVERFIT)
- `strategies.json` — current enabled/disabled state (used for action-item reconciliation)

## Step 2 — Reconcile yesterday's action items

**This is the hygiene step that catches the 2026-05-12 v17/v18 bug class.** Any `open_action_items` row whose `target_id` is absent from today's `strategies.json` (or now has `enabled: false`) is **mandatorily** flipped to EXECUTED in this run — do not let a stale item sit PROPOSED for another cycle.

For each entry in `report.json → open_action_items`:

- `kill <strategy_id>` — check `strategies.json`. If the strategy is now `enabled: false` **or absent** → push `action-item-update` with `action_item_status: "EXECUTED"`. **Required, not optional.** If still enabled and active → leave PROPOSED (or mark DEFERRED if the recommendation is stale). For **partial** executions (e.g. user kept some of a multi-strategy kill block), still EXECUTED but include the per-strategy split in `action_item_note`.
- `promote <strategy_id>` — check whether the strategy is now in `strategies.json` with the proposed config. EXECUTED if yes.
- `create_new <strategy_id>` — check `strategies.json` AND `journal.json`. If both present → EXECUTED. If only journal entry exists → still PROPOSED (proposal recorded, not yet deployed).
- `watch <strategy_id>` — typically these resolve themselves once n hits 100 and a kill/promote decision happens. EXECUTED when the watched strategy gets a terminal verdict in journal. **Also EXECUTED if every listed target is now absent from `strategies.json`** — the watch is moot.

For multi-target items (`target_id` is a comma-separated list like `"v18-calm-mkv-strict,v18-calm-mkv-exitonly"`), the item is EXECUTED when ALL listed targets are absent. If any one is still present, leave PROPOSED and call out the partial state in `action_item_note`.

**Inline operator edits.** Action items can also be dismissed or edited by the operator directly on the /report dashboard (POST `/api/action-item/:date/:id/dismiss` or PATCH `/api/action-item/:date/:id`). Respect any `EXECUTED` / `REJECTED` / `DEFERRED` status already present in `report.json → open_action_items` — do NOT re-propose dismissed items in subsequent narratives. If the operator edited a `summary` or `kind`, the new text is authoritative; treat the original proposal as superseded.

## Step 2.5 — Diff yesterday vs today active strategies

Compare today's `strategies.json` against `report.json → recent_reports[0].summary.active_strategies_snapshot`:

- **Added**: strategy IDs in today's roster but missing from yesterday's snapshot.
- **Removed**: strategy IDs in yesterday's snapshot but missing today.
- **Toggled off**: `enabled: true` yesterday → `enabled: false` today.
- **Toggled on**: the reverse.

Describe any non-empty groups in plain prose at the top of the narrative (Step 7) — operators read the roster diff before reading recommendations, so it sets the frame. Example: "Roster: removed v17-calm-be5/be7/be9 + v18-calm-mkv-exitonly (4 kills enacted between yesterday and today). No adds or toggles."

If yesterday's snapshot is absent (first rollout day or a session gap), say so and move on.

## Step 3 — Identify today's signal

Use `report.json → today_auto`. **The composite readiness score (0–100) is the headline metric** — every kill/promote/watch judgement should cite it explicitly.

- **Promotion readiness** (`today_auto.promotion_readiness_all`): **read this first.** ALL enabled strategies ranked by composite 0–100 score against the SOL bar, with per-component breakdown (sample_size / drop_top3_pnl / total_net_sol / monthly_run_rate / win_rate_sanity) and per-gate pass/fail. Any row with `promotable: true` is a candidate for live promotion this cycle. `promotion_readiness_top5` is the same list truncated to 5 — use `_all` whenever you need to see beyond the top.
- **Winners / losers**: top 5 each by `net_return_pct`. Note any single-trade outliers (e.g. > +200% or < −50%) — flag in the narrative, then cross-check against `leave-one-out-pnl.json → top1/top3_contribution_pct` to see if those wins are concentrating the strategy's total P&L.
- **Δ readiness score vs yesterday**: pull `by_strategy_daily` from `recent_reports[0]` and compare to today's `by_strategy_daily_snapshot`. Strategies whose score moved >5 points in either direction deserve a one-line mention. This replaces the old "Δ median" diagnostic — median per-trade is a distribution-shape diagnostic only, never a promote/kill signal.
- **Auto-anomalies**: from `today_auto.anomalies_auto`. Include them in your narrative and rank by severity.

## Step 4 — Generate recommendations

**Voice rule — non-negotiable.** Recommendations are PROPOSALS. Phrase every entry in future-tense recommend-voice: "recommend killing X because Y", "propose promoting X — gates Z clear". **Never** past-tense: not "killed X", not "declared INVALID", not "all four variants removed". The skill does NOT execute strategy changes; only the operator does, via a separate `strategy-commands.json` push. The 2026-05-12 narrative was past-tense and read as if executed — that confusion is what this rule prevents.

**Promote candidates** — strategies that clear ALL four bar gates plus regime stability:

| Gate | Source |
|---|---|
| `n_trades >= 100` | `leave-one-out-pnl.json` row |
| `total_net_sol_drop_top3 > 0` | same — the outlier-stripped edge check |
| `total_net_sol >= 0.5` | same — table-stakes accumulation |
| `monthly_run_rate_sol >= 3.75` | same — ~$300/month target |
| Panel 11 `wr_std_dev < 15%` | `panel11.json` — regime stable |
| Panel 7 verdict NOT OVERFIT | `panel7.json` |

`promotion_readiness_top5` already ranks the closest-to-bar with the first four gates folded into the score. Use that as your shortlist, then verify Panel 7 + Panel 11.

**Kill candidates** — any one of:

- `n_trades >= 100` AND `total_net_sol_drop_top3 <= 0` (no real edge after outlier strip)
- `n_trades >= 100` AND `total_net_sol < 0` (accumulated losses, not gains)
- `edge-decay.json` flagged `DECAYING` with `n_total >= 50` AND `total_net_sol` trending negative
- `loss-postmortem.json` shows systemic feature deviation in losers
- `anomalies_auto: strategy_stalled` for > 24h
- Panel 7 verdict OVERFIT at `n >= 100`

**Do NOT auto-kill on negative median alone.** A strategy with negative median + positive `drop_top3` is a legitimate fat-tail strategy; the loss tail is part of the cost of capturing the win tail. Memecoins are definitionally fat-tailed.

**Create new** (`auto_journal: true` will seed journal entries automatically):

- High-`opt_avg_ret` combos at `n` between 50 and 100 from `best-combos.json`
- Each entry needs `{ strategy_id, hypothesis, prediction: { target_n, target_days, kill_criterion }, cohort_label }`
- Frame `kill_criterion` in net-SOL terms when possible (e.g. `"n>=50 and total_net_sol_drop_top3<0"`); the parser still accepts the older `"n>=N and median<X"` form for compatibility but it's less informative.

**Watch**:

- Combos at `n < 50` showing promise but too sparse to act on
- Anything from `promotion_readiness_top5` with `n_trades < 100` that's pacing toward all four gates

## Step 5 — Look across history

Read `report.json → recent_reports[0..6]`. Look for:

- **Recurring winners**: same strategy_id appearing in `winners` 3+ days running
- **Recurring losers**: same exit_reason dominating a strategy's losers across multiple days
- **Repeat outlier wallets/devs**: same dev_wallet_address surfacing in big wins or losses
- **Exit-mix drift**: TP/SL ratio shifting across days for a strategy
- **Anomaly recurrence**: same `auto_anomaly.kind` flagging multiple days
- **Action-item carryover**: items proposed > 3 days ago still PROPOSED — escalate or mark DEFERRED

## Step 6 — Update lessons-learned (sparingly)

If the cross-history scan reveals a pattern that's been confirmed for ≥ 7 days and contradicts or refines an existing lesson, push `lesson-upsert` (or `lesson-archive` for invalidated ones). Keep this rare — it's institutional memory, not a daily noticeboard.

## Step 7 — Compose narrative

Free-form markdown commentary, 4–8 paragraphs. Cover:

- **Opening paragraph: roster diff from Step 2.5** ("Roster: added X, removed Y, toggled off Z") — operators read this before recommendations, so it sets the frame. If empty, write "No roster changes since yesterday."
- One-sentence headline
- What accumulated SOL today vs. what bled
- Cross-day pattern observations
- Honest self-check: any "this strategy is winning" claim cross-checked against `leave-one-out-pnl.json → total_net_sol_drop_top3`? Is the apparent edge from 1–3 lottery trades, or from a sustained pattern?
- Operator next step (single most important action)

**Voice rule (mirror of Step 4):** every action verb describing a recommendation MUST be future-tense — "recommend killing", "propose promoting", "watching pending n=N", "would create new strategy X". Never write "killed", "promoted", "removed", "declared INVALID" unless you are describing something the operator ALREADY did (then cite the date / commit). If you find yourself reaching for past-tense, you're conflating proposal with execution.

## Step 8 — Push commands

Build a single `strategy-commands.json` and push to `main` via `mcp__github__create_or_update_file`. Shape:

```json
{
  "commands": [
    {
      "action": "report-upsert",
      "id": "report-2026-05-10",
      "date": "2026-05-10",
      "generated_by": "claude",
      "narrative": "...markdown... (roster diff in opening paragraph; proposal-voice recommendations)",
      "winners": [/* top 5 trade rows */],
      "losers": [/* bottom 5 trade rows */],
      "anomalies": [/* combined auto + claude observations */],
      "patterns": [/* cross-day observations */],
      "by_strategy_daily": [/* from Step 0.5 — per-strategy snapshot for the by-strategy panel + time-series chart */],
      "active_strategies_snapshot": [/* from Step 0.5 — roster snapshot for tomorrow's diff */],
      "recommendations": {
        "kill": [{"strategy_id": "...", "reason": "n=120, drop_top3=-0.42 SOL — apparent edge was 1-3 lottery trades"}],
        "promote": [{"strategy_id": "...", "reason": "all 4 gates clear: n=134, drop_top3=+0.61 SOL, total=+0.94 SOL, monthly=4.21 SOL/mo; Panel 11 stable, Panel 7 ROBUST"}],
        "create_new": [
          {
            "strategy_id": "v21-vel-dd-tight",
            "hypothesis": "vel 20-50 + dd > -10% closed gap to n=100 — propose live shadow test. Target accumulating >= 0.5 SOL with drop_top3 > 0 on n=125.",
            "prediction": {"target_n": 125, "target_days": 14, "kill_criterion": "n>=50 and total_net_sol_drop_top3<0"},
            "cohort_label": "v21"
          }
        ],
        "watch": [{"strategy_id": "...", "reason": "n=72, pacing toward all 4 gates"}]
      },
      "action_items": [
        {
          "id": "ai-2026-05-10-001",
          "kind": "promote",
          "target_id": "v20-vel2050-dd-base",
          "summary": "Promote v20-vel2050-dd-base to live — clears all 4 SOL-bar gates with regime stability.",
          "status": "PROPOSED",
          "proposed_at": 1778412000
        }
      ],
      "auto_journal": true
    },
    {
      "action": "action-item-update",
      "id": "follow-up-1",
      "date": "2026-05-09",
      "action_item_id": "ai-2026-05-09-002",
      "action_item_status": "EXECUTED",
      "action_item_note": "Strategy v9-vel50 disabled per yesterday's plan."
    }
  ]
}
```

## Verify

After pushing, wait ~2 min then re-fetch `report.json` and confirm:

- `today_report.narrative` matches what you pushed
- `open_action_items` reflects the new PROPOSED items
- Any `action-item-update` you sent flipped status in `recent_reports`
- For `auto_journal: true` runs, new `create_new` proposals appear in `journal.json` as `<strategy_id>-proposal-<date>` entries
- `command-results.json` shows `ok: true` for every command (debug rejections from there)
