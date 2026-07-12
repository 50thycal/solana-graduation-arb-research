# Screening & Handoff

Read in Phases 3–4. Two parts: the **scoring rubric** (cut the slate) and the **handoff template** (promote survivors in the repo's format, ready for `solana-strategy-phase-2`).

---

## Part A — The six-axis screen

Score every candidate on all six. Order reflects how often each one *kills* an idea — correlation and the survivorship gate do a lot of the cutting. Use a simple scale per axis (e.g. −2 to +2, or kill/weak/ok/strong); the point is an explicit, defensible call, not false precision. Most candidates should not promote.

### 1. Correlation to existing books (the portfolio lens) — *kills the most "new" ideas*
Does the candidate share a **return driver** with a live strategy — the *same leads* or the *same signal*, not just the same surface? Look through to the driver:
- Another hot-lead net-floor step → same leads, same recency signal → **correlated with the incumbent** (and it's the incumbent's own hill-climb, not a new idea).
- A freshness or consensus gate layered on the *same* leads still shares the recency driver — but a restriction can carry independent robustness; judge the marginal driver.
- A **new wallet source** or a **different edge-source** (earliness, cross-token skill, consensus on different leads) has a genuinely different driver → uncorrelated.
**Scoring:** shared driver with a live strategy → heavy penalty *even if the edge is real* (adds variance, not diversification). Zero correlation → bonus (uncorrelated ballast is worth more than its raw edge toward the SOL-accumulation goal). This axis can veto an otherwise-good idea. **Screen against the waiting queue, not only the live book:** the board is chronically at `MAX_INFLIGHT`, so a survivor that shares a driver with a challenger already queued for the next slot — and isn't clearly better — is a HOLD, not a promote. Promote budget = slots actually open; **zero is a valid promote count.** (Uncorrelated-but-*dead* is not ballast: a new wallet source scores "uncorrelated" here but is a known graveyard on axis 2 — don't let this axis's bonus rescue it.)

### 2. Edge plausibility given the graveyard — *the prior*
Which family does it fall in?
- **Information asymmetry that survives the `-lag` twin** (a lead knows/sees something first; you mirror it before decay) → **high prior** (the only proven edge shape).
- **Public post-hoc chart features** (velocity/holders/concentration/snipers/regime on the *token*) → **dead** (−935 SOL; filters reshape the loss, never reverse it).
- **Cumulative copy-net as a lead selector or veto** → **dead** (refuted both directions OOS; only *recency* holds).
- **Exit/sizing engineering to rescue a signal** → **low** (never flipped a negative entry; tighter-than-SL30 stops poison).
Also name **who the lead is / why they're ahead** and **why it persists** — the crowd can't identify these leads or fresh tokens fast enough (the decay race). "This wallet class keeps entering winners in the first 15 minutes and the tape can't surface them that fast" is credible; "these wallets are just good" is not.

### 3. Survivorship / point-in-time safety — *the silent hard gate*
Does any field the idea keys on resolve **after** entry time? The `holders≥250 (backfill)` filter showed **+24.25%** and "ROBUST" and was recommended for deployment **5+ times** — pure survivorship (backfill re-resolves holder count after the outcome, so surviving-250-holders-today = didn't-rug). **Walk-forward train/test cannot detect this** — both halves share the contaminated feature (same class as the `liq_t300` look-ahead bug). Apply the smell test: if computing the signal needs to know how the token *ended up* (final holder count, whether it rugged, peak price, "confirmed recovery"), it's poison. An idea that leans on an at-entry-unknowable field is **dead on arrival — reject it here**, regardless of how good it backtests. (The winner-sniper pre-filter is safe *because* flows only accumulate after enrollment — out-of-sample by construction.)

### 4. Execution / cost survival — *hard gate*
Estimate the edge on the **`-lag` twin** (5s entry delay + round-trip cost `SIM_DEFAULT_COST_PCT` + slippage), never the idealized ~1.1s mirror (upper bound only; score caps at 80; never a live candidate). The copy edge is a decay race — if 5 seconds kills it, it isn't capturable, and the idealized number is a mirage. Then:
- **drop3 > 0** (net after removing the top 3 trades). Net-positive-but-drop3-negative is a lottery ticket (1–3 outliers), refused by design. This is the single most important robustness check.
- **exit-stress > 0** where the chassis is exercised.
- **Live-only costs** for a live-bound idea: Jito tip, ATA rent, priority fees, land rate (the rent-failure lesson: `InsufficientFundsForRent` is a *funding* symptom, not a retry bug).
An edge that only survives at 1.1s, or only on raw net, is dead.

### 5. Capacity / n≥100 reachability — *should already be a Phase-2 PRE-gate; this is the second check*
Can it reach **n ≥ 100** on the copyable (post-graduation PumpFun) universe, with drop3 holding, in a readable window? The `live_tape` source was pruned precisely because its wallets rarely traded the copyable universe — stuck at **n=24 for 4+ loops**, never reaching n≥100 (a funnel/reachability problem, not a P&L problem); gradspec froze the same way. **Reachability has killed more theses here than edge has** — it belongs *up front* in Phase 2 (estimate fire-rate before writing the candidate line), and any candidate that reached this screen without a fire-rate estimate is a process miss to fix before scoring. A gate so strict it fires a few times a day, or a source whose wallets don't touch fresh graduations, can't build a track record. A great edge that fires 10 times is a hobby, not 3.75 SOL/mo.

### 6. Infra / RPC reuse — *speed-and-cost multiplier*
Which existing machinery does it reuse, and what does it cost to run?
- **Reuse:** the `COPY_STRATEGIES` chassis + the `-lag` twin (a gate/exit idea = one entry + its twin); the `DISCOVERY_SOURCES` registry (a new source = one row + a harvester → the standardized `copy-src-<id>` probe + scorecard row + quarantine routing, zero bespoke wiring); the winner-sniper 3-stage funnel; the shared scorer.
- **RPC/WS cost:** the dominant Helius cost is **watchlist size on the WebSocket** (billed per delivered message), *not* strategy count — pruning strategies frees ~0. A new source's smart set grows the watchlist (capped best-first, `COPYSRC_WATCH_CAP`); a scoring-heavy idea grows `wallet_pnl` RPC. Zero-RPC gates (`maxConsensusRecent`, `maxTokenAgeSec`, `maxExtensionPct` — all cached/counted) are the cheapest to test.
High reuse + low marginal RPC → cheaper and faster to a verdict → promote sooner among near-ties.

### Output of Phase 3
A scored table: candidate × the six axes + a **promote / hold / kill** call and a one-line reason. Be blunt. Killing an idea here, before a probe, is the cheapest win available. Typically 0–3 promote (0 is legitimate — see Part C).

---

## Part B — Handoff template (Phase 4)

For each survivor, write this. It matches a `docs/copy-strategy-lab.md` ledger entry so it drops straight into the repo's pipeline and into `solana-strategy-phase-2` (Phase 1 thesis / Phase 3 implementation). The **pre-registered predictions are the load-bearing part** — written before any validation so the test can't be quietly re-scoped after the fact.

```markdown
# <NAME> — <one-line description of the copy-edge>

*Thesis written <date>, before any validation ran; the falsifiable predictions below are
pre-registered. Status: pending probe. Voice: proposal (operator reviews + deploys).*

## One-liner
<The edge in one sentence a trader would recognize — which lever, which leads/tokens, the signal.>

## Mechanism
- **What asymmetry:** <what the lead knows/sees first, and what's mispriced as a result.>
- **Who's on the other side / why they're ahead:** <the lead class and their behavior; who
  provides the exit liquidity — e.g. the crowd that can't identify fresh winners fast enough.>
- **Why it persists:** <the decay race / the tape's blind spot — why this isn't already competed away.>
- **Edge family:** <recency / cross-token-skill / consensus / earliness / freshness / microstructure>
  and why the prior supports it (must be information-asymmetry, not a public-feature filter).

## The one lever changed
<The single lever/param perturbed vs the incumbent (Phase-2 discipline: one incumbent, one-param
challengers). For a wallet-source idea: the harvester + the DISCOVERY_SOURCES row id.>

## Pre-registered predictions (write BEFORE validating; each on the -lag twin, each with a kill criterion)
- **P1 — <claim>.** PASS if <concrete threshold on the -lag twin — e.g. net/trade > 0 AND
  drop3 > 0 at n≥100>; FAIL / KILL if <threshold — e.g. drop3 ≤ 0 at n≥100>.
- **P2 — <claim, e.g. beats the OG control>.** PASS if <the copy-src probe beats copy-tp100-sl30-lag
  on BOTH net/trade AND drop3/trade at n≥100>; KILL if <FAILS on either>.
- **P3 — <claim, e.g. reachability / fire-rate>.** PASS if <fires ≥ X/day by day 3>; if it
  can't reach n≥100 in <window>, the gate over-filters or the source misses the copyable universe → shelve.
- **Decision rule:** promote to a gated lab strategy (or a shadow slot) only if <which predictions
  must pass>; if <…>, shelve the lever/source. (State it now so results can't be re-scoped.)

## Probe plan
- **Path (a) gate/exit/sizing:** a `COPY_STRATEGIES` entry perturbing one lever **plus its `-lag`
  twin**, shadow-traded toward n≥100. Fresh strategy id (reused ids inherit stale `retired_summary` rows).
- **Path (b) wallet source:** a harvester tagging `wallet_candidates.source = '<id>'` (INSERT OR
  IGNORE) + one `DISCOVERY_SOURCES` row → auto-emits the standardized `copy-src-<id>` probe
  (lag5 + drift10, TP100/SL30, **no lead-quality gate**) vs the OG control `copy-tp100-sl30-lag`;
  read the verdict on `copy-trades.json → discovery_scorecard`. Confirm the source's smart set is
  actually subscribed on the watchlist (the 07-04 gap kept every probe at n=0).
- **Path (c) offline pre-check:** a read-only replay or an `ops`-branch DB query
  (`{"type":"db","sql":"SELECT …","max_rows":N}` → `ops/result.txt`) where existing data supports a
  cheap pre-check before committing a slot. Read-only; the ops runner never redeploys.
- **Point-in-time construction:** <which fields are knowable at entry; how look-ahead/survivorship
  is excluded — the smell test passes>.
- **Promotion result:** <what the probe must show to earn a shadow slot or a gated strategy>.

## Cost + capacity
- **`-lag` / cost math:** <expected edge on the 5s twin after round-trip cost + slippage; drop3 expectation>.
- **RPC/WS cost to test:** <does it grow the watchlist (WS-billed, the dominant cost) or scoring
  volume? or is it a zero-RPC cached gate?>.
- **Capacity / reachability:** <estimated fire-rate on the copyable universe → days-to-n≥100>.

## Correlation
- **Vs current book:** <what return driver it shares or doesn't with the incumbent / live strategies>.
- **Value to the SOL goal:** <why it helps — a new uncorrelated source/signal, or incremental
  robustness on a proven one>.
```

## Where the artifact goes
This thesis is the bridge into the validation machinery:
- **In the repo:** it becomes an operator-approved code edit — a `COPY_STRATEGIES` entry (+ its `-lag`
  twin) or a `DISCOVERY_SOURCES` row (+ a harvester) → PR into `main` → deploy → the bot shadow-collects
  → the daily/lab skills read `copy-trades.json` and journal the verdict in `docs/copy-strategy-lab.md`.
  A wallet source runs its `copy-src-<id>` probe to a `BEATS_OG`/`FAILS` scorecard verdict at n≥100
  before it earns any gated variant (discovery discipline: one probe per source until it beats OG).
- **Generically:** it enters `solana-strategy-phase-2` at **Phase 1** (thesis) / **Phase 3** (implement
  as a code-defined strategy + `-lag` twin) with the thesis and predictions already articulated — no
  further generative work. The Phase-3 monitor (`/solana_loop_checker_phase3`) then tracks its
  n / net / drop3 / stress / monthly toward the promotion bar.

The idea model's job ends here: a pre-registered, falsifiable, cost-aware, survivorship-safe, testable
copy-thesis, ranked by its expected contribution to accumulating SOL. Validation takes it from there.

---

## Part C — Binding-constraint handoff (Phase 4, when no signal clears)

When the screen promotes **zero** signal theses, do NOT manufacture a weak one to fill a slot. The
North-Star deliverable is the highest-EV change toward SOL accumulation, and that is often a
non-signal change (capacity / execution-cost / measurement) or the honest conclusion that no edge on
the current data clears the realistic-cost bar. Write it with the *same* pre-registration rigor as a
thesis — this is a success state, not an empty cycle. The 2026-07-12 D1/D3 handoff is the worked example.

```markdown
# <NAME> — <binding-constraint / non-signal change, one line>

*Diagnosis written <date>; the observable + revert criterion below are pre-registered.
Category: <capacity | execution-cost | measurement | no-edge-at-realistic-cost>. Voice: proposal.*

## Verdict
<"No positive-EV signal this cycle; the binding constraint is <X>." OR "No edge on the current data
clears the realistic-cost bar; the goal now needs <lower execution cost | a genuinely new data
input>, not another gate.">

## Evidence
<The Phase-0.5 calibration table + the Phase-3 screen results that rule the signal lane out, and the
live-board / cost / measurement data that points at the real constraint.>

## Recommended change
<The exact non-signal change: a config default (capacity), an ops-DB read-only study (cost/
measurement), a harvester/flag fix (integrity) — or, for no-edge, the specific data input or
cost-reduction the goal would require. One lever, like a signal thesis.>

## Pre-registered observable + revert/kill criterion
- **P1 — <the metric that confirms it worked>.** PASS if <threshold in a stated window>; REVERT/FAIL
  if <threshold> (instant revert for a config; shelve-with-reason for a study).
- <further Ps as needed — same discipline as a signal thesis: no post-hoc re-scoping.>

## Why this beats a signal thesis this cycle
<Expected SOL contribution vs the best available signal candidate — why fixing the constraint, or
declaring no-edge, is higher-EV than spending a slot on a marginal/correlated overlay.>
```

A category-2/3/4 change usually ships as an operator-approved config/code edit or a read-only
`ops`-branch DB study (no shadow slot consumed); a "no-edge-at-realistic-cost" verdict ships as a
recommendation (change the inputs) rather than a probe. Either way it lands in `docs/copy-strategy-lab.md`
and, next cycle, into the Phase-0.5 calibration table.
