# X1 — Execution-cost lever: is round-trip cost reducible below what the entry needs? (2026-07-16)

*Read-only ops-DB scoping study via `/solana-strategy-phase-2` (execution/measurement, path c — no
shadow slot, no code change, no live money). Follows N1 (`docs/n1-edge-death-2026-07-16.md`) and D3
(`docs/live-cost-recon-2026-07-12.md`). Voice: proposal.*

> **RESOLVED same day, superseding the burst recommendation below:** the operator's own live-trading
> experience puts real round-trip cost at **6–10%**, sometimes worse than the modeled 6%. This
> answers the burst's question directly (well above the ~4.4% target) — the cost lever is **closed,
> FAIL**. See `docs/copy-strategy-lab.md` (2026-07-16, "X1 RESOLVED by operator-observed live cost")
> for the full resolution. Do not run the burst below; the question it targeted is already answered.

## Why this study

N1 established the hot-lead edge is dead at the 6% realistic cost, and that the cause is **cost**
(the same trades net +17.31 SOL at 3% but −1.86 at 6%). N1's North-Star verdict left two live
levers: a genuinely new data input, or **lower execution cost**. This study scopes the cost lever:
**what round-trip cost does the entry actually need, and is that reachable?**

## The target (computed from the N1 row-level pull — no new data needed)

Sweeping the round-trip cost on the 1,034 hot-lead `-lag` rows and finding where drop3/trade crosses 0:

| cohort | breakeven cost for **drop3/t = 0** | for net/t = 0 |
|---|---|---|
| POOLED strict + strict-hi (n=1034) | **~4.37%** | ~5.64% |
| strict-hi alone (incumbent, n=198) | **~2.91%** | — |

So to revive the edge, round-trip cost must fall from 6% to **~4.4% (pooled)** — a **~1.6pp cut** — or
to **~2.9%** for the incumbent alone (a ~3.1pp cut). That is the bar the cost lever has to clear.

## Decomposing the 6% — what's reducible and what isn't

The 6% (`SIM_DEFAULT_COST_PCT`) is applied as a **flat % regardless of trade size** (`tradeNetSol`,
`copy-trader.ts:1026`), but it was calibrated by D3 from **0.05 SOL live-micro** June trades, where
fixed costs dominate as a percentage. Decomposed against the recorded data:

**1. Entry-latency drift is NOT a mean cost — it is slightly favorable.** `entry_drift_pct` (the
detection→5s-fill drift, already priced into the `-lag` entry) averages **−3.1% on strict-hi, −2.2%
on strict, −1.3% on tp100-sl30-lag** — the 5s wait tends to catch a *dip*, not a chase (consistent
with the freshdip finding). High variance (abs-drift 5–7%), but mean-favorable. **Implication:
"execute faster" does not recover cost on the mean** — it would cut variance, not the average cost.
The latency is not the lever.

**2. Fixed mechanical costs (Jito tip + ATA rent) are real and controllable at micro size, but the
headroom is modest.** From the two live-micro samples (entry-side stored `jito_tip_sol` +
`ata_rent_sol` per trade, size 0.05):

| live strategy | tip+rent / trade | % of 0.05 SOL (entry-side) |
|---|---|---|
| `copy-consensus2-lag-drift5-live-micro` (n=170) | 0.000428 SOL | **0.86%** |
| `copy-hotlead-hold30m-live-micro` (n=323) | 0.002274 SOL | **4.55%** |

The 5× spread is almost entirely **tip aggressiveness** — modest tips run ~1%, aggressive ~4.5%.
- **ATA rent recovery is already implemented** (`executor.ts:876–897` appends a `CloseAccount` ix on
  the sell, refunding rent; `ata_rent_sol` stores only the *permanent* unrecovered residual). So the
  recorded rent is already net-of-recovery — the residual (~0.0002–0.00145 SOL/trade) is small
  headroom, not a free 4%.
- **Tip discipline** is the meaningful fixed-cost lever: keeping tips modest saves ~2–3.5pp *at 0.05
  SOL* vs aggressive tipping.

**3. Size amortizes the fixed costs — a genuine lever, but it trades against slippage and risk.**
Because the SIM cost is flat-% but the real fixed cost is per-trade-SOL, a larger live size dilutes
tip+rent as a fraction (0.5 SOL ≈ 10× dilution → fixed component ~0.1–0.5% instead of ~1–4.5%). But
larger size raises pool slippage (grows with size/`pool_quote_sol`) and 10×'s the per-trade risk
against the circuit breaker — the whole reason live is pinned at 0.05 SOL. Not free.

**4. The binding unknown — real entry/exit SLIPPAGE on the CURRENT executor — is stale and
unmeasurable offline.** D3's ~3.1pp entry slippage (the bulk of the 6%) came from **June** live pairs;
the copy executor has been paused since 2026-06-29, so there is **no modern sample**. Slippage is
separate from drift (already priced) and from tip/rent (the fixed costs above) — it is the land-time
price gap (submit→land) plus spread/MEV, and it can only be re-measured with live fills on the
current executor.

## Verdict — reducibility is PLAUSIBLE but NOT confirmable offline

- **The target is close.** 6% → 4.4% is a ~1.6pp cut, and the controllable pieces (tip discipline,
  the mean-favorable drift, imperfect-but-present rent recovery, optional larger size) plausibly move
  the *mechanical* component to ~1–2%. If the current executor's **slippage** is modest (~2–3%), total
  round-trip could land near or below 4.4% and the hot-lead edge would revive.
- **But the slippage number — the deciding term — is stale (June) and cannot be measured without live
  trades.** So this study cannot, on its own, declare the cost reducible. It can only say: the
  arithmetic is not hopeless, and the one missing measurement is well-scoped.

## Recommended change (pre-registered) — a bounded live calibration burst

This is D3's explicitly-deferred recommendation, now made decision-critical by N1. **Needs operator
funding sign-off** (live was blocked in D3; nothing here enables it).

- **The burst:** re-enable `COPY_LIVE_ENABLED` for the incumbent `copy-hotlead-strict-hi` **only**,
  at `MICRO_TRADE_SIZE_SOL` = 0.05, behind the existing `DAILY_MAX_LOSS_SOL` = 1.0 circuit breaker,
  capped to **≤0.3 SOL total exposure** (≈6 trades) — enough to pair live fills against the shadow
  twin and measure real slippage, small enough that the answer is cheap tuition.
- **Pre-registered observables + decision rule (fixed before the burst):**
  - **P1 — the actual round-trip cost.** Pair each live fill against its shadow-modeled entry/exit;
    compute measured round-trip cost = entry slippage + exit slippage + tip + permanent rent + fees.
    **PASS (cost lever is viable):** measured round-trip **< 4.4%** → re-cost `SIM_DEFAULT_COST_PCT`
    to the measured value and the hot-lead entry (and R1's subset) is back above the bar → resume
    signal work. **FAIL (cost is structural):** measured round-trip **≥ 4.4%** → N1's "no edge at
    realistic cost; need a new data input" verdict stands; stop iterating entry gates.
  - **P2 — the slippage/tip split.** Report entry vs exit slippage and tip separately, so if P1 is a
    marginal FAIL the next question (tighter tips? one-block-faster land? slightly larger size?) is
    already scoped rather than guessed.
  - **Revert:** instant (`COPY_LIVE_ENABLED=false`); the breaker trips the day at −1.0 SOL regardless.

## What NOT to do (from this study)

- **Do not "just execute faster" to cut cost** — the entry drift is mean-favorable; latency is a
  variance lever, not a mean-cost lever.
- **Do not re-cost `SIM_DEFAULT_COST_PCT` downward on this stale/offline evidence** — D3 moved it 3→6
  on a *measurement*; moving it back must also be a measurement (the burst), not an assumption.
- **Do not spawn signal overlays on the below-bar base** while the cost question is open — N1 holds
  until the burst answers P1.

## Pre-registration integrity

The 4.4% target was computed before the decomposition. The burst's P1/P2 pass/fail thresholds are
fixed here, before any live data. Study is read-only; no code changed; the ops runner never redeploys.
