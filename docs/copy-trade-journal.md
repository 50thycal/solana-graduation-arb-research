# Copy-Trade Journal

Daily review log for the copy-trading subsystem, maintained by the `/copy-daily-report` skill.
Newest entry first. Each entry has a machine-readable `SNAPSHOT` block (used by the next day's
run to compute day-over-day deltas — do not hand-edit it) followed by human prose.

**Bar:** a copy strategy is promotable only with realistic execution (5s entry delay) AND n≥100 AND
drop_top3>0 AND exit_stress>0 AND monthly≥3.75 SOL. Idealized 1:1 mirrors are upper-bound references,
never live candidates. Roster changes are code edits to `COPY_STRATEGIES` (operator-approved), not
`strategy-commands.json`. Recommendations here are proposals.

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

**New strategies to try:** One candidate — propose `copy-conviction-consensus2-lag`: a realistic twin (5s entry delay) of `copy-conviction-consensus2`, the highest-scoring idealized strategy (promo 78.4, n=369, drop3=+1.87, monthly +25 SOL). It's the only idealized mirror besides `copy-followsell` with a positive drop3 at large n, and its ceiling is well above zero. Its existing idealized version has 207 common events with the baseline and a structural edge on consensus quality. A realistic lag twin would tell us whether that edge survives real-world entry timing.

**Operator next step:** Approve the KILL proposal for `copy-consensus2-lag` (one code edit to remove it from `COPY_STRATEGIES`). Then watch `copy-consensus2-lag-drift5` for the next ~38 trades (target n=175) — if drop3 remains negative there, kill it too and pivot to `copy-conviction-consensus2-lag` as the new primary hypothesis.
