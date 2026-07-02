# Copy-Strategy Lab — ideation & convergence ledger

Maintained by the `/copy-strategy-lab` skill (weekly). Tracks the hill-climb toward a
**promotable** realistic copy strategy: the current incumbent, in-flight experiments and
their lineage, and the resolved log. Complement to `copy-trade-journal.md` (daily eval).

**Target:** a realistic strategy (5s entry lag) clearing n≥100 · drop3>0 · stress>0 · monthly≥3.75.
**Discipline:** one incumbent; spawn challengers that perturb its strongest lever by one param;
prune matured failures; cap in-flight experiments (MAX_INFLIGHT = 4); converge, don't sprawl.

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
