# Copy-Trade Journal

Daily review log for the copy-trading subsystem, maintained by the `/copy-daily-report` skill.
Newest entry first. Each entry has a machine-readable `SNAPSHOT` block (used by the next day's
run to compute day-over-day deltas — do not hand-edit it) followed by human prose.

**Bar:** a copy strategy is promotable only with realistic execution (5s entry delay) AND n≥100 AND
drop_top3>0 AND exit_stress>0 AND monthly≥3.75 SOL. Idealized 1:1 mirrors are upper-bound references,
never live candidates. Roster changes are code edits to `COPY_STRATEGIES` (operator-approved), not
`strategy-commands.json`. Recommendations here are proposals.

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
