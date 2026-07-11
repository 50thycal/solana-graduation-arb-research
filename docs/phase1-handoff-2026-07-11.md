# Phase-1 Idea-Model Handoff — 2026-07-11

*Produced by `/solana-idea-model-phase-1` (divergent front-end). Runs in chat; stops at the probe
spec. **Proposal voice** — every roster change below is a proposal for the operator to review +
deploy, never past tense. Nothing here touches live money or edits `COPY_STRATEGIES`. Survivors
enter `solana-strategy-phase-2` at its Phase 1 (thesis) / Phase 3 (implementation) with the
pre-registered predictions already articulated.*

---

## Phase 0/1 — grounding (what's contestable *right now*)

**Incumbent / correlation baseline.** `copy-hotlead-strict` — OG graduation-seeded wallets, hot-lead
recency gate `{lastN:10, minTrades:3, minNetSol:0.5}`, TP100/SL30, lag5 + drift10. n=820, net
+11.80, **net/trade +0.01439, drop3/trade +0.00636**, monthly 25.3 SOL/mo, score 100. Its sibling
`copy-hotlead-strict-hi` (net-floor 1.0) is the only other promotable (n=139).

**OG control** (`copy-tp100-sl30-lag`, the discovery-scorecard benchmark): n=1026, net/trade
−0.03303, drop3/trade −0.03776. The gap between the control and the incumbent **is** the hot-lead
recency edge.

**Two facts reframe this cycle:**

1. **The challenger board is at the `MAX_INFLIGHT=4` cap.** In flight: `strict-hi`, the 3-arm
   operator fable cohort (`fable-dip` / `fable-leadpullback` / `fable-deep`, one experiment), the
   freshdip line (`freshdip` + `freshdip-bounded`), and `hotlead-early`. Discovery track: `gradspec`
   + `external` probes. **There is no open spawn slot today** — survivors are *queued* for the slot
   that frees when a near-dead challenger resolves (see triggers below), not spawn-now.

2. **Both promotable strategies are `degrading`; `n_promotable_stable = 0`.** `copy-hotlead-strict`
   recent-per-trade −0.00423 (prior +0.0193); `strict-hi` recent −0.04509. The hot-lead edge is
   front-loaded and eroding — the cumulative bar is propped up by old winners. This is the Phase-3
   "incumbent weakening" trigger that calls for new ideas, and it means **drop3-robustness, not raw
   net, is the binding constraint** any new thesis must attack.

**Refined meta-lessons (re-derived from the live record; these override the generic priors this
cycle):**

- **Info-asymmetry via recency on the OG universe is the *only* surviving edge.** Every gate that
  works reads *our copy-net of this lead lately* (recency), not the lead's own P&L, not a public
  chart feature.
- **The wallet-source frontier is an empirical graveyard.** cotrade FAILS, live_tape PRUNED,
  **winner_sniper PRUNED** (n=148, −0.048/t — *worse* than unselected OG), external negative,
  gradspec funnel frozen (pre-filter default-OFF) + P1 missed (`smart_copyable` 4/10). Proven cause:
  **own-skill ≠ copyable (r≈0 transfer)** + non-OG wallets **don't reach the copyable universe**
  (can't hit n≥100). The skill's generic "weight source highest" is overridden by this cycle's data
  — *do not spawn a new source until a concrete fix for the r≈0 transfer + reachability walls
  exists, and let the two live probes resolve first.*
- **Public post-hoc chart features are dead** (−935 SOL graveyard). The `feature_signature` panel
  (buy-pressure unique-buyers d=0.955, whale-share d=−0.743, buy-ratio d=0.574) is *token-selection*
  signal, mostly `new-only`/`auto-backfill` coverage — using it as a copy gate re-enters that
  graveyard and risks survivorship. Excluded on sight.
- **Cumulative copy-net neither selects nor vetoes (only recency holds); exit/sizing engineering
  never flips a negative entry; net-positive / drop3-negative is a refused lottery.** Unchanged.
- **The recent backtests converge on one theme: buy weakness, not strength.** Dip fills carry the
  edge (07-03); hot leads coming off ≥2 recent losses mean-revert (+0.034/t vs −0.007/t clean-run,
  07-10); the 3+ smart-buyer crowd is the crowding cliff (+0.97% vs +6.36% at 2). The chase zone
  bleeds. **But** the live freshdip reads are still negative at small n (unbounded-downside falling
  knives), and **per-lead consistency screens already backfired** in backtest ("drop1-per-lead hurts
  −4.2; moonshot leads ARE the edge") — a hard prior against any idea that diversifies *away* from
  the concentrated winner leads.

**Slot-opening triggers to watch (when to actually spawn a survivor):** `hotlead-early` (n=46, drop3
−4.16, uniformly worsening → likely KILL soon); `freshdip` (n=42, drop3 −3.02); `gradspec` day-7
shelve. Any of these frees a slot.

---

## Phase 2 — the slate (diverge; screened in Phase 3)

| # | lever × edge-source | point-in-time signal (at-entry-knowable?) | one-sentence edge |
|---|---|---|---|
| C1 | source × co-buy graph | co-buyers of hot leads, selected forward by copy-net | expand the lead set from wallets that already trade our mints |
| C2 | source × cross-token skill | high grad-frequency wallets selected by *copy-net* not own-P&L | fix r≈0 by swapping the selection metric onto reachable wallets |
| C3 | scoring-within-OG × recency | rank OG leads by copy-net **drop3** (breadth), not sum | prefer leads whose recent copy edge is broad, not one moonshot |
| **C4** | **entry-gate × microstructure (sell-side)** | **live smart-crowd net buy/sell flow on the mint at copy (zero-RPC, cached)** | **veto copies where the smart crowd is net-distributing — don't be their exit liquidity** |
| **C5** | **entry-gate × portfolio breadth** | **this strategy's own recent copies of this lead in a window (zero-RPC)** | **cap repeat-copies per lead to broaden the underlying-bet distribution (drop3)** |
| C6 | which-wallets × behavioral signature | lead's historical median post-grad entry speed (cached ts) | select latency-advantaged leads as an informedness proxy |
| C7 | entry-gate × earliness | ≤1 prior smart buyer (`maxConsensusRecent:1`) | sole-smart-buyer = earliest, not exit liquidity |
| C8 | entry-gate × freshness | token age < 15min, no dip gate (`maxTokenAgeSec:900`) | isolate pure freshness from the dip confound |
| C9 | entry-gate × consensus (time-ordered) | ≥2 **hot** leads buy same mint within X s | fresh multi-lead conviction cascade, not a static count |
| C10 | exit × any | TP/SL/trail tweak | (coverage only — exit engineering is dead) |
| C11 | sizing × drop3 | size down on over-represented leads | drop3-aware sizing (risk lever, not alpha) |

---

## Phase 3 — six-axis screen

Axes: **1** correlation · **2** edge-plausibility vs graveyard · **3** survivorship/point-in-time ·
**4** execution/cost on the `-lag` twin (drop3>0) · **5** capacity/n≥100 reachability · **6**
infra/RPC reuse. (++ strong / + ok / ~ weak / − kill-level.)

| # | 1 corr | 2 edge | 3 surv | 4 exec | 5 cap | 6 infra | call | one-line reason |
|---|---|---|---|---|---|---|---|---|
| **C4** | ~ (overlay) | ++ | ++ | + | + | ++ | **PROMOTE** | novel sell-side crowd signal, zero-RPC, at-entry-safe, thins the SL tail → drop3 |
| **C5** | ~ (overlay) | + | ++ | + | ~ | ++ | **PROMOTE** | generalizes the *proven* `maxEntriesPerMint` (repeat tail bleeds) to lead-level breadth; drop3-targeted |
| C3 | − (incumbent's own driver) | + | ++ | + | + | ++ | HOLD | it's the incumbent's Phase-2 hill-climb (better lead metric), not a new idea |
| C6 | ~ | + | ++ | ~ | ~ | ++ | HOLD | novel but our leads are *all* fast post_grad_amm → may not discriminate; transfer unproven |
| C8 | − (recency driver) | + | ++ | + | + | ++ | HOLD | already **QUEUED** as `hotlead-fresh` (spawns when freshdip resolves) — not new |
| C9 | − (hot-lead + consensus) | ~ | ++ | ~ | − | ++ | HOLD | double-hot-lead gate cuts fire-rate hard → n≥100 unreachable; correlated |
| C7 | − (== losing `hotlead-early`) | ~ | ++ | ~ | − | ++ | KILL | sharper cut of a lever already bleeding live (hotlead-early n=46, drop3 −4.16) |
| C1 | − (same mints) | ~ | + | ~ | ~ | + | KILL | co-buyers trade our exact mints → returns correlated with incumbent; cotrade already FAILED |
| C2 | + | − | + | − | − | + | KILL | source graveyard: r≈0 transfer + reachability; gradspec is the frozen version of this |
| C10 | − | − | — | − | — | — | KILL | exit engineering never flips a negative entry (graveyard) |
| C11 | ~ | ~ | ++ | ~ | + | + | KILL | sizing isn't alpha; "moonshot leads ARE the edge" cautions against down-weighting them |

**Survivorship gate applied to each:** C4/C5/C6/C7/C8/C11 all key on live crowd events, cached
timestamps, or the strategy's own closed rows — knowable at entry, no backfill. C2 (copy-net on new
wallets) is safe by construction (forward-only). No promoted idea leans on an after-the-fact field.
The `feature_signature` buy-pressure columns were excluded from generation as public-feature /
backfill-survivorship risk.

**Two promote, the rest hold/kill.** Neither promote is *uncorrelated ballast* — both are
drop3-robustness **overlays on the sole surviving edge**. That is the honest, deliberate call this
cycle: the uncorrelated frontier (sources, cross-skill, earliness, consensus) is a graveyard, the
incumbent is degrading, and **drop3 is the gate that blocks promotion** — so the highest-EV move is
new *at-entry information* that thins the incumbent's loss tail, not another bet on a dead
uncorrelated driver.

---

## Phase 4 — promoted pre-registered theses

### C4 — `copy-hotlead-nodump` — veto copies made into smart-crowd distribution

*Thesis written 2026-07-11, before any validation ran; the predictions below are pre-registered.
Status: pending probe (queued — spawn on the next open `MAX_INFLIGHT` slot). Voice: proposal.*

**One-liner.** Copy the incumbent's hot leads, but **skip the entry when the watched smart crowd is
net-*selling* this mint in the seconds around our fill** — even a hot lead's buy is a trap if the
rest of the smart money is simultaneously distributing.

**Mechanism.**
- *What asymmetry:* the hot lead's buy says "informed money is entering"; the crowd's live sell-flow
  says "informed money is *exiting*." When both fire at once we are buying the crowd's exit liquidity
  at a fresh, thin pool — the SL-tail signature.
- *Who's ahead / who provides the exit liquidity:* us, in the vetoed subset — we'd be the last buyer
  before a smart-money-led fade. The veto removes exactly that cohort.
- *Why it persists:* the sell side of the watched crowd is **used by nothing on the entry path
  today** (`crowdSellExit` uses it only to *exit*); no live strategy prices "is the crowd dumping as
  I buy?" into the entry decision.
- *Edge family:* microstructure (sell-side crowd flow) — information-asymmetry, not a public chart
  feature. Distinct from `minConsensusRecent` (a buy-side count floor that failed drop3): this keys
  on the **buy/sell imbalance**, and the novel information is the sell leg.

**The one lever changed.** Add one gate to the incumbent chassis (identical entry/exit otherwise):
`smartFlowVeto { windowSec }` — skip if `countRecentSmartSellers(mint, windowSec) >
countRecentSmartBuyers(mint, windowSec)` at the delayed-entry moment (tier ∈ {promotable, smart},
the same source consensus already uses). Start `windowSec = 90`.

**Pre-registered predictions (each on the realistic strategy; each with a kill criterion):**
- **P1 — anti-lottery / drop3.** PASS if at n≥100 **net/trade > 0 AND drop3/trade > 0**; **KILL** if
  drop3/trade ≤ 0 at n≥100.
- **P2 — beats the incumbent on robustness.** PASS if at n≥100 it beats `copy-hotlead-strict` on
  **drop3/trade (> +0.00636)** with net/trade **≥ −10%** of the incumbent's (+0.01439); **KILL** if
  drop3/trade ≤ the incumbent's at n≥100 (the veto bought no robustness).
- **P3 — fire-rate / reachability.** PASS if it fires **≥ 3/day by day 5** (veto removes only the
  distribution subset, expected ≲25% of entries); if it can't reach **n≥100 in ~4 weeks**, the veto
  over-filters or the crowd-flow signal is too rare at the current 40-wallet watchlist → shelve.
- **Decision rule:** promote to a live-micro-candidate review only if **P1 AND P2** hold at n≥100;
  if P1 holds but P2 fails (drop3>0 but no better than the incumbent), keep as a WATCH robustness
  reference, don't promote; if P1 fails, KILL to the graveyard.

**Probe plan.** Path (a): one `COPY_STRATEGIES` entry = `copy-hotlead-strict` + `smartFlowVeto`
(the incumbent is already realistic at lag5, so the strategy *is* its own `-lag` twin). Shadow-trade
vs `copy-hotlead-strict` toward n≥100; PRUNE per arena rules if beaten on net/trade AND drop3/trade.
Fresh strategy id (never reuse a burned id). *Point-in-time construction:* the buy/sell counts read
`copy_probe_events` at the copy instant — forward-only, no backfill; missing data → not blocked
(benefit of the doubt, matching `maxExtensionPct`/`maxTokenAgeSec`). *Promotes when:* P1 ∧ P2 at n≥100.

**Cost + capacity.** `-lag`/cost: inherits the incumbent's TP100/SL30 economics; the veto only
*removes* trades (expected to remove net-negative ones), so drop3 should rise if the thesis holds.
RPC/WS: **zero marginal** — reuses the cached `countRecentSmart*` machinery and the existing
watchlist; no new subscriptions, no watchlist growth. Reachability: at ~5 incumbent fires/day minus
a ≲25% veto → ~3.5–4/day → n≥100 in ~4 weeks (the binding risk; P3 checkpoints it).

**Correlation.** Shares the hot-lead **return driver** with the incumbent (same leads, same mints
minus the vetoed subset) — a robustness overlay, not uncorrelated ballast. Value to the SOL goal:
the incumbent is degrading and drop3-thin; a filter that provably thins the SL tail is the most
direct path to a *stable* promotable strategy that clears the bar through bad tape.

---

### C5 — `copy-hotlead-breadth` — cap repeat-copies per lead to broaden the drop3 base

*Thesis written 2026-07-11, before any validation ran; predictions pre-registered. Status: pending
probe (queued). Voice: proposal.*

**One-liner.** Copy the incumbent's hot leads, but **cap how many times the book copies the *same*
lead within a rolling window**, forcing exposure across more distinct leads so no single lead's
trades dominate — a direct structural attack on the thin, fragile drop3.

**Mechanism.**
- *What asymmetry:* none new — this is a **portfolio-construction** lever on the proven edge. The
  incumbent's leads are a tight co-buy cluster (top pairs co-occur 25–31× in `smart-money →
  consensus`), so profit concentrates in few underlying bets → drop3 is fragile by construction.
- *Why it should help drop3:* mechanically, spreading the same n across more distinct leads reduces
  the marginal contribution of any single lead → removing the top-3 trades hurts less → drop3/trade
  rises. It generalizes the **proven** `maxEntriesPerMint` finding (1st/2nd entries profit, 3rd+
  bleed −5.8 SOL) from the *mint* level to the *lead* level.
- *Why it persists:* the book has never capped *winner-lead* concentration — `leadExclusionGate`
  only prunes *loser* leads, so nothing today broadens the winner distribution.
- *Edge family:* portfolio breadth / drop3-robustness overlay on the recency edge.

**The one lever changed.** Add one gate: `maxLeadCopiesPerWindow { maxCopies, windowSec }` — skip a
copy once this strategy already holds/opened ≥ `maxCopies` entries of **this lead** within
`windowSec` (reads the strategy's own open+recent-closed rows, exactly like `maxEntriesPerMint` /
`leadExclusionGate`). Start `{ maxCopies: 2, windowSec: 3600 }`.

**Pre-registered predictions (with the graveyard risk stated up front):**
- **P0 — the moonshot risk (pre-declared).** The 07-03 backtest found *"drop1-per-lead hurts −4.2;
  moonshot leads ARE the edge."* A lead-share cap risks cutting the concentrated winners that carry
  net. This is the primary kill-risk, declared now so the result can't be re-scoped: the cap targets
  the **marginal Nth repeat** (like the proven mint cap), **not** each lead's best trade — but if the
  data shows it removing net, P2 kills it.
- **P1 — drop3 improves.** PASS if at n≥100 **drop3/trade > +0.00636** (beats the incumbent) **AND
  net/trade ≥ 0**; **KILL** if drop3/trade ≤ the incumbent's at n≥100.
- **P2 — net not gutted (the P0 check).** **KILL** if net/trade falls below **+0.010** (a >30% net
  give-up vs the incumbent's +0.01439) *without* drop3/trade clearing +0.010 — i.e. it traded away
  the moonshots for no robustness gain.
- **P3 — reachability.** PASS if ≥ 3/day by day 5; shelve if it can't reach n≥100 in ~4 weeks (the
  cap plus the 40-wallet watchlist may starve it).
- **Decision rule:** promote to review only if **P1 holds AND P2 does not trigger**; otherwise WATCH
  or KILL per the triggers.

**Probe plan.** Path (a): `copy-hotlead-strict` + `maxLeadCopiesPerWindow` (already realistic → its
own `-lag` twin). Shadow vs `copy-hotlead-strict` to n≥100; also read against `maxEntriesPerMint`'s
logic as the conceptual control. Fresh id. *Point-in-time:* own open/closed rows only — knowable at
entry, no backfill. *Promotes when:* P1 ∧ ¬P2 at n≥100.

**Cost + capacity.** Zero marginal RPC/WS (own-series SQL, cached; no watchlist change). Reachability
is the larger risk here than for C4 — capping repeat-copies of the high-frequency leads cuts more
fire volume; P3 is the guard. `-lag`/cost inherits the incumbent's chassis.

**Correlation.** Same return driver as the incumbent (by design — it re-shapes the incumbent's own
distribution). Value: attacks the *exact* binding constraint (drop3 fragility from lead
concentration) that keeps `n_promotable_stable = 0`. Lower-conviction than C4 because of the P0
moonshot risk — promoted as the structural complement, to be spawned only if a second slot opens.

---

## Summary for the operator

- **Board is at cap; both promotables are degrading (`n_promotable_stable = 0`).** No spawn-now slot.
  Watch for `hotlead-early` / `freshdip` to resolve (both look near-death) → then spawn.
- **Promote (queued): C4 `copy-hotlead-nodump`** (smart-distribution veto — the cleaner, higher-
  conviction one: novel sell-side signal, zero-RPC, drop3-targeted) **and C5 `copy-hotlead-breadth`**
  (per-lead breadth cap — structural drop3 attack, with the "moonshot leads are the edge" risk
  pre-registered as its kill criterion).
- **Both are robustness overlays on the sole surviving edge, not uncorrelated ballast** — a
  deliberate call: the uncorrelated frontier is empirically dead, and drop3 (not net) is what blocks
  promotion.
- **Do not spawn a new wallet source** until the r≈0 transfer + reachability walls have a concrete
  fix and the two live probes (external, gradspec) resolve.
- **Killed at the screen (cheapest win):** C7 earliness (== the losing `hotlead-early`), C1/C2 new
  sources (graveyard), C10 exit tweaks, C11 sizing. C3/C6/C8/C9 held (incumbent hill-climb / already
  queued / reachability).
