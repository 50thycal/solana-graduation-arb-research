# Phase-1 Idea-Model Handoff — 2026-07-13

*Produced by `/solana-idea-model-phase-1` (divergent front-end). Runs in chat; stops at the probe
spec. **Proposal voice** — every change below is a proposal for the operator to review + deploy,
never past tense. Nothing here touches live money or edits `COPY_STRATEGIES`. Survivors enter
`solana-strategy-phase-2` at its Phase 1 (thesis) / Phase 3 (implementation) with the pre-registered
predictions already articulated. Previous handoff: `docs/phase1-handoff-2026-07-12.md` (D1/D3 —
both enacted same-day; D1 deployed 07-12, D3 completed with follow-ups enacted).*

**This cycle is operator-seeded:** the operator pre-agreed three candidate levers in chat — (A) lead
alpha-lifecycle/tenure decay, (B) a book-level own-edge regime gate, (C) D2 forward copy-net trial
rotation — and directed a full Phase-1 pass with them as priority candidates. Per the skill's rules
they compete on the same six-axis screen as everything else (no rubber-stamping); the screen's
verdicts are below.

---

## Phase 0/1 — grounding (what's contestable *right now*, 2026-07-13 01:57 UTC scoreboard)

**Incumbent / correlation baseline.** `copy-hotlead-strict-hi` — hot-lead recency gate
`{lastN:10, minTrades:3, minNetSol:1.0}`, TP100/SL30, lag5 + drift10. n=155, net +4.21, net/trade
+0.02714, drop3/trade +0.01295, score 82.6, **sole promotable** — and **degrading** (recent 51
trades −0.0307/t vs prior +0.0555/t, WR .375→.275) with the **exit-stress margin at +0.259**, one
bad cluster from failing the same gate that killed strict. `n_promotable_stable = 0`.

**The board changed materially since the 07-12 handoff:**

1. **`copy-hotlead-strict` was PRUNED 2026-07-12** (operator-approved, commit `7b20642`): the 6%
   re-cost collapsed its exit_stress +4.84 → −10.14 and the arena flipped to PRUNE — dominated by
   strict-hi on both net/trade (0.013 vs 0.029) and drop3/trade (0.005 vs 0.014). **This was
   pre-predicted by the 07-12 D3 study** ("strict likely slips below the bar while strict-hi
   holds") and confirmed within a day — a direct hit for the measurement lane.
2. **D1 `copy-watchlist-unlock` is DEPLOYED** (PR #556; watchlist_size now 150, process up ~7h at
   read time). T0 baseline recorded: **173 leads / 49 hot**; day-7 read lands **~07-19** (P2: leads
   ≥200, hot ≥65, incumbent fires ≥7/day; P2 failure kills D2-by-proxy).
3. **The whole roster below the incumbent is pre-n≥100:** nine challengers (fable dip 18 /
   leadpullback 22 / deep 28 / freshdip 49 / freshdip-bounded 10, hotlead-early 52, C4 nodump 21,
   C5 breadth 17) + two probes (gradspec 4 — funnel frozen; external 13). `hotlead-fresh` is queued
   for the first freed slot. **Zero open shadow slots**; the board is >2× the MAX_INFLIGHT cap by
   standing operator override.
4. **The 6% re-cost skews every young-vs-old comparison** for ~1–2 weeks: new closes are 6%-costed,
   the incumbent's history is mostly 3%-costed; the challengers' ugly starts (C4/C5 at −0.11/t) and
   part of every `degrading` flag are confounded by the cost era mix. The arena also still names the
   pruned `copy-hotlead-strict` as the challengers' benchmark (a ghost).

**Meta-lessons (re-derived; two updated this cycle):** info-asymmetry via recency on the OG universe
is the only surviving edge; the wallet-*source* frontier is an empirical graveyard (own-skill ≠
copyable, r≈0 transfer + reachability walls); public post-hoc chart features are dead (−935 SOL);
cumulative copy-net neither selects nor vetoes; exit engineering never flips a negative entry;
net-positive/drop3-negative is a refused lottery; buy weakness, not strength. **Updated:** (i) the
07-12 "strict recovered → regime-noise reading" was premature — strict was pruned within a day and
strict-hi is degrading again; the honest current reading is that the **hot-lead family's edge is
intermittent or decaying at the wallet level**, and the book has no model of which; (ii) the
**backtest-first lane decays hard out-of-sample** — freshdip's spawning backtest read +19.0 net /
xt3 +11.7 on the subset, live forward it sits at **−1.93 at n=49**; dip/leadpullback/deep are
younger but none is tracking its backtest. Any new offline-study thesis must treat in-sample fit as
the null and pre-register split-half persistence.

---

## Phase 0.5 — calibration on this skill's OWN promoted-thesis record

| promoted thesis (handoff) | lane | testable? | reached n≥100? | beat incumbent? | status |
|---|---|---|---|---|---|
| gradspec (07-05) | wallet-source | **NO** — funnel frozen by the 07-09 credit retune (prefilter default-OFF; `entered_24h: 0`) | n=4 | — | **dangling pre-registration; day-7 fallback due TODAY 07-13** → resolve as **shelve-as-untestable** (not FAILS — the test never armed) |
| hotlead-early (07-05) | entry-gate (earliness) | yes | n=52 | trending NO (−0.046/t vs incumbent +0.027/t; drop3/t −0.083, worsening) | on track to KILL; nearest natural slot-free |
| C4 nodump (07-11) | entry-gate (sell-flow veto) | weakly — the veto has fired only **3× in 21 entries** (low test power) | n=21 | too early (−0.115/t, all 6%-costed) | unresolved |
| C5 breadth (07-11) | entry-gate (per-lead cap) | weakly — cap fired 6× in 17 | n=17 | too early | unresolved |
| D1 watchlist-unlock (07-12) | **capacity (non-signal)** | yes — deployed 07-12 | n/a | n/a | in-flight, observables day-7 ~07-19 |
| D3 live-cost-recon (07-12) | **measurement (non-signal)** | yes — completed same-day | n/a | n/a | **RESOLVED — HIT**: found the 3% cost under-pricing, drove the 3→6% recost, correctly predicted strict's fall, blocked a live funding mistake |

**Realized hit-rate by lane:** signal theses **0 hits** (1 untestable, 1 trending-kill, 2 pending
with low lever-fire counts); non-signal theses **effectively 2-for-2** (one resolved hit, one
cleanly deployed and reading on schedule). The a-priori grid ordering is therefore overridden
exactly as it was on 07-12: the entry-gate overlay lane is saturated AND empirically cold; the
wallet-source lane stays closed absent a new data input; the highest-yield recent work has been
**models of why the scoreboard/edge behaves as it does**. The operator's three seeds fit that
pattern — A and B are *models of the edge's intermittency*, C is a supply pipeline — which is why
they were seeded, and the screen below still gets to kill them.

**Dangling pre-registrations flagged:** gradspec day-7 (resolve today, above);
`hotlead-fresh` still queued (its hold trigger — freshdip resolving — hasn't fired); C4/C5's P3
fire-rate checkpoints (≥3 fires/day by day 5, due ~07-16) should be read against the **post-D1**
event baseline, not the starved pre-D1 one.

---

## Phase 2 — the slate (diverge; screened in Phase 3)

Anti-anchoring note: gravity this cycle is a tenth overlay on hot-lead entries (lane full and cold)
or another wallet-source (graveyard). The slate pushes instead on the **edge-lifecycle dimension**
(when is the proven edge alive — at the wallet level (A1) and the book level (B1)), the **supply
pipeline** (C1, S1), **microstructure** (D5/D6 carried holds), and **measurement** (M1), plus
coverage slots that will screen to kill.

| # | lever × edge-source | point-in-time signal (at-entry-knowable?) | one-sentence edge |
|---|---|---|---|
| **A1** | **which-wallets × alpha-lifecycle / decay-stage** *(operator seed A)* | lead's **hot-tenure** (time since its rolling last-10 baseline copies first cleared the hot bar, prior closes only) + **our Nth copy of this lead** — both from our own recorded series | hot leads have a finite alpha half-life (crowding / their edge fading); the book trades a 3-week-old hot lead exactly like a fresh one — the observed book-wide decay is what wallet-level alpha decay looks like |
| **B1** | **book-level timing × own-edge regime** *(operator seed B)* | trailing K-trade rolling net/trade of the strategy's **own closed rows** (strategy-endogenous, zero market covariates) | the edge is demonstrably intermittent (strict: degrading→stable→pruned inside 5 days); the book eats the dead stretches in full — stand down when its own forward edge is measurably dead |
| **C1** | **which-wallets × capacity/supply** *(operator seed C = D2 held)* | our forward copy-net on trial-subscribed wallets (internal, forward-only) | manufacture new hot leads by rotating scored candidates through trial slots and graduating on the only metric proven to transfer |
| D5 | entry-gate × lead behavior *(carried hold)* | lead's prior buys of this mint in last N h (`copy_probe_events`, cached) | copy only a lead's FIRST touch — re-buys are averaging-down |
| D6 | entry-gate × microstructure *(carried hold)* | lead buy SOL ÷ `pool_quote_sol` at fill (recorded since 07-10) | relative impact = urgency; data matures ~07-24 |
| **M1** | **measurement × integrity** | n/a (scoreboard change; observables pre-registered) | the arena benchmarks challengers against a **pruned ghost** (`copy-hotlead-strict`) and mixes 3%-era and 6%-era rows in every cumulative and trend number — every PRUNE/PROMOTE verdict for the next ~2 weeks inherits the distortion |
| S1 | capacity × subscription layer | n/a | smart-set tier expansion (watchlist 150→~330) — D1's explicitly-deferred second step |
| A2 | entry-gate × crowding on the lead | count of distinct smart buyers who copied this lead's recent entries | fade leads whose entries the smart crowd now piles into — but our only observable crowd is the consensus family already tested (early failing) |
| T1 | entry-gate × session timing | UTC hour / day-of-week at entry | session effects on memecoin flow — timing-gate family (regime-mid/hi, macro, hotlead-regime) is a uniform graveyard |
| E1 | exit × any (coverage) | — | exit engineering — dead prior |
| Z1 | sizing × conviction (coverage) | — | sizing isn't alpha — dead prior |
| W1 | which-wallets × new data input (coverage) | — | the only thing that re-opens the source lane is genuinely NEW data (social/mempool/off-chain), none of which is wired today |

Reachability pre-gate notes: A1/B1/M1 are offline studies (no fire-rate question until a deployment
form exists; A1's P3 below pre-registers the retained-fire-rate floor). C1's reachability is exactly
what D1's day-7 read measures. D5/D6 are zero-RPC cached gates on the incumbent's flow. T1/A2/E1/Z1/W1
are coverage entries expected to die at the screen.

---

## Phase 3 — six-axis screen

Axes: **1** correlation (book + queue) · **2** edge plausibility vs graveyard · **3**
survivorship/point-in-time · **4** execution/cost on the `-lag` twin · **5** capacity/n≥100 ·
**6** infra/RPC reuse. (++ strong / + ok / ~ weak / − kill-level.)

| # | 1 corr | 2 edge | 3 surv | 4 exec | 5 cap | 6 infra | call | one-line reason |
|---|---|---|---|---|---|---|---|---|
| **A1** | ~ (same leads, but models their decay rather than adding an overlay; informs supply policy) | ++ (directly explains the observed book-wide decay; recency-family — the proven edge shape) | ++ (tenure/Nth-copy derived from our own PRIOR closes only) | + (studied on recorded `-lag` rows; deployment form judged at 6%) | + (P3 pre-registers the retained-fire floor; post-D1 volume helps) | ++ (path (c) ops-DB replay over ~990 recorded rows, zero RPC, **no slot**) | **PROMOTE (offline study)** | cheapest available test of the single most important open question — is the edge decaying at the wallet level — with a deployable gate if confirmed |
| **B1** | + (book-level, above every strategy — competes with nothing in the queue) | + (graveyard-ADJACENT: all market-timing gates died — but those keyed on market covariates; this keys on the strategy's OWN forward realized edge, which the trend field already shows regime-switching) | ++ (trailing net of closed trades, computable at each entry) | + (replay on recorded rows; must beat always-on on drop3, both halves) | ++ (gates the book, doesn't thin any single test below readability — stand-down windows lengthen n-timelines, P3 bounds this) | ++ (path (c) replay, zero RPC, no slot; deployment = a config flag on existing `recencyProfile` machinery) | **PROMOTE (offline study)** | the null (noise-chasing own PnL) is explicitly pre-registered; if the edge-state persistence isn't there, the study kills BOTH the gate and half of A1's premise for free |
| **C1** | + (supply, amplifies rather than competes) | + (forward copy-net is the only metric that transfers; positive-selection graveyard was CUMULATIVE net — this is forward + trial-scoped) | ++ (forward-only by construction) | + | **?** — this is exactly D1's P2 question | ~ (rotation state machine + watchlist rework — real build) | **HOLD (pre-registered trigger 07-19)** | decision rule already registered on 07-12: D1 P2 fail (leads ≤185) kills C1 by proxy; P2 pass defers it (supply not binding); only the middle band argues for building the ranked-rotation half |
| D5 | − (overlay, lane full and cold) | + | ++ | + | ~ | ++ | HOLD | unchanged from 07-12 — offline replay possible, but A1/B1 are strictly higher-information uses of the same ops-DB budget this cycle |
| D6 | − (overlay, lane full) | + | + | + | + | ++ | HOLD | `pool_quote_sol` matures ~07-24; queue the offline replay then |
| **M1** | ++ (zero — measurement layer) | ++ (a recorded, first-order distortion, not a hypothesis) | ++ | ++ | ++ | ++ (small code edit: repoint arena benchmark + expose per-era net/trade; no slot) | **PROMOTE (integrity fix)** | every arena verdict for ~2 weeks is computed against a ghost benchmark on mixed-cost rows; fixing the scoreboard beats any signal this cycle (the D3 precedent) |
| S1 | + | + | ++ | + | + | + (config) | HOLD | sequenced behind D1's day-7 read by design — one supply step at a time |
| A2 | − (consensus family; `early` is failing on this exact driver) | ~ | ++ | ~ | ~ | ++ | KILL | our only crowd observable is the smart set — that's `maxConsensusRecent`, already in-flight and losing |
| T1 | ~ | − (timing-gate graveyard: regime-mid/hi, macro, macro-regime, hotlead-regime ALL negative at n≥30; session-hour is a public feature) | + | ~ | + | ++ | KILL | the lab's durable finding says it verbatim: "avoid spawning more timing gates" — B1 differs by being strategy-endogenous; T1 does not |
| E1 | − | − | — | − | — | — | KILL | dead prior (exit engineering) |
| Z1 | ~ | − | ++ | ~ | + | + | KILL | dead prior (sizing isn't alpha) |
| W1 | ++ | ~ | ? | ? | − | − | KILL (this cycle) | no new data input is actually available/wired; slate it only when one is |

**Survivorship gate applied:** A1's tenure/Nth-copy and B1's trailing-net use only rows CLOSED
before each evaluated entry (reconstruction discipline stated in the probe plans — the same
prior-closes-only construction the 07-10 leadpullback backtest used). C1 is forward-only by
construction. M1 is bookkeeping. No slated idea keys on an after-entry-resolved field.

**Promote count: 2 offline studies + 1 measurement fix — zero shadow slots** (the board is over-cap
with `hotlead-fresh` already queued; nothing here may queue-jump it). This is the same deliberate
shape as the 07-12 cycle: make the existing bets resolve faster and truer, and test the *model of
the edge* before spending slots on more overlays.

---

## Phase 4 — promoted pre-registered theses

### A1 — `lead-alpha-lifecycle` — do hot leads decay, and is the book trading stale ones?

*Thesis written 2026-07-13, before any validation ran; predictions pre-registered. Status: pending
probe (path (c) — offline ops-DB study, zero RPC, no slot). Voice: proposal.*

**One-liner.** Bucket every recorded hot-lead copy by the lead's **hot-tenure** (how long it had
been continuously hot at entry) and by **our Nth copy of that lead**; if the edge concentrates in
young-tenure / low-N leads and the recent degrading windows skew old, the book's decay is
wallet-level alpha decay — and a freshness-of-lead gate (or rotation policy) is the deployable fix.

**Mechanism.**
- *What asymmetry:* the hot-lead gate is a *level* detector (is the lead's last-10 net ≥ X?) with no
  concept of *age of the streak*. If a hot lead's edge decays after it becomes hot (crowding — other
  copiers find it; or its own alpha fades), the gate keeps firing on it long after the edge is gone,
  and the whole family degrades together — exactly what the board shows (every hotlead variant
  decaying at once while the unselected baseline `copy-tp100-sl30` trends *improving*).
- *Why it persists:* nothing in the book models it; `leadExclusionGate` prunes only realized losers
  (backward-looking level, again), not aging winners.
- *Edge family:* recency/freshness on the OG base — the one family with a live prior — applied to
  the *lead* dimension instead of the token dimension.

**The one lever changed.** None yet — this is a study. The pre-declared deployment form, if
confirmed: ONE new gate on the incumbent chassis (`maxLeadHotTenureDays` or `maxCopiesPerLead`
lifetime cap, whichever the data ranks), as a single challenger + its `-lag` twin — filed behind
the queued `hotlead-fresh` unless the operator re-prioritizes.

**Pre-registered predictions (each with a kill criterion):**
- **P1 — the lifecycle signal exists.** On strict's 835 retired rows + strict-hi's 155 (time-ordered,
  split-half): net/trade in the **youngest hot-tenure tercile** exceeds the **oldest tercile** by
  ≥ +0.02 SOL/trade AND the youngest tercile's drop3/trade > 0, **in BOTH halves**. Tenure computed
  from prior closes only. FAIL → the lifecycle thesis is refuted; KILL the deployment form and
  record the negative (it also weakens B1's premise).
- **P2 — it explains the observed decay.** The trades inside the recorded `degrading` windows
  (strict 07-09→07-12; strict-hi current) skew old: median hot-tenure (or median Nth-copy) ≥ 1.5×
  the prior-window median. FAIL → decay is not lifecycle-driven; the gate may still be spawnable on
  P1 alone but loses its "explains the board" claim.
- **P3 — the deployable gate retains reachability.** The best tenure/N cutoff from P1 retains
  ≥ 40% of the incumbent's historical fires (≈ ≥3/day at post-D1 volume). FAIL → over-filters;
  report the finding but do not spawn (the lesson becomes a *rotation/supply* argument feeding C1
  instead — decaying leads mean the pool needs constant refresh).
- **Decision rule:** propose the challenger only if P1 ∧ P3 (P2 upgrades conviction, not the gate).
  Multiple-comparisons discipline: terciles and the K=1.5× factor fixed here, before the query runs;
  in-sample fit is the null (the freshdip lesson).

**Probe plan.** Path (c): 3–4 read-only `ops`-branch DB queries over closed copy rows joined to the
per-lead baseline series (the same reconstruction the 07-10 leadpullback backtest used, which
proves the data supports it). Zero RPC, no slot, ~1 session. *Point-in-time construction:* hot-tenure
and Nth-copy at each entry derive exclusively from rows closed before that entry. *Promotes when:*
P1 ∧ P3 → a one-lever challenger spec goes to `solana-strategy-phase-2`.

**Cost + capacity.** Compute-only. Deployment form (if any) is a zero-RPC cached gate sharing the
incumbent's polls.

**Correlation.** Same leads as the incumbent — deliberately: it is a model OF the incumbent's decay,
not a diversifying bet. Its portfolio value is deciding whether the family's fade is structural
(rotate/refresh: strengthens C1) or noise (hold course), which no current experiment can answer.

---

### B1 — `book-edge-regime-gate` — stand down when the book's own forward edge is dead

*Thesis written 2026-07-13, before any validation ran; predictions pre-registered. Status: pending
probe (path (c) — offline replay, zero RPC, no slot). Voice: proposal.*

**One-liner.** Replay the incumbent family's time-ordered closed rows with a stand-down switch —
skip entries while the strategy's own trailing K-trade net/trade ≤ 0, re-enter when it turns
positive — and keep it only if it beats always-on **on drop3/trade AND net/trade in both time
halves**; the null hypothesis is that this is noise-chasing on fat-tailed own-PnL.

**Mechanism.**
- *What asymmetry:* the edge is intermittent — strict round-tripped degrading→stable→pruned within
  5 days; strict-hi's recent window is −0.031/t against a +0.056/t prior. The book currently eats
  100% of the dead stretches. If edge-state is persistent (dead stretches predict more dead), a
  stand-down rule converts known intermittency into avoided losses without touching entry logic.
- *Why this is NOT the killed timing-gate family:* regime-mid/hi, macro, macro-regime, and
  hotlead-regime all keyed on **market covariates** (baseline-book score, BTC bands). This keys on
  the **strategy's own realized forward edge** — the exact quantity `recencyProfile` already
  computes and the exact quantity whose swings we've watched all month. Material difference named;
  the graveyard prior still gets a vote via the pre-registered null.
- *Edge family:* meta/regime on own-book state — a genuinely untested *level* (above entry gating).

**The one lever changed.** None in `COPY_STRATEGIES` — the deployment form, if confirmed, is a
book-level config (promote `recencyProfile` from advisory to an entry-blocking flag with
pre-declared K), proposed separately for operator review.

**Pre-registered predictions (each with a kill criterion):**
- **P1 — the gated book wins where it counts.** For at least one pre-declared K ∈ {20, 30, 50}
  (fixed here, no other values may be tried), the SAME K beats always-on on **both** drop3/trade
  and net/trade **in both time halves** of strict's 835 + strict-hi's 155 rows, while retaining
  ≥ 50% of trades. FAIL → KILL the gate; record that own-PnL trend-following doesn't clear noise.
- **P2 — the gate skips genuinely bad trades.** The gated-OUT cohort's net/trade ≤ −0.02 in both
  halves (the rule excludes losses, not random trades). FAIL → any P1 pass is fragile — treat as
  KILL unless P1 margins are extreme.
- **P3 — edge-state persistence exists at all.** P(next-10-trades net ≤ 0 | trailing-K net ≤ 0)
  exceeds the unconditional probability by ≥ 10pp. FAIL → intermittency is not persistent →
  kills B1 AND materially weakens A1's decay premise (shared root) — a valuable joint negative.
- **Decision rule:** propose the config change only if P1 ∧ P2 ∧ P3. Any pass must quote the
  worst-half margin, not the pooled one. No post-hoc K search beyond the declared three.

**Probe plan.** Path (c): single read-only replay over the same rows as A1 (one combined ops-DB
pull serves both studies). *Point-in-time construction:* trailing-K net at each entry uses only
prior closed rows. *Promotes when:* P1–P3 → operator-reviewed config proposal (advisory →
enforced), with a shadow observation window before any live relevance.

**Cost + capacity.** Compute-only; shares A1's data pull. Deployment adds zero RPC (the trend
machinery already runs). Stand-down windows stretch n-timelines for in-flight tests — the config
proposal must state the expected duty cycle from the replay.

**Correlation.** Sits above every strategy; competes with nothing in the queue. Value: converts the
board's known intermittency from a passive risk into either an exploitable structure or a
pre-registered dead end — and P3 double-reads on A1.

---

### M1 — `arena-truth-fix` — un-ghost the benchmark, un-mix the cost eras

*Category: measurement. Status: proposed small code edit (no slot). Voice: proposal.*

**Verdict.** Every challenger verdict on the board is currently computed against
`copy-hotlead-strict` — pruned 07-12, a ghost — and every cumulative/trend number mixes 3%-era and
6%-era rows, which the 07-12 lab addendum itself flagged as a misread risk.

**Recommended change (one reviewed edit):** (1) repoint `experiment_arena.benchmark` (and the
challenger rows' benchmark baselines) to the current incumbent `copy-hotlead-strict-hi`;
(2) surface per-strategy `net_per_trade` / `drop3_per_trade` computed on **post-recost rows only**
(rows closed after the 6% deploy) alongside the cumulative numbers, so arena verdicts and trend
flags can be read on like-for-like costing during the ~2-week transition.

**Pre-registered observable + revert criterion.** P1: after deploy, every arena row exposes the
post-recost fields and the benchmark names a live strategy; PASS = the next daily/lab reads cite
them (no more mixed-era comparisons); trivial revert (reporting-only — no trading-path change).

**Why this beats a signal thesis this cycle:** identical logic to 07-12's D3 — the mission runs on
this scoreboard; two known distortions in it corrupt every keep/kill/promote decision for the next
two weeks, at the cost of a small reporting edit.

---

### C1 — D2 forward copy-net trial rotation — HELD, decision pre-wired to 07-19

*Not promoted this cycle — the trigger was pre-registered on 07-12 and lands in six days.*

- **D1 P2 FAIL (lead pool ≤ 185 by ~07-19):** C1 is **refuted by proxy** (subscription/supply was
  not the binding constraint) — record the kill in the lab ledger, do not build.
- **D1 P2 PASS (leads ≥ 200 / hot ≥ 65 / fires ≥ 7/day):** C1 is **deferred** — raw supply fixed it;
  revisit only if the pool stalls again at full subscription.
- **Middle band (185–200):** the only outcome that argues for C1's build — and then only the
  *ranking/rotation* half (value-ranked trial slots), sized as one experiment, after A1's verdict
  (if leads decay, rotation is not optional — A1's P3-fail branch feeds exactly this design).

---

## Summary for the operator

- **Promoted: A1 + B1 as one combined offline ops-DB study** (same data pull, zero RPC, no shadow
  slot, ~1 session of work) with pre-registered kill criteria — including the pre-declared null
  that B1 is noise-chasing and the freshdip lesson that in-sample fit is the default outcome. And
  **M1**, a small scoreboard-integrity edit (ghost benchmark + mixed cost eras) in the D3 tradition.
- **Held with a dated trigger: C1 (D2 rotation)** — its fate resolves mechanically on D1's day-7
  read ~07-19; building it earlier would be spending before the free answer arrives.
- **Killed at the screen:** A2 (crowding-on-lead — consensus family, already failing in-flight), T1
  (session timing — the timing-gate graveyard, verbatim), E1/Z1 (dead priors), W1 (no new data
  input actually available).
- **Zero new shadow strategies — deliberately, third cycle running.** The board is over-cap with
  `hotlead-fresh` queued; the signal lane's realized phase-1 hit-rate is 0-for-4; the two operator
  seeds that survived are precisely the ones testable without a slot.
- **Dangling pre-registrations to resolve:** gradspec day-7 is due **today** → shelve-as-untestable
  (frozen funnel, not a refutation); C4/C5 P3 fire-rate checkpoints (~07-16) should be judged
  against post-D1 event volume.
