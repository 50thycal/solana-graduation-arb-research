# Copy-Trade Journal

Daily review log for the copy-trading subsystem, maintained by the `/copy-daily-report` skill.
Newest entry first. Each entry has a machine-readable `SNAPSHOT` block (used by the next day's
run to compute day-over-day deltas — do not hand-edit it) followed by human prose.

**Bar:** a copy strategy is promotable only with realistic execution (5s entry delay) AND n≥100 AND
drop_top3>0 AND exit_stress>0 AND monthly≥3.75 SOL. Idealized 1:1 mirrors are upper-bound references,
never live candidates. Roster changes are code edits to `COPY_STRATEGIES` (operator-approved), not
`strategy-commands.json`. Recommendations here are proposals.

---

## 2026-06-26

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-06-26",
  "overall": {"n": 7272, "net": 59.70, "drop3": 35.71, "stress": -13.02, "open": 17},
  "retired_summary": {"n": 16367, "net": -95.47},
  "regime_score": 5, "regime_24h": 6, "macro_score": 5, "btc_7d_pct": -3.94,
  "book_daily_today": 31.77,
  "leads": {"n_leads": 148, "hot": 42, "cold": 68},
  "n_promotable_realistic": 5,
  "strategies": [
    {"id": "copy-hotlead",                         "realistic": true,  "n": 691, "net": 14.074, "drop3":  7.493, "stress":  6.675, "promo_score": 100.0, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-hold30m",                 "realistic": true,  "n": 651, "net": 30.410, "drop3":  6.425, "stress": 23.096, "promo_score": 100.0, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-strict",                  "realistic": true,  "n": 390, "net": 11.129, "drop3":  4.547, "stress":  6.890, "promo_score": 100.0, "verdict": "PROMOTE"},
    {"id": "copy-consensus2-elite",                "realistic": true,  "n": 147, "net":  3.838, "drop3":  0.987, "stress":  2.247, "promo_score":  87.3, "verdict": "PROMOTE"},
    {"id": "copy-elitelead",                       "realistic": true,  "n": 257, "net":  4.300, "drop3":  0.761, "stress":  1.566, "promo_score":  80.2, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-consensus",               "realistic": true,  "n": 309, "net":  5.849, "drop3": -0.591, "stress":  2.550, "promo_score":  75.0, "verdict": "WATCH"},
    {"id": "copy-hotlead-trailtp-wide",            "realistic": true,  "n":  65, "net":  2.260, "drop3": -1.662, "stress":  1.545, "promo_score":  63.4, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-pair-shadow",     "realistic": true,  "n": 145, "net":  0.930, "drop3": -0.262, "stress":  0.762, "promo_score":  62.6, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-trailtp-wide",    "realistic": true,  "n":  63, "net":  1.763, "drop3": -1.736, "stress":  1.079, "promo_score":  58.4, "verdict": "WATCH"},
    {"id": "copy-hotlead-deep",                    "realistic": true,  "n": 509, "net":  5.683, "drop3": -0.900, "stress":  0.327, "promo_score":  58.3, "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-ratchet-trailtp", "realistic": true,  "n":  63, "net":  1.203, "drop3": -2.296, "stress":  0.530, "promo_score":  52.9, "verdict": "WATCH"},
    {"id": "copy-hotlead-ratchet-trailtp",         "realistic": true,  "n":  63, "net":  1.081, "drop3": -1.905, "stress":  0.411, "promo_score":  51.7, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-scaleout-trailtp","realistic": true,  "n":  66, "net":  0.804, "drop3": -1.673, "stress":  0.258, "promo_score":  50.8, "verdict": "WATCH"},
    {"id": "copy-hotlead-scaleout-trailtp",        "realistic": true,  "n":  75, "net":  0.260, "drop3": -2.327, "stress": -0.305, "promo_score":  45.4, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-live-micro",      "realistic": true,  "n": 145, "net": -0.015, "drop3": -0.721, "stress":  0.098, "promo_score":  41.0, "verdict": "KILL"},
    {"id": "copy-hotlead-ctrl",                    "realistic": true,  "n": 158, "net":  0.011, "drop3": -2.697, "stress": -1.617, "promo_score":  40.3, "verdict": "KILL"},
    {"id": "copy-hotlead-cap",                     "realistic": true,  "n": 144, "net": -1.371, "drop3": -3.774, "stress": -2.826, "promo_score":  40.0, "verdict": "KILL"},
    {"id": "copy-elitelead-ctrl",                  "realistic": true,  "n":  93, "net": -1.287, "drop3": -3.962, "stress": -2.219, "promo_score":  38.6, "verdict": "WATCH"},
    {"id": "copy-hotlead-consensus-cap",           "realistic": true,  "n":  73, "net": -1.258, "drop3": -3.589, "stress": -1.985, "promo_score":  34.6, "verdict": "WATCH"},
    {"id": "copy-hotlead-consensus-ctrl",          "realistic": true,  "n":  72, "net": -1.916, "drop3": -4.246, "stress": -2.619, "promo_score":  34.4, "verdict": "WATCH"},
    {"id": "copy-elitelead-cap",                   "realistic": true,  "n":  72, "net": -1.430, "drop3": -3.617, "stress": -2.143, "promo_score":  34.4, "verdict": "WATCH"},
    {"id": "copy-cons2elite-ratchet-trailtp",      "realistic": true,  "n":  19, "net": -1.735, "drop3": -2.971, "stress": -1.896, "promo_score":  23.8, "verdict": "WATCH"},
    {"id": "copy-cons2elite-scaleout-trailtp",     "realistic": true,  "n":  19, "net": -1.758, "drop3": -3.129, "stress": -1.858, "promo_score":  23.8, "verdict": "WATCH"},
    {"id": "copy-cons2elite-trailtp-wide",         "realistic": true,  "n":  19, "net": -1.887, "drop3": -3.265, "stress": -2.045, "promo_score":  23.8, "verdict": "WATCH"},
    {"id": "copy-3eg1-follow",                     "realistic": true,  "n":   0, "net":  0.000, "drop3":  0.000, "stress":  0.000, "promo_score":  20.0, "verdict": "WATCH"},
    {"id": "copy-3eg1-runner",                     "realistic": true,  "n":   0, "net":  0.000, "drop3":  0.000, "stress":  0.000, "promo_score":  20.0, "verdict": "WATCH"},
    {"id": "copy-3eg1-tp100",                      "realistic": true,  "n":   0, "net":  0.000, "drop3":  0.000, "stress":  0.000, "promo_score":  20.0, "verdict": "WATCH"}
  ]
}
```

**Headline:** Tape recovery: regime flips from poor (score=2) to neutral (score=5); book surges +31.77 SOL today reversing three losing days; copy-elitelead drop3 sign-flip BACK to positive (+0.761) restores it as the 5th promotable realistic strategy; copy-hotlead-strict reaches score=100.

**Day-over-day (vs 2026-06-25):**
- Regime: 2 (poor) → 5 (neutral). 24h trailing score rose 1→6 — the recovery is broad, not a single spike. Book net_6h = −3.25 (slightly negative in the last 6h as of snapshot time ~10am UTC, but overall daily +31.77).
- Macro: BTC score 6→5 (neutral). BTC 7d pct deteriorated further (−1.74%→−3.94%), but today's daily bounce +2.15% is giving a locally positive tailwind. No macro recovery yet on the weekly timeframe.
- **Book daily:** −8.47 (partial Jun 25) → Jun 25 closed at −15.96 → Jun 26 currently +31.77. A strong single-day recovery after three consecutive losing days (Jun 23 −8.63, Jun 24 −40.84, Jun 25 −15.96 closed). Cumulative swing over 3 bad days was approximately −65 SOL; today has returned ~31.77 of that.
- **copy-elitelead DROP3 SIGN FLIP BACK TO POSITIVE:** drop3 −0.246→+0.761 (+1.007 Δ), score 63→80.2 (+17.2 pts). Was WATCH yesterday after losing its drop3 gate on Jun 25; today's strong tape closed enough winning trades to restore robustness. All gates now clear (n=257, drop3>0, stress>0, monthly=+12.90 SOL). Restored to promotable.
- **copy-hotlead-strict REACHES score=100:** drop3 +1.703→+4.547 (+2.844 Δ), score 96→100. A standout improvement — three consecutive days of drop3 gains despite the surrounding tape volatility confirms this filter is genuinely screening out bad entries. Monthly=+30.35 SOL.
- **copy-hotlead and copy-hotlead-hold30m continue steady accretion:** hotlead +72 trades, net +1.316, drop3 +1.316. hold30m +56 trades, net +1.859, drop3 +1.859. Both absorbing the tape swings well.
- **Pending kills partially recovering on today's tape — gates still fail:** copy-hotlead-ctrl net −2.835→+0.011 (+2.846 on good tape), but drop3 still −2.697. copy-hotlead-cap net −3.344→−1.371 (+1.973), drop3 still −3.774. copy-elitelead-ctrl net −3.184→−1.287 (was catastrophic, no longer; n=93, not yet at n=100). Today's numbers make these look less dire but none have escaped their structural negative drop3 at n≥100.
- **copy-hotlead-ratchet-trailtp added 46 trades in one day** (n=17→63): net +0.572, but drop3 worsened (−1.005→−1.905). Volume is arriving fast but the tail is concentrating, not dispersing.
- **Trailtp family big score jumps:** copy-hotlead-trailtp-wide 23→63.4, hold30m-trailtp-wide 25→58.4, hold30m-ratchet-trailtp 25→52.9. All have positive net and stress on today's strong tape, but drop3 remains negative everywhere (n<100, too early).
- **copy-conviction-consensus2 appeared:** n=929, net=+16.808, drop3=+4.021, realistic_execution=False. The idealized mirror. Both realistic twins (copy-consensus2-lag, killed 2026-06-17; copy-consensus2-lag-drift5, killed 2026-06-20 at drop3=−0.81) have already been tried and are invalid. copy-consensus2-elite (realistic, n=147, promotable) is the current live test of this signal. No new strategy warranted.
- **Retired_summary unchanged:** n=16367, net=−95.47. None of the 4 pending kills (copy-hotlead-deep, copy-hotlead-ctrl, copy-hotlead-hold30m-live-micro, copy-hotlead-cap) have been enacted by the operator. They remain consuming slots and capital.
- **Leads:** 143→148 leads (+5), 41→42 hot (+1), 65→68 cold (+3). Marginal pool growth; cold count growing faster than hot (ratio slightly weakening).
- **n_promotable_realistic: 4→5** (copy-elitelead restored).

**Week-over-week (Jun 20→26):**
- Regime arc this week: 6 (Jun 20) → 3 (Jun 21) → 8 (Jun 22 peak) → poor stretch (Jun 23-25, scores 2-3) → 5 today. The week had a sharp mid-week peak followed by a 3-day crash and now a partial recovery. Volatility is extremely high (book range: +31.77 to −40.84 SOL on individual days).
- **Converging (realistic):** copy-hotlead-strict is the week's clear winner — drop3 grew from ~+0.495 (Jun 24) to +1.703 (Jun 25) to +4.547 today, all while the tape was either poor or recovering. This is regime-robust evidence of a real filter. copy-hotlead and copy-hotlead-hold30m are steady accreters with large drop3 cushions (7.49 and 6.43 SOL respectively).
- **Volatile but recovering (realistic):** copy-elitelead experienced a sign-flip cycle: positive (pre-Jun 25) → negative Jun 25 → positive again today. This is a fragile candidate — drop3=+0.761 is a thin cushion. One more bad day would flip it again. Monitor closely.
- **Structurally negative (realistic):** copy-hotlead-consensus has had negative drop3 for 2 consecutive days (Jun 25: −0.759, Jun 26: −0.591). Still improving marginally today but has never recovered its original drop3 buffer since it turned negative.
- **Strengthening kill case:** copy-hotlead-deep negative drop3 for 4+ consecutive days (Jun 22 was the last positive reading). copy-hotlead-ctrl, copy-hotlead-cap: n≥100 with consistently negative drop3; today's tape improvement did NOT flip drop3 positive. These are structurally bad.
- **Lead pool:** hot leads grew from ~37 (Jun 20) to 42 today (+5). cold leads grew from 48→68 (+20 over the week). Pool is deepening but the cold proportion is rising — new leads being onboarded haven't proven themselves. The hot-to-cold ratio is weakening.
- **Macro BTC:** 7d pct has deteriorated all week (score ranged 4-6, now 5). The daily bounce today (+2.15%) is not yet a trend reversal.

**Verdicts (proposals — roster changes require operator approval + code edit to `COPY_STRATEGIES`):**

- **PROMOTE (5 strategies — all gates clear, all pending for multiple sessions):**
  - copy-hotlead — n=691, net=+14.07, drop3=+7.49, stress=+6.68, monthly=+30.16 SOL. Score 100. Has been on the promote list for 7+ sessions. **Most urgent live-micro candidate.**
  - copy-hotlead-hold30m — n=651, net=+30.41, drop3=+6.43, stress=+23.10, monthly=+76.03 SOL. Score 100. Highest monthly rate in the roster.
  - copy-hotlead-strict — n=390, net=+11.13, drop3=+4.55, stress=+6.89, monthly=+30.35 SOL. Score 100. Strong regime-robust performance this week confirms real filter signal.
  - copy-consensus2-elite — n=147, net=+3.84, drop3=+0.99, stress=+2.25, monthly=+11.51 SOL. Score 87.3. Thin drop3 cushion (+0.987) — give one more week to build buffer before promoting.
  - copy-elitelead — n=257, net=+4.30, drop3=+0.76, stress=+1.57, monthly=+12.90 SOL. Score 80.2. **Restored today after yesterday's sign-flip.** Drop3 cushion is thin (+0.761) — promote only after another 1-2 sessions confirm stability.

- **KILL (4 strategies — n≥100, gates fail, operator action still pending):**
  - copy-hotlead-deep — n=509, drop3=−0.900 (negative for 4+ consecutive days); net positive (+5.68) but the edge is concentrated in top trades. n≥100, drop3≤0 gate fails. **Recommend kill.**
  - copy-hotlead-ctrl — n=158, net=+0.011, drop3=−2.697. Net barely positive today (good tape one-day effect), but structural robustness gate fails at n≥100 with drop3 deeply negative. **Recommend kill.**
  - copy-hotlead-hold30m-live-micro — n=145, net=−0.015, drop3=−0.721. Near-breakeven net but drop3≤0 at n≥100. **Recommend kill.**
  - copy-hotlead-cap — n=144, net=−1.371, drop3=−3.774. Fails all gates including net<0. **Recommend kill.**

- **WATCH (downgrade from kill, one more cycle):**
  - copy-elitelead-ctrl — n=93, net=−1.287 (was catastrophic at −3.184 yesterday; recovered +1.897 on today's tape). Catastrophic criterion no longer applies. n<100, so the n≥100 drop3 kill gate hasn't triggered yet. Drop3=−3.962 is deeply negative — expect KILL verdict at n=100 unless tape recovers the entire deficit. Keep on watch; do not kill before n=100 given the small-n rule.
  - copy-hotlead-consensus — n=309, drop3=−0.591 (2nd consecutive day negative). Not yet a multi-day confirmed kill by the "multi-day consecutive" rule in prior sessions, but the trend is clear. Recommend KILL next session if drop3 stays negative.
  - copy-hotlead-hold30m-pair-shadow — n=145, drop3=−0.262 at n≥100. Stress still positive (+0.762). Borderline — watch one more cycle.
  - Trailtp family (n=63-75): positive net on today's good tape, but drop3 universally negative and n<100. Keep cooking; re-evaluate after n=100.
  - Cap/ctrl secondary family (consensus-cap/ctrl, elitelead-cap, n=72-73): all negative, approaching catastrophic in some cases. Watch through n=100 or until catastrophic criterion triggers.
  - copy-cons2elite-trailtp family (n=19): too early, poor tape environment for recent entries. Watch.
  - copy-3eg1-* (n=0, 2611 wallet_allowlist skips): still gate-starved. The wallet allowlist appears to be blocking all events. This needs an operator code investigation — if the allowlisted wallets are inactive, the entire family will never trade. Flag for code review.

**New strategies to try:** None proposed this cycle. Both realistic consensus2 twins (copy-consensus2-lag, copy-consensus2-lag-drift5) were tried and killed in June at drop3≤0 — the copy-conviction-consensus2 idealized mirror's strong numbers (+16.808 SOL, n=929) are encouraging but the research arm is already covered by copy-consensus2-elite (the realistic elite-gated version, currently promotable). With 4 confirmed kills pending enactment, 5 promotable strategies awaiting deployment, and multiple experiments in flight, adding more surface area would increase noise.

**Operator next step:** Enact 4 pending kills (copy-hotlead-deep, copy-hotlead-ctrl, copy-hotlead-hold30m-live-micro, copy-hotlead-cap) via a single COPY_STRATEGIES code edit — these are confirmed invalid at n≥100 and are blocking capital/slots. Then approve copy-hotlead or copy-hotlead-hold30m for the first live-micro promotion (both score=100, pending for 7+ sessions). If enacting the live-micro test of hold30m is already in flight via copy-hotlead-hold30m-live-micro, note that this strategy's kill removes it — the live-micro test effectively failed at net=−0.015 and drop3=−0.721.

---

## 2026-06-25

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-06-25",
  "overall": {"n": 6192, "net": 35.41, "drop3": 11.43, "stress": -26.71, "open": 136},
  "retired_summary": {"n": 16367, "net": -95.47},
  "regime_score": 2, "regime_24h": 1, "macro_score": 6, "btc_7d_pct": -1.74,
  "book_daily_today": -8.47,
  "leads": {"n_leads": 143, "hot": 41, "cold": 65},
  "n_promotable_realistic": 4,
  "strategies": [
    {"id": "copy-hotlead",                       "realistic": true,  "n": 619, "net": 12.758, "drop3":  6.177, "stress":  6.127, "promo_score": 100, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-hold30m",               "realistic": true,  "n": 595, "net": 28.551, "drop3":  4.566, "stress": 21.851, "promo_score": 100, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-strict",                "realistic": true,  "n": 352, "net":  8.285, "drop3":  1.703, "stress":  4.494, "promo_score":  96, "verdict": "PROMOTE"},
    {"id": "copy-consensus2-elite",              "realistic": true,  "n": 134, "net":  3.877, "drop3":  1.061, "stress":  2.419, "promo_score":  88, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-consensus",             "realistic": true,  "n": 284, "net":  5.681, "drop3": -0.759, "stress":  2.642, "promo_score":  75, "verdict": "WATCH"},
    {"id": "copy-elitelead",                     "realistic": true,  "n": 228, "net":  3.292, "drop3": -0.246, "stress":  0.878, "promo_score":  63, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-pair-shadow",   "realistic": true,  "n": 108, "net":  0.543, "drop3": -0.567, "stress":  0.421, "promo_score":  59, "verdict": "WATCH"},
    {"id": "copy-hotlead-deep",                  "realistic": true,  "n": 444, "net":  4.967, "drop3": -1.616, "stress":  0.294, "promo_score":  57, "verdict": "KILL"},
    {"id": "copy-hotlead-ratchet-trailtp",       "realistic": true,  "n":  17, "net":  0.509, "drop3": -1.005, "stress":  0.324, "promo_score":  41, "verdict": "WATCH"},
    {"id": "copy-hotlead-ctrl",                  "realistic": true,  "n": 112, "net": -2.835, "drop3": -5.350, "stress": -3.932, "promo_score":  40, "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-live-micro",    "realistic": true,  "n": 108, "net": -0.295, "drop3": -0.915, "stress": -0.155, "promo_score":  40, "verdict": "KILL"},
    {"id": "copy-hotlead-cap",                   "realistic": true,  "n":  98, "net": -3.344, "drop3": -5.363, "stress": -4.287, "promo_score":  39, "verdict": "KILL"},
    {"id": "copy-elitelead-ctrl",                "realistic": true,  "n":  67, "net": -3.184, "drop3": -5.416, "stress": -3.811, "promo_score":  33, "verdict": "KILL"},
    {"id": "copy-hotlead-consensus-cap",         "realistic": true,  "n":  56, "net": -1.426, "drop3": -3.563, "stress": -1.975, "promo_score":  31, "verdict": "WATCH"},
    {"id": "copy-hotlead-consensus-ctrl",        "realistic": true,  "n":  55, "net": -2.084, "drop3": -4.221, "stress": -2.609, "promo_score":  31, "verdict": "WATCH"},
    {"id": "copy-elitelead-cap",                 "realistic": true,  "n":  45, "net": -2.856, "drop3": -4.472, "stress": -3.263, "promo_score":  29, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-scaleout-trailtp","realistic": true,"n":  26, "net": -0.462, "drop3": -1.460, "stress": -0.674, "promo_score":  25, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-ratchet-trailtp","realistic": true, "n":  26, "net": -0.186, "drop3": -1.357, "stress": -0.450, "promo_score":  25, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-trailtp-wide",  "realistic": true,  "n":  25, "net": -0.557, "drop3": -1.729, "stress": -0.803, "promo_score":  25, "verdict": "WATCH"},
    {"id": "copy-hotlead-scaleout-trailtp",      "realistic": true,  "n":  19, "net": -0.750, "drop3": -2.149, "stress": -0.876, "promo_score":  23, "verdict": "WATCH"},
    {"id": "copy-hotlead-trailtp-wide",          "realistic": true,  "n":  15, "net": -0.812, "drop3": -2.212, "stress": -0.951, "promo_score":  23, "verdict": "WATCH"},
    {"id": "copy-cons2elite-ratchet-trailtp",    "realistic": true,  "n":   7, "net": -0.875, "drop3": -0.909, "stress": -0.930, "promo_score":  21, "verdict": "WATCH"},
    {"id": "copy-cons2elite-scaleout-trailtp",   "realistic": true,  "n":   6, "net": -1.062, "drop3": -0.909, "stress": -1.087, "promo_score":  21, "verdict": "WATCH"},
    {"id": "copy-cons2elite-trailtp-wide",       "realistic": true,  "n":   6, "net": -1.055, "drop3": -0.909, "stress": -1.096, "promo_score":  21, "verdict": "WATCH"},
    {"id": "copy-3eg1-follow",                   "realistic": true,  "n":   0, "net":  0.000, "drop3":  0.000, "stress":  0.000, "promo_score":  20, "verdict": "WATCH"},
    {"id": "copy-3eg1-runner",                   "realistic": true,  "n":   0, "net":  0.000, "drop3":  0.000, "stress":  0.000, "promo_score":  20, "verdict": "WATCH"},
    {"id": "copy-3eg1-tp100",                    "realistic": true,  "n":   0, "net":  0.000, "drop3":  0.000, "stress":  0.000, "promo_score":  20, "verdict": "WATCH"}
  ]
}
```

**Headline:** Regime stays in "poor" (score=2) for a third consecutive day; copy-elitelead and copy-hotlead-consensus both have their drop3 sign-flip today; 5 strategies now qualify for kill while copy-hotlead-strict is the lone bright spot (+15 promo-score, drop3 +0.495→+1.703 during bad tape).

**Day-over-day (vs 2026-06-24):**
- Regime: 1→2 (still poor), 24h trailing=1. Book −8.47 SOL today (partial, as of ~10:00 UTC). Three consecutive losing days: Jun 23 −12.40, Jun 24 −56.71, Jun 25 partial −8.47.
- Macro: BTC score 5→6 ("tailwind"). BTC had a +3.33% day but 7d still −1.74%; F&G=12 (extreme fear). A daily bounce inside a weak week — not a regime recovery.
- **c2rr family kill enacted:** The entire c2rr block (10 strategies, ~2274 trades) disappeared from active and moved to retired. Retired_summary jumped from n=14093 to n=16367. Well done.
- **2 new drop3 SIGN FLIPs:**
  - copy-hotlead-consensus: drop3 +0.061→**−0.759** (Δ−0.820 in 23 trades). Now fails gate at n=284.
  - copy-elitelead: drop3 +1.367→**−0.246** (Δ−1.613 in 36 trades, Δscore −28). Was scored 92.1/PROMOTE yesterday, now 63/fails.
- **copy-hotlead-strict GAINS robustness:** drop3 +0.495→**+1.703** (Δ+1.208 in 55 trades), score 81→96. The only realistic strategy improving through poor tape. Its stricter filter appears to be screening out bad-regime entries better than the base hotlead.
- **Promotable count drops: 6→4.** copy-elitelead and copy-hotlead-consensus lost the drop3 gate.
- **copy-hotlead-ctrl crosses n=100 with all gates negative:** n=112, net=−2.835, drop3=−5.350, stress=−3.932. Full kill qualification reached.
- **copy-hotlead-hold30m-live-micro crosses n=100 with all gates negative:** n=108, net=−0.295, drop3=−0.915, stress=−0.155. Full kill qualification reached.
- **copy-hotlead-cap approaches catastrophic threshold:** n=98, net=−3.344 (net<−3 at n≥40 → catastrophic kill criterion met).
- **copy-elitelead-ctrl catastrophic threshold crossed:** n=67, net=−3.184 (net<−3 at n≥40 → kill).
- **New trailtp family appeared:** copy-hotlead-ratchet-trailtp (n=17), copy-hotlead-scaleout-trailtp (n=19), copy-hotlead-trailtp-wide (n=15), copy-hotlead-hold30m-{ratchet,scaleout,trailtp-wide} (n=25-26), copy-cons2elite-{ratchet,scaleout,trailtp-wide} (n=6-7). All negative at small n — too early to judge; poor regime is expected headwind.
- **3eg1 family still gate-starved:** n=0 with 2152 wallet_allowlist skips. 100% of events are blocked by the allowlist — the wallets on the list may be inactive. Investigate before concluding the signal is bad.
- **Lead pool:** 138→143 leads (+5), 40→41 hot, 62→65 cold. Marginal improvement in pool depth.

**Week-over-week (Jun 17→25):**
- Regime arc: 2→5→4→6→3→8 (peak Jun 22)→1→2. The week had a strong mid-section (Jun 20-22, regime 6-8) followed by a hard crash (Jun 23-25, regime 1-2). The current poor stretch is now 3 days old.
- Book daily pattern: mostly positive Jun 17-22 (+23.38, −11.42, +2.64, +16.27, +4.58, +27.93), then crash Jun 23-25 (−12.40, −56.71, −8.47 partial). Cumulative book swing of ~−77 SOL in 3 days after the peak. The Jun 22 surge was partially a one-day lottery event.
- Macro BTC: ranged 4-8 this week, peaked at 8 on Jun 15 (before our tracking window), settling to 2-5 in the crash days (Jun 23-24), now recovering to 6. No sustained macro tailwind.
- **Converging (realistic):** copy-hotlead-strict is the week's surprise — promo score has climbed from ~75 (Jun 18 estimate) to 96 today while tape was poor. Suggests the strict filter genuinely screens bad entries.
- **Decaying (realistic):** copy-elitelead (score 92→63, drop3 sign-flip), copy-hotlead-consensus (borderline all week, now failed). Both were fragile candidates that poor regime has eliminated.
- **Steady (realistic):** copy-hotlead and copy-hotlead-hold30m remain at score=100 despite drop3 erosion — their cushions (6.2 and 4.6 SOL respectively) are large enough to survive the current stretch.
- Lead pool: hot leads grew from 26 to 41 over the week (+15), pool depth from 65 to 143. Pool is healthier now than at the start of the week. Cold count also grew (39→65) — new leads being added that haven't proven themselves yet.
- **Strengthening kill case:** copy-hotlead-deep has had negative drop3 for 2 consecutive days (Jun 24: −0.446, Jun 25: −1.616) — multi-day confirmation met.

**Verdicts (proposals — roster changes require operator approval + code edit to `COPY_STRATEGIES`):**

- **PROMOTE:** copy-hotlead (score=100, n=619, drop3=+6.18, monthly=+29 SOL), copy-hotlead-hold30m (score=100, n=595, drop3=+4.57, monthly=+78 SOL), copy-hotlead-strict (score=96, n=352, drop3=+1.70, monthly=+25 SOL), copy-consensus2-elite (score=88, n=134, drop3=+1.06, monthly=+13 SOL). All four have been recommended for multiple consecutive days — awaiting operator action.
- **KILL (5 strategies, code edit required):**
  - copy-hotlead-deep: n=444, drop3=−1.616 (negative for 2 consecutive days, multi-day confirmed); net positive but robustness gate fails.
  - copy-hotlead-ctrl: n=112, net=−2.835, drop3=−5.350, stress=−3.932 — all three gates fail at n≥100.
  - copy-hotlead-hold30m-live-micro: n=108, net=−0.295, drop3=−0.915, stress=−0.155 — all gates fail at n≥100.
  - copy-hotlead-cap: n=98, net=−3.344 — catastrophic (net<−3 at n≥40); all gates fail.
  - copy-elitelead-ctrl: n=67, net=−3.184 — catastrophic (net<−3 at n≥40); all gates fail.
- **WATCH (one more cycle before kill decision):**
  - copy-hotlead-consensus: n=284, drop3=−0.759 (first day negative — single-day flip in poor regime; will confirm kill next cycle if still negative).
  - copy-elitelead: n=228, drop3=−0.246 (first day negative, was +1.367 yesterday — marginal, give one cycle).
  - copy-hotlead-hold30m-pair-shadow: n=108, drop3=−0.567 but net positive (+0.543) and stress positive; lottery-shaped, not catastrophic — watch.
  - copy-elitelead-cap: n=45, net=−2.856 — approaching catastrophic threshold; watch one cycle.
  - copy-hotlead-consensus-cap/ctrl: n=55-56, both negative but n<100 — watch.
  - New trailtp family (n=6-26): Too early; poor regime makes early numbers unreliable.
  - copy-3eg1-*: n=0, 100% gate-starved by wallet_allowlist (2152 skips). Investigate whether the allowlist wallets are still active before any verdict.

**New strategies to try:** None proposed this cycle. The roster has 5 pending kills, 4 pending promotions, and several experiments in flight. Priority is clearing the backlog rather than adding surface area. Revisit once regime recovers and pending kills are enacted.

**Operator next step:** Enact 5 kills (copy-hotlead-deep, copy-hotlead-ctrl, copy-hotlead-hold30m-live-micro, copy-hotlead-cap, copy-elitelead-ctrl) — these are confirmed kills, code edit to `COPY_STRATEGIES`. Then consider promoting copy-hotlead and copy-hotlead-hold30m to live-micro (both score=100, waiting multiple days). Investigate copy-3eg1 wallet_allowlist gate-starve as a background task.

---

## 2026-06-24

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-06-24",
  "overall": {"n": 7155, "net": 92.95, "drop3": 58.14, "stress": 20.17, "open": 129},
  "retired_summary": {"n": 14093, "net": -117.61},
  "regime_score": 1, "regime_24h": 7, "macro_score": 5, "btc_7d_pct": -2.39,
  "book_daily_today": -29.78,
  "leads": {"n_leads": 138, "hot": 40, "cold": 62},
  "n_promotable_realistic": 6,
  "strategies": [
    {"id": "copy-hotlead",                   "realistic": true,  "n": 533, "net": 14.555, "drop3":  7.974, "stress":  8.774, "promo_score": 100.0, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-hold30m",            "realistic": true,  "n": 515, "net": 31.143, "drop3":  7.158, "stress": 25.215, "promo_score": 100.0, "verdict": "PROMOTE"},
    {"id": "copy-consensus2-elite",           "realistic": true,  "n": 116, "net":  5.428, "drop3":  2.611, "stress":  4.124, "promo_score": 100.0, "verdict": "PROMOTE"},
    {"id": "copy-elitelead",                  "realistic": true,  "n": 192, "net":  4.711, "drop3":  1.367, "stress":  2.639, "promo_score":  92.1, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-strict",             "realistic": true,  "n": 297, "net":  7.078, "drop3":  0.495, "stress":  3.877, "promo_score":  81.2, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-consensus",          "realistic": true,  "n": 261, "net":  6.501, "drop3":  0.061, "stress":  3.683, "promo_score":  75.8, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-deep",               "realistic": true,  "n": 370, "net":  6.137, "drop3": -0.446, "stress":  2.203, "promo_score":  75.0, "verdict": "KILL"},
    {"id": "copy-c2rr-ratchet-run",           "realistic": true,  "n": 200, "net":  8.586, "drop3":-13.203, "stress":  6.354, "promo_score":  75.0, "verdict": "KILL"},
    {"id": "copy-c2rr-trailtp-wide",          "realistic": true,  "n": 168, "net":  7.346, "drop3": -4.124, "stress":  5.469, "promo_score":  75.0, "verdict": "KILL"},
    {"id": "copy-c2rr-ratchet-trailtp",       "realistic": true,  "n": 183, "net":  7.291, "drop3": -4.179, "stress":  5.260, "promo_score":  75.0, "verdict": "KILL"},
    {"id": "copy-c2rr-scaleout-trailtp",      "realistic": true,  "n": 157, "net":  3.919, "drop3": -2.001, "stress":  2.803, "promo_score":  75.0, "verdict": "KILL"},
    {"id": "copy-c2rr-scaleout-run",          "realistic": true,  "n": 143, "net":  1.665, "drop3":-10.046, "stress":  0.637, "promo_score":  61.4, "verdict": "KILL"},
    {"id": "copy-c2rr-trailtp-tight",         "realistic": true,  "n": 211, "net":  2.872, "drop3": -3.309, "stress":  0.641, "promo_score":  61.4, "verdict": "KILL"},
    {"id": "copy-c2rr-ratchet-tp",            "realistic": true,  "n": 265, "net":  1.183, "drop3": -3.023, "stress": -1.570, "promo_score":  55.0, "verdict": "KILL"},
    {"id": "copy-c2rr-scaleout-50",           "realistic": true,  "n": 185, "net":  0.775, "drop3": -2.214, "stress": -0.488, "promo_score":  55.0, "verdict": "KILL"},
    {"id": "copy-c2rr-control",               "realistic": true,  "n": 230, "net": -2.645, "drop3": -7.237, "stress": -4.961, "promo_score":  40.0, "verdict": "KILL"},
    {"id": "copy-c2rr-breakeven",             "realistic": true,  "n": 252, "net": -1.079, "drop3": -4.941, "stress": -3.653, "promo_score":  40.0, "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-pair-shadow","realistic": true,  "n":  54, "net":  0.745, "drop3": -0.365, "stress":  0.675, "promo_score":  52.5, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-live-micro", "realistic": true,  "n":  54, "net":  0.130, "drop3": -0.491, "stress":  0.129, "promo_score":  39.9, "verdict": "WATCH"},
    {"id": "copy-hotlead-cap",                "realistic": true,  "n":  57, "net": -0.842, "drop3": -2.860, "stress": -1.412, "promo_score":  31.4, "verdict": "WATCH"},
    {"id": "copy-hotlead-ctrl",               "realistic": true,  "n":  54, "net": -1.250, "drop3": -3.268, "stress": -1.781, "promo_score":  30.8, "verdict": "WATCH"},
    {"id": "copy-hotlead-consensus-cap",      "realistic": true,  "n":  36, "net": -0.962, "drop3": -3.100, "stress": -1.314, "promo_score":  27.2, "verdict": "WATCH"},
    {"id": "copy-elitelead-cap",              "realistic": true,  "n":  35, "net": -1.658, "drop3": -3.274, "stress": -1.986, "promo_score":  27.0, "verdict": "WATCH"},
    {"id": "copy-hotlead-consensus-ctrl",     "realistic": true,  "n":  35, "net": -1.620, "drop3": -3.757, "stress": -1.948, "promo_score":  27.0, "verdict": "WATCH"},
    {"id": "copy-elitelead-ctrl",             "realistic": true,  "n":  34, "net": -1.384, "drop3": -3.000, "stress": -1.707, "promo_score":  26.8, "verdict": "WATCH"},
    {"id": "copy-3eg1-follow",                "realistic": true,  "n":   0, "net":  0.000, "drop3":  0.000, "stress":  0.000, "promo_score":  20.0, "verdict": "WATCH"},
    {"id": "copy-3eg1-runner",                "realistic": true,  "n":   0, "net":  0.000, "drop3":  0.000, "stress":  0.000, "promo_score":  20.0, "verdict": "WATCH"},
    {"id": "copy-3eg1-tp100",                 "realistic": true,  "n":   0, "net":  0.000, "drop3":  0.000, "stress":  0.000, "promo_score":  20.0, "verdict": "WATCH"}
  ]
}
```

**Headline:** Regime crashes from 8→1 (poor tape); book −29.78 SOL today (partial, as of 10:01 UTC); copy-hotlead-deep drops3 sign-flips (−0.446) after being promotable two days ago; the entire c2rr family (10 strategies) is now validated-negative at n≥100 and qualifies for mass kill.

**Day-over-day (vs 2026-06-22 — no 2026-06-23 entry was written):**
- Regime: 8 (strong) → 1 (poor). The 24h trailing score is still 7, confirming the crash is intraday today. book_net_6h = −27.00 SOL; only copy-hotlead-hold30m is green today (+5.12 SOL), every other strategy losing.
- Macro: BTC score 4 → 5 (neutral), BTC 1d +0.41%, but 7d −2.39% and fear & greed at 17 (extreme fear). Slight daily bounce in a weak-week context.
- Book daily: Jun 22 +39.78 → Jun 23 −12.40 → Jun 24 −29.78 (partial). Two consecutive bad days after the Jun 22 surge.
- **copy-hotlead-deep drop3 SIGN FLIP:** n=189→370 (+181 trades), drop3 went +5.634 → **−0.446**. Was score 100/PROMOTE, now score 75/fails drop3. Net still +6.137 and stress still +2.203, but the robustness gate fails. The regression is driven by 2 days of losing trades in a poor regime eroding the cushion from Jun 17–18's exceptional trades.
- **copy-consensus2-elite NEWLY PROMOTABLE:** n=72→116 (+44 trades), drop3 +2.594 → +2.611. All four gates now clear (n≥100, drop3>0, stress>0, monthly +20.35 SOL/mo).
- **copy-hotlead drop3 erosion:** n=304→533, drop3 +11.983 → +7.974. Still strong, but losing ~1.5 SOL per 100 trades in the current regime.
- **copy-hotlead-strict drop3 erosion:** n=149→297, drop3 +6.077 → **+0.495**. Still passes but now fragile — two bad days would flip it.
- **copy-hotlead-consensus drop3 erosion:** n=165→261, drop3 +5.977 → **+0.061**. Hair-thin; a single bad day flips it.
- **copy-hotlead-hold30m strengthening:** n=281→515, drop3 +4.607 → +7.158. The only strategy improving robustness in this tape.
- **Roster changes enacted by operator since Jun 22:**
  - *Removed:* copy-hotlead-deep-live-micro (was n=64, mildly negative); copy-fatwallet-* (all 5 variants, too early/negative).
  - *Added:* copy-hotlead-cap (n=57), copy-hotlead-ctrl (n=54) — exit cap/control experiment; copy-hotlead-consensus-cap, copy-hotlead-consensus-ctrl, copy-elitelead-cap, copy-elitelead-ctrl (n=34-36 each) — same dimension applied to other lead gates; copy-hotlead-hold30m-live-micro (n=54, new live-micro test); copy-hotlead-hold30m-pair-shadow (n=54); copy-3eg1-follow, copy-3eg1-runner, copy-3eg1-tp100 (n=0, brand new family).
  - *Not yet enacted from prior proposals:* copy-c2rr-ratchet-run kill (still running at n=200); none of the 6 promotable strategies promoted to live yet.

**Week-over-week (2026-06-17 → 2026-06-24):**
- *Convergence:* copy-consensus2-elite crossed n=100 today (score 79→94.4→100, now fully promotable). copy-hotlead-hold30m is the strongest strategy in the roster (monthly +93 SOL/mo, drop3 improving).
- *Decay:* copy-hotlead-deep is the biggest regression story — was a PROMOTE candidate Jun 22, now fails drop3. copy-hotlead-strict and copy-hotlead-consensus have shed most of their drop3 buffer in 2 days of poor tape; they're still technically passing but fragile. The entire c2rr family has been uniformly negative every day this week — the family was optimistic at low n but failed robustness checks as trades accumulated.
- *Regime:* Extremely volatile all week (swing scores: 3→−12.62 / 8→+39.78 / poor→−12.40 / 1→−29.78). The Jun 22 +39.78 SOL day was the single best day on record; the following two days gave back most of it. Mean daily P&L = −3.75 SOL, std = 30.14 — very high variance.
- *BTC/macro:* BTC 7d pct deteriorated steadily week-over-week (scores: 6→6→7→6→8→6→5→4→5→5→5→4→2→5). BTC dropped from $66K+ to $62.5K over the week. Fear & greed at 17 (extreme fear) signals risk-off environment.
- *Lead pool:* n_hot 37 (Jun 21) → 41 (Jun 22) → 40 (Jun 24). Hot leads slightly lower today; n_cold 48→52→62 (increasing cold leads). The ratio is weakening day-over-day — lead quality may be deteriorating in this regime.
- *c2rr mass kill:* Every c2rr strategy that has hit n≥100 has a negative drop3. No exception. The entire family thesis (c2rr = c2 filter + ratchet/trailing exits) appears structurally lottery-shaped: the apparent P&L in each is concentrated in 1-3 exceptional trades. The family should be fully retired.

**Verdicts (proposals — roster changes require operator approval + code edit to COPY_STRATEGIES):**

- **PROMOTE (6):**
  - copy-hotlead — n=533, net=+14.55, drop3=+7.97, stress=+8.77, monthly=+36.4 SOL/mo. Score 100. Has been on the promote list for 6+ sessions with no action. **Recommend as the first live slot.**
  - copy-hotlead-hold30m — n=515, net=+31.14, drop3=+7.16, stress=+25.22, monthly=+93.4 SOL/mo. Score 100. Strongest monthly rate in the roster. Live-micro test running at n=54 (copy-hotlead-hold30m-live-micro, net=+0.13).
  - copy-consensus2-elite — n=116, net=+5.43, drop3=+2.61, stress=+4.12, monthly=+20.4 SOL/mo. Score 100. **Newly promotable today** (crossed n=100 gate). All gates clear.
  - copy-elitelead — n=192, net=+4.71, drop3=+1.37, stress=+2.64, monthly=+17.7 SOL/mo. Score 92.1.
  - copy-hotlead-strict — n=297, net=+7.08, drop3=+0.495, stress=+3.88, monthly=+23.6 SOL/mo. Score 81.2. **FRAGILE** — drop3 eroded from +6.08 to +0.50 in 2 days; one more bad stretch could flip it.
  - copy-hotlead-consensus — n=261, net=+6.50, drop3=+0.061, stress=+3.68, monthly=+19.5 SOL/mo. Score 75.8. **HAIR-THIN** — drop3 barely positive; effectively 1 bad trade from failing the gate. Promote-pending but risky to deploy now.

- **KILL (11 strategies — propose mass code cleanup):**
  - copy-hotlead-deep — n=370, drop3=−0.446. Drop3 sign-flipped from +5.634 two days ago. Net still positive (+6.14) and stress positive (+2.20), but the drop3 gate fails at n=370. The edge is now concentrated in 3 outlier trades. Regression is likely regime-driven but the rule is clear. If the operator wants to track recovery, a WATCH extension is an option — but per the kill criterion (n≥100 AND drop3≤0), this is a KILL.
  - copy-c2rr-ratchet-run — n=200, net=+8.59, drop3=**−13.20**. The entire gain is in top-3 trades. On the kill list since Jun 22; still not enacted. Worst drop3 in the roster.
  - copy-c2rr-trailtp-wide — n=168, drop3=−4.12. n≥100, drop3<0.
  - copy-c2rr-ratchet-trailtp — n=183, drop3=−4.18. n≥100, drop3<0.
  - copy-c2rr-scaleout-trailtp — n=157, drop3=−2.00. n≥100, drop3<0.
  - copy-c2rr-scaleout-run — n=143, drop3=−10.05. n≥100, drop3<0.
  - copy-c2rr-trailtp-tight — n=211, drop3=−3.31. n≥100, drop3<0.
  - copy-c2rr-ratchet-tp — n=265, drop3=−3.02, stress=−1.57. n≥100, drop3<0 AND stress<0.
  - copy-c2rr-scaleout-50 — n=185, drop3=−2.21, stress=−0.49. Drop3 was barely +0.076 on Jun 22; now negative. n≥100, drop3<0.
  - copy-c2rr-control — n=230, net=**−2.65**, drop3=−7.24, stress=−4.96, monthly=−13.2 SOL/mo. Fails all gates including net<0.
  - copy-c2rr-breakeven — n=252, net=**−1.08**, drop3=−4.94, stress=−3.65, monthly=−5.4 SOL/mo. Fails all gates including net<0.

- **WATCH (11 strategies — all too early or gate-starved):**
  - copy-hotlead-hold30m-live-micro — n=54, net=+0.13. Live micro test running; too early. Mirror of the PROMOTE candidate; keep watching.
  - copy-hotlead-hold30m-pair-shadow — n=54, net=+0.75. Shadow comparison; too early.
  - copy-hotlead-cap / copy-hotlead-ctrl — n=57/54, net=−0.84/−1.25. New cap/ctrl exit experiment; uniformly negative but n<100 and not catastrophic (net>−3 at n<40 rule). Watch through n=100.
  - copy-hotlead-consensus-cap / copy-hotlead-consensus-ctrl — n=36/35, early negative. Watch.
  - copy-elitelead-cap / copy-elitelead-ctrl — n=35/34, early negative. Watch.
  - copy-3eg1-follow / copy-3eg1-runner / copy-3eg1-tp100 — n=0, brand new. No action.

**New strategies to try:** None proposed this cycle. The bottleneck is kill/promote execution, not idea generation. With 11 strategies pending kill (code edits), 6 pending promotion decisions, and 11 new strategies already cooking, adding more would only increase noise.

**Operator next step:** Enact the c2rr mass kill (10 strategies + copy-hotlead-deep) via a single COPY_STRATEGIES code edit + push — these are all validated-negative and are consuming slots and capital. Then approve the first live promotion for copy-hotlead (has been pending for 6+ sessions). The cap/ctrl experiment (6 strategies) needs to run to n≥100 before a verdict; do not kill yet.

---

## 2026-06-22

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-06-22",
  "overall": {"n": 8916, "net": 138.23, "drop3": 86.10, "stress": 45.13, "open": 229},
  "retired_summary": {"n": 7845, "net": -132.55},
  "regime_score": 8, "regime_24h": 2, "macro_score": 4, "btc_7d_pct": -3.63,
  "book_daily_today": 27.93,
  "leads": {"n_leads": 127, "hot": 41, "cold": 52},
  "n_promotable_realistic": 6,
  "strategies": [
    {"id": "copy-hotlead",               "realistic": true,  "n": 304, "net": 18.390, "drop3": 11.983, "stress": 14.890, "promo_score": 100,  "verdict": "PROMOTE"},
    {"id": "copy-hotlead-hold30m",        "realistic": true,  "n": 281, "net": 23.522, "drop3":  4.607, "stress": 20.157, "promo_score": 100,  "verdict": "PROMOTE"},
    {"id": "copy-hotlead-deep",           "realistic": true,  "n": 189, "net": 11.984, "drop3":  5.634, "stress":  9.797, "promo_score": 100,  "verdict": "PROMOTE"},
    {"id": "copy-hotlead-strict",         "realistic": true,  "n": 149, "net": 12.427, "drop3":  6.077, "stress": 10.643, "promo_score": 100,  "verdict": "PROMOTE"},
    {"id": "copy-hotlead-consensus",      "realistic": true,  "n": 165, "net": 12.327, "drop3":  5.977, "stress": 10.381, "promo_score": 100,  "verdict": "PROMOTE"},
    {"id": "copy-elitelead",              "realistic": true,  "n": 108, "net":  7.348, "drop3":  4.518, "stress":  6.088, "promo_score": 100,  "verdict": "PROMOTE"},
    {"id": "copy-consensus2-elite",       "realistic": true,  "n":  72, "net":  5.410, "drop3":  2.594, "stress":  4.560, "promo_score":  94.4, "verdict": "KEEP"},
    {"id": "copy-c2rr-scaleout-50",       "realistic": true,  "n":  84, "net":  2.513, "drop3":  0.076, "stress":  1.923, "promo_score":  72.0, "verdict": "KEEP"},
    {"id": "copy-c2rr-ratchet-trailtp",   "realistic": true,  "n":  85, "net":  3.816, "drop3": -2.390, "stress":  2.865, "promo_score":  72.0, "verdict": "WATCH"},
    {"id": "copy-c2rr-trailtp-wide",      "realistic": true,  "n":  78, "net":  3.225, "drop3": -3.320, "stress":  2.357, "promo_score":  70.6, "verdict": "WATCH"},
    {"id": "copy-c2rr-scaleout-trailtp",  "realistic": true,  "n":  74, "net":  1.945, "drop3": -1.419, "stress":  1.430, "promo_score":  64.1, "verdict": "KEEP"},
    {"id": "copy-c2rr-breakeven",         "realistic": true,  "n": 114, "net":  2.030, "drop3": -0.084, "stress":  0.815, "promo_score":  63.1, "verdict": "WATCH"},
    {"id": "copy-c2rr-ratchet-tp",        "realistic": true,  "n": 121, "net":  1.733, "drop3": -0.884, "stress":  0.452, "promo_score":  59.5, "verdict": "WATCH"},
    {"id": "copy-c2rr-control",           "realistic": true,  "n": 102, "net":  1.197, "drop3": -1.805, "stress":  0.123, "promo_score":  56.2, "verdict": "WATCH"},
    {"id": "copy-c2rr-trailtp-tight",     "realistic": true,  "n": 104, "net": -0.383, "drop3": -2.277, "stress": -1.446, "promo_score":  40.0, "verdict": "WATCH"},
    {"id": "copy-c2rr-ratchet-run",       "realistic": true,  "n":  88, "net": -4.076, "drop3": -5.098, "stress": -4.901, "promo_score":  37.6, "verdict": "KILL"},
    {"id": "copy-c2rr-scaleout-run",      "realistic": true,  "n":  58, "net": -2.921, "drop3": -4.037, "stress": -3.238, "promo_score":  31.6, "verdict": "WATCH"},
    {"id": "copy-hotlead-deep-live-micro","realistic": true,  "n":  64, "net": -0.080, "drop3": -0.379, "stress": -0.066, "promo_score":  32.8, "verdict": "KEEP"},
    {"id": "copy-fatwallet-hightp",       "realistic": true,  "n":  12, "net": -0.563, "drop3": -0.579, "stress": -0.675, "promo_score":  22.4, "verdict": "WATCH"},
    {"id": "copy-fatwallet-tp100",        "realistic": true,  "n":  11, "net": -0.347, "drop3": -0.363, "stress": -0.453, "promo_score":  22.2, "verdict": "WATCH"},
    {"id": "copy-fatwallet-follow",       "realistic": true,  "n":  11, "net": -0.179, "drop3": -0.182, "stress": -0.289, "promo_score":  22.2, "verdict": "WATCH"},
    {"id": "copy-fatwallet-runner",       "realistic": true,  "n":  11, "net": -0.347, "drop3": -0.363, "stress": -0.453, "promo_score":  22.2, "verdict": "WATCH"},
    {"id": "copy-fatwallet-scaleout",     "realistic": true,  "n":  10, "net": -0.453, "drop3": -0.466, "stress": -0.547, "promo_score":  22.0, "verdict": "WATCH"}
  ]
}
```

**Headline:** copy-elitelead crosses n≥100 today (n=108, all gates clear) — six realistic strategies are now fully promotable; book surged +27.93 SOL as the copy-internal regime flipped to "strong" (score 8, up from 3 yesterday).

**Day-over-day (vs 2026-06-21):**
- Regime score: 3 → 8 (strong flip); book_net_6h=+36.23 SOL. The 24h lagging score only shows 2, confirming the recovery is recent.
- Macro: 5 → 4 (headwind). BTC 7d pct swung +0.58% → -3.63% — the whole week's BTC drift turned negative.
- Book daily: +4.58 → +27.93 SOL (strong recovery after yesterday's −8.04 close).
- **copy-elitelead newly promotable**: crossed n=100 gate (91→108), all gates now clear — the 6th PROMOTE candidate.
- **Big score jumpers (>10 pts):** copy-c2rr-scaleout-trailtp +34.1pts (net turned positive, −0.794→+1.945); copy-c2rr-control +22.2pts (net turned positive, −0.721→+1.197); copy-c2rr-scaleout-50 +22pts (drop3 turned positive for first time, −1.286→+0.076).
- **NEW additions:** 5 copy-fatwallet-* variants appeared (n=10-12 each, all early negative, gate-starved — wallet_allowlist filtering ~96% of events). A new dimension under test; too early to evaluate.
- **copy-c2rr-ratchet-run** continued its decline: net −2.743→−4.076 at n=88 → now catastrophic (net<−3 at n≥40 rule applies). Was on KILL list yesterday; still on KILL list.

**Week-over-week (2026-06-17 → 2026-06-22):**
- *Convergence:* copy-elitelead reached score 100 today (was untracked before Jun 17); copy-consensus2-elite 79→94.4 and approaching n=100; copy-c2rr-scaleout-50 score 50→72 with drop3 turning positive. n_promotable_realistic went 0→2→1→4→5→6 — a clean weekly climb.
- *Decay:* copy-c2rr-ratchet-run has been losing ground every day (net −2.743 → −4.076); copy-c2rr-scaleout-run also trending down (−2.204 → −2.921). Both need resolution.
- *Regime:* Volatile all week (scores 2→5→4→6→3→8). No sustained favorable stretch — sharp daily reversals. Today's 8 is the highest of the week.
- *BTC/macro:* BTC 7d pct deteriorated steadily: +5.72→+1.34→−1.61→−1.02→+0.58→−3.63. Persistent macro headwind despite BTC being roughly flat day-over-day.
- *Lead pool:* Hot leads 26→30→28→34→37→41. Steady growth in hot leads week-over-week — positive for the hotlead-family signal quality.
- *Book:* Daily P&L volatile (23→−11→3→16→−8→+28). Positive days outnumber negative; the book net grew +15.3 SOL today alone.

**Verdicts (proposals — require operator approval + code edit to COPY_STRATEGIES):**

- **PROMOTE (6):** copy-hotlead (n=304, net=+18.39, drop3=+11.98, monthly=55 SOL/mo), copy-hotlead-hold30m (n=281, monthly=88 SOL/mo), copy-hotlead-deep (n=189, monthly=51), copy-hotlead-strict (n=149, monthly=53), copy-hotlead-consensus (n=165, monthly=46), **copy-elitelead (n=108, monthly=37 — newly cleared today)**. All gates green on realistic execution. These have been pending approval; recommend starting with copy-hotlead (broadest coverage, highest sample) for the first live-micro slot.
- **KEEP COOKING (3):** copy-consensus2-elite (n=72, score=94.4, drop3=+2.59 — needs 28 more trades to clear n gate); copy-c2rr-scaleout-50 (n=84, drop3 just turned +0.076 — fragile, needs 16 more trades to confirm); copy-c2rr-scaleout-trailtp (n=74, net just turned positive +1.945, drop3 still −1.419 — promising momentum but not there yet).
- **WATCH (9):** copy-c2rr-breakeven (n=114, drop3=−0.084 — nearly zero, one good day from clearing); copy-c2rr-ratchet-tp (n=121, drop3=−0.884); copy-c2rr-ratchet-trailtp (n=85, net positive but drop3=−2.39); copy-c2rr-trailtp-wide (n=78, drop3=−3.32); copy-c2rr-control (n=102, drop3=−1.81); copy-c2rr-trailtp-tight (n=104, net=−0.38, all stress negative — approaching kill if it doesn't recover); copy-c2rr-scaleout-run (n=58, net=−2.92 — approaching catastrophic); fatwallet family (n=10-12 each, too early).
- **KILL (1 — propose):** copy-c2rr-ratchet-run — net=−4.076 at n=88 qualifies as catastrophic (net<−3 at n≥40 rule). Was on KILL list yesterday. Recommend removing from COPY_STRATEGIES.

**New strategies to try:** None proposed this cycle. The fatwallet family (5 variants) is a brand-new dimension just launched and needs time to cook. With 6 strategies already fully promotable and no operator approval enacted yet, the bottleneck is deployment speed, not hypothesis generation.

**Operator next steps:**
1. **(Most urgent)** Approve and enact the first PROMOTE from the hotlead family — recommend copy-hotlead (n=304, broadest base, 55 SOL/mo) as the first live-micro slot if not already approved.
2. Confirm kill of copy-c2rr-ratchet-run (catastrophic at −4.08 SOL, n=88) via code edit + push.

---

## 2026-06-21

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-06-21",
  "overall": {"n": 7715, "net": 122.92, "drop3": 70.79, "stress": 41.87, "open": 58},
  "retired_summary": {"n": 7845, "net": -132.55},
  "regime_score": 3, "regime_24h": 4, "macro_score": 5, "btc_7d_pct": 0.58,
  "book_daily_today": 4.58,
  "leads": {"n_leads": 118, "hot": 37, "cold": 48},
  "n_promotable_realistic": 5,
  "strategies": [
    {"id": "copy-hotlead", "realistic": true, "n": 266, "net": 15.337, "drop3": 9.330, "stress": 12.290, "promo_score": 100, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-hold30m", "realistic": true, "n": 214, "net": 21.415, "drop3": 2.887, "stress": 18.782, "promo_score": 100, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-deep", "realistic": true, "n": 159, "net": 10.530, "drop3": 4.762, "stress": 8.682, "promo_score": 100, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-consensus", "realistic": true, "n": 147, "net": 10.157, "drop3": 4.389, "stress": 8.440, "promo_score": 100, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-strict", "realistic": true, "n": 120, "net": 10.235, "drop3": 4.467, "stress": 8.795, "promo_score": 100, "verdict": "PROMOTE"},
    {"id": "copy-elitelead", "realistic": true, "n": 91, "net": 5.977, "drop3": 3.147, "stress": 4.920, "promo_score": 98, "verdict": "KEEP"},
    {"id": "copy-consensus2-elite", "realistic": true, "n": 65, "net": 3.708, "drop3": 0.892, "stress": 2.964, "promo_score": 79, "verdict": "KEEP"},
    {"id": "copy-c2rr-ratchet-trailtp", "realistic": true, "n": 58, "net": 3.026, "drop3": -2.713, "stress": 2.368, "promo_score": 67, "verdict": "WATCH"},
    {"id": "copy-c2rr-trailtp-wide", "realistic": true, "n": 52, "net": 2.601, "drop3": -3.795, "stress": 2.014, "promo_score": 65, "verdict": "WATCH"},
    {"id": "copy-c2rr-breakeven", "realistic": true, "n": 82, "net": 1.059, "drop3": -0.935, "stress": 0.193, "promo_score": 53, "verdict": "WATCH"},
    {"id": "copy-c2rr-ratchet-tp", "realistic": true, "n": 87, "net": 0.638, "drop3": -1.890, "stress": -0.271, "promo_score": 52, "verdict": "WATCH"},
    {"id": "copy-c2rr-scaleout-50", "realistic": true, "n": 56, "net": 0.767, "drop3": -1.286, "stress": 0.371, "promo_score": 50, "verdict": "WATCH"},
    {"id": "copy-c2rr-control", "realistic": true, "n": 72, "net": -0.721, "drop3": -2.770, "stress": -1.448, "promo_score": 34, "verdict": "WATCH"},
    {"id": "copy-c2rr-trailtp-tight", "realistic": true, "n": 72, "net": -1.187, "drop3": -3.081, "stress": -1.905, "promo_score": 34, "verdict": "WATCH"},
    {"id": "copy-c2rr-ratchet-run", "realistic": true, "n": 60, "net": -2.743, "drop3": -3.739, "stress": -3.307, "promo_score": 32, "verdict": "KILL"},
    {"id": "copy-c2rr-scaleout-trailtp", "realistic": true, "n": 49, "net": -0.794, "drop3": -2.753, "stress": -1.118, "promo_score": 30, "verdict": "WATCH"},
    {"id": "copy-c2rr-scaleout-run", "realistic": true, "n": 36, "net": -2.204, "drop3": -3.210, "stress": -2.385, "promo_score": 27, "verdict": "WATCH"},
    {"id": "copy-hotlead-deep-live-micro", "realistic": true, "n": 35, "net": -0.181, "drop3": -0.347, "stress": -0.177, "promo_score": 27, "verdict": "KEEP"}
  ]
}
```

**Headline:** The hotlead family achieves a clean sweep — all 5 realistic variants simultaneously score 100 on the promotion bar, led by two new crossings this session (copy-hotlead-strict crossed n=100 with score 100, copy-hotlead-hold30m's drop3 flipped from −0.485 to +2.887 and is now the highest-monthly strategy in the roster at +91.78 SOL/mo); meanwhile the operator enacted a full kill-list cleanup overnight (8 strategies removed), and copy-hotlead-deep-live-micro is live at n=35 (mildly negative at −0.181, too early to call).

**Day-over-day (vs 2026-06-20 snapshot):** Regime dropped sharply, 6→3 ("weak"), regime_24h 8→4. book_net_6h=−15.73 (rolling 6h including late June 20 afternoon) — the book had a rough late-yesterday stretch. Today's partial (n=535, +4.58 SOL by 10:00 UTC) is modestly positive and better than yesterday's full-day +3.89. Macro held flat at 5 ("neutral"), BTC barely moved ($63,853→$64,127), fear & greed 23. SOL firmed slightly ($71.73→$73.16).

**Roster changes since yesterday (operator enacted all Jun 20 proposals plus more):**
- **Killed (8 total):** copy-bigbuy ✓, copy-consensus3 ✓, copy-macro ✓, copy-regime-mid ✓, copy-regime-hi ✓ (the 5 formal kills), plus copy-macro-regime, copy-hotlead-regime, and copy-consensus2-lag-drift5 (the oscillating watch). All regime/macro-gated and BTC-timed strategies are now gone — a clean exit from the entire macro-timing experiment.
- **New addition:** copy-hotlead-deep-live-micro — hotlead-deep deployed live at MICRO_TRADE_SIZE_SOL. n=35 across 2 days (Jun 20 n=18/−0.018, Jun 21 n=17/−0.164). Mildly negative early, no verdict yet.
- **retired_summary grew** from (n=6655, net=−124.71) to (n=7845, net=−132.55): +1,190 historical trades absorbed, net degraded −7.84 — confirms the killed strategies were all net-negative.

**Key strategy movers today:**

- `copy-hotlead-hold30m` (+54 trades): Δdrop3=**+3.372**, crossing zero from −0.485 → **+2.887**. Score 75→**100**, ALL GATES NOW CLEAR. This is the new highest-monthly strategy in the roster at +91.78 SOL/mo. The stress gate also passes at +18.782. **NEWLY PROMOTABLE.** The drop3 trajectory has been accelerating daily (Jun 18: −4.234 → Jun 19: −5.033 → Jun 20: −0.485 → Jun 21: +2.887); the reversal from Jun 19→20 was driven by the Jun 17–18 exceptional days propagating through the hold-30m longer exit window. The drop3 buffer (+2.887) is now solid — not a fragile crossing.
- `copy-hotlead-strict` (+40 trades): Δdrop3=**+2.557**, score 94.9→**100**. **CROSSED N=100 GATE** this session. n=120, net=+10.235, drop3=+4.467, stress=+8.795, monthly=+51.18 SOL. All gates clear. **NEWLY PROMOTABLE.**
- `copy-hotlead-consensus` (+33 trades): Δdrop3=**+2.566**, score 97.8→100. n=147, net=+10.157, drop3=+4.389, stress=+8.440, monthly=+43.53 SOL. Proposed for promotion yesterday; metrics strengthened further.
- `copy-hotlead` (+68 trades): Δdrop3=**+1.311**, Δnet=+1.311 (identical — no new top-3 winner). Score holds at 100. n=266, net=+15.337, drop3=+9.330, monthly=+51.12 SOL. Has been proposed for promotion for 4 consecutive sessions without action.
- `copy-hotlead-deep` (+51 trades): Δdrop3=+0.196. n=159, net=+10.530, drop3=+4.762, monthly=+52.65 SOL. Slow delta today (live-micro deployment likely consuming some signal capacity). All gates clear and its live twin is now running.
- `copy-elitelead` (+19 trades): Δdrop3=**+1.582**, score 89→98. n=91, drop3=+3.147, monthly=+35.86 SOL. **9 trades from the n=100 gate.** Will be the 6th promotable strategy, likely tomorrow.
- `copy-consensus2-elite` (+7 trades): Δdrop3=+0.324, score 73.7→79. n=65, drop3=+0.892 — thin buffer but positive and growing.

**C2RR cluster (consensus2 realistic exit-variant experiment, n=36–87 each):**

None have positive drop3 yet. The "run" variants are the clearest failures:
- `copy-c2rr-ratchet-run` (n=60, net=−2.743, drop3=−3.739, stress=−3.307): **approaching catastrophic kill threshold** (net<−3 at n≥40). All three quality gates deeply failing. Monthly=−27.43 SOL. The "never-sell-while-running" exit approach is clearly the worst in this universe. Kill trigger is essentially certain within the next few sessions.
- `copy-c2rr-scaleout-run` (n=36, net=−2.204, drop3=−3.210): pre-40 so technically not at threshold yet, but same pattern. Monthly=−22.04 SOL. High kill risk at n=40.

Best in cluster (still lottery-shaped but positive net + stress):
- `copy-c2rr-ratchet-trailtp` (n=58, net=+3.026, stress=+2.368, drop3=−2.713)
- `copy-c2rr-trailtp-wide` (n=52, net=+2.601, stress=+2.014, drop3=−3.795)
- `copy-c2rr-breakeven` (n=82, net=+1.059, stress=+0.193, drop3=−0.935 — closest to zero)

The structural takeaway from this cluster: trailing + TP combinations outperform trailing-only exits. The "run" extreme (trail forever) appears to hold losers too long in this universe.

**Live-micro execution watch:**

`copy-hotlead-deep-live-micro`: n=35, net=−0.181, drop3=−0.347, stress=−0.177. Started Jun 20. The shadow copy-hotlead-deep shows +10.530 over 159 trades (+0.066 SOL/trade expectation). At 0.5 SOL paper size, the expected micro-scale net over 35 trades would be negligible — so this −0.181 is not yet alarming. The prior live-micro test (copy-consensus2-lag-drift5-live-micro) failed badly (−9.68pp exec gap). With hotlead, the execution lag is the same 5s but the hotlead signal may be more durable vs the timing-sensitive consensus2. Monitor the execution gap for the first 75 trades before drawing conclusions.

**Week-over-week (5 entries, Jun 17–21):**

Book daily arc: +23.38 → −11.42 (partial) → +9.87 → +3.89 → +4.58 (partial). After the Jun 17/18 exceptional +54/+40 days, the book has normalized. Jun 18 was partial and negative during the snapshot window. Jun 19–21 are modest-positive days averaging +6.1 SOL/day — healthy if unexciting.

Realistic strategies converging (every carried-over strategy improved drop3 this session):
- `copy-hotlead-hold30m`: drop3 −4.234 → −5.033 → −0.485 → **+2.887** — J-shaped with reversal driven by the Jun 17/18 windfall finally clearing the hold-30m exit window.
- `copy-hotlead-strict`: drop3 −0.999 → −1.000 → +1.910 → **+4.467** — clean positive trajectory after crossing n=100.
- `copy-hotlead-consensus`: drop3 −1.429 → −0.760 → +1.823 → **+4.389** — steadily widening post-zero margin.
- `copy-hotlead`: drop3 +0.506 → +2.329 → +8.019 → **+9.330** — fastest-growing absolute drop3 buffer.
- `copy-elitelead`: drop3 −1.494 → −0.334 → +1.565 → **+3.147** — rapid improvement; will likely be promotable in 24h.

No realistic strategies are decaying. The prior decaying group (macro/regime/bigbuy/consensus3) was entirely removed.

Macro/BTC over 5 days: 6 → 6 → 4 → 5 → **5**. BTC has ranged $62k–$66k, settled at $64k. Macro is neutral — neither tailwind nor headwind. The Jun 17/18 book surge occurred when macro was 6 (mild tailwind) and again today's regime is 3 (weak). The hotlead signal is now confirmed to perform across both tailwind and neutral macro windows.

Lead pool: 85 → 94 → 99 → 102 → **118** leads. Net addition of 16 leads since yesterday. hot: 26 → 30 → 28 → 34 → **37**. The pool is growing and the hot/cold ratio is the healthiest it's been (37 hot vs 48 cold, 44% hot). Top leads consistent: 5q8osC4C (n=85, +5.58 SOL, hot), B6yHBbrf (n=13, +3.50 SOL, 54% WR, hot), AE7neeVw (n=8, +3.26 SOL, 75% WR, hot). Bottom: 6svp2aai (n=93, −4.94 SOL, cold), 2fHT9wBh (n=101, −4.61 SOL, cold). Lead selection quality is steady.

**Verdicts (proposals — roster changes require operator approval + `COPY_STRATEGIES` code edit):**

- **PROMOTE (4 pending — copy-hotlead-deep already promoted to live-micro):**
  - `copy-hotlead` — n=266, net=+15.337, drop3=+9.330, stress=+12.290, monthly=+51.12 SOL, score=100. Has been proposed 4 consecutive sessions. The highest drop3 buffer in the roster. Primary action.
  - `copy-hotlead-consensus` — n=147, net=+10.157, drop3=+4.389, stress=+8.440, monthly=+43.53 SOL, score=100. Proposed yesterday, metrics strengthened.
  - `copy-hotlead-strict` — n=120, net=+10.235, drop3=+4.467, stress=+8.795, monthly=+51.18 SOL, score=100. **NEW PROMOTABLE this session.** Crossed n=100 today.
  - `copy-hotlead-hold30m` — n=214, net=+21.415, drop3=+2.887, stress=+18.782, monthly=+91.78 SOL, score=100. **NEW PROMOTABLE this session.** Highest monthly rate in the roster; the "hold 30 min minimum before follow-selling" exit variant. The drop3 buffer is solid at +2.887 and widening.

- **KEEP COOKING:**
  - `copy-elitelead` — n=91, score=98, drop3=+3.147, monthly=+35.86 SOL. 9 trades from promotion. All quality metrics clear; only the n=100 gate remains. Expect to be the 6th promotable strategy by tomorrow.
  - `copy-consensus2-elite` — n=65, drop3=+0.892, score=79. Thin buffer but positive and growing. Needs more trades before trusting the drop3 sign; keep cooking.
  - `copy-hotlead-deep-live-micro` — n=35, net=−0.181. First live deployment in the hotlead family. Too early for a verdict; monitor execution gap vs shadow over the next 65 trades.
  - `copy-c2rr-ratchet-trailtp` (n=58), `copy-c2rr-trailtp-wide` (n=52), `copy-c2rr-breakeven` (n=82), `copy-c2rr-ratchet-tp` (n=87), `copy-c2rr-scaleout-50` (n=56) — the positive-net c2rr variants. All lottery-shaped (drop3 negative) but not catastrophically negative. Keep cooking to n=100; drop3 trajectory at n=100 will determine verdicts.

- **KILL (1 proposal — pre-trigger warning):**
  - `copy-c2rr-ratchet-run` — n=60, net=−2.743, drop3=−3.739, stress=−3.307, monthly=−27.43 SOL. All quality gates deeply failing. Approaching catastrophic threshold (net<−3 at n≥40). Recommend killing immediately rather than waiting — the direction is unambiguous and there is no recovery path with all three gates negative and deepening.

- **WATCH (approaching kill):**
  - `copy-c2rr-scaleout-run` — n=36, net=−2.204, drop3=−3.210, stress=−2.385. Pre-40 threshold, but heading toward it. If net crosses −3 (estimated within ~4 more trades at this rate), kill immediately.
  - `copy-c2rr-control` — n=72, net=−0.721, drop3=−2.770, stress=−1.448. All gates failing. Not catastrophic yet but the control variant (baseline consensus2+5s entry, no exit modification) has been negative from the start. Kill at n=100 if gates still fail.
  - `copy-c2rr-trailtp-tight` — n=72, net=−1.187, drop3=−3.081, stress=−1.905. Similar pattern to control. Kill at n=100 if no recovery.
  - `copy-c2rr-scaleout-trailtp` — n=49, net=−0.794, drop3=−2.753, stress=−1.118. Three gates failing. Watch to n=80.

**New strategies to try:** None this cycle. Five strategies are simultaneously at score 100 waiting to be promoted to live-micro; copy-elitelead is one session away from joining them. The priority is execution, not research. After the first wave of live-micro promotions runs for 2–3 weeks, revisit whether a new dimension (exit timing, entry sizing) adds edge on top of the lead-selection signal.

**Operator next steps (priority order):**
1. **Kill `copy-c2rr-ratchet-run`** — n=60, net=−2.743 approaching −3 threshold, all quality gates failing. Pre-emptive kill to avoid the catastrophic threshold triggering mid-session. Remove from `COPY_STRATEGIES`.
2. **Promote `copy-hotlead` to live-micro** — 4th consecutive session at score 100, highest drop3 buffer in the roster (+9.330). This is the overdue primary action.
3. **Promote `copy-hotlead-consensus`, `copy-hotlead-strict`, `copy-hotlead-hold30m` to live-micro** — all three score 100 with all gates clear. Running 5 hotlead live-micro strategies simultaneously is manageable at MICRO_TRADE_SIZE_SOL and provides diversification across exit profiles.
4. **Watch `copy-hotlead-deep-live-micro`** — check execution gap at n=75 (±35 more trades). If gap is severe (>5pp), consider pausing and diagnosing entry timing before promoting the other 4 families.

---

## 2026-06-20

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-06-20",
  "overall": {"n": 7288, "net": 123.87, "drop3": 71.75, "stress": 46.45, "open": 231},
  "retired_summary": {"n": 6655, "net": -124.71},
  "regime_score": 6, "regime_24h": 8, "macro_score": 5, "btc_7d_pct": -1.02,
  "book_daily_today": 16.27,
  "leads": {"n_leads": 102, "hot": 34, "cold": 43},
  "n_promotable_realistic": 4,
  "strategies": [
    {"id": "copy-hotlead", "realistic": true, "n": 198, "net": 14.026, "drop3": 8.019, "stress": 11.706, "promo_score": 100, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-deep", "realistic": true, "n": 108, "net": 10.334, "drop3": 4.566, "stress": 9.015, "promo_score": 100, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-consensus", "realistic": true, "n": 114, "net": 7.592, "drop3": 1.823, "stress": 6.266, "promo_score": 97.8, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-strict", "realistic": true, "n": 80, "net": 7.678, "drop3": 1.910, "stress": 6.700, "promo_score": 94.9, "verdict": "KEEP"},
    {"id": "copy-elitelead", "realistic": true, "n": 72, "net": 4.395, "drop3": 1.565, "stress": 3.565, "promo_score": 89, "verdict": "KEEP"},
    {"id": "copy-consensus2-lag-drift5", "realistic": true, "n": 287, "net": 6.568, "drop3": 0.138, "stress": 3.481, "promo_score": 76.7, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m", "realistic": true, "n": 160, "net": 17.651, "drop3": -0.485, "stress": 15.650, "promo_score": 75, "verdict": "KEEP"},
    {"id": "copy-consensus2-elite", "realistic": true, "n": 58, "net": 3.384, "drop3": 0.568, "stress": 2.719, "promo_score": 73.7, "verdict": "KEEP"},
    {"id": "copy-consensus3", "realistic": true, "n": 131, "net": 2.701, "drop3": -3.755, "stress": 1.298, "promo_score": 68, "verdict": "KILL"},
    {"id": "copy-c2rr-ratchet-trailtp", "realistic": true, "n": 15, "net": 2.895, "drop3": -2.513, "stress": 2.683, "promo_score": 58, "verdict": "WATCH"},
    {"id": "copy-c2rr-trailtp-wide", "realistic": true, "n": 14, "net": 2.722, "drop3": -2.686, "stress": 2.523, "promo_score": 57.8, "verdict": "WATCH"},
    {"id": "copy-c2rr-scaleout-50", "realistic": true, "n": 14, "net": 0.105, "drop3": -1.842, "stress": 0.006, "promo_score": 29.1, "verdict": "WATCH"},
    {"id": "copy-c2rr-ratchet-tp", "realistic": true, "n": 19, "net": -0.041, "drop3": -2.228, "stress": -0.236, "promo_score": 23.8, "verdict": "WATCH"},
    {"id": "copy-c2rr-trailtp-tight", "realistic": true, "n": 18, "net": -0.103, "drop3": -1.947, "stress": -0.286, "promo_score": 23.6, "verdict": "WATCH"},
    {"id": "copy-c2rr-breakeven", "realistic": true, "n": 17, "net": -0.351, "drop3": -2.075, "stress": -0.519, "promo_score": 23.4, "verdict": "WATCH"},
    {"id": "copy-c2rr-control", "realistic": true, "n": 15, "net": -1.128, "drop3": -2.906, "stress": -1.260, "promo_score": 23, "verdict": "WATCH"},
    {"id": "copy-c2rr-scaleout-trailtp", "realistic": true, "n": 14, "net": -0.778, "drop3": -2.309, "stress": -0.867, "promo_score": 22.8, "verdict": "WATCH"},
    {"id": "copy-c2rr-ratchet-run", "realistic": true, "n": 10, "net": -1.491, "drop3": -2.061, "stress": -1.564, "promo_score": 22, "verdict": "WATCH"},
    {"id": "copy-c2rr-scaleout-run", "realistic": true, "n": 8, "net": -1.105, "drop3": -1.564, "stress": -1.129, "promo_score": 21.6, "verdict": "WATCH"},
    {"id": "copy-regime-hi", "realistic": true, "n": 109, "net": -4.027, "drop3": -6.690, "stress": -5.069, "promo_score": 40, "verdict": "KILL"},
    {"id": "copy-regime-mid", "realistic": true, "n": 200, "net": -4.883, "drop3": -8.316, "stress": -6.845, "promo_score": 40, "verdict": "KILL"},
    {"id": "copy-macro", "realistic": true, "n": 176, "net": -2.382, "drop3": -8.251, "stress": -4.147, "promo_score": 40, "verdict": "KILL"},
    {"id": "copy-macro-regime", "realistic": true, "n": 80, "net": -2.218, "drop3": -4.810, "stress": -2.998, "promo_score": 36, "verdict": "WATCH"},
    {"id": "copy-hotlead-regime", "realistic": true, "n": 67, "net": -1.679, "drop3": -4.206, "stress": -2.336, "promo_score": 33.4, "verdict": "WATCH"},
    {"id": "copy-bigbuy", "realistic": true, "n": 46, "net": -3.323, "drop3": -5.228, "stress": -3.730, "promo_score": 29.2, "verdict": "KILL"}
  ]
}
```

**Headline:** Three hotlead variants simultaneously hit the promotion bar this morning — `copy-hotlead` (score 100, 3rd consecutive session), `copy-hotlead-deep` (score 100, just crossed n=100), and `copy-hotlead-consensus` (score 97.8, drop3 flipped positive overnight); meanwhile `copy-bigbuy` crossed the catastrophic kill threshold (n=46, net=−3.32), and `copy-consensus3` is now INVALID at n=131 with drop3=−3.755 and declining.

**Day-over-day (vs 2026-06-19 snapshot, snapshot was partial ~10:00 UTC):** Tape turned sharply positive — regime_score 4→6 ("favorable"), regime_24h 1→8 (massive intraday surge). Macro held flat at 5 ("neutral"), BTC 7d improved slightly −1.61%→−1.02%, SOL 1d +3.7% to $71.53. Book daily today: +16.27 SOL at 09:59 UTC snapshot (partial; already ahead of yesterday's full-day +9.87). The whole-book Δnet=+23.70 and Δdrop3=+23.71 are nearly identical — the 608 new trades across all strategies did not produce a single new top-3 winner at the book level. Entirely broad accumulation.

**Roster changes since yesterday:** `copy-consensus2-lag-drift5-live-micro` is gone from active strategies — confirmed killed (per operator action on the recommendation). Live_vs_shadow data confirms the decision was correct: the live-micro averaged −5.35% vs shadow's +4.32% over 172 matched trades, exec_gap = −9.68pp. Ten new c2rr strategies (consensus2 ratchet/trail/scale-out exit variants: copy-c2rr-control, copy-c2rr-ratchet-tp, copy-c2rr-ratchet-trailtp, copy-c2rr-ratchet-run, copy-c2rr-trailtp-tight, copy-c2rr-trailtp-wide, copy-c2rr-scaleout-50, copy-c2rr-scaleout-run, copy-c2rr-scaleout-trailtp, copy-c2rr-breakeven) appeared in today's data — all consensus-gated with 5s delay, n=8–19. Too new to call.

**Key strategy movers today:**
- `copy-hotlead` (+30 trades): Δnet=+6.21, Δdrop3=+5.69 (2.33→8.02). The drop3 jump is particularly notable — the top-3 winners are now just a 57% slice of net vs historically much higher. Strengthening fast.
- `copy-hotlead-deep` (+16 trades): Δnet=+3.01, Δdrop3=+2.56 (2.00→4.57), score 98.4→**100**. Crossed n=100 gate today. All gates clear. NEW PROMOTABLE.
- `copy-hotlead-consensus` (+16 trades): Δnet=+2.96, Δdrop3=+2.58 (−0.76→**+1.82**). Drop3 crossed zero and landed well above it. Score 74.6→**97.8**. NEW PROMOTABLE. n=114 (crossed n=100 gate as well).
- `copy-hotlead-strict` (+12 trades): Δnet=+1.17, Δdrop3=+0.54 (1.37→1.91), score 85.8→94.9. 20 trades from n=100.
- `copy-elitelead` (+10 trades): Δnet=+2.28, Δdrop3=+1.90 (−0.33→**+1.57**, FLIPPED), score 61.7→89. Needs 28 more trades to hit n=100.
- `copy-consensus2-elite` (+10 trades): Δnet=+2.36, Δdrop3=+1.59 (−1.02→**+0.57**, FLIPPED), score 49.7→73.7. Needs 42 more trades.
- `copy-consensus2-lag-drift5` (+38 trades): Δnet=+1.24, Δdrop3=+1.08 (−0.94→**+0.14**, RE-FLIPPED). Score 75→76.7. Thin margin — this is the third oscillation around zero (positive Jun 18, negative Jun 19, positive Jun 20). All gates technically clear but the buffer (+0.138) is fragile; just 3 bad trades would flip it back. The live execution gap data (−9.68pp) also argues against promoting this one ahead of the hotlead family. Marked WATCH, not PROMOTE.
- `copy-hotlead-hold30m` (+19 trades): Δnet=+5.36, Δdrop3=+4.55 (−5.03→**−0.49**). Drop3 closing on zero fast — if it crosses positive it will be the highest-monthly strategy in the roster (+88.26 SOL/mo). Watching closely.
- `copy-consensus3` (+30 trades): Δnet=**−1.52**, Δdrop3=**−1.72** (−2.03→−3.76), score 75→68. Active deterioration at n=131 with all gates failing. First kill proposal.
- `copy-bigbuy` (+14 trades): Δnet=**−1.76** (−1.56→−3.32). Net < −3 at n=46 ≥ 40 — **catastrophic kill threshold triggered**. Kill immediately.
- `copy-regime-mid` (+54 trades): Δnet=**−3.37** (−1.52→−4.88). Worst daily loss of any strategy today. All gates failing at n=200. 3rd consecutive kill proposal — still not enacted.
- `copy-regime-hi` (+33 trades): n 76→109 (now past n=100 gate), Δnet=−0.53 (−3.49→−4.03), drop3=−6.69, monthly=−17.26 SOL. All gates now formally fail at n≥100. 3rd proposal.
- `copy-macro` (+2 trades): roughly flat (net −2.38). Still failing all gates at n=176. 3rd proposal.

**Week-over-week (4 entries: Jun 17–20):**

Book daily arc: Jun 17 +31.14 → Jun 18 +28.56 → Jun 19 +9.87 → Jun 20 +16.27 (partial). Four consecutive positive days averaging +21.5 SOL/day (σ=10.1). The book has recovered spectacularly from the Jun 13–14 double-digit daily losses. However, today's regime_24h=8 suggests the current conditions are especially favorable — the book may regress toward the mean as regime normalizes.

Realistic strategies converging (positive drop3 trajectory across 4 days):
- `copy-hotlead` drop3: −1.86 → +0.51 → +2.33 → **+8.02** — linear sustained accumulation; the fastest-growing drop3 in the roster.
- `copy-hotlead-deep` drop3: −2.21 → +0.24 → +2.00 → **+4.57** — launched later (n=19 on Jun 17), but at n=108 already well past the bar.
- `copy-hotlead-consensus` drop3: −1.43 → −0.76 → **+1.82** — latest in the family to clear but the trend is consistent.
- `copy-elitelead` drop3: −1.49 → −0.33 → **+1.57** — fast flip at low n; needs n=100 to confirm.
- `copy-consensus2-elite` drop3: — → −1.02 → **+0.57** — two-day flip; still too small (n=58) to trust.

Realistic strategies decaying:
- `copy-consensus3` drop3: −2.49 → −2.03 → **−3.76** — diverging further from zero with each cycle at n=131. INVALID.
- `copy-bigbuy` net: +0.79 → +0.36 → −1.56 → **−3.32** — complete collapse over 4 days.
- `copy-regime-mid` net: −0.72 → −1.52 → **−4.88** — accelerating.

Lead pool: hot leads 26 → 30 → 28 → **34** (+6 today), cold 39 → 40 → 46 → **43** (−3 today). The hot/cold balance is improving for the first time in several sessions. Top leads consistent: 5q8osC4C (n=76, +4.10 SOL) and AE7neeVw (n=8, +3.26 SOL, 75% WR) leading; bottom unchanged (6svp2aai n=89/−4.33, 2fHT9wBh n=88/−4.23). New entrant B6yHBbrf (n=12, +3.68 SOL, 58.3% WR, last10 +4.05) — high win rate in recent trades, worth watching.

Macro/BTC pattern over 4 days: macro score 6 → 6 → 4 → **5**. BTC has been in $62k–$65k range all week, mild 7d negative drift. SOL gained today (+3.7% 1d, $71.53). Fear & greed at 23 (extreme fear by traditional standards but book is thriving — suggesting the memecoin/copy-trade alpha is regime-independent).

**Verdicts (proposals — roster changes require operator approval + `COPY_STRATEGIES` code edit):**

- **PROMOTE (3 confirmed):**
  - `copy-hotlead` — n=198, net=+14.03, drop3=+8.02, stress=+11.71, monthly=+52.60 SOL, score=100, all gates clear. 3rd consecutive session at score 100. Proposed last 2 sessions without action. This is the strongest realistic strategy in the roster. Recommend adding `executionMode: "live_micro"` in `COPY_STRATEGIES`.
  - `copy-hotlead-deep` — n=108, net=+10.33, drop3=+4.57, stress=+9.02, monthly=+62.01 SOL, score=100, all gates clear. Just crossed n=100 this morning. Stricter hotlead gate (deeper quality filter) with comparable metrics to hotlead itself. Recommend promoting simultaneously with copy-hotlead.
  - `copy-hotlead-consensus` — n=114, net=+7.59, drop3=+1.82, stress=+6.27, monthly=+37.96 SOL, score=97.8, all gates clear. Drop3 crossed zero today and landed solidly above it. Recommend promoting alongside the other two; at MICRO_TRADE_SIZE_SOL, running 3 hotlead variants concurrently is manageable.
  - **Note on execution gap:** the live-micro consensus2 test showed a −9.68pp exec gap. The hotlead strategies' margins are large enough to absorb this (drop3/monthly well above the floor), but the operator should monitor execution quality carefully in the first week.
  - `copy-consensus2-lag-drift5` — gates technically clear (n=287, drop3=+0.138, stress=+3.48, monthly=+19.70 SOL, score=76.7) but drop3 has oscillated +/−/+ across three sessions with only +0.138 buffer. Given the −9.68pp execution gap observed in the live-micro test, this thin margin would likely not survive live execution. **Do NOT promote this session** — keep watching, promote only if drop3 reaches +1.0 and holds for 2+ sessions.

- **KEEP COOKING:**
  - `copy-hotlead-strict` — n=80, drop3=+1.91, monthly=+46.07 SOL, score=94.9. All metrics strong; 20 trades from the n=100 gate. Will be promotable on the next run if trajectory holds.
  - `copy-hotlead-hold30m` — n=160, net=+17.65, drop3=−0.485 (2 bad trades from crossing zero), monthly=+88.26 SOL. Drop3 is closing at +4.55/session pace. If it flips positive, this becomes the highest-monthly strategy. Watch daily.
  - `copy-elitelead` — n=72, drop3=+1.57 (flipped today), score=89. Needs 28 more trades. At current pace should hit n=100 in 2-3 days.
  - `copy-consensus2-elite` — n=58, drop3=+0.57 (flipped today), score=73.7. Needs 42 more trades. Too new to trust the drop3 sign at this n.
  - `copy-c2rr-* cluster` (10 strategies, n=8–19 each) — brand-new consensus2-gated exit-variant experiments. All have high skip counts (already_open ~300, consensus ~65). Way too small to evaluate. Keep cooking until n≥50 on the best performers.

- **KILL (5 proposals):**
  - `copy-bigbuy` — n=46, net=−3.32. Catastrophic kill threshold (net < −3 at n≥40) triggered today. `lead_buy_size` gate starves it (2715 skips) so the few trades it gets are highly concentrated. Recommend removing from `COPY_STRATEGIES` immediately.
  - `copy-consensus3` — n=131, net=+2.70, drop3=−3.755, stress=+1.30 (stress passes but drop3 decisively fails). Net looks positive but it's lottery-shaped (removing top 3 trades wipes out the net and goes deeply negative). At n=131 with drop3 worsening by −1.72 per session, this is INVALID. First kill proposal.
  - `copy-macro` — n=176, net=−2.38, drop3=−8.25, monthly=−14.29 SOL. All gates failing at scale. 3rd consecutive kill proposal. No evidence of recovery; macro timing adds noise not edge.
  - `copy-regime-mid` — n=200, net=−4.88, drop3=−8.32, monthly=−20.93 SOL. 3rd consecutive kill proposal. Lost −3.37 SOL today alone. Worst deterioration in the roster.
  - `copy-regime-hi` — n=109, net=−4.03, drop3=−6.69, monthly=−17.26 SOL. n≥100 with all gates failing. 3rd proposal. High-regime gating is pure loss at every threshold tested.

- **WATCH (approaching kill or bar):**
  - `copy-macro-regime` — n=80, net=−2.22, drop3=−4.81. Same failing pattern as the three kills above; propose kill at n=100 if gates still fail (20 trades away).
  - `copy-hotlead-regime` — n=67, net=−1.68, drop3=−4.21. Regime overlay is clearly dragging the hotlead signal into loss; propose kill at n=80 if net still negative.
  - `copy-consensus2-lag-drift5` — drop3=+0.138, oscillating. See PROMOTE section — do not promote until buffer ≥ +1.0 sustained for 2 sessions.

**New strategies to try:** None this cycle. Three hotlead strategies are simultaneously promotable and the c2rr cluster (10 strategies) just launched. The roster is at maximum active capacity for useful evaluation. After the kills clear (bigbuy, consensus3, macro, regime-mid, regime-hi = 5 strategies), there may be room to add new hypotheses.

**Operator next steps (priority order):**
1. **Promote `copy-hotlead`, `copy-hotlead-deep`, `copy-hotlead-consensus` to live-micro** — all three score ≥97.8, all gates clear, all confirmed over multiple sessions. Add `executionMode: "live_micro"` to each in `COPY_STRATEGIES`. `copy-hotlead` is the primary; the other two are bonus if the operator is comfortable running 3 live strategies simultaneously.
2. **Kill `copy-bigbuy`** — catastrophic threshold triggered today (net=−3.32 at n=46). Stop losses now.
3. **Kill `copy-consensus3`** — n=131, drop3=−3.755, actively worsening. INVALID at scale.
4. **Kill `copy-macro`, `copy-regime-mid`, `copy-regime-hi`** — 3rd consecutive proposal, all deteriorating, regime-mid lost −3.37 SOL today alone. These kills are overdue.

---

## 2026-06-19

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-06-19",
  "overall": {"n": 6680, "net": 100.17, "drop3": 48.04, "stress": 30.68, "open": 229},
  "retired_summary": {"n": 6483, "net": -124.51},
  "regime_score": 4, "regime_24h": 1, "macro_score": 4, "btc_7d_pct": -1.61,
  "book_daily_today": 2.64,
  "leads": {"n_leads": 99, "hot": 28, "cold": 46},
  "n_promotable_realistic": 1,
  "strategies": [
    {"id": "copy-hotlead", "realistic": true, "n": 168, "net": 7.814, "drop3": 2.329, "stress": 5.928, "promo_score": 100, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-deep", "realistic": true, "n": 92, "net": 7.327, "drop3": 2.004, "stress": 6.233, "promo_score": 98.4, "verdict": "KEEP"},
    {"id": "copy-hotlead-strict", "realistic": true, "n": 68, "net": 6.512, "drop3": 1.374, "stress": 5.681, "promo_score": 85.8, "verdict": "KEEP"},
    {"id": "copy-consensus2-lag-drift5", "realistic": true, "n": 249, "net": 5.331, "drop3": -0.943, "stress": 2.660, "promo_score": 75.0, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m", "realistic": true, "n": 141, "net": 12.290, "drop3": -5.033, "stress": 10.591, "promo_score": 75.0, "verdict": "KEEP"},
    {"id": "copy-consensus3", "realistic": true, "n": 101, "net": 4.218, "drop3": -2.032, "stress": 3.093, "promo_score": 75.0, "verdict": "KEEP"},
    {"id": "copy-hotlead-consensus", "realistic": true, "n": 98, "net": 4.628, "drop3": -0.760, "stress": 3.526, "promo_score": 74.6, "verdict": "KEEP"},
    {"id": "copy-elitelead", "realistic": true, "n": 62, "net": 2.116, "drop3": -0.334, "stress": 1.435, "promo_score": 61.7, "verdict": "KEEP"},
    {"id": "copy-consensus2-elite", "realistic": true, "n": 48, "net": 1.021, "drop3": -1.019, "stress": 0.506, "promo_score": 49.7, "verdict": "KEEP"},
    {"id": "copy-consensus2-lag-drift5-live-micro", "realistic": true, "n": 130, "net": -0.230, "drop3": -0.405, "stress": -0.244, "promo_score": 40.0, "verdict": "KILL"},
    {"id": "copy-regime-mid", "realistic": true, "n": 146, "net": -1.516, "drop3": -4.512, "stress": -2.990, "promo_score": 40.0, "verdict": "KILL"},
    {"id": "copy-macro", "realistic": true, "n": 174, "net": -2.418, "drop3": -8.288, "stress": -4.162, "promo_score": 40.0, "verdict": "KILL"},
    {"id": "copy-macro-regime", "realistic": true, "n": 78, "net": -1.883, "drop3": -4.475, "stress": -2.649, "promo_score": 35.6, "verdict": "WATCH"},
    {"id": "copy-regime-hi", "realistic": true, "n": 76, "net": -3.493, "drop3": -5.507, "stress": -4.206, "promo_score": 35.2, "verdict": "KILL"},
    {"id": "copy-hotlead-regime", "realistic": true, "n": 53, "net": -1.345, "drop3": -3.470, "stress": -1.864, "promo_score": 30.6, "verdict": "WATCH"},
    {"id": "copy-bigbuy", "realistic": true, "n": 32, "net": -1.564, "drop3": -3.470, "stress": -1.863, "promo_score": 26.4, "verdict": "WATCH"}
  ]
}
```

**Headline:** `copy-hotlead` is the sole clear PROMOTABLE strategy (n=168, score 100, all gates clear, strengthening); meanwhile the `copy-consensus2-lag-drift5` live-micro test (n=130) is failing and its shadow drop3 reversed to −0.943 — recommend killing the live-micro and pausing the shadow promotion.

**Day-over-day (vs 2026-06-18 snapshot):** Regime score 5 → 4 ("weak"), regime_24h collapsed 5 → 1 — the tape is weakening fast. Macro score 6 → 4 ("headwind"): BTC 7d flipped from +1.34% → −1.61%, btc_usd $65.5k → $62.6k, fear & greed 14 (extreme fear). Book daily today: +2.64 SOL on 490 trades (partial at 10:00 UTC), with 229 open positions showing −17.28 unrealized — a quiet, mildly negative session so far after yesterday's +28.56.

Critical strategy moves today:

- **`copy-hotlead`** (+63 trades): Δnet +2.008, Δdrop3 +1.823, score 81.3 → **100**. All gates now clear decisively. This is the first strategy to reach a perfect promo score and has sustained it across three consecutive days of data accumulation. Proposed for promote yesterday — data has further confirmed it.
- **`copy-hotlead-deep`** (+52 trades): Δnet +2.153, Δdrop3 +1.767, score 66 → **98.4** (+32.4 pts — largest mover today). n=92, drop3=+2.004, stress=+6.233, monthly=+54.95. Just 8 trades from the n=100 gate. If drop3 holds positive it will be promotable on the next run.
- **`copy-hotlead-strict`** (+39 trades): Δnet +2.827, Δdrop3 +2.373, score 60.8 → **85.8** (+25 pts). n=68, drop3=+1.374, monthly=+48.84. Strong metrics — needs ~32 more trades.
- **`copy-consensus2-lag-drift5`** (+69 trades): Δdrop3 **−1.663**, score 84 → 75. Drop3 flipped back to −0.943 after being +0.720 yesterday. Yesterday's promotion recommendation was based on a thin +0.720 buffer that did not survive 69 more trades. The shadow strategy is now back in WATCH territory.
- **`copy-consensus2-lag-drift5-live-micro`** (new in data today): n=130, net=−0.230, drop3=−0.405, stress=−0.244, monthly=−3.44 SOL. All gates failing. The live-micro deployment initiated after yesterday's report is losing real money and its shadow counterpart has reversed. Recommend killing immediately.
- **`copy-bigbuy`** (+17 trades): Δnet **−1.920** (biggest single-day loss today on any strategy). Net went from +0.356 → −1.564 in one session. The `lead_buy_size` gate heavily starves it (2302 skips) so the low-n trades it does get are highly volatile. Approaching the catastrophic threshold (net < −3 at n ≥ 40); will likely trigger within the next 8+ trades at this rate.
- **Kills proposed yesterday but not yet enacted** (`copy-macro` n=174/net=−2.418, `copy-regime-mid` n=146/net=−1.516, `copy-regime-hi` n=76/net=−3.493): all continued to deteriorate. Second consecutive proposal to kill these. Each lost more SOL today, regime scores are declining, and with macro turning to headwind these will get worse before better.

**Week-over-week (3 entries: 2026-06-17, 2026-06-18, 2026-06-19):**

Book daily arc (past 2 weeks): −0.88 → −5.14 → +33.83 → +5.91 → +3.25 → +3.35 → −17.82 → −20.42 → −7.25 → +5.51 → **+54.52** → **+28.56** → **+2.64** (partial). The Jun 17 and Jun 18 back-to-back 54+28 days are exceptional — the book's entire cumulative net (100 SOL) is largely built on those two days. Today is modest partial.

Realistic strategies converging toward bar (positive trajectory over 3 days): `copy-hotlead` (drop3: −1.86 → +0.51 → +2.33 — clean linear accumulation), `copy-hotlead-deep` (drop3: −2.21 → +0.24 → +2.00 — fastest accelerator in the roster), `copy-hotlead-strict` (drop3: −1.82 → −1.00 → +1.37 — flipped positive this cycle). The pure hotlead signal without regime/macro overlay is consistently strengthening.

Realistic strategies decaying: `copy-consensus2-lag-drift5` (drop3: −0.28 → +0.72 → −0.94 — reverted after one good day), `copy-consensus2-lag-drift5-live-micro` (n=130, losing in live execution), `copy-bigbuy` (net: +0.79 → +0.36 → −1.56 — rapidly deteriorating).

Macro/regime pattern over 3 days: regime 2 → 5 → 4, macro 6 → 6 → 4, BTC 7d: +5.72% → +1.34% → −1.61%. The positive macro environment that drove Jun 17/18 gains is fading. This strengthens the argument that the pure hotlead signal (which performed through both good and bad macro windows) is more durable than the macro/regime-gated variants.

Lead pool: hot leads 26 → 30 → 28, cold 39 → 40 → 46. Cold lead count is rising — the pool has more cold leads than hot for the second day. Top leads remain consistent (5q8osC4C n=76/+4.10, DVhwSE98 n=24/+2.42 hot; worst: 6svp2aai n=88/−4.16 cold, 2HJMgsEq n=39/−3.64 cold). The lead signal remains bifurcated — a subset of hot leads drives the book P&L.

**Verdicts (proposals — roster changes require operator approval + `COPY_STRATEGIES` code edit):**

- **PROMOTE:** `copy-hotlead` — n=168, net=+7.814, drop3=+2.329, stress=+5.928, monthly=+33.49 SOL, score=100, all gates clear. Proposed yesterday and further confirmed today with Δdrop3=+1.823 over 63 new trades. Recommend live-micro deployment at MICRO_TRADE_SIZE_SOL. This is the primary action this cycle.

- **KEEP COOKING:** `copy-hotlead-deep` (n=92, drop3=+2.004 — 8 trades from promotable; if drop3 holds at n=100, promote immediately). `copy-hotlead-strict` (n=68, drop3=+1.374 — needs ~32 more trades, trajectory strong). `copy-hotlead-hold30m` (n=141, net=+12.29 — high net but drop3=−5.033 blocks it; lottery-shaped, keep watching). `copy-hotlead-consensus` (n=98, drop3=−0.760 — 2 trades from n=100 bar but drop3 still negative). `copy-consensus3` (n=101, drop3=−2.032 — cleared n=100 but fails drop3 decisively). `copy-elitelead` (n=62, drop3=−0.334 — narrowing). `copy-consensus2-elite` (n=48, drop3=−1.019). `copy-bigbuy` (n=32 — pre-40, watch the catastrophic threshold; recommend kill if net < −3 at any point past n=40).

- **WATCH (approaching kill):** `copy-consensus2-lag-drift5` — n=249, drop3=−0.943, score=75. The shadow strategy dropped back below zero after a brief positive window. Kill threshold was set at n=300 with drop3 still negative — now 51 trades away. If drop3 remains < 0 at n=300, kill. `copy-macro-regime` — n=78, net=−1.883. Below the catastrophic threshold for now but same failing pattern as the three kills below. `copy-hotlead-regime` — n=53, net=−1.345. Regime overlay is clearly dragging the hotlead signal into loss.

- **KILL (proposals — 2nd recommendation on first three, 1st on live-micro):**
  - `copy-consensus2-lag-drift5-live-micro` — n=130, net=−0.230, drop3=−0.405, stress=−0.244, monthly=−3.44 SOL. All gates failing at n=130. The shadow version's drop3 is also negative. This live-micro test has produced its verdict: the consensus2 signal does not survive realistic execution with the current paper universe. Recommend removing from `COPY_STRATEGIES` immediately to stop real-SOL losses.
  - `copy-macro` — n=174, net=−2.418, drop3=−8.288, stress=−4.162, monthly=−14.51 SOL. All gates failing, deteriorating every day. 2nd consecutive kill proposal.
  - `copy-regime-mid` — n=146, net=−1.516, drop3=−4.512, stress=−2.990, monthly=−7.58 SOL. Same pattern. 2nd proposal.
  - `copy-regime-hi` — n=76, net=−3.493 (already past catastrophic threshold of < −3 at n≥40). drop3=−5.507. 2nd proposal.

**New strategies to try:** None this cycle. Three hotlead variants (deep, strict, hold30m) are already within striking distance of the promotion bar — adding more strategies before clearing the kill list creates noise, not signal. The priority is: promote hotlead, kill the 4 confirmed losers, and wait for hotlead-deep to clear n=100.

**Operator next steps (priority order):**
1. **Kill `copy-consensus2-lag-drift5-live-micro`** — this is the most urgent: it's live money losing at −3.44 SOL/month. Remove from `COPY_STRATEGIES`.
2. **Promote `copy-hotlead` to live-micro** — all gates clear, score 100, confirmed over 3 days. Add `executionMode: "live_micro"` to its entry in `COPY_STRATEGIES`.
3. **Kill `copy-macro`, `copy-regime-mid`, `copy-regime-hi`** — second consecutive kill proposal; these have been running in the red for days and macro is now turning further against them.

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
