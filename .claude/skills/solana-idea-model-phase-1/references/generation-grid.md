# Generation Grid — the divergent engine

Read in Phase 2. The goal is **coverage**: walk this grid deliberately so generation doesn't tunnel on the one corner it wants to tunnel on — *another exit tweak on the same wallets*, or *another step of the hot-lead net-floor hill-climb*. Those are Phase-2's convergent hill-climb, not new ideas. Generate breadth first; the screen cuts later.

The grid has three axes. A candidate is a **lever × edge-source** anchored by a **point-in-time signal** (the fresh, at-entry-knowable quantity you'd key on). Walk the levers as the outer loop — and within them push hardest on the wallet-source and selection axes, where the portfolio is most likely to find *uncorrelated* edge.

The mission is fixed (copy smart wallets on post-graduation PumpFun; graduation-arb is retired), so unlike a multi-market venue the divergence is **within one mechanic**. That makes anti-anchoring *more* important, not less: the space of "which wallets, which of their entries, how fresh" is large and mostly unexplored, while the gravity keeps pulling back to the incumbent's exact lever.

---

## Axis 1 — The four levers (the outer loop)

A copy-strategy is a configuration across these. **The a-priori "leverage" ordering below is a starting guess — override it with your Phase-0.5 realized hit-rate table.** The concrete params live in the `CopyStrategy` interface (`src/copytrade/copy-trader.ts`) and `DISCOVERY_SOURCES` (`src/copytrade/discovery-sources.ts`).

1. **Which wallets to follow — discovery + scoring.** ⚠️ **PRIOR INVERTED (as of 2026-07).** This *was* labelled the highest-leverage lever / open frontier — a better base once turned a losing control into the promotable incumbent. But that base is the **OG graduation seed**, and every attempt to find a NEW or better source than it has died: cotrade FAILS, live_tape PRUNED (n=24, unreachable), winner_sniper PRUNED (n=148, −0.048/t — *worse* than unselected OG), external stalled, gradspec frozen. Root cause: own-trading skill doesn't transfer to a 5s-lagged entry-only mirror (r≈0), and non-OG wallets rarely trade the copyable universe (can't reach n≥100). **Re-selecting *who* to follow from the same on-chain data is a graveyard — do NOT lead here.** The lever only re-opens with a genuinely new **data input** (not another reselection heuristic) that ALSO clears the Phase-2 reachability pre-gate. Two sub-levers, both now *low* prior absent new data:
   - **Discovery source** — *how* wallets are found. Params: `leadSource` (registry-quarantined pipeline), `leadCohort` (`og_smart` vs `cotrade` graph snowball), `leadSelection` (`v1` own-P&L set vs `v2` copy-net set — positive selection REFUTED), `walletAllowlist`. A brand-new source is a one-row `DISCOVERY_SOURCES` change + a harvester (see the discovery-playbook) → the standardized `copy-src-<id>` probe. *Prior: LOW unless it brings new data + passes reachability.*
   - **Scoring / selection within a source** — which surfaced wallets are tradable. The winner-sniper 3-stage funnel (profit-credit → forward pre-filter → scorer) is the out-of-sample-by-construction template, but it was itself PRUNED — a rigorous funnel on non-transferable skill still fails. *Prior: LOW.*

2. **Entry gating — which of a followed wallet's entries to copy.** A rich, mostly-unexplored param family. The one gate proven to hold is the **recency hot-lead gate** (`hotLeadGate {lastN, minTrades, minNetSol}` — "our last-N copies of this lead netted ≥ X"); raising the net-floor `X` buys drop3 robustness (the live hill-climb — that specific climb is Phase-2's, not a new idea). Other live/available gates to generate around:
   - `minConsensusRecent` — ≥ N distinct smart wallets bought this mint in 10min (token-level "what"; consensus≥2 is a keeper, ≥3 over-filters).
   - `maxConsensusRecent` — *inverse:* AT MOST N prior smart buyers = **earliness / first-mover** (are we early, not buying exit liquidity?). Zero RPC.
   - `maxTokenAgeSec` — **token-freshness**: skip if the token graduated > N sec ago. Offline replay found tokens <15min post-grad carried the entire robust edge; older buckets went drop3-negative. Fresh grads are where detection infra has the information edge. Zero RPC (cached).
   - `maxExtensionPct` — skip if the pool has already run > N% above the graduation open (don't chase). Distinct from `maxEntryDriftPct`. Zero RPC.
   - `minLeadBuySol` — conviction: only copy when the lead's own buy ≥ X SOL (size = conviction; ≥2 SOL alone did *not* survive costs — needs a fresh angle).
   - `minLeadRank` — lead's follow-list rank ≤ N.
   - `maxEntriesPerMint` — repeat-buy cap (1st/2nd entries profit, 3rd+ bleed).
   - `leadExclusionGate` — per-strategy dynamic pruning (self-prunes the bottom leads as n grows).
   - `excludeProvenBadLeads` — proven-bad veto (the surviving copy-net half — but refuted *forward*; don't relitigate without a new angle).
   *Prior: MEDIUM–HIGH for a genuinely new gate/signal; LOW for another net-floor step (that's the incumbent's own climb).*

3. **Exit rules — TP/SL/trailing/time.** Chassis, not alpha. Params: `tpPct`, `slPct`, `exitFollow`, `maxHoldSec`, `breakevenAtPct`, `ratchet`, `scaleOut`, `trailingTp`, `followSellDelaySec`. The robust chassis is **TP100/SL30**; tighter stops are poison; exit engineering *never flipped a losing entry positive*. *Prior: LOW — don't lead here.* Only worth a slate slot if paired with a genuinely new *entry* edge.

4. **Sizing — position size / concentration caps.** A risk lever, not an alpha lever; judged against the monthly-run-rate bar and drop3. `executionMode: 'live_micro'` is the live knob (0.05 SOL behind the circuit breaker). *Prior: LOW for alpha; relevant for capacity/robustness framing.*

`entryDelaySec` (the **`-lag` twin**, 5s) is not a lever to optimize — it's the realistic-execution *measurement* every real strategy carries. Every candidate is judged on its `-lag` twin.

---

## Axis 2 — Edge-source (walk against each lever)

*Where does the information asymmetry come from?* The copy edge is always "a lead knows/sees something and you mirror it before decay," but the **source** of that asymmetry varies — and different sources have different return drivers (this is what makes an idea *uncorrelated*). Walk these:

- **Lead identity + recent form** — a specific wallet's recent copy profitability (the hot-lead recency gate). The incumbent's driver. *Saturated on the net-floor axis; correlated with the incumbent.*
- **Cross-token generalizable skill** — wallets that keep profiting on *other* tokens, proven out-of-sample (the winner-sniper pre-filter). The frontier — a source that reliably surfaces genuinely-skilled early buyers is the biggest available win. *Low correlation to recency; HIGH prior.*
- **Consensus / crowding** — multiple *independent* smart wallets converging on the same fresh mint (token-level signal, `minConsensusRecent`). Different driver from single-lead recency. *consensus≥2 is a keeper; screen correlation with the consensus control.*
- **Earliness / first-mover** — being among the *first* smart buyers, before the crowd provides exit liquidity (`maxConsensusRecent`, `maxExtensionPct`). The inverse of consensus — tests whether *early* beats *confirmed*. *Novel driver; largely untested.*
- **Freshness / decay stage** — the token's age since graduation (`maxTokenAgeSec`); the edge concentrates in the <15min window where detection infra leads and the token's fate is unresolved. *Strong recent signal; combine with other sources.*
- **Conviction / behavioral signature** — the lead's own buy size, speed, or hold pattern as a signal of how much *they* know (`minLeadBuySol` and its unexplored cousins). *Buy-size alone failed; a richer behavioral signal is open.*
- **Microstructure at entry** — pool state / buy-pressure at the moment of copy (from `parse-swap` / the pool-vault reads). Point-in-time by construction. *Under-explored; must be at-entry-knowable.*
- **Discovery seeding** — the raw pipeline that surfaces candidates before scoring (firstbuyer/dev/creator wallets, competition signals, live-tape, external leaderboards, co-trade graph). *cotrade FAILS, live_tape PRUNED, external COLLECTING — new seeding theses are the anti-anchor slot.*

---

## Axis 3 — Point-in-time signal (the anchor for every candidate)

Every candidate must key on a **fresh signal knowable at the lead's buy**. This is both the anchor and the first safety check: a signal that resolves *after* entry is disqualified on sight (the `holders≥250 (backfill)` +24% trap — pure survivorship, invisible to walk-forward). For each lever × edge-source, name the exact quantity and confirm it's at-entry-knowable:

- **Our last-N copy net of this lead** (recency) — knowable; the proven signal.
- **Distinct smart-buyer count on the mint in the last 10min** (consensus / earliness) — knowable at the buy; zero RPC.
- **Token age since graduation** (`migration_timestamp`, cached) — knowable; zero RPC.
- **Pool extension above graduation open** (`open_price_sol`, cached) — knowable; zero RPC.
- **Lead's own buy size in SOL** (parsed from their tx) — knowable at the buy.
- **A wallet's forward-validated skill** (winner-sniper pre-filter: profitable on ≥2 *other* closed positions) — out-of-sample by construction, so it *is* at-entry-knowable when the pre-filter enrolls before the trigger. Contrast with MTM-at-final-price used as a live gate (that would be look-ahead).
- **Pool microstructure at entry** (buy pressure, vault balances) — knowable if read at the copy moment, not backfilled.

Disqualified-signal smell test: if computing the signal requires knowing how the token *ended up* (final holder count, whether it rugged, peak price, "confirmed recovery"), it's post-entry-resolved → poison. Do not slate it.

---

## How to walk the grid (Phase 2 procedure)

1. For each **lever**, ask: which **edge-sources** (Axis 2) could power a new strategy on it, given the live board and — above all — your **Phase-0.5 realized hit-rate** (which overrides the a-priori lever ordering)?
2. For each viable cell, name the **point-in-time signal** (Axis 3) — the exact at-entry-knowable quantity — and confirm it survives the disqualified-signal smell test.
3. **Apply the reachability PRE-gate before writing the line:** estimate the candidate's fire-rate on the copyable (post-grad PumpFun) universe. If it can't plausibly reach n≥100 in the readable window (the `live_tape` n=24 / gradspec-frozen death), drop it now — don't slate it and let screen-axis 5 catch it later.
4. Write the surviving candidate as one line: *lever × edge-source, the signal, one-sentence edge (who's ahead, why it persists).*
5. Explicitly include ≥ a few candidates that **do not share the incumbent's return driver** — a fresh consensus/earliness/freshness signal on the OG base, a microstructure-at-entry signal, or (when the signal lane is dry) a **non-signal candidate**. Anti-anchoring is a hard requirement; a slate of exit-tweaks or net-floor-steps fails the gate.

**The non-signal categories (generate these when the signal lane is saturated — they are first-class candidates, not a fallback).** The four levers above are all *signal* levers, but the North-Star deliverable is the highest-EV change toward SOL accumulation, and the binding constraint is often elsewhere. Put these on the same slate and screen them head-to-head with the signals by expected SOL contribution:
- **Capacity / supply** — the proven edge is throttled: watchlist cap (WS-billed), scoring backlog, a too-strict gate starving fire-rate. Un-throttling lifts *every* strategy at once. Observable: fire-rate / lead-pool / n-timeline before vs after. (Worked example: D1 `copy-watchlist-unlock`, 2026-07-12.)
- **Execution cost** — the shadow bar mis-prices real fills (`SIM_DEFAULT_COST_PCT` vs measured slippage), so a "promising" shadow may be a live loser. Reconciling it via an ops-DB study is pure EV. (Worked example: D3 `live-cost-recon`, 2026-07-12.)
- **Measurement / integrity** — a scoreboard bug, a survivorship leak, a stale live flag distorts every downstream decision. (Worked example: the stale `hold30m-live-micro` active flag, 2026-07-12.)

---

## Seed ideas (illustrative starting points, not an exhaustive or pre-approved list)

Use these to prime the pump, then generate beyond them. Each still must pass the Phase 3 screen — several deliberately probe the priors.

- **Earliness gate (entry-gating × first-mover × prior-buyer-count).** `maxConsensusRecent = 1`: only enter when the triggering lead is the *sole* smart buyer so far — test whether being early (not buying later smart buyers' exit liquidity) is the real edge, the inverse of consensus. Zero RPC, novel driver, low correlation to recency. *This is exactly the kind of anti-anchor candidate the phase wants.*
- **Freshness × recency stack (entry-gating × freshness × token-age + last-N-net).** Layer `maxTokenAgeSec` (<15min) onto the hot-lead gate — the freshdip family. Screen the correlation with the incumbent hard (shares the recency driver) but the freshness restriction may carry independent robustness. Zero marginal RPC.
- **A new wallet SOURCE via a fresh harvester (discovery × cross-token-skill × forward-validated-skill).** ⚠️ **This lane is now a graveyard** (cotrade / live_tape / winner_sniper / gradspec all PRUNED or frozen — reselecting who to follow from the same on-chain data doesn't transfer to a lagged mirror, r≈0). A new-harvester thesis is LOW prior and **only viable if it brings a genuinely new *data input*** (not another seeding heuristic over the same pool) AND passes the reachability pre-gate up front (the `live_tape` failure mode: wallets that don't trade the copyable universe → stuck at n=24). Do not slate this just to satisfy anti-anchoring — an unreachable or same-data source is a known dead end, not diversification.
- **Microstructure-gated entry (entry-gating × microstructure × pool-buy-pressure-at-copy).** Gate copies on the pool state at the copy moment (e.g. net buy pressure / vault imbalance) — a *when-to-copy* signal distinct from *which lead*. Must be read at entry (not backfilled) to pass the survivorship gate. Under-explored; verify the signal is point-in-time.
- **Behavioral-signature lead selection (which-wallets × conviction/behavior × lead-speed-or-pattern).** Beyond raw buy size (which failed): select leads by a behavioral signature knowable at the buy (e.g. how fast they entered post-graduation, their typical hold shape) as a proxy for how much they know. Novel driver; define the exact at-entry-knowable feature and screen it against the public-feature graveyard (it must be about the *lead*, not the token's public chart).
- **The anti-anchor open slot.** Deliberately empty here — a lever × edge-source the live book has *no* exposure to. Fill it during generation with something that does not share the incumbent's leads or signal.
