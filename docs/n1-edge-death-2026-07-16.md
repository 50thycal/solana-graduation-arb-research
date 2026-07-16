# N1 — Incumbent edge-death vs cost-transition (RESOLVED 2026-07-16)

*Read-only ops-DB study executed via `/solana-strategy-phase-2` (path c — no shadow slot, no code
change, no live money). Pre-registered in `docs/phase1-handoff-2026-07-16.md` (N1). D3 lineage
(`docs/live-cost-recon-2026-07-12.md`). Voice: proposal.*

## Question

`copy-hotlead-strict-hi` — the sole promotable — fell below the bar (n=198, net +1.92, **drop3
−0.78**, exit-stress −2.44, degrading). Is that a **real edge death at realistic 6% cost**, or a
residual of the **3%→6% mixed-cost-era transition** (net_sol is stored per-row at the cost live when
it closed, so cumulative numbers blend 3%-era and 6%-era rows for ~1–2 weeks)?

## Method

One read-only `ops`-DB pull: all closed `-lag` rows of the pure hot-lead entry cohort —
`copy-hotlead-strict` (retired floor-0.5, 836 rows) + `copy-hotlead-strict-hi` (incumbent floor-1.0,
198) + `copy-fable-leadcap` (27, a strict-hi clone) = **1,061 rows**, each with `gross_pct`,
`size_sol`, `net_sol`, `exit_ts`, `mint`, `lead`.

The stored net embeds the cost live at close: `net = size × (gross_pct − costPct)/100`
(`tradeNetSol`, `copy-trader.ts:1026`). Verified per-row — early strict rows carry an embedded cost
≈3.0, recent rows ≈6.0. That lets two independent constructions:
1. **Primary — re-net at a consistent 6%** across the full history: `net6 = size × (gross_pct −
   6)/100`. Cost-consistent, large n, no dependence on the fuzzy deploy boundary. (This is exactly
   what D3's re-costing did.) Non-scaled rows only (the cohort has no scale-out → exact).
2. **Cross-check — the pre-registered close-era partition:** rows whose embedded cost ≈6 (closed
   under the 6% regime) vs ≈3, using the stored net. (leadcap excluded from pooled stats — it clones
   strict-hi's rows when the lifetime cap doesn't bind, so pooling would double-count.)

## Results

**Primary — full sample re-netted at a consistent 6%:**

| cohort | n | net6/trade | drop3/trade | drop3 (SOL) |
|---|---|---|---|---|
| POOLED strict + strict-hi | 1034 | **−0.0018** | **−0.0081** | −8.40 |
| strict-hi alone (incumbent) | 198 | −0.0018 | **−0.0152** | −3.01 |
| strict alone (floor 0.5) | 836 | −0.0018 | −0.0096 | −8.05 |

**Cross-check — pre-registered close-era partition (stored net):**

| cohort | n | net/trade | drop3/trade |
|---|---|---|---|
| POOLED **6%-era only** | 51 | −0.0869 | **−0.1359** |
| strict-hi 6%-era only | 47 | −0.0715 | −0.1246 |
| POOLED **3%-era only** (contrast) | 983 | **+0.0176** | **+0.0109** |

**The cost decomposition is the headline.** The *same* 1,034 trades net **+17.31 SOL at 3%
(drop3/t +0.0109)** but **−1.86 SOL at 6% (drop3/t −0.0081)**. ~All of the apparent edge was
**under-priced execution cost** — the 3%→6% re-cost (itself the D3 correction of measured ~3.1pp
entry slippage) erases it. This is **not** a mixed-era measurement artifact that will wash out:
re-costing the entire history consistently at 6% still fails drop3, and the forward 6%-era partition
(n=51) independently agrees, more negatively.

**A secondary genuine decay sits on top of the cost effect.** Trajectory in exit-order chunks of 100,
all at consistent 6%: the sign oscillates by regime, but the most recent chunks are negative
(800–899 −0.035/t, 900–999 −0.060/t, tail −0.012/t) vs positive early ones (0–99 +0.074/t). And the
fresh 6%-era-only rows (−0.087/t) are materially worse than the full-sample-6% mean (−0.0018/t) — so
recent tape is worse than the historical average *even at the same cost*. leadcap (all 6%-era,
−0.106/t) corroborates.

## Verdict

**P1 — FAIL.** At realistic 6% cost the hot-lead entry does **not** clear drop3 > 0 at n≥100:
drop3/t = **−0.0081** on the cost-consistent full sample (n=1034), −0.0152 on strict-hi alone
(n=198), and −0.136 on the underpowered forward 6%-era partition (n=51). All three agree in sign.
The mean is ~breakeven (−0.0018/t) but the drop3 robustness gate — the one that matters — is
negative. **→ North-Star verdict: no edge on the current data clears the realistic-cost bar; the
goal now needs a genuinely new data input OR lower execution cost, not another entry gate.**

**Primary cause = cost, not a transition artifact.** The edge only ever *looked* promotable because
the shadow under-priced execution at 3%; at the measured ~6% it was sub-bar all along, with a
secondary recent decay compounding it.

**P2 — the recent bleed is BROAD, not a cluster** (so it does not temper the P1-FAIL). In strict-hi's
recent 66-trade window (net6/t −0.048, WR 0.29): **52 distinct mints, 73% net-negative**; the worst
single mint is only **5%** of the total loss; **16 distinct leads, 75% net-negative**. Systemic, not
a handful of unlucky tokens.

## Implications (proposals — no code changed by this study)

1. **R1 (relative-impact replay, ~07-24) is now an AUTOPSY with a low prior, not a rescue.** The
   aggregate entry is dead at 6% and drop3 is negative, so the thin surviving positive mass is
   top-trade-concentrated — a subset selector would have to capture nearly all of it. Still worth the
   *cheap* offline replay as the specific "does ANY subset survive 6%?" check, but reframed: if R1's
   top-impact tercile also fails drop3>0 in both halves, it confirms this verdict decisively; a pass
   would be a genuine (surprising) rescue.
2. **Execution cost is now a first-class lever.** The entire edge lives or dies on the cost
   assumption (3% → promotable, 6% → dead). Anything that genuinely lowers round-trip cost/slippage
   — tighter entry routing, lower/adaptive tips, better fill timing — is worth as much as any new
   signal, and is the one lane with a clear mechanism to move the entry back above the bar.
3. **A genuinely new DATA input** (not another reselection of the same on-chain wallets) is the only
   signal-side path left, per the standing wallet-source graveyard. Absent that or a cost reduction,
   the honest read is to **stop spawning entry-gate overlays** on a below-bar base.
4. **Do not fund live-micro** — unchanged from D3; the shadow itself is now sub-bar at the honest cost.

## Pre-registration integrity

Both P1 constructions were fixed before the query ran (re-net-at-6% + close-era partition, drop3>0 at
n≥100 as PASS). The forward partition came in under n=100 (n=51) — reported as underpowered and
decided on the n≥100 cost-consistent re-net, which was the pre-registered primary. No post-hoc
re-scoping; the 3%-era positive number is reported in full as the contrast that localizes the cause
to cost. Study is read-only; the ops runner never redeploys.
