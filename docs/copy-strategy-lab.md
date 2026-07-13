# Copy-Strategy Lab — ideation & convergence ledger

Maintained by the `/copy-strategy-lab` skill (weekly). Tracks the hill-climb toward a
**promotable** realistic copy strategy: the current incumbent, in-flight experiments and
their lineage, and the resolved log. Complement to `copy-trade-journal.md` (daily eval).

**Target:** a realistic strategy (5s entry lag) clearing n≥100 · drop3>0 · stress>0 · monthly≥3.75.
**Discipline:** one incumbent; spawn challengers that perturb its strongest lever by one param;
prune matured failures; cap in-flight experiments (MAX_INFLIGHT = 4); converge, don't sprawl.

---

## 2026-07-13 — A1/B1 offline study RESOLVED (phase-1 handoff 2026-07-13): copy-count decay CONFIRMED, calendar-tenure decay INVERTED, book-regime gate REFUTED

Executed the combined A1 (`lead-alpha-lifecycle`) + B1 (`book-edge-regime-gate`) ops-DB study
pre-registered same-day in `docs/phase1-handoff-2026-07-13.md` (operator-directed "proceed with
that test"). Data: all closed rows of `copy-hotlead-strict` (836, retired) + `copy-hotlead-strict-hi`
(155) + the `copy-tp100-sl30` baseline series (3,591) via the read-only `ops` channel; hot-tenure and
Nth-copy reconstructed at each entry from **prior baseline closes only** (the same construction as
the 07-10 leadpullback backtest); tercile bounds and K ∈ {20,30,50} fixed in the pre-registration.
Only 3/991 entries (0.3%) failed hot-at-entry reconstruction.

**A1 — PARTIAL CONFIRM, with a sign flip on the mechanism.** The lifecycle decay is real but it is
keyed on **how many times we've copied the lead**, not on calendar time hot:

- **P1 (tenure dimension): FAIL — INVERTED.** Young-tenure (≤20.3h hot) leads are the WORST cohort
  in both halves (h1 −0.0028/t, h2 −0.0154/t) while old-tenure leads are positive (h2 +0.0397/t,
  drop3/t +0.0276). Time-since-hot does not decay the edge — if anything, freshly-hot leads are
  noise that hasn't proven out.
- **P1 (Nth-copy dimension): PASS both halves.** Low-N copies (≤5th copy of a lead) beat high-N
  (>12th) by **+0.0219/t (h1) and +0.0577/t (h2)**, with the low-N cohort's drop3/t positive in both
  halves (+0.0238 / +0.0221). The >12th-copy tail in h2 is the bleed: −0.0204/t, drop3/t −0.0345.
- **P2: PASS on both strategies.** The recorded degrading windows skew hard to high-N: strict's
  recent-window median is its **17th** copy of a lead vs 8th prior (×2.12); strict-hi 8th vs 4th
  (×2.00). The book's observed decay is substantially "re-copying the same leads deeper and deeper."
- **P3: PASS at the ≤12 cutoff (retains 67%), FAIL at ≤5 (37%, bar 40%).** At ≤12 the h2 read is
  +0.0178/t / drop3 +0.0091 vs always-on +0.0024/−0.0038 (h1 ≈ flat vs always-on — the whole
  improvement comes from dropping the recent-era high-N bleed). Per-strategy: strict kept 64%
  (+0.0225/+0.0105) vs dropped (−0.0035/−0.0159); strict-hi kept 85% (+0.0275/+0.0109) vs dropped
  23 trades carrying drop3/t −0.0584.
- **Decision rule fires (P1 ∧ P3):** RECOMMEND spawning ONE challenger — incumbent chassis + a new
  lifetime per-lead copy cap **`maxCopiesPerLead: 12`** (per-strategy, all-time; distinct from C5's
  2-per-hour RATE cap, whose in-flight test is unaffected). Per the pre-registration it files
  behind the queued `hotlead-fresh` unless the operator re-prioritizes. The ≤5 form is
  higher-edge but pre-registered as over-filtering; do not fit intermediate cutoffs post-hoc.
- Fairness note: the h2-concentration of the effect is NOT a 6%-recost artifact — kept-vs-dropped
  within h2 share the same cost-era mix.

**B1 — REFUTED on all three predictions; the honest negative.** No K ∈ {20,30,50} beats always-on
on both axes in both halves for either strategy (P1 FAIL). The gated-OUT cohorts are frequently
**positive** — on strict h2 the gate would have stood down INTO +0.0177/t trades while keeping
−0.0230/t ones (P2 FAIL: the rule skips recoveries, not losses). Edge-state persistence does not
exist: P(next-10 net ≤0 | trailing-K ≤0) − unconditional ranges **−20pp to +5pp**, never ≥+10pp
(P3 FAIL). Own-PnL trend-following on this book is noise-chasing, exactly the pre-registered null —
same family verdict as every killed timing gate. **Do not promote `recencyProfile` to a hard gate;
do not relitigate without a genuinely different regime signal.** Joint read with A1: coherent —
there is no exploitable time-domain regime (B1, tenure inversion), while the count-domain decay
(A1) is real; the edge doesn't fade with the clock, it fades with our repeated exploitation of the
same lead.

**Addendum (same day, operator-directed — "spin up that new one as recommended"): spawned
`copy-fable-leadcap`** — incumbent chassis (strict-hi, {10,3,1.0}, TP100/SL30, lag5+drift10) + ONE
new gate `maxLeadCopiesLifetime {maxCopies: 12, counter: copy-hotlead-strict-hi}` (new config +
`lead_exhausted` skip reason + `leadCopyCountLifetime` counter, closed-rows-only). Design decision
validated with one extra offline check before implementing: a baseline-series count construction
**failed split-half** (h1 sign-flipped; corr(own-N, baseline-N) = 0.39), so the deployed cap counts
on the **incumbent's per-strategy series** — the exact construction and rows the study validated —
rather than its own fresh series (which would start every lead at N=0 and never bind) or the
baseline. Pre-registered P1/P2/P3 restated verbatim in the code comment (P2 baselines: strict-hi
n=155, net/t +0.02714, drop3/t +0.01295; P3 expects ~85% of incumbent fire rate and requires the
lever-fire count reported at n≥100 — the C4 test-power lesson). Spawned over MAX_INFLIGHT by
operator direction (C4/C5 precedent); queued `hotlead-fresh` keeps its claim on the next natural
slot. **Also enacted M1's first half: `ARENA_BENCHMARK` repointed `copy-hotlead-strict` (pruned
ghost) → `copy-hotlead-strict-hi`** — required for this and every challenger's arena verdict to
resolve at all (bench lookup returned undefined since the 07-12 prune). M1's second half
(post-recost per-trade fields) remains open. Verified: build green (pre-existing tsconfig
deprecation only); 14-check harness against the compiled dist (roster shape carries exactly the
one new lever on the incumbent chassis; counter SQL boundary/exclusion/all-time semantics; gate
wiring + skip reason + config publication + benchmark repoint).

Phase-0.5 bookkeeping: A1 and B1 pre-registrations are both CLOSED (no dangling debt); the C1/D2
trigger (D1 day-7, ~07-19) and M1's post-recost fields remain open from the 07-13 handoff.

---

## 2026-07-12 — Enacted the 2026-07-12 phase-1 handoff: D1 `copy-watchlist-unlock` (config) + D3 `live-cost-recon` (ops-DB study, funding BLOCKED)

Operator directed "move on these two" from the 07-12 phase-1 handoff
(`docs/phase1-handoff-2026-07-12.md`). Neither is a new trading signal — the overlay lane is nine
challengers deep (C4/C5 from 07-11 included), the wallet-source frontier is a graveyard, so the two
promotes attack the program's actual binding constraints: **event supply** (D1) and **scoreboard
truth** (D3).

**D1 — `copy-watchlist-unlock` (lever 1, subscription layer): `COPY_WATCHLIST_MAX` 80 → 150.**
One-line default change in `follower-probe.ts`. At cap 80 (70 OG slots after the 10-slot source
reserve) only ~47% of the ~150-wallet follow_list is subscribed and the entire ~178-wallet smart set
is dropped by the tier-priority truncation — the sole proven edge is starved at the subscription
layer (same "unsubscribed wallets fire zero events" mechanism as the U5 bug). The settled `rpc_usage`
panel measures `copy_follower_ws` at ~4.2k credits/day @ 80 (~53/wallet/day) vs a ~47k/day total and
the ≤100k cap, so 80→150 completes follow_list coverage for ~+3.7k credits/day (≈51k total, ~51% of
cap). Source reserve unchanged (10). Pre-registered 7-day observables (verbatim in the code comment
so the test can't be re-scoped): leads 173→**≥200**, hot **≥65**, incumbent fires **≥7/day**,
incumbent net/trade stays **>0**; REVERT (env, instant) if console spend → >85k/day. **P2's failure
mode also refutes D2 (trial-rotation) by proxy** — if leads stay ≤185, subscription was not the
binding constraint. NOTE: code default — a Railway `COPY_WATCHLIST_MAX` env override would mask it.
Build green (only the pre-existing tsconfig deprecation); PR #556.

**D3 — `live-cost-recon` (execution/measurement integrity): live-micro funding BLOCKED.** Read-only
ops-DB study (`docs/live-cost-recon-2026-07-12.md`), zero RPC, no slot. Findings: (1) **no
modern-era live sample** — every live copy trade is June 18–29, executor paused since (the
`hold30m-live-micro` "active:true" is a stale flag, its −0.75 SOL is a June total, not an ongoing
bleed — corrects the 07-11 journal alarm); (2) `consensus2-live-micro` is 79% `live_error`
(rent-bug era, excluded); (3) the clean 324-pair `hold30m` join shows **~3.1pp entry slippage**, so
the flat 3% round-trip assumption is ~half the real cost. **Pre-registered verdicts: P1 FAIL** (3.1pp
> 2pp bar → funding killed pending fix/recalibration); **P2 split — `copy-hotlead-strict` FAILS
re-costing (drop3 → −5.9, monthly → ~1.3), `copy-hotlead-strict-hi` SURVIVES (drop3 → +2.3), which
INVERTS the daily journal's ranking** (the thin-per-trade strict is the fragile one under real cost;
the higher-conviction strict-hi is the robust one); **P3 NO** (zero current-era pairs). Recommendation:
do not fund on this stale evidence; if live is wanted, a bounded calibration burst (≤0.3 SOL behind
the breaker) on the current executor first; prefer strict-hi over strict; formally clear the stale
`hold30m-live-micro` flag; consider re-calibrating `SIM_DEFAULT_COST_PCT` 3.0 → ~6 from a modern
burst (separate reviewed follow-up, not changed here). Also corrects the handoff's ~4.4s land-time
figure (that was the retired v25 `trades_v2` executor; the copy executor landed ~1.9s in June).

**Roster unchanged by this cycle** — D1 is a supply config, D3 is advisory (enacts no code). The
nine in-flight challengers, the two live probes (external/gradspec), and the queued `hotlead-fresh`
are untouched; D1 accelerates all of their clocks. Decision notes carried for the operator: gradspec
day-7 (07-13) → shelve-as-untestable (frozen pre-filter, not a refutation); `hotlead-early` (n=46,
drop3/t −0.090) is the nearest natural KILL.

**Addendum (same day, operator-directed) — enacted two D3 recommendations:**

1. **Cleared the stale `copy-hotlead-hold30m-live-micro` "active" flag** (`live-training-data.ts`):
   removed it from `LIVE_SHADOW_MAP` + `LIVE_ORIGINAL_MAP` → drops to retired/off (matching the
   06-23 `deep-live-micro` precedent). Its base + pair-shadow were killed 07-05/07-03 and live
   trading paused 06-29, but the kill was never propagated to that file, so its active-gate kept
   reading `active: true` on trade history alone. **Operator confirms zero copy live-micro strategies
   are running** — the correct active set is empty. Convention hardened in the code comment: killing
   a copy live strategy MUST remove it from those maps (the only active-gate).

2. **Re-costed `SIM_DEFAULT_COST_PCT` 3.0 → 6.0** (`sim-constants.ts`) from the D3 measurement (~3.1pp
   entry slip alone → 3% under-priced the round trip by ~half; ~6% = entry + estimated exit). Operator
   rationale: going live is gated entirely on shadow performance, so the shadow must price execution
   honestly or a "promising" shadow could be a live loser. **Blast radius (flag for the next daily/lab
   read so the drop isn't misread as edge decay):** the constant feeds BOTH the copy shadow sim
   (`copy-trader.ts`) and wallet scoring (`wallet-pnl.ts`). Wallet scoring **reprices immediately**
   (recomputed each cycle → the `wallet_discovery.promotable` count, now 10, likely drops; the gate
   tightens). The copy strategy scoreboard transitions **gradually** — `net_sol` is stored per-row at
   close, so existing rows keep their 3%-era net and only new closes use 6%; cumulative net/drop3 drift
   down over each strategy's trade-turnover window while `recent_net_per_trade` reflects 6% fast. Under
   this cost, per D3's re-costing, `copy-hotlead-strict` likely slips below the drop3/monthly bar while
   `copy-hotlead-strict-hi` holds — expect the promotion picture to tighten over the next 1–2 weeks.
   Stale June sample; recalibrate from a modern burst if one ever runs. Both changes: build green
   (only the pre-existing tsconfig deprecation).

---

## 2026-07-11 — Spawned from the 2026-07-11 phase-1 idea-model handoff: NODUMP (C4) + BREADTH (C5), two drop3-robustness overlays (operator-directed; MAX_INFLIGHT override)

Implements both promoted theses from the phase-1 handoff (`docs/phase1-handoff-2026-07-11.md`). The
handoff's framing: the board was at the `MAX_INFLIGHT=4` cap and both promotables
(`copy-hotlead-strict`/`-hi`) are `degrading` with `n_promotable_stable=0`, so **drop3-robustness,
not net, is the binding gate**; and the wallet-source frontier is an empirical graveyard
(cotrade/live_tape/winner_sniper all pruned — own-skill ≠ copyable, r≈0). With the uncorrelated
frontier dead, both promotes are **robustness overlays on the sole surviving edge** (the incumbent
hot-lead entry), each attacking drop3 via new at-entry information. **Operator explicitly overrode
MAX_INFLIGHT** to spawn both now rather than wait for a slot to free (precedent: the 2026-06-19 c2rr
exit-sweep cohort ran 10-at-once as an operator-directed exception). All predictions were
pre-registered on 2026-07-11 BEFORE any data and are restated verbatim in the `COPY_STRATEGIES` code
comments so the test can't be re-scoped. Incumbent baselines (2026-07-11 scoreboard): strict n=820,
net/trade **+0.01439**, drop3/trade **+0.00636**.

**C4 — `copy-hotlead-nodump`, lever 2 (entry gating): SMART-DISTRIBUTION VETO.** Incumbent chassis +
ONE new gate `smartFlowVeto {windowSec: 90}` — at the copy moment, skip the entry if the watched
smart crowd is net-SELLING this mint (distinct smart sellers > distinct smart buyers over 90s, from
`copy_probe_events`, tier ∈ {promotable,smart}). Even a hot lead's buy is a trap if the rest of the
smart money is simultaneously distributing (we'd be their exit liquidity) — the SL-tail signature.
The novel information is the SELL leg: `crowdSellExit` uses it only to EXIT; nothing prices "is the
crowd dumping as I buy?" into the ENTRY today. Distinct from `minConsensusRecent` (a buy-side count
floor that FAILED drop3) — this keys on the buy/sell IMBALANCE. Zero RPC (cached counts). The higher-
conviction of the two. Pre-registered: **P1** KILL if drop3/trade ≤ 0 at n≥100; **P2** beats the
incumbent on drop3/trade (> +0.00636) with net/trade ≥ −10% of incumbent (≥ +0.01295), else KILL;
**P3** ≥3 fires/day by day 5, shelve if it can't reach n≥100 in ~4 weeks. Promote only if P1 ∧ P2.

**C5 — `copy-hotlead-breadth`, lever 2 (entry gating / portfolio breadth): PER-LEAD COPY CAP.**
Incumbent chassis + ONE new gate `maxLeadCopiesPerWindow {maxCopies: 2, windowSec: 3600}` — cap how
many times the book copies the SAME lead within an hour, forcing exposure across more DISTINCT leads.
The incumbent's leads are a tight co-buy cluster (`smart-money → consensus` top pairs co-occur
25-31×), so profit concentrates in few underlying bets → drop3 is fragile by construction; spreading
the same n across more leads mechanically lifts drop3/trade. Generalizes the PROVEN
`maxEntriesPerMint` (1st/2nd entries profit, 3rd+ bleed) from the mint level to the lead level;
`leadExclusionGate` only prunes LOSER leads, so nothing today broadens the WINNER distribution. Zero
RPC (own-series SQL). Lower-conviction: the 2026-07-03 backtest found "drop1-per-lead hurts −4.2;
moonshot leads ARE the edge," so a lead cap risks cutting the concentrated winners — declared as
**P0** (the cap targets the marginal Nth repeat, not each lead's best trade). Pre-registered: **P1**
drop3/trade > +0.00636 AND net/trade ≥ 0 at n≥100, else KILL; **P2** KILL if net/trade < +0.010
without drop3/trade clearing +0.010 (traded moonshots for no robustness); **P3** ≥3 fires/day by day
5. Promote only if P1 holds AND P2 does not trigger.

Both are realistic at `entryDelaySec: 5` → each IS its own `-lag` twin (no separate twin row, as with
`hotlead-early`/`freshdip`). Fresh ids (never reused). Resolve vs `copy-hotlead-strict` at n≥100 per
arena rules (PRUNE if beaten on net/trade AND drop3/trade). Roster note: this pushes the in-flight
challenger count above the cap by operator direction; converge back under MAX_INFLIGHT as
`hotlead-early` (n=46, drop3 −4.16, worsening) and `freshdip` (n=42, drop3 −3.02) resolve.

**Verified:** code type-checks clean (the only `npm run build` error is a pre-existing tsconfig
`ignoreDeprecations` deprecation on `main`, unrelated to this change — `dist` emits both strategies +
both gates + the helper). Offline harness against the compiled dist + verbatim SQL: 12/12 on the new
signal semantics — `smartFlowVeto` distinct buyer/seller dedup, `src_*`-tier quarantine, the 90s
window boundary, the strict `sellers > buyers` imbalance (tie is NOT a veto), and
`leadCopyCountRecent` open+closed counting with old/skipped/other-strategy exclusion + the 3600s
boundary — plus a brace-matched dist scan confirming each strategy object carries exactly its one new
lever on the incumbent chassis.

---

## 2026-07-10 — Ledger enactment (U13 prune) + FD3 cohort: 3 new strategies from fresh backtests (operator-directed)

Operator directed: act on the phase-3 monitor ledger + spawn three new strategies. Grounded in two
new ops-DB backtests over `copy-hotlead-strict`'s 814 closed rows before writing any strategy code.

**U13 ENACTED — `winner_sniper` discovery source PRUNED (FAILS at n=148).** Once the 07-08
watchlist-reserve fix let its wallets actually subscribe, the probe `copy-src-winner-sniper-v2`
collected fast and resolved decisively: n=148, net −7.17, **−0.048/trade vs the OG control's
−0.032/trade** — worse than copying unselected OG wallets. Two rounds of profit-proofing (winner-
window hit + forward pre-filter) still don't produce copyable leads — consistent with the 06-29
audit (own-PnL ⊄ copy profit). Registry row removed; harvester + pre-filter were already
default-OFF from the 07-09 credit retune. Both winner-sniper probeIds are burned. NOTE: `gradspec`
shares the (default-off) pre-filter, so its funnel is FROZEN until `PREFILTER_DISABLED=false` —
its probe (n=4, +0.25/t) trades only from already-passed wallets. U14 also resolved: the
watchlist at 40 is the intentional 07-09 ≤100k-credit/day posture, not a failure.

**Backtest 1 — cold-streak veto REFUTED, inverted (the honest negative result):** hypothesis was
"skip hot leads mid losing-streak" (downside persistence). The data says the opposite *within
already-hot leads*: ≥2 losses in the lead's last 3 baseline copies → **+0.034/trade (n=423, wr
.33)**; clean recent run (0–1 losses) → **−0.007/trade (n=391, wr .29)**; 3-loss streaks were the
best of all (+0.043/t, n=79). Recent losses on a hot lead mean-REVERT — the wallet-level analog of
the dip fill (buy quality on pullback, never on the visible win-run that attracts crowding).

**Backtest 2 — LP-depth gate not backtestable:** `pumpswap_initial_lp_sol` is NULL on 789/814
rows (enrichment barely ran). Pivoted to data-collection-first (below).

**Spawned (operator-directed 3-strategy cohort — treat as ONE experiment for MAX_INFLIGHT, like
c2rr; challengers in flight: freshdip, freshdip-bounded, hotlead-early + these 3):**
- **`copy-fable-dip`** — incumbent + bounded dip band (0 ≥ drift ≥ −20%), NO age gate. The
  strongest cut of the 07-03 OOS backtest (dip-only: h1 +17.4/xt3 +10.8, h2 +6.5/+3.4, n=336) was
  never deployed — we shipped dip+age (freshdip) instead. Completes the attribution matrix:
  strict / dip / freshdip / freshdip-bounded.
- **`copy-fable-leadpullback`** — incumbent + `leadPullbackGate {lastM:3, minLosses:2}` (new gate
  + `no_pullback` skip reason): enter only a hot lead's drawdown. Backtested same-day (above).
- **`copy-fable-deep`** — incumbent + `minPoolSol: 30` (new gate + `shallow_pool` skip reason):
  skip pools that bled below 30 SOL (fresh PumpSwap pools open ~85). Threshold is a POSTED PRIOR,
  not a fit — the real payoff is the new data collection: **every entry on every strategy now
  records `pool_quote_sol`** (new column) from the same vault read that prices the fill (zero
  RPC), making pool-depth vs outcome backtestable within days.

All three: resolve vs `copy-hotlead-strict` at n≥100 per arena rules (PRUNE if beaten on net/trade
AND drop3/trade). Fire-rate caveat: the 07-09 watchlist cut (140→40 wallets) lowers everyone's
event volume — n≥100 timelines stretch accordingly; judge fire rates against the post-retune
baseline, not the old one. Verified: build green; 31-check offline harness (prune, roster shapes,
pullback SQL + gate arithmetic incl. thin-history, pool gate boundary, pool_quote_sol migration +
insertOpen recording, config publication, arena auto-registration).

---

## 2026-07-09 — Degradation / strength-over-time check (operator-directed)

Operator observation: the promotable strategies have been declining loop-over-loop — still clearing
the bar, but if the edge can't hold, they'll fail. The promotion bar is a **cumulative snapshot**
(n / drop3 / stress / monthly over all-time) and is structurally blind to decay: a strategy whose
early trades were great and recent trades are dying still reads promotable because the lifetime
average is propped up by the old winners. This is the front-loaded-edge failure mode the audit and
this ledger already flag ("the hotlead edge is front-loaded and regime-sensitive").

**Added an advisory recency/trend check** (`recencyProfile` in `copy-trader.ts`, published on every
`by_strategy.<id>.recency` + surfaced on `promotion.rows`): split each strategy's time-ordered closed
trades into a RECENT window (last ~⅓ of history, floored at 30, capped at 150 so a big strategy's
recent decay isn't diluted by its whole front-loaded history) vs the PRIOR trades, and compare
per-trade net + win-rate. `trend` ∈ {degrading, stable, improving, insufficient}. Because per-trade
mean is fat-tail-noisy (one moonshot swings it), DEGRADING requires a net/trade drop **corroborated**
by a win-rate drop OR the recent window going net-non-positive — so a lower recent mean from "no
moonshot lately" (win-rate steady) reads STABLE, not DEGRADING. New promotion fields: per-row `trend`
/ `recent_net_per_trade` / `degrading`, and top-level `degrading` (list) + `n_promotable_stable`
(clears the bar AND not decaying = the genuinely fund-able set).

**Advisory, NOT a gate** — `promotable` and `score` are unchanged (that bar is operator-defined; a
unilateral demotion would redefine what the arena calls a LIVE_CANDIDATE). This gives the check
visibility everywhere without changing the semantics. **If you want it to have teeth** (flip
`degrading` → hard demotion, or make `promotable_stable` the arena's live-micro candidate), that's a
one-line follow-up — say the word. Env-tunable: `COPY_TREND_MIN_WINDOW` (30), `COPY_TREND_MAX_RECENT`
(150), `COPY_TREND_ABS_MARGIN` (0.008), `COPY_TREND_REL_MARGIN` (0.35), `COPY_TREND_WR_MARGIN` (0.05).

**Live validation (ops DB, 2026-07-09) — the check fires on exactly what prompted it:**
| strategy | prior net/trade (n) | recent net/trade (n) | prior WR → recent WR | trend |
|---|---|---|---|---|
| `copy-hotlead-strict` | +0.0187 (655) | **−0.0015 (150)** | 0.313 → 0.307 | **degrading** (recent went net-≤0; edge vanished) |
| `copy-hotlead-strict-hi` | +0.0833 (84) | **−0.0569 (42)** | 0.405 → 0.238 | **degrading** (both signals; severe) |
| `copy-fable-freshdip` | −0.10 (8) | −0.01 (30) | — | insufficient (prior < 30) |
| `copy-hotlead-early` | +0.22 (5) | −0.05 (30) | — | insufficient (prior < 30) |

Both promotable incumbents are decaying → `n_promotable_stable` = **0** right now. That is the exact
"do not fund the live-micro test yet" signal the cumulative bar was hiding. Verified: build green;
17-check offline harness against the compiled dist (degrading / stable / improving / insufficient
cases, gate left unchanged, top-level aggregates) + this live ops-DB cross-check.

---

## 2026-07-08 — U5 fix: watchlist-cap regression zeroed every discovery-source probe; U7: bounded-dip challenger spawned

Directed from the `/solana_loop_checker_phase3` monitor loop's ledger (operator: "look into U5 and U7... resolve on Opus"). Both are code fixes/spawns, not proposals — enacted directly.

**U5 — `copy-src-winner-sniper-v2` / `copy-src-gradspec` stuck at n=0 despite 18 / 4 tradable wallets (BUG, FIXED):**
Root-caused via live-data diagnosis (an independent parallel investigation corroborated the same finding, including a direct log citation): `follower-probe.ts`'s watchlist builder unions four tiers by priority (follow_list → smart set → copy-net → discovery-source) and truncates the LOW-priority tail to fit `COPY_WATCHLIST_MAX` (140). `follow_list` alone has grown to **150 addresses — already over the cap on its own** — so `ordered.slice(0, 140)` kept only follow_list, dropping smart-set, copy-net, and **100% of every discovery-source wallet**, confirmed live: `logs.json` → `"Watchlist updated: 140 wallets (150 promotable, 178 smart-set, 10 copy-net, **0 discovery-source**; 165 dropped)"`. Since unsubscribed wallets fire zero lead events, `onLeadBuy` was never invoked for them — not even a `status='skipped'` row, matching the observed "n=0, no attempts at all."

**This is a same-day regression from 2026-07-04**: commit `2c43bf4` fixed an identical n=0 incident by subscribing discovery-source wallets (documented in `docs/discovery-playbook.md`); hours later `bec9b79` added `WATCHLIST_MAX=140` with discovery-source as the lowest-priority tier to cap Helius WS billing — reasonable when the higher tiers totaled ~150, but follow_list/smart-set have since organically grown to 150/178, so the "trim the tail" logic now trims the *entire* tail every time, not just the excess.

**Fix** (`follower-probe.ts`): new `WATCHLIST_SOURCE_RESERVE` (env `COPY_WATCHLIST_SOURCE_RESERVE`, default 40) reserves a slice of the SAME `WATCHLIST_MAX` budget for the discovery-source tier — not a size increase, a re-allocation within the existing WS-billing envelope, bounded in practice by `SOURCE_WATCH_CAP × |DISCOVERY_SOURCES|` (currently ≤75). Verified offline against the compiled dist: with the fix, 10 synthetic source-only wallets survive the cap alongside 150 synthetic follow_list rows; setting the reserve to 0 exactly reproduces the live bug (source tier → 0), proving the reserve is what matters. Noted but not chased: a possible secondary factor (`resolvePool` only resolves mints in the local `graduations` table, vs Stage-2's broader `venue==='pumpswap'` acceptance) — low-confidence, flagged as a post-fix watch item if `n` stays anomalously low once the cap fix lands.

**U7 — `copy-fable-freshdip`'s live n=35 read came in negative; bounded-dip challenger spawned:**
freshdip's own closed rows (n=35, 2026-07-08) bucketed by `entry_drift_pct` (ops DB) show the "just take any dip" design (drift ≤ 0, unbounded on the downside) is too permissive: **drift < −20% (n=5) had a 0% win rate and average MFE of only 2.8%** — these positions never even bounced before stopping out, a falling-knife signature — while every shallower band (−20%..0%, n=30) summed **net +0.68 SOL**. Excluding just the deep tail flips freshdip's own aggregate from net −0.41 to net +0.68 on the same underlying trades.

New `minEntryDriftPct` config (paired with the existing `maxEntryDriftPct` ceiling) and a sibling strategy **`copy-fable-freshdip-bounded`** (`minEntryDriftPct: -20`, otherwise identical to freshdip). freshdip itself keeps running unchanged (n<100, not yet resolved) — this is a sibling, not a replacement. Roster now 3 challengers (`copy-hotlead-early`, `copy-fable-freshdip`, `copy-fable-freshdip-bounded`), under MAX_INFLIGHT=4. Caveat: n=35 is small and the exact −20% boundary sits at the sharpest break in a thin sample — revisit once this challenger matures. Resolve vs `copy-hotlead-strict` at n≥100 (arena rules); secondary read against plain freshdip once both have comparable n.

**Verified:** build green; two offline harnesses against the compiled dist + a real schema DB (19 checks for the bounded-dip gate/strategy/config-publication; 6 checks for the watchlist-reserve fix including a before/after bug-reproduction test).

---

## 2026-07-06 — Spawned from the 2026-07-05 phase-1 idea-model handoff: GRADSPEC (discovery source) + HOTLEAD-EARLY (challenger); HOTLEAD-FRESH stays queued

Implements the two "spawn now" ideas from the pre-registered phase-1 handoff (grounded in the
07-05 scoreboard: incumbent `copy-hotlead-strict` n=706, net/trade +0.01525, drop3/trade +0.00592;
OG control `copy-tp100-sl30-lag` n=709, −0.0299 / −0.0368). All predictions were pre-registered
on 2026-07-05, BEFORE any data — they are restated verbatim in the code comments so the test
can't be re-scoped.

**GRADSPEC — new discovery source (`copy-src-gradspec`), lever 1 (wallet source).** Reseed the
winner-sniper forward pre-filter from the *post-grad-AMM specialist* archetype: wallets with high
`grad_buys`, low `pre_pct` (≤0.10), active ≤14d (the `smart-money → timing` panel isolates them —
grad_buys 674–784, pre_pct 0.01–0.04, absent from the OG 0-30s seed). This is the principled fix
to the winner-sniper `NO_WALLETS` starve: its 0-30s winner-credit seed reaches ~3 wallets; the
archetype seeds *for* wallets that trade the fast copyable window. Only the seeding heuristic is
new code (`gradspec-harvester.ts`, pure SQL on the worker tick, zero RPC); everything downstream
is reused — `winner_prefilter` forward gate (new `origin` column attributes enrollments;
`GRADSPEC_MAX_WATCHING`=75 sub-cap of the shared 200 slots) → FIFO scorer → origin-scoped relaxed
gate → the auto-emitted standardized probe vs the OG control. Cross-token-skill driver, LOW
correlation to the hot-lead book.
Pre-registered: **P1** smart_copyable ≥ 10 within 5 days (FAIL/SHELVE if < 3 by day 7 — the
reachability wall is structural); **P2** at n≥100 beats OG on BOTH net/trade AND drop3/trade with
drop3/trade > 0 absolute → `BEATS_OG`, else KILL to the source graveyard; **P3** n≥100 within
~3 weeks, else shelve (the `live_tape`/`external` failure mode). Promote to a hot-lead-gated
variant only if P2 holds.

**HOTLEAD-EARLY — `copy-hotlead-early`, lever 2 (entry gating).** The incumbent chassis + ONE
lever: `maxConsensusRecent: 2` — copy a hot lead only when it's among the first ≤2 smart buyers
on the mint. Measured driver (`smart-money → outcome_lift`): avg return by prior smart-buyer
count 1 → +4.6%, 2 → +6.02% (peak), 3+ → +0.97% (the crowding cliff). First-mover is a different
return family from lead-recency; zero marginal RPC (cached count, shares the incumbent's polls).
Not answered by the graveyard: `copy-hotlead-consensus` tested a consensus *floor* (the opposite)
and `hold30m-early` bolted earliness onto the killed 30m-hold lottery — neither tested a
*maximum*-consensus gate on the robust TP100/SL30 hot-lead chassis.
Pre-registered: **P1** KILL if drop3/trade ≤ 0 at n≥100; **P2** KILL if it doesn't beat the
incumbent on BOTH net/trade (> +0.01525) AND drop3/trade (> +0.00592) at n≥100; **P3** needs
~5 fires/day and n≥100 in ~3 weeks, else shelve or relax to `maxConsensusRecent: 3` (the
pre-declared fallback — P3 is the main risk on an already-selective gate).

**QUEUED, not spawned: HOTLEAD-FRESH** (`copy-hotlead-strict` + `maxTokenAgeSec: 900`, NO dip
gate — isolates freshness from `copy-fable-freshdip`'s dip confound). Hold trigger: spawn the
moment `copy-fable-freshdip` resolves (n≥100 or killed). Held to respect MAX_INFLIGHT=4 and
"converge, don't sprawl": challengers in flight after this entry = `copy-hotlead-strict-hi`,
`copy-fable-freshdip`, `copy-hotlead-early` (+ the gradspec probe on the discovery track),
leaving the queued net-floor-1.5 step room if `strict-hi` confirms.

---

## 2026-07-04 — Roster prune: 2 strategy kills + 1 discovery-source prune (operator-approved from the phase-3 monitor loop)

Enacted from the `/solana_loop_checker_phase3` advisory loop's Updates & Ideas ledger; the operator
approved U1 / U4 / U6 and directed the code edit (Opus session). All three are removals — closed rows
stay in the DB → `retired_summary`; none of these ids may be revived (they'd inherit stale rows).

**Killed (`COPY_STRATEGIES`, `copy-trader.ts`):**
- **`copy-hotlead-hold30m`** (U1, INVALID — lottery). n=1139, net **+24.2** (the biggest raw net in the
  book) but drop3 **−6.9** and worsening on every loop across 07-03→07-04 (−1.3 → −2.3 → −3.3 → −5.0 →
  −5.9 → −6.2 → −6.9). Net-positive / drop3-negative = textbook lottery (top-3 wallets ≈ 32% of net).
  The I3 thesis — that hot-lead selection would concentrate the 30m-hold winners into positive drop3 —
  is refuted: the recency gate did not fix the fat tail. The hot-lead entry survives on the robust
  TP100/SL30 chassis via `copy-hotlead-strict` (promotable) + `copy-fable-freshdip`.
- **`copy-hotlead-strict-xbad`** (U4, INVALID — veto refuted forward). The proven-bad exclusion (skip
  leads whose all-time baseline copy net is negative) was the surviving half of the copy-net signal
  after V2 positive-selection was refuted OOS. Forward it added no robustness: by n=45, net-negative on
  BOTH axes (net/trade −0.025, drop3/trade −0.070) vs the strict base it layers on (+0.016 / +0.006) —
  strictly dominated, deteriorating every loop (drop3 −1.1 → −3.1). Same lesson as `copy-elitelead` and
  the V2 A/B: cumulative copy-net neither selects nor vetoes forward copy profit. **Only the recency
  hot-lead gate ({10,3,0.5}) holds** — this closes the copy-net lead-screen line for good.

**Pruned (`DISCOVERY_SOURCES`, `discovery-sources.ts`):**
- **`live_tape`** (U6, FAILS). Probe `copy-src-live-tape` stalled at n=24 for 4+ loops (its wallets
  rarely trade our copyable graduation universe → can't reach n≥100) and was clearly below the OG
  control on the trades it did make (net/trade −0.047 vs −0.028; drop3/trade −0.055 vs −0.036). Registry
  row removed → probe + scorecard row + routing retire; harvester was already default-OFF
  (`LIVE_TAPE_ENABLED!=='true'`), so nothing was running to stop. Recorded in the discovery-playbook
  resolved table.

**Post-prune roster:** incumbent `copy-hotlead-strict`; challengers `copy-hotlead-strict-hi` (net-floor
1.0, leading), `copy-fable-freshdip` (fresh-dip, collecting); controls `copy-tp100-sl30(-lag)`; reference
`copy-conviction-consensus2`; discovery probes `copy-src-winner-sniper-v2` (3-stage funnel, collecting)
+ `copy-src-external`. Challenger count now 2 (well under MAX_INFLIGHT), leaving room to spawn the
net-floor-1.5 step **if** `strict-hi` confirms drop3 at n≥100 (ledger U3).

---

## 2026-07-04 (later) — Winner-sniper rebuilt as the operator's 3-stage funnel: profit-credit → forward pre-filter → scorer

Operator direction (same session as the audit below): the sniper pipeline should (1) only credit
window buyers who were **profitable on that token**, (2) hold them in a **pre-filter** — watched,
not traded, not yet scored — measuring whether they keep profiting on OTHER tokens across ALL of
PumpSwap, and (3) only pass-bar wallets reach the scorer, which decides tradability. Stated goal:
"I can't listen to every single swap" — each cheap stage buys admission to the next, expensive one.

**This supersedes the morning's tally-bar signalSet shortcut** (which would have let wallets with
one lucky profitable window straight into the probe). Shipped on the same branch/PR:

- **Stage 1 — profit-credit** (`winner-sniper.ts`): buyer capture upgraded from a name-set to
  per-wallet window FLOWS (0-30s `competition_signals` sizes with entry ≈ open, ∪ sampled
  pool-vault swaps now parsed properly via `parseSwapForOwner` — buys AND sells, SOL + token legs,
  this mint only). A `winner_hit` requires MTM profit at the final observed path price
  (> `WINNER_PROFIT_EPS_SOL`, default 0.01 SOL). Appearances still count every sampled buyer, so
  precision = profitable hits / appearances. Old un-profit-checked hits decay off in ~2 days
  (36h half-life) — no migration.
- **Stage 2 — forward pre-filter** (NEW `winner-prefilter.ts`): tally-bar wallets enroll into
  `winner_prefilter` (hard cap `PREFILTER_MAX_WALLETS`=200). A dedicated `transactionSubscribe`
  (accountInclude = watching set, zero RPC, billed WS msgs bounded by the cap; usage source
  `discovery_prefilter_ws`) tallies their per-mint flows on venue=`pumpswap` swaps only. PASS =
  ≥2 profitable CLOSED positions (tok_out ≥ 0.9×tok_in) on non-trigger mints AND closed net ≥
  +0.25 SOL within 120h; early-fail at −1.0 SOL; fails free their slots (14d retention). Flows
  only accumulate after enrollment → the test is out-of-sample by construction. Conservative
  accounting: open bags neither pass nor fail (no unrealized marks, no price RPC).
- **Stage 3 — scoring decides** : pre-filter PASS → `wallet_candidates(source='winner_sniper')`
  at top scoring priority (boost now keys on pre-filter passage, not the source tag — collision-
  proof) → FIFO scorer → tradable set = passed ∩ relaxed scored gate (drop3>0 + copyable-relaxed),
  capped, OG-universe-subtracted (`getPrefilterGatedWallets` in discovery-sources.ts). The morning's
  watchlist fix already subscribes whatever this set produces.

**Clean-start reset (operator 2026-07-04) — corrected after a live-dashboard check:** operator
flagged that stale collection shouldn't dilute the new measurement. My first read (from the
session-start `copy-trades.json`, 01:28 UTC) said the probe was n=0 — WRONG: by 13:51 UTC the live
dashboard showed **`copy-src-winner-sniper` at n=109, net −1.81, drop3 −3.49**. Cause: the morning
watchlist fix (commit 1) had already deployed, and its interim tally-bar `signalSet` exposed the
top-25 tally wallets (bought-a-winner, no profit check — the own-PnL-negative ones the audit
flagged), which then copied at a loss. So there IS stale probe data, from the wallet-selection the
3-stage funnel replaces, and it would dilute the funnel's series. Two-part clean start:
- **Probe id bumped** (`discovery-sources.ts` `probeId` override → `copy-src-winner-sniper-v2`).
  The old id leaves the roster; its 109 closed rows fall into `retired_summary`; the funnel reports
  fresh from n=0. The override changes ONLY the P&L series name — source tag (`winner_sniper`),
  quarantine routing (`leadSource`), and funnel counts are untouched. `live_tape`/`external` probe
  ids unchanged.
- **Tally reset** (`winner-sniper.ts`, one-time, version-guarded
  `winner_sniper_data_version = profit-credit-2026-07-04`): clears `winner_sniper_tally` once so
  pre-filter enrollment is driven purely by new profit-verified hits; keeps `winner_labels` (paths,
  for bar recalibration); lets in-flight `winner_obs` finalize under the new logic; never re-clears
  on redeploys.

(The stale `wallet_candidates(source='winner_sniper')` rows are left — the tradable gate requires a
pre-filter PASS, so they can't reach the probe; inert scoring-priority residual, not dilution. The
old id's few open shadow positions wind down via the poll loop's `strategy_removed` branch — shadow
closes, no real money.)

**Verification:** build green + two in-memory SQLite smoke tests — (1) the full chain (enroll state
machine incl. cap, closed-position accounting excl. trigger mints, pass → gated set, OG-quarantine
subtraction when a graduate also clears the global bar); (2) the reset is idempotent (clears stale
tally + sets the version on first start; a fresh row survives a second start, no re-clear; labels
preserved).

**Expected timeline:** `copy-src-winner-sniper-v2` sits at n=0 (NO_WALLETS) for a few days by
design — a wallet now needs a profitable winner-window, then 2+ profitable closed trades under
forward watch, then a score. `copy-trades.json → winner_sniper.prefilter` shows the new funnel live
(watching / passed / failed_ttl / failed_loss + per-wallet progress). If `watching` stays ~0 for
>48h, stage 1 is over-tight (raise `WINNER_SNIPER_MIN_HITS`→1 or lower `WINNER_PROFIT_EPS_SOL`); if
wallets watch but never pass, loosen `PREFILTER_MIN_OTHER_WINS`/`PREFILTER_MIN_NET_SOL` before
concluding the thesis fails. The retired `copy-src-winner-sniper` (n=109, −1.81) is the honest
record of the interim tally-bar selection — evidence that bought-a-winner ≠ profitable-to-copy,
which is exactly what the profit-credit + pre-filter funnel fixes.

---

## 2026-07-04 — Discovery-probe funnel audit: why every `copy-src-*` sat at n=0 (watchlist gap + off-thesis gate); fixes shipped

Operator asked why the discovery probes aren't collecting (`copy-src-live-tape`/`-external`
"funnels filling", `copy-src-winner-sniper` NO_WALLETS) and whether the filters are too strict.
Audit ran over `copy-trades.json`, `copy-probe.json`, `logs.json` and two `ops`-channel DB pulls.

**Diagnosis — a codebase gap, not filter strictness:**
1. **Watchlist gap (the blocker for ALL three probes).** The 07-03 relaxed source gate produced
   13 live_tape + 12 external smart+copyable wallets — routed by `sourceSets`, counted by the
   scorecard, but **never subscribed**: the follower-probe watchlist was still only
   follow_list ∪ global smart set ∪ copy-net. Proof: 0/25 source wallets on the watchlist (only
   J9xeW…, which independently clears the full global bar, could sneak in), 0/30 recent probe
   events from source wallets. Un-watched wallets fire no lead events → probes stuck at n=0 by
   construction. The relaxation silently broke the invariant "source-smart ⊆ watchlist" that held
   when source gates equaled the global gate.
2. **Winner-sniper: the own-PnL gate is off-thesis and kept the set structurally empty.** The
   harvester itself is healthy (73 grads labeled, 47 winners, 656 wallets tallied, promotions
   flowing). But ALL 9 FIFO-scored multi-hit snipers have own-PnL drop3 ≤ +0.05 — the 6/6-precision
   top sniper (NULLio…) sits at −5.4 SOL. The thesis is an ENTRY-timing signal and the probe exits
   on its own TP100/SL30; gating the lead set on the lead's own realized PnL (their exits included)
   tested a different hypothesis, and under it `smart_copyable` would stay ~0 indefinitely.
3. **Winner-sniper collision:** 14 of 21 multi-hit snipers were already `wallet_candidates` rows
   under `competition_signal` (the OG seed reads the same 0-30s pool), so `promote()`'s
   new-wallets-only insert could never tag them — the signal's strongest wallets were invisible
   to their own source. (The remaining 6/7 tagged candidates were simply <6h old, behind the 4h
   scoring tick — cadence, not a bug.)
4. **Live-tape harvester is OFF** (`LIVE_TAPE_ENABLED` unset since ~07-01; status row 3 days
   stale, cycles_run=0 in the current deploy). Its 1,518 candidates are historical. This is
   consistent with the 06-29 lesson (discovery out-ran scoring; 1,109 live_tape candidates still
   unscored at priority 1000) — recommend leaving it off until the backlog drains; the probe test
   runs fine on the 13 already-scored wallets, refilling as the backlog scores (~3% pass rate).

**Thesis audit (existing data):** the shared premise — good buyers carry token-selection signal —
holds at population level: smart-wallet presence lifts PUMP rate 35.6% → 46.8% (+11pp, p≈0,
`smart-money.json → outcome_lift`). The freshdip backtest (07-03, below) independently found the
edge concentrated in fresh tokens + disciplined entries, which is exactly the winner-sniper shape
(entry edge with runway). External keeps its honest "crowded/alpha-decayed" prior (several of its
12 are days-dormant — expect slow n). None of this proves any source BEATS_OG — that remains the
scorecard's question; the fixes below only make the test actually runnable.

**Shipped (this branch):**
- `follower-probe.ts` — watchlist now unions the discovery-source sets; source-only wallets are
  tier-tagged `src_<id>`; `watchlist_source_wallets` added to status. (~196 → ~240 subs, ≈+20%
  on `copy_follower_ws` ≈ +3k msgs/day — trivial vs the 653k/day estimate.)
- `copy-trader.ts` — consensus/crowd counts (`countRecentSmartBuyers/Sellers`) now filter
  `tier IN ('promotable','smart')`, so the wider watchlist cannot perturb consensus-gated series
  (`copy-conviction-consensus2`).
- `discovery-sources.ts` — optional per-source `signalSet` override: winner_sniper's smart set is
  now its own bar (hits ≥ 2, precision ≥ 0.25, decayed score ≥ 0.5, top-25 by decayed score),
  not own-PnL. Signal sets subtract the OG universe + earlier sources' sets (can't steal a wallet
  another book trades). Tag-gated sets (live_tape/external) unchanged, now capped best-first
  (`COPYSRC_WATCH_CAP`=25). Scorecard `smart_copyable` now reports the exact routed/watched sets.
- `winner-sniper.ts` — `getWinnerSniperSignalWallets()` + `WINNER_SNIPER_WATCH_CAP` (25) +
  `signal_set_size` in the summary panel.
- `discovery.ts` — scoring-priority boost keys on TALLY membership (hits ≥ 2), not
  `wc.source='winner_sniper'`, so collided snipers get FIFO-scored fast too (reporting only).
- `docs/discovery-playbook.md` — contract updated (watchlist bullet, signal-set override, caps,
  control-kill hazard note).

**Expected observables (~24-48h):** `copy-probe.json → status.watchlist_size` ≈ 240 with
`watchlist_source_wallets` ≈ 40; `discovery_scorecard → winner_sniper.funnel.smart_copyable` > 0
(NO_WALLETS clears); first `copy-src-*` closed trades. If probes STILL sit at n=0 with watched
wallets, next suspect is lead activity itself (dormant wallets), visible via `src_*`-tier probe
events.

**Watch-items:** (1) 47/73 labels are winners — a 64% base rate makes `minPrecision` 0.25
non-selective in this regime; tighten only once probe P&L exists (label bar is env-tunable, path
stored for recalibration). (2) `copy-tp100-sl30-lag` carries a KILL proposal in the daily journal
but is the scorecard's OG control — keep it (or swap the control) before enacting that kill.
(3) Re-enabling `LIVE_TAPE_ENABLED` is an operator env decision — defer until scoring backlog
drains.

---

## 2026-07-03 (later) — FD: `copy-fable-freshdip` spawned (own-thesis line; offline-backtested entry-context gates)

Operator directive: "treat this as your own build — any copy strategy you see fit." Rather than
perturb the incumbent's lead gate again, this line asks WHERE the incumbent's edge actually lives.
Method: offline replay of every closed copy row over the `ops` DB channel (5 aggregate queries),
conditioning recorded outcomes on entry context, with split-half (time) OOS checks and per-cell
drop-top3 (`xt3`) — the first strategy here designed from a backtest rather than deployed-and-waited.

**Findings (all on recorded rows, 0.5 SOL, net of 3% cost):**
1. **Replaying the hot gate on the idealized baseline is NOT drop3-positive** (hot05 replica:
   n=676, net −1.1, xt3 −5.8). The incumbent's realistic twin IS (+12.4/+5.9) → a large share of
   its robustness comes from the *execution layer* (5s delay + drift-skip: avg entry drift −2.2%),
   not lead selection alone. The don't-chase mechanics deserved direct study:
2. **Dip fills carry the edge on hot leads.** strict by measured `entry_drift_pct`: dips ≤0 earn
   +0.05..+0.10/trade; the 0..5% chase zone bleeds (−0.03..−0.04). On UNGATED leads (lag baseline)
   deep dips are falling knives (−0.12/trade) — the dip signal is conditional on lead quality.
3. **Token freshness concentrates it further.** strict on dip fills by age-since-graduation:
   <15m = the entire robust edge (h1 +13.2/xt3 +9.0; h2 +5.8/xt3 +2.7 — the only age bucket
   positive on both metrics in both halves); 15-60m mixed; 1-4h negative both halves.
4. **The exit chassis must stay TP100/SL30**: the same gates on the hold30m chassis die in half 2
   (whole family decayed — matches its KILL). In the fresh-dip subset the TP-hit rate roughly
   doubles (36/81 h1, 30/80 h2 hit +100% vs 27% book-wide), spread over 54 distinct leads.
5. Tested and NOT adopted: per-lead consistency screens (win-count floor, per-lead drop1) — the
   drop1 screen actively hurts (−4.2 on the replica; moonshot leads ARE the edge); extension<50%
   stacked on age+dip over-filters (n≈27/half, xt3 flips negative in h2).

**Spawned (one challenger, 3/4 slots now used):**
`copy-fable-freshdip` — incumbent entry+exit unchanged (hotLeadGate {10,3,0.5}, lag5, TP100/SL30)
with two zero-RPC context gates: `maxEntryDriftPct: 0` (enter only at-or-below the detection
snapshot after the 5s wait) and NEW config `maxTokenAgeSec: 900` (only tokens graduated <15min ago,
via cached `graduations` ts; new `token_age` skip reason). Subset economics: n=161/17.1d (~9-10
fires/day → n≈100 in ~11d), net +19.0, xt3 +11.7, both halves positive on both.
**Resolve at n≥100 vs `copy-hotlead-strict` per arena rules** (PRUNE if beaten on net/trade AND
drop3/trade); kill early if fire rate can't reach n=100 in ~2.5 weeks. Honest caveats: gates were
selected on the same 17-day window the incumbent survived (multiple-comparisons risk mitigated but
not eliminated by the half-splits); fresh-dip fills may be adversely selected in ways the shadow
model can't see (thin just-migrated pools) — the -lag execution model plus the arena comparison is
exactly the test for that.

---

## 2026-07-03 — Roster audit + iteration protocol (operator-directed)

Operator asked to audit everything running, prune losers, and formalize a "compare all
experiments → prune → iterate to a live-micro candidate" loop.

**Pruned (roster edit to `COPY_STRATEGIES`):**
- `copy-hotlead` (n=1102, net +3.6, drop3 −3.5, stress −7.9) — DOMINATED: `copy-hotlead-strict`
  (same signal, net floor ≥0.5 vs >0) beats it on every robustness axis and is the promotable one.
- `copy-hotlead-hold30m-pair-shadow` (n=501, net −0.5) — ORPHAN: a 0.05-SOL twin whose live_micro
  counterpart was killed long ago; no live comparison left to feed.
- Left as a judgment call for the operator: `copy-hotlead-hold30m` (n=1060, net **+28.4** but drop3
  −2.7 for weeks — highest net, never promotable, a lottery). Kept as the "what a lottery looks
  like" reference pending an explicit kill.

> RPC note: pruning hot-lead **variants** frees ~0 RPC — they share one deduped poll loop. The real
> sinks are `wallet_pnl` scoring (candidate volume) and the every-lead controls' distinct positions.
> Prune for CLARITY/discipline, not cost. (At audit time the bot ran ~19% of the RPC ceiling.)

**The iteration protocol (encoded as `experiment_arena` in copy-trades.json + a card on /copy-trades):**
Every active experiment is tagged with a ROLE and a VERDICT vs its benchmark, so the loop is self-serve:
- **incumbent** — the sole promotable; the bar everything is measured against (today: `copy-hotlead-strict`).
- **challenger** — a realistic, not-yet-promotable variant; judged PER-TRADE vs the incumbent on
  net/trade AND drop3/trade. `PRUNE` when matured (n≥100) and beaten on BOTH; `PROMOTE_REVIEW` when it
  beats the incumbent on both; else `WATCH`/`COLLECTING`.
- **discovery_probe** (`copy-src-*`) — defers to `discovery_scorecard` (probe vs the OG control
  `copy-tp100-sl30-lag`); `SOURCE_BEATS_OG` / `SOURCE_FAILS` / `NO_WALLETS` / `COLLECTING`.
- **control** / **reference** — load-bearing baselines and idealized upper-bounds; never pruned.
- `live_micro_candidate` = the current promotable leader. **Nothing goes live without operator sign-off.**

The loop each cycle: read `experiment_arena` → enact `prune_candidates` (code edit) → keep the
incumbent + spawn ONE new challenger perturbing its strongest lever (or a new discovery source) →
`PROMOTE_REVIEW` graduates a challenger to the incumbent → repeat until a challenger clears the full
promotion bar and the operator green-lights live-micro. Discovery sources sit outside the MAX_INFLIGHT=4
challenger cap (they're funnels, not variants).

Post-prune roster: incumbent `copy-hotlead-strict`; challengers `copy-hotlead-strict-hi`,
`copy-hotlead-strict-xbad`; discovery probes `copy-src-winner-sniper` / `-live-tape` / `-external`;
controls `copy-tp100-sl30`, `copy-tp100-sl30-lag`; reference `copy-conviction-consensus2`; (pending)
`copy-hotlead-hold30m`.

---

## 2026-07-02 — V2 positive selection REFUTED out-of-sample; pivot to proven-bad exclusion; discovery-source framework (operator-directed)

The 2026-07-01 methodology fixes paid off immediately: the walk-forward comparison **flipped the
V2 story on day one**. Branch `claude/copy-bot-strategy-review-96su67` (fresh from main).

**The refutation (why the select A/B died early):** in-sample, V2-selected leads showed +27.0 SOL
(vs V1 +10.3) — the old headline. Out-of-sample (gate on pre-cutoff copies, score on the 7d after):
**V2's unique picks LOST −2.43 SOL (4 leads) while the leads V2 rejects made +1.60 (34 leads)**.
Every gate_grid config was OOS-negative (−0.20…−0.55 net/lead; adding recency made it WORSE).
The live A/B's exclusive splits agreed (v2-excl −3.55/20 trades vs v1-excl −1.10/37). Three
independent lenses, one answer: cumulative copy-net POSITIVE selection is a mirage — the same
lesson as the killed `copy-elitelead`, now with the circularity mechanism identified.
**KILLED:** `copy-select-v1` (n=39), `copy-select-v2` (n=23, 0 wins), `copy-hotlead-strict-v2`
(n=3). The copy-v2 page marks the A/B `resolved_refuted` with the frozen final series.

**What survives — the pivot (cohort V):** persistence is one-sided. First-half LOSERS keep losing
(−17.8 SOL second-half) while winners barely persist (+2.5). Copy-net is a **veto, not a
selector** → spawned **`copy-hotlead-strict-xbad`**: identical to the incumbent
`copy-hotlead-strict`, but skips leads whose all-time baseline copy net is proven negative
(≥10 copies summing ≤0; `getCopyNetExcludedAddresses`, env `COPYXBAD_*`). Population-based, so the
screen is live from day one; subset of strict → ~zero marginal RPC. **Resolve vs strict at n≥100:
keep only if it beats strict on drop3 AND net/trade.**

**Also resolved:** cotrade discovery **FAILS** (n=108, net −4.5, drop3 −6.5 vs OG-smart control
−0.9/−3.0) — killed `copy-cotrade-tp100-sl30` + its control `copy-ogsmart-tp100-sl30`. And the
idealized source probes (`copy-livetape-tp100-sl30` n=0, `copy-external-tp100-sl30` n=1) were
superseded (below).

**Discovery-source framework (operator request — "make it easy to iterate discovery theses"):**
new `src/copytrade/discovery-sources.ts`. A discovery thesis is now **one registry row + a
harvester** that tags `wallet_candidates.source`; everything else derives: the quarantined smart
set (generic SQL), a standardized REALISTIC probe (`copy-src-<id>`, lag5+drift10 TP100/SL30, no
lead gate — auto-emitted into `COPY_STRATEGIES`), and a `discovery_scorecard` row in
copy-trades.json (funnel + P&L vs the shared OG control `copy-tp100-sl30-lag` + auto-verdict at
n≥100: must beat control on net/trade AND drop3/trade). Playbook: `docs/discovery-playbook.md`.
Live-tape + external migrated to registry probes (`copy-src-live-tape`, `copy-src-external`).

**In-flight after this change (4 slots, at cap):** `copy-hotlead-strict-hi` (n=12),
`copy-hotlead-strict-xbad` (new), `copy-src-live-tape` + `copy-src-external` (funnel-blocked,
counted as one source-probe slot pair). Incumbent unchanged: `copy-hotlead-strict` (n=628, drop3
+5.41, score 100, sole promotable).

**Addendum (same day) — new discovery source `winner_sniper` (operator thesis, picked from a
4-way comparison):** wallets that repeatedly EARLY-BUY (0-30s window, `competition_signals` —
free) the graduations that go on to WIN. Winner label = observed minute-cadence PATH (operator
spec 2026-07-03): 20 checks @ 60s from T+1m; WIN requires peak ≥ +50% AND ≥3 checks at/above the
bar (a real exit window, not a one-tick wick; a spike-then-fade token correctly counts as a WIN
that a single T+30m snapshot would miss). Full path stored (`path_json`) for post-hoc bar
recalibration. **Buyer capture spans the FULL window** (operator 2026-07-03): every wallet that
bought anywhere in the ~20min — the free 0-30s `competition_signals` UNION a capped sample of
pool-vault swap signers — not just the 0-30s snipers (a minute-9 dip into a winner counts).
Winners AND losers credit their buyers (losers only bump the appearance denominator). ~60
droppable reads/grad ≈ 8-10k calls/day. Ranked by winner-hit **precision** (hits ÷ appearances —
the spray-bot guard)
with a **36h half-life decay** + eviction (the operator's "good wallets rotate fast" observation,
consistent with recency>cumulative). Rejected alternatives: literal per-token profit attribution
(needs the tape — the June credit-blowout lesson) and same-day fast-track (spray-bot noise at
n=1-2). Harvester `winner-sniper.ts`; registry row auto-emits probe `copy-src-winner-sniper` +
scorecard verdict vs the OG control. Promoted wallets jump the scoring queue (priority 1200 +
decayed score). Env: `WINNER_SNIPER_DISABLED`, `WINNER_MIN_RET_PCT`, `WINNER_SNIPER_HALFLIFE_H`,
`WINNER_SNIPER_MIN_HITS/PRECISION/SCORE`. Funnel panel: `copy-trades.json → winner_sniper`.
Discovery sources sit outside the 4-slot lab cap (they're funnels, not strategy variants), but
this makes 3 sources collecting — hold new sources until one resolves.

---

## 2026-07-01 — Copy-v2 methodology overhaul + roster changes (operator-directed)

Operator-directed batch off a copy-v2 evaluation (branch `claude/copy-bot-strategy-review-96su67`).
Two parts: fix how the copy-v2 page measures the V2 (copy-net) lead-selection experiment, and act
on the standing roster proposals. Everything env-gated so default live behaviour is unchanged.

**copy-v2 page (`leaderboard-v2.ts` + `/copy-v2` renderer) — 5 methodology fixes:**
1. **Latency match.** V2 selects on `copy-tp100-sl30` (~1.1s fills) but the live copy-select arms
   execute at 5s+drift10 (copy-select-v2 already skips ~32% of candidates on drift vs ~4% for v1).
   Added latency-matched measurement baseline `copy-tp100-sl30-lag`; page now publishes
   `measurement.lag_vs_fast` (per-lead net at both latencies + sign-flips). Live selection stays on
   the fast baseline until the lag twin matures (env `COPYV2_USE_LAG_MEASURE`), so the A/B isn't disturbed.
2. **Walk-forward comparison.** The old headline scored leads on the same trades used to select them
   (circular). Added out-of-sample `method_comparison.walk_forward` (gate on pre-cutoff copies, score
   on post-cutoff); old block retained but relabelled `in_sample` (circular — do not cite).
3. **A/B shared/exclusive split + verdict.** Arm stats now split shared vs exclusive leads (only the
   exclusive subset distinguishes the methods); explicit `ab_verdict` incl. the both-fail→keep-V1 case
   and a min-edge noise floor the old "keep whichever nets more" rule ignored.
4. **Re-aim at the incumbent.** The select A/B runs on static TP100/SL30 (a ruleset the lab already
   killed). Added `copy-hotlead-strict-v2` (copy-net gate layered on the only promotable strategy) vs
   its control `copy-hotlead-strict` → does V2 add anything on top of what would actually deploy?
5. **Recency gate + calibration grid.** V2_GATE is cumulative reputation (≈ the killed `copy-elitelead`
   shape; #1 selected lead is 7d-negative yet still picked). Added an env-tunable recency clause
   (`COPYV2_MIN_NET_RECENT`, default disabled → no live change) and a walk-forward `gate_grid`
   (minCopies × recency) so the operator calibrates from data before flipping it on.
   Also: `paired_vs_baseline` now pairs on `copy_event_id` so the delayed-entry arms get paired.

**Roster kills (enacted from the 2026-06-30/07-01 backlog):** removed the 12 P/Q/R/S hold/exit-sweep
arms on `copy-hotlead-hold30m` (hold45m/60m/20m, sl20/sl40, be30, hold30m-strict, cap2, prune, early,
nochase, crowdexit). All hit their kill criterion (n≥100 or catastrophic; drop3 < parent). Finding:
the 30m time-stop + SL30 on the hot-lead entry is the local optimum for this exit family; exit search
on this base is retired. Closed rows remain in the DB → `retired_summary`.

**New hypothesis spawned (T, shadow):** `copy-hotlead-strict-hi` — net-floor hill-climb on the
incumbent. `copy-hotlead-strict` (the sole promotable) is `copy-hotlead` with the lead net floor
raised 0 → 0.5; this pushes that one defining lever further (0.5 → 1.0). Tests whether a stricter
"clearly profitable lately" floor concentrates a cleaner lead set (higher drop3/monthly) or
over-filters until n collapses. Same entry/exit; shares strict's polls. **Kill:** n≥100 and drop3 <
strict's drop3, OR can't reach n=100 in ~2 weeks (over-filtered). 2-week window. This is the one
autonomous lab spawn this cycle; recency-gate calibration waits on the `gate_grid` data post-deploy.

**Discipline note (multiple comparisons):** ~24 strategies have been scored against the same gates;
one score-100 survivor (`copy-hotlead-strict`) is partly what selection pressure alone produces. Its
real evidence is holding positive drop3 through both June 29–30 record drawdown days, not the point-in-
time score. Judge the V2 experiment the same way — persistence through bad tape, not a single net read.

---

## Incumbent

**`copy-consensus2-lag-drift5`** — promo score 75, n=137, net +4.32, stress +2.82, monthly +18.5 SOL.
**Blocked by drop3 = −0.90** (the failing gate). It's the highest-scoring *mature* realistic strategy.
The edge: token-level **consensus** (≥2 smart wallets) + don't-chase drift gate (≤5%) on a 5s-lag base.
Trend: promo score 62.8 → 75 over the last cycle, but drop3 went −0.28 → −0.90 — the new winners
concentrated in the same ~3 tops rather than broadening. **The convergence problem is drop3, not net.**

**Update 2026-06-19:** per the 2026-06-18 daily journal, `copy-consensus2-lag-drift5` has since
**crossed the bar** — promo 84, n=180, net +5.94, drop3 **+0.72**, stress +3.97, monthly +18.5
(all gates clear, PROMOTABLE). drop3 flipped positive on normal-trade accumulation (Δnet = Δdrop3,
no new lottery ticket) — healthy, but +0.72 is **thin**. Making that drop3 robust (and lifting
net/monthly) by booking modest winners earlier is the motivation for the exit-sweep cohort below.

## Durable signal findings (what to exploit / avoid)
- **Works:** token consensus (consensus2/3), lead selection (hotlead family). These are token/lead-intrinsic.
- **Doesn't:** window/macro timing (regime-mid/hi, macro, macro-regime all negative at n≥30). Avoid spawning more timing gates.
- **Open question:** can any consensus/lead variant get drop3 > 0 at n≥100, or is the signal structurally fat-tail-bound (profit always concentrated in a few moonshots)? That's the convergence question.

## In-flight experiments (pre-lab, adopted into tracking 2026-06-17)
| id | parent | hypothesis (one lever) | target_n | kill_criterion |
|---|---|---|---|---|
| copy-hotlead | (lead signal) | recent-P&L lead selection beats indiscriminate copy | 100 | drop3≤0 & net<0 at n≥100 |
| copy-hotlead-hold30m | hotlead | lead selection + 30m hold fixes the lottery-hold drop3 | 100 | drop3≤0 at n≥100 |
| copy-consensus3 | consensus2 | ≥3 wallets (higher conviction) lifts drop3 vs ≥2 | 100 | drop3 ≤ consensus2-lag-drift5's at n≥100 |
| copy-consensus2-elite | consensus2 + elite | consensus × cumulative-lead-quality | 100 | drop3≤0 at n≥100 |
| copy-elitelead | (lead signal) | cumulative lead reputation beats noisy recency | 100 | drop3≤0 & net<0 at n≥100 |
| copy-hotlead-strict / -deep | hotlead | tighter/deeper lead-quality calibration | 100 | no better than copy-hotlead at n≥100 |

> NOTE: 5 in-flight is over the MAX_INFLIGHT=4 cap, but these predate the lab and are mid-flight —
> let them mature and resolve before spawning new ones. **No new experiment until the slot count drops.**

## Resolved log
| date | id | verdict | why |
|---|---|---|---|
| 2026-06-17 | copy-consensus2-lag | KILLED | redundant with consensus2-lag-drift5 (no drift gate); drop3 −3.84 vs −0.90, strictly dominated |
| 2026-06-17 | copy-{tp100-sl30,followsell}-lag(+drift10), consensus2-lag-drift10 | KILLED | plain TP/SL & follow-sell don't survive realistic execution (n≥100, drop3 & stress decisively negative) |

## Convergence state (2026-06-17)
**Converging, blocked on drop3.** The roster has narrowed from ~26 to 20, the dead TP/SL & follow-sell
lineages are pruned, and the search has correctly focused on the two durable signals (consensus, lead
selection). The single incumbent (`consensus2-lag-drift5`) is the clear leader but is stuck below the
drop3 line. **Next exploitation should target drop3** — perturbations that broaden the winner
distribution (e.g. a smaller TP that books more modest winners instead of waiting for moonshots, or a
scale-out that realizes partial gains). **Hold new spawns until the 5 in-flight experiments mature past
n≥100** (the hotlead family + J-cohort), then resolve them and spawn the best drop3-targeted variant.

---

## Exit-sweep cohort — `copy-c2rr-*` (operator-directed, 2026-06-19)

A **directed batch**, not an autonomous lab spawn: 1 control + 9 exit variants, all on the
incumbent's **exact** entry (consensus2, `entryDelaySec:5`, `maxEntryDriftPct:5`), differing
**only** in the exit. Directly tests this ledger's own stated next move — *broaden the winner
distribution / "a scale-out that realizes partial gains"* — to make the incumbent's now-positive
but thin drop3 (+0.72) **robust** and lift net/monthly. Added a `trailingTp` runner-exit mechanic
to `src/copytrade/copy-trader.ts` (ratchet + scale-out already existed and are reused).

**MAX_INFLIGHT exception (intentional):** 10 arms at once vs the cap of 4. Justified because it's
operator-directed, shares ONE entry (a focused exit sweep, **not** dimensional sprawl), and is
self-comparing against its own fresh control. Treat the cohort as a **single experiment with 10
arms**, resolved together at n≥100. Hold autonomous spawns until it resolves.

**Win/kill (per variant, vs `copy-c2rr-control` over the same forward window):** WIN if it beats
control on **net_sol AND drop_top3** at n≥100. KILL if no better than control on both at n≥100,
or catastrophic (net < −3 at n≥40). Calibrate atPct/dropPct/tiers from the consensus2 MFE/peak
distribution before first resolution. target_n = 100 each (~2 weeks at consensus2's fire rate).

| id | arm | the one lever (vs control's static tp100/sl30) |
|---|---|---|
| `copy-c2rr-control` | control | none — fresh static tp100/sl30 baseline (same start window) |
| `copy-c2rr-breakeven` | ratchet | breakeven stop once +25% |
| `copy-c2rr-ratchet-tp` | ratchet | 3-tier step-up stops, keep the 2× cap |
| `copy-c2rr-ratchet-run` | ratchet | 3-tier step-up stops, no hard TP (ride) |
| `copy-c2rr-scaleout-50` | runner | bank 50% @+50%, rest → 2× |
| `copy-c2rr-scaleout-run` | runner | bank 50% @+75%, runner protected by a +30% ratchet |
| `copy-c2rr-trailtp-tight` | runner | trailing-TP: arm +30%, exit on 15% fall from HWM |
| `copy-c2rr-trailtp-wide` | runner | trailing-TP: arm +50%, exit on 30% fall from HWM |
| `copy-c2rr-scaleout-trailtp` | hybrid | bank 50% @+50%, then trail the runner |
| `copy-c2rr-ratchet-trailtp` | hybrid | ratchet downside + trailing-TP upside |

> Committed to dev branch `claude/confident-ritchie-e6tx14` (not yet merged/deployed — operator
> gate). Resolve via `/copy-daily-report` once arms reach n≥100; the breakeven/scale-out/ratchet
> arms are the ones most likely to thicken drop3 (book modest winners instead of waiting for the
> top-3 moonshots).
