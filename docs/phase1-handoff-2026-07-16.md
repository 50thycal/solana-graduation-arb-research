# Phase-1 Idea-Model Handoff — 2026-07-16

*Produced by `/solana-idea-model-phase-1` (divergent front-end). Runs in chat; stops at the probe
spec. **Proposal voice** — every change below is a proposal for the operator to review + deploy,
never past tense. Nothing here touches live money or edits `COPY_STRATEGIES`. Survivors enter
`solana-strategy-phase-2` at its Phase 1 (thesis) / Phase 3 (implementation) with the pre-registered
predictions already articulated. Previous handoffs: `docs/phase1-handoff-2026-07-13.md` (A1/B1/M1 —
all resolved 07-13), `docs/phase1-handoff-2026-07-12.md` (D1/D3).*

**This cycle is operator-seeded:** the operator pre-agreed three candidate levers in chat — each on
a *different* lever, all deliberately off the saturated hot-lead-recency line — and directed a full
Phase-1 pass with them as priority candidates:
1. **Relative-impact conviction** (entry gate): gate on `lead_buy_sol ÷ pool_quote_sol` (the lead's
   price impact, not absolute size — absolute `≥2 SOL` was already refuted as `copy-bigbuy`).
2. **Conviction-weighted continuous sizing** (sizing lever): size by a conviction composite to
   attack drop3 without discarding moonshot leads.
3. **Fast no-bounce velocity exit** (exit lever): time-boxed early cut if a position hasn't risen
   X% within N seconds (the 07-08 falling-knife "never bounced" finding).

Per the skill's rules they compete on the same six-axis screen as everything else (no
rubber-stamping — the 07-13 precedent: the operator seeded A/B/C and the screen held/killed them).
The screen's verdicts are below.

---

## Phase 0/1 — grounding (what's contestable *right now*, 2026-07-16 12:45 UTC scoreboard)

**The dominating fact of this cycle: the sole promotable has fallen below the bar.**
`copy-hotlead-strict-hi` — hot-lead recency gate `{lastN:10, minTrades:3, minNetSol:1.0}`, TP100/SL30,
lag5 + drift10 — is now **n=198, net +1.92, drop3 −0.78 (NEGATIVE), exit-stress −2.44 (NEGATIVE),
monthly 4.11, score 55, degrading** (recent 66 trades −0.04355/t vs prior +0.03631/t, WR .288).
It fails the drop3 gate and the stress gate. **`n_promotable = 0`, `n_promotable_stable = 0`.**

This is materially worse than the 07-13 state, when strict-hi was the *sole promotable* at drop3
+0.01295. The 07-12 D3 study **pre-predicted exactly this** ("expect the promotion picture to tighten
over the next 1–2 weeks" as the 3%→6% re-cost flows through the trade-turnover window) — it has now
arrived. Under realistic 6% cost + continued wallet-level decay, the hot-lead entry is sub-marginal.

**The rest of the board is uniformly red** (2026-07-16 scoreboard):

| strategy | role | n | net | drop3 | stress | mo | trend |
|---|---|---|---|---|---|---|---|
| `copy-hotlead-strict-hi` | incumbent | 198 | +1.92 | **−0.78** | −2.44 | 4.11 | degrading |
| `copy-fable-dip` | challenger | 43 | +0.57 | −2.08 | 0.0 | 2.45 | insufficient |
| `copy-fable-deep` | challenger | 88 | −3.75 | −6.66 | −4.85 | −16.08 | improving |
| `copy-hotlead-nodump` (C4) | challenger | 81 | −4.81 | −7.77 | −5.71 | −24.05 | improving |
| `copy-hotlead-breadth` (C5) | challenger | 73 | −4.49 | −7.45 | −5.30 | −22.45 | improving |
| `copy-fable-leadpullback` | challenger | 61 | −4.66 | −7.18 | −5.38 | −19.97 | degrading |
| `copy-fable-leadcap` (A1) | challenger | 27 | −2.87 | −5.25 | −3.10 | −21.51 | insufficient |
| `copy-conviction-consensus2` | reference | 1653 | +2.64 | −10.14 | −37.73 | 5.66 | degrading |
| `copy-tp100-sl30-lag` | OG control | 1252 | −48.54 | −53.38 | −76.34 | −104.01 | degrading |
| `copy-src-gradspec` | discovery probe | 4 | +1.01 | −0.17 | 0.89 | 30.28 | insufficient (noise) |
| `copy-src-external` | discovery probe | 13 | −0.16 | −0.85 | −0.48 | −0.8 | insufficient |

Every challenger is net-negative; the two 07-11 drop3-robustness promotes (C4 nodump, C5 breadth)
are trending toward KILL (net −4.81 / −4.49, drop3 deeply negative). The controls bleed as designed.

**OG control** (`copy-tp100-sl30-lag`, the discovery-scorecard benchmark): net/trade ≈ −0.039,
drop3 −53.4 over n=1252. The gap between it and the incumbent **was** the hot-lead recency edge —
but that gap has now shrunk below the realistic-cost bar.

**Meta-lessons (re-derived from the live record; the operative priors this cycle):**
- **Info-asymmetry via recency on the OG universe *was* the only surviving edge — and it is now
  below the realistic-cost bar.** Every gate that works reads *our copy-net of this lead lately*, but
  at 6% cost that edge no longer clears drop3.
- **The wallet-*source* frontier is an empirical graveyard** (cotrade FAILS, live_tape PRUNED,
  winner_sniper PRUNED −0.048/t, external negative, gradspec frozen) — own-skill ≠ copyable (r≈0) +
  reachability walls. Do not lead here absent a genuinely new *data input*.
- **Public post-hoc chart features are dead** (−935 SOL). Excluded on sight.
- **Cumulative copy-net neither selects nor vetoes** (refuted both directions OOS; only *recency*
  ever held — and recency is now sub-marginal).
- **Exit / sizing engineering never flips a negative entry** (the P/Q/R/S 12-arm sweep; tighter-than-
  SL30 stops are poison). **This lesson is now load-bearing:** with the entry drop3-negative, any
  exit or sizing overlay is dead on arrival.
- **Net-positive / drop3-negative is a refused lottery.** `consensus2` (net +2.64, drop3 −10.14) is
  the textbook example on the current board.

**In-flight triggers to watch:** **D1 `copy-watchlist-unlock` day-7 read is due ~07-19** (3 days out)
— its P2 (leads ≥200 / hot ≥65 / incumbent fires ≥7/day) resolves whether *supply* is the binding
constraint and mechanically decides C1/D2 (07-13 handoff). C4 nodump (n=81) / C5 breadth (n=73) are
the nearest natural KILLs as they cross n≥100.

---

## Phase 0.5 — calibration on this skill's OWN promoted-thesis record

| promoted thesis (handoff) | lane | testable? | reached n≥100? | beat incumbent? | status |
|---|---|---|---|---|---|
| gradspec (07-05) | wallet-source | NO (funnel frozen) | n=4 | — | shelved-as-untestable (07-13) |
| hotlead-early (07-05) | entry-gate (earliness) | yes | n=94 | NO | **KILLED 07-16** (prune: net −3.73, drop3/t −0.06) |
| C4 nodump (07-11) | entry-gate (sell-flow veto) | yes | n=81 | trending NO (net −4.81, drop3 −7.77) | on track to KILL at n≥100 |
| C5 breadth (07-11) | entry-gate (per-lead cap) | yes | n=73 | trending NO (net −4.49, drop3 −7.45) | on track to KILL at n≥100 |
| A1 leadcap (07-13) | entry-gate (lifetime N-cap) | yes | n=27 | too early (net −2.87) | in-flight, young |
| B1 book-regime-gate (07-13) | meta/regime | yes (offline) | n/a | — | **RESOLVED — REFUTED** (own-PnL trend = noise) |
| D1 watchlist-unlock (07-12) | **capacity (non-signal)** | yes — deployed | n/a | n/a | in-flight, day-7 ~07-19 |
| D3 live-cost-recon (07-12) | **measurement (non-signal)** | yes | n/a | n/a | **RESOLVED — HIT** (drove 3→6% recost; predicted this incumbent decay) |
| M1 arena-truth-fix (07-13) | **measurement (non-signal)** | yes — deployed | n/a | n/a | RESOLVED — HIT (benchmark repointed) |

**Realized hit-rate by lane — unchanged and now sharper: signal theses 0 hits** (gradspec
untestable; hotlead-early KILLED; C4/C5 trending KILL; A1 young; B1 refuted). **Non-signal theses
3-for-3** (D3 + M1 resolved hits, D1 clean-deployed). The a-priori grid ordering is overridden for
the *fourth consecutive cycle*: the entry-gate overlay lane is saturated and empirically cold, the
wallet-source lane stays closed, and the highest-yield work remains **models of the edge + scoreboard
integrity**. The clearest new datum: **the D3 measurement thesis correctly predicted the incumbent's
fall below the bar** — the single most consequential call of the last month came from the measurement
lane, not a signal.

**Mapping the operator's three seeds onto this record (before the screen):**
- **Seed 1 (relative-impact) = D6** on the 07-13 slate — a genuine entry-selection microstructure
  signal, HELD there only for data maturity. The one seed *not* in a graveyard lane.
- **Seed 2 (sizing) = Z1 (07-13) + C11 (07-11)** — screened-to-KILL **twice** ("sizing isn't alpha").
- **Seed 3 (no-bounce exit) = E1** — the exit-engineering coverage slot, KILLED **every cycle**.

**Dangling pre-registrations flagged/resolved:** hotlead-early KILLED 07-16 (its day-7 fallback
resolved). C4/C5 P3 fire-rate checkpoints (~07-16) are moot — both are simply trending to KILL on
P1/P2. D1 day-7 (~07-19) is the one open pre-registered trigger. No un-closed debt blocks this cycle.

---

## Phase 2 — the slate (diverge; screened in Phase 3)

Anti-anchoring note: the three operator seeds are one-per-lever (entry / sizing / exit), which is
good breadth — but two land in graveyard lanes. The slate widens each seed with its nearest siblings
so the screen ranks the *lever*, not just the one param, and adds the non-signal candidate the board
state demands (the incumbent is below the bar).

| # | lever × edge-source | point-in-time signal (at-entry-knowable?) | one-sentence edge |
|---|---|---|---|
| **R1** | **entry-gate × microstructure (relative impact)** *(seed 1 = D6)* | `lead_buy_sol ÷ pool_quote_sol` at fill (both recorded since 07-10; cached, zero-RPC) | a lead sizing large *relative to pool depth* is high-urgency conviction — isolate the still-live subset of the decayed hot-lead entry |
| R2 | entry-gate × conviction (absolute) | `lead_buy_sol` ≥ X (`minLeadBuySol`, exists) | absolute buy size = conviction — **already refuted** as `copy-bigbuy` (net −3.1); R1 is the untested *ratio* cut |
| R3 | entry-gate × microstructure (absolute depth) | `pool_quote_sol` ≥ X (`minPoolSol`) | deep pools only — **in flight as `copy-fable-deep`** (n=88, net −3.75, failing); the denominator of R1 alone doesn't carry |
| S1 | **sizing × conviction composite** *(seed 2 = Z1/C11)* | size ∝ (recency-net × dip-depth × consensus) | conviction-weight capital to lift net without cutting moonshots |
| E1 | **exit × velocity (no-bounce cut)** *(seed 3)* | price change in first N s post-entry (hot-poll infra) | cut falling knives before the −30% SL |
| N1 | **measurement × edge-death vs cost-transition** | n/a (ops-DB read on recorded rows) | is the incumbent's drop3-negative read a *real* edge death or a residual of the 3%→6% mixed-cost transition window? decides whether any signal work is even worth a slot |

Reachability pre-gate notes: R1/R2/R3/S1/E1 all fire on the incumbent's existing flow (no new
subscriptions, zero marginal RPC). R1's offline replay needs enough rows with *both* `lead_buy_sol`
and `pool_quote_sol` populated — recording began 07-10, so the readable window is ~07-22..07-24
(pre-registered on 07-13). N1 is a read-only ops-DB study, no slot.

---

## Phase 3 — six-axis screen

Axes: **1** correlation (book + queue) · **2** edge plausibility vs graveyard · **3**
survivorship/point-in-time · **4** execution/cost on the `-lag` twin (drop3>0) · **5** capacity/n≥100
reachability · **6** infra/RPC reuse. (++ strong / + ok / ~ weak / − kill-level.)

| # | 1 corr | 2 edge | 3 surv | 4 exec | 5 cap | 6 infra | call | one-line reason |
|---|---|---|---|---|---|---|---|---|
| **R1** | ~ (same leads, but *selects a subset* — an entry gate can improve a marginal entry, unlike an exit/sizing overlay) | + (microstructure info-asymmetry: relative impact = urgency; **absolute** size failed but the *ratio* is a distinct, untested signal) | ++ (both fields read at the fill; forward-only, no backfill) | + (studied on recorded `-lag` rows at 6% cost; drop3>0-in-both-halves pre-registered) | + (fires on all incumbent entries; offline replay = zero fire-rate risk) | ++ (path (c) ops-DB replay over recorded rows, zero RPC, **no slot**; deployment = one `CopyStrategy` gate) | **PROMOTE (offline study)** | the one seed that is entry-*selection*, not exit/sizing; a genuine at-entry microstructure signal; doubles as a diagnostic of whether *any* hot-lead subset still clears the bar |
| R2 | − (== refuted `copy-bigbuy`) | − (absolute buy-size failed costs) | ++ | − | + | ++ | KILL | already in the graveyard; R1 is the material difference (ratio, not level) |
| R3 | − (== in-flight `fable-deep`) | ~ | ++ | ~ | + | ++ | HOLD | the R1 denominator alone is live and failing (n=88, net −3.75) — R1's *ratio* is what's untested |
| **S1** | ~ (re-weights the incumbent's own trades) | − (**sizing isn't alpha** — killed as Z1/C11; and with **drop3 now negative the tail winners carry net**, so conviction-weighting concentrates INTO the tail → drop3 gets *worse*, the opposite of the goal) | ++ | − (cannot create expectancy where the entry is negative) | + | + | **KILL** | sizing never flips a negative entry; here it actively worsens the binding metric (drop3) |
| **E1** | − (exit overlay, lane dead) | − (**exit engineering never flipped a losing entry**; a fast time-conditioned cut IS a tighter-than-SL30 stop = poison; the P/Q/R/S sweep killed every such overlay incl. `nochase`/`crowdexit`) | + | − (dominated: the falling-knife subset is an **entry** problem already handled by `minEntryDriftPct:-20` in freshdip-bounded) | ~ | ++ | **KILL** | the exit graveyard, and dominated by an existing entry gate |
| **N1** | ++ (measurement layer — competes with nothing) | ++ (a recorded, first-order question: real edge death vs a known cost-transition artifact the 07-12 lab addendum flagged) | ++ | ++ | ++ | ++ (read-only ops-DB, no slot) | **PROMOTE (measurement study)** | the D3-lineage move: before spending any slot on an overlay of a below-bar entry, establish whether the entry is *genuinely* dead at 6% or still mid-transition |

**Survivorship gate applied:** R1's ratio reads `lead_buy_sol` and `pool_quote_sol` recorded *at the
fill* — forward-only, no backfill. N1 partitions recorded rows by close-timestamp (cost era), a
bookkeeping split. No promoted idea keys on an after-entry-resolved field. (S1/E1 are killed on the
graveyard prior, not survivorship.)

**Promote count: 1 offline signal study (R1) + 1 measurement study (N1) — zero shadow slots.** The
board is over-cap and uniformly red; nothing here queues a slot. This is the same deliberate shape as
07-12/07-13: resolve the model of the edge before spending slots on overlays of a below-bar entry.

---

## Phase 4 — promoted pre-registered theses

### R1 — `copy-relimpact` (D6) — relative price-impact as a lead-conviction gate

*Thesis written 2026-07-16, before any validation ran; predictions pre-registered. Status: pending
probe (path (c) — offline ops-DB replay, zero RPC, no slot; runs once data matures ~07-22..07-24).
Voice: proposal. This promotes the 07-13 D6 HOLD to a pre-registered study — pre-registering before
the data matures is the stronger discipline (the result can't be re-scoped after the fact).*

**One-liner.** Among the incumbent's hot-lead entries, keep only those where the lead's own buy was
large *relative to the pool's SOL depth* (`lead_buy_sol ÷ pool_quote_sol ≥ θ`) — a lead putting 2 SOL
into a 20-SOL pool (10% impact) signals categorically more urgency/conviction than 2 SOL into a
200-SOL pool (1%), and that subset may be the part of the decayed hot-lead entry that still clears the
realistic-cost bar.

**Mechanism.**
- *What asymmetry:* the lead's *price impact* is a behavioral signature of how much they know — willing
  to move the pool means willing to pay for immediacy. Absolute buy size (`copy-bigbuy`, ≥2 SOL) was
  refuted because 2 SOL means nothing without the pool context; the **ratio** normalizes it.
- *Who's ahead / why it persists:* the crowd can see the lead's buy but not price its *impact against
  live depth* fast enough at a fresh, thin pool; the tape surfaces the buy, not the buy-to-depth ratio.
- *Edge family:* microstructure / conviction-signature on the OG base — information-asymmetry, not a
  public chart feature (the ratio is about the *lead's action vs pool state at entry*, not the token's
  outcome). Distinct from the refuted absolute-size and the failing absolute-depth (`fable-deep`) cuts.

**The one lever changed.** Add one gate to the incumbent chassis (identical entry/exit otherwise):
`minLeadImpactPct { minRatio: θ }` — skip the copy if `lead_buy_sol / pool_quote_sol < θ` at the
delayed-entry fill (both already recorded per-row). θ is **calibrated from the replay, not fitted
post-hoc** — the replay reports the metric by ratio-tercile and θ is pre-declared as the lower bound
of whichever tercile clears P1 in *both* halves (no intermediate-cutoff fishing, per the freshdip
lesson).

**Pre-registered predictions (each on the realistic `-lag` rows at 6% cost; each with a kill criterion):**
- **P1 — the high-impact subset carries the surviving edge.** On the pooled hot-lead `-lag` rows
  (strict-hi n=198 + strict retired rows that carry both fields, time-ordered, split-half): the
  **top ratio-tercile** has **net/trade > 0 AND drop3/trade > 0 in BOTH halves**, and beats the
  bottom tercile by **≥ +0.02 SOL/trade**. FAIL → relative-impact does not isolate a live subset →
  KILL the gate (and it becomes strong evidence for the N1 "entry is dead at realistic cost" verdict).
- **P2 — it beats the ungated incumbent on robustness.** The top-tercile subset beats the full
  incumbent on **drop3/trade** with net/trade **≥** the incumbent's. FAIL → the ratio adds no
  robustness → shelve.
- **P3 — reachability.** The retained subset (θ = the P1-clearing tercile bound) keeps **≥ 40%** of
  the incumbent's historical fires (≈ ≥3/day at post-D1 volume). FAIL → over-filters → report the
  finding but do not spawn a challenger.
- **Decision rule:** propose a one-lever challenger (`copy-relimpact`, incumbent chassis +
  `minLeadImpactPct`, its own `-lag` twin) only if **P1 ∧ P3** (P2 upgrades conviction). If P1 fails,
  KILL and feed the negative into N1's verdict.

**Probe plan.** Path (c): read-only `ops`-branch DB queries over closed `-lag` copy rows carrying both
`lead_buy_sol` and `pool_quote_sol` (recording began 07-10 → readable ~07-22..07-24; **the offline
replay runs in Phase 2 once row count with both fields ≥ ~150 across the split-half, checkable with one
`SELECT COUNT(*) … WHERE lead_buy_sol IS NOT NULL AND pool_quote_sol IS NOT NULL` per era**). *Point-in-time
construction:* both fields are stored at the fill, forward-only, no backfill; null on either → not
blocked (benefit of the doubt, matching `maxExtensionPct`/`minPoolSol`). *Promotes to a shadow slot
when:* P1 ∧ P3 in the replay → the challenger spec goes to `solana-strategy-phase-2`.

**Cost + capacity.** Compute-only to test; the deployed gate is zero-RPC (both fields come from the
same vault read + tx parse that already run). Reachability is P3's checkpoint. `-lag`/cost inherits
the incumbent's TP100/SL30 at 6%.

**Correlation.** Same leads as the incumbent — deliberately: it is a *subset selector* on the sole
(now-marginal) edge, not diversifying ballast. Its value is a possible **rescue path** for the
below-bar incumbent (isolate the still-profitable subset) *and* a clean diagnostic (if even the
high-impact tercile can't clear drop3>0 at 6%, the entry is dead — a decisive negative worth as much
as a positive).

---

### N1 — `incumbent-edge-death-vs-cost-transition` — is the hot-lead entry genuinely dead at 6%?

*Category: measurement. Status: proposed read-only ops-DB study (no slot). Voice: proposal.*

**Verdict / question.** The incumbent went drop3-negative (−0.78) and stress-negative (−2.44) at
n=198 — but the 07-12 lab addendum explicitly flagged that the 3%→6% re-cost makes every cumulative
number a **mixed-cost-era blend** for ~1–2 weeks (old rows 3%-costed, new rows 6%-costed), and the
`degrading` trend is partly a cost-era artifact. Before any signal work is worth a shadow slot, resolve:
**is strict-hi's fall a real edge death, or a residual of the cost transition + a bad recent cluster?**

**Recommended change (read-only study, zero code/slot).** Partition strict-hi's (and pooled hot-lead)
`-lag` rows by close-era: **pure-6%-costed rows only** (closed after the 07-12 recost deploy) vs the
3%-era. Compute net/trade + drop3/trade on the 6%-only cohort at n and by rolling window. This is the
apples-to-apples read the M1 fix set up but no daily/lab cycle has yet run on a full 6%-only sample.

**Pre-registered observable + kill criterion.**
- **P1 — the honest 6%-only read.** PASS (edge survives, keep iterating on signals) if the 6%-only
  cohort at n≥100 has **drop3/trade > 0**; FAIL (edge is dead at realistic cost) if drop3/trade ≤ 0 on
  the 6%-only cohort at n≥100 → the North-Star verdict flips to *"no edge on the current data clears
  the realistic-cost bar; the goal now needs a genuinely new data input or lower execution cost, not
  another gate"* and the next cycle stops spawning overlays.
- **P2 — cluster vs trend.** Report whether the recent −0.044/t is a single loss cluster (few mints)
  or broad; a concentrated cluster on the 6%-only cohort tempers the P1-FAIL reading.

**Why this beats a signal thesis this cycle.** Identical logic to 07-12's D3, which correctly called
this exact decay: the mission runs on the scoreboard, and the scoreboard's most important number (is
the sole edge alive?) is currently ambiguous between edge-death and a known measurement transition.
Resolving it is higher-EV than any overlay of a possibly-dead entry — and it gates whether R1 is a
rescue mission or an autopsy.

---

## Summary for the operator

- **The dominating fact:** the sole promotable `copy-hotlead-strict-hi` has **fallen below the bar**
  (drop3 −0.78, stress −2.44, n=198, degrading) — exactly as the 07-12 D3 study predicted the 6%
  re-cost would do. `n_promotable_stable = 0`; every challenger is net-negative.
- **Of the three operator seeds, one survives the screen:** **Seed 1 (relative-impact) → PROMOTE as
  R1**, an offline ops-DB replay (path c, no slot), reframed for the current state as both a possible
  rescue of the below-bar incumbent and a diagnostic. It is the only seed that is entry-*selection*
  (an entry gate can improve a marginal entry) rather than exit/sizing.
- **Seeds 2 & 3 → KILLED at the screen** (the cheapest win): **Seed 2 (sizing)** isn't alpha (killed
  twice as Z1/C11) and now actively worsens drop3 (conviction-weighting concentrates into the tail
  winners that carry a drop3-negative book); **Seed 3 (no-bounce exit)** is the exit-engineering
  graveyard (tighter-than-SL30 = poison) and is dominated by the existing `minEntryDriftPct:-20`
  entry gate.
- **Also promoted: N1**, a read-only measurement study (D3 lineage) — resolve whether the incumbent's
  fall is real edge-death or a 3%→6% cost-transition artifact **before** spending any slot; it gates
  whether R1 is a rescue or an autopsy.
- **Zero new shadow strategies** — fourth cycle running. The board is over-cap and red; the signal
  lane is 0-for-N; the highest-EV work stays offline studies + measurement.
- **Open trigger:** D1 `copy-watchlist-unlock` day-7 read ~07-19 (whether *supply* is the binding
  constraint). C4 nodump / C5 breadth are the nearest natural KILLs as they cross n≥100.
- **Sequencing recommendation:** run **N1 first** (it's runnable now on recorded rows); if N1-P1
  FAILS (edge dead at 6%), R1 becomes an autopsy that confirms the "need new data/lower cost" verdict;
  if N1-P1 PASSES (edge alive, transition artifact), R1's replay at data maturity (~07-24) becomes the
  live rescue candidate.
