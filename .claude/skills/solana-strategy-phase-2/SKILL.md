---
name: solana-strategy-phase-2
description: |
  Design, build, backtest, shadow-trade, and iterate a profitable Solana copy-trading strategy end to end, fitted to the bot's arena. Use whenever the user wants to build, design, improve, or reason about a copy-strategy for the Solana bot — a new wallet source, entry gate, exit rule, or sizing rule; form or validate a copy-trading thesis; wire up lead/graduation/wallet data; backtest or shadow-trade a copy approach; or judge whether a copy-strategy is promotable. Trigger on "build a copy strategy", "new copy-trade idea", "improve the incumbent", "spawn a challenger", "add a wallet source", "is this promotable", or references to hot-lead gating, drop3, the -lag twin, or post-graduation PumpFun copy trading. Treat it as building the user's OWN copy-strategies within the bot's mission — propose new levers freely, but validate on the -lag twin at n≥100 with drop3 positive, and do NOT revive the retired graduation-arb line without explicit operator direction.
---

# Solana Strategy — Phase 2 (build & validate)

The convergent build/validate workflow for the copy-trading bot, the Solana counterpart to the Kalshi Phase-2 skill. It takes a copy-strategy hypothesis and drives it through the arena's gates: **shadow → realistic-execution validation → promotion → small live**. Its job is disciplined validation, not idea generation.

**The mission is fixed** (per the repo's CLAUDE.md): build a profitable copy-trading bot on **post-graduation PumpFun** tokens — mirror the entries of profitable smart wallets, fast and cheap enough to **accumulate SOL after realistic execution costs** (5s entry delay, round-trip cost + slippage), on **n ≥ 100** trades, with the edge **surviving removal of its top 3 winners** and clearing the **monthly run-rate bar**. Every strategy is judged by that, not by raw net.

**Scope discipline.** You are free to hypothesize and adopt new copy-strategies — new wallets to follow, entry gating, exit rules, sizing. But two hard boundaries: (1) stay within the copy-trading mission; (2) **the graduation-arbitrage line is retired** (the old T+30 "buy the graduation, filter on public chart features" thesis — ~150 strategies / 32k paper trades / −935 SOL — see `references/copytrade-edge-map.md`). Do not revive it without explicit operator direction. Graduation *detection* stays alive: it seeds wallet discovery and defines the copyable universe.

**Framing, not financial advice.** This is a research/engineering framework. It routes every strategy through shadow and small live sizing behind a circuit breaker, and never claims victory on small n, on the idealized mirror, or on outlier-driven means.

**The loop is ordered and gated.** Each phase has an exit gate; a strategy that fails a gate goes back a phase, not forward.

```
Phase 0  Inventory the arena + the graveyard   → gate: know the incumbent, levers, ruled-out set
Phase 1  Form a falsifiable copy-thesis        → gate: one lever, the edge in a sentence, a falsifier
Phase 2  Wire the data (point-in-time correct)  → gate: no field resolved after entry time
Phase 3  Implement as a code-defined strategy   → gate: strategy + its -lag twin in COPY_STRATEGIES
Phase 4  Backtest / replay where data allows     → gate: positive on the -lag twin, drop3 > 0
Phase 5  Shadow-trade toward n≥100              → gate: promotion bar clears on the -lag twin
Phase 6  Promote, then small live (live_micro)  → gate: all gates hold; circuit breaker armed
```

---

## Phase 0 — Inventory the arena and the graveyard first

Do NOT start from a blank page. The bot has a documented incumbent, a lab ledger of lineage, and a large graveyard of ruled-out ideas. Read the live state before proposing anything — the operator self-serves all data via the **`bot-status` branch**; you read it, not the DB.

Pull and read:
- **`copy-trades.json`** (`bot-status`) → `promotion.rows`, `by_strategy`, `paired_vs_baseline`, `lead_performance` — the live scoreboard: every strategy's n / net / drop3 / stress / monthly / score, and which are promotable. This is the correlation-and-incumbent baseline.
- **`docs/copy-trade-journal.md`** (newest-first) — what yesterday's/this week's review decided, day/week trends.
- **`docs/copy-strategy-lab.md`** — the lab ledger: current incumbent, in-flight challengers and their lineage, resolved log. This tells you what's already been perturbed and what's live.
- **`docs/research-archive/`** and **`references/copytrade-edge-map.md`** — the graveyard: the retired graduation-arb line and the copy-trading dead ends (cumulative-copy-net doesn't select or veto forward; survivorship-poisoned backfill features; exit-engineering can't flip a negative entry). Never regenerate a ruled-out idea without naming a specific material difference.
- **`wallet-leaderboard.json`**, **`smart-money.json`**, **`copy-probe.json`**, **`live-execution.json`**, **`diagnose.json`** — wallet scores, whether token *selection* carries edge, follower-detection latency, live execution health, bot health.

**Gate:** You can state the current incumbent and its strongest lever, the in-flight challengers, and the ruled-out set. Proposing before you've read `copy-trades.json` + the two journals is the cardinal sin here.

---

## Phase 1 — Form a falsifiable copy-thesis (perturb one lever)

A copy-strategy is a configuration across four levers: **which wallets to follow** (discovery/source + scoring), **entry gating**, **exit rules**, and **sizing**. Read `references/copytrade-edge-map.md` for where edge realistically lives and what's proven dead. The core empirical fact: **copy-trading smart wallets is the only approach with large-n, drop3-robust positive P&L** — the edge is *information asymmetry* (the lead knows something you don't; you mirror it fast/cheap enough to keep some), not public chart features (exhausted).

Write the thesis explicitly:
1. **The one lever you're changing** — lab discipline is *one incumbent; a challenger perturbs its strongest lever by one param.* Not a from-scratch rebuild. (The strongest lever historically is the recency **hot-lead gate** — "last-10 copies of this lead netted ≥ X"; raising the floor X buys drop3 robustness. That's the live hill-climb.)
2. **The edge, in one sentence** — what mispricing/asymmetry, and *why does it persist*? "This wallet class keeps entering winners early and the crowd can't identify them fast enough" is credible; "these wallets are just good" is not.
3. **Why it survives realistic execution** — the edge must clear the 5s entry lag + round-trip cost + slippage, not just exist in the idealized mirror.
4. **What would falsify it** — the concrete result that kills it (e.g. "drop3 stays ≤ 0 at n≥100," or "the -lag twin nets negative"). Pre-register it so the test can't be re-scoped after the fact.

**Anti-anchor within the mission:** the gravity pulls toward another exit-rule tweak on the same wallets. Push on the highest-leverage lever — usually *which wallets* (discovery/source quality), since a better base is what turns a losing control into a promotable strategy.

**Gate:** One lever, the edge in one sentence with a persistence reason, and a pre-registered falsifier. Vague theses don't pass.

---

## Phase 2 — Wire the data (point-in-time correct)

Copy-trading P&L is only trustworthy if every input reflects what was knowable **at entry time**. The graveyard's most expensive lesson lives here:

> **Never use a field resolved after entry time.** The `holders≥250 (backfill)` filter looked +24% and was recommended for deployment five times — it was pure survivorship: backfill re-resolves holder count *after* the outcome, so a token that still has 250 holders today is one that didn't rug. **Walk-forward train/test cannot detect this** — both halves share the contaminated feature. Same class as the `liq_t300` look-ahead bug. Any feature whose value is settled after the entry decision is poison, however good it backtests.

The data you need, each timestamped point-in-time:
- **Lead events** — the swaps of the wallets you follow, as they happened (the copy signal), via the follower/graduation listeners. The copyable universe is **post-graduation PumpFun tokens**; graduation detection defines it.
- **Wallet history / scores** — computed only from information available before each decision (the discovery funnel enforces this by construction — see `arena-and-promotion.md`).
- **Execution context** — price at entry and at the `-lag` snapshot (5s later), for the realistic-execution model; round-trip cost + slippage.
- **Outcomes** — realized exits (TP/SL/time), marked correctly (open bags neither pass nor fail — no unrealized marks).

**Gate:** Every feature is point-in-time; no field is resolved after the entry decision. If a signal only works with a post-entry-resolved field, it's dead — do not proceed.

---

## Phase 3 — Implement as a code-defined strategy (with its -lag twin)

Copy-strategies are **code-defined** in `COPY_STRATEGIES` (`copy-trader.ts`); discovery sources in `DISCOVERY_SOURCES` (`discovery-sources.ts`). Implement the thesis as one strategy that perturbs the incumbent's lever by one param, and **always create its `-lag` twin** (the 5s-entry-delay version) — that twin is the only thing judged for real edge; the no-delay version is an upper bound only.

The pipeline per strategy: **signal** (which lead/wallet/gate fires) → **entry decision** (the gate) → **sizing** → **execution** (shadow by default; `live_micro` only after promotion). Reuse the existing chassis — the robust exit chassis is **TP100 / SL30** (take-profit 100%, stop-loss 30%; hold-to-settlement-style, stop-losses tighter than that have been poison). Keep the wallet/gate logic separate from the exit/sizing logic — you'll iterate the gate far more than the plumbing.

**Lab discipline:** one incumbent; **MAX_INFLIGHT = 4** challengers; converge, don't sprawl. If you're at the cap, a new challenger waits or replaces a matured failure. Give the strategy a stable id (closed rows persist in the DB under `retired_summary`; a reused id inherits stale rows — never reuse).

**Gate:** The strategy and its `-lag` twin are defined in `COPY_STRATEGIES`, perturb exactly one lever vs the incumbent, and slot under MAX_INFLIGHT with a fresh id.

---

## Phase 4 — Backtest / replay where the data allows

Where backfill/shadow history supports it, replay the thesis offline before committing a shadow slot — but under the same realistic-execution discipline, judged on the `-lag` twin.

Non-negotiables (see `references/arena-and-promotion.md`):
- **Judge the `-lag` twin, never the idealized mirror.** The 1:1 mirror fills at the optimistic ~1.1s snapshot; its score caps at 80 and it is *never* a live candidate. Real edge = the 5s-delay twin.
- **drop3 > 0.** Compute net after removing the top 3 trades. Net-positive but drop3-negative = a lottery ticket (the whole edge is 1–3 outliers), and the arena correctly refuses it. This is the single most important robustness check.
- **Costs in:** round-trip cost + slippage on every fill; for live, add Jito tip + ATA rent + priority fees (see `references/solana-execution.md`).
- **Exit-stress ≥ 0** — holds under the exit-stress penalty.
- **No survivorship** (Phase 2's rule holds — verify it).
- **Regime caution** — much of the copy history is a few days / one regime; a single-regime backtest is a hypothesis, not proof.

**Gate:** Positive on the `-lag` twin after costs, with drop3 > 0, out-of-regime where possible. A negative-entry signal cannot be rescued by exit engineering — if the `-lag` entry is negative, go back to Phase 1.

---

## Phase 5 — Shadow-trade toward n ≥ 100

Shadow trading is the forward test the backtest can't be. A new strategy runs in **shadow** (no real money) on the live copyable universe and accrues trades toward the promotion sample. In this bot the shadow book *is* the out-of-sample test — offline replay (Phase 4) is a pre-check, not a substitute.

Watch, per loop (this is what `/solana_loop_checker_phase3` monitors): the strategy's n, net, **drop3**, stress, monthly run-rate, score, and its trajectory vs the incumbent. Concentration is the trap — a young challenger can post a gaudy net/trade that's 70% three wallets; the n≥100 read with drop3 intact is what matters, not the early number.

**Gate:** The promotion bar clears **on the `-lag` twin**: `realistic_execution: true` · `n_trades ≥ 100` · `total_net_sol_drop_top3 > 0` · `exit_stress > 0` · `monthly_run_rate_sol ≥ 3.75`. If drop3 collapses as early concentration dilutes toward n≥100, the lever has capped — shelve it.

---

## Phase 6 — Promote, then small live (live_micro), then hill-climb

When the bar clears, the strategy is promotable. Live is a deliberate, small, circuit-breakered step:
- **live_micro only** — real txs at `MICRO_TRADE_SIZE_SOL` (0.05 SOL), a hard override, behind the daily circuit breaker (`DAILY_MAX_LOSS_SOL` = 1.0 SOL, trips the day at ≤ −1.0). This is the analog of "start tiny."
- **Watch live-vs-shadow drift** — land rate, slippage, Jito spend, ATA rent (`live-execution.json`). Live diverges from shadow through execution costs the shadow model under-weights; the rent-failure lesson applies (a rising `InsufficientFundsForRent` count is a *funding* symptom — wallet near the preflight floor with no ATA-rent headroom — not a retry bug).
- **Then hill-climb the winning lever.** If the promoted strategy came from raising the hot-lead net-floor, and drop3 held, spawn the next floor step as a new challenger — one param, under MAX_INFLIGHT. Raising the floor keeps buying robustness until it stops; when the next step's drop3 doesn't improve, the lever has capped and you stop.
- **Prune matured failures** every cycle — a strategy that's net-positive but drop3-negative and worsening is a confirmed lottery; retiring it is a *win* (it tells you what to stop). Ruling a book out is progress toward the goal, not a loss.

**Gate:** All promotion gates hold on the `-lag` twin, the circuit breaker is armed, and live_micro size is small enough that live-vs-shadow surprises are cheap tuition.

---

## Guardrails (apply throughout)

- **Judge the `-lag` twin, never the idealized mirror.** The no-delay mirror is an upper bound (score cap 80), never a live candidate.
- **drop3 > 0 or it's a lottery.** Net-positive with negative drop3 is 1–3 outliers, not an edge. This gate is sacred.
- **Never use a field resolved after entry time.** Survivorship/look-ahead is invisible to walk-forward. Any post-entry-resolved feature is poison.
- **n ≥ 100 before any claim.** Never declare victory on small n, on the idealized mirror, or on outlier-driven means.
- **Converge, don't sprawl.** One incumbent; a challenger perturbs one lever by one param; MAX_INFLIGHT = 4; prune matured failures. Fresh strategy id every time (reused ids inherit stale rows).
- **Shadow before live_micro; circuit breaker always armed** (`DAILY_MAX_LOSS_SOL`). Start live at 0.05 SOL.
- **Stay in the copy-trading mission; graduation-arb is retired** — don't revive without explicit operator direction (graduation *detection* stays, to seed discovery).
- **The operator is the deploy loop.** You self-serve data via `bot-status`; the operator reviews code and deploys. Not investment advice; validated edges still go through shadow and small live sizing.

---

## Reference files
- `references/solana-execution.md` — the execution reality and cost model: the copyable universe, the `-lag` twin, land rate, slippage, Jito tips/bundles, priority fees, ATA rent, sizing constants, the circuit breaker, MEV. **Read for Phases 2–6.**
- `references/copytrade-edge-map.md` — where copy-edge lives (the four levers, information asymmetry) and the full graveyard (retired graduation-arb, cumulative-copy-net, survivorship traps) as priors. **Read for Phase 1.**
- `references/arena-and-promotion.md` — the promotion bar, the `-lag` twin vs idealized mirror, drop3 / exit-stress / monthly-run-rate, roles, lab discipline (one incumbent, one-lever perturbation, MAX_INFLIGHT, hill-climb), the wallet-discovery funnel, and the `bot-status` state files. **Read for Phases 3–6.**
