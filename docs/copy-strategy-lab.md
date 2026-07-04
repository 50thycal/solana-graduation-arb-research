# Copy-Strategy Lab — ideation & convergence ledger

Maintained by the `/copy-strategy-lab` skill (weekly). Tracks the hill-climb toward a
**promotable** realistic copy strategy: the current incumbent, in-flight experiments and
their lineage, and the resolved log. Complement to `copy-trade-journal.md` (daily eval).

**Target:** a realistic strategy (5s entry lag) clearing n≥100 · drop3>0 · stress>0 · monthly≥3.75.
**Discipline:** one incumbent; spawn challengers that perturb its strongest lever by one param;
prune matured failures; cap in-flight experiments (MAX_INFLIGHT = 4); converge, don't sprawl.

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
