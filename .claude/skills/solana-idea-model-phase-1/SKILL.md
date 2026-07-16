---
name: solana-idea-model-phase-1
description: |
  Generate and screen NEW copy-trading strategy ideas for the Solana (post-graduation PumpFun) bot, then decide which are worth validating. Use whenever the user wants new copy-strategy ideas, edges, levers, or angles to test; asks "what should we try next", "find me new strategies", "brainstorm copy edges", or "what's the next lever"; wants to survey the arena for open slots or saturated levers; or wants to judge whether an idea is novel/uncorrelated enough to promote to shadow-trading. This is Phase 1 — the divergent front-end that feeds the build-and-validate pipeline (`solana-strategy-phase-2`) and is fed by the Phase-3 monitor loop (`/solana_loop_checker_phase3`). It grounds in the incumbent, the lab ledger, the −935 SOL graveyard, and its OWN past-thesis hit-rate, generates an anti-anchored slate across signal AND non-signal categories (capacity, execution-cost, measurement), screens it, and either promotes survivors as pre-registered falsifiable theses with a probe plan OR — when no signal clears — diagnoses the binding constraint as a pre-registered non-signal change. The deliverable is the highest-EV change toward SOL accumulation, not necessarily a new signal. Do NOT revive the retired graduation-arb line, do NOT skip the survivorship gate, and do NOT manufacture a signal thesis to fill a slot.
---

# Solana Idea Model — Phase 1 (generate, screen, promote)

The divergent front-half of the copy-trading pipeline, the Solana counterpart to `kalshi-idea-model`. Its job is **breadth then judgment**: enumerate many candidate copy-edges, then cut hard to the few worth a probe. It is deliberately *not* a validator — validation is the repo's job (shadow book → n≥100 → live_micro) and the `solana-strategy-phase-2` skill's Phases 1–6. This skill produces the artifact that pipeline consumes: a **pre-registered, falsifiable copy-thesis + a probe plan**.

**Runs in chat.** Every step here is doable with chat tools — reading the repo over GitHub (`bot-status` branch for live state, `main` for code), reasoning. It never needs to *run* a probe or touch live money, so it needs no Railway/DB write access; it stops at specifying the probe.

**North star (from the repo's CLAUDE.md):** a copy-strategy that **accumulates SOL after realistic execution**, on n ≥ 100 trades, with the edge surviving removal of its top 3 winners (drop3 > 0), clearing **≥ 3.75 SOL/month** (~$300/mo, covers infra) per live strategy. Rank everything by expected contribution to that. Value uncorrelated ballast — an edge that doesn't share a return driver with the current book is worth more than a marginally better one that does. **Ruling an idea out is a win.**

**The deliverable is the highest-EV *change* toward that goal — a new signal is only one kind.** This skill historically emitted entry-gate / wallet-source theses, but the goal is SOL accumulation, and the binding constraint is often *not* a missing signal. Generate across **four candidate categories** and rank them together by expected SOL contribution:
> 1. **Signal** — a new edge / gate / wallet-source (the classic output).
> 2. **Capacity / supply** — the proven edge is throttled (watchlist cap, scoring backlog, fire-rate); un-throttling it lifts every strategy at once.
> 3. **Execution cost** — the shadow bar mis-prices real fills, so a "promising" shadow is a live loser (or the reverse); reconciling it is pure EV.
> 4. **Measurement / integrity** — a scoreboard bug, a survivorship leak, or a stale flag distorts every downstream decision.
>
> A cycle whose honest answer is *"no positive-EV signal exists — the binding constraint is category 2/3/4"* is a **success**, not an empty cycle (the 2026-07-12 D1 supply-unlock + D3 cost-reconciliation were worth more than any tenth entry-gate overlay). And a cycle whose honest answer is *"no edge on the current data clears the realistic-cost bar — the goal now needs lower execution cost or a genuinely new **data input**, not another gate"* is the single most valuable thing this skill can say when it's true. **Never manufacture a signal thesis to fill a slot.**

**Idea generation ≠ idea validation.** The failure mode this skill exists to prevent is rigorously validating a narrow, anchored idea set — the bot has ~150 dead strategies / 32k paper trades proving that excellent process on the wrong idea just produces validated garbage. Diverge first (Phase 2), converge second (Phase 3). Do not let the screen contaminate the generation.

**Where this sits in the loop.** Phase 3 (`/solana_loop_checker_phase3`, the read-only monitor) surfaces *when* new ideas are needed — a lever capped, a discovery source `FAILS`, a slot opened under `MAX_INFLIGHT`, the incumbent dethroned. This skill (Phase 1) turns that trigger into candidates. `solana-strategy-phase-2` (Phase 2) validates the survivors. Read the monitor's latest ledger and the lab ledger first — they tell you what's saturated and where the open slots are.

```
Phase 0   Ground in what's already been tried  → gate: know the incumbent, the levers, the graveyard
Phase 0.5 Calibrate on your OWN hit-rate       → gate: know which lanes your past theses actually won/lost
Phase 1   Survey the live board                → gate: know the roster, the scorecard, the copyable universe
Phase 2   Diverge — generate a broad slate     → gate: ≥ ~10 candidates across signal + non-signal categories
Phase 3   Screen — score against the rubric    → gate: each candidate scored, not vibes-ranked
Phase 4   Promote — pre-registered thesis/probe OR diagnose the binding constraint (no-signal is a valid output)
```

---

## Phase 0 — Ground in what's already been tried (do this FIRST, always)

The single most valuable thing this skill does is **not regenerate settled questions**. This bot has a large, hard-won graveyard; read it before generating anything. All live state is on the **`bot-status` branch** (you self-serve — the operator does not screenshot dashboards or query the DB); code and docs are on `main`. Pull:

- **`copy-trades.json`** (`bot-status`) → `promotion.rows`, `by_strategy`, `paired_vs_baseline`, `lead_performance`, `discovery_scorecard`, `rpc_usage`. It is **large** — fetch with `curl -sL .../refs/heads/bot-status/copy-trades.json` and slice with `python3`. This is the live scoreboard and the **correlation-and-incumbent baseline**.
- **`docs/copy-strategy-lab.md`** (`main`) — the lab ledger: current incumbent, in-flight challengers and lineage, the resolved log. What's already been perturbed and what's live.
- **`docs/copy-trade-journal.md`** (`main`, newest-first) — what recent daily reviews decided; day/week trends; the `SNAPSHOT` blocks.
- **`docs/discovery-playbook.md`** + the "Resolved so far" table (`main`) — the discovery-source graveyard (cotrade FAILS, live_tape PRUNED, copy-net positive-selection REFUTED) and the standardized measurement contract for any new wallet-source idea.
- **`docs/research-archive/`** and **`references/copytrade-edge-map.md`** — the retired graduation-arb line and the copy-trading dead ends.
- **The `KILLED` / `INVALID` comments inline in `COPY_STRATEGIES`** (`src/copytrade/copy-trader.ts`) — a dated tape of every strategy tried and why it died. Grep for `KILLED` / `INVALID` / `drop3`.
- **`CLAUDE.md`** (`main`) — the mission, the promotion bar, the operating conventions (proposal voice, PR flow, RPC posture).

Then extract the **meta-lessons** — the durable priors for generation. From the current record:
1. **Copy = information asymmetry is the ONLY proven edge.** Copying smart wallets is the sole approach with large-n, drop3-robust positive P&L (n≈3k, +32 SOL, drop3 +12). The edge is that the lead knows/sees something first and you mirror it before decay. **High prior on anything that sharpens *which lead* and *how fresh*; near-zero prior on anything computable from public chart features after the fact.**
2. **The OG wallet base + recency IS the edge — but every attempt to find a *better/additional* source has failed (this prior has INVERTED).** Historically a better base turned a losing control (−0.028/trade) into the promotable incumbent (+0.019/trade), so wallet-source quality *matters* — but that base is the OG graduation seed, and every thesis that tried to find a NEW or better source than it has died: cotrade FAILS, live_tape PRUNED (n=24, unreachable), winner_sniper PRUNED (n=148, −0.048/t — *worse* than unselected OG), external stalled, gradspec frozen. Root cause: own-trading skill doesn't transfer to a 5s-lagged entry-only mirror (r≈0), and non-OG wallets rarely trade the copyable universe (can't reach n≥100). So the old "dig here first" is now **inverted** — the marginal wallet-source frontier is an **empirical graveyard**. **Do NOT lead with a new wallet-source thesis unless it brings a genuinely new DATA input (not a reselection of the same on-chain wallets) AND clears the reachability pre-gate.** Reselecting *who* to follow from the same data is done. *(This is the exact prior that drifted stale and forced a manual override every cycle before Phase 0.5 existed — re-derive it from your own hit-rate table, don't trust this text blindly.)*
3. **Public post-hoc features are dead (−935 SOL).** ~150 strategies filtered on velocity/holders/concentration/snipers/regime: net −935 SOL, zero cleared the bar. Filters reshape the loss, never reverse it. Don't propose a public-feature filter.
4. **Cumulative copy-net neither selects nor vetoes.** All-time copy-net positive-selection was refuted OOS; the proven-bad *veto* was then refuted forward too. **Only the *recency* hot-lead gate holds.** Don't repropose cumulative-net in a new hat.
5. **Exit engineering can't rescue a negative entry.** TP/SL/trail/scale sweeps never flipped a losing entry positive; tighter-than-SL30 stops are poison. **Exit/sizing are low-prior** — don't lead with them.
6. **Net-positive / drop3-negative is a lottery, refused by design.** The biggest raw net in the book (`hold30m`, +24 SOL) had negative, worsening drop3 and was killed. Raw net is the *least* important number.

Re-derive these from the live docs each time — the record evolves. If a lesson has been overturned, use the current version.

**Gate:** You can state the current incumbent (the correlation baseline), the in-flight challengers and open slots, the ruled-out set (the graveyard), and the meta-lessons (the priors). Generating before you've read `copy-trades.json` + the lab ledger + the graveyard is the cardinal sin here.

---

## Phase 0.5 — Calibrate against your OWN track record (not just the arena's)

Phase 0 grounds you in the *arena's* graveyard (every strategy ever). This step grounds you in **this skill's own hit-rate** — the discipline that keeps its priors from drifting stale. Before generating, pull every thesis prior phase-1 handoffs promoted (`docs/phase1-handoff-*.md` + the `copy-strategy-lab.md` entries that cite them) and score each on three questions:

| promoted thesis | edge-source | was it even TESTABLE? | reached n≥100? | beat the incumbent (net/t AND drop3/t)? |
|---|---|---|---|---|

Then compute the **realized hit-rate by edge-source** and let it *override* the a-priori HIGH/MEDIUM/LOW labels in the generation grid. If "new wallet source" is 0-for-5, it is a low-prior lane **regardless of what the grid says** — the a-priori labels are a starting guess; your own record is the evidence. Two failure modes this catches that Phase 0 alone does not:
- **A stale prior** — the grid still says "wallet-source, dig here first" after five straight failures (the exact drift that forced a manual override every cycle before this step existed). Update the prior; don't re-override it by hand forever.
- **A silently re-scoped or unresolved test** — a prior thesis's pre-registered P1/P2/P3 never got evaluated on schedule, or was quietly reinterpreted. An unresolved pre-registration is a **debt, not a free slot**: resolve it (pass/fail/shelve-with-reason) before spawning anything new in that lane.

**Gate:** you can state your own recent promoted-thesis hit-rate by edge-source, and you have flagged (and where possible resolved) any prior pre-registration that was never closed out.

---

## Phase 1 — Survey the live board

Ground generation in what's *actually contestable right now*, not an abstraction of the bot. Read from `copy-trades.json` and the ledgers:

- **The roster + roles** — who's the incumbent, which challengers are collecting, which controls/references exist, how many slots remain under `MAX_INFLIGHT = 4`. A crowded board means an idea must be *better than a waiting challenger*, not merely positive. **Set your promote budget to the number of slots actually open** (or about to open as a near-dead challenger resolves) — if the board is at cap with nothing near resolution, the correct promote count may be **zero**; a thesis that queues for weeks decays in relevance and forces an operator override. Rank survivors against the *waiting queue*, not just the incumbent.
- **Per-strategy return drivers** — what signal each live strategy keys on (hot-lead recency, consensus, freshness). This is the **correlation map** for Phase 3: two strategies keying on the same leads/signal move together.
- **The discovery scorecard** (`discovery_scorecard`) — which wallet *sources* are live, their funnel state (candidates → scored → smart_copyable), and verdicts (`BEATS_OG` / `FAILS` / `COLLECTING` / `NO_WALLETS`). A `NO_WALLETS` source is a funnel problem worth a fresh harvester idea; a `FAILS` source is a closed question.
- **The copyable universe + wallet supply** — `wallet-leaderboard.json` (scored/promotable wallet count and growth), `smart-money.json` (does token *selection* carry edge), `copy-probe.json` (lead-event rate + follower-detection latency). This bounds capacity: a gate that fires twice a day can't reach n≥100 in a reasonable window.
- **RPC/WS headroom** (`rpc_usage`) — the dominant cost is **watchlist size on the WebSocket** (billed per delivered message), not strategy count. Any idea that grows the watchlist (a new source's smart set) has a standing cost even before it earns its keep. Know the current ceiling.

**Gate:** You know the incumbent's lever, the open slots, which sources are live/dead, roughly how much copyable flow exists, and where the RPC/WS ceiling sits — enough to judge which levers are even worth pushing.

---

## Phase 2 — Diverge: generate a broad candidate slate

Now generate widely. Read `references/generation-grid.md` — the fountain: the **four levers** (which-wallets/discovery, entry-gating, exit, sizing) crossed with **edge-sources** (where the asymmetry comes from) and **point-in-time signals** (the fresh, at-entry-knowable quantity you'd key on). Walk the levers as the outer loop.

Rules for this phase:
- **Breadth before judgment.** Get ≥ ~10 candidates on the table before scoring any. Include some you suspect are weak — coverage is the point, and weak-looking ideas sometimes survive for a non-obvious reason.
- **Anti-anchor — this bot's gravity is strong.** The pull here is toward *another exit tweak on the same wallets* or *another hot-lead net-floor step*. Those are Phase-2's hill-climb, not new ideas. For every candidate that extends the incumbent's lever, force one that pushes a **different lever or a different edge-source** — especially a new wallet *source* or a new selection signal (consensus, earliness, freshness) with **no shared return driver** with the live book.
- **Weight the priors by your OWN realized hit-rate (Phase 0.5), not the grid's a-priori labels.** Lean toward recency/freshness signals on the OG base (lesson 1); lean AWAY from new wallet-sources (lesson 2 — now a graveyard), public features (3), cumulative-net (4), and exit engineering (5). If a lane is 0-for-N in your calibration table, it needs a genuinely new *ingredient* (new data, not another variant) to re-enter the slate. A prior is a starting weight; your track record and the screen do the cutting.
- **Reachability is a PRE-gate, not just a screen axis.** Before you write a full candidate line for any wallet-source or narrow gate, estimate its fire-rate on the copyable (post-grad PumpFun) universe. If it can't plausibly reach **n≥100 in the readable window** (the `live_tape` n=24 / gradspec-frozen death), it does **not** go on the slate — reachability has killed more theses here than edge has. For a wallet-source the concrete question is "do these wallets actually trade fresh graduations at ≥ ~3/day", answered *now*, not in screen-axis 5.
- **When the signal lane is saturated, generate the non-signal categories too.** If your calibration table + the live board say the signal frontier is exhausted (every divergent candidate keeps screening to the same graveyard reasons), do **not** force a tenth correlated overlay — put capacity/supply, execution-cost, and measurement candidates (North-Star categories 2–4) on the same slate and screen them head-to-head with the signals by expected SOL contribution.
- **Every SIGNAL candidate is anchored by a point-in-time signal.** A signal candidate without a concrete, at-entry-knowable signal is just an opinion — don't slate it. (And a signal that resolves *after* entry is disqualified on sight — see the survivorship gate.) *(Non-signal candidates in categories 2–4 are anchored instead by a measurable observable + a revert/kill criterion — see Phase 4.)*
- **Each candidate is one line:** lever/category × edge-source, the fresh signal (or the observable, for non-signal), and the one-sentence edge ("this lead/token class keeps entering winners early and the crowd can't identify it fast enough because X" / "the proven edge is throttled by X and un-throttling it lifts every strategy").

**Gate:** ≥ ~10 candidates spanning multiple categories, at least a few with zero correlation to the incumbent's return driver, each SIGNAL candidate past the reachability pre-gate. A slate that's all exit-tweaks or all hot-lead-floor-steps fails this gate — widen toward fresh selection-signals on the OG base and (when the signal lane is dry) the non-signal categories.

---

## Phase 3 — Screen: score every candidate against the rubric

Now converge. Read `references/screening-and-handoff.md` for the full rubric. Score each candidate — don't rank on vibes. The axes, ordered by how often each *kills* an idea here:

1. **Correlation to existing books AND the waiting queue** (the portfolio lens). Does it share a *return driver* with a live strategy — the same leads, the same signal? All hot-lead net-floor variants correlate with the incumbent; a genuinely new wallet source or a consensus/earliness signal on different leads is more uncorrelated. Shared driver → heavily penalized *even if the edge is real* (adds variance, not diversification). Uncorrelated → bonus toward the SOL-accumulation goal. **Compare against the queued challengers too, not only live strategies:** if a survivor shares a driver with a thesis already waiting for the next slot and isn't clearly better, it's a HOLD — don't spend the slot on a near-duplicate of what's already in line.
2. **Edge plausibility given the graveyard.** Is it information-asymmetry that could survive the `-lag` twin (high prior), or is it really a public-feature filter / cumulative-copy-net / exit-lottery in a new hat (dead)? Name *why the lead has the edge* and *why it persists* (the decay race — the crowd can't identify these leads/tokens fast enough).
3. **Survivorship / point-in-time safety** — *the Solana-specific hard gate; kills silently.* Does any field the idea keys on resolve **after** entry time? The `holders≥250 (backfill)` filter showed +24% and "ROBUST" and was recommended for deployment 5+ times — it was pure survivorship (backfill re-resolves holder count after the outcome), and **walk-forward train/test cannot detect it** because both halves share the contaminated feature. Any at-entry-unknowable signal is poison, however good it looks. An idea that leans on one is dead on arrival — reject it here.
4. **Execution / cost survival.** Estimate the edge on the **`-lag` twin** (5s entry delay + round-trip cost + slippage), never the idealized ~1.1s mirror (upper bound only, score-capped at 80, never live). The edge is a decay race — if 5s kills it, it isn't capturable. Require **drop3 > 0** (net after removing the top 3 trades; net-positive-but-drop3-negative is a lottery). For a live-bound idea, add the live-only costs (Jito tip, ATA rent, priority fees, land rate).
5. **Capacity / n≥100 reachability** — *this should already be a Phase-2 PRE-gate; here it's the second check.* Can it reach n≥100 on the copyable universe with drop3 holding, in a readable window? The `live_tape` source was pruned precisely because its wallets rarely traded the copyable graduation universe (stuck at n=24 for days); gradspec froze the same way. A gate so strict it fires a few times a day, or a source whose wallets don't touch post-grad PumpFun, can't build a track record. **Reachability has killed more theses here than edge has** — if a candidate reached the screen without a Phase-2 fire-rate estimate, that's a process miss, fix it before scoring. A great edge that fires 10 times is a hobby, not 3.75 SOL/mo.
6. **Infra / RPC reuse** — *speed-and-cost multiplier.* Which existing machinery does it reuse — the `COPY_STRATEGIES` chassis + `-lag` twin, the `DISCOVERY_SOURCES` registry (a new source = one row + a harvester), the winner-sniper funnel, the standardized `copy-src-<id>` probe? AND its RPC/WS cost: does it grow the watchlist (WS-billed, the dominant cost) or scoring volume? High reuse + low marginal RPC → cheaper and faster to a verdict → promote sooner among near-ties.

Produce a scored table (candidate × the six axes + a promote/hold/kill call and a one-line reason). Be blunt; most candidates should not promote. Killing an idea *here*, before a probe, is the cheapest possible win.

**Gate:** Every candidate scored on all six axes with an explicit call, and the survivorship gate applied to each. Typically 1–3 promote.

---

## Phase 4 — Promote: pre-registered thesis + probe plan

For each survivor, produce the handoff artifact in the repo's format (template in `references/screening-and-handoff.md`), matching a `copy-strategy-lab.md` ledger entry:

- **One-liner** — the copy-edge in a sentence a trader would recognize (which lever, which leads/tokens, the signal).
- **Mechanism** — what asymmetry, who the lead is and why they're ahead, why it persists (the decay race / the crowd's blind spot), and which edge family it's in.
- **The one lever changed** — name the single lever/param perturbed vs the incumbent (Phase-2 discipline is one incumbent, one-param challengers). For a wallet-source idea, name the harvester + the `DISCOVERY_SOURCES` row.
- **Pre-registered falsifiable predictions (P1…Pn)** — written *before* any validation, each with a concrete pass/fail threshold **on the `-lag` twin** and a kill criterion (e.g. "drop3 > 0 at n≥100", "`-lag` net/trade beats the OG control on BOTH net/trade and drop3/trade", "fire-rate ≥ X/day by day 3 or the gate over-filters"). This is the load-bearing part and the whole reason to write the thesis before probing — it stops the test being quietly re-scoped.
- **Probe plan** — the exact validation path: either (a) a `COPY_STRATEGIES` entry perturbing one lever **plus its `-lag` twin**, shadow-traded toward n≥100, or (b) a wallet-source: a harvester tagging `wallet_candidates.source` + one `DISCOVERY_SOURCES` row → the standardized `copy-src-<id>` probe (lag5+drift10, TP100/SL30, no lead gate) vs the OG control, read on the scorecard; or (c) an offline replay/`ops`-branch read-only DB query where the data supports a pre-check. State the **point-in-time construction** (which fields are knowable at entry) and the **result that promotes it** to a shadow slot or a gated strategy.
- **Cost + capacity note** — the `-lag`/cost math, the drop3 expectation, the RPC/WS cost to even test (watchlist growth?), and the fire-rate → n≥100 timeline.
- **Correlation note** — what return driver it shares or doesn't with the live book, and what that's worth to the SOL-accumulation goal.

That artifact is the bridge into the validation machinery: it enters `solana-strategy-phase-2` at its **Phase 1** (thesis) / **Phase 3** (implement as a code-defined strategy + `-lag` twin) with the thesis and predictions already articulated — no further generative work. In the repo it becomes a `COPY_STRATEGIES` entry or a `DISCOVERY_SOURCES` row (operator-approved code edit → PR into `main` → deploy → shadow data), logged in `docs/copy-strategy-lab.md`.

**If no candidate clears the screen — say so, and diagnose the binding constraint instead of manufacturing a thesis.** This is a valid, sometimes-correct Phase-4 output, not an empty cycle. Write it with the same rigor as a thesis:
- **The verdict** — one of: *"no positive-EV signal this cycle; the binding constraint is <capacity / execution-cost / measurement>"* (a category-2/3/4 change), or *"no edge on the current data clears the realistic-cost bar; the goal now needs <lower execution cost / a genuinely new data input>, not another gate."*
- **The evidence** — the calibration table + screen results that rule the signal lane out, and the data pointing at the real constraint.
- **The recommended change + a pre-registered observable** — the exact non-signal change (config, harvester, ops-DB study), the metric that would confirm it worked, and the revert/kill criterion — same pre-registration discipline as a signal thesis. A category-3/4 change may be an offline `ops`-branch read-only study rather than a shadow probe.
- The **2026-07-12 D1 (supply-unlock) + D3 (cost-reconciliation) handoff** is the worked example of this output.

**Gate:** Either each promoted idea is a self-contained pre-registered thesis with falsifiable `-lag`-twin predictions and a runnable probe plan — OR, when nothing clears, a pre-registered binding-constraint diagnosis with a recommended non-signal change and its confirm/revert criteria. Manufacturing a weak signal thesis to avoid the second outcome is the failure mode, not the second outcome itself.

---

## Guardrails

- **Ground before you generate.** Read `copy-trades.json` + the lab ledger + the graveyard first; never regenerate a ruled-out idea without naming a specific, material difference.
- **Breadth before judgment.** Don't let the screen suppress generation; get the slate on the table first.
- **Push the lever your OWN track record rewards, not the grid's a-priori "highest".** Recency/freshness signals on the OG base still move edge; new wallet-sources are now a graveyard (calibrate in Phase 0.5 — don't lead there without a new *data* input); exit/sizing rarely move anything. Anti-anchor away from BOTH another exit variant AND another same-data source reselection.
- **Calibrate on your own hits (Phase 0.5).** Weight generation by your realized promoted-thesis hit-rate by edge-source, and resolve any dangling pre-registration before spawning new theses in that lane. Priors drift stale; your track record doesn't lie.
- **Be willing to conclude "no signal — change the inputs".** The deliverable is the highest-EV change toward SOL accumulation, not a signal per se. If the honest answer is a capacity/cost/measurement fix, or "no edge clears realistic cost", that IS the output. Never manufacture a thesis to fill a slot.
- **Promote to open slots, ranked against the queue.** Promote count = slots actually open (or about to open); if the board is at cap with nothing resolving, zero is a valid promote count. A survivor that isn't clearly better than a queued challenger is a HOLD.
- **Correlation is a first-class screen.** A hot-lead-floor variant is not a new idea — measure the shared return driver, not the surface. Screen against the queue, not only the live book.
- **Survivorship is the silent killer.** Any field resolved after entry time is poison and invisible to walk-forward. Reject at-entry-unknowable signals on sight.
- **Judge the `-lag` twin, never the idealized mirror; drop3 > 0 or it's a lottery.** The 1.1s mirror is an upper bound (score cap 80), never live. Net-positive with negative drop3 is 1–3 outliers.
- **Reachability is a PRE-gate.** Estimate fire-rate BEFORE writing a thesis; an edge that can't reach n≥100 on the copyable universe (the `live_tape` n=24 / gradspec-frozen lesson) never goes on the slate. It has killed more theses here than edge has.
- **Pre-register predictions.** Promoted theses AND binding-constraint diagnoses state falsifiable predictions with kill/revert criteria *before* validation runs — no post-hoc re-scoping.
- **This skill stops at the probe spec.** It does not run probes, touch live money, or need Railway/DB write access — it hands a pre-registered thesis to Phase 2. Proposal voice only (the operator reviews code and deploys). Not investment advice; validated edges still go through shadow and small live_micro sizing behind the circuit breaker.
- **Stay in the copy-trading mission; graduation-arb is retired** — don't revive it without explicit operator direction (graduation *detection* stays, to seed discovery).

---

## Reference files
- `references/generation-grid.md` — the divergent engine: the four signal levers × edge-sources × point-in-time signals (with the **inverted** wallet-source prior flagged), the reachability pre-gate, and the **non-signal categories** (capacity / execution-cost / measurement) with worked examples. **Read for Phase 2.**
- `references/screening-and-handoff.md` — the six-axis screen grounded in the bot's reality (survivorship, `-lag`/drop3, reachability-as-pre-gate, queue-aware correlation), the pre-registered-thesis + probe-plan template (Part B), and the **binding-constraint / no-signal handoff template (Part C)** for handoff to `solana-strategy-phase-2`. **Read for Phases 3–4.**
