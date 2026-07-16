# D3 `live-cost-recon` — live-execution cost reconciliation (2026-07-12)

*Enacts thesis D3 from `docs/phase1-handoff-2026-07-12.md`. Read-only ops-DB study over the `ops`
branch (`copy_trades`, `execution_mode='live_micro'` joined to shadow twins on `copy_event_id`).
Zero RPC, no strategy slot, no capital touched. **Proposal voice** — the operator decides. The
pre-registered P1/P2/P3 were written in the merged 07-12 handoff before this ran; verdicts below.*

## TL;DR

**The pending live-micro funding recommendation is BLOCKED.** At the only execution cost we can
measure (~**3.1pp entry slippage**, from 324 clean matched pairs), the flat **3% round-trip
assumption in the promotion bar is roughly half the real cost**, and under that haircut the
**incumbent `copy-hotlead-strict` fails re-costing (drop3 → −5.9 SOL, monthly → ~1.3)** — while
**`copy-hotlead-strict-hi` survives** (drop3 → +2.3, monthly → ~13), the reverse of the daily
journal's ranking. BUT every live trade in the DB is **June 18–29**; the executor has been paused 13
days and reworked since (the rent-bug era is in this sample), so the estimate is **stale with wide
error bars**. **Recommendation: do not fund live-micro on the current evidence; if live is still
wanted, run a bounded calibration burst (≤0.3 SOL) on the current executor first.**

---

## The data (two ops-DB queries)

### Query 1 — live_micro inventory (all copy live trades ever)

| strategy | n | closed | failed | live_error | has copy_event_id | first→last day | net SOL | jito | ata rent | avg land ms |
|---|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|
| `copy-hotlead-hold30m-live-micro` | 324 | 324 | 0 | 6 | 324 | 06-23 → **06-29** | −0.745 | 0.266 | 0.469 | 1915 |
| `copy-consensus2-lag-drift5-live-micro` | 172 | 172 | 0 | **136** | 0 | 06-18 → 06-19 | −0.201 | 0.037 | 0.039 | — |
| `copy-hotlead-deep-live-micro` | 146 | 146 | 0 | 1 | 2 | 06-20 → 06-23 | −0.425 | 0.188 | 0.206 | — |

Four load-bearing facts fall straight out of this:

1. **No modern-era sample.** The newest live copy trade in the entire DB is **2026-06-29** — 13 days
   ago. Live trading was paused (`copy-trader.ts`: "KILLED 2026-06-29 operator request — pause live
   trading"). **The "active: true" flag the 07-11 journal alarmed about is stale** — hold30m's
   −0.745 SOL is a *historical June total, not an ongoing bleed.* No live capital has moved in 13
   days. (This corrects the journal's "real money currently losing" framing: it is real money that
   lost, once, in June, and has been idle since.)
2. **`consensus2` is the rent-bug era, excluded.** 136/172 rows (79%) carry a `live_error` — the
   `InsufficientFundsForRent` / `live_buy_failed` funding symptom documented in the research archive,
   *not* slippage. It also has **zero** `copy_event_id`, so it can't be cleanly matched. Excluded
   from cost estimation as a funding artifact per the pre-registered segmentation rule.
3. **`hold30m` is the one clean, joinable sample** — 324 rows, only 6 errors, **100% copy_event_id
   coverage**, so it matches its shadow twin (`copy-hotlead-hold30m-pair-shadow`, alive over the same
   window) exactly 1:1. This is the study's spine.
4. **Land time is ~1.9s, not 4.4s.** The 4.4s figure the handoff cited was from `trades_v2` — the
   *retired v25 graduation bot's* executor, a different code path. The copy executor landed at
   ~1915ms in June. (Correction to the handoff's D3 mechanism note; doesn't change the verdict, but
   the latency budget is smaller than stated.)

### Query 2 — hold30m clean matched-pair gap (324 pairs, joined on copy_event_id)

Compared on return % (`net_sol / size_sol × 100`); `entry_slip_pp = (live_entry / shadow_entry −
1) × 100` is the pure entry execution slippage on the identical event (~5s apart).

| day | matched | entry_slip_pp | live_ret_pp | shadow_ret_pp | gap_pp | errs |
|---|--:|--:|--:|--:|--:|--:|
| 06-23 | 20 | 2.89 | 6.24 | 12.44 | −6.20 | 0 |
| 06-24 | 73 | 1.88 | −4.65 | 13.58 | **−18.23** | 0 |
| 06-25 | 44 | 3.75 | −4.72 | 4.01 | −8.73 | 0 |
| 06-26 | 47 | 1.57 | 11.07 | 13.91 | −2.85 | 0 |
| 06-27 | 35 | 4.85 | −11.03 | −10.41 | −0.62 | 3 |
| 06-28 | 76 | 1.83 | −7.58 | −7.85 | **+0.27** | 2 |
| 06-29 | 29 | 9.26 | −21.97 | −21.90 | −0.07 | 1 |
| **ALL** | **324** | **3.12** | **−4.62** | **+1.47** | **−6.08** | 6 |

**Reading it:** the end-to-end −6.08pp gap is *not* a flat tax. Entry slippage is stable at
~1.5–3.8pp on normal days (the 9.26pp on 06-29 is a thin, −22% crash day — outlier). The wild
end-to-end swings (−18pp on 06-24, ~0 on 06-27/28/29) are the **30-minute-hold exit path diverging**
— on 06-24 the shadow rode winners to +13.6% that live's exit timing missed. That exit divergence is
**hold30m-specific and does NOT transfer** to the TP100/SL30 incumbents (limit-like exits). **The
transferable, strategy-agnostic execution cost is the entry slippage: ~3.1pp.**

---

## Verdicts (against the pre-registered predictions)

### P1 — does the gap survive segmentation to ≤2pp? **FAIL (gap is real).**

Segmented as pre-registered: excluding the 6 error rows and the 06-29 thin-day spike, entry
slippage is still ~2–3.8pp per normal day, **~3.1pp overall — above the 2pp threshold.** The 3%
round-trip *total* assumption is under-modeling entry alone (real entry ~3.1% vs a modeled ~1.5%
each-way). Per the pre-registered rule, **P1 fails → the "fund live-micro now" recommendation is
KILLED** pending either a demonstrated executor improvement (P3 path) or a bar recalibration.
*Caveat: the sample is 3 weeks old and pre-dates the retry rework — see P3.*

### P2 — do the incumbents survive re-costing? **strict FAILS; strict-hi SURVIVES.**

Re-cost each shadow strategy by shifting every closed trade's net down by the extra execution cost.
At fixed shadow size 0.5 SOL, an extra `h` pp/trade is a constant shift `c = h/100 × 0.5` SOL — which
preserves trade ordering, so drop3 shifts by `c × (n−3)`. Applied to the 07-12 scoreboard
(`strict` n=824, net 13.38, drop3 6.80, monthly 28.68; `strict-hi` n=143, net 6.63, drop3 4.43,
monthly 19.88):

| haircut | `copy-hotlead-strict` net / drop3 / monthly | `copy-hotlead-strict-hi` net / drop3 / monthly |
|---|---|---|
| +1.5pp (optimistic — executor improved) | +7.2 / **+0.64** / ~15 | +5.6 / +3.4 / ~17 |
| **+3.1pp (measured entry slip)** | +0.6 / **−5.9** ✗ / ~1.3 ✗ | +4.4 / **+2.3** ✓ / ~13 ✓ |
| +6.0pp (pessimistic — full end-to-end) | −11.3 ✗ / −24 ✗ / ✗ | +2.3 / +0.2 / ~7 |

**`copy-hotlead-strict` — the daily journal's preferred candidate — does not survive the measured
cost:** its thin +3.25%-of-position per-trade edge is eaten, drop3 flips to −5.9 and monthly falls
to ~1.3 (below the 3.75 bar). It clears only the optimistic 1.5pp case, and thinly (drop3 +0.64).
**`copy-hotlead-strict-hi` survives across the whole range** (drop3 stays positive even at 6pp)
because its per-trade edge (+9.3% of position) is ~3× larger. This **inverts the journal's ranking**:
under realistic execution cost, the higher-conviction, thinner-n strict-hi is the more live-robust
of the two, and strict is the fragile one. (Both estimates are *conservative* — 3.1pp was measured at
0.05 SOL; price impact at 0.5 SOL is larger, so the real haircut ≥ this.)

### P3 — is the modern sample sufficient? **NO — decisively (zero modern pairs).**

Pre-registered trigger: "if current-era matched pairs < 100, report wide error bars and recommend a
bounded calibration burst." **Current-era pairs = 0.** Every live trade is June 18–29, on an executor
that has since been paused and reworked (the rent bug in the consensus2 sample is fixed; retry logic
changed). So the ~3.1pp estimate describes a **retired executor state**, not what live would cost
today. The honest posture: the P1/P2 failures are the best available evidence and **default to
NOT funding**, but the number is not current.

---

## Decision rule outcome + recommendations (proposals)

Per D3's pre-registered decision rule (funding BLOCKED until P1+P2 reported):

1. **Do not fund live-micro on the current evidence.** P1 fails (~3.1pp real vs 2pp bar) and P2 fails
   for the journal's lead candidate (`strict`). The predictable outcome of funding `strict` now is a
   slow bleed, exactly as its June live twin did.
2. **If live is still wanted, the path is a bounded calibration burst first** — ~20 trades × 0.05 SOL
   (**≤0.3 SOL at risk**, behind the existing `DAILY_MAX_LOSS_SOL` breaker, operator sign-off) on the
   **current** executor, purely to measure modern slippage. This is explicitly a measurement, not a
   P&L bet. If modern entry slip comes in **≤1.5pp**, `strict` re-enters viability and `strict-hi`
   becomes a clear go; if it's still ~3pp, `strict` is permanently shelved as live-unviable and only
   `strict-hi` proceeds.
3. **If funding proceeds at all, prefer `copy-hotlead-strict-hi` over `copy-hotlead-strict`** — it is
   the only incumbent whose drop3 stays positive under the measured cost. This reverses the current
   journal recommendation and should be flagged.
4. **`copy-hotlead-hold30m-live-micro`: confirm inert / clear the stale flag.** It has not traded
   since 06-29; the `active: true` is a dangling config flag, not an active position. Recommend the
   operator formally disable it (or document it) so future journal runs stop reading it as live
   capital at risk — but note the urgency is lower than the 07-11 journal implied (nothing is
   currently bleeding).
5. **Consider recalibrating `SIM_DEFAULT_COST_PCT` (currently 3.0%)** — a separate, reviewed
   follow-up. The June evidence says the true round-trip is closer to ~6% (entry ~3.1pp + a
   comparable exit leg) for these thin fresh-pool fills. Raising the shadow cost assumption would
   make the *entire* copy scoreboard honest about live viability, not just the two incumbents — but
   it should be set from a *modern* calibration burst, not this stale sample. **Explicit non-goal of
   this study:** no gate/constant is changed here; measure first.

## Caveats

- Stale sample (June 18–29); executor reworked since. The whole study is a lower-bound read on a
  retired code path — hence the calibration-burst recommendation before any capital decision.
- Entry slip measured at 0.05 SOL; 0.5 SOL fills would slip more (conservative direction).
- The end-to-end −6.08pp gap is inflated by hold30m's exit-timing divergence and should **not** be
  used as the incumbent haircut — the ~3.1pp entry slip is the transferable number, with the
  exit leg estimated, not measured, for TP100/SL30.
