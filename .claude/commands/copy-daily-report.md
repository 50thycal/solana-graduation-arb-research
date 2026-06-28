---
description: Routine daily copy-trading review — analyze copy-trades.json, decide keep/kill/promote/add per strategy against the realistic-execution bar, record day-over-day + week-over-week trends to the copy-trade journal.
---

# /copy-daily-report — Daily copy-trading review + journal

The routine analyst run for the **copy-trading** subsystem (separate from `/daily-report`, which covers the T+30 graduation book). Each run: reads `copy-trades.json`, compares to yesterday's journal entry, decides what to do with every copy strategy (keep cooking / kill / promote / add new), records the trends seen day-over-day and week-over-week, and appends a dated entry to `docs/copy-trade-journal.md`.

Run on demand or via `/loop 24h /copy-daily-report` for daily cadence.

> **Evaluation bar (copy-specific).** A copy strategy is PROMOTABLE only when ALL clear: **realistic execution (5s entry delay) · n≥100 · drop_top3 > 0 · exit_stress > 0 · monthly_run_rate ≥ 3.75 SOL**. This is computed for you in `copy-trades.json → promotion`. The realistic-execution gate is non-negotiable: an **idealized 1:1 mirror** (no `entryDelaySec`) fills at the optimistic ~1.1s snapshot and is an UPPER BOUND only — never a live candidate. Its score caps at 80. Always judge real edge on the `-lag` twin, never the idealized mirror.

> **Copy strategies are CODE-DEFINED.** Unlike the T+30 book, the copy roster lives in `COPY_STRATEGIES` in `src/copytrade/copy-trader.ts`, not in `strategies.json`. Killing or adding a copy strategy is a **code edit + push to the dev branch + redeploy**, not a `strategy-commands.json` command. Therefore this skill **only proposes** roster changes — it writes recommendations to the journal. Execution (editing the array) happens in a follow-up step after operator approval. Phrase every recommendation in proposal voice ("recommend killing X", "propose adding Y") — never past-tense.

> **Don't kill on small n, in either direction.** copy-hotlead looked great at n=31 (+3.77, drop3 +2.00) then regressed to +1.00/drop3−1.22 at n=56. Small samples mislead both ways. Do not promote OR kill a realistic-execution strategy before n≥100 unless it's catastrophically negative (net < −3 at n≥40). Below n=100 the verdict is KEEP COOKING or WATCH.

---

## Step 0 — Today's UTC date

The journal entry key is today's UTC date in `YYYY-MM-DD`.

## Step 1 — Fetch copy-trades.json

The file is large (~500KB). Pull it with `curl` and parse the blocks you need with `python3` (do NOT inline the whole file). The MCP tool also works but truncates — prefer curl:

```bash
curl -sL "https://raw.githubusercontent.com/50thycal/solana-graduation-arb-research/refs/heads/bot-status/copy-trades.json" -o /tmp/ct.json
```

Pull these blocks:
- `generated_at`, `size_sol`, `overall` (ACTIVE-only n/net/drop3/stress/win_rate/open), `retired_summary`
- `regime.current` (score, band, score_24h, baseline_net_6h/24h, book_net_6h, lead_buys_6h, active_leads_6h) + `regime.swing` (daily book P&L + daily_mean/std)
- `macro` (score, band, components.btc_7d_pct / btc_1d_pct, btc_usd) — BTC-only tailwind/headwind
- `promotion` (monthly_bar_sol, n_promotable, rows[] with id/n/net_sol/drop_top3/exit_stress/monthly_run_rate_sol/**realistic_execution**/gates/promotable/score)
- `by_strategy` — per strategy: config (the gates), n, total_net_sol, total_net_sol_drop_top3, total_net_sol_exit_stress, win_rate, open_positions, daily, entry_drift, drift_skips, **gate_skips**, entered
- `paired_vs_baseline` — delta_net_sol vs copy-tp100-sl30 on shared events (the honest exit-variant comparison)
- `lead_performance` — n_leads, n_hot, n_cold, top[], bottom[]

Also read `diagnose.json` (verdict) — if not HEALTHY, note it but proceed (copy-trades is self-contained).

## Step 2 — Read yesterday + the week from the journal

Read `docs/copy-trade-journal.md`. Entries are newest-first. Grab:
- **Yesterday's entry** (entry [0]) — its `SNAPSHOT` JSON block is your day-over-day baseline.
- **The last 7 entries** — for week-over-week trends.

If the journal is empty / missing, say "first run, no prior entry" and seed it (Step 7 still writes today's entry).

## Step 3 — Read today's state

Build the picture, leading with the **realistic-execution** category of the promotion card:

- **Promotion — realistic category first.** From `promotion.rows`, filter `realistic_execution: true`, sort by score. These are the only live candidates. Any with `promotable: true` → promote candidate this cycle. Note the idealized mirrors separately as the ceiling (best case at zero latency) but never as candidates.
- **Per-strategy health.** For each active strategy: n, net, drop3, stress, win_rate, open. Cross-check apparent winners against drop3 + stress — a positive net with negative drop3 is lottery-shaped, not edge.
- **Lead signal.** `lead_performance`: n_hot / n_cold trend, top/bottom leads. Lead selection (consensus, cumulative lead quality) has been the durable edge; window/macro timing weaker.
- **Gate funnels.** For low-n gated strategies, read `gate_skips` + `entered`. Distinguish "n is low because the gate is strict" (high skip count) from "no qualifying events" (low skip count). If a strategy is gate-starved (e.g. n≈0 with thousands of skips on one reason), flag it for a looser threshold.
- **Regime + macro.** `regime.current.score` (1-10, copy-internal tape) and `macro.score` (1-10, BTC). Note both and their `score_24h` / btc_7d trajectory.

## Step 4 — Day-over-day deltas

Diff today's per-strategy metrics against yesterday's `SNAPSHOT` block:
- New strategies (in today, absent yesterday) and any removed (in yesterday's snapshot, absent today — a kill was enacted).
- For each carried-over strategy: Δn, Δnet, Δdrop3, Δpromo_score. Flag any promo-score move > 10 points, any drop3 sign flip, any net swing > 2 SOL.
- Regime score and macro score vs yesterday — is the tape / BTC improving or worsening.
- Book daily P&L: today's day vs the prior days in `regime.swing.daily`.

## Step 5 — Week-over-week trends

Across the last 7 journal entries:
- Which realistic-execution strategies are **converging toward** the bar (rising promo score / drop3 turning positive) vs **decaying** (falling, drop3 going negative). Name them.
- Regime score pattern (mostly green? volatile? a sustained bad stretch?) and macro/BTC trend over the week.
- Lead pool health trend (n_hot vs n_cold over the week).
- Any strategy that's been negative at n≥100 for multiple days → strengthening KILL case.
- Any recurring observation worth elevating to a durable note.

## Step 6 — Decide: what to do with each strategy

Assign every active strategy ONE verdict, in proposal voice. Use the realistic-execution numbers, never the idealized mirror's.

- **PROMOTE** — realistic_execution AND all promotion gates clear (promotable: true). Recommend a live-micro test (real funds at MICRO_TRADE_SIZE_SOL). This is an operator decision; state the gates that cleared.
- **KEEP COOKING** — n < 100 but trending toward the bar (drop3 ≥ 0 and stress ≥ 0, or promo score rising day-over-day). The default for young strategies.
- **KILL** — realistic_execution AND n ≥ 100 AND (drop3 ≤ 0 OR stress ≤ 0 OR net < 0); OR a multi-day decaying realistic strategy with negative drop3; OR catastrophic (net < −3 at n ≥ 40). Idealized mirrors are NOT killed for failing the realistic bar — they're references. Only recommend killing an idealized mirror if its entire family (incl. lag twins) is dead.
- **WATCH** — n < 50, too sparse; or gate-starved (recommend loosening the gate, citing the skip funnel).

Then propose **NEW strategies to try** (0–3), grounded in what the data shows working — e.g. variants of the durable signals (consensus, cumulative lead quality), or loosened gates for starved strategies. Each new idea: id, hypothesis, the one gate/param it isolates, and why now.

> **Redundancy guardrail (added 2026-06-17 after a bad proposal).** Before proposing any "new" strategy, check that an equivalent does NOT already exist in the roster. The most common trap: proposing a "realistic 5s-entry twin of idealized strategy X" — those twins **already exist** as `copy-<base>-lag` and `copy-<base>-lag-drift5`. E.g. the realistic twin of `copy-conviction-consensus2` is `copy-consensus2-lag` / `copy-consensus2-lag-drift5`, NOT a new strategy. Match on the gate/param combination (tp/sl, consensus, hotlead, regime, macro, entryDelaySec, drift), not the id string. If an equivalent exists, the right action is "watch the existing one," not "create a duplicate." Never propose recreating a strategy that's also on your KILL list.

## Step 7 — Write the journal entry

Prepend (newest-first) a dated entry to `docs/copy-trade-journal.md`. Two parts: a machine-readable `SNAPSHOT` block (so tomorrow can diff) and human prose. Template:

```markdown
## 2026-06-17

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-06-17",
  "overall": {"n": 0, "net": 0, "drop3": 0, "stress": 0, "open": 0},
  "regime_score": 0, "regime_24h": 0, "macro_score": 0, "btc_7d_pct": 0,
  "book_daily_today": 0,
  "leads": {"n_leads": 0, "hot": 0, "cold": 0},
  "n_promotable_realistic": 0,
  "strategies": [
    {"id": "copy-consensus2-lag-drift5", "realistic": true, "n": 0, "net": 0, "drop3": 0, "stress": 0, "promo_score": 0, "verdict": "KEEP"}
  ]
}
```

**Headline:** one sentence — the single most important thing today.

**Day-over-day:** regime/macro moves, strategy promo-score movers (>10pts), drop3 sign flips, any roster change enacted since yesterday.

**Week-over-week:** which realistic strategies are converging vs decaying, regime/BTC pattern, lead-pool trend, any strengthening kill case.

**Verdicts (proposals — roster changes need approval + a code edit to COPY_STRATEGIES):**
- PROMOTE: …
- KEEP COOKING: …
- KILL: …  (with the gate that failed + n)
- WATCH / loosen gate: …

**New strategies to try:** id — hypothesis — what it isolates.

**Operator next step:** the single most important action.
```

Keep `strategies[]` in the SNAPSHOT to ~the active roster (one row each). `verdict` ∈ KEEP / KILL / PROMOTE / WATCH.

## Step 8 — Publish to the stable `copy-daily-reports` branch + auto-merge PR

Daily reports always land on **one** stable branch and **one** rolling PR. This avoids the
N-conflicting-branches problem (each run rebases onto fresh main, then force-pushes; the open PR
updates in place; auto-merge publishes when checks pass).

The exact recipe:

```bash
# 1. Get fresh main so the new entry sits on top of any code/cohort entries that landed today.
git fetch origin main
git checkout -B copy-daily-reports origin/main

# 2. Write today's entry into docs/copy-trade-journal.md (Step 7).
# 3. Commit on this branch.
git add docs/copy-trade-journal.md
git commit -m "copy-journal: <YYYY-MM-DD> daily review"

# 4. Force-push (the branch is rebased onto main every run, so history rewinds is expected).
git push -u origin copy-daily-reports --force-with-lease
```

Then make sure there's exactly **one** open PR from `copy-daily-reports` into `main`:

- `mcp__github__list_pull_requests` (`head=50thycal:copy-daily-reports`, `state=open`). If one
  exists, the push above already updated it — do nothing. If none exists, open it with
  `mcp__github__create_pull_request` titled `copy-journal: rolling daily reviews` and a body that
  notes "this PR is reused each day — the branch is rebased onto main and force-pushed before
  every new entry."
- After the PR exists (or already existed), call `mcp__github__enable_pr_auto_merge` with
  `merge_method: "squash"`. If branch protection has no required checks, GitHub merges
  immediately; otherwise it merges as soon as checks pass.

Do NOT push roster changes (code edits to `COPY_STRATEGIES`) in this run — those are a separate,
approved step on their own branch.

## Step 9 — Surface the result

Reply to the operator with: the headline, the realistic-execution promotion shortlist (who's closest / any promotable), the proposed verdicts (esp. any KILL or PROMOTE), the new-strategy ideas, the single recommended next action, and the rolling-PR URL (so they can merge it manually if auto-merge didn't fire). If any roster change is recommended, ask for approval to make the code edit.

## Notes on autonomy

- This skill **decides and records**; it does not edit the roster. When the operator approves a kill/add, make the `COPY_STRATEGIES` edit in a follow-up (typecheck + push to the dev branch as usual).
- Never recommend promoting an idealized mirror. The realistic `-lag` twin is the only thing that can go live.
- Be honest about small n. "Keep cooking" is the right call far more often than kill or promote.
