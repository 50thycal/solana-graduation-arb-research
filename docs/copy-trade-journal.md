# Copy-Trade Journal

Daily review log for the copy-trading subsystem, maintained by the `/copy-daily-report` skill.
Newest entry first. Each entry has a machine-readable `SNAPSHOT` block (used by the next day's
run to compute day-over-day deltas — do not hand-edit it) followed by human prose.

**Bar:** a copy strategy is promotable only with realistic execution (5s entry delay) AND n≥100 AND
drop_top3>0 AND exit_stress>0 AND monthly≥3.75 SOL. Idealized 1:1 mirrors are upper-bound references,
never live candidates. Roster changes are code edits to `COPY_STRATEGIES` (operator-approved), not
`strategy-commands.json`. Recommendations here are proposals.

---

## 2026-06-18

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-06-18",
  "overall": {"n": 5538, "net": 57.55, "drop3": 27.15, "stress": -0.65, "open": 202},
  "retired_summary": {"n": 6483, "net": -124.51},
  "regime_score": 5, "regime_24h": 5, "macro_score": 6, "btc_7d_pct": 1.34,
  "book_daily_today": -11.42,
  "leads": {"n_leads": 94, "hot": 30, "cold": 40},
  "n_promotable_realistic": 2,
  "strategies": [
    {"id": "copy-consensus2-lag-drift5", "realistic": true, "n": 180, "net": 5.942, "drop3": 0.720, "stress": 3.969, "promo_score": 84.0, "verdict": "PROMOTE"},
    {"id": "copy-hotlead", "realistic": true, "n": 105, "net": 5.806, "drop3": 0.506, "stress": 4.608, "promo_score": 81.3, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-hold30m", "realistic": true, "n": 85, "net": 6.465, "drop3": -4.234, "stress": 5.460, "promo_score": 72.0, "verdict": "KEEP"},
    {"id": "copy-hotlead-deep", "realistic": true, "n": 40, "net": 5.174, "drop3": 0.237, "stress": 4.658, "promo_score": 66.0, "verdict": "KEEP"},
    {"id": "copy-hotlead-consensus", "realistic": true, "n": 52, "net": 3.871, "drop3": -1.429, "stress": 3.258, "promo_score": 65.4, "verdict": "KEEP"},
    {"id": "copy-consensus3", "realistic": true, "n": 41, "net": 2.450, "drop3": -2.487, "stress": 1.978, "promo_score": 63.0, "verdict": "KEEP"},
    {"id": "copy-hotlead-strict", "realistic": true, "n": 29, "net": 3.685, "drop3": -0.999, "stress": 3.313, "promo_score": 60.8, "verdict": "KEEP"},
    {"id": "copy-consensus2-elite", "realistic": true, "n": 18, "net": 1.051, "drop3": -0.692, "stress": 0.845, "promo_score": 47.0, "verdict": "KEEP"},
    {"id": "copy-elitelead", "realistic": true, "n": 21, "net": 0.248, "drop3": -1.494, "stress": 0.027, "promo_score": 39.4, "verdict": "KEEP"},
    {"id": "copy-macro", "realistic": true, "n": 156, "net": -1.728, "drop3": -7.598, "stress": -3.301, "promo_score": 40.0, "verdict": "KILL"},
    {"id": "copy-regime-mid", "realistic": true, "n": 123, "net": -0.723, "drop3": -3.719, "stress": -1.975, "promo_score": 40.0, "verdict": "KILL"},
    {"id": "copy-regime-hi", "realistic": true, "n": 75, "net": -3.315, "drop3": -5.329, "stress": -4.022, "promo_score": 35.0, "verdict": "KILL"},
    {"id": "copy-macro-regime", "realistic": true, "n": 73, "net": -2.070, "drop3": -4.662, "stress": -2.780, "promo_score": 34.6, "verdict": "WATCH"},
    {"id": "copy-hotlead-regime", "realistic": true, "n": 37, "net": -0.667, "drop3": -2.775, "stress": -1.035, "promo_score": 27.4, "verdict": "WATCH"},
    {"id": "copy-bigbuy", "realistic": true, "n": 15, "net": 0.356, "drop3": -1.522, "stress": 0.195, "promo_score": 32.1, "verdict": "KEEP"}
  ]
}
```

**Headline:** First bar crossings ever — `copy-consensus2-lag-drift5` (score 84, all gates clear) and `copy-hotlead` (score 81.3, all gates clear) are both **PROMOTABLE** with realistic execution, driven by yesterday's exceptional +54.52 SOL book day.

**Day-over-day (vs yesterday's 2026-06-17 snapshot):** Regime jumped from 2 (poor) → 5 (neutral); regime_24h also 5. Macro unchanged at 6 (tailwind), BTC 7d cooled from 5.72% → 1.34% (still positive, just less so). Yesterday's book closed at +54.52 SOL by EOD (well above the +23.38 in yesterday's snapshot). Today (09:59 UTC, partial) is rough: book -11.42 with 202 open positions showing -13.44 unrealized. Overall n +656, net +13.22, drop3 +13.21.

The critical development: both promotion candidates had their drop3 flip positive today.
- `copy-consensus2-lag-drift5`: drop3 −0.904 → +0.720. Δn=+43 (mostly yesterday's 48-trade day). Crucially, the delta in net and drop3 are **identical** (+1.624 each), meaning none of yesterday's 43 new trades entered the top-3 — normal-trade accumulation cleared the bar, not a new lottery ticket.
- `copy-hotlead`: drop3 −1.861 → +0.506. Δn=+29. Same arithmetic: Δnet = Δdrop3 = +2.367. The 29 new trades all landed below the existing top-3 threshold — healthy broadening.

Roster change since yesterday: `copy-consensus2-lag` confirmed killed (not in active roster; retired_summary n +223, net +6.50, suggesting the strategy had profitable final trades before retiring).

Additional kill candidates crystallized: `copy-macro` (n=156, all gates fail, monthly −12.96 SOL), `copy-regime-mid` (n=123, monthly −4.34 SOL), `copy-regime-hi` (n=75, net < −3 at n≥40 — catastrophic threshold hit).

**Week-over-week (book daily arc):** −0.88 (06-07) → −5.14 (06-08) → +33.83 (06-09) → +5.91 (06-10) → +3.25 (06-11) → +3.35 (06-12) → −17.82 (06-13) → −20.42 (06-14) → −7.25 (06-15) → +5.51 (06-16) → +54.52 (06-17) → −11.42 (06-18, partial). The Jun 13-14 crash stretched across exactly the window these realistic strategies launched, explaining the early negative drop3 readings. Jun 15-17 recovery is what finally accumulated enough floor to clear the bar.

Macro trajectory: BTC climbed from 60k (score 1-2 early June) to 65k range (score 5-8 mid-June) then slightly softened to 64k. Still tailwind but momentum is cooler than peak. Regime has been persistently poor (1-2) through most of June but jumped to 5 today — may reflect the recent positive tape. Lead pool: hot 26→30, cold 39→40 — cold leads still dominate by count but hot leads are gaining ground. Top leads remain steady (5q8osC4C, AE7neeVw, HntvSoXq all hot and net-positive). The macro/regime gating strategies (`copy-macro`, `copy-regime-hi`, `copy-macro-regime`) have all failed at scale — the signal does not help; waiting for a "better" regime just starved them of trades while the ungated hotlead/consensus strategies ran profitably through the same windows.

`copy-hotlead-deep` is the standout new watch: n=40, net +5.17, drop3 +0.237 (positive already at n=40 — earlier than consensus2-lag-drift5 achieved it at n=180). 27 of 40 trades happened on Jun 17, so this number is very fragile; but the early drop3 sign is unusual and worth tracking.

**Verdicts (proposals — roster changes require operator approval + `COPY_STRATEGIES` code edit):**

- **PROMOTE:** `copy-consensus2-lag-drift5` — n=180, net +5.942, drop3 +0.720, stress +3.969, monthly +22.28 SOL, all gates clear. Propose live-micro test. Caveat: margins are thin and ~87% of total net came from two days (Jun 15 +3.67, Jun 17 +5.22); recommend starting at MICRO_TRADE_SIZE_SOL and monitoring weekly net. `copy-hotlead` — n=105, net +5.806, drop3 +0.506, stress +4.608, monthly +29.03 SOL, all gates clear. Propose live-micro test. Same caveat on concentration (Jun 15 +3.55, Jun 17 +4.98 dominated).

- **KEEP COOKING:** `copy-hotlead-hold30m` (n=85, net +6.465, stress +5.46 — but drop3 −4.234 blocks it; needs to reach n=100 and flip drop3 positive to be a candidate). `copy-hotlead-deep` (n=40, drop3 +0.237 — strong early signal, most trades from one day so hold until n≥80 before reading anything into drop3). `copy-hotlead-consensus` (n=52, net +3.87, drop3 −1.43). `copy-hotlead-strict` (n=29, net +3.69, drop3 −1.00). `copy-consensus3` (n=41, net +2.45, drop3 −2.49). `copy-consensus2-elite` (n=18, net +1.05). `copy-elitelead` (n=21, net +0.25). `copy-bigbuy` (n=15, gate-starved: 1145 skips on lead_buy_size).

- **KILL (proposals):** `copy-macro` — n=156, realistic, drop3 −7.60, stress −3.30, monthly −12.96 SOL. All gates fail decisively at scale. Macro timing is net-negative. Recommend removing. `copy-regime-mid` — n=123, realistic, drop3 −3.72, stress −1.98, monthly −4.34 SOL. n≥100 with all gates failed. Regime gating adds noise, not edge. Recommend removing. `copy-regime-hi` — n=75, net −3.315 (< −3 at n≥40, catastrophic threshold). drop3 −5.33, stress −4.02. High-regime gating is pure loss. Recommend removing.

- **WATCH (approaching kill):** `copy-macro-regime` (n=73, net −2.07, drop3 −4.66 — not yet catastrophic but same pattern as the three kills above; propose kill at n=100 if gates still fail). `copy-hotlead-regime` (n=37, net −0.67, drop3 −2.78 — regime gate is dragging a hotlead-based strategy into loss; propose kill at n=60 if net still negative).

**New strategies to try:** None this cycle. The two promotions are the priority action, and the kill list needs clearing before adding more noise. One candidate to revisit after hotlead-deep matures to n≥80: `copy-hotlead-deep-drift5` (drift-gated variant of hotlead-deep) — but only propose if hotlead-deep's drop3 remains positive at larger n. Guardrail check: no equivalent exists in the current roster.

**Operator next step:** Approve promoting `copy-consensus2-lag-drift5` and `copy-hotlead` to live-micro (code edit to `COPY_STRATEGIES`, add `executionMode: "live_micro"`), and approve killing `copy-macro`, `copy-regime-mid`, `copy-regime-hi` (remove from `COPY_STRATEGIES`). This is the first live deployment decision — verify MICRO_TRADE_SIZE_SOL is set appropriately before enabling.

---

## 2026-06-17

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-06-17",
  "overall": {"n": 4882, "net": 44.33, "drop3": 13.94, "stress": -6.84, "open": 184},
  "retired_summary": {"n": 6260, "net": -131.01},
  "regime_score": 2, "regime_24h": 1, "macro_score": 6, "btc_7d_pct": 5.72,
  "book_daily_today": 23.38,
  "leads": {"n_leads": 85, "hot": 26, "cold": 39},
  "n_promotable_realistic": 0,
  "strategies": [
    {"id": "copy-consensus2-lag-drift5", "realistic": true, "n": 137, "net": 4.318, "drop3": -0.904, "stress": 2.821, "promo_score": 75.0, "verdict": "WATCH"},
    {"id": "copy-hotlead", "realistic": true, "n": 76, "net": 3.439, "drop3": -1.861, "stress": 2.587, "promo_score": 70.2, "verdict": "KEEP"},
    {"id": "copy-hotlead-hold30m", "realistic": true, "n": 57, "net": 7.376, "drop3": -3.323, "stress": 6.642, "promo_score": 66.4, "verdict": "KEEP"},
    {"id": "copy-consensus2-lag", "realistic": true, "n": 183, "net": 2.986, "drop3": -3.843, "stress": 1.041, "promo_score": 65.4, "verdict": "KILL"},
    {"id": "copy-hotlead-consensus", "realistic": true, "n": 30, "net": 2.307, "drop3": -2.993, "stress": 1.952, "promo_score": 60.5, "verdict": "WATCH"},
    {"id": "copy-hotlead-deep", "realistic": true, "n": 19, "net": 2.728, "drop3": -2.209, "stress": 2.477, "promo_score": 58.8, "verdict": "WATCH"},
    {"id": "copy-hotlead-strict", "realistic": true, "n": 15, "net": 2.853, "drop3": -1.823, "stress": 2.641, "promo_score": 58.0, "verdict": "WATCH"},
    {"id": "copy-consensus3", "realistic": true, "n": 14, "net": 2.897, "drop3": -2.039, "stress": 2.695, "promo_score": 57.8, "verdict": "WATCH"},
    {"id": "copy-bigbuy", "realistic": true, "n": 9, "net": 0.792, "drop3": -1.086, "stress": 0.684, "promo_score": 43.6, "verdict": "WATCH"},
    {"id": "copy-consensus2-elite", "realistic": true, "n": 2, "net": 0.436, "drop3": 0.0, "stress": 0.407, "promo_score": 39.5, "verdict": "WATCH"},
    {"id": "copy-macro", "realistic": true, "n": 87, "net": 0.082, "drop3": -5.787, "stress": -0.816, "promo_score": 40.7, "verdict": "WATCH"},
    {"id": "copy-regime-mid", "realistic": true, "n": 57, "net": -3.608, "drop3": -6.453, "stress": -4.123, "promo_score": 31.4, "verdict": "WATCH"},
    {"id": "copy-regime-hi", "realistic": true, "n": 42, "net": -3.493, "drop3": -5.507, "stress": -3.856, "promo_score": 28.4, "verdict": "WATCH"},
    {"id": "copy-macro-regime", "realistic": true, "n": 33, "net": -3.167, "drop3": -5.719, "stress": -3.443, "promo_score": 26.6, "verdict": "WATCH"},
    {"id": "copy-hotlead-regime", "realistic": true, "n": 19, "net": -2.662, "drop3": -3.300, "stress": -2.805, "promo_score": 23.8, "verdict": "WATCH"},
    {"id": "copy-elitelead", "realistic": true, "n": 4, "net": -0.299, "drop3": -0.472, "stress": -0.334, "promo_score": 20.8, "verdict": "WATCH"}
  ],
  "note": "Updated from seed (same date). 5 decisively-failed realistic strategies killed (tp100-sl30-lag, followsell-lag, tp100-sl30-lag-drift10, followsell-lag-drift10, consensus2-lag-drift10). J-cohort (consensus3/elitelead/consensus2-elite) now in data. Big positive day: book +23.38 closed / +42.94 overall."
}
```

**Headline:** `copy-consensus2-lag-drift5` hit promo score 75 (n=137, net +4.32, monthly +18.5 SOL) after a strong +2.29 SOL day — but drop3 deepened to −0.90, and nothing clears the realistic bar yet.

**Day-over-day (vs seed written earlier this morning):** Regime improved 1 → 2 (still "poor"). Macro unchanged at 6 (BTC tailwind, 7d +5.72%, 1d −0.14%). Book had an exceptional day: +23.38 SOL closed (+42.94 overall including open unrealized). Five decisively-failed realistic strategies confirmed killed (tp100-sl30-lag, followsell-lag, tp100-sl30-lag-drift10, followsell-lag-drift10, consensus2-lag-drift10) — now in retired_summary (n=6260, net=−131). The J-cohort launched: copy-consensus3 (n=14, +2.90), copy-elitelead (n=4, −0.30), copy-consensus2-elite (n=2, +0.44). Top promo-score movers today: `copy-consensus2-lag-drift5` +12.2 pts (62.8→75.0), `copy-hotlead` +22.3 pts (47.9→70.2), `copy-hotlead-consensus` +37.5 pts (23.0→60.5, but n=30 — today's surge inflating it). `copy-consensus2-lag-drift5` drop3 moved more negative (−0.28 → −0.90): the 20 new profitable trades didn't broaden the winner distribution — same 3 tops still dominating. Critical to watch.

**Week-over-week (1 prior entry — arc established):** Book daily: −0.88 (06-07) → −5.14 (06-08) → +33.83 (06-09) → +5.91 (06-10) → +0.27 (06-11) → +5.12 (06-12) → −18.89 (06-13) → −22.93 (06-14) → −4.60 (06-15) → +8.70 (06-16) → +42.94 (06-17, partial). The realistic-execution strategies launched during the bad 06-13/14 stretch; their drop3 reflects those losses. Macro has recovered from extreme lows (BTC 60k, score 1–2 early June) to 65k, score 6 now. Regime has been persistently poor (1–2 range) but book performance is recovering — suggesting regime score is lagging. Lead pool: hot 26 vs cold 39 — cold still slightly dominates.

**Verdicts (proposals — roster changes require operator approval + `COPY_STRATEGIES` code edit):**

- PROMOTE: None. Zero realistic strategies clear the bar.

- KEEP COOKING: `copy-hotlead` (n=76, +3.44 net, promo 70.2 — trajectory is strong, +2.69 today; needs to reach n=100 and flip drop3 positive). `copy-hotlead-hold30m` (n=57, net +7.38, stress +6.64, promo 66.4 — spectacular today +7.89 on 20 trades, but that single day dominates at small n; treat as promising, not confirmed).

- KILL (proposal): `copy-consensus2-lag` — n=183, drop3=−3.84. Gate fails decisively at scale; its drift5 twin is strictly better on every metric. Recent good days (+1.93 today, +3.20 yesterday) don't rescue a −3.84 drop3 at n=183. Recommend killing to save RPC and reduce noise.

- WATCH (approaching kill threshold — propose kill at n≥100 if gates still fail): `copy-macro` (n=87, drop3=−5.79, stress=−0.82 — 13 more trades from the trigger; deteriorating consistently). `copy-regime-mid` (n=57, every daily net negative — regime filter is adding noise, not edge). `copy-regime-hi` (n=42, same pattern). `copy-macro-regime` (n=33, all metrics negative and worsening). `copy-hotlead-regime` (n=19, win_rate 5%, clearly toxic).

- WATCH (too new to call): `copy-consensus2-lag-drift5` (n=137, **sole viable realistic candidate** — promo score 75, monthly +18.5 SOL, but drop3=−0.90 blocks promotion; hold until n=175, then kill if drop3 still <0). `copy-hotlead-consensus` (n=30, inflated by today's surge — small n). `copy-hotlead-deep` (n=19), `copy-hotlead-strict` (n=15), `copy-consensus3` (n=14, J-cohort). `copy-consensus2-elite` (n=2), `copy-elitelead` (n=4, already −0.30 — watching). `copy-bigbuy` (n=9, very sparse — `lead_buy_size` gate filtering heavily, 586 skips).

**New strategies to try:** ~~Propose `copy-conviction-consensus2-lag`~~ **— CORRECTION (operator review, 2026-06-17): this proposal is REDUNDANT and was rejected.** A realistic 5s-entry twin of `copy-conviction-consensus2` already exists: it is exactly `copy-consensus2-lag` (entryDelaySec:5 + minConsensusRecent:2) and its drift-gated sibling `copy-consensus2-lag-drift5`. So the realistic consensus2 test is already running — and `consensus2-lag-drift5` is the better of the two (drop3 −0.90 vs −3.84). Do **not** recreate it; `consensus2-lag-drift5` IS the primary consensus hypothesis to watch. No new strategy added this cycle. (Guardrail added to the skill: before proposing a "new" strategy, check `COPY_STRATEGIES` for an existing `-lag` twin of the idealized mirror.)

**Operator next step:** ✅ DONE (2026-06-17): `copy-consensus2-lag` killed (removed from `COPY_STRATEGIES`). The redundant `copy-conviction-consensus2-lag` proposal was rejected (the realistic consensus2 twin already exists as `copy-consensus2-lag-drift5`). Now watch `copy-consensus2-lag-drift5` for the next ~38 trades (target n=175) — if drop3 remains negative there, kill it too; the next primary hypothesis would be the `copy-hotlead` family (the lead-selection signal), not a consensus2 recreate.
