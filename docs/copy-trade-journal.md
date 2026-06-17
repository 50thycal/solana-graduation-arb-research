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
  "overall": {"n": 6327, "net": -20.18, "drop3": -50.58, "stress": -84.94, "open": 302},
  "regime_score": 1, "regime_24h": 4, "macro_score": 6, "btc_7d_pct": 5.78,
  "book_daily_today": -0.37,
  "leads": {"n_leads": 85, "hot": 24, "cold": 38},
  "n_promotable_realistic": 0,
  "strategies": [
    {"id": "copy-consensus2-lag-drift5", "realistic": true, "n": 117, "net": 2.02, "drop3": -0.28, "stress": 0.78, "promo_score": 62.8, "verdict": "WATCH"},
    {"id": "copy-consensus2-lag", "realistic": true, "n": 159, "net": 1.05, "drop3": -2.85, "stress": -0.60, "promo_score": 55.0, "verdict": "KILL"},
    {"id": "copy-hotlead", "realistic": true, "n": 57, "net": 0.75, "drop3": -1.48, "stress": 0.15, "promo_score": 47.9, "verdict": "KEEP"},
    {"id": "copy-bigbuy", "realistic": true, "n": 7, "net": 1.16, "drop3": -0.72, "stress": 1.06, "promo_score": 47.0, "verdict": "WATCH"},
    {"id": "copy-tp100-sl30-lag", "realistic": true, "n": 370, "net": -9.84, "drop3": -14.39, "stress": -13.46, "promo_score": 40.0, "verdict": "KILL"},
    {"id": "copy-followsell-lag", "realistic": true, "n": 545, "net": -2.55, "drop3": -6.29, "stress": -8.12, "promo_score": 40.0, "verdict": "KILL"},
    {"id": "copy-tp100-sl30-lag-drift10", "realistic": true, "n": 329, "net": -6.31, "drop3": -10.78, "stress": -9.57, "promo_score": 40.0, "verdict": "KILL"},
    {"id": "copy-followsell-lag-drift10", "realistic": true, "n": 446, "net": -1.22, "drop3": -4.54, "stress": -5.79, "promo_score": 40.0, "verdict": "KILL"},
    {"id": "copy-consensus2-lag-drift10", "realistic": true, "n": 117, "net": -1.65, "drop3": -4.63, "stress": -2.82, "promo_score": 40.0, "verdict": "KILL"},
    {"id": "copy-macro", "realistic": true, "n": 59, "net": -1.85, "drop3": -4.71, "stress": -2.42, "promo_score": 31.8, "verdict": "WATCH"},
    {"id": "copy-regime-mid", "realistic": true, "n": 53, "net": -2.92, "drop3": -5.77, "stress": -3.41, "promo_score": 30.6, "verdict": "WATCH"},
    {"id": "copy-regime-hi", "realistic": true, "n": 39, "net": -2.98, "drop3": -4.99, "stress": -3.32, "promo_score": 27.8, "verdict": "WATCH"},
    {"id": "copy-hotlead-hold30m", "realistic": true, "n": 37, "net": -0.52, "drop3": -3.20, "stress": -0.89, "promo_score": 27.4, "verdict": "WATCH"},
    {"id": "copy-macro-regime", "realistic": true, "n": 29, "net": -2.47, "drop3": -5.02, "stress": -2.72, "promo_score": 25.8, "verdict": "WATCH"},
    {"id": "copy-hotlead-regime", "realistic": true, "n": 17, "net": -2.32, "drop3": -2.96, "stress": -2.45, "promo_score": 23.4, "verdict": "WATCH"},
    {"id": "copy-hotlead-consensus", "realistic": true, "n": 15, "net": -0.67, "drop3": -2.79, "stress": -0.81, "promo_score": 23.0, "verdict": "WATCH"},
    {"id": "copy-hotlead-deep", "realistic": true, "n": 5, "net": -0.41, "drop3": -0.49, "stress": -0.45, "promo_score": 21.0, "verdict": "WATCH"},
    {"id": "copy-hotlead-strict", "realistic": true, "n": 4, "net": -0.14, "drop3": -0.26, "stress": -0.18, "promo_score": 20.8, "verdict": "WATCH"}
  ],
  "note": "First journal entry (seed). J-cohort (consensus3 / elitelead / consensus2-elite) pending deploy — not yet in data."
}
```

**Headline:** Nothing is promotable on realistic execution; `copy-consensus2-lag-drift5` (score 62.8, n=117, +2.02, drop3 −0.28, stress +0.78) is the lone bright spot and sits a hair below the drop3 line — everything else with n≥100 has decisively failed.

**Day-over-day:** First entry — no prior baseline. Regime is poor right now (1/10, 24h trend 4); macro is a mild tailwind (6/10, BTC 7d +5.78%). Book essentially flat today (−0.37).

**Week-over-week:** Establishing the baseline. The arc of the last week: a brutal regime (two −36 SOL days on 06-13/06-14) followed by recovery (06-15 +10/+17), now soft again. The realistic-execution strategies launched into that bad stretch, which is depressing their drop3 — the idealized mirrors (which ran longer, through better tape) look far better but are not live candidates.

**Verdicts (proposals — roster changes need approval + a `COPY_STRATEGIES` code edit):**
- PROMOTE: none. No realistic strategy clears the bar.
- KEEP COOKING: `copy-hotlead` (n=57, regressed from its n=31 peak — watch closely, leaning negative).
- KILL (realistic, n≥100, fails drop3 + stress decisively): `copy-tp100-sl30-lag` (−9.84), `copy-tp100-sl30-lag-drift10` (−6.31), `copy-followsell-lag` (−2.55), `copy-followsell-lag-drift10` (−1.22), `copy-consensus2-lag` (−2.85 drop3, dominated by its drift5 twin), `copy-consensus2-lag-drift10` (−4.63 drop3, the drift gate too tight for consensus). The plain TP/SL and follow-sell signals do not survive realistic execution.
- WATCH: `copy-consensus2-lag-drift5` — at the decision point (n=117) but drop3 only −0.28 with positive net/stress/monthly; keep one more week, kill if drop3 still <0 at n≥150. `copy-macro` / `copy-regime-mid` / `copy-regime-hi` (n≈40–59, negative — will flip to KILL if still negative at n≥100). The hotlead-stacks (n<40) — too sparse, leaning invalid.

**New strategies to try:** The J-cohort is already queued (pending deploy of the latest commits): `copy-consensus3` (≥3 wallets), `copy-elitelead` (cumulative lead quality), `copy-consensus2-elite` (consensus × proven lead). These double down on the durable signal (consensus / lead selection) and replace noisy recency. No new ideas beyond these until they collect.

**Operator next step:** Deploy the latest dev-branch commits so the J-cohort starts collecting, and approve the 6 KILL proposals above to clear the decisively-failed realistic strategies (cuts clutter + RPC). Hold `consensus2-lag-drift5` — it's the one to watch.
