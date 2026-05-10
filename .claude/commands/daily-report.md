---
description: Routine daily run — analyze trading performance, identify patterns, push narrative + recommendations to /report via report-upsert.
---

# /daily-report — Cross-session memory builder

This is the routine analyst run. It reads bot-status, looks across the last 7 days of trading + reports, identifies winners/losers/anomalies, proposes strategy actions, audits yesterday's action items, and pushes a single `strategy-commands.json` containing one `report-upsert` (with `auto_journal: true`) plus any `action-item-update` follow-ups.

Run on demand or via `/loop 24h /daily-report` for daily cadence.

> **Evaluation regime (effective 2026-05-10):** the bar is **net SOL accumulated**, not median per-trade return. See CLAUDE.md "How to evaluate a candidate" for the priority order. The promotion bar is `n>=100 AND total_net_sol_drop_top3 > 0 AND total_net_sol >= 0.5 AND monthly_run_rate_sol >= 3.75`. Do not kill strategies on negative median alone — fat-tail memecoin strategies legitimately live there.

## Step 0 — Today's date

The report key is the **UTC date** in `YYYY-MM-DD` form. Use today's UTC date.

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

For each entry in `report.json → open_action_items`:

- `kill <strategy_id>` — check `strategies.json`. If the strategy is now `enabled: false` or absent → push `action-item-update` with `action_item_status: "EXECUTED"`. If still enabled and active → leave PROPOSED (or mark DEFERRED if the recommendation is stale). For **partial** executions (e.g. user kept some of a multi-strategy kill block), still EXECUTED but include the per-strategy split in `action_item_note`.
- `promote <strategy_id>` — check whether the strategy is now in `strategies.json` with the proposed config. EXECUTED if yes.
- `create_new <strategy_id>` — check `strategies.json` AND `journal.json`. If both present → EXECUTED. If only journal entry exists → still PROPOSED (proposal recorded, not yet deployed).
- `watch <strategy_id>` — typically these resolve themselves once n hits 100 and a kill/promote decision happens. EXECUTED when the watched strategy gets a terminal verdict in journal.

## Step 3 — Identify today's signal

Use `report.json → today_auto`:

- **Promotion readiness** (`today_auto.promotion_readiness_top5`): **read this first.** Top 5 enabled strategies ranked by composite 0–100 score against the SOL bar, with per-component breakdown (sample_size / drop_top3_pnl / total_net_sol / monthly_run_rate / win_rate_sanity) and per-gate pass/fail. Any row with `promotable: true` is a candidate for live promotion this cycle.
- **Winners / losers**: top 5 each by `net_return_pct`. Note any single-trade outliers (e.g. > +200% or < −50%) — flag in the narrative, then cross-check against `leave-one-out-pnl.json → top1/top3_contribution_pct` to see if those wins are concentrating the strategy's total P&L.
- **By-strategy deltas vs yesterday**: surface strategies where Δ Median > +5pp or < −5pp. Treat as diagnostic (distribution shifted), not as a promote/kill signal.
- **Auto-anomalies**: from `today_auto.anomalies_auto`. Include them in your narrative and rank by severity.

## Step 4 — Generate recommendations

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

- One-sentence headline
- What accumulated SOL today vs. what bled
- Cross-day pattern observations
- Honest self-check: any "this strategy is winning" claim cross-checked against `leave-one-out-pnl.json → total_net_sol_drop_top3`? Is the apparent edge from 1–3 lottery trades, or from a sustained pattern?
- Operator next step (single most important action)

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
      "narrative": "...markdown...",
      "winners": [/* top 5 trade rows */],
      "losers": [/* bottom 5 trade rows */],
      "anomalies": [/* combined auto + claude observations */],
      "patterns": [/* cross-day observations */],
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
