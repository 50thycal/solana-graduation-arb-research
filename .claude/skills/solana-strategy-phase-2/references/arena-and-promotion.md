# Arena & Promotion Methodology

Read in Phases 3–6. The counterpart to Kalshi's backtest-sizing-risk reference. This is how the bot decides a copy-strategy is real: the promotion bar, the metrics, the roles, the lab discipline, and the wallet-discovery funnel. All state is read from the **`bot-status` branch** — you self-serve; the operator reviews code and deploys.

## Contents
- The promotion bar (the five gates)
- The `-lag` twin vs the idealized mirror
- The metrics: drop3, exit-stress, monthly run-rate, score
- Strategy roles
- Lab discipline (converge, don't sprawl)
- The hill-climb
- The wallet-discovery funnel
- Where state lives

---

## The promotion bar (all five must clear; computed in `copy-trades.json → promotion`)

| Gate | Field | Meaning |
|------|-------|---------|
| Realistic execution | `realistic_execution: true` | Judged on the `-lag` twin (5s entry delay), never the idealized mirror |
| Sample | `n_trades ≥ 100` | Enough trades to trust the number |
| Anti-lottery | `total_net_sol_drop_top3 > 0` | Edge survives removing its best 3 trades |
| Exit robustness | `exit_stress > 0` | Holds under the exit-stress penalty |
| Run-rate | `monthly_run_rate_sol ≥ 3.75` | ≈ $300/mo — clears AI/infra cost |

A strategy is **PROMOTABLE** only when ALL clear. Never claim victory on small n, on the idealized mirror, or on outlier-driven means.

## The `-lag` twin vs the idealized mirror

Two twins per strategy:
- **Idealized mirror** — no `entryDelaySec`; fills at the optimistic ~1.1s snapshot. **Upper bound only. Score caps at 80. Never a live candidate.** It answers "is there any edge with free execution?"
- **`-lag` twin** — 5s entry delay + round-trip cost + slippage. **This is the only thing judged for real edge and the only thing eligible for live.**

The classic error is quoting the mirror's number as the strategy's edge. Always read the `-lag` row.

## The metrics

- **drop3** (`total_net_sol_drop_top3`) — net after removing the 3 best trades. The core anti-lottery check. **Net-positive but drop3-negative = a lottery ticket** (the whole edge is 1–3 outliers); refused by design. Watch its trajectory across loops — a drop3 that worsens every loop (like `hold30m`) is a deepening lottery, a prune candidate. Track `drop3/trade` (d3/t) for cross-strategy comparison.
- **exit-stress** (`exit_stress`) — a penalty test on the exit path; must be > 0. Catches strategies that only look good under their exact exit timing.
- **monthly run-rate** (`monthly_run_rate_sol`) — projected SOL/month at shadow size; must be ≥ 3.75 to clear infra cost. Positive-but-tiny doesn't promote.
- **score** — the 0–100 composite. Caps at 80 for the idealized mirror. A promotable strategy scores high on the `-lag` twin. Score is a summary; the individual gates are the decision.
- **n / net / net-per-trade** — raw sample, raw P&L, and per-trade. Raw net is the *least* important number (it's what lotteries maximize); drop3 and the `-lag` twin matter more.

## Strategy roles

Every strategy in the arena has a role (from `copy-trades.json` / the lab ledger):
- **incumbent** (👑) — the current best promotable strategy; the thing challengers try to beat. There is exactly **one**.
- **challenger** — a strategy perturbing the incumbent's strongest lever by one param, collecting toward n≥100.
- **control** — a fixed baseline (e.g. `copy-tp100-sl30(-lag)`) kept for comparison; `KEEP_INFRA` even when negative.
- **reference** — an idealized/never-live comparator (e.g. `copy-conviction-consensus2`) — informative, not a candidate.
- **discovery probe** — a wallet *source* under test (e.g. `copy-src-winner-sniper-v2`), collecting to a scorecard verdict (BEATS_OG / FAILS).

## Lab discipline — converge, don't sprawl

From the lab ledger's rules:
- **One incumbent.** Everything is measured against it.
- **Perturb one lever by one param.** A challenger changes a single thing vs the incumbent — not a from-scratch rebuild. This keeps causality legible (you know *what* moved the number).
- **MAX_INFLIGHT = 4.** Cap concurrent challengers. At the cap, a new idea waits or replaces a matured failure.
- **Prune matured failures.** A strategy past its checkpoint that's net-positive/drop3-negative (a confirmed lottery) or strictly dominated by its base gets retired. **Pruning is a win** — it tells you what to stop.
- **Stable ids.** Closed rows persist in the DB under `retired_summary`; a *reused* id inherits stale rows and corrupts the new measurement. Bump the id (e.g. `…-v2`) on a clean restart; never revive a retired id.

## The hill-climb

The productive pattern: find the incumbent's strongest lever, perturb it one step, and if the perturbation clears the bar with drop3 intact at n≥100, promote it and take the next step. Worked example — the **net-floor** on the hot-lead gate:

| floor X | strategy | drop3/trade | status |
|---------|----------|-------------|--------|
| 0.5 | `copy-hotlead-strict` (incumbent) | +0.009 | promotable |
| 1.0 | `copy-hotlead-strict-hi` (challenger) | +0.028 | leading, collecting |
| 1.5 | (spawn only if 1.0 confirms drop3 at n≥100) | ? | pending |

Raising the floor buys robustness — **until it caps.** Higher floors select fewer, hotter leads, so drop3 improves but concentration rises and n shrinks; each step must re-clear drop3 at n≥100. When the next step's drop3 stops improving (or collapses as concentration dilutes), the lever is exhausted — stop climbing it and find the next lever.

## The wallet-discovery funnel (lever 1, done right)

A discovery source is validated the same way, but the source itself is staged so cheap filters gate admission to expensive ones ("I can't listen to every swap"):
1. **Profit-credit** — a wallet earns a hit only if it was *actually profitable* on that token (MTM at the final observed price > epsilon), not merely present. Un-profit-checked hits decay off (~36h half-life). Precision = profitable hits / appearances.
2. **Forward pre-filter** — credited wallets are *watched, not traded, not scored* while the system measures whether they keep profiting on **other** tokens across all of PumpSwap. PASS = ≥2 profitable **closed** positions on non-trigger mints AND closed net ≥ +0.25 SOL within a window; early-fail at −1.0 SOL. **Flows only accumulate after enrollment → the test is out-of-sample by construction.** Open bags neither pass nor fail (no unrealized marks).
3. **Scoring decides tradability** — only pre-filter PASS wallets reach the scorer (drop3>0 + copyable-relaxed gate), capped, with the OG universe subtracted so the probe measures *incremental* wallets.

The lesson baked in: don't let one lucky profitable window admit a wallet. Each stage is out-of-sample relative to the last, which is why the funnel's verdict is trustworthy where a name-set shortcut isn't.

## Where state lives (`bot-status` branch, unless noted)

| Question | Source |
|----------|--------|
| Every strategy's standing (the scoreboard) | `copy-trades.json` → `promotion.rows`, `by_strategy`, `paired_vs_baseline`, `lead_performance` |
| Which wallets are scored / promotable | `wallet-leaderboard.json` |
| Does token *selection* carry edge | `smart-money.json` |
| Follower-detection latency + lead events | `copy-probe.json` |
| Live execution health (land rate, slippage, Jito spend) | `live-execution.json`, `live-training.json` |
| Yesterday's decision, day/week trends | `docs/copy-trade-journal.md` (newest-first) |
| Lineage — what's been tried and why | `docs/copy-strategy-lab.md` (lab ledger) |
| Bot health / graduation detection | `diagnose.json`, `snapshot.json` |
| Parked graduation-arb findings | `docs/research-archive/` |

Read `copy-trades.json` + the two `docs/` journals first every cycle, form a hypothesis from the data, then act. The monitor loop that surfaces all this each cycle is `/solana_loop_checker_phase3` (read-only, proposes; the operator enacts).
