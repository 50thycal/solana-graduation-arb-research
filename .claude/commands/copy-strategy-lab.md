---
description: Weekly copy-trading strategy ideation + convergence loop — read the data + trends, update the incumbent best strategy, resolve matured experiments, and spawn ONE new hypothesis (mostly variants of the current best, occasionally a new dimension) to hill-climb toward a promotable strategy. Records lineage in the strategy lab ledger.
---

# /copy-strategy-lab — strategy ideation + convergence

The exploration engine for copy trading (complement to `/copy-daily-report`, which *evaluates* the roster). This loop *generates* the next strategy to test and drives the roster to **converge on the best strategy over time** — hill-climbing, not sprawling. Each run promotes the best matured strategy to "incumbent," resolves experiments that have reached decision-n, and spawns at most ONE new hypothesis derived from what's working.

Run on a slow cadence — `/loop 7d /copy-strategy-lab`. **Weekly, not daily**: a new strategy needs ~1–2 weeks to reach n≥100 before it can be judged, so adding one per day would flood the roster with un-evaluable strategies and never converge.

> **Convergence over sprawl — the core discipline.** The goal is a *promotable* realistic strategy (n≥100 · drop3>0 · stress>0 · monthly≥3.75, on a 5s-entry lag base). Get there by: (1) keeping a single **incumbent** = the best mature realistic strategy; (2) spawning challengers that perturb the incumbent's strongest lever by ONE param; (3) pruning matured failures; (4) capping in-flight experiments. Do NOT add a new strategy every run — only when there's an open slot AND a grounded hypothesis. If nothing is improving after several cycles, say so plainly (the realistic edge may not clear the bar).

> **Roster changes are code edits to `COPY_STRATEGIES`** (operator-approved via merge). This skill MAY implement the one new experiment per run (add to the array, typecheck, commit, push to the dev branch) — deploy stays gated by the operator's merge. Apply the **redundancy guardrail** (see `/copy-daily-report`): never spawn a strategy whose gate/param combo already exists (match on params, not id) and never recreate something on the kill list.

## Step 0 — Today's UTC date.

## Step 1 — Read state

- `copy-trades.json` (curl + python3; it's large): `promotion.rows` (filter `realistic_execution: true`), `by_strategy` configs + n/net/drop3/stress, `paired_vs_baseline`, `lead_performance`. The realistic promotion card is your scoreboard.
- `docs/copy-trade-journal.md` — the latest daily entries for trend context (regime/macro arc, what's strengthening vs decaying).
- `docs/copy-strategy-lab.md` — the lab ledger: current incumbent, in-flight experiments (id · parent · hypothesis · target_n · kill_criterion), and the resolved log. **This is your memory of what's been tried and why.**

## Step 2 — Update the incumbent

The **incumbent** is the realistic strategy with the highest promo score that is **mature (n≥100)**. Compare to the ledger's recorded incumbent:
- If a different mature strategy now has a higher promo score (and clears ≥ as many gates), it's the **new incumbent** — note the handoff and that future challengers derive from it.
- If the incumbent is unchanged, note its promo-score trend (climbing toward the bar, flat, or decaying).
- If NO realistic strategy is mature yet, the incumbent is "none — closest candidate is X (n=…, promo=…)"; challengers still derive from the closest candidate.

## Step 3 — Resolve matured experiments

For each lab experiment in the ledger now at **n≥100** (or catastrophic: net<−3 at n≥40):
- **WIN** if it clears the bar (promotable) OR beats the incumbent's promo score with positive drop3 → keep; it may become the new incumbent and the basis for the next variants. If promotable, recommend a live-micro test.
- **LOSS** if it fails the bar decisively (drop3≤0 or stress≤0 at n≥100) → propose KILL (and remove from in-flight). Move it to the resolved log with the verdict.
- Still maturing (n<100, not catastrophic) → leave in-flight.

## Step 4 — Convergence check

State plainly whether the search is **converging or sprawling**:
- Converging: incumbent promo score trending up over recent cycles, the viable lineage is narrowing, fewer-but-better candidates.
- Sprawling/stalled: many immature strategies, no promo-score progress across 2+ cycles, or the best lineage keeps failing the same gate (e.g. drop3 never crosses positive — a sign the signal is fat-tail-bound).
- If a promotable strategy exists and is stable → the lineage has converged; shift to "confirm robustness + recommend live-micro," and slow ideation (don't keep spawning variants of a solved problem).
- If stalled for ~3+ cycles with no realistic strategy clearing drop3 → say so honestly: the realistic copy edge may not clear the bar, and that's a finding, not a prompt to keep adding strategies.

## Step 5 — Spawn the next hypothesis (≤1 per run, only if there's an open slot)

**Open-slot rule:** count in-flight lab experiments (n<100). If ≥ `MAX_INFLIGHT` (default 4), do NOT add — report status and the held idea, and wait. This is what forces convergence.

If there's a slot, generate ONE hypothesis:
- **EXPLOIT (default, ~3 of 4 cycles):** take the incumbent (or closest candidate) and perturb its **strongest single lever** by one param — e.g. tighten/loosen a gate threshold (consensus 2→3, drift 5%→3%/8%), adjust TP/SL, add one orthogonal quality gate it lacks (e.g. + cumulative lead quality). Pick the perturbation most likely to fix the incumbent's *failing* gate (usually drop3 — so favor changes that broaden the winner distribution, not concentrate it).
- **EXPLORE (~1 of 4, or whenever exploitation has stalled 2+ cycles):** a genuinely new signal/dimension not yet on the roster, grounded in the data (e.g. a new lead-quality measure, a token-feature gate, a time-of-day gate) — only if the lead/feature data supports it.
- Always: realistic base (`entryDelaySec: 5`, usually `maxEntryDriftPct: 10`), run the redundancy guardrail, and state the ONE thing it isolates + the gate it's trying to fix.

**Pair with a prune** if the roster is at its working cap (~20 active): retire one matured LOSS from Step 3 in the same change, so the roster stays bounded.

## Step 6 — Implement + record

If a hypothesis was spawned:
1. Add it to `COPY_STRATEGIES` in `src/copytrade/copy-trader.ts` (+ any prune). `npx tsc --noEmit`.
2. Commit + push to the dev branch (do NOT merge/deploy — operator does that).
3. Append to the lab ledger's in-flight table: `{ id, parent, hypothesis, gate_it_isolates, target_n (usually 100), target_date (~14d), kill_criterion }`.
Always update the ledger's **incumbent** line and **resolved log** (from Steps 2–3) even on runs that spawn nothing.

## Step 7 — Report

Reply with: the current incumbent + its trend, any experiment resolutions (wins/kills), the convergence verdict (converging / stalled / solved), and the new experiment (id + the one lever it changes + why) or "no add this cycle — N experiments still maturing." If a strategy went promotable, lead with the live-micro recommendation.

## Relationship to the other routines
- `/copy-daily-report` (daily) — evaluates the roster, records day/week trends, proposes kills. Maintains `copy-trade-journal.md`.
- `/copy-strategy-lab` (weekly) — generates the next hypothesis, drives convergence. Maintains `copy-strategy-lab.md`.
The daily routine feeds the lab (trends + kill proposals); the lab feeds the daily routine (new strategies to track). Keep them in their lanes: daily doesn't spawn strategies; the lab doesn't do daily eval.
