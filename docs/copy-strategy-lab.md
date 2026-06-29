# Copy-Strategy Lab — ideation & convergence ledger

Maintained by the `/copy-strategy-lab` skill (weekly). Tracks the hill-climb toward a
**promotable** realistic copy strategy: the current incumbent, in-flight experiments and
their lineage, and the resolved log. Complement to `copy-trade-journal.md` (daily eval).

**Target:** a realistic strategy (5s entry lag) clearing n≥100 · drop3>0 · stress>0 · monthly≥3.75.
**Discipline:** one incumbent; spawn challengers that perturb its strongest lever by one param;
prune matured failures; cap in-flight experiments (MAX_INFLIGHT = 4); converge, don't sprawl.

---

## Incumbent (updated 2026-06-29)

**`copy-hotlead-hold30m`** — score 100, n=846, net +42.85 SOL, drop3 +11.72, stress +33.28,
monthly +91.82 SOL/mo. **All gates clear. PROMOTABLE.**

Supersedes `copy-consensus2-lag-drift5` (the previous incumbent). The consensus2 line has been
retired — the lab focus shifted entirely to the hotlead family, which proved more durable and
better-distributed. The hotlead signal + 30-minute hold cap is the dominant configuration.

**Why it's the incumbent over `copy-hotlead` and `copy-hotlead-strict` (both also score 100):**
- Net: 42.85 vs 14.61 / 14.52
- drop3: 11.72 vs 7.59 / 7.94 — broadest winner distribution
- stress: 33.28 vs 5.11 / 8.90 — most robust to exit-stress penalty
- Monthly run rate: 91.82 vs 31.31 / 31.12 SOL/mo — 3× the others

The 30m cap prevents the lottery-hold pattern; without it (`copy-hotlead`, no max_hold) the P&L
is similar in net but stress is much weaker. With a 45m cap, drop3 collapses (see resolved log).
The optimal window is clearly 30m.

**Caution:** the pair-shadow window (n=308, most recent start) shows weaker recent performance
(net=+0.49, drop3=−0.72) vs the full history (n=846, net=+42.85, drop3=+11.72). The early-window
trades are carrying the cumulative metrics. Drop3 should be re-verified as the window extends.

## Three simultaneous PROMOTABLE strategies (2026-06-29)

All score 100, all gates clear at n≥100 with realistic execution:

| id | n | net_sol | drop3 | stress | monthly_sol |
|---|---|---|---|---|---|
| **copy-hotlead-hold30m** | 846 | +42.85 | +11.72 | +33.28 | +91.82 |
| **copy-hotlead-strict** | 518 | +14.52 | +7.94 | +8.90 | +31.12 |
| **copy-hotlead** | 894 | +14.61 | +7.59 | +5.11 | +31.31 |

**Live-micro recommendation (operator action required):**
`copy-hotlead-hold30m` is the primary live candidate (91.82 SOL/mo, 3× the others, strongest
drop3 and stress). If only one strategy goes live, this is it. `copy-hotlead` and
`copy-hotlead-strict` can run as secondary live-micro arms once the primary is validated.
Note: `copy-hotlead-hold30m-live-micro` (the previous live-micro test, n=308) produced net=−0.51
with drop3=−0.72 — underperforming its shadow, suggesting execution slip or adverse recent
window. Investigate live execution health before re-enabling.

## Durable signal findings (what to exploit / avoid)

- **Works:** hotlead gate (recent-window lead P&L selection), max_hold_sec=1800 (30m cap). These
  are the core levers of the incumbent. Lead selection is the primary filter; the 30m cap prevents
  lottery-ticket hold and broadens the winner distribution.
- **Works (but idealized only):** token consensus (conviction-consensus2, n=1120, net=+18.24 — but
  no entryDelaySec, so never a live candidate). The signal exists but hasn't yet been validated
  under a 5s realistic lag; the consensus2 line was retired before that test ran.
- **Doesn't:** alternative hold lengths (20m/45m/60m all fail drop3 decisively at n≥100). Tighter
  SL (sl20, sl40) and breakeven-stop (be30) both hurt drop3 — original sl30 is best. Stricter
  hotlead gate (minNetSol=0.5 vs 0) appears to hurt (hold30m-strict n=84 going negative).
- **Open:** wallet-set diversification (ogsmart, cotrade) — both at n~53, looking weak but too
  early to conclude. Crowd-exit mechanic (crowdexit, n=44, net=+1.17) — slightly positive, worth
  watching to n=100.
- **Avoid:** timing gates (regime, macro), extra consensus layers (consensus2-elite). Proven losers.

---

## In-flight experiments as of 2026-06-29

8 in-flight (n<100). **MAX_INFLIGHT=4 is breached — no new spawn this cycle.**
Several of these are clearly failing early; they'll resolve at n=100 without further action.

| id | n | net | drop3 | stress | kill_criterion | status |
|---|---|---|---|---|---|---|
| copy-hotlead-hold30m-crowdexit | 44 | +1.17 | −1.64 | +0.69 | drop3≤0 at n≥100 | WATCH — only one showing life |
| copy-hotlead-hold30m-strict | 84 | −2.24 | −6.21 | −3.06 | drop3≤0 at n≥100 | On kill path — drop3 deep negative at n=84 |
| copy-hotlead-hold30m-cap2 | 72 | −2.43 | −5.59 | −3.13 | drop3≤0 at n≥100 | On kill path |
| copy-hotlead-hold30m-prune | 79 | −2.69 | −6.58 | −3.45 | drop3≤0 at n≥100 | On kill path |
| copy-hotlead-hold30m-early | 24 | −1.95 | −2.67 | −2.16 | drop3≤0 at n≥100 | Bad trajectory early |
| copy-hotlead-hold30m-nochase | 19 | −2.34 | −2.75 | −2.49 | drop3≤0 at n≥100 | Bad trajectory early |
| copy-ogsmart-tp100-sl30 | 53 | +0.18 | −1.92 | −0.37 | drop3≤0 & net<0 at n≥100 | Marginal; no lag — not realistic |
| copy-cotrade-tp100-sl30 | 54 | −0.99 | −2.93 | −1.52 | drop3≤0 & net<0 at n≥100 | Negative; no lag — not realistic |

**Crowdexit** (n=44, net=+1.17, stress=+0.69) is the only in-flight experiment with positive net
and stress. Drop3 is still −1.64 — needs to broaden the winner distribution. Will be resolved at
n=100. If drop3 turns positive, it becomes a viable variant to compare to the incumbent.

**Ogsmart / cotrade** are not realistic (no entryDelaySec) and will not be promotable regardless
of outcome. Track for signal quality only.

---

## Resolved log (all-time)

| date | id | verdict | why |
|---|---|---|---|
| 2026-06-17 | copy-consensus2-lag | KILLED | redundant with drift5 twin; drop3 −3.84, strictly dominated |
| 2026-06-17 | copy-{tp100-sl30,followsell}-lag(+drift10), consensus2-lag-drift10 | KILLED | TP/SL + follow-sell don't survive realistic execution (drop3 & stress negative at n≥100) |
| 2026-06-29 | copy-hotlead-hold20m | PROPOSE KILL | n=137, drop3=−8.17, stress=−3.06. 20m cap is too short — exits before gains mature |
| 2026-06-29 | copy-hotlead-hold45m | PROPOSE KILL | n=137, drop3=−11.66. 45m cap over-holds into reversal; lottery-ticket P&L, drop3 decisive fail |
| 2026-06-29 | copy-hotlead-hold60m | PROPOSE KILL | n=118, drop3=−11.71, stress=−8.57. 60m severely over-holds; both gates negative |
| 2026-06-29 | copy-hotlead-hold30m-sl20 | PROPOSE KILL | n=129, drop3=−9.37, stress=−7.10. Tighter SL at 20% cuts winners too early and amplifies lottery concentration |
| 2026-06-29 | copy-hotlead-hold30m-sl40 | PROPOSE KILL | n=118, drop3=−10.69, stress=−7.68. Wider SL at 40% holds losers too long; both gates negative |
| 2026-06-29 | copy-hotlead-hold30m-be30 | PROPOSE KILL | n=126, drop3=−7.87, stress=−5.72. Breakeven stop at +30% kills the moderate winners early; worse than static sl30 |
| 2026-06-29 | copy-hotlead-hold30m-pair-shadow | PROPOSE KILL | n=308, drop3=−0.72, monthly=2.09 SOL. Drop3 negative, below monthly bar — inferior in the recent window |
| 2026-06-29 | copy-hotlead-hold30m-live-micro | PROPOSE KILL | n=308, net=−0.51, drop3=−1.24, stress=−0.56. Losing real money; shadow also underperforming in recent window |
| 2026-06-29 | copy-tp100-sl30 | PROPOSE KILL | n=2460, net=−20.14, drop3=−26.69, stress=−45.07. Idealized no-lag, massive cumulative loss |
| 2026-06-29 | copy-hotlead | ELEVATED to PROMOTABLE | n=894, all gates clear, score 100 |
| 2026-06-29 | copy-hotlead-hold30m | ELEVATED to PROMOTABLE + new INCUMBENT | n=846, all gates clear, score 100, monthly 91.82 SOL |
| 2026-06-29 | copy-hotlead-strict | ELEVATED to PROMOTABLE | n=518, all gates clear, score 100 |

**Previously resolved (between 2026-06-19 and 2026-06-29, based on absence from current roster):**
`copy-consensus2-lag-drift5`, `copy-consensus3`, `copy-elitelead`, `copy-consensus2-elite`,
`copy-hotlead-deep`, `copy-hotlead-consensus`, `copy-hotlead-regime`, `copy-macro`,
`copy-regime-mid`, `copy-regime-hi`, `copy-macro-regime`, `copy-bigbuy` — all killed via
daily-report cycle between June 19–29. Lineage is in `copy-trade-journal.md`.

---

## Dropped: exit-sweep cohort `copy-c2rr-*` (proposed 2026-06-19, never deployed)

The 10-arm exit sweep (breakeven/ratchet/scaleout/trailtp variants on consensus2 entry) was
committed to branch `claude/confident-ritchie-e6tx14` but never merged. It became moot once
`copy-hotlead-hold30m` achieved promotable status with strong drop3 and stress. The c2rr cohort
targeted the consensus2 entry (drop3=+0.72, thin). The incumbent's current drop3=+11.72 at n=846
is a far better base — no urgent need to run exit variants on a weaker entry.

**If the hotlead-hold30m's recent-window weakening persists** (pair-shadow drop3=−0.72), revisit
exit variants targeted to hotlead-hold30m (not consensus2) in a future lab cycle.

---

## Convergence state (2026-06-29)

**CONVERGING WELL — first time with three simultaneous PROMOTABLE realistic strategies.**

The hotlead family has decisively answered the lab's core question: yes, a copy signal can produce
drop3>0 at n≥100 under realistic execution. The ticket is not structurally fat-tail-bound when you
combine (a) recent-P&L lead selection and (b) a 30-minute hold cap that prevents over-holding into
reversals.

**What the hold-duration sweep proved:** 20m (too short), 30m (optimal), 45m (drop3 collapses),
60m (net negative). Lock the hold at 30m. **What the SL sweep proved:** sl20/sl40/be30 all hurt
drop3 vs the base sl30. Lock SL at 30%.

**Remaining open questions:**
1. Is the hotlead-hold30m edge holding up in the most recent window? The pair-shadow (n=308) shows
   weaker performance. Monitor as n grows; if drop3 turns negative at n=400+, we may need a
   refresh of the hotlead gate or wallet roster.
2. Does the crowdexit mechanic (n=44, net=+1.17) survive to n=100 with positive drop3? If yes,
   it's a one-lever variant worth promoting alongside the incumbent.
3. Can any wallet-diversification signal (ogsmart, cotrade) clear the realistic bar?

**Next spawn:** None this cycle (8 in-flight > MAX_INFLIGHT=4). Once the 6 near-failure experiments
resolve at n=100 (hold30m-strict/cap2/prune should hit n=100 within days), slots will free up. The
next spawn candidate — if crowdexit resolves positive — is a **hold30m-crowdexit-lag** with
`entryDelaySec:5` + `maxEntryDriftPct:10` + the crowdexit mechanic, targeting drop3 improvement
via earlier exit on crowd-sell detection. If crowdexit fails, the next dimension to explore is the
hotlead gate threshold or a partial scale-out that banks 50% at +50% before the 30m cap.
