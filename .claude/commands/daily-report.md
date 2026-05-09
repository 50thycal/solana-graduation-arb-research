---
description: Routine daily run — analyze trading performance, identify patterns, push narrative + recommendations to /report via report-upsert.
---

# /daily-report — Cross-session memory builder

This is the routine analyst run. It reads bot-status, looks across the last 7 days of trading + reports, identifies winners/losers/anomalies, proposes strategy actions, audits yesterday's action items, and pushes a single `strategy-commands.json` containing one `report-upsert` (with `auto_journal: true`) plus any `action-item-update` follow-ups.

Run on demand or via `/loop 24h /daily-report` for daily cadence.

## Step 0 — Today's date

The report key is the **UTC date** in `YYYY-MM-DD` form. Use today's UTC date.

## Step 1 — Fetch state

Read these files from `bot-status` (use `mcp__github__get_file_contents` with `owner=50thycal`, `repo=solana-graduation-arb-research`, `ref=refs/heads/bot-status`):

- `report.json` — the existing report state, including `today_auto` (auto-stats), the previous `recent_reports`, `lessons`, and `open_action_items`. **This is your primary input.**
- `diagnose.json` — health verdict + next action
- `trades.json` — recent trades + by-strategy breakdown
- `journal.json` — current hypotheses + auto_status
- `best-combos.json` — leaderboard ranked by `opt_avg_ret` with `baseline_avg_return_pct`
- `edge-decay.json` — DECAYING / STABLE / STRENGTHENING flags per strategy
- `strategy-percentiles.json` — median net per strategy (always cross-check means)
- `loss-postmortem.json` — dominant loss patterns per strategy
- `panel11.json` — combo regime stability (use before promoting)
- `strategies.json` — current enabled/disabled state (used for action-item reconciliation)

## Step 2 — Reconcile yesterday's action items

For each entry in `report.json → open_action_items`:

- `kill <strategy_id>` — check `strategies.json`. If the strategy is now `enabled: false` or absent → push `action-item-update` with `action_item_status: "EXECUTED"`. If still enabled and active → leave PROPOSED (or mark DEFERRED if the recommendation is stale).
- `promote <strategy_id>` — check whether the strategy is now in `strategies.json` with the proposed config. EXECUTED if yes.
- `create_new <strategy_id>` — check `strategies.json` AND `journal.json`. If both present → EXECUTED. If only journal entry exists → still PROPOSED (proposal recorded, not yet deployed).
- `watch <strategy_id>` — typically these resolve themselves once n hits 100 and a kill/promote decision happens. EXECUTED when the watched strategy gets a terminal verdict in journal.

## Step 3 — Identify today's signal

Use `report.json → today_auto`:

- **Winners / losers**: top 5 each by `net_return_pct`. Note any single-trade outliers (e.g. > +200% or < −50%) — these can mislead means and should be flagged in the narrative.
- **By-strategy deltas vs yesterday**: surface strategies where Δ Median > +5pp or < −5pp.
- **Auto-anomalies**: from `today_auto.anomalies_auto`. Include them in your narrative and rank by severity.

## Step 4 — Generate recommendations

- **Kill candidates**:
  - `edge-decay.json` strategies flagged `DECAYING` with `n_total ≥ 50`
  - Strategies with `loss-postmortem.json` `dominant_patterns` showing systemic feature deviations
  - Strategies stalled (`anomalies_auto: strategy_stalled`) for > 24h
- **Promote candidates**:
  - `best-combos.json` rows with `n ≥ 100`, `beats_baseline: true`, **and** Panel 11 `wr_std_dev < 15%` (regime stable)
  - Cross-check: median in `strategy-percentiles.json` must be in line with mean (no single-trade-outlier inflation)
- **Create new** (`auto_journal: true` will seed journal entries automatically):
  - High-`opt_avg_ret` combos at `n` between 50 and 100 — proposals to test, not promote
  - Each entry needs `{ strategy_id, hypothesis, prediction: { target_median_net_pct, target_n, kill_criterion }, cohort_label }`
- **Watch**:
  - Combos at `n < 50` showing promise but too sparse to act on

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
- What worked / didn't today
- Cross-day pattern observations
- Honest self-check: any mean-driven claim cross-checked against median?
- Operator next step (single most important action)

## Step 8 — Push commands

Build a single `strategy-commands.json` and push to `main` via `mcp__github__create_or_update_file`. Shape:

```json
{
  "commands": [
    {
      "action": "report-upsert",
      "id": "report-2026-05-09",
      "date": "2026-05-09",
      "generated_by": "claude",
      "narrative": "...markdown...",
      "winners": [/* top 5 trade rows */],
      "losers": [/* bottom 5 trade rows */],
      "anomalies": [/* combined auto + claude observations */],
      "patterns": [/* cross-day observations */],
      "recommendations": {
        "kill": [{"strategy_id": "...", "reason": "..."}],
        "promote": [{"strategy_id": "...", "reason": "..."}],
        "create_new": [
          {
            "strategy_id": "v18-vel-dd-tight",
            "hypothesis": "vel 20-50 + dd > -10% closed gap to n=100 — propose live shadow test.",
            "prediction": {"target_median_net_pct": 7, "target_n": 100, "kill_criterion": "n>=50 and median<-5"},
            "cohort_label": "v18"
          }
        ],
        "watch": [{"strategy_id": "...", "reason": "..."}]
      },
      "action_items": [
        {
          "id": "ai-2026-05-09-001",
          "kind": "promote",
          "target_id": "vel<5+dev<3%",
          "summary": "Promote vel<5+dev<3% to live shadow strategy — n=125, beats baseline by 13.5pp.",
          "status": "PROPOSED",
          "proposed_at": 1746748800
        }
      ],
      "auto_journal": true
    },
    {
      "action": "action-item-update",
      "id": "follow-up-1",
      "date": "2026-05-08",
      "action_item_id": "ai-2026-05-08-002",
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
