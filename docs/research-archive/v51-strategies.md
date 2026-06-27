# v51 cohort — four new shadow strategies (2026-06-04)

Context: market regime is **RED** (pump_rate 14%, fast_rug 20%, median T+300 −3.5%; RED 53% of recent
hours). Only 3 of 101 enabled strategies survive drop-top3, and v25 (excl+climbing) — the long-time
leader — is now flagged DECAYING with a last-25 mean of −22.7%. The whole book is fading with the tape.

Decisive finding from `peak-analysis.json`: **universe EV is negative at every take-profit level**
(`recommended_tp` = TP100 at −6.55%). When trades miss TP they bleed ~−31% (TP15 non-hit), and
DUMP-labeled tokens slide monotonically to −49% by T+300. The problem isn't the entry or the TP —
it's the **downside tail**. Path predictors that actually separate winners (`price-path-stats.json`,
Cohen's d): monotonicity_0_30 0.58, shallow max_drawdown_0_30 0.54 (both medium); dip_and_recover_flag
0.03 (negligible). Unconditional later entry is *worse* (T+30 −5.3% → T+60 −7.2%), so any dynamic
entry's edge is in the **skip**, not the wait.

All four below are **shadow-mode, no code changes** — built entirely from existing graduation_momentum
columns and strategy params. Promotion bar unchanged: n≥100 · drop_top3>0 · total≥0.5 SOL ·
monthly≥3.75 SOL · Panel 7 NOT OVERFIT · Panel 11 regime std-dev <15%.

## 1. `v51-confirm-gate` — dynamic multi-checkpoint confirmation entry
v25's base, but require a **two-point monotonic climb** (pct_t15 < pct_t30 < pct_t45, via
`recovery_t30_above_t15` + `recovery_t45_above_t30`) **and** shallow early drawdown
(`max_drawdown_0_30 > −10%`, tighter than v25's −25%). Enters at T+60 on confirmed recovery only;
rejects fade-then-die candidates that pass v25's single climb check. TP100 / SL30 / 300s.

## 2. `v51-tail-guard` — v25 entry, truncated left tail
**Identical entry to v25** (controlled comparison) with the exit rebuilt to cap downside:
SL10 (vs 30) + 1s poll + breakeven@+30% + tighten-to-7% at half-hold. Directly attacks the
−31% non-hit bleed. Tests whether truncating the tail makes net SOL regime-stable even if win rate falls.

## 3. `v51-capitulation-bounce` — mean-reversion scalp (uncorrelated sleeve)
The only non-momentum bet. Buy tokens **down 10–60% at T+30** that confirm a bounce
(t30>t15 AND t45>t30), exit fast: TP15 / SL12 / 120s / 1s poll. Low correlation to the all-momentum
book should stabilize the aggregate. Honest prior: dip_and_recover is negligible for T+300, so this is
shadow-validated as a *fast scalp only*, never a hold — forward-test in shadow avoids look-ahead bias.

## 4. `v51-quality-momentum` — quality concentrate (T+30 entry)
Stack the strongest single signals on the proven mid-velocity band: vel 20–50 + liq>100 + age>10min
(+4.1 avg final) + `max_drawdown_0_30 > −10%` (+4.4, best single path filter) + monotonicity>0.5.
A stricter cousin of the current best living candidate `v9shadow-velmid-liq-mono`, adding the drawdown
and age gates. TP150 / SL25 / 300s.

## Follow-ups requiring operator/code action (not in this push)
- **Re-enable `entry-time-matrix`** research panel (currently disabled via `SYNC_HEAVY_PANELS!=true`) to
  find the optimal confirmation checkpoint for idea 1. Operator env toggle — left off to protect dashboard latency.
- **Leading-indicator size taper** for idea 2: `fast_rug_rate` leads live P&L by 2–3h (corr +0.27).
  Tapering position size when rolling rug-rate rises needs new code; the structural early-stop in
  `v51-tail-guard` is the no-code first cut.
