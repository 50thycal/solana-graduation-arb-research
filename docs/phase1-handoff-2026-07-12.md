# Phase-1 Idea-Model Handoff — 2026-07-12

*Produced by `/solana-idea-model-phase-1` (divergent front-end). Runs in chat; stops at the probe
spec. **Proposal voice** — every change below is a proposal for the operator to review + deploy,
never past tense. Nothing here touches live money or edits `COPY_STRATEGIES`. Survivors enter
`solana-strategy-phase-2` at its Phase 1 (thesis) / Phase 3 (implementation) with the pre-registered
predictions already articulated. Previous handoff: `docs/phase1-handoff-2026-07-11.md` (C4/C5 —
both spawned same-day by operator override; this cycle does not regenerate them).*

---

## Phase 0/1 — grounding (what's contestable *right now*, 2026-07-12 03:52 UTC scoreboard)

**Incumbent / correlation baseline.** `copy-hotlead-strict` — hot-lead recency gate
`{lastN:10, minTrades:3, minNetSol:0.5}`, TP100/SL30, lag5 + drift10. n=824, net +13.38,
**net/trade +0.01624, drop3/trade +0.00825**, score 100, trend **stable** (recent/trade +0.00695 —
recovered from the 07-10/07-11 degrading stretch). `n_promotable_stable` = 1 again.
`copy-hotlead-strict-hi` (net-floor 1.0): n=143, **+0.04633 / +0.03097 per trade**, score 100, still
flagged `degrading` but easing (recent/trade back positive at +0.00863). OG control
`copy-tp100-sl30-lag`: n=1038, −0.03149 / −0.03616 per trade — the gap to the incumbent **is** the
hot-lead recency edge.

**Three facts reframe this cycle:**

1. **The overlay lane is saturated.** Nine challengers in flight (operator-overridden, >2× the
   MAX_INFLIGHT=4 cap): `strict-hi`, the fable cohort (`dip` n=5 / `leadpullback` n=5 / `deep` n=9),
   `freshdip` n=42 (−0.025/t, drop3 −0.072/t), `freshdip-bounded` n=3, `hotlead-early` n=46
   (−0.051/t, drop3 −0.090/t, uniformly worsening — likely KILL at n≈100), and yesterday's C4/C5
   (`nodump`, `breadth`, n=1 each). `hotlead-fresh` is already queued for the next free slot.
   **The marginal value of another entry-gate overlay is ~zero this cycle** — it would queue behind
   nine experiments that all key on the same hot-lead entries.

2. **The whole book is supply-starved by the watchlist cap — and that is new, checkable
   information.** `COPY_WATCHLIST_MAX` default is 80 (10 reserved for discovery sources), while
   `follow_list` alone has grown to ~150 and the global smart set to ~178: **roughly half the scored
   promotable wallets, and the entire smart-set tier, are not subscribed at all** (the tier-priority
   truncation — same mechanism as the 07-08 U5 incident, where unsubscribed wallets produce zero
   lead events *by construction*). Observable symptoms: the lead pool has been flat at 173 leads /
   ~50 hot since the 07-09 credit retune; incumbent fire rate ~4–7/day; the seven small challengers
   are crawling toward n≥100 (the lab ledger itself flags the stretched timelines). Meanwhile
   `rpc_usage` estimates **47.4k credits/day against the ≤100k/day target** — the 07-09 retune
   overshot, and `copy_follower_ws` is only 4.2k msgs/day (~53 msgs/wallet/day). There is budget
   headroom to un-throttle the proven edge.

3. **The live-vs-shadow execution gap is unreconciled while live-micro funding is being
   recommended.** The daily journal (07-10, 07-11) recommends live-micro tests for both promotables.
   But every live-vs-shadow read on record is negative: 557 matched live/shadow trades show live avg
   return **−5.16% vs shadow +0.22%** (journal 07-11); the surviving matched pair in
   `live_vs_shadow` (`hotlead-deep`) shows **exec_gap −6.64pp** over 126 matched; and
   `live-execution.json`'s largest live sample (213 trades) measures **entry slip +2.72% / exit slip
   −3.03% ≈ 5.7pp round-trip** against the **3.0%** shadow assumption (`SIM_DEFAULT_COST_PCT`), with
   an 85.9% land rate and ~4.4s land time. If the real round-trip cost is ~5.7%, the incumbent's
   +3.25%-of-position per-trade edge thins to ~+0.5% and **nothing on the current board clears the
   monthly bar in live execution.** Also outstanding: `copy-hotlead-hold30m-live-micro` is still
   `active: true` with real capital (324 trades, −0.75 SOL) on a strategy killed 07-05.

**Meta-lessons (re-derived, unchanged from 07-11 except where noted):** info-asymmetry via recency
on the OG universe is the only surviving edge; the wallet-*source* frontier is an empirical
graveyard (cotrade FAILS, live_tape PRUNED, winner_sniper FAILS n=148 at −0.048/t, external
collecting negative at n=13, gradspec frozen — own-skill ≠ copyable, r≈0 transfer + reachability
walls); public post-hoc chart features are dead (−935 SOL); cumulative copy-net neither selects nor
vetoes (only recency holds); exit engineering never flips a negative entry; net-positive /
drop3-negative is a refused lottery; buy weakness, not strength (dip fills, lead pullback
mean-reversion, the 3+ smart-buyer crowding cliff: +6.72% at 2 buyers → −0.92% at 3+). **New this
cycle:** the incumbent's "degrading" flag partially recovered on its own (strict back to stable) —
supporting the regime-noise reading over structural decay, but not settling it.

**Board/decision triggers surfaced for the operator (not theses):**
- `copy-src-gradspec`'s day-7 fallback lands **2026-07-13**, but its P1 miss is **structurally
  confounded**: the winner pre-filter has been default-OFF since the 07-09 credit retune, so the
  funnel *cannot* enroll new wallets (`candidates: 0, scored: 0`; probe trades only from the 4
  already-passed wallets). Honest handling: **shelve-as-untestable** (not FAILED — the test never
  armed), or re-arm bounded (`PREFILTER_DISABLED=false` with a tight cap) only after the D1 budget
  read below. Do not let the shelve be recorded as a thesis refutation.
- `hotlead-early` (n=46, drop3/t −0.090, worsening) is the nearest KILL → frees the slot the queued
  `hotlead-fresh` is waiting for.
- The standing `copy-tp100-sl30-lag` KILL proposal (13+ failing reads) still conflicts with its role
  as the discovery-scorecard control — swap the control first or keep it (lab watch-item, unchanged).

---

## Phase 2 — the slate (diverge; screened in Phase 3)

Anti-anchoring note: the gravity this cycle is *another overlay on the incumbent's entries* — the
saturated lane. The slate deliberately pushes the levers the board has **no** live exposure to:
supply/capacity (which-wallets at the subscription layer), measurement integrity (execution cost),
and the discovery-decision layer, plus fresh gate signals for coverage.

| # | lever × edge-source | point-in-time signal (at-entry-knowable?) | one-sentence edge |
|---|---|---|---|
| **D1** | **which-wallets × supply/capacity** | n/a (infrastructure; observables pre-registered) | **the proven hot-lead edge is subscription-throttled: ~80 scored wallets + the whole smart set unsubscribed at cap 80 while RPC runs at 47% of budget — un-throttle it** |
| D2 | which-wallets × forward trial rotation | our forward copy-net on trial wallets (internal, forward-only) | rotate scored candidates through trial subscription slots and graduate them on *copy-net*, not own-PnL — manufactures new hot leads with the only metric that transfers |
| **D3** | **execution/sizing × measurement integrity** | n/a (offline; matched pairs already recorded) | **reconcile the −5…−6.6pp live-vs-shadow gap against the 3% cost assumption BEFORE funding live-micro — either the bar is optimistic or the executor is fixable; both outcomes are wins** |
| D4 | source × cross-token skill (decision) | (gradspec probe already live) | gradspec's P1 miss is an artifact of the frozen pre-filter — shelve-as-untestable or re-arm bounded; don't record it as refuted |
| D5 | entry-gate × earliness-of-lead | lead's prior buys of this mint in last N h (`copy_probe_events`, cached) | copy only a lead's FIRST touch of a mint — re-buys are averaging-down, not discovery; nothing today reads the LEAD's repeats |
| D6 | entry-gate × conviction/microstructure | lead buy SOL ÷ pool depth at copy (parsed `sol_delta`; `pool_quote_sol` recorded since 07-10) | relative impact = urgency — absolute buy-size failed, size-relative-to-liquidity is untested |
| D7 | entry-gate × microstructure (sell-side, SOL-weighted) | SOL-weighted smart flow imbalance (cached events) | richer version of C4's count-based veto |
| D8 | entry-gate × consensus (time-ordered) | ≥2 hot leads buy same mint within X s | conviction cascade (held 07-11: fire-rate wall) |
| D9 | which-wallets × behavioral signature | lead's historical median post-grad entry speed (cached ts) | latency-advantaged leads as informedness proxy (held 07-11: may not discriminate) |
| D10 | entry-gate × insider flow | dev/creator wallets of this mint selling in last N min | don't buy while insiders distribute — but needs per-entry RPC or watchlist growth; borders the sniper/insider feature graveyard |
| D11 | exit × any | (coverage slot) | exit engineering — dead prior |
| D12 | sizing × conviction | (coverage slot) | sizing isn't alpha — dead prior |

---

## Phase 3 — six-axis screen

Axes: **1** correlation · **2** edge-plausibility vs graveyard · **3** survivorship/point-in-time ·
**4** execution/cost on the `-lag` twin · **5** capacity/n≥100 reachability · **6** infra/RPC reuse.
(++ strong / + ok / ~ weak / − kill-level.)

| # | 1 corr | 2 edge | 3 surv | 4 exec | 5 cap | 6 infra | call | one-line reason |
|---|---|---|---|---|---|---|---|---|
| **D1** | + (amplifies, competes with nothing) | ++ (subscription→events is *proven causal*, U5) | ++ (n/a) | + (economics unchanged) | ++ (IS the capacity lever) | ++ (env default + observables; +~4k credits/day vs 53k headroom) | **PROMOTE** | un-throttles the sole proven edge AND accelerates all nine in-flight tests at once; cheapest win available |
| **D3** | ++ (zero — it's measurement) | ++ (a first-order recorded discrepancy, not a hypothesis) | ++ (matched pairs, same events) | ++ (IS the exec axis) | ++ (557 matched pairs already on disk) | ++ (ops-DB only, zero RPC, no slot) | **PROMOTE** | the mission is real SOL; the current bar may be ~2.7pp/trade optimistic — validates or halts the live path before capital moves |
| D2 | + | + (copy-net forward = the proven metric) | ++ | + | + | ~ (rotation state machine, watchlist rework) | HOLD | correct successor to D1 — but pointless while 80 already-scored wallets sit unsubscribed for free; build only if D1 saturates and the pool still stalls |
| D4 | n/a | + | ++ | n/a | − (funnel frozen) | ++ | HOLD (decision) | not a thesis — an integrity call on an in-flight probe; shelve-as-untestable beats a false FAILS |
| D5 | − (overlay, lane full) | + (plausible, ambiguous — whales also scale winners) | ++ | + | ~ (re-buys rare → weak test power) | ++ (zero RPC; offline-backtestable NOW) | HOLD | run as a path-(c) offline replay over closed rows + probe events first; take a slot only if the replay clears drop3 |
| D6 | − (overlay, lane full) | + | + (impact at *our* fill ≈ lead's, 5s apart — acceptable) | + | + | ++ (zero RPC) | HOLD | `pool_quote_sol` only recording since 07-10 — backtestable in ~2–3 weeks; queue the offline replay, no slot |
| D7 | − (C4's own hill-climb) | + | ++ | + | + | ++ | HOLD | wait for C4's n≥100 read; a variant before the parent resolves is sprawl |
| D8 | − (hot-lead driver) | ~ | ++ | ~ | − | ++ | HOLD | unchanged from 07-11 — fire-rate wall (double-hot-lead gate) |
| D9 | ~ | + | ++ | ~ | ~ | ++ | HOLD | unchanged from 07-11 — our leads are all fast post_grad_amm; may not discriminate |
| D10 | − (overlay) | ~ | + | ~ | ~ | − (per-entry RPC or non-smart watchlist growth) | KILL | cost + graveyard-adjacent (insider/sniper features); lane full anyway |
| D11 | − | − | — | − | — | — | KILL | exit engineering never flipped a negative entry |
| D12 | ~ | − | ++ | ~ | + | + | KILL | sizing isn't alpha; drop3-sizing already killed at the 07-11 screen |

**Survivorship gate applied:** D1/D3 key on no market signal at all (infrastructure + already-recorded
matched pairs). D5 (probe-event history), D6 (parsed `sol_delta`, `pool_quote_sol` at fill), D7
(cached flow counts), D9 (cached timestamps) are all at-entry-knowable, no backfill. D10's "insider
selling" is live flow (safe) but its *selection of which wallets are insiders* leans on graduation
enrichment fields — audit before any future promotion. No slated idea keys on an after-entry-resolved
field.

**Two promote, the rest hold/kill.** Neither promote is a trading signal — that is the honest,
deliberate call this cycle, the mirror image of 07-11: the signal lane (nine overlays deep) is fully
invested, the uncorrelated-source lane is a graveyard awaiting its two live probes, so the
highest-EV moves are the ones that make every existing bet resolve **faster** (D1) and make the
scoreboard **true** (D3).

---

## Phase 4 — promoted pre-registered theses

### D1 — `copy-watchlist-unlock` — re-subscribe the scored wallet supply the cap is silently dropping

*Thesis written 2026-07-12, before any validation ran; predictions pre-registered. Status: pending
probe (config change + observables — consumes no strategy slot). Voice: proposal.*

**One-liner.** The hot-lead machine is fed by baseline copy events, and events only come from
subscribed wallets; at `COPY_WATCHLIST_MAX=80` we are silently dropping ~half the scored
`follow_list` (~150) and the entire smart-set tier (~178) — raise the cap to ~150 (source reserve
unchanged) inside the ≤100k/day credit budget, and measure the supply response.

**Mechanism.**
- *What asymmetry:* none claimed — this is throughput on the proven recency edge. Subscription →
  lead events → baseline copies → leads crossing `minTrades:3` → hot-lead classification → gated
  fires. Every link is existing, verified machinery; the 07-08 U5 incident proved the first link is
  causal (unsubscribed wallets = zero events *by construction*).
- *Why now:* the 07-09 retune cut the watchlist for credit reasons and overshot — estimated spend is
  47.4k/day vs the 100k target, `copy_follower_ws` is 8.9% of it, and the lead pool has been flat at
  173 leads / ~50 hot since exactly that cut. Nine in-flight experiments are all starving on the
  same event volume; C4's `smartFlowVeto` and every consensus-family gate are additionally starved
  because the smart-set tier (whose events feed `countRecentSmart*`) is entirely unsubscribed.
- *Edge family:* capacity/supply on lever 1 (which wallets — at the subscription layer).

**The one lever changed.** `COPY_WATCHLIST_MAX` default 80 → **150** (`WATCHLIST_SOURCE_RESERVE`
stays 10). One step only — smart-set-tier expansion (→~330) is explicitly NOT this proposal; judge
it later on this probe's data.

**Pre-registered predictions (each with a kill criterion):**
- **P1 — cost stays in budget.** PASS if `copy_follower_ws` lands ≈ 8–9k msgs/day (~53/wallet/day ×
  150) and `rpc_usage.est_credits_per_day` stays **≤ 65k** with the console confirming within ~2×
  of the estimate; **REVERT** (env, instant) if total attributable spend pushes the console toward
  >85k/day.
- **P2 — the supply response appears.** PASS if within **7 days** of deploy: `lead_performance.n_leads`
  grows 173 → **≥ 200**, hot count ~50 → **≥ 65**, and incumbent fires/day rises ~4–7 → **≥ 7**
  (7-day averages). **FAIL** if the lead pool is still ≤ 185 by day 7 — then subscription was NOT
  the binding constraint, the pool is quality-bounded, and **D2 (trial rotation) is refuted-by-proxy
  too** (a valuable negative: stop pushing supply, the frontier is elsewhere).
- **P3 — the edge survives the breadth.** PASS if the incumbent's net/trade over the post-change
  window stays **> 0** and its drop3 trend does not invert (the marginal wallets are the
  lower-priority tail of `follow_list` — if quality collapses, the old truncation was accidentally
  curating, and the follow-up is value-ranked subscription, i.e. D2's ranking half, not a bigger cap).
- **Decision rule:** keep permanently if P1 ∧ P2 ∧ P3 at day 7–14; revert on P1 failure any time;
  P2 failure → revert optional (cost is small) but *record the negative* in the lab ledger and kill
  the D2 line with it.

**Probe plan.** Path (a′) config: one-line default change (or env set by the operator — zero code)
→ deploy → read `copy-probe.json → status.watchlist_size`, `rpc_usage`, `lead_performance`,
`promotion.rows` daily for 7 days (the daily skill already reads all four). No new strategy id, no
slot consumed, instantly reversible. *Point-in-time construction:* n/a — no market signal.
*Promotes when:* P1 ∧ P2 ∧ P3 → becomes the standing posture; the queued/starved tests (C4/C5
fire-rates, `hotlead-fresh`, freshdip resolution) all inherit the faster clock.

**Cost + capacity.** +~70 wallets ≈ +3.7k WS msgs/day ≈ +3.7k credits/day (est → ~51k/day, half the
target). Reachability: n/a. Expected side-effects to watch: consensus counts (`minConsensusRecent`,
`maxConsensusRecent`, `smartFlowVeto`) see more events — their series stay internally consistent
(the 07-04 tier filter `tier IN ('promotable','smart')` already guards gated series), but fire-rate
baselines for P3-style checkpoints on C4/C5 should be re-based on the post-change volume.

**Correlation.** Amplifies the incumbent's return driver rather than diversifying — but it is not a
competing bet: it is the denominator every in-flight bet divides by. Value to the SOL goal: faster
n≥100 on nine experiments, more distinct hot leads (structurally thicker drop3 base), and it re-arms
the starved consensus/flow signals that two current challengers key on.

---

### D3 — `live-cost-recon` — reconcile live execution cost against the shadow assumption before any live-micro funding

*Thesis written 2026-07-12, before any validation ran; predictions pre-registered. Status: pending
probe (path (c) — offline ops-DB study, zero RPC, no slot). Voice: proposal.*

**One-liner.** Every live-vs-shadow read on record says live execution loses ~5–6.6pp per trade to
the shadow model's 3% round-trip assumption; quantify the TRUE live cost from the recorded matched
pairs (segmented by era and failure mode), re-cost the promotable strategies at it, and only then
decide the pending live-micro funding recommendation.

**Mechanism.**
- *What's mispriced:* the promotion bar judges strategies at `SIM_DEFAULT_COST_PCT = 3.0%`
  round-trip. Recorded live telemetry says otherwise: 557 matched live/shadow trades at live avg
  −5.16% vs shadow +0.22%; the `hotlead-deep` matched pair at exec_gap −6.64pp over 126 trades; the
  largest live sample (213 trades) measuring entry slip +2.72% + exit slip −3.03% ≈ **5.7pp
  round-trip** with land rate 85.9% and ~4.4s land latency. If ~5.7% is the real cost, the
  incumbent's shadow edge (+3.25% of position per trade gross of nothing — i.e. ~+6.25% gross,
  +3.25% net at 3%) compresses to ~**+0.5% net**, and the monthly bar is missed by every strategy
  on the board at any size. The scoreboard would be systematically optimistic — every promotion
  decision inherits the error.
- *Why the number might be better than it looks (the study must segment):* the matched-pair record
  spans old executor eras and known non-cost failures — the 134 `live_buy_failed` exits on
  `consensus2-live-micro` were a wallet-rent/funding symptom (documented in the research archive),
  not slippage; buy/sell retry logic has been reworked since; and much of the measured "slip" at
  0.05 SOL size is adverse drift in the ~4.4s land window (latency cost), which Jito tips / priority
  fees can buy down. The honest answer may be era-dependent — that is exactly what the study
  establishes.
- *Edge family:* measurement integrity on the execution/sizing lever. Not a trading signal; the
  survivorship and `-lag` questions do not arise (matched pairs share the same events).

**The one lever changed.** None in `COPY_STRATEGIES`. The deliverables are: (1) a reconciled
round-trip cost estimate (median + tail, by era / venue / failure-mode) from the ops DB; (2) a
re-costed promotion table (which of `strict` / `strict-hi` still clear the bar at the reconciled
cost); (3) a go / no-go / fix-first recommendation on the pending live-micro funding, including
whether `SIM_DEFAULT_COST_PCT` or a live-stress gate on `promotion` should change (each its own
operator-approved follow-up, not part of this study).

**Pre-registered predictions (each with a kill criterion):**
- **P1 — the gap survives segmentation.** Compute the matched-pair gap EXCLUDING known funding-bug
  exits and pre-retry-fix eras. PASS (gap explained) if the residual modern-era gap is **≤ 2pp** per
  trade → live-micro funding may proceed with a +2pp stress haircut baked into the go decision.
  FAIL (gap real) if the residual gap is **> 2pp** → the "fund live-micro now" recommendation is
  **KILLED** until either the executor demonstrably improves (P3 path) or the bar is recalibrated.
- **P2 — the incumbents survive re-costing, or they don't.** Re-cost `copy-hotlead-strict` /
  `copy-hotlead-strict-hi` closed rows at the reconciled cost. PASS if drop3 > 0 AND monthly ≥ 3.75
  still hold at shadow size; FAIL → neither is a live candidate at ANY size until the edge or the
  executor improves — record it in the lab ledger as the binding constraint (this outcome would be
  the single most valuable negative available this cycle: it stops a predictable live bleed).
- **P3 — the modern sample is sufficient.** If matched pairs from the CURRENT executor era number
  **< 100**, the study reports the era-segmented estimate with wide error bars and recommends a
  bounded **calibration burst** (~20 trades × 0.05 SOL ≈ ≤0.3 SOL at risk behind the existing
  `DAILY_MAX_LOSS_SOL` breaker, operator sign-off required) purely to measure modern slippage —
  explicitly NOT a P&L bet, and only if P1's historical read is ambiguous.
- **Decision rule:** the funding recommendation in the daily journal is treated as **BLOCKED** until
  P1+P2 are reported. Also in scope: recommend disabling `copy-hotlead-hold30m-live-micro` (live
  capital on a strategy killed 07-05, −1.26 SOL/mo run-rate) unless the operator explicitly keeps it
  as a paid execution-cost sensor — in which case its ongoing matched pairs become this study's
  modern-era data feed (state which, in the result).
- **Explicit non-goal:** no change to `SIM_DEFAULT_COST_PCT` or the promotion gates inside this
  study — measure first; any recalibration is its own reviewed follow-up.

**Probe plan.** Path (c): `ops`-branch read-only DB queries joining live fills to shadow twins on
`copy_event_id` (the `live_vs_shadow` machinery already does the join — extend the query, don't
rebuild), segmented by strategy / era boundaries (executor-fix commits) / exit reason
(`live_buy_failed` excluded as funding, not cost), plus `live-execution.json` telemetry (slip, land
rate, Jito spend). Zero RPC, zero watchlist impact, no strategy slot. *Point-in-time construction:*
n/a — retrospective matched-pair accounting on recorded fills. *Promotes when:* P1/P2 reported →
the go / no-go / fix-first call lands in the lab ledger and unblocks (or permanently re-scopes) the
live-micro path.

**Cost + capacity.** Compute-only (~3–5 ops queries). The optional P3 calibration burst is the only
capital touch: ≤ 0.3 SOL bounded, opt-in, operator-gated.

**Correlation.** Zero with every trading thesis — it is the measurement layer under all of them.
Value to the SOL goal: the mission is *real* SOL after *real* execution; this either validates the
whole live path at a known cost, or stops it before the bleed — both outcomes worth more than any
tenth overlay.

---

## Summary for the operator

- **This cycle promotes no new trading signal — deliberately.** The overlay lane is nine deep
  (including yesterday's C4/C5, spawned by your override), the source lane is a graveyard awaiting
  its two live probes, and the two binding constraints visible in the data are **event supply**
  (watchlist cap 80 vs ~150 scored wallets; lead pool flat since the 07-09 retune; RPC at 47% of
  budget) and **scoreboard truth** (live-vs-shadow gap ~5–6.6pp vs the 3% assumption, with a
  live-micro funding recommendation pending on top of it).
- **Promote #1 — D1 `copy-watchlist-unlock`:** raise `COPY_WATCHLIST_MAX` 80→150 within budget;
  pre-registered supply observables (leads ≥200, hot ≥65, fires ≥7/day by day 7) with instant
  revert. Un-throttles the incumbent AND accelerates all nine in-flight experiments and the starved
  consensus/flow signals (C4/C5's own tests included).
- **Promote #2 — D3 `live-cost-recon`:** offline matched-pair study that must land BEFORE the
  pending live-micro funding decision; pre-registered thresholds decide fund-with-haircut vs
  fix-first vs not-live-viable. Includes the standing `hold30m-live-micro` disable recommendation.
- **Held:** D2 trial-rotation (build only if D1 saturates and the pool still stalls — P2's failure
  mode kills it too), D5 lead-first-touch + D6 relative-impact (offline replays first; D6's data
  matures ~2–3 weeks after the 07-10 `pool_quote_sol` change), D7 SOL-weighted flow (C4's own
  hill-climb — wait for its read), D8 cascade + D9 entry-speed (unchanged holds from 07-11).
- **Killed at the screen:** D10 insider-distribution veto (RPC cost + graveyard-adjacent), D11 exit
  tweaks, D12 conviction sizing (dead priors).
- **Decisions surfaced, not theses:** gradspec day-7 (07-13) should resolve as
  **shelve-as-untestable** (frozen funnel — not a refutation) unless you prefer a bounded pre-filter
  re-arm after D1's budget read; `hotlead-early` is the nearest natural KILL (frees the slot the
  queued `hotlead-fresh` is waiting for); the `copy-tp100-sl30-lag` KILL still awaits a control swap.
