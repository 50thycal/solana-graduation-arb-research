# Copy-Trade Journal

Daily review log for the copy-trading subsystem, maintained by the `/copy-daily-report` skill.
Newest entry first. Each entry has a machine-readable `SNAPSHOT` block (used by the next day's
run to compute day-over-day deltas — do not hand-edit it) followed by human prose.

**Bar:** a copy strategy is promotable only with realistic execution (5s entry delay) AND n≥100 AND
drop_top3>0 AND exit_stress>0 AND monthly≥3.75 SOL. Idealized 1:1 mirrors are upper-bound references,
never live candidates. Roster changes are code edits to `COPY_STRATEGIES` (operator-approved), not
`strategy-commands.json`. Recommendations here are proposals.

---

## 2026-07-06 — Daily review: regime snaps 3→9 ("weak"→"strong") and copy-hotlead-strict fully reverses yesterday's erosion to post its best-ever cushion (drop3 +9.07) on its 10th consecutive promotable day, while copy-hotlead-strict-hi surges to n=77 within reach of a second promotion case; two unprompted discovery-side additions (gradspec, hotlead-early) land overnight

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-07-06",
  "overall": {"n": 6301, "net": -6.3175, "drop3": -20.4637, "stress": -71.0921, "open": 34},
  "retired_summary": {"n": 24790, "net": -206.6032},
  "regime_score": 9, "regime_24h": 9, "macro_score": 7, "btc_7d_pct": 4.42,
  "book_daily_today": 14.28,
  "leads": {"n_leads": 170, "hot": 53, "cold": 79},
  "n_promotable_realistic": 1,
  "strategies": [
    {"id": "copy-hotlead-strict",         "realistic": true,  "n": 731, "net": 15.656, "drop3":  9.074, "stress":  7.814, "promo_score": 100,  "verdict": "PROMOTE"},
    {"id": "copy-hotlead-strict-hi",      "realistic": true,  "n":  77, "net":  7.105, "drop3":  4.934, "stress":  6.170, "promo_score":  95.4,"verdict": "WATCH"},
    {"id": "copy-hotlead-early",          "realistic": true,  "n":   6, "net":  1.624, "drop3":  0.023, "stress":  1.530, "promo_score":  51.8,"verdict": "WATCH"},
    {"id": "copy-fable-freshdip",         "realistic": true,  "n":  16, "net":  0.483, "drop3": -1.359, "stress":  0.309, "promo_score":  41.3,"verdict": "WATCH"},
    {"id": "copy-src-external",           "realistic": true,  "n":   4, "net":  0.445, "drop3": -0.135, "stress":  0.395, "promo_score":  39.7,"verdict": "WATCH"},
    {"id": "copy-tp100-sl30-lag",         "realistic": true,  "n": 792, "net":-20.339, "drop3":-25.187, "stress":-28.090, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-src-winner-sniper-v2",   "realistic": true,  "n":   0, "net":  0,     "drop3":  0,     "stress":  0,     "promo_score":  20,  "verdict": "WATCH"},
    {"id": "copy-src-gradspec",           "realistic": true,  "n":   0, "net":  0,     "drop3":  0,     "stress":  0,     "promo_score":  20,  "verdict": "WATCH"},
    {"id": "copy-conviction-consensus2",  "realistic": false, "n":1417, "net": 16.613, "drop3":  3.826, "stress":  1.685, "promo_score":  76.8,"verdict": "KEEP"},
    {"id": "copy-tp100-sl30",            "realistic": false, "n":3258, "net":-27.904, "drop3":-34.461, "stress":-60.904, "promo_score":  20,  "verdict": "KEEP"}
  ]
}
```

**Headline:** The copy-book regime score snapped from 3 ("weak") to 9 ("strong") overnight — the sharpest single-day recovery in the journal's history — and `copy-hotlead-strict` fully reversed yesterday's cushion erosion to post its best reading yet (drop3 +9.07, up from +4.18), its 10th consecutive promotable day, still with zero live capital deployed. `copy-hotlead-strict-hi` surged from n=56 to n=77 (promo score 78.6→95.4) and is now one good day from a second n≥100 promotion case. Two new probes — `copy-hotlead-early` and `copy-src-gradspec` — appeared overnight via commit `0b011ec` ("Spawn GRADSPEC discovery source + copy-hotlead-early challenger, phase-1 handoff 2026-07-05"), unprompted by this skill but consistent with the operator's faster-than-daily iteration pattern.

**Day-over-day (vs 2026-07-05 SNAPSHOT):**
- **`copy-hotlead-strict` — full reversal, best-ever cushion, 10th consecutive promotable day.** net 10.764→**15.656** (+4.89), drop3 4.181→**9.074** (+4.89), stress 3.276→**7.814** (+4.54) on 25 new trades. This is the largest single-day gain in the journal's history for this strategy and the highest drop3/stress readings it has ever posted — confirms yesterday's erosion was regime noise, not a new decay trend. Monthly run-rate climbed to 33.55 SOL/mo (from 23.06). Still the only strategy in the roster with zero negative-drop3 days ever, and still no live capital deployed anywhere.
- **`copy-hotlead-strict-hi` — the day's biggest mover, closing in on n=100.** n 56→**77** (+21), net 3.068→7.105 (+4.04), drop3 0.989→4.934 (+3.95), stress 2.430→6.17 (+3.74). Promo score jumped **78.6→95.4 (+16.8, >10pt mover)** — all gates already read as if they'd clear at n≥100 (drop3, stress, monthly run-rate of 42.63 SOL/mo all comfortably positive). One more day of trades at this pace crosses the n=100 line and this becomes the second realistic promotion case in the roster.
- **`copy-conviction-consensus2` (idealized reference) — full reversal in lockstep with the live book.** Promo score **35→76.8 (+41.8, the largest mover of the day)**, drop3 flipped from −1.283 (negative, flagged yesterday) back to **+3.826**, stress flipped from −2.921 to **+1.685**. This mirrors `copy-hotlead-strict`'s reversal almost exactly in direction and confirms yesterday's softening was a shared regime effect across the whole book, not strategy-specific — as flagged in yesterday's entry.
- **`copy-tp100-sl30-lag` — still deep in KILL territory, only a small relief move.** net −21.648→−20.339 (+1.31), drop3 −26.496→−25.187 (+1.31), stress −28.600→−28.090 (+0.51) on 75 new trades. Every metric ticked up with the book-wide good day, but the magnitude (+1.3) is trivial against the −25 hole — still failing every gate, still the longest unbroken decay history in the roster before today's marginal bounce.
- **`copy-fable-freshdip`** grew n 10→16 (+6), net −1.223→0.483 (+1.71), stress −1.301→0.309 (+1.61), but **drop3 stayed negative** (−1.380→−1.359, +0.02 — essentially flat). Still far too small for a verdict.
- **`copy-src-external`** ticked down slightly: n 2→4, net 0.561→0.445 (−0.12), drop3 flipped to −0.135. Still n=4, noise.
- **`copy-src-winner-sniper-v2`** — second straight day at n=0. Per `discovery_scorecard`, its funnel has scored 30 candidates and found only 1 smart+copyable wallet since the 07-02 reset — the pipeline is barely producing candidates, not yet a P&L question.
- **Two new probes appeared overnight (commit `0b011ec`, not proposed by this skill):**
  - **`copy-src-gradspec`** (n=0) — a fresh discovery-source experiment reseeding the winner-prefilter forward gate from the `post_grad_amm` smart-money-timing archetype instead of the 0-30s winner-credit seed. Pre-registered success criteria in `discovery_scorecard`: P1 smart_copyable≥10 in 5 days (shelve if <3 by day 7), P2 beats the OG control on drop3/trade at n≥100, P3 n≥100 within ~3 weeks. Funnel currently shows 0 candidates / 2 smart_copyable — day 1, too early to read.
  - **`copy-hotlead-early`** (n=6) — config is byte-identical to `copy-hotlead-strict` (same tp/sl, 5s delay, drift 10, hot-lead gate) but its gate-skip funnel includes a `too_late: 150` reason not present anywhere in `copy-hotlead-strict`'s funnel — implying a hidden entry-timing cutoff (likely testing whether entering earlier in a lead's trade sequence adds edge) not exposed in the JSON config schema. Too small (n=6) to read; net/drop3/stress all marginally positive on this first batch.
- **Regime score snapped 3→9** (weak→strong, the sharpest single-day move recorded), `score_24h` also jumped 5→9. Macro ticked up 6→7 (tailwind), BTC 7d% eased slightly 6.03%→4.42% (still solidly positive).
- **Book P&L confirms the reversal, and yesterday's "down day" firmed up positive.** `regime.swing.daily` now shows 07-05 closed at **+4.19 SOL** (not the −4.13 partial reading reported in yesterday's entry — another instance of a partial-day read flipping sign by close), and today's partial reading is **+14.28 SOL**, the best day in the visible window (07-03: +0.32, 07-04: −21.53, 07-05: +4.19, 07-06: +14.28).
- **Lead pool grew slightly:** 169→170 leads, hot flat at 53, cold flat at 79.
- **Bot health:** `diagnose.json` verdict is HEALTHY, all levels passing, WS connected, graduations flowing normally.

**Week-over-week (Jun 30 → Jul 06, 7 entries):**
- **`copy-hotlead-strict` remains the only strategy that has never had a negative drop3 day**, now 10+ consecutive promotable days, and today set its best-ever cushion reading after a one-day erosion scare — the pattern across two weeks is "cushion dips for a day, then fully recovers," never a sustained decay. This is the strongest live-micro promotion case the roster has produced, and it keeps getting stronger with age.
- **`copy-hotlead-strict-hi` has now grown from n=21 (07-03) → 48 → 56 → 77 (today)** over four straight days, with its promo score climbing 56→81.3→78.6→95.4 in step. It is on track to become the second realistic promotion case within the next 1-2 daily reads.
- **Regime/book pattern this week: high volatility, not a clean trend.** −21.53 (07-04) → +4.19 (07-05, confirmed) → +14.28 (07-06 partial) — a sharp V-shaped recovery from the week's one bad day, echoing the 4-day recovery/2-day dip/recovery whipsaw seen since the late-June drawdown. Macro/BTC has stayed a steady tailwind all week (score 6-7, BTC 7d% positive every reading) while the copy-book tape itself swings much harder — the disconnect flagged last week (strengthening macro vs. weaker book) has now resolved in the book's favor.
- **Lead pool** has grown gradually all week: 53 hot today vs. the 49-51 plateau of two weeks ago — slow, steady growth, no plateau or reversal.
- **Operational pattern continues:** another roster addition (`gradspec`, `hotlead-early`) landed outside this skill's proposal cycle, the fourth such unprompted change in the last week. The operator/other sessions continue to iterate faster than the daily cadence — this skill's role remains "confirm and audit," not "originate."

**Verdicts (proposals — roster changes require operator approval + code edit to `COPY_STRATEGIES`):**

- **PROMOTE (1, unchanged):**
  - `copy-hotlead-strict`: n=731, net=+15.66, drop3=+9.07, stress=+7.81, monthly=33.55 SOL/mo. Score 100, all gates clear, 10th consecutive promotable day, best-ever cushion reading after fully reversing yesterday's dip. Still the only strategy in the roster with zero negative-drop3 days ever, and still no live capital deployed anywhere — the case for funding a live-micro test is now as strong as it has ever been.

- **KILL (1 carried over, unenacted):**
  - `copy-tp100-sl30-lag`: n=792, net=−20.34, drop3=−25.19, stress=−28.09. 9+ consecutive days of failing every gate; today's book-wide good day only produced a trivial +1.3 SOL bounce. The exit shape (tp100/sl30), not the lag mechanism, remains the culprit per the `paired_vs_baseline` comparison.

- **WATCH:**
  - `copy-hotlead-strict-hi`: n=77 (up from 56), promo score 95.4 (up from 78.6) — the closest strategy to a second promotion case; likely crosses n=100 within 1-2 days.
  - `copy-hotlead-early`: n=6, new overnight addition (commit `0b011ec`), config identical to `copy-hotlead-strict` but with a distinct `too_late` gate-skip reason implying a hidden entry-timing variant. Too small for any read.
  - `copy-src-gradspec`: n=0, new overnight addition, pre-registered discovery-source experiment (`post_grad_amm` reseed) with explicit P1/P2/P3 success gates in `discovery_scorecard`. Day 1 — watch the funnel candidate count over the next 5 days per its own pre-registered checkpoint.
  - `copy-fable-freshdip`: n=16, drop3 still negative (−1.36) though net/stress turned positive. Still too small.
  - `copy-src-external`: n=4. Still far too small.
  - `copy-src-winner-sniper-v2`: n=0 for the 2nd straight day; funnel has found only 1 smart+copyable wallet from 30 scored candidates since the 07-02 reset — a discovery-pipeline stall, not yet a P&L question.

- **Idealized references (not live candidates):**
  - `copy-conviction-consensus2`: n=1417, net=+16.61. Drop3 and stress both flipped back positive in lockstep with the live book's reversal (promo score 35→76.8) — confirms yesterday's softening was a shared regime effect, not strategy-specific.
  - `copy-tp100-sl30`: n=3258, net=−27.90. Negative baseline reference, improved slightly with the book-wide good day but still deeply negative.

**New strategies to try:** None this cycle. Two fresh experiments (`copy-src-gradspec`, `copy-hotlead-early`) already landed overnight with their own pre-registered or implicit hypotheses, and `copy-hotlead-strict-hi` is about to generate real promotion data within days — per the redundancy guardrail, the right move is watching what's already cooking rather than adding more.

**Operator next step:** The live-micro case for `copy-hotlead-strict` is now the strongest it has ever been — 10 consecutive promotable days, best-ever cushion reading today, zero live capital deployed anywhere in the roster. Recommend funding a live-micro test at `MICRO_TRADE_SIZE_SOL`. Secondary: enact the long-standing `copy-tp100-sl30-lag` KILL (9+ days failing every gate). Also worth watching closely: `copy-hotlead-strict-hi` is one good day from crossing n=100 and generating a second real promotion case.

---

## 2026-07-05 — Daily review: overnight operator-approved roster prune (hold30m + xbad retired, live_tape dropped, winner-sniper reset to v2) coincides with the sharpest regime drop in weeks (7→3) and a confirmed hard down-day, as copy-hotlead-strict's cushion erodes for the first time since 07-03's recovery began

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-07-05",
  "overall": {"n": 6043, "net": -28.9131, "drop3": -43.0593, "stress": -90.5784, "open": 19},
  "retired_summary": {"n": 24790, "net": -206.6032},
  "regime_score": 3, "regime_24h": 5, "macro_score": 6, "btc_7d_pct": 6.03,
  "book_daily_today": -4.13,
  "leads": {"n_leads": 169, "hot": 53, "cold": 79},
  "n_promotable_realistic": 1,
  "strategies": [
    {"id": "copy-hotlead-strict",         "realistic": true,  "n": 706,  "net": 10.764, "drop3":  4.181, "stress":  3.276, "promo_score": 100,  "verdict": "PROMOTE"},
    {"id": "copy-hotlead-strict-hi",      "realistic": true,  "n":  56,  "net":  3.068, "drop3":  0.989, "stress":  2.430, "promo_score":  78.6,"verdict": "WATCH"},
    {"id": "copy-src-external",           "realistic": true,  "n":   2,  "net":  0.561, "drop3":  0,     "stress":  0.529, "promo_score":  40.7,"verdict": "WATCH"},
    {"id": "copy-tp100-sl30-lag",         "realistic": true,  "n": 717,  "net":-21.648, "drop3":-26.496, "stress":-28.600, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-fable-freshdip",         "realistic": true,  "n":  10,  "net": -1.223, "drop3": -1.380, "stress": -1.301, "promo_score":  22,  "verdict": "WATCH"},
    {"id": "copy-src-winner-sniper-v2",   "realistic": true,  "n":   0,  "net":  0,     "drop3":  0,     "stress":  0,     "promo_score":  20,  "verdict": "WATCH"},
    {"id": "copy-conviction-consensus2",  "realistic": false, "n":1378,  "net": 11.503, "drop3": -1.283, "stress": -2.921, "promo_score":  35,  "verdict": "KEEP"},
    {"id": "copy-tp100-sl30",            "realistic": false, "n":3174,  "net":-31.937, "drop3":-38.494, "stress":-63.991, "promo_score":  20,  "verdict": "KEEP"}
  ]
}
```

**Headline:** Overnight the operator enacted a roster prune (`6da2ff5`: retire `copy-hotlead-hold30m` + `copy-hotlead-strict-xbad`, prune the `live_tape` discovery source; `d5e8171`: reset `copy-src-winner-sniper` to a clean-funnel `-v2`) — coinciding with the sharpest regime-score drop in weeks (7→3, "weak" band) and a confirmed hard down-day, as `copy-hotlead-strict`'s promotion cushion eroded for the first time since the 07-03 recovery began.

**Day-over-day (vs 2026-07-04 SNAPSHOT):**
- **Roster prune enacted, both pending kills plus two housekeeping drops.** `copy-hotlead-hold30m` (this journal's carried-over KILL since 07-03) is gone; so are `copy-hotlead-strict-xbad` (n=28, drop3 had just flipped negative) and `copy-src-live-tape` (n=3, discovery funnel just found wallets yesterday — pruned anyway per commit `6da2ff5`, labeled U1/U4/U6 operator-approved). `retired_summary` grew n 23430→24790 (+1360) and net −225.15→**−206.60** (+18.55), consistent with folding in `hold30m`'s large positive net. `copy-src-winner-sniper` (n=57, unfavorable early read flagged yesterday) was replaced with a fresh **`copy-src-winner-sniper-v2`** (n=0, commit `d5e8171` — "clean funnel measurement," gating on the winner-sniper discovery signal rather than its own P&L this time).
- **`copy-hotlead-strict` cushion eroded sharply — first reversal since the 07-03 recovery began.** net 12.907→**10.764** (−2.14), drop3 6.324→**4.181** (−2.14), stress 5.583→**3.276** (−2.31) on 20 new trades. This breaks the 2-day growth streak (07-03→07-04) and is the largest single-day erosion since the historic-drawdown stretch in late June. All gates still clear comfortably (drop3, stress both solidly positive, monthly run-rate 23.06 SOL/mo) — **9th consecutive promotable day** — but this is the second erosion episode in two weeks and worth a close look tomorrow given today's regime backdrop.
- **`copy-hotlead-strict-hi` softened in step.** n 48→56 (+8), net 3.414→3.068 (−0.35), drop3 1.335→0.989 (−0.35), stress 2.851→2.430 (−0.42). Promo score fell 81.3→78.6 (−2.7) — the surge flagged yesterday paused; still under n=100.
- **`copy-tp100-sl30-lag` KILL proposal reconfirmed, still unenacted, deteriorating for well over a week straight.** net −19.317→**−21.648** (−2.33), drop3 −24.164→**−26.496** (−2.33), stress −25.522→**−28.600** (−3.08) on 77 new trades. Every metric worse again today. Its `paired_vs_baseline` delta is a small positive (+1.09 SOL / +0.004 per event over 263 shared events with the idealized baseline) — the 5s-lag mechanism itself isn't the main driver of the loss, the underlying tp100/sl30 exit shape is.
- **`copy-fable-freshdip` — first real negative signal.** n 4→10 (+6), net −0.100→**−1.223** (−1.12), drop3 −0.243→**−1.380** (−1.14), stress −0.140→**−1.301** (−1.16). Still far too small (n=10) for a verdict, but every metric moved the wrong way on its first real batch of trades.
- **`copy-conviction-consensus2` (idealized reference) — drop3 flipped negative for the first time in weeks.** net 13.888→11.503 (−2.39), **drop3 1.102→−1.283** (−2.39, sign flip), stress −0.316→−2.921 (−2.61). Promo score fell 48.8→**35** (−13.8, a >10pt mover). Not a live candidate regardless, but the idealized book-wide ceiling weakening in step with `copy-hotlead-strict` points to a shared regime effect rather than something strategy-specific.
- **Regime score dropped sharply: 7→3** ("weak" band, the lowest reading since the late-June drawdown), while `score_24h` actually improved 2→5 — an inverse divergence from the last two entries (intraday tape now the worse signal, 24h outlook the better one). Macro held flat at 6 (tailwind); BTC 7d% kept improving (4.09%→6.03%).
- **Book P&L confirms yesterday's reversal was real, not partial-day noise — and worse than first read.** `regime.swing.daily` shows 07-04 closed at **−21.53 SOL** (nearly double the −11.32 partial-day estimate reported in yesterday's entry) and today's partial reading (through the sync cutoff) is −4.13. The 4-day recovery streak (07-01 through 07-03) is now confirmed broken by a real down-day, not noise.
- **Lead pool grew slightly:** 162→169 leads (+7), hot 51→53 (+2), cold 78→79 (+1).

**Week-over-week (Jun 29 → Jul 05, 7 entries):**
- **`copy-hotlead-strict` remains the only strategy that has never had a negative drop3 day**, now 9+ consecutive promotable days. But today's erosion is the second cushion-shrinking episode in two weeks (the first ran 07-01→07-02, driven by the late-June drawdown working through the trailing window) — worth confirming tomorrow whether this is a one-day blip tied to today's weak regime reading, or the start of a new multi-day erosion streak like the last one.
- **The operator continues to iterate faster than this skill's daily cadence**, and the lag between a KILL call landing here and the code edit is shrinking: `hold30m` went proposal (07-03) → enacted (07-05), a 2-day lag, down from the ~1-2 day average noted last week but still not same-day. Three roster changes landed outside this skill's proposal cycle in the last 3 days (`copy-hotlead` kill, unprompted `winner-sniper`/`freshdip` additions, and now this prune + v2 reset).
- **Regime/book pattern: the 4-day recovery (06-30→07-03) has now fully reversed** — two down-days in a row (07-04 confirmed −21.53, 07-05 partial −4.13) and today's regime score (3, "weak") is the lowest since the drawdown itself. Macro/BTC keeps strengthening in the background regardless (tailwind band held all week, BTC 7d% positive and rising every reading) — the disconnect between an improving macro backdrop and a weakening copy-book tape is now a full week old and worth flagging as a durable pattern, not a one-off.
- **Lead pool** has grown modestly from the 49-51 hot plateau of the last two weeks to 53 hot today — the first real growth in the lead pool since the 06-30 recovery, though still gradual.
- **`copy-tp100-sl30-lag`** has now deteriorated on every single metric for 8+ consecutive daily reads — the longest unbroken decay streak of any strategy in the journal's history. The KILL case here is now as strong as any carried-over recommendation has ever been.

**Verdicts (proposals — roster changes require operator approval + code edit to `COPY_STRATEGIES`):**

- **PROMOTE (1, unchanged):**
  - `copy-hotlead-strict`: n=706, net=+10.76, drop3=+4.18, stress=+3.28, monthly=23.06 SOL/mo. Score 100, all gates clear, 9th consecutive promotable day. Cushion eroded sharply today (−2.14 SOL on net/drop3) — still the only strategy in the roster with zero negative-drop3 days ever, and still no live capital deployed anywhere, but recommend one more day of confirmation before treating today's erosion as pure regime noise.

- **KILL (1 carried over, 3 enacted since yesterday):**
  - `copy-tp100-sl30-lag` (carried over): n=717, net=−21.65, drop3=−26.50, stress=−28.60. 8+ consecutive days of deterioration on every metric — the longest unbroken decay streak in the journal. Its lag mechanism isn't the culprit (paired-vs-baseline delta is slightly positive); the tp100/sl30 exit shape itself is the problem.
  - `copy-hotlead-hold30m`, `copy-hotlead-strict-xbad`, `copy-src-live-tape` (all **enacted** — retired/pruned overnight per commit `6da2ff5`, operator-approved). No further action needed.

- **WATCH:**
  - `copy-hotlead-strict-hi`: n=56 (up from 48), promo score 78.6 (down from 81.3) — the surge flagged yesterday paused; still the closest strategy behind `copy-hotlead-strict` for a second promotion case once it clears n=100.
  - `copy-fable-freshdip`: n=10, first real negative batch (drop3 −0.24→−1.38). Still far too small for a verdict, but the reversal tempers earlier optimism about this thesis.
  - `copy-src-winner-sniper-v2`: n=0, brand-new reset of the winner-sniper thesis to isolate the discovery-signal-only gate (commit `d5e8171`). Watch its first batch of trades before drawing any conclusion — the prior version's unfavorable early read (worse net/trade and drop3/trade than its own control) is exactly what this reset is meant to fix or confirm.
  - `copy-src-external`: n=2. Still far too small.

- **Idealized references (not live candidates):**
  - `copy-conviction-consensus2`: n=1378, net=+11.50. Drop3 flipped negative for the first time in weeks (+1.10→−1.28), stress fell further negative — the idealized ceiling weakened in step with the live book, consistent with a shared regime effect rather than a strategy-specific problem.
  - `copy-tp100-sl30`: n=3174, net=−31.94. Negative baseline reference, roughly flat day-over-day.

**New strategies to try:** None this cycle. The roster already has a fresh, unresolved experiment (`copy-src-winner-sniper-v2`) from last night's reset, and today's story is a book-wide regime dip rather than a strategy-specific gap — the redundancy guardrail plus the "don't act on one bad day" rule both point to watching what's already cooking rather than adding more.

**Operator next step:** Two actions, in order of leverage: (1) fund a live-micro test on `copy-hotlead-strict` — 9 consecutive promotable days now, still zero live capital deployed anywhere, though worth watching one more day to confirm today's cushion erosion is regime noise and not a new decay trend; (2) enact the long-standing `copy-tp100-sl30-lag` KILL — thanks for clearing the other three overnight (`hold30m`, `xbad`, `live_tape`). Also worth a look: the copy book has now had 2 down-days in a row against a strengthening macro/BTC backdrop — if that gap keeps widening it may be worth a regime-gate tightening pass, but one more day of data would help before proposing that concretely.

---

## 2026-07-04 — Daily review: copy-hotlead's carried-over KILL finally enacted; copy-hotlead-strict hits an 8th consecutive promotable day as copy-hotlead-strict-hi surges toward it, even as today's partial book day snaps the 4-day recovery streak

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-07-04",
  "overall": {"n": 7002, "net": 3.9747, "drop3": -27.1535, "stress": -68.2261, "open": 97},
  "retired_summary": {"n": 23430, "net": -225.1496},
  "regime_score": 7, "regime_24h": 2, "macro_score": 6, "btc_7d_pct": 4.09,
  "book_daily_today": -11.3177,
  "leads": {"n_leads": 162, "hot": 51, "cold": 78},
  "n_promotable_realistic": 1,
  "strategies": [
    {"id": "copy-hotlead-strict",         "realistic": true,  "n": 686,  "net": 12.907, "drop3":  6.324, "stress":  5.583, "promo_score": 100,  "verdict": "PROMOTE"},
    {"id": "copy-hotlead-strict-hi",      "realistic": true,  "n":  48,  "net":  3.414, "drop3":  1.335, "stress":  2.851, "promo_score":  81.3,"verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m",        "realistic": true,  "n":1110,  "net": 27.249, "drop3": -3.879, "stress": 15.271, "promo_score":  75,  "verdict": "KILL"},
    {"id": "copy-hotlead-strict-xbad",    "realistic": true,  "n":  28,  "net":  0.862, "drop3": -1.134, "stress":  0.556, "promo_score":  46.2,"verdict": "WATCH"},
    {"id": "copy-src-external",           "realistic": true,  "n":   1,  "net":  0.513, "drop3":  0,     "stress":  0.492, "promo_score":  40.1,"verdict": "WATCH"},
    {"id": "copy-tp100-sl30-lag",         "realistic": true,  "n": 640,  "net":-19.317, "drop3":-24.164, "stress":-25.522, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-src-winner-sniper",      "realistic": true,  "n":  57,  "net": -2.654, "drop3": -4.232, "stress": -3.188, "promo_score":  31.4,"verdict": "WATCH"},
    {"id": "copy-fable-freshdip",         "realistic": true,  "n":   4,  "net": -0.100, "drop3": -0.243, "stress": -0.140, "promo_score":  20.8,"verdict": "WATCH"},
    {"id": "copy-src-live-tape",          "realistic": true,  "n":   3,  "net": -0.547, "drop3":  0,     "stress": -0.567, "promo_score":  20.6,"verdict": "WATCH"},
    {"id": "copy-conviction-consensus2",  "realistic": false, "n":1352,  "net": 13.888, "drop3":  1.102, "stress": -0.316, "promo_score":  48.8,"verdict": "KEEP"},
    {"id": "copy-tp100-sl30",            "realistic": false, "n":3073,  "net":-32.240, "drop3":-38.796, "stress":-63.247, "promo_score":  20,  "verdict": "KEEP"}
  ]
}
```

**Headline:** Overnight, the operator finally enacted yesterday's carried-over `copy-hotlead` KILL (it and its `hold30m-pair-shadow` are retired) — meanwhile `copy-hotlead-strict` extended its promotable streak to 8 consecutive days with its cushion still growing, `copy-hotlead-strict-hi` surged toward promotion-grade numbers (promo score 56→81.3), and two brand-new, unprompted strategies (`copy-src-winner-sniper`, `copy-fable-freshdip`) appeared in the roster, while today's partial book day (−11.32 SOL) snapped the 4-day recovery streak flagged yesterday.

**Day-over-day (vs 2026-07-03 SNAPSHOT):**
- **`copy-hotlead` KILL enacted.** It (n=1099 at last read, net+3.88/drop3−3.14/stress−7.52, carried as a KILL proposal for 2 days) is gone from today's `by_strategy` — `retired_summary` grew n 21811→23430 (+1619) and net −227.92→−225.15 (+2.77), consistent with `copy-hotlead` and `copy-hotlead-hold30m-pair-shadow` (n=500, net−0.51) both being retired together. Neither kill was proposed for the shadow specifically, but retiring it alongside its now-decaying parent (`hold30m`) is reasonable housekeeping.
- **`copy-hotlead-strict` — 8th consecutive promotable day, cushion still growing.** net 12.063→**12.907** (+0.84), drop3 5.480→**6.324** (+0.84), stress 5.157→**5.583** (+0.43) on 39 new trades. Monthly run-rate climbed to 27.66 SOL/mo. This is the second straight day of cushion growth after the 3-day erosion streak resolved yesterday — the strongest and now-longest-standing promotion case in the roster's history, and still no live capital deployed anywhere.
- **`copy-hotlead-strict-hi` surged — the biggest mover of the day.** n 21→48 (+27), net 1.906→3.414 (+1.51), drop3 0.025→1.335 (+1.31), stress 1.652→2.851 (+1.20). Promo score jumped **56→81.3 (+25.3)** — the largest single-day move in the roster. Still under n=100 so not yet gate-eligible, but if this trajectory holds it's the next strategy in line behind `copy-hotlead-strict` for a promotion case.
- **`copy-hotlead-strict-xbad` — first negative signal since its launch.** drop3 flipped **+0.106 → −1.134** on n 6→28 (+22 trades), promo score fell 57.5→46.2 (−11.3, a >10pt mover). Last cycle called this "the most promising new idea in the roster" — today's data tempers that. Still far too small (n=28) for any verdict per the small-n rule; flagging the reversal to track, not acting on it.
- **`copy-hotlead-hold30m` KILL proposal reconfirmed, still unenacted.** drop3 continued to worsen: −2.661→**−3.879** (3rd+ consecutive negative day, each worse than the last), stress declined 16.990→15.271 but stayed positive, net dipped slightly 28.467→27.249. The grace window closed yesterday with a KILL call; today's data gives no reason to reconsider.
- **`copy-tp100-sl30-lag` KILL proposal reconfirmed, still unenacted, still deteriorating.** net −14.969→**−19.317** (−4.35), drop3 −19.517→**−24.164** (−4.65), stress −20.119→**−25.522** (−5.40) on 111 new trades — every metric worse, every day, for over a week running.
- **Two brand-new, unprompted strategies appeared:** `copy-src-winner-sniper` (n=0→57 in one day — a large first-day jump, 40 of 97 entered positions still open) and `copy-fable-freshdip` (n=0→4). Neither was proposed by this skill. `winner-sniper`'s early numbers are unfavorable: per `discovery_scorecard`, its net/trade (−0.0466) and drop3/trade (−0.0742) are both currently worse than the `copy-tp100-sl30-lag` control (−0.0302 / −0.0378) — the bar it must clear at n≥100 to validate the "winner-hit precision" sourcing thesis. Too early to call (n=57<100), but the early read leans against the thesis so far.
- **`copy-src-live-tape` funnel finally found wallets.** `discovery_scorecard` shows `smart_copyable: 25` (up from 0/`NO_WALLETS` yesterday) — the live-tape harvester pipeline is no longer stuck. The probe itself is still tiny (n=3, net−0.55) with an unusually high open-position count (21 open vs. 3 closed) — too early to read the P&L, but the discovery-side blocker is resolved.
- **`copy-conviction-consensus2` (idealized reference) — stress flipped negative** (+0.331→**−0.316**) for the first time since the recovery began, promo score fell 55.7→48.8 (−6.9). Not a live candidate regardless, but a mild softening signal for the book-wide ceiling.
- **Regime eased slightly:** 8→7 (still "favorable" band), `score_24h` 3→2 (24h outlook still cautious, continuing the divergence flagged yesterday). Macro held flat at 6 (tailwind); BTC 7d% continued improving (3.2%→4.09%).
- **Lead pool essentially flat:** 161→162 leads, hot 50→51 (+1), cold flat at 78.
- **Book P&L reversed today.** The 4-day recovery streak called out yesterday (06-30: −78.13 → 07-01: −32.68 → 07-02: −5.80 → 07-03: +8.31) broke: today's partial day (through 10:00 UTC) sits at **−11.32 SOL**. It's a partial day and could still move, but it's the first red day since the historic drawdown resolved — worth confirming at day-close tomorrow, not yet actionable.

**Week-over-week (Jun 30 → Jul 04, 5 entries):**
- **`copy-hotlead-strict` remains the only strategy that has never had a negative drop3 day**, now 8+ consecutive promotable days, having weathered the worst drawdown on record and now showing 2 straight days of cushion growth. The case for a live-micro test has only strengthened all week; there is still zero live capital deployed anywhere in the roster.
- **`copy-hotlead` and `copy-hotlead-hold30m` both completed their decay arcs this week** — `copy-hotlead` was called KILL on 07-02, confirmed again on 07-03, and finally retired overnight into today's snapshot; `copy-hotlead-hold30m` followed the same script one day behind (KILL called 07-03, still pending enactment). The operator is now averaging roughly a 1-2 day lag between this skill's KILL call and the code edit landing.
- **Regime/book recovery, which was a confirmed 4-day trend through 07-03, broke today** — first red partial-day since the 06-29/06-30 crash resolved. Macro/BTC continues to strengthen in the background (tailwind band held 3 straight days, BTC 7d% positive and rising for 5 straight readings), so today's book dip looks like idiosyncratic tape noise rather than a fresh macro headwind — but worth one more day of confirmation either way.
- **Lead pool** has been essentially flat (49-51 hot) for a full week after recovering from the 06-30 trough (46) — a stable plateau, no further growth or decay.
- **Operational pattern continues:** a third roster change in 4 days landed outside this skill's proposal cycle (the `copy-hotlead` kill, plus the unprompted `copy-src-winner-sniper` / `copy-fable-freshdip` additions) — consistent with last week's note that other sessions are iterating faster than the daily cadence proposes changes.

**Verdicts (proposals — roster changes require operator approval + code edit to `COPY_STRATEGIES`):**

- **PROMOTE (1, unchanged):**
  - `copy-hotlead-strict`: n=686, net=+12.91, drop3=+6.32, stress=+5.58, monthly=27.66 SOL/mo. Score 100, all gates clear, 8th consecutive promotable day, cushion growing for the 2nd straight day. Still the only strategy in the roster with zero negative-drop3 days ever, and still no live capital deployed anywhere.

- **KILL (2 carried over, 1 enacted since yesterday):**
  - `copy-hotlead-hold30m` (carried over): n=1110, net=+27.25, drop3=−3.88 (worsening for the 3rd+ straight day), stress=+15.27 (still strong but declining). Robustness-gate failure confirmed again; net/stress remain the best absolute economics in the roster if the operator wants to keep it as a shadow reference instead of fully retiring it.
  - `copy-tp100-sl30-lag` (carried over): n=640, net=−19.32, drop3=−24.16, stress=−25.52. Long-running realistic strategy, deteriorating every day for over a week.
  - `copy-hotlead` (**enacted** — no longer in the roster, retired alongside `copy-hotlead-hold30m-pair-shadow`). No further action needed.

- **WATCH:**
  - `copy-hotlead-strict-hi`: n=48 (up from 21), promo score 81.3 (up from 56, the day's biggest mover). Closest strategy to `copy-hotlead-strict` for a second promotion case — watch closely as it approaches n=100.
  - `copy-hotlead-strict-xbad`: n=28, drop3 flipped negative (+0.11→−1.13) for the first time. Too small for a verdict; the reversal tempers last cycle's optimism but doesn't yet change anything.
  - `copy-src-winner-sniper`: n=57 (new, unprompted addition), net=−2.65, drop3=−4.23. Early read is unfavorable vs. its own control per `discovery_scorecard` (worse net/trade and drop3/trade than `copy-tp100-sl30-lag`); needs n≥100 before a verdict. Worth a quick operator confirmation that this addition (and `copy-fable-freshdip`) were intentional, since neither was proposed here.
  - `copy-fable-freshdip`: n=4 (new, unprompted addition). Far too small to read anything into.
  - `copy-src-live-tape`: n=3, but its discovery funnel just found 25 smart+copyable wallets (up from 0/`NO_WALLETS`) — the pipeline blocker is resolved even though the P&L probe is still too new to judge. 21 open positions vs. 3 closed; check again once more positions resolve.
  - `copy-src-external`: n=1. Still too small.

- **Idealized references (not live candidates):**
  - `copy-conviction-consensus2`: n=1352, net=+13.89. Stress flipped negative (+0.33→−0.32) for the first time since the recovery began — a mild softening signal for the book-wide ceiling, not actionable.
  - `copy-tp100-sl30`: n=3073, net=−32.24. Negative baseline reference, continuing to deteriorate in step with volume.

**New strategies to try:** None this cycle. The roster already picked up two fresh, untested ideas overnight outside this skill's cycle (`copy-src-winner-sniper`, `copy-fable-freshdip`), and `copy-hotlead-strict-hi` is closing in on gate-eligibility as a second promotion case. Priority is watching these mature, not adding more experiments.

**Operator next step:** Three actions, in order of leverage: (1) fund a live-micro test on `copy-hotlead-strict` — 8 consecutive promotable days now, cushion still growing, still zero live capital deployed anywhere; (2) enact the two still-pending kills (`copy-hotlead-hold30m`, `copy-tp100-sl30-lag`) — thanks for clearing `copy-hotlead` overnight; (3) confirm whether `copy-src-winner-sniper` / `copy-fable-freshdip` are intentional additions, and keep an eye on tomorrow's book close to see if today's −11.3 SOL partial day is noise or the start of something (regime/macro backdrop still looks favorable, so leaning toward noise).

---

## 2026-07-03 — Daily review: overnight roster overhaul (V2 selection refuted, xbad veto pivot added) while copy-hotlead-strict's cushion grows for the first time in 4 days; copy-hotlead-hold30m's 3rd straight negative drop3 day converts its grace-period WATCH to KILL

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-07-03",
  "overall": {"n": 8131, "net": 17.7424, "drop3": -13.3858, "stress": -61.7275, "open": 33},
  "retired_summary": {"n": 21811, "net": -227.9222},
  "regime_score": 8, "regime_24h": 3, "macro_score": 6, "btc_7d_pct": 3.2,
  "book_daily_today": 7.908,
  "leads": {"n_leads": 161, "hot": 50, "cold": 78},
  "n_promotable_realistic": 1,
  "strategies": [
    {"id": "copy-hotlead-strict",              "realistic": true,  "n": 647, "net": 12.063, "drop3":  5.480, "stress":  5.157, "promo_score": 100,  "verdict": "PROMOTE"},
    {"id": "copy-hotlead-hold30m",             "realistic": true,  "n":1059, "net": 28.467, "drop3": -2.661, "stress": 16.990, "promo_score":  75,  "verdict": "KILL"},
    {"id": "copy-hotlead",                     "realistic": true,  "n":1099, "net":  3.881, "drop3": -3.139, "stress": -7.517, "promo_score":  55,  "verdict": "KILL"},
    {"id": "copy-hotlead-strict-xbad",         "realistic": true,  "n":   6, "net":  2.102, "drop3":  0.106, "stress":  1.998, "promo_score":  57.5,"verdict": "WATCH"},
    {"id": "copy-hotlead-strict-hi",           "realistic": true,  "n":  21, "net":  1.906, "drop3":  0.025, "stress":  1.652, "promo_score":  56,  "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-pair-shadow", "realistic": true,  "n": 500, "net": -0.506, "drop3": -2.015, "stress": -1.011, "promo_score":  40,  "verdict": "WATCH"},
    {"id": "copy-tp100-sl30-lag",              "realistic": true,  "n": 529, "net":-14.969, "drop3":-19.517, "stress":-20.119, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-src-live-tape",               "realistic": true,  "n":   0, "net":  0,     "drop3":  0,     "stress":  0,     "promo_score":  20,  "verdict": "WATCH"},
    {"id": "copy-src-external",                "realistic": true,  "n":   0, "net":  0,     "drop3":  0,     "stress":  0,     "promo_score":  20,  "verdict": "WATCH"},
    {"id": "copy-conviction-consensus2",       "realistic": false, "n":1317, "net": 14.179, "drop3":  1.393, "stress":  0.331, "promo_score":  55.7,"verdict": "KEEP"},
    {"id": "copy-tp100-sl30",                 "realistic": false, "n":2953, "net":-29.381, "drop3":-35.937, "stress":-59.209, "promo_score":  20,  "verdict": "KEEP"}
  ]
}
```

**Headline:** Another operator-approved roster overhaul landed overnight (commit `37fe405`: V2 positive-selection A/B refuted out-of-sample and killed, replaced by a "proven-bad exclusion" veto pivot, plus a new discovery-source registry) — meanwhile `copy-hotlead-strict`'s promotion cushion grew for the first time in 4 days (+0.70 SOL) even as `copy-hotlead-hold30m`'s drop3 posted its 3rd consecutive negative day, closing out the 07-01 grace window and converting it to KILL.

**Day-over-day (vs 2026-07-02 SNAPSHOT):**
- **Roster overhaul enacted (commit `37fe405`, unprompted by this skill).** `copy-select-v1`, `copy-select-v2`, and `copy-hotlead-strict-v2` are gone from today's `by_strategy` entirely — the operator's own 07-01 walk-forward check flipped the V2 "positive copy-net selection" story on day one (OOS: V2's unique picks lost −2.43 SOL/4 leads, the leads it rejected gained +1.60/34), so all three were killed. `copy-cotrade-tp100-sl30` and its `copy-ogsmart-tp100-sl30` control are also gone (cotrade failed its own resolution rule at n=108). In their place: **`copy-hotlead-strict-xbad`** (n=6) — the pivot — vetoes leads whose last-10-trade copy-net is persistently ≤0 (the one OOS-robust signal found: downside persistence, not upside selection) layered on top of the incumbent `copy-hotlead-strict` gate. Also new: `copy-src-live-tape` / `copy-src-external` (n=0 each), standardized realistic probes replacing the old ad-hoc `copy-livetape`/`copy-external` mirrors under a new discovery-source registry (`discovery_scorecard` in the JSON — live-tape source has 0 smart+copyable wallets so far, verdict `NO_WALLETS`).
- **`copy-hotlead-strict` cushion grew for the first time in 4 days.** drop3 4.78 → **5.48** (+0.70), stress 4.83 → 5.16 (+0.33), net 11.37 → 12.06 (+0.70) on 34 new trades. This breaks the 3-day erosion streak (7.92→6.92→4.78) flagged in the last two entries — the erosion tracked the historic 06-29/06-30 drawdown working through the trailing window, and now that regime has fully rolled off, the cushion is recovering. **7th consecutive promotable day**, monthly run-rate 25.85 SOL/mo.
- **`copy-hotlead-hold30m` — grace window closed, converting WATCH → KILL.** drop3 has now been negative 3 straight days: 07-01 −0.076 (marginal) → 07-02 −2.006 → 07-03 **−2.661** (today), each day worse, not recovering. Yesterday's entry set the explicit trigger: "one more day of negative drop3 and this should convert to KILL too." It did. Net (+28.47) and stress (+16.99) remain strongly positive — this is a drop-top3-only failure, not a collapse — but the mechanical gate rule (n≥100, drop3 negative, no sign of recovery across the full grace window) is met.
- **`copy-hotlead`** continues its confirmed decay: net 4.38→3.88, drop3 −2.64→−3.14, stress −6.51→−7.52. Both robustness gates still failing decisively. KILL proposal carries over, still unenacted in today's roster.
- **`copy-tp100-sl30-lag`** (realistic twin of the idealized baseline) also continues to deteriorate: net −11.27→−14.97, drop3 −15.82→−19.52, stress −15.46→−20.12 on 101 new trades. KILL proposal carries over, still unenacted.
- **`copy-hotlead-strict-hi`** (n=21, up from n=3) and the brand-new **`copy-hotlead-strict-xbad`** (n=6) are both too small to score but both directionally clean — positive net/drop3/stress. Both are variants of the "tighten/refine the strict gate" hypothesis this journal has been recommending; xbad in particular is the most promising fresh idea in weeks (see New strategies below).
- **Regime jumped 5→8 (strong band)** intraday, but `score_24h` fell 5→3 — the instantaneous tape looks strong while the 24h outlook is more cautious; a divergence worth watching, not yet acting on. Macro held flat at 6 (tailwind), BTC 7d% continued improving (1.43%→3.2%).
- **Lead pool essentially flat:** 160→161 leads, hot flat at 50, cold 77→78.
- **Book P&L:** today's partial day (+7.91 SOL, per `regime.swing.daily`) extends the recovery streak — 06-30: −78.13, 07-01: −32.68, 07-02: −5.80, 07-03: **+7.91** — four consecutive days of improvement since the historic drawdown, now solidly positive.

**Week-over-week (Jun 29 → Jul 03, 5 entries):**
- **`copy-hotlead-strict` remains the only strategy that has never had a negative drop3 day**, now 7+ consecutive promotable days including the worst drawdown stretch on record — and today is the first day its cushion grew rather than shrank since the drawdown began working through its trailing window. This is the strongest evidence yet for a live-micro promotion, and the case has only strengthened this week, not weakened.
- **`copy-hotlead-hold30m`** flipped from "converging" (score=100, drop3 growing through 06-28) to fully decaying: 3 consecutive negative drop3 days, each worse than the last, closing out this week with its first KILL call. Its parent (`copy-hotlead`) decayed even faster and was already called KILL two days ago.
- **Regime/book recovery is now a confirmed 4-day trend**, not a one-day bounce: −78→−33→−6→+8 SOL/day since the 06-29/06-30 record crash. Macro flipped to tailwind on 07-02 and has held for 2 days; BTC 7d% has now improved for 4 straight readings (−6.92%→−4.62%→−1.94%→1.43%→3.2%).
- **Lead pool** recovered from the 06-30 trough (46 hot) to a stable plateau (49-50 hot) for the last 4 days — no further growth, but no further decay either.
- **Operational pattern this week:** two major roster overhauls landed outside this skill's proposal cycle in 3 days (07-02's 12-strategy kill backlog + 07-03's V2-refutation pivot) — the operator/other sessions are actively iterating on the data faster than this daily cadence proposes changes. Good sign for velocity; means this skill's job increasingly shifts from "propose the next hill-climb step" to "confirm/audit what's already been changed."

**Verdicts (proposals — roster changes require operator approval + code edit to `COPY_STRATEGIES`):**

- **PROMOTE (1, unchanged):**
  - `copy-hotlead-strict`: n=647, net=+12.06, drop3=+5.48, stress=+5.16, monthly=25.85 SOL/mo. Score 100, all gates clear, 7th consecutive promotable day, cushion now recovering rather than eroding. Still no live capital deployed anywhere in the roster (prior pilot killed 06-29) — this remains the strongest and now-longest-standing case for a live-micro test.

- **KILL (1 new, 2 carried over):**
  - `copy-hotlead-hold30m` (**new**): n=1059, net=+28.47, drop3=−2.66 (3rd straight negative day, worsening each day), stress=+16.99 (still strong). The 3-5 day grace window set 07-01 has closed with no recovery — converting per the skill's own multi-day-decay rule. Net/stress remain the best absolute economics in the roster, so this is a robustness-gate failure, not a P&L collapse; worth noting if the operator wants to keep it running as a shadow reference rather than fully retire it.
  - `copy-hotlead` (carried over): n=1099, net=+3.88, drop3=−3.14, stress=−7.52. Both robustness gates still decisively failing; decay continuing since the 07-02 KILL call.
  - `copy-tp100-sl30-lag` (carried over): n=529, net=−14.97, drop3=−19.52, stress=−20.12. Long-running realistic strategy, continuing to deteriorate every day since flagged.

- **WATCH:**
  - `copy-hotlead-strict-xbad`: n=6, net=+2.10, drop3=+0.11, stress=+2.00. The pivot strategy from last night's roster change (copy-net veto for downside-persistent leads) — too small to score but directionally clean. This is the most promising new idea in the roster; give it time to reach n≥50 before any verdict.
  - `copy-hotlead-strict-hi`: n=21 (up from 3), net=+1.91, drop3=+0.03, stress=+1.65. Growing cleanly, promo score climbing (36.7→56).
  - `copy-hotlead-hold30m-pair-shadow`: n=500, net=−0.51, drop3=−2.02. Shadow reference tracking hold30m's now-confirmed decay; no independent action needed.
  - `copy-src-live-tape` / `copy-src-external`: n=0 each, brand new under the discovery-source registry. `live_tape` funnel reports `NO_WALLETS` (0 smart+copyable wallets found yet) — a discovery-pipeline issue, not a P&L one; check the funnel again in a few days before reading anything into the eventual probe P&L.

- **Idealized references (not live candidates):**
  - `copy-conviction-consensus2`: n=1317, net=+14.18, drop3 and stress both improved and stress crossed positive for the first time (−0.34→+0.33). Promo score jumped 35→55.7 (+20.7, a >10pt mover) — the idealized ceiling is recovering in step with the book.
  - `copy-tp100-sl30`: n=2953, net=−29.38. Negative baseline reference, roughly flat day-over-day.

**New strategies to try:** None this cycle. `copy-hotlead-strict-xbad` (copy-net veto pivot) already covers the freshest and most promising hypothesis in the data — per the redundancy guardrail, the right move is to let it mature toward n≥50 before proposing variants or combinations (e.g. applying the same veto to the hold30m exit shape) on top of it.

**Operator next step:** Two actions, in order of leverage: (1) fund a live-micro test on `copy-hotlead-strict` — 7 consecutive promotable days now, cushion recovering, still the only strategy with zero negative-drop3 days ever, and there is no live capital deployed anywhere; (2) enact the two carried-over kills (`copy-hotlead`, `copy-tp100-sl30-lag`) plus today's new one (`copy-hotlead-hold30m`) in the same code edit — consider whether `hold30m` should be fully retired or kept as a shadow reference given its net/stress are still the best in the roster.

---

## 2026-07-02 — Daily review: 12-strategy kill backlog finally enacted; copy-hotlead-strict holds score=100 for a 6th day as macro flips to tailwind, but copy-hotlead's decay is now decisive enough to call KILL

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-07-02",
  "overall": {"n": 7847, "net": 7.7041, "drop3": -23.4241, "stress": -69.2144, "open": 28},
  "retired_summary": {"n": 21549, "net": -216.3318},
  "regime_score": 5, "regime_24h": 5, "macro_score": 6, "btc_7d_pct": 1.43,
  "book_daily_today": 3.6626,
  "leads": {"n_leads": 160, "hot": 50, "cold": 77},
  "n_promotable_realistic": 1,
  "strategies": [
    {"id": "copy-hotlead-strict",             "realistic": true,  "n": 613, "net": 11.367, "drop3":  4.784, "stress":  4.825, "promo_score": 100,  "verdict": "PROMOTE"},
    {"id": "copy-hotlead-hold30m",            "realistic": true,  "n": 997, "net": 29.123, "drop3": -2.006, "stress": 18.271, "promo_score":  75,  "verdict": "WATCH"},
    {"id": "copy-hotlead",                    "realistic": true,  "n":1048, "net":  4.376, "drop3": -2.644, "stress": -6.506, "promo_score":  55,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-pair-shadow","realistic": true,  "n": 438, "net": -0.499, "drop3": -2.008, "stress": -0.940, "promo_score":  40,  "verdict": "WATCH"},
    {"id": "copy-tp100-sl30-lag",             "realistic": true,  "n": 428, "net":-11.273, "drop3":-15.821, "stress":-15.456, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-hotlead-strict-hi",          "realistic": true,  "n":   3, "net":  0.147, "drop3":  0,     "stress":  0.114, "promo_score":  36.7,"verdict": "WATCH"},
    {"id": "copy-select-v1",                  "realistic": true,  "n":  31, "net": -0.840, "drop3": -2.520, "stress": -1.143, "promo_score":  26.2,"verdict": "KEEP"},
    {"id": "copy-select-v2",                  "realistic": true,  "n":  18, "net": -4.214, "drop3": -3.976, "stress": -4.315, "promo_score":  23.6,"verdict": "KEEP"},
    {"id": "copy-hotlead-strict-v2",          "realistic": true,  "n":   1, "net": -0.167, "drop3":  0,     "stress": -0.174, "promo_score":  20.2,"verdict": "WATCH"},
    {"id": "copy-conviction-consensus2",      "realistic": false, "n":1265, "net": 12.950, "drop3":  0.164, "stress": -0.339, "promo_score":  35,  "verdict": "KEEP"},
    {"id": "copy-tp100-sl30",                "realistic": false, "n":2827, "net":-27.736, "drop3":-34.293, "stress":-56.300, "promo_score":  20,  "verdict": "KEEP"}
  ]
}
```

**Headline:** The 12-strategy kill backlog flagged for three straight reports was finally enacted (commit `7594d67`, ~1969 trades / −119.9 SOL retired) — and while the book climbs out of its worst-ever 3-day stretch (macro flips to tailwind, BTC 7d turns positive for the first time in weeks), `copy-hotlead`'s robustness gates have now failed decisively for two consecutive days, moving it from WATCH to KILL, and `copy-hotlead-hold30m`'s drop3 is negative for a second straight day.

**Day-over-day (vs 2026-07-01 SNAPSHOT):**
- **Kill backlog enacted.** `retired_summary` n jumped 19,580 → 21,549 (+1,969 trades) and net −96.42 → −216.33 SOL (−119.9 SOL retired), matching the 12 strategies flagged since 2026-06-30 (hold60m, be30, sl40, sl20, hold30m-strict, cap2, prune, hold20m, crowdexit, hold45m, early, nochase). All 12 are absent from today's `by_strategy` — the overhang the last two entries called out is finally cleared.
- **`copy-hotlead-strict` remains the sole promotable (score=100, 6th consecutive day)** but its cushion narrowed: net 13.50→11.37 (−2.13), drop3 6.92→4.78 (−2.13), stress 7.16→4.83 (−2.33) on 24 new trades. All three robustness gates still clear comfortably, but this is the third straight day of the cushion shrinking (7.92 on 06-30 → 6.92 on 07-01 → 4.78 today) even as macro turned favorable — worth watching, not yet alarming.
- **`copy-hotlead` — decay confirmed, moving WATCH → KILL.** Stress went 06-30: +0.25 → 07-01: −3.20 → 07-02: **−6.51** (decisively negative 2 days running), drop3 flipped negative again (0.37→−2.64), and net fell 7.39→4.38 (−3.01, over a third of its entire 18-day net erased in one day on just 35 new trades). Yesterday's entry flagged this as "closer to a KILL than hold30m if the next few days don't recover" — it didn't recover, it got worse on every metric. n=1048≥100 with both drop3 and stress decisively failing for 2 consecutive days meets both the mechanical gate rule and the multi-day-decay rule.
- **`copy-hotlead-hold30m` — drop3 negative for a 2nd straight day** (−0.076 on 07-01 → −2.006 today), but net (+29.12) and stress (+18.27) remain strongly positive — a different failure shape than `copy-hotlead`. Per the grace period set on 07-01 ("if drop3/stress don't recover within ~3-5 days, this becomes a KILL"), today is day 2 of that window. Holding at WATCH, but flagging: one more day of negative drop3 and this should convert to KILL too.
- **New, unreviewed additions to the roster:** `copy-hotlead-strict-hi` (n=3, commit `790a32a`, "net-floor hill-climb on the sole promotable") and `copy-hotlead-strict-v2` (n=1, part of commit `7594d67`). Both are tighter variants of the strict gate — consistent with the strategy this journal has recommended doubling down on, but neither was proposed by this skill. Both far too small to score; noted for awareness, matching the same "confirm intentional" flag raised for select-v1/v2 on 07-01.
- **`copy-tp100-sl30-lag`** (the realistic twin of the idealized baseline mirror, age 20.7 days) is visible in today's promotion rows for the first time in recent entries: n=428, net=−11.27, drop3=−15.82, stress=−15.46, monthly=−42.27 — decisively fails every gate at a long-standing sample size. Flagging as a new KILL candidate (see Verdicts).
- **Regime/macro turned favorable.** Regime score flat at 5, but `score_24h` recovered 1→5 — the 24h outlook finally confirms the intraday recovery flagged (but unconfirmed) yesterday. Macro score jumped 4→6, flipping from headwind to **tailwind** band for the first time in over two weeks; BTC 7d% turned positive (−1.94%→+1.43%) for the first time since mid-June. Fear/greed still extreme (19) but the trend is improving.
- **Lead pool:** 160 leads flat, hot 49→50 (+1), cold 75→77 (+2) — continuing the slow recovery from the 06-30 trough (46).
- **Book P&L:** today's partial day (+3.66 SOL through 10:00 UTC, 126 trades) is the first positive book day since 06-28, following the worst 3-day stretch on record (06-29: −55.85, 06-30: −77.45, 07-01: −32.68 per `regime.swing.daily`).

**Week-over-week (Jun 28 → Jul 02, 5 entries):**
- `copy-hotlead-strict` is the only strategy that has never had a negative drop3 day across the entire journal, and has held score=100 for 6+ consecutive days — including through the worst 3-day drawdown stretch in the book's history. Its absolute cushion has eroded the last 3 days (7.92→6.92→4.78) but remains solidly positive. This is the strongest evidence yet for a live-micro promotion.
- `copy-hotlead-hold30m` and `copy-hotlead` both broke their "converging" trend on 06-29/06-30 and have not recovered since — `copy-hotlead`'s decay is now decisive (2 days of dual-gate failure); `hold30m`'s is milder (drop3-only, large net/stress cushion intact).
- Regime pattern: worst-ever 3-day stretch (06-29 to 07-01) appears to be resolving — regime_24h recovered to 5, macro flipped to tailwind, BTC turned positive, and today's partial book day is the first green day in 4.
- Macro/BTC: 13+ day slide from ~$66K bottomed around 06-30 ($58.7K) and has now recovered 2 straight days to $60.06K, with the macro score confirming tailwind for the first time since mid-June.
- Lead pool: hot count 46 (06-30 trough) → 49 (07-01) → 50 (07-02) — steady 3-day recovery.
- Operational: the 12-strategy kill backlog that sat unenacted for 3 full reporting cycles (06-30, 07-01) is now cleared — the single highest-leverage recommendation from the last two entries was actioned.

**Verdicts (proposals — roster changes require operator approval + code edit to `COPY_STRATEGIES`):**

- **PROMOTE (1):**
  - `copy-hotlead-strict`: n=613, net=+11.37, drop3=+4.78, stress=+4.83, monthly=24.36 SOL/mo. Score 100, all gates clear, 6th consecutive promotable day — including surviving the worst 3-day drawdown on record with cushion intact. There is currently no live-micro strategy running (the prior pilot was killed 06-29). This is now the strongest evidence yet to fund a live-micro test on `copy-hotlead-strict`.

- **KILL (2 new):**
  - `copy-hotlead`: n=1048, net=+4.38 (eroding fast), drop3=−2.64, stress=−6.51 (decisive fail, 2nd straight day), monthly implied well negative. Two consecutive days of dual-gate failure plus a −3.01 SOL single-day loss on a thin (+4.38) total net. This is the multi-day decay pattern the skill's KILL rule targets.
  - `copy-tp100-sl30-lag`: n=428, net=−11.27, drop3=−15.82, stress=−15.46, monthly=−42.27. Long-running (20.7 days) realistic strategy decisively failing every gate — not exempt as an idealized-mirror reference since it's the `-lag` (realistic-execution) twin, not the mirror itself. The idealized `copy-tp100-sl30` stays as the reference; only its realistic twin is proposed for removal.

- **WATCH — one day from a KILL call if it doesn't recover:**
  - `copy-hotlead-hold30m`: n=997, net=+29.12, drop3=−2.01 (2nd straight negative day), stress=+18.27 (still strong). Day 2 of the 3-5 day grace window set on 07-01. If drop3 is still negative on 07-03/04, convert to KILL.
  - `copy-hotlead-hold30m-pair-shadow`: n=438, net=−0.50, drop3=−2.01. Shadow reference tracking hold30m's decay; no independent action needed.

- **KEEP COOKING (n<50, too sparse for a verdict):**
  - `copy-select-v1`: n=31, improving (net −1.63→−0.84, drop3 −3.22→−2.52).
  - `copy-select-v2`: n=18, worsening (net −2.50→−4.21, drop3 −2.03→−3.98). Watch closely once it clears n=50.
  - `copy-hotlead-strict-hi` (n=3) and `copy-hotlead-strict-v2` (n=1): brand new, added outside this skill's recommendations (commits `790a32a`, `7594d67`). Worth a quick operator confirmation of intent, same as flagged for select-v1/v2 last cycle.

- **Idealized references (not live candidates):**
  - `copy-conviction-consensus2`: n=1265, net=+12.95, drop3 flipped positive (+0.16, from −1.27) — the idealized ceiling is recovering too.
  - `copy-tp100-sl30`: n=2827, net=−27.74. Negative baseline reference, roughly flat day-over-day.

**New strategies to try:** None this cycle. `copy-hotlead-strict-hi` and `copy-hotlead-strict-v2` already cover the "tighten the strict gate further" hypothesis this journal would otherwise propose — per the redundancy guardrail, no new idea is warranted until those mature or the two pending KILLs are enacted.

**Operator next step:** Two actions, in order of leverage: (1) fund a live-micro test on `copy-hotlead-strict` — it has now cleared every promotion gate for 6 consecutive days including the worst drawdown stretch on record, and there is currently no live capital deployed anywhere in the roster; (2) enact the two new kills (`copy-hotlead`, `copy-tp100-sl30-lag`) in the same code edit. Also worth 5 minutes: confirm the `copy-hotlead-strict-hi` / `-v2` additions and the `copy-select-v1`/`v2` A/B are intentional and tracked — none were proposed by this skill.

---

## 2026-07-01 — Daily review: June 30 breaks the record set the day before (−77.5 SOL); promotable count drops 3 → 1 as hold30m and hotlead both fall off the bar

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-07-01",
  "overall": {"n": 9297, "net": -92.663, "drop3": -137.538, "stress": -182.788, "open": 13},
  "retired_summary": {"n": 19580, "net": -96.417},
  "regime_score": 5, "regime_24h": 1, "macro_score": 4, "btc_7d_pct": -1.94,
  "book_daily_today": -9.47,
  "leads": {"n_leads": 160, "hot": 49, "cold": 75},
  "n_promotable_realistic": 1,
  "strategies": [
    {"id": "copy-hotlead-strict",            "realistic": true,  "n": 589, "net":  13.497, "drop3":  6.915, "stress":  7.160, "promo_score": 100,  "verdict": "PROMOTE"},
    {"id": "copy-hotlead-hold30m",           "realistic": true,  "n": 964, "net":  31.052, "drop3": -0.076, "stress": 20.502, "promo_score":  75,  "verdict": "WATCH"},
    {"id": "copy-hotlead",                   "realistic": true,  "n":1013, "net":   7.387, "drop3":  0.367, "stress": -3.195, "promo_score":  59.6,"verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-pair-shadow","realistic": true,  "n": 408, "net":  -0.351, "drop3": -1.861, "stress": -0.764, "promo_score":  40,  "verdict": "WATCH"},
    {"id": "copy-hotlead-hold45m",           "realistic": true,  "n": 251, "net":   3.081, "drop3":-24.049, "stress":  0.434, "promo_score":  59.3,"verdict": "KILL"},
    {"id": "copy-hotlead-hold20m",           "realistic": true,  "n": 246, "net":  -9.934, "drop3":-17.156, "stress":-12.269, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-sl20",      "realistic": true,  "n": 233, "net": -12.386, "drop3":-20.177, "stress":-14.538, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-be30",      "realistic": true,  "n": 229, "net": -16.939, "drop3":-21.028, "stress":-18.959, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-sl40",      "realistic": true,  "n": 217, "net": -15.512, "drop3":-23.303, "stress":-17.437, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold60m",           "realistic": true,  "n": 225, "net": -21.242, "drop3":-28.378, "stress":-23.134, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-cap2",      "realistic": true,  "n": 164, "net": -10.199, "drop3":-17.990, "stress":-11.684, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-prune",     "realistic": true,  "n": 143, "net":  -3.791, "drop3":-11.581, "stress": -5.188, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-strict",    "realistic": true,  "n": 150, "net":  -9.799, "drop3":-14.415, "stress":-11.148, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-crowdexit", "realistic": true,  "n": 160, "net":  -2.454, "drop3": -9.030, "stress": -4.053, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-early",     "realistic": true,  "n":  84, "net": -10.596, "drop3":-11.514, "stress":-11.249, "promo_score":  36.8,"verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-nochase",   "realistic": true,  "n":  53, "net":  -7.094, "drop3": -8.176, "stress": -7.498, "promo_score":  30.6,"verdict": "KILL"},
    {"id": "copy-select-v1",                 "realistic": true,  "n":  19, "net":  -1.634, "drop3": -3.216, "stress": -1.797, "promo_score":  23.8,"verdict": "WATCH"},
    {"id": "copy-select-v2",                 "realistic": true,  "n":   9, "net":  -2.495, "drop3": -2.029, "stress": -2.538, "promo_score":  21.8,"verdict": "WATCH"},
    {"id": "copy-conviction-consensus2",     "realistic": false, "n":1241, "net":  11.515, "drop3": -1.271, "stress": -1.498, "promo_score":  35,  "verdict": "KEEP"},
    {"id": "copy-tp100-sl30",               "realistic": false, "n":2734, "net": -27.924, "drop3":-34.480, "stress":-55.526, "promo_score":  20,  "verdict": "KEEP"}
  ]
}
```

**Headline:** June 30 broke the record set the day before for worst book day ever (−77.45 SOL, vs June 29's −71.85 SOL) — two consecutive historic drawdowns have knocked two of the three previously-promotable strategies (`copy-hotlead-hold30m`, `copy-hotlead`) below the promotion bar; only `copy-hotlead-strict` still clears all gates.

**Day-over-day (vs 2026-06-30 SNAPSHOT):**
- **The June 30 book crash was much worse than it looked at report time.** Yesterday's snapshot, taken ~10:00 UTC on the 30th, showed `book_daily_today: 0.68` (a flat-to-good partial day). The day then collapsed to −77.45 SOL by close — the worst single day in book history, beating June 29's −71.85 by more SOL than the prior record itself. Δoverall net: −5.06 → −92.66 (−87.6 SOL). Δdrop3: −49.94 → −137.54 (−87.6). Open positions 24 → 13.
- **Promotable count: 3 → 1.** `copy-hotlead-hold30m` drop3 flipped +7.13 → **−0.076** (marginal, essentially breakeven, but a strict fail of the drop-top3 gate) — demoted PROMOTE → WATCH. `copy-hotlead` exit_stress flipped +0.254 → **−3.195** (a decisive fail, not marginal) — demoted PROMOTE → WATCH, closer to an outright KILL than hold30m. Both retain strongly positive net (+31.05, +7.39) and hold30m's stress is still robust (+20.50) — this reads as outlier-driven damage from the two worst days on record, not yet a confirmed multi-day decay pattern like the Cohort P kills. Given it's a single-day flip off a historic tail event, calling WATCH rather than an immediate KILL; if drop3/stress don't recover within ~3-5 days this becomes a KILL case.
- `copy-hotlead-strict` (the survivor): net 14.50 → 13.50 (−1.00), drop3 7.92 → 6.92 (−1.00), stress 8.42 → 7.16 (−1.26), n 562 → 589 (+27). Smallest hit of the trio by far — confirms it remains the most macro-resilient screen in the roster, exactly as flagged in the prior 4 entries.
- **New in roster since yesterday (not proposed by this skill):** `copy-select-v1` (n=19) and `copy-select-v2` (n=9) — a live V1-vs-V2 lead-selection A/B added by a code change (commit `938bf2a`, "Option B — live V1-vs-V2 selection A/B"). Both idealized-config realistic-flagged, too small to score. WATCH.
- **The 12 kill-backlog strategies from the 2026-06-30 entry are all still live and continued to bleed**, unenacted: hold60m −14.38→−21.24, be30 −10.44→−16.94, sl40 −8.25→−15.51, sl20 −7.01→−12.39, hold30m-strict −5.32→−9.80, cap2 −4.04→−10.20, hold20m −3.80→−9.93, prune −1.66→−3.79, crowdexit +0.71→−2.45 (flipped negative). `hold30m-early` grew 57→84 (still <100, still catastrophic at n≥40). `hold45m` deteriorated further (drop3 −16.93→−24.05).
- `copy-conviction-consensus2` (idealized reference): drop3 flipped +2.49 → **−1.27**. Never a live candidate, but a signal that even the idealized-mirror ceiling took damage from this stretch — the whole book, not just the realistic twins, got hit.
- Regime: 1 → 5 (recovered to neutral intraday) but `score_24h` still 1 — the 24h outlook has not confirmed the recovery. Macro: 3 → 4, BTC 7d −4.62% → −1.94% (slight improvement), still headwind band. Fear/greed remains extreme.
- Lead pool: 158 → 160 leads, hot 46 → 49 (partial recovery from yesterday's first weekly decline), cold flat at 75.

**Week-over-week (Jun 25 → Jul 1):**
- **The "durable edge" thesis just took its first real hit.** For the prior 6 days, `copy-hotlead-hold30m` and `copy-hotlead-strict` held positive drop3 through every regime trough, which was the core evidence cited for genuine edge vs tape-driven luck. Today `hold30m`'s drop3 went negative for the first time in its 15-day life. `copy-hotlead-strict` is now the only strategy that has *never* had a negative drop3 day — raising it from "preferred" to "the only one still standing."
- Regime pattern: this is now the worst 3-day stretch on record (score 7→1→1→5, with book P&L +19.76→−72.19→−77.45→−9.47 partial). Two back-to-back all-time-worst days is a materially different event than the single bad day (June 23-24 trough) seen earlier in the month.
- Macro/BTC: still consolidating in the $58-60K range, no tailwind. Fear/greed pinned at extreme-fear (11) — third straight day.
- Lead pool: hot count troughed at 46 (Jun 30) and is recovering (49 today) — read as noise, not a trend reversal yet.
- Operational note: the 2026-06-30 kill-backlog cleanup (12 strategies) has not been enacted after one full day — those strategies added another ~40 SOL of shadow losses since being flagged. Not real money (live-micro was killed on Jun 29), but it's wasting shadow budget exactly as the prior entry warned.

**Verdicts (proposals — roster changes require operator approval + code edit to `COPY_STRATEGIES`):**

- **PROMOTE (1):**
  - `copy-hotlead-strict`: n=589, net=+13.50, drop3=+6.92, stress=+7.16, monthly=28.92 SOL/mo. Score 100. The only strategy that survived the two-day historic drawdown with all gates intact. Primary (now sole) live candidate.

- **WATCH — demoted from PROMOTE, need 3-5 more days to confirm outlier vs. decay:**
  - `copy-hotlead-hold30m`: n=964, net=+31.05, drop3=**−0.08** (marginal fail), stress=+20.50 (still strong), monthly=66.54. Best absolute economics in the roster; only the outlier-robustness gate failed, by a hair.
  - `copy-hotlead`: n=1013, net=+7.39, drop3=+0.37 (still positive), stress=**−3.20** (decisive fail), monthly=15.83. This is the fragility the prior entry predicted ("one more bad day flips it") — it flipped. Closer to a KILL than hold30m if the next few days don't recover.
  - `copy-hotlead-hold30m-pair-shadow`: n=408, net=−0.35 (flipped negative), drop3=−1.86, monthly=−1.17. Shadow reference for hold30m; tracking its parent's damage.
  - `copy-select-v1` / `copy-select-v2`: n=19 / n=9. New V1-vs-V2 selection A/B, added outside this skill's recommendations. Far too small to score; re-check at n≥50.

- **KILL (12 — unchanged from 2026-06-30, still pending operator action, still bleeding):**
  - `copy-hotlead-hold60m` (n=225, net=−21.24, drop3=−28.38), `copy-hotlead-hold30m-be30` (n=229, net=−16.94, drop3=−21.03), `copy-hotlead-hold30m-sl40` (n=217, net=−15.51, drop3=−23.30), `copy-hotlead-hold30m-sl20` (n=233, net=−12.39, drop3=−20.18), `copy-hotlead-hold30m-strict` (n=150, net=−9.80, drop3=−14.42), `copy-hotlead-hold30m-cap2` (n=164, net=−10.20, drop3=−17.99), `copy-hotlead-hold20m` (n=246, net=−9.93, drop3=−17.16), `copy-hotlead-hold30m-prune` (n=143, net=−3.79, drop3=−11.58), `copy-hotlead-hold30m-crowdexit` (n=160, net=−2.45, drop3=−9.03), `copy-hotlead-hold45m` (n=251, net=+3.08, drop3=−24.05, deteriorating daily), `copy-hotlead-hold30m-early` (n=84, net=−10.60, catastrophic), `copy-hotlead-hold30m-nochase` (n=53, net=−7.09, catastrophic).

- **Idealized references (not live candidates):**
  - `copy-conviction-consensus2`: n=1241, net=+11.52, drop3 flipped negative (−1.27) — even the idealized ceiling took damage this stretch.
  - `copy-tp100-sl30`: n=2734, net=−27.92. Negative baseline reference, deteriorating with the book.

**New strategies to try:** None this cycle. With the promotable count cut to 1 and two former promotables now needing multi-day confirmation, the priority is watching the existing roster recover (or not) — not adding new experiments. The 12-strategy kill backlog is now a full day overdue; enacting it remains the single highest-leverage code edit available.

**Operator next step:** Enact the 2026-06-30 kill-backlog cleanup (12 strategies, unchanged list above) — it's now been pending a full day and cost ~40 more SOL in shadow losses. Do not add `copy-hotlead-hold30m` as live-micro yet as previously suggested — it fell off the promotion bar today; `copy-hotlead-strict` is now the only defensible promotion candidate if live capital is to be deployed. Also worth 5 minutes: sanity-check whether the copy-select-v1/v2 A/B (added outside this loop) is intentional and what hypothesis it's testing, since it wasn't proposed here.

---

## 2026-06-30 — Daily review: June 29 worst book day ever (−71.9 SOL); live-micro kill enacted; 12 strategies hit kill criteria; 3 promotables intact but copy-hotlead fragile

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-06-30",
  "overall": {"n": 8461, "net": -5.063, "drop3": -49.938, "stress": -88.690, "open": 24},
  "retired_summary": {"n": 19580, "net": -96.417},
  "regime_score": 1, "regime_24h": 1, "macro_score": 3, "btc_7d_pct": -4.62,
  "book_daily_today": 0.68,
  "leads": {"n_leads": 158, "hot": 46, "cold": 75},
  "n_promotable_realistic": 3,
  "strategies": [
    {"id": "copy-hotlead-hold30m",           "realistic": true,  "n": 916, "net":  38.261, "drop3":  7.133, "stress": 28.061, "promo_score": 100,  "verdict": "PROMOTE"},
    {"id": "copy-hotlead-strict",            "realistic": true,  "n": 562, "net":  14.502, "drop3":  7.919, "stress":  8.423, "promo_score": 100,  "verdict": "PROMOTE"},
    {"id": "copy-hotlead",                   "realistic": true,  "n": 965, "net":  10.402, "drop3":  3.381, "stress":  0.254, "promo_score":  82.5,"verdict": "PROMOTE"},
    {"id": "copy-hotlead-hold30m-pair-shadow","realistic": true,  "n": 369, "net":   0.283, "drop3": -1.227, "stress": -0.103, "promo_score":  44.2,"verdict": "WATCH"},
    {"id": "copy-hotlead-hold45m",           "realistic": true,  "n": 204, "net":  10.201, "drop3":-16.930, "stress":  7.896, "promo_score":  75,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold20m",           "realistic": true,  "n": 201, "net":  -3.802, "drop3":-11.024, "stress": -5.796, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-sl20",      "realistic": true,  "n": 193, "net":  -7.008, "drop3":-14.798, "stress": -8.855, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-be30",      "realistic": true,  "n": 188, "net": -10.436, "drop3":-14.524, "stress":-12.164, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-sl40",      "realistic": true,  "n": 178, "net":  -8.254, "drop3":-16.044, "stress": -9.922, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold60m",           "realistic": true,  "n": 182, "net": -14.375, "drop3":-21.512, "stress":-15.962, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-cap2",      "realistic": true,  "n": 128, "net":  -4.037, "drop3":-11.828, "stress": -5.275, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-prune",     "realistic": true,  "n": 123, "net":  -1.664, "drop3": -9.455, "stress": -2.897, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-strict",    "realistic": true,  "n": 124, "net":  -5.319, "drop3": -9.935, "stress": -6.490, "promo_score":  40,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-crowdexit", "realistic": true,  "n": 115, "net":   0.714, "drop3": -5.861, "stress": -0.485, "promo_score":  55,  "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-early",     "realistic": true,  "n":  57, "net":  -7.314, "drop3": -8.036, "stress": -7.755, "promo_score":  31.4,"verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-nochase",   "realistic": true,  "n":  43, "net":  -5.497, "drop3": -6.578, "stress": -5.830, "promo_score":  28.6,"verdict": "KILL"},
    {"id": "copy-conviction-consensus2",     "realistic": false, "n":1183, "net":  15.278, "drop3":  2.492, "stress":  2.787, "promo_score":  80,  "verdict": "KEEP"},
    {"id": "copy-tp100-sl30",               "realistic": false, "n":2595, "net": -23.798, "drop3":-30.355, "stress":-50.051, "promo_score":  20,  "verdict": "KEEP"}
  ]
}
```

**Headline:** June 29 delivered the worst single day in book history (−71.9 SOL; book net collapsed from +49.4 to −5.1 overnight); the live-micro kill was enacted between sessions; all 12 strategies in the kill backlog hit their trigger criteria; the 3 promotables survive but copy-hotlead is now fragile (stress near zero).

**Day-over-day (vs 2026-06-29 SNAPSHOT, taken ~10:00 UTC):**
- Δn: 7618 → 8461 (+843 trades). **Δnet: +49.36 → −5.06 (−54.4 SOL)** — the rest of June 29 after the morning snapshot erased the book. Δdrop3: +4.48 → −49.94 (−54.4); top-3 unchanged, pure June 29 losses.
- **copy-hotlead-hold30m-live-micro: KILLED** (enacted between sessions — not in today's by_strategy; retired_summary +324 trades). This is the kill proposed daily since Jun 25 and finally actioned. Real-money bleed stopped.
- Regime: 7 → 1 (crashed). Yesterday's snapshot was taken at peak regime=7; the afternoon of June 29 collapsed to 1 and has not recovered. regime_24h=1 (24h outlook also poor). book_net_6h today=−10.21 SOL.
- Macro: 4 → 3 (−1). BTC 7d improved slightly (−6.92% → −4.62%); absolute level $59.4K unchanged. Fear/greed=15 (extreme fear). Headwind persists.
- Lead pool: 157 → 158 total (+1), hot 50 → 46 (−4), cold 69 → 75 (+6). First weekly hot-lead decline. Not alarming but watch.
- **Per-strategy movers vs yesterday's SNAPSHOT:**
  - copy-hotlead-hold30m: Δn=+71, Δnet=−4.63, Δdrop3=−4.63. Jun 29: −6.53 SOL (50 trades). Still the board leader (drop3=+7.13, stress=+28.06, score=100).
  - copy-hotlead-strict: Δn=+45, Δnet=+0.47, Δdrop3=+0.47. Jun 29: −0.31 SOL (34 trades) — nearly flat on the book's worst day. The only realistic strategy to end June 29 net-positive.
  - copy-hotlead: Δn=+73, Δnet=−3.76, Δdrop3=−3.76. Jun 29: −3.30 SOL (52 trades). Score dropped 100→82.5; stress collapsed 4.69→0.25. Still promotable but fragile.
  - copy-hotlead-hold60m: Δn=+64, Δnet=−6.87 → total −14.38 (n=182). Catastrophic, 5th consecutive kill recommendation ignored.
  - Cohort P/Q/S collectively: hold30m-strict/cap2/prune/crowdexit all crossed n=100 today; early/nochase crossed the catastrophic (net<−3 at n≥40) threshold. Full batch resolution: all fail.

**Week-over-week (Jun 24 → Jun 30):**
- **Converging (durable edge):**
  - copy-hotlead-hold30m: score=100 for 6 consecutive days through the worst regime stretch in this journal. Drop3 trajectory: +4.57 → +7.16 → +9.82 → +11.76 → +7.13. Fell on June 29 but remained positive through $59K BTC and regime=1.
  - copy-hotlead-strict: score=100 for ≥4 consecutive days. Jun 29 net=−0.31 vs hotlead Jun 29=−3.30 and hold30m Jun 29=−6.53. The strict gate (minNetSol=0.5 in last 10) is the best macro/tape screen in the roster. Drop3 +7.92 growing weekly.
  - copy-hotlead: score drifted from 100 to 82.5. Jun 29 gave it its worst daily (−3.30 SOL, −3.08% of all-time net in one day). Stress at 0.254 — one more bad day flips it non-promotable. Weekly trend is weakening relative to strict.
- **Lead pool:** hot 41 (Jun 22) → 51 (Jun 28) → 46 (today). First reversal after consistent weekly growth. 6 cold reclassifications on the June 29 bloodbath. Watch for sustained decay.
- **Regime pattern:** Volatile all week. Trough at 1-2 (Jun 23-24), recovered to 5-7 (Jun 27-29 morning), then crashed back to 1 (Jun 29 afternoon). The promotable trio accumulated positive drop3 through both troughs — this is the core evidence of genuine edge vs tape-driven luck.
- **Macro/BTC:** $59.2K (Jun 25) → $60.4K (Jun 29) → $59.4K (today). Flat at $59-60K. Two-week slide from $66K has fully unwound into a consolidation range. Fear/greed=15. No tailwind yet.
- **Cohort P fully resolved (all fail):** All 7 hold-time variants (hold20m, hold30m-sl20/sl40/be30/strict, hold45m, hold60m) resolved negative. The baseline hold30m exit (TP/SL with 30min cap) cannot be improved by changing hold duration or SL placement in this regime. Lesson: the entry filter (hot-lead strictness) is what differentiates, not the exit timing.
- **Cohort Q fully resolved (all fail):** cap2 (n=128, net=−4.04) and prune (n=123, net=−1.66) both crossed n=100 today. Capping per-mint entries and pruning cold leads from the watchlist both fail to recover the lost robustness.
- **Cohort S resolved (KILL):** crowdexit (n=115, net=+0.71, drop3=−5.86) crossed n=100 today. Drop3 < parent (7.13) by >12 SOL — stated kill criterion met.

**Verdicts (proposals — roster changes require operator approval + code edit to `COPY_STRATEGIES`):**

- **PROMOTE (3):**
  - `copy-hotlead-hold30m`: n=916, net=+38.26, drop3=+7.13, stress=+28.06, monthly=82 SOL/mo. Score 100. Best absolute metrics. Primary live candidate.
  - `copy-hotlead-strict`: n=562, net=+14.50, drop3=+7.92, stress=+8.42, monthly=31 SOL/mo. Score 100. Most macro-resilient strategy — near-zero loss on book's worst day. Preferred over base hotlead on current tape.
  - `copy-hotlead`: n=965, net=+10.40, drop3=+3.38, stress=+0.25, monthly=22 SOL/mo. Score 82.5. All gates pass but stress barely above zero; one more bad day makes it non-promotable. Flag as fragile.

- **KILL (12 — full roster cleanup):**
  - `copy-hotlead-hold60m`: n=182, net=−14.375, drop3=−21.512 — catastrophic; 5th consecutive kill recommendation unenacted.
  - `copy-hotlead-hold30m-be30`: n=188, net=−10.436, drop3=−14.524 — catastrophic.
  - `copy-hotlead-hold30m-sl40`: n=178, net=−8.254, drop3=−16.044 — catastrophic.
  - `copy-hotlead-hold30m-sl20`: n=193, net=−7.008, drop3=−14.798 — catastrophic.
  - `copy-hotlead-hold30m-strict`: n=124, net=−5.319, drop3=−9.935 — crossed n=100 today; all gates fail.
  - `copy-hotlead-hold30m-cap2`: n=128, net=−4.037, drop3=−11.828 — crossed n=100 today; all gates fail.
  - `copy-hotlead-hold30m-prune`: n=123, net=−1.664, drop3=−9.455 — crossed n=100 today; all gates fail.
  - `copy-hotlead-hold20m`: n=201, net=−3.802, drop3=−11.024 — n≥100, all gates fail.
  - `copy-hotlead-hold30m-crowdexit`: n=115, net=+0.714, drop3=−5.861 — n≥100, drop3 < parent +7.13 (Cohort S rule met).
  - `copy-hotlead-hold45m`: n=204, net=+10.201, drop3=−16.930 — window nominally closes Jul 2 but drop3 deteriorating daily (−11.66 yesterday → −16.93 today); criterion met early; lottery pattern confirmed.
  - `copy-hotlead-hold30m-early`: n=57, net=−7.314 — catastrophic (net < −3 at n=57 ≥ 40).
  - `copy-hotlead-hold30m-nochase`: n=43, net=−5.497 — catastrophic (net < −3 at n=43 ≥ 40).

- **WATCH:**
  - `copy-hotlead-hold30m-pair-shadow`: n=369, net=+0.283, drop3=−1.227, monthly=1.06. Not catastrophic, net barely positive. Monthly fails. Keep as hold30m shadow reference; check again at n=450.
  - `copy-cotrade-tp100-sl30` (new, n=72, realistic=false, net=−2.836): idealized cohort testing co-trade wallet sourcing. Too small; idealized mirror only.
  - `copy-ogsmart-tp100-sl30` (new, n=63, realistic=false, net=−0.365): idealized mirror testing OG-smart wallet sourcing. Too small; idealized only.
  - `copy-livetape-tp100-sl30` (new, n=0): not yet launched.

- **Idealized references (not live candidates):**
  - `copy-conviction-consensus2`: n=1183, net=+15.278, realistic=false, score=80. Upper-bound reference only.
  - `copy-tp100-sl30`: n=2595, net=−23.798. Negative baseline reference.

**New strategies to try:** None this cycle. 12 strategies pending kill, 3 proven promotables waiting for live capital. Clearing the kill backlog is the precondition for further ideation — adding experiments while 5 catastrophics still run wastes shadow budget and muddies regime tracking.

**Operator next step:** One code edit removes all 12 kill candidates from `COPY_STRATEGIES` (hold60m, be30, sl40, sl20, hold30m-strict, cap2, prune, hold20m, crowdexit, hold45m, early, nochase) and adds `copy-hotlead-hold30m` as the new live-micro strategy. This clears the entire pending backlog in one PR and puts real capital behind the 82 SOL/mo champion.

---

## 2026-06-29 — Daily review: 6 KILL triggers hit (4 catastrophic), 3 promotables unchanged, June 28 outlier day collapses overall drop3

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-06-29",
  "overall": {"n": 7618, "net": 49.36, "drop3": 4.48, "stress": -24.15, "open": 11},
  "retired_summary": {"n": 19256, "net": -95.67},
  "regime_score": 7, "regime_24h": 9, "macro_score": 4, "btc_7d_pct": -6.92,
  "book_daily_today": -16.34,
  "leads": {"n_leads": 157, "hot": 50, "cold": 69},
  "n_promotable_realistic": 3,
  "strategies": [
    {"id": "copy-hotlead",                     "realistic": true,  "n": 892, "net": 14.161, "drop3":  7.141, "stress":  4.690, "promo_score": 100, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-hold30m",             "realistic": true,  "n": 845, "net": 42.892, "drop3": 11.764, "stress": 33.330, "promo_score": 100, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-strict",              "realistic": true,  "n": 517, "net": 14.030, "drop3":  7.448, "stress":  8.424, "promo_score": 100, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-hold45m",             "realistic": true,  "n": 137, "net": 14.654, "drop3": -11.656,"stress": 12.950, "promo_score":  75, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-pair-shadow", "realistic": true,  "n": 307, "net":  0.492, "drop3": -0.721, "stress":  0.166, "promo_score":  50, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-crowdexit",   "realistic": true,  "n":  43, "net":  1.215, "drop3": -1.595, "stress":  0.748, "promo_score":  51, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-strict",      "realistic": true,  "n":  83, "net": -2.192, "drop3": -6.166, "stress": -3.004, "promo_score":  37, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-cap2",        "realistic": true,  "n":  71, "net": -2.390, "drop3": -5.546, "stress": -3.073, "promo_score":  34, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-prune",       "realistic": true,  "n":  78, "net": -2.649, "drop3": -6.534, "stress": -3.400, "promo_score":  36, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-early",       "realistic": true,  "n":  23, "net": -1.908, "drop3": -2.629, "stress": -2.107, "promo_score":  25, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-nochase",     "realistic": true,  "n":  19, "net": -2.344, "drop3": -2.747, "stress": -2.492, "promo_score":  24, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-live-micro",  "realistic": true,  "n": 307, "net": -0.506, "drop3": -1.239, "stress": -0.559, "promo_score":  40, "verdict": "KILL"},
    {"id": "copy-hotlead-hold20m",             "realistic": true,  "n": 136, "net": -1.651, "drop3": -8.137, "stress": -3.019, "promo_score":  40, "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-be30",        "realistic": true,  "n": 125, "net": -4.471, "drop3": -7.828, "stress": -5.669, "promo_score":  40, "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-sl20",        "realistic": true,  "n": 128, "net": -5.846, "drop3": -9.322, "stress": -7.047, "promo_score":  40, "verdict": "KILL"},
    {"id": "copy-hotlead-hold30m-sl40",        "realistic": true,  "n": 117, "net": -6.549, "drop3":-10.643, "stress": -7.623, "promo_score":  40, "verdict": "KILL"},
    {"id": "copy-hotlead-hold60m",             "realistic": true,  "n": 118, "net": -7.507, "drop3":-11.708, "stress": -8.572, "promo_score":  40, "verdict": "KILL"}
  ]
}
```

**Headline:** Cohort P resolved in full — 5 of 7 variants hit kill criteria (4 catastrophically past −3 SOL at n≥100), the kill backlog now stands at 6 strategies; the 3 promotables remain score=100 and growing but are blocked from live capital while real money bleeds in the failing pilot.

**Day-over-day (vs 2026-06-28 SNAPSHOT):**
- n: 6403 → 7618 (+1215 trades). June 28 ended at +26.38 book; the snapshot caught only +6.62 partial — the big June 28 day accrued after the snapshot.
- Net: 45.94 → 49.36 (+3.42 SOL): approx. the June 28 remainder +19.76 minus June 29 YTD −16.34.
- **Drop3 collapsed: 21.95 → 4.48 (−17.47).** June 28's outlier wins became the new top-3 in the aggregate book, shifting the drop3 benchmark hard. The individual promotables are fine (hold30m drop3=+11.76), but the book-level aggregate is now outlier-driven. This is a warning sign for the aggregate, not for the core trio.
- Regime: 5 → 7 (+2, "favorable"); regime_24h=9 — the copy tape is hot today despite the steep losses this morning (327 trades, −16.34 SOL through 10:00 UTC — a very bad early session).
- Macro: 3 → 4 (+1). BTC bounced +0.95% 1d to $59,963 but still −6.92% 7d. Fear/greed=12 (extreme fear). Macro remains headwind.
- Leads: 155 → 157 total, hot 51 → 50 (−1), cold 68 → 69 (+1). Essentially flat; lead pool not degrading.
- **Per-strategy movers (Δ from yesterday's SNAPSHOT):**
  - copy-hotlead: Δn=+85, Δnet=+0.57, Δdrop3=+0.13 — steady accumulation.
  - copy-hotlead-hold30m: Δn=+74, Δnet=+9.09(!), Δdrop3=+1.95 — strong; 30m hold captured June 28's runners well.
  - copy-hotlead-strict: Δn=+42, Δnet=+2.08, Δdrop3=+2.08 — solid; strict gate showed positive today (+0.56) while peers bleed.
  - copy-hotlead-hold20m: Δn=+60, Δnet=−3.36(!), Δdrop3=−4.55 — reversed sharply from +1.71 on day 1 to −1.65 at n=136. All gates fail.
  - copy-hotlead-hold45m: Δn=+66, Δnet=+15.72(!), Δdrop3=−5.47 — net skyrocketed but drop3 crashed further (was −6.19, now −11.66). Classic lottery pattern: one massive June 28 win drove net up while removing robustness.
  - copy-hotlead-hold60m: Δn=+57, Δnet=−4.91(!), Δdrop3=−6.04 — catastrophic trajectory.
  - copy-hotlead-hold30m-sl20: Δn=+57, Δnet=−3.62, Δdrop3=−4.78 — catastrophic.
  - copy-hotlead-hold30m-sl40: Δn=+51, Δnet=−4.25, Δdrop3=−5.30 — catastrophic.
  - copy-hotlead-hold30m-be30: Δn=+57, Δnet=−2.24, Δdrop3=−3.28 — catastrophic.
  - copy-hotlead-hold30m-live-micro: Δn=+54, Δnet=−0.35, Δdrop3=−0.35 — still bleeding real money.

**Week-over-week (Jun 23 → Jun 29 across 7 journal entries):**
- **Converging (score=100 all week):** copy-hotlead, copy-hotlead-hold30m, copy-hotlead-strict have been score-100 continuously. Drop3 on hold30m: +7.16 (Jun 24) → +4.57 (Jun 25) → +11.56 (Jun 27) → +9.82 (Jun 28 partial) → **+11.76** today. Durable and robust through macro headwind.
- **Regime pattern:** Volatile — 8 (Jun 22) → 1-2 (Jun 23–25 trough) → 4 (Jun 27) → 5 (Jun 28) → **7** today. Tape is clearly recovering. The worst trough (regime=1 on Jun 23-24) did not break the promotable core.
- **Macro/BTC:** BTC 7d pct: −3.6% (Jun 22) → −5.4% (Jun 27) → −6.28% (Jun 28) → **−6.92%** today. Uninterrupted 7-day slide from ~$66K to $59.9K. Fear/greed 18→12 (extreme fear throughout). The promotable trio has accumulated positive drop3 through this entire stretch — strong evidence of macro-independence.
- **Cohort P fully resolved:** launched Jun 27 (7 variants); at n≥100 after only 2–3 days all 7 have resolved — 4 catastrophic (hold60m, sl20, sl40, be30), 1 plain kill (hold20m), 1 still watch (hold30m-strict at n=83). Only hold45m remains ambiguous: positive net but lottery-shaped drop3.
- **Lead pool:** hot leads 41 (Jun 22) → 50 (Jun 29). Growing weekly. Pool quality stable despite macro.
- **Live-micro gap persists:** pair-shadow net=+0.492 vs live-micro net=−0.506 at n=307 (same entries). Δ≈1 SOL on 307 trades. The gap is structural (execution overhead), not sampling noise. Every cycle the pilot runs costs real money.

**Verdicts (proposals — roster changes require operator approval + code edit to `COPY_STRATEGIES`):**

- **PROMOTE (3):**
  - `copy-hotlead`: n=892, net=+14.16, drop3=+7.14, stress=+4.69, monthly=30.3 SOL/mo. Score 100. All gates clear. 8th+ consecutive day promotable.
  - `copy-hotlead-hold30m`: n=845, net=+42.89, drop3=+11.76, stress=+33.33, monthly=91.9 SOL/mo. Score 100. Board's best by every metric. Primary live candidate.
  - `copy-hotlead-strict`: n=517, net=+14.03, drop3=+7.45, stress=+8.42, monthly=30.1 SOL/mo. Score 100. Today is the only strategy in the whole roster printing positive (+0.56 SOL) during the bad June 29 morning — the strict filter is screening out the macro-driven losers.

- **KILL (6 — all urgent, real money on one):**
  - `copy-hotlead-hold30m-live-micro`: n=307, net=−0.506, drop3=−1.239, all gates fail. Real money (0.05 SOL/trade × 307 trades). Kill proposed every daily review since Jun 25 — NOT YET ENACTED. Costs money each cycle it runs.
  - `copy-hotlead-hold60m`: n=118, net=−7.507, drop3=−11.71, stress=−8.57. Catastrophic (net < −3 at n=118). Cohort P window is superseded by catastrophic rule.
  - `copy-hotlead-hold30m-sl20`: n=128, net=−5.846, drop3=−9.322. Catastrophic.
  - `copy-hotlead-hold30m-sl40`: n=117, net=−6.549, drop3=−10.643. Catastrophic.
  - `copy-hotlead-hold30m-be30`: n=125, net=−4.471, drop3=−7.828. Catastrophic.
  - `copy-hotlead-hold20m`: n=136, net=−1.651, drop3=−8.137, stress=−3.019. n≥100, all three robustness gates fail. Reversed from +1.71 on Cohort P day 1 to negative — not a sampling fluke.

- **WATCH:**
  - `copy-hotlead-hold45m`: n=137, net=+14.65, drop3=−11.66. **Lottery-shaped.** Top-3 wins = +26.31 SOL; without them net=−11.66. Positive net but not edge. 5-day window closes Jul 2; if drop3 doesn't improve meaningfully by then, kill per Cohort P criterion (drop3 < parent's +11.76).
  - `copy-hotlead-hold30m-pair-shadow`: n=307, net=+0.492, drop3=−0.72, monthly=2.11 SOL. Monthly fails. Net positive and stress positive, but drop3 still slightly negative. Not a kill — let it run to n=350+.
  - `copy-hotlead-hold30m-strict`: n=83, net=−2.192. Below n=100 threshold; negative. Check at n=100.
  - `copy-hotlead-hold30m-crowdexit`: n=43, net=+1.215, win_rate=0.512 (highest of any strategy). Early but the win rate stands out. 5-day window; WATCH.
  - `copy-hotlead-hold30m-cap2`, `-prune`: n=71/78, both negative. Too small to assess; Cohort Q window ~Jul 2.
  - `copy-hotlead-hold30m-early`, `-nochase`: n=23/19. Tiny — no signal yet.

- **Idealized references (not live candidates):**
  - `copy-conviction-consensus2`: n=1118, net=+18.90, realistic=false, score=80. Upper-bound reference only. Today: −3.71 SOL (partial day — macro headwind hitting ungated strategies hard).
  - `copy-tp100-sl30`: n=2450, net=−19.02. Negative baseline. Continue as paired-comparison reference.

**New strategies to try:** None this cycle. Three promotables waiting for live capital and a 6-strategy kill backlog: adding more experiments before clearing the kill pile is counterproductive and adds RPC polling cost.

**Operator next step:** One code edit clears the highest-leverage backlog: (1) remove `copy-hotlead-hold30m-live-micro`, `copy-hotlead-hold60m`, `copy-hotlead-hold30m-sl20/sl40/be30`, `copy-hotlead-hold20m` from `COPY_STRATEGIES` (6 kills), and (2) add `copy-hotlead-hold30m` as the new live-micro strategy — swapping real money from the failing pilot to the 91.9 SOL/mo winner. This is the same action proposed on Jun 28 (unenacted), with 5 more catastrophic kills now added to the list.

---

## 2026-06-28 — Daily review: three at score=100, live-micro burn continues, Cohort P day 1 in macro headwind

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-06-28",
  "overall": {"n": 6403, "net": 45.94, "drop3": 21.95, "stress": -15.99, "open": 55},
  "retired_summary": {"n": 19256, "net": -95.67},
  "regime_score": 5, "regime_24h": 5, "macro_score": 3, "btc_7d_pct": -6.28,
  "book_daily_today": 6.62,
  "leads": {"n_leads": 155, "hot": 51, "cold": 68},
  "n_promotable_realistic": 3,
  "strategies": [
    {"id": "copy-hotlead",                     "realistic": true,  "n": 807, "net": 13.592, "drop3":  7.012, "stress":  5.008, "promo_score": 100,  "verdict": "PROMOTE"},
    {"id": "copy-hotlead-hold30m",             "realistic": true,  "n": 771, "net": 33.804, "drop3":  9.819, "stress": 25.187, "promo_score": 100,  "verdict": "PROMOTE"},
    {"id": "copy-hotlead-strict",              "realistic": true,  "n": 475, "net": 11.949, "drop3":  5.367, "stress":  6.818, "promo_score": 100,  "verdict": "PROMOTE"},
    {"id": "copy-hotlead-hold30m-pair-shadow", "realistic": true,  "n": 253, "net":  0.834, "drop3": -0.378, "stress":  0.557, "promo_score":  60.6, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-live-micro",  "realistic": true,  "n": 253, "net": -0.158, "drop3": -0.886, "stress": -0.166, "promo_score":  40,   "verdict": "KILL"},
    {"id": "copy-hotlead-hold20m",             "realistic": true,  "n":  76, "net":  1.712, "drop3": -3.590, "stress":  0.895, "promo_score":  59.2, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold45m",             "realistic": true,  "n":  71, "net": -1.064, "drop3": -6.185, "stress": -1.774, "promo_score":  34.2, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-sl20",        "realistic": true,  "n":  71, "net": -2.231, "drop3": -4.545, "stress": -2.918, "promo_score":  34.2, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-be30",        "realistic": true,  "n":  68, "net": -2.236, "drop3": -4.551, "stress": -2.892, "promo_score":  33.6, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-sl40",        "realistic": true,  "n":  66, "net": -2.301, "drop3": -5.344, "stress": -2.935, "promo_score":  33.2, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold60m",             "realistic": true,  "n":  61, "net": -2.596, "drop3": -5.668, "stress": -3.173, "promo_score":  32.2, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-strict",      "realistic": true,  "n":  47, "net": -0.953, "drop3": -3.996, "stress": -1.418, "promo_score":  29.4, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-cap2",        "realistic": true,  "n":  21, "net":  0.344, "drop3": -1.757, "stress":  0.121, "promo_score":  40.4, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-prune",       "realistic": true,  "n":  28, "net":  0.481, "drop3": -2.412, "stress":  0.183, "promo_score":  42.4, "verdict": "WATCH"}
  ]
}
```

**Headline:** Three realistic strategies at score=100 (copy-hotlead, copy-hotlead-hold30m, copy-hotlead-strict) with drop3 all strongly positive and growing — copy-hotlead-strict recovered from "fragile" (+1.70 Jun 25) to solid (+5.37 today) — while the live-micro burn (−0.158 SOL real money at n=253) and hostile macro (BTC −6.28% 7d, fear/greed=18) make an urgent kill + promote swap the single highest-value action.

**Day-over-day (vs 2026-06-25 SNAPSHOT — 3 days; no SNAPSHOT in Jun 27 action entries):**
- Regime: 2→5 (poor to neutral). score_24h=5 — steady, not trending. Book −2.33 SOL in last 6h (partial day still open, 67 active leads).
- Macro: 6→3 (tailwind → headwind). BTC slid from ~$62.9K (Jun 25) to $60,117 today; fear & greed 18 (extreme fear). Worst macro reading in this journal. BTC macro score history over 8 days: 8→6→5→4→5→5→4→2→2→3→4→4→3 — a two-week slide from $66.5K to $60.1K (−9.6%).
- Book daily: Jun 25 −7.26 → Jun 26 +18.46 (strong bounce) → Jun 27 −16.07 (heavy loss, Cohort P's first day) → Jun 28 +6.62 partial. Three-day net for the retained roster: +10.53 SOL.
- **Jun 27 roster cut effects:** Active open positions 136→55; overall drop3 11.43→21.95 (nearly doubled) — removing the negative-drop3 drag clarified the picture immediately.
- **copy-hotlead-strict drop3 recovery:** +1.703 (Jun 25, fragile) → +5.367 (today). Gain of +3.66 in 3 days. Score 96→100. The strict filter continued screening bad entries through the worst of the macro slide. No longer fragile.
- **copy-hotlead-hold30m drop3 improvement:** +4.57 → +9.82 in 176 trades (+5.25). This strategy adds robustness faster than any other in the roster.
- **copy-hotlead drop3:** +6.18 → +7.01 in 188 trades (+0.83). Steady.
- **copy-hotlead-hold30m-live-micro:** n 108→253 (+145 trades). Net −0.295→−0.158 — the last 145 trades were barely positive (+0.137 total), but all three robustness gates still fail at n=253. Real money continuing to bleed.
- **Lead pool:** 143→155 total (+12), hot 41→51 (+10). Best hot-lead count in this journal. Pool strength growing despite macro weakness.

**Week-over-week (Jun 22 → Jun 28):**
- **Converging:** All three core promotables improved robustness through the week despite the Jun 23-25 poor-tape trough (regime 8→1→2). drop3 cushions grew, not shrank, through adversity — sign of genuine edge vs. lottery-shaped strategies that lose drop3 when regime turns.
- **Regime pattern:** Volatile (8→1-2→5). The hard mid-week trough exposed the lottery-shaped strategies (already killed). The promotable trio survived intact.
- **Macro/BTC:** Consistent 13-day decline from $66.5K to $60.1K. Seven consecutive days macro score ≤5. If this continues, it stresses all strategies but the promotable trio has now demonstrated they can accumulate drop3 even under sustained headwind.
- **Lead pool:** Hot leads 41 (Jun 22) → 51 (Jun 28) — steady weekly growth. More qualifying entries for the hotlead gate = more data per cycle.
- **Cohort P (7 strategies, launched Jun 27):** Day 1 complete. All negative except copy-hotlead-hold20m (+1.71 net). Jun 27 was one of the worst book days (−16.07), so a poor start is expected and not conclusive. The 5-day evaluation window closes ~Jul 2. Notable: copy-hotlead-hold20m had a strong bounce today (+3.21) while hold60m (−1.09 today) is approaching catastrophic territory.

**Verdicts (proposals — roster changes require operator approval + code edit to `COPY_STRATEGIES`):**

- **PROMOTE (3):**
  - `copy-hotlead`: n=807, net=+13.59, drop3=+7.01, stress=+5.01, monthly=29 SOL/mo. Score 100. On the promote list for multiple sessions.
  - `copy-hotlead-hold30m`: n=771, net=+33.80, drop3=+9.82, stress=+25.19, monthly=72 SOL/mo. Score 100. Highest monthly run-rate. Primary live candidate.
  - `copy-hotlead-strict`: n=475, net=+11.95, drop3=+5.37, stress=+6.82, monthly=28 SOL/mo. Score 100. Recovered from fragile — now solid.

- **KILL (1 — real money, urgent):**
  - `copy-hotlead-hold30m-live-micro`: n=253, net=−0.158, drop3=−0.886, stress=−0.166, monthly=−0.79 SOL. All robustness gates fail. Real money at 0.05 SOL/position over 253 closed trades. The shadow twin (`pair-shadow`) runs identically and is also net-negative (−0.015 today), confirming the entry logic is the issue, not execution costs alone. Kill recommendation unchanged from Jun 25 — still not enacted. May require force-selling 2 open positions.

- **WATCH (all experiments):**
  - `copy-hotlead-hold30m-pair-shadow`: n=253, drop3=−0.378 (barely negative), stress=+0.557. Net slightly positive. Improving trend. One more cycle.
  - `copy-hotlead-hold20m` (Cohort P): n=76, net=+1.71, drop3=−3.59. Standout positive in the cohort; strong today (+3.21). Too early (day 1 of 5-day window). Track closely.
  - `copy-hotlead-hold60m` (Cohort P): n=61, net=−2.60. **Near catastrophic threshold** (net<−3 at n≥40 rule). Two bad days would trigger early kill inside the window.
  - `copy-hotlead-hold45m`, `copy-hotlead-hold30m-sl20/sl40/be30`, `copy-hotlead-hold30m-strict` (Cohort P): all negative at n=47-71, macro headwind is a valid confound. Hold through the 5-day window (~Jul 2).
  - `copy-hotlead-hold30m-cap2`, `copy-hotlead-hold30m-prune` (Cohort Q): n=21-28, day 0-1. Too early.

**New strategies to try:** None proposed this cycle. Three proven promotables waiting for action and 9 live experiments (Cohort P + Q) in the evaluation window. Execution, not ideation, is the bottleneck.

**Operator next step:** Kill `copy-hotlead-hold30m-live-micro` (real money, all gates fail at n=253) and swap in `copy-hotlead-hold30m` as the live-micro strategy — one PR removes the loser and promotes the 72 SOL/mo winner. This is the highest-value single action: stops real-money bleeding and deploys the proven strategy simultaneously.

---

## 2026-06-28 — Cohort S (crowd-sell exit) + token-metadata capture infra

**Cohort S — `copy-hotlead-hold30m-crowdexit`** (`crowdSellExit: {minSellers:2, windowSec:600}`).
A new EXIT mechanic: close the position when ≥2 distinct smart wallets have sold the mint within
10min — *independent of the entry lead*. Unlike `exitFollow` (mirror the one entry lead's sell), this
follows the whole watched crowd OUT, targeting the SL-driver tail (smart money turning en masse). The
signal is **zero-RPC** — sells are already in `copy_probe_events` (`action='sell'`); it's event-driven
off `onLeadSell`, with one vault re-fetch only when an exit actually fires. New generic field
`crowdSellExit` + `countRecentSmartSellers()` helper + a crowd branch in `onLeadSell`; exit reason
`crowd_sell`. Kill: `n>=100 AND drop3 < parent`. 5-day window.

**Token-metadata capture (infra, no strategy yet).** New `TokenMetadataFetcher` (default-ON,
`COPYTRADE_META_DISABLED` to stop) + `token_metadata` table. For each distinct mint in `copy_trades`
lacking metadata, it calls Helius DAS `getAssetBatch` (1 droppable RPC / ≤100 mints) for
name/symbol/image/json_uri, then best-effort fetches the off-chain JSON for twitter/telegram/website
(pump.fun puts socials there, not in DAS `content.metadata`), and upserts with precomputed
`has_image` / `has_socials` flags. Out-of-band (10-min worker, `firstRunDelayMs` 120s), **never on the
hot copy path**; metadata is immutable so it's cached per-mint forever (failures cached too). This
seeds the "no picture / no socials = rug-ish" dataset the on-chain chart-features can't see — once it
accrues, the rug analysis is a plain `GROUP BY has_socials` over `token_metadata ⨝ copy_trades`. RPC
cost ≈ a few hundred credits/month (bounded by the copied-mint universe, one-time per mint).

---

## 2026-06-28 — Cohort R: two "buying too late" gates (first-mover + price-extension)

> Two more `copy-hotlead-hold30m` variants attacking the same failure mode (entering as exit
> liquidity). Both zero-RPC, share the parent's entries+polls. Kill per id: `n>=100 AND drop3 <
> parent's drop3`. 5-day window.

**`-early` (first-mover) — structural, not backtestable.** `maxConsensusRecent: 1` — only copy when
the lead is the SOLE smart wallet to have bought the mint in the 10-min window (the lead is logged to
`copy_probe_events` before `onLeadBuy`, so count==1 means just the lead). Tests the OPPOSITE of the
killed consensus2 (which required ≥2 buyers and failed drop3): if more-confirmation isn't the edge,
maybe being EARLY is. New generic field `maxConsensusRecent` + gate (skip reason `too_late`), reuses
the cached `countRecentSmartBuyers`.

**`-nochase` (price-extension) — backtested first (DB query C).** Entry/open-price ratio vs net on
739 closed hold30m trades:

| entry/open | n | WR | avg net |
|---|---|---|---|
| <1× (below open) | 170 | .335 | +0.085 |
| **1–1.5× (0–50%)** | 70 | .386 | **+0.219** |
| 1.5–2× | 78 | .231 | −0.034 |
| 2–3× | 89 | .292 | −0.009 |
| 3–5× | 94 | .372 | −0.002 |
| ≥5× | 245 | .371 | +0.031 |

**Non-monotonic** — a naive "skip if extended" cap fails (it'd cut the ≥5× bucket). But the real
signal is clean: **entries at/below +50% of graduation open are the best** (a+b: n=240, +29.9 SOL,
+0.124 avg ≈ 2.5× parent), the 50–300% band bleeds, and the ≥5× bucket is positive only via outliers
(`max_ratio` 321×). → `maxExtensionPct: 50` (buy within +50% of open, or below). New generic field +
`mintOpenPrice()` helper (cached per-mint, null open => not blocked); skip reason `extension`. Gates
on the detection snapshot price (≈ the −lag fill given ~0% median drift).

> Note: the broad "don't chase the moon" framing was only PARTIALLY confirmed (U-shaped, not
> monotonic). The gate is justified as "buy cheap" (keep the robust low-extension entries), not as a
> blanket extension cap. The ≥5× runners we drop net only +0.031 avg and lean on a 321× outlier.

---

## 2026-06-28 — Cohort Q: two data-backed gates (repeat-buy cap + lead exclusion)

> Spawned 2 variants of `copy-hotlead-hold30m` from a DB analysis (run over the new `ops`-branch
> query channel — the legacy `db-query.json` channel was retired). Both gates are pure-SQL/cached
> (zero RPC) and share the parent's hot-lead entries + position polls, so marginal RPC ≈ 0; `-cap2`
> also *cuts* polling. Kill per id: `n>=100 AND drop3 < parent copy-hotlead-hold30m's drop3`. 5-day window.

**The analysis (copy-hotlead-hold30m, 739 closed trades):**
- **Token chart-features are NOT a usable filter — negative result.** `liquidity_sol_t30` is null on
  89% of copied tokens (copies fire independent of T+30 enrichment) → unusable. Holders / top5-conc /
  dev% are all noisy + non-monotonic (no coherent threshold; the "bad" buckets — 150–250 holders,
  3–5% dev — don't form a story). The hot-lead entry already extracts that signal. **Did NOT build
  feature gates** (would be overfitting scattered buckets).
- **Repeat-buying IS a clean signal.** Re-entry ordinal on the same mint: 1st `+0.034` avg (+14.8
  tot), 2nd **`+0.155`** avg (**+24.3** tot — the best bucket, the lead doubling down on a winner),
  3rd `−0.030`, 4th+ `−0.049` (3rd+ = **−5.8 SOL over 146 trades**, ~20% of all entries, plus pure
  extra poll RPC). → cap at 2, NOT 1.

**Built:**

| Strategy | Gate | Hypothesis |
|---|---|---|
| `copy-hotlead-hold30m-cap2` | `maxEntriesPerMint: 2` | Drop the 3rd+ re-entry chase tail (−5.8 SOL) → higher drop3 + less poll RPC. |
| `copy-hotlead-hold30m-prune` | `leadExclusionGate: {minTrades:5, maxNetSol:0}` | Self-prune the bottom leads: once this strategy has ≥5 closed copies of a lead summing ≤0 net, stop copying it. Drops the SL-driver tail (the dashboard "Worst leads"). |

**Mechanics (new, generic — reusable by any strategy):**
- `maxEntriesPerMint` — counts THIS strategy's closed entries on the mint (`already_open` already
  blocks concurrent re-entry, so closed-count = prior-entry count; cap=2 skips the 3rd). Skip reason
  `mint_entry_cap`.
- `leadExclusionGate {minTrades, maxNetSol}` + `leadOwnStats(strategyId, leadWallet)` — reads THIS
  strategy's own closed copies of the lead (NOT the shared `COPY_REGIME_BASELINE` series the hot/elite
  gates use), cache keyed `${strategyId}:${leadWallet}`. Inverse of hotLeadGate: a lead with
  `< minTrades` history is NOT excluded (benefit of the doubt), so it self-prunes as n grows. Skip
  reason `lead_excluded`.

**Deferred:** token metadata capture (image/socials via `getAssetBatch`, out-of-band + cached) — the
behavioral rug signal the chart-features miss; separate build, next round.

---

## 2026-06-27 — Daily review

<!-- SNAPSHOT (machine-readable; do not hand-edit) -->
```json
{
  "date": "2026-06-27",
  "overall": {"n": 5396, "net": 59.75, "drop3": 35.76, "stress": 6.76, "open": 12},
  "retired_summary": {"n": 19256, "net": -95.67},
  "regime_score": 4, "regime_24h": 9, "macro_score": 4, "btc_7d_pct": -5.4,
  "book_daily_today": 4.90,
  "leads": {"n_leads": 153, "hot": 49, "cold": 64},
  "n_promotable_realistic": 3,
  "strategies": [
    {"id": "copy-hotlead",                     "realistic": true,  "n": 745, "net": 15.854, "drop3":  9.273, "stress":  7.863, "promo_score": 100, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-hold30m",             "realistic": true,  "n": 700, "net": 35.541, "drop3": 11.556, "stress": 27.620, "promo_score": 100, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-strict",              "realistic": true,  "n": 432, "net": 13.146, "drop3":  6.563, "stress":  8.433, "promo_score": 100, "verdict": "PROMOTE"},
    {"id": "copy-hotlead-hold30m-pair-shadow", "realistic": true,  "n": 190, "net":  1.014, "drop3": -0.198, "stress":  0.798, "promo_score":  63, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-live-micro",  "realistic": true,  "n": 190, "net":  0.018, "drop3": -0.711, "stress":  0.086, "promo_score":  41, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold20m",             "realistic": true,  "n":   4, "net":  0.132, "drop3": -0.183, "stress":  0.088, "promo_score":  37, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-be30",        "realistic": true,  "n":   4, "net":  0.047, "drop3": -0.183, "stress":  0.004, "promo_score":  26, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-strict",      "realistic": true,  "n":   4, "net":  0.047, "drop3": -0.183, "stress":  0.004, "promo_score":  26, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold60m",             "realistic": true,  "n":   5, "net":  0.084, "drop3": -0.352, "stress":  0.030, "promo_score":  31, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-sl20",        "realistic": true,  "n":   5, "net": -0.016, "drop3": -0.295, "stress": -0.067, "promo_score":  21, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m-sl40",        "realistic": true,  "n":   4, "net": -0.082, "drop3": -0.258, "stress": -0.121, "promo_score":  21, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold45m",             "realistic": true,  "n":   5, "net": -0.255, "drop3": -0.352, "stress": -0.302, "promo_score":  21, "verdict": "WATCH"},
    {"id": "copy-conviction-consensus2",       "realistic": false, "n": 973, "net": 17.971, "drop3":  5.185, "stress":  7.590, "promo_score":  80, "verdict": "WATCH"},
    {"id": "copy-tp100-sl30",                  "realistic": false, "n": 2135, "net": -23.753, "drop3": -30.309, "stress": -45.269, "promo_score": 20, "verdict": "WATCH"}
  ]
}
```

**Headline:** Three realistic strategies all-gates-clear and reinforcing (hold30m now drop3 +11.6 / +82 SOL/mo projected) after a strong June 26 bounce; live-micro pilot trails paper twin by ~2000x (net +0.02 vs +35.54) and is the critical blocker before scaling real capital. T+30 graduation pipeline stalled (does not appear to affect copy-trading).

**Day-over-day** (vs 2026-06-25 snapshot; 2026-06-26 was a roster-cut narrative entry, no snapshot):
- **Roster cut enacted 2026-06-26:** 19 strategies removed (all drop3<0), Cohort P (7 hold30m hill-climb variants) launched today (n=4–5, too early for signal).
- **Promotable core materially stronger:** hotlead Δdrop3 +3.10 (6.18→9.27); hotlead-hold30m Δdrop3 +6.99 (4.57→11.56); hotlead-strict Δdrop3 +4.86 (1.70→6.56). All three moved up significantly, driven by June 26's +26.71 book day.
- **Regime recovered:** score 2→4 (still weak), yesterday 24h score=9; book daily −8.47→+26.71→+4.90 (partial today).
- **Lead pool hotting up:** hot 41→49, cold 65→64. More active signals entering the pool.
- **BTC macro headwind deepened:** 7d −1.74%→−5.4%; 1d bounce +1.05%. Despite worsening BTC, the copy book stayed positive — encouraging macro-independence signal.

**Week-over-week** (last 6 snapshot dates: 06-21 through 06-27):
- **Converging:** all three promotable strategies have been score-100 since at least 06-21 (6+ consecutive days). Drop3 on hotlead-hold30m: +2.89 (06-21) → +4.61 (06-22) → +7.16 (06-24) → +4.57 (06-25) → **+11.56** today. Strongly trending up despite the mid-week (06-23–25) regime trough.
- **Regime pattern:** 06-21=3, 06-22=8 (rally), 06-24=1, 06-25=2 (trough), 06-27=4 (recovery). Volatile but book held up — hotlead edge appears regime-tolerant.
- **BTC trend:** 7d pct went +0.58%→−3.63%→−2.39%→−1.74%→−5.4%. Sustained macro headwind; copy edge holding regardless.
- **Lead pool:** hot leads 37→41→40→41→49. Trending up over the week — expanding signal pool is a positive structural sign.
- **Live-micro gap persistent:** at n=108 on 06-25, pair-shadow was net +0.54 / live-micro net −0.30. At n=190 today: pair-shadow net +1.01 / live-micro net +0.02. The gap is not closing meaningfully with more trades, suggesting a structural issue (RPC entry misses, not sampling noise).

**Verdicts (proposals — roster changes require operator approval + code edit):**

- **PROMOTE — copy-hotlead** (n=745, net=+15.85, drop3=+9.27, stress=+7.86, monthly=+33.97 SOL): all gates clear, 6th consecutive day promotable. Recommend operator approve live-micro entry at 0.5 SOL/trade. This strategy does NOT have an active live-micro twin yet — launching one is the action.
- **PROMOTE — copy-hotlead-hold30m** (n=700, net=+35.54, drop3=+11.56, stress=+27.62, monthly=+82.02 SOL): board's best strategy on every metric. Gate-clear for 6+ days. BUT: existing live-micro pilot (`copy-hotlead-hold30m-live-micro`) is severely underperforming (net +0.02 vs +35.54). Recommend investigating the entry-miss rate on the live side before scaling further. Do not increase live size until the gap is explained.
- **PROMOTE — copy-hotlead-strict** (n=432, net=+13.15, drop3=+6.56, stress=+8.43, monthly=+32.86 SOL): hotlead subset with net≥0.5 floor per lead — highest-conviction entry. All gates clear. No live twin exists yet. Same investigation caveat applies.
- **WATCH — copy-hotlead-hold30m-pair-shadow** (n=190, drop3=−0.198): live pipeline shadow component of hold30m. Drop3 improving (was −0.567 on 06-25). Monitor for sign flip — if drop3 turns positive at n≥100, it clears the bar for pair-shadow mode.
- **WATCH — copy-hotlead-hold30m-live-micro** (n=190, net=+0.018, drop3=−0.711): real-money pilot. Technically n≥100 with negative drop3 → ordinarily KILL, but this is the live execution canary for hold30m. Recommend keeping alive to diagnose the paper/live gap rather than killing it. If a fix is deployed and net doesn't improve materially by n=300, recommend replacing with a fresh live-micro at fixed entry.
- **WATCH — Cohort P (7 hold30m variants, n=4–5 each):** launched today, no actionable signal yet. Re-evaluate 2026-07-02.
- **WATCH — copy-tp100-sl30** (n=2135, net=−23.75): load-bearing baseline reference. 8 open positions + highest poll cost on the roster. With only one active `paired_vs_baseline` comparison (copy-conviction-consensus2, n=504 shared events), the marginal value of keeping this running is declining. Recommend operator decision: keep as reference OR retire to reduce RPC/slot usage.

**New strategies to try:** None this cycle. Cohort P just launched (7 variants targeting hold-duration and SL sensitivity). Let it run to n≥50 before proposing additions.

**Critical open question — live-micro gap:** The paper hold30m prints +35.54 SOL cumulative; the live-micro twin prints +0.018 at the same n=190. A 5-second entry delay is already baked in (both are `realistic_execution`). Likely cause: the live execution layer is missing entries that paper captures — either Helius RPC throttling under load (`copy_poll` rate limit), or position capacity conflicts (live strategy hits `already_open` skips that the paper path ignores). Check `gate_skips.price_fail` and `gate_skips.rpc_drop` vs `entered` ratios on the live-micro strategy to diagnose.

**Operator next step:** Before promoting any strategy to live capital, diagnose why `copy-hotlead-hold30m-live-micro` (net +0.018 at n=190) diverges so severely from its paper twin (net +35.54 at n=700). Check logs for entry-miss rate on the live side. If it's RPC throttling, the fix is in place already (roster was just cut in half) — wait for the next 50 live trades to see if fills improve. If it's capacity skips, lower `maxConcurrentPositions` on the live strategy.

---

## 2026-06-27 — New experiment cohort P (hold30m hill-climb)

> Spawned 7 variants of the board's best strategy, `copy-hotlead-hold30m` (parent: net +35.9,
> drop3 +11.9, ~89 SOL/mo, WR 34%). Each changes exactly ONE lever and shares the parent's
> hot-lead entry (lastN10 / ≥3 / net>0, lag5 + drift10). Because `poll()` dedupes price fetches
> by `baseVault`, every variant that enters the same lead-buys as the parent **shares its entry +
> poll RPC** — near-zero marginal budget. Removed `copy-3eg1-*` (dormant single wallet, n=0) in the
> same change to free roster slots.

**Bar / kill criterion (per id):** `n >= 100 AND drop3 < parent copy-hotlead-hold30m's drop3` — a
variant must beat the parent on *robustness* (drop_top3), not just raw net. **Window: 5 days**
(re-evaluate ~2026-07-02; most will still be n<100 → WATCH unless they decisively bleed).

| Strategy | Lever changed | Hypothesis |
|---|---|---|
| `copy-hotlead-hold45m` | `maxHoldSec` 1800→2700 | 30m time-stop cuts runners short; +15m captures more of the runner tail. |
| `copy-hotlead-hold60m` | `maxHoldSec` 1800→3600 | Same, further out — finds where the hold curve turns. |
| `copy-hotlead-hold20m` | `maxHoldSec` 1800→1200 | Opposite: positions not moving by 20m just fade; exit earlier lifts drop3. |
| `copy-hotlead-hold30m-sl20` | `slPct` 30→20 | Tighter stop cuts losers faster (WR↑); test if drop3 survives. |
| `copy-hotlead-hold30m-sl40` | `slPct` 30→40 | Wider stop gives runners room before the no-TP ride. |
| `copy-hotlead-hold30m-be30` | +`breakevenAtPct:30` | Once +30%, raise stop to entry+buffer — de-risk pop-then-fade WITHOUT capping runners. |
| `copy-hotlead-hold30m-strict` | `hotLeadGate.minNetSol` 0→0.5 | Best-entry × best-exit: the promotable `-strict` net floor on the 30m runner exit. Subset of parent's tokens (zero marginal RPC). |

**Explicitly NOT tested:** trailing-TP / scale-out / ratchet exits on this base (cohort O already
proved they cut drop3 here — INVALID), and the consensus overlay (`minConsensusRecent:2`) — deferred
per operator (`copy-hotlead-consensus` already failed drop3 on the no-hold base).

**Predictions (resolve at n≥100 or 5 days):** each variant `{target_drop3 > 0, target_n: 100,
target_days: 5, kill: "n>=100 and drop3 < parent"}`. The hold-duration and breakeven arms are the
highest-information (they move the exit the parent leaves on the table); `-strict` is the highest-
conviction (proven entry floor × proven exit).

---

## 2026-06-27 — Roster cut (RPC-budget + robustness)

> Roster-change entry, not a daily snapshot (no machine `SNAPSHOT` block — `/copy-daily-report`
> regenerates those). Operator-approved cut driven by the Helius RPC budget: monthly cap 10M,
> reset on the 22nd, already at 2.5M on the 27th (~500k/day ≈ 15M/mo trajectory). Copy position
> polling (`copy_poll`) is ~23% of REST RPC and scales directly with concurrent open positions.

**Action: removed 19 strategies from `COPY_STRATEGIES`** (`src/copytrade/copy-trader.ts`). All 19
fail the realistic-execution bar (drop3 < 0). Removes ~20 of 37 polled open positions (~54%),
cutting the `copy_poll` slice roughly in half on top of the scoring-worker reductions already made.

**Kept (5 research + 1 live twin):** `copy-hotlead` (+14.5 / drop3 +7.9, PROMOTABLE),
`copy-hotlead-hold30m` (+35.9 / +11.9, PROMOTABLE, best), `copy-hotlead-strict` (+12.0 / +5.4,
PROMOTABLE), `copy-conviction-consensus2` (+17.7 / +5.0, robust idealized anchor),
`copy-tp100-sl30` (load-bearing paired/regime baseline — kept despite worst P&L −24.5 & highest
poll cost; flag for separate review), plus the `copy-hotlead-hold30m-pair-shadow` / `-live-micro`
twins (the live-execution pipeline for the best strategy — NOT cut; removing them would force-sell
the open live bag).

**Conclusions recorded per cohort:**

- **Cohort O (exit × entry cross, 9 killed)** — `copy-hotlead`/`-hold30m`/`cons2elite` ×
  `scaleout-trailtp`/`trailtp-wide`/`ratchet-trailtp`. Kill criterion was drop3 ≥ the entry's
  static-exit twin; **all 9 failed** (drop3 −1.8 to −5.7). **Trailing-TP / scale-out / ratchet
  runner exits do not beat static TP100/SL30 on the promotable entries** — they trade drop3
  robustness for raw net. The `cons2elite` arm is net- and drop3-negative on every exit (entry too
  weak, confirms the 06-24 c2rr finding). The runner-exit search is closed.
- **Cohort N (daily-loss circuit breaker, 6 killed)** — 3 matched `-cap` (dailyLossCapSol=3) vs
  `-ctrl` pairs on hotlead / elitelead / hotlead-consensus. Win was `-cap` higher floor AND net ≥
  `-ctrl`. **All six arms net-negative** (cap −2.7/−3.9/−1.5, ctrl −1.3/−3.8/−2.1); the cap can't be
  validated on bases that themselves lose, so the circuit-breaker question is **unresolved, not
  refuted**. **LESSON:** the fresh same-age `-ctrl` twin of our best strategy ran negative (−1.3)
  while the older `copy-hotlead` booked +14.5 on the identical gate → **the hotlead edge is
  front-loaded / regime-sensitive; watch `copy-hotlead` for decay.** Re-run the cap test only once a
  base clears the bar fresh.
- **`copy-hotlead-deep` (lottery)** — lastN20/≥5-trade "stable" lookback. n=550 net +5.2 but drop3
  −1.37: net is tail-driven. The longer lookback adds nothing over `copy-hotlead` (lastN10/≥3) and
  `copy-hotlead-strict` (net-floor 0.5), which are the robust calibrations.
- **`copy-elitelead` (J2, lottery)** — cumulative-positive lead ≥10 trades. n=285 net +1.6 drop3
  −1.92: **stable-reputation lead selection underperforms recency.** Cumulative lead quality is not
  the durable signal; recency + a net floor is. Token-level consensus remains the keeper, not lead
  reputation.
- **`copy-hotlead-consensus` (I2, borderline)** — lead × token (hot lead's pick + ≥2 smart wallets).
  n=327 net +5.6 drop3 −0.87: the consensus overlay adds no robustness over plain `copy-hotlead`.
  Marginal sign-flip (was WATCH 06-25) — revivable if regime turns.
- **`copy-consensus2-elite` (J3, borderline)** — consensus2 × elite lead. n=164 net +2.1 drop3
  −0.75, sign-flipped from +1.06 on 06-25. Stacking two weak-positive gates didn't compound into a
  robust edge. Revivable.

**Not touched:** the 3 new `copy-3eg1-*` single-wallet experiments (n=0, just launched) stay as the
active experiment per operator.

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
