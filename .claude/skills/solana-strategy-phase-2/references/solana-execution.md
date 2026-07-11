# Solana Execution Reality & Cost Model

The counterpart to Kalshi's API reference. On Kalshi you cross a spread and pay a known fee; on Solana, execution is the hard part and the place edges die. Read for Phases 2–6. Constants below are the repo's current defaults (`src/trading/config.ts`) — verify against the code, they're tuned over time.

## Contents
- The copyable universe
- The `-lag` twin (the realistic-execution model)
- Live execution mechanics (land rate, slippage, Jito, priority fees, rent)
- Sizing + the circuit breaker
- MEV / adverse fills
- The rent-failure lesson

---

## The copyable universe

Copy trading operates on **post-graduation PumpFun tokens** — tokens that have graduated off the bonding curve onto PumpSwap (PumpFun's AMM). Graduation *detection* (`monitor/graduation-listener.ts`) defines this universe and seeds wallet discovery; it stays alive even though the graduation-*arb* trading line is retired. A wallet source is only useful to the extent its wallets actually trade *this* universe — a source whose wallets rarely touch copyable graduations can't reach n≥100 (this is exactly why `live_tape` was pruned).

Swaps route through PumpSwap (`trading/pumpswap-swap.ts`, `pool-resolver.ts`); Token-2022 mints need special handling (`token-2022.ts`); `safety.ts` gates obviously-bad tokens pre-entry.

---

## The `-lag` twin — the realistic-execution model

This is the single most important execution concept, and the analog of "assume you cross the spread" on Kalshi.

- Every strategy has two twins: the **idealized mirror** (fills at the ~1.1s snapshot, no entry delay) and the **`-lag` twin** (a **5s entry delay** modeling the time to detect the lead's swap, decide, and land your own tx).
- **The idealized mirror is an UPPER BOUND ONLY.** Its score caps at 80 and it is *never* a live candidate. It answers "is there any edge if execution were free?" — not "is there edge we can capture."
- **All real edge is judged on the `-lag` twin.** A copy-strategy that's positive on the mirror but negative on the `-lag` twin has no capturable edge — the lead's advantage is gone within 5 seconds. This is the most common way a plausible copy-thesis dies.
- The lag twin also carries **round-trip cost + slippage**; the realistic model is (5s-delayed entry price) × (1 + slippage) plus exit costs.

When you backtest (Phase 4) or read the scoreboard (Phase 5), always look at the `-lag` row. If someone quotes a strategy's mirror number as its edge, that's the classic error.

---

## Live execution mechanics (what the `-lag` model approximates, and where live drifts from shadow)

Shadow trading assumes your fill; live trading has to actually land a transaction on a congested chain. The gap between shadow and live is pure execution cost:

- **Land rate.** Not every submitted tx lands. Missed lands = missed entries/exits, and they're not random — you miss most when the chain is hottest, which correlates with the moves you most wanted. Tracked in `live-execution.json`.
- **Slippage.** Entry price moves between decision and land. The bot clamps copy-entry slippage hard: `COPY_ENTRY_MAX_SLIPPAGE_BPS` = 100 (1%) on every copy buy; the general swap tolerance `SWAP_SLIPPAGE_BPS` / `DEFAULT_MAX_SLIPPAGE_BPS` = 500 (5%). A tight entry cap rejects bad fills but lowers land rate — that tradeoff is real.
- **Jito bundles / priority tips.** To land reliably in congestion you tip. `DEFAULT_JITO_TIP_SOL` = 0.0005; **`COPY_JITO_TIP_SOL` = 0** by default (copy trades don't tip unless set). Block engine: `ny.mainnet.block-engine.jito.wtf`. Tips are a real per-trade cost that the shadow model under-weights — on 0.05 SOL trades a 0.0005 tip is ~1% of size.
- **ATA rent + fees.** Buying a new token needs an Associated Token Account, which costs rent (SOL) on top of the swap + fee + tip. This is why the live wallet needs headroom (below).
- **Position management.** SL/TP is enforced by a price poll (`positionPollSeconds`; 1s polling catches fast SL/TP but burns RPC). Trailing SL/TP, breakeven moves, and staged SL-tightening exist — but the proven chassis is plain **TP100 / SL30**; tighter stops have been poison (they convert transient dips into realized losses).

---

## Sizing + the circuit breaker

- **live_micro** is the only live mode: real txs at **`MICRO_TRADE_SIZE_SOL` = 0.05 SOL**, a hard override. This is "start tiny."
- **`DAILY_MAX_LOSS_SOL` = 1.0** — the circuit breaker trips the day's live trading at ≤ −1.0 SOL realized. Always armed before any live_micro run.
- **`WALLET_SOL_BUFFER` = 0.02** — preflight floor; the wallet must sit above (`MICRO_TRADE_SIZE_SOL` + buffer) with headroom for ATA rent + fees + tip, or entries fail on rent (see below).
- Sizing on the promotion bar is judged by **monthly run-rate ≥ 3.75 SOL** (≈ $300/mo, covers AI/infra) at the shadow size (0.5 SOL) — a strategy must project to clear infra cost, not just be positive.

---

## MEV / adverse fills

As a taker copying a public lead into a thin AMM pool, you are exposed to being front-run/sandwiched — a searcher sees the same lead (or your own tx) and prices you worse. This is a *cost you bear*, not a tactic: it shows up as slippage and worse-than-shadow fills. Tight entry-slippage caps and Jito bundling are the defenses; the `-lag` twin plus realistic slippage is the offline approximation.

---

## The rent-failure lesson (don't re-investigate as new)

`InsufficientFundsForRent` failures fire when the live wallet sits near the preflight floor (`MICRO_TRADE_SIZE_SOL` 0.05 + `WALLET_SOL_BUFFER` 0.02) with no headroom for ATA rent + fees + Jito tip. **Retrying adds no lamports — it cannot fix a rent failure.** A rising rent count is a *funding* symptom (top up the wallet), not a missed-trade bug and not a retry-logic bug. This is a settled question in the graveyard; treat a rent-failure spike as "fund the wallet," full stop.
