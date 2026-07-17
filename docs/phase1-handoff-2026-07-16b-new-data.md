# Phase-1 Idea-Model Handoff — 2026-07-16 (B) — the new-data-input cycle

*Produced by `/solana-idea-model-phase-1` (divergent front-end). Runs in chat; stops at the probe
spec. **Proposal voice** — every change below is a proposal for the operator to review, and each
requires a **data-ingestion build the operator must approve** before it can become a shadow probe.
Nothing here touches live money or edits `COPY_STRATEGIES`. Previous handoff same day:
`docs/phase1-handoff-2026-07-16.md` (the operator-seeded on-feed pass whose three levers became N1,
all resolved dead). This is a **separate, later directive.***

**Operator directive for this cycle (hard constraint):** generate candidates **only** in the
"genuinely new data input" category. Any candidate that re-derives from the existing
graduation/PumpFun on-chain feed — any new way to *select, score, or discover wallets* from the same
on-chain data — is **auto-disqualified**, regardless of packaging. Anti-anchoring this cycle is about
the **data source**, not the strategy shape: a clever new gate/exit/sizing on the same feed does NOT
count as new. Carry the cost finding forward as a **hard survival constraint** — a new data source
must plausibly produce an edge large enough to survive a **6–10% round-trip**, not merely be
statistically distinguishable in a backtest. The screen's correlation axis is raised to ask
explicitly: *does this data source depend on the same on-chain wallets/transactions the OG feed
already sees? Kill on sight if yes.*

---

## Phase 0 + 0.5 — grounding & own hit-rate (why the constraint is correct)

Every lane that re-derives from the existing on-chain feed is now closed — confirmed by this skill's
own realized hit-rate, not just the arena's:

| Lane (all key on `graduations` / `copy_trades` / `wallet-history`) | Verdict | Evidence |
|---|---|---|
| New wallet **source** (same feed) | **0-for-5 graveyard** | cotrade FAILS · live_tape PRUNED (n=24) · winner_sniper PRUNED (n=148, −0.048/t, *worse* than unselected OG) · external COLLECTING/stalled · gradspec frozen (n=4) |
| Entry-**gate** / exit / sizing (same feed) | Closed | N1 (2026-07-16) reconfirmed the hot-lead entry is dead at realistic cost; exit engineering never flipped a negative entry positive; the 07-16 (A) operator-seeded impact/sizing/exit levers all screened to the same graveyard |
| **Cost** reduction | **Closed 2026-07-16** | Operator live trading experience: real round-trip ran **6–10%**, sometimes worse than the 6% SIM — stronger than any calibration burst. 6% may be a *floor*, not a ceiling |

The `copy-strategy-lab.md` 2026-07-16 resolution states it outright: *"The ONLY remaining path to a
promotable strategy is a genuinely new data input — something the bot does not currently read at
all."* This cycle executes that instruction.

**Own promoted-thesis hit-rate by edge-source:** new-wallet-source **0/5**; gate/exit/sizing
perturbations **0/many**; the only ever-survivor was the incumbent's own recency hill-climb, now
degrading. The a-priori grid's "dig into wallet-source" prior is fully **inverted** — re-selecting
*who* to follow from the same on-chain data is a dead lane, and re-shaping *how* we trade it is too.

---

## Phase 1 — the live board (why this is a Part-C binding-constraint cycle)

- **Board at cap; every realistic strategy red or degrading.** Incumbent `copy-hotlead-strict-hi`:
  n=203, net +2.0 but **drop3 −0.7, exit-stress −2.4, degrading** → arena marks it `PRUNE`. Control
  `copy-tp100-sl30-lag`: −49 SOL. `experiment_arena.live_micro_candidate: null`,
  `promote_review: []`, `n_promotable: 0`.
- **Discovery scorecard:** `external` COLLECTING (n=13/100, stalled), `gradspec` frozen (n=4) — the
  last two same-feed sources, neither reachable.
- **Implication for the promote budget:** there is no healthy incumbent to perturb and no on-feed
  shadow slot worth spending. The correct output is **not** a `COPY_STRATEGIES` entry — it is a
  ranked proposal for *what new data to ingest*. Each thesis below is gated behind a data-ingestion
  build; none consumes a shadow slot until the operator approves that build.

---

## Phase 2 — divergent slate (new-data-input ONLY)

Admissibility per line: the signal must **not** be computable from the existing tables, **and** its
edge must plausibly clear a **6–10% round-trip** — i.e. it must flag *large directional catalysts*,
not marginal statistical tilts (a weak edge that cleared 3% modeling is exactly the trap that just
closed).

| # | Category | New (off-feed) data source | Point-in-time signal | Edge thesis |
|---|---|---|---|---|
| **S1** | Social | X/Twitter firehose | Influential-account first-mention + mention-velocity on ticker/CA within N min of grad | Off-chain caller attention is a demand wave that *leads* on-chain flow; winners 3–10× (clears 6–10%) |
| **S2** | Social | Telegram/Discord alpha-caller channels | A known caller group posts the CA | The call is off-chain and leads the buy wave the bot sees on-chain |
| **S3** | Off-chain platform | **pump.fun off-chain engagement layer** (livestream active, comment/reply velocity, unique chatters) | Livestream on + chat surge at grad | Engagement→demand tell pure on-chain can't see until buys already print; covers *every* pump token |
| **F1** | Off-chain funding | Entity/label provider (Arkham/Nansen-style attribution) | Early buyers funded by **fresh CEX withdrawals** vs recycled insider wallets | Real new money sustains; insider-wash dumps — a large directional split |
| **P1** | Off-chain reputation | Off-chain creator-identity graph (prior launches/rugs, socials) | Creator's off-chain rug history known at grad | Avoid rug-class launches (−100% tail) using data not on our chain feed |
| **C2** | Cross-venue | Frontend trending lists (Axiom/BullX/Photon/GMGN) | Token appears on a trending endpoint | Retail-attention proxy leading flow |
| **M1** | Mempool/timing | Solana pending-tx / Jito bundle stream | Large pending buy before it lands | See whale buys sub-block, enter same-block |
| **C1** | Cross-venue | CEX listing/rumor feed | Listing announcement | Listing pop |
| **P2** | Off-chain narrative | Off-chain trend/narrative feed | Token theme matches this week's pumping narrative | Narrative alignment |
| **W1** | Aggregated alert | Paid multi-chain "smart money" alert feeds | Feed flags the token | Aggregated alpha |

---

## Phase 3 — six-axis screen (correlation axis raised: kill if it depends on the same on-chain data)

| # | Genuinely off-feed? | Clears 6–10%? | Point-in-time safe? | Reachable to n≥100 on fresh grads? | Backtestable | Call |
|---|---|---|---|---|---|---|
| **S3** | ✅ pump.fun social layer, off-chain | ✅ engagement→big runs | ✅ engagement@grad | ✅ **every** pump token by construction | ⚠️ forward-collect only | **PROMOTE** |
| **S1** | ✅ X firehose, off-chain | ✅ caller waves 3–10× | ✅ mention ts ≤ entry | ⚠️ thin early social on some grads | ⚠️ costly historical X pull | **PROMOTE** |
| **F1** | ✅ entity labels, off-chain | ✅ real-money vs wash is large | ✅ funding known@grad | ✅ every token has early buyers | ✅ providers have history | **HOLD (3rd)** |
| **P1** | ✅ off-chain identity graph | ⚠️ rug-avoidance *filter* (reshapes loss?) but on *new* data | ✅ known@grad | ✅ high | ✅ | HOLD |
| **C2** | ❌ **trending = aggregation of the same on-chain volume** | — | — | — | — | **KILL (rule 5)** |
| **M1** | ❌ **same transaction stream, earlier** — latency surface, not a new signal; also the closed cost/execution lane | doesn't move 6–10% | — | — | — | **KILL (rule 5 + closed lane)** |
| **S2** | ✅ but fragmented coverage | ✅ | ✅ | ⚠️ | ❌ hard to ingest cleanly | KILL (reachability) |
| **C1** | ✅ | ✅ | ✅ | ❌ near-zero for fresh grads | — | KILL (reachability) |
| **P2** | ✅ | ❌ noisy/coarse | ✅ | ✅ | ⚠️ | KILL (weak edge) |
| **W1** | ❌ re-derives on-chain flow | — | — | — | — | KILL (rule 5) |

**C2, M1, W1 are the exact trap the directive targets** — each *looks* like a new venue, but its raw
ingredient is the same on-chain volume/transactions the OG feed already sees (trending is computed
*from* on-chain volume; mempool is the same tx stream a few hundred ms earlier; alert feeds
re-aggregate on-chain flow). Killed on the raised correlation axis regardless of surface novelty.

---

## Phase 4 — promoted theses (pre-registered) + binding-constraint verdict

### Verdict (Part C)
**No positive-EV signal exists on the current data; the binding constraint is a missing DATA INPUT.**
The two theses below are the highest-EV *new inputs* to feed in. Neither is a `COPY_STRATEGIES`
perturbation — each is a **data-ingestion build** the operator must approve before it can become a
shadow probe. The board being at cap with nothing promotable means the correct on-feed promote count
is **zero**; the EV is entirely in opening a new data surface.

---

### S3 — pump.fun off-chain engagement signal *(PRIMARY)*

*Thesis written 2026-07-16, before any validation ran; predictions pre-registered. Status: pending a
data-ingestion build + forward-collection probe. Voice: proposal.*

**One-liner.** Enter a fresh graduation only when the token's **off-chain pump.fun engagement**
(livestream active, comment/reply velocity, unique chatters in the last N minutes) is surging at the
graduation moment — a demand tell that lives entirely off-chain and that the on-chain feed can't see
until the buys have already printed.

**Mechanism.**
- *What asymmetry:* engagement on the pump.fun platform (livestream, chat) is a leading indicator of
  the retail demand wave; it is **not** on any on-chain table the bot reads.
- *Why it's ahead:* the crowd trading purely on-chain (including the OG smart wallets we mirror) only
  sees the demand once it hits the pool; the engagement surge precedes it.
- *Why it persists:* the tape can't surface "which of 50 simultaneous grads has a hot livestream"
  fast enough — the decay race is won off-chain.
- *Edge family:* **off-chain demand catalyst** — a genuinely new driver, uncorrelated with recency.

**The one lever changed.** A new **entry-gate input** sourced from a new `token_social` table
(off-chain), joined to the copyable graduation universe — NOT a re-selection of wallets.

**Pre-registered predictions (each on the `-lag` twin, each with a kill criterion).**
- **P1 — engagement selects large moves.** PASS if, in forward-collected data, the high-engagement
  bucket's `-lag` net/trade > 0 **AND drop3 > 0 at n≥100**; KILL if drop3 ≤ 0 at n≥100.
- **P2 — the edge clears realistic cost.** PASS if the high-engagement bucket's `-lag` net/trade
  beats the OG control `copy-tp100-sl30-lag` on **both** net/trade and drop3/trade **at an assumed
  6–10% round-trip**; KILL if it only clears at ≤3%.
- **P3 — reachability & signal coverage.** PASS if ≥ ~3 high-engagement fresh grads/day carry the
  signal (n≥100 within ~5 weeks of forward-collection); shelve if the engagement API can't be
  sampled fast enough at graduation or coverage < 1/day.

**Probe plan.** (a) Build a lightweight harvester that, at each detected graduation, samples the
pump.fun off-chain engagement state and writes a `token_social` row keyed by mint + timestamp
(point-in-time — sampled *at* grad, never backfilled). (b) After ~2 weeks of forward-collection,
offline-replay the copyable universe bucketed by engagement, judged on the `-lag` twin at n≥100 with
drop3. (c) Only if P1+P2 pass does it earn a gated `COPY_STRATEGIES` entry + its `-lag` twin.
*Point-in-time construction:* engagement is sampled at the graduation instant and stored immutably;
nothing re-resolves after the outcome, so the survivorship smell test passes.

**Cost + capacity.** Edge must be a *directional catalyst* (winners 3–10×) to clear 6–10% — that is
the whole reason S3 beat the marginal on-feed tilts. RPC/WS cost: **zero on the Helius surfaces**
(new data is an off-chain HTTP sample, not a watchlist growth) — the dominant WS cost is untouched.
Reachability is the main risk; P3 gates it.

**Correlation.** Zero shared return driver with the hot-lead recency book — a new off-chain demand
signal. Maximum diversification value toward the SOL-accumulation goal.

---

### S1 — off-chain social first-mention / caller-attention signal *(SECONDARY)*

*Thesis written 2026-07-16, pre-registered. Status: pending a data-ingestion build + probe. Proposal.*

**One-liner.** Enter a fresh graduation only when an **influential off-chain account first-mentions**
the ticker/CA (or mention-velocity spikes) within N minutes of graduation — the off-chain attention
wave that leads the on-chain demand.

**Mechanism.** *Asymmetry:* a large crypto account / caller posting the CA is a demand catalyst
invisible to the on-chain feed until buys land. *Why ahead:* social propagation leads pool flow by
seconds-to-minutes. *Why it persists:* the crowd can't map "which fresh grad just got called by whom"
in real time. *Edge family:* **off-chain attention catalyst** — new driver, uncorrelated with recency.

**The one lever changed.** A new **entry-gate input** from an X/social ingestion pipeline joined to
the copyable universe — not a wallet re-selection.

**Pre-registered predictions.**
- **P1 — mention selects large moves.** PASS if the mentioned bucket's `-lag` net/trade > 0 AND
  drop3 > 0 at n≥100; KILL if drop3 ≤ 0.
- **P2 — clears realistic cost.** PASS if it beats the OG control on net/trade AND drop3/trade at a
  6–10% round-trip; KILL if only at ≤3%.
- **P3 — latency & coverage.** PASS if the mention is detectable **before or within the 5s entry
  window** for ≥ ~3 grads/day; **KILL/shelve if social systematically *lags* the on-chain move**
  (then it's a coincident indicator with no capturable edge) or coverage < 1/day.

**Probe plan.** (a) Stand up an X/social ingestion filtered to a curated influential-account +
keyword set, writing `token_social` mention rows keyed by mint + first-mention timestamp. (b) Offline
pre-check is possible via a historical X pull for already-graduated tokens (costly but avoids a
2-week wait) OR forward-collect; either way judged on the `-lag` twin at n≥100 with drop3. (c) Gated
`COPY_STRATEGIES` entry + twin only if P1+P2 pass and P3's lead-not-lag check holds. *Point-in-time:*
key on first-mention timestamp ≤ entry; discard any token whose first qualifying mention is after the
entry instant.

**Cost + capacity.** Same directional-catalyst logic as S3. Ingestion cost is the main downside (X
firehose/API pricing); the **P3 lead-vs-lag check is the load-bearing kill** — if social is
coincident-or-lagging, S1 dies fast and cheap. Zero marginal Helius WS cost.

**Correlation.** Uncorrelated with the recency book; partially overlapping with S3 (both off-chain
attention) — if both survive, screen S1×S3 correlation before running both live.

---

### F1 — fresh-money funding attribution *(HOLD — third in line)*

Genuinely off-feed (entity labels), point-in-time, high reachability, and backtestable against
provider history — but heavier infra (a paid labeling provider) and a subtler edge (real-money vs
insider-wash) than the two attention catalysts. Hold behind S3/S1; promote if either fails P3.

---

## Why this beats spending a slot on another on-feed variant

The on-feed lanes are 0-for-many and formally closed (N1 + the cost resolution). Another gate/exit/
sizing tweak on the same data has a near-zero prior and would only add correlated variance to a book
that is already red. The entire remaining EV is in opening a data surface the bot is blind to today.
S3 and S1 are the two highest-EV such surfaces: both zero-marginal-WS-cost, both directional-catalyst
edges that can plausibly clear the 6–10% bar, both survivorship-safe by point-in-time construction,
and both uncorrelated with the recency book. **Recommend the operator approve the S3 `token_social`
harvester first** (highest reachability, zero Helius cost, cleanest point-in-time story), with S1 as
the fast-follow.
