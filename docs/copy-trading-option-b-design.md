# Option B — Wallet-Following Copy Trading: Design Doc (2026-06-04)

> **Status: design / research artifact, not yet built.** Operator review gate before any code lands.
> This is a partial pivot of the bot's thesis (graduation-momentum → wallet-following), so it ships
> as a *parallel* subsystem that reuses the existing executor, Helius account, Jito path, and the
> n≥100 / drop-top-3 evaluation discipline — it does **not** rip out the graduation pipeline.

## 0. Why "beyond pump.fun" is forced, not optional

The current bot only observes a wallet during a **30-second window after a token graduates**
(`competition_signals` is T+0..T+30s only, ~10–20 tx/grad parsed, RPC-capped — see
`src/collector/competition-detector.ts:92,:198`). The full-window swap logger is disabled
(`src/collector/swap-logger.ts:14`). We have **no per-wallet realized P&L anywhere** — the only
"wallet reputation" primitives are creator rug-rate (`creator_prior_*`) and `sniper_wallet_velocity_avg`,
which counts *how often* a wallet snipes, never whether the snipes *made money*
(`src/db/schema.ts:246`, backfill `:480`).

The economic reason this matters: **profitable pump.fun wallets make their money on the bonding curve,
before graduation, and frequently sell INTO graduation liquidity.** Our pipeline first wakes up at the
`Migrate` instruction — the exact moment the alpha wallets are often *exiting*. Copying their
post-graduation PumpSwap behavior would mostly copy their **sells**. To follow wallets that actually
accumulate SOL we must watch them on the bonding curve and across venues. Hence Option B.

## 1. Subsystem overview

Four new components, one new long-running process lane, reusing existing execution:

```
                    ┌─────────────────────────────────────────────┐
                    │  WALLET INTELLIGENCE (offline / batch)        │
  Helius / RPC ───► │  1. Discovery  → 2. PnL Engine → 3. Ranker    │ ─► watchlist (DB)
                    └─────────────────────────────────────────────┘
                                         │ top-N wallets
                                         ▼
                    ┌─────────────────────────────────────────────┐
  Geyser gRPC  ───► │  4. Follower (realtime)                       │
  (wallet subs)     │     detect target buy/sell  →  copy decision  │
                    └─────────────────────────────────────────────┘
                                         │ copy intent
                                         ▼
                    ┌─────────────────────────────────────────────┐
                    │  EXECUTION (reuse + extend)                    │
                    │   existing: PumpSwap buy/sell + Jito          │
                    │   NEW: bonding-curve buy, Raydium/Jupiter      │
                    └─────────────────────────────────────────────┘
```

The two **load-bearing new pieces** are (2) the wallet-PnL engine — without it "best performing
wallets" is undefined — and (4) the realtime follower — without it we react too slowly to copy anything
but exits. Components 1 and 3 are tractable glue. The execution extensions are real work but bounded.

---

## 2. Component specs

### 2.1 Wallet Discovery (`src/copytrade/discovery.ts` — new)

**Job:** produce a candidate set of wallets worth scoring. We are *not* scoring all of Solana — we seed
from data we already have plus cheap expansions.

Seed sources (cheapest → richest):
- **Existing DB, free.** Distinct `wallet_address` from `competition_signals` (snipers/early buyers we've
  already seen) and `firstbuyer_wallet` / `dev_wallet_address` / `creator_wallet_address` from
  `graduation_momentum`. This is a few thousand wallets at zero new RPC cost.
- **Bonding-curve early buyers.** For a rolling set of recently-graduated *winners* (high `pct_t300`),
  pull the bonding-curve buy history and harvest the wallets that were early. Requires the
  bonding-curve account history (see §2.4 venue note) — moderate RPC.
- **(Optional) third-party leaderboards.** Birdeye/Helius/Dune "top trader" lists as a cold-start seed.
  Treat as a *candidate* source only — we re-verify every wallet's PnL ourselves (§2.2); never trust an
  external "win rate".

Output: `wallet_candidates(address, first_seen, source, last_refreshed)`.

### 2.2 Wallet P&L Engine (`src/copytrade/wallet-pnl.ts` — new) — **the crux**

**Job:** for each candidate wallet, reconstruct realized SOL P&L from its on-chain history so the ranker
(§2.3) can apply the *same bar CLAUDE.md already enforces* (n≥100, drop-top-3>0, monthly run-rate,
regime stability) — but per *wallet* instead of per *strategy*.

Approach — **FIFO position reconstruction from the wallet's swap stream:**
1. `getSignaturesForAddress(wallet, until=last_processed)` paginated → wallet's tx history.
2. Parse each tx (reuse the buy/sell classification already written twice in
   `competition-detector.ts:125-134` and `swap-logger.ts:119-146`: signer SOL delta sign + token-balance
   delta for the traded mint). **Refactor that logic into one shared `parseSwapTx()` util** rather than a
   third copy.
3. Per (wallet, mint): FIFO-match buys→sells → realized SOL P&L per round trip, plus an open-position
   mark for unrealized.
4. Aggregate per wallet: `n_round_trips`, `total_realized_sol`, `total_realized_sol_drop_top3`,
   `median_rt_pct`, `monthly_run_rate_sol`, `win_rate`, `avg_hold_seconds`, `last_active`,
   `venues_used[]`.

**Critical correctness traps (call out so we don't ship a fake leaderboard):**
- **Survivorship / look-ahead:** rank a wallet only on trades that closed *before* the day we'd start
  copying it; forward-test the copy in shadow. Mirrors the existing look-ahead guardrail
  (`CLAUDE.md` SEARCH SPACE) — a wallet that looks great because we picked it *after* its one 100× is the
  wallet-level version of the `liq_t300` tautology bug.
- **Outlier-driven means:** reuse the existing `drop_top3` philosophy verbatim. A wallet with
  `total_realized_sol_drop_top3 ≤ 0` is a lottery winner, not alpha — same rule as
  `leave-one-out-pnl.json`.
- **Self-funding / wash / Jito-bundle noise:** filter txs where the counterparty is the same wallet
  cluster; ignore sub-dust round trips.
- **Cost realism:** subtract priority fees + Jito tips + ATA rent the *target* paid is irrelevant — we
  must subtract the costs **we** would pay to copy (use `SIM_DEFAULT_COST_PCT` + gap penalties from
  `src/api/sim-constants.ts`, the same constants the strategy sim uses, so wallet ranking and strategy
  ranking are on one cost basis).

This engine is batch/offline (a worker like `src/api/heavy-cache-worker.ts`), refreshed daily, writing
`wallet_scores`. **This is where most of the build risk lives** — it's a from-scratch PnL reconstructor
over noisy multi-venue data. Budget the most time here.

### 2.3 Ranker / Watchlist (`src/copytrade/ranker.ts` — new)

**Job:** turn `wallet_scores` into an actionable, churn-controlled watchlist.

Promotion bar for a wallet onto the **live follow list** (deliberately parallels the strategy bar):

| Gate | Threshold | Rationale |
|---|---|---|
| `n_round_trips` | ≥ 100 | same n≥100 floor as strategies |
| `total_realized_sol_drop_top3` | > 0 | not 1–3 lottery tickets |
| `monthly_run_rate_sol` | ≥ 3.75 | covers our infra cost per followed wallet sleeve |
| `last_active` | ≤ N days | dead alpha is not alpha — wallets decay (cf. `edge-decay.json`) |
| `consistency` (rolling) | positive recent window | reuse the `edge-decay` STRENGTHENING/STABLE idea per-wallet |

Output: `follow_list(address, rank, copy_size_sol, max_concurrent, enabled, added_at, kill_criterion)` —
intentionally the same shape as a strategy config so the existing journal / daily-report / kill machinery
can wrap it. **Each followed wallet is treated as a "strategy" in shadow** so it flows through
`leave-one-out-pnl.json`, `journal.json`, and the promotion gates with zero new evaluation code.

### 2.4 Realtime Follower (`src/copytrade/follower.ts` — new) — **second load-bearing piece**

**Job:** detect a followed wallet's buy/sell within ~1 block and emit a copy intent fast enough to land
in the same or next block.

**Transport: Yellowstone Geyser gRPC** (Helius supports it on paid plans), `accountSubscribe`/transaction
subscription **keyed on the follow-list wallets**, not on the pump.fun program. This is the architectural
break from today's design: `graduation-listener.ts` subscribes to *one program* via WS `onLogs`; the
follower subscribes to *N wallets* via gRPC and must handle dynamic watchlist updates (add/remove a wallet
without dropping the stream).

Why Geyser not WS `onLogs`: today's pipeline already documents that Helius batch-replays confirmed-level
events with 25–75s lag and even `processed` WS has a tail (`graduation-listener.ts:183-187,:628-638`).
That latency is *fine* for a T+30 momentum entry; it is **fatal** for copy trading, where the edge decays
in seconds. Geyser gives processed-commitment account writes with the lowest available latency.

Copy-decision logic (per detected target action):
- **Target BUY** → emit copy-buy intent: same mint, our own `copy_size_sol` (NOT mirrored notional —
  size by our risk, capped), venue = whatever venue the target used.
- **Target SELL** → if we hold a copied position in that mint, emit copy-sell (exit-follow). Also support a
  *time/secondary* exit independent of the target (target may dump on us via a faster route).
- **Dedup & idempotency:** reuse the `seenSignatures` bounded-map pattern
  (`graduation-listener.ts:406`) so a redelivered target tx doesn't double-fire a copy.
- **Anti-self-trade & anti-frontrun-trap:** skip mints with obvious honeypot/transfer-hook flags (we
  already have `src/trading/token-2022.ts` `getMintProfile`); cap per-mint and global concurrent copies.

### 2.5 Execution extensions (`src/trading/` — extend existing)

We already have, working in live mode: PumpSwap buy/sell instruction builders + expected-out math
(`src/trading/pumpswap-swap.ts`), Jito bundle submission (`src/trading/jito.ts`), token-2022 handling
(`src/trading/token-2022.ts`), and the full `Executor` with shadow/live_micro/live_full modes
(`src/trading/executor.ts`). **The copy subsystem reuses `Executor` wholesale** for the PumpSwap case.

New execution code required:
- **Bonding-curve buy path** — pump.fun on-curve `buy` instruction. We currently have *no* bonding-curve
  buy builder (grep confirms `buildBuyInstructions` lives only in `pumpswap-swap.ts`). This is the single
  biggest new execution component, because copying pre-graduation alpha *requires* on-curve buys.
- **Raydium / Jupiter buy path** — for wallets that trade migrated tokens off PumpSwap. Jupiter aggregator
  is the pragmatic first cut (one integration covers most venues) at the cost of a little latency.
- **Venue router** — map the target's detected venue → our buy path. Default to Jupiter when unsure.

---

## 3. New data model (`src/db/schema.ts` — additive migrations only)

Follow the existing safe `ALTER TABLE` / `CREATE TABLE IF NOT EXISTS` pattern. New tables:

```
wallet_candidates(address PK, first_seen, source, last_refreshed)
wallet_tx_cache(address, signature, block_time, mint, action, sol_delta, token_delta, venue,
                PRIMARY KEY(address, signature))          -- raw parsed swaps, the PnL engine's input
wallet_round_trips(id PK, address, mint, open_ts, close_ts, sol_in, sol_out, realized_sol, hold_sec)
wallet_scores(address PK, n_round_trips, total_realized_sol, total_realized_sol_drop_top3,
              median_rt_pct, monthly_run_rate_sol, win_rate, last_active, venues_json, scored_at)
follow_list(address PK, rank, copy_size_sol, max_concurrent, enabled, kill_criterion, added_at)
copy_trades(... mirror of trades_v2 shape ...)            -- so leave-one-out-pnl can treat each
                                                          --   followed wallet as a "strategy"
```

`copy_trades` deliberately mirrors `trades_v2` (`schema.ts:707`) so the entire evaluation stack
(`leave-one-out-pnl.json`, percentiles, regime panels, journal) works on copied trades with minimal new
reporting code — each `address` plays the role `strategy_id` plays today.

---

## 4. Latency budget (the make-or-break number)

Copy trading lives or dies here. Rough target for "copy a bonding-curve buy before the pop":

| Stage | Target | Current capability |
|---|---|---|
| Target tx → our process (Geyser) | < 400 ms | ❌ new (today: WS onLogs, 25–75s tail) |
| Decision + build tx | < 50 ms | ✅ trivial |
| Submit (Jito bundle) + land | next block (~400–800 ms) | ⚠️ Jito path exists, not latency-tuned |
| **End-to-end** | **same/next block** | needs the full Geyser→Jito path proven |

Our position monitor is `five_second` polling (`CLAUDE.md` OPERATIONAL CONSTANTS) — fine for held
positions, but the *entry* race must not touch that path. The follower must own a dedicated low-latency
lane. **Recommend an early latency spike** (measure Geyser→land round-trip on a throwaway wallet) *before*
building the PnL engine — if we can't land next-block, the whole thesis weakens and we should know cheaply.

---

## 5. Evaluation discipline (reuse, don't reinvent)

The whole point of mirroring `copy_trades` on `trades_v2` and `follow_list` on strategy configs: a
followed wallet is **PROMOTABLE / INVALID / WATCH / BLOCKED** under the *exact same* rules as a strategy
(`CLAUDE.md` CANDIDATE OUTCOMES). A wallet stays in **shadow** until its *copied* trades (not its own
trades) clear n≥100 · drop_top3>0 · total≥0.5 SOL · monthly≥3.75 SOL · regime-stable. This guards against
the obvious failure mode — "the wallet is great but our copies arrive 2 blocks late and we get the bad
fills." Shadow-copy answers that empirically before a cent of real size.

---

## 6. Phased rollout

- **Phase 0 — latency spike (days).** Stand up Geyser, subscribe to one wallet, measure detect→land. Kill
  criterion: if we can't reliably land ≤ next-block, escalate to operator before building more.
- **Phase 1 — wallet-PnL engine offline (1–2 wks).** Build `parseSwapTx()` refactor + FIFO reconstructor
  + `wallet_scores`, seeded from existing DB wallets only (zero new ingestion). Deliverable: a
  *defensible* wallet leaderboard with drop-top-3 and look-ahead controls. Operator reviews it like any
  research panel before we follow anyone.
- **Phase 2 — shadow follower, PumpSwap-only (1 wk).** Geyser follow top-N, copy *post-graduation* buys
  only (reuses `Executor` 100%), log to `copy_trades` in shadow. Validates the realtime path on the easy
  venue.
- **Phase 3 — bonding-curve buy path + multi-venue (1–2 wks).** The real edge. Add on-curve buy builder +
  Jupiter router; shadow-copy pre-graduation entries.
- **Phase 4 — live_micro.** Only wallets PROMOTABLE in shadow graduate to live micro size, through the
  same gate strategies use.

Total: ~3–6 weeks, front-loaded with the two cheap go/no-go gates (Phase 0 latency, Phase 1 leaderboard
credibility).

---

## 7. Costs, risks, open questions

**Costs.** Geyser gRPC is typically a higher Helius tier than our current 10M-credit/month plan
(`graduation-listener.ts:158-163` notes we're already metered against that cap). Wallet-history backfill
is RPC-heavy (`getSignaturesForAddress` + parse per candidate) — bound it with the existing
`globalRpcLimiter` (`src/utils/rpc-limiter.ts`) and a candidate cap. **Operator decision needed: budget
for the Geyser tier + extra RPC.**

**Risks / honest priors.**
- *Adverse selection:* even at next-block, we systematically fill *worse* than the wallet we copy — that's
  what Phase-2 shadow exists to quantify. If the copy-slippage eats the edge, Option B fails and we'll see
  it in shadow before risking size.
- *Alpha decay:* good wallets are found and crowded; `last_active` + per-wallet edge-decay gating is
  mandatory, not optional.
- *Target sells faster than us:* the wallet may exit via a route we don't see instantly. Independent
  secondary exits (time/SL) are required, not just exit-follow.
- *Thesis drift:* this is a second product. It must run *beside* the graduation bot, not cannibalize its
  RPC budget — keep the follower on its own connection/lane like the migration poller already is
  (`graduation-listener.ts:303-338`).

**Open questions for operator before Phase 1:**
1. Geyser budget approved? (gates Phase 0.)
2. Cold-start seeding — DB-only (free, slower to find alpha) vs. add a paid leaderboard seed (faster, but
   we still re-verify)?
3. Sizing policy — fixed `copy_size_sol` per wallet vs. scaled to target notional (capped)?
4. Is a partial thesis-pivot acceptable, or should this be spun into a *separate* bot/repo so the
   graduation research stays clean?

---

## 8. Reused vs. new — summary

| Piece | Reuse | New |
|---|---|---|
| Helius account / RPC limiter | ✅ | Geyser tier |
| Swap parsing (buy/sell classify) | ✅ logic exists ×2 | refactor to shared `parseSwapTx()` |
| Execution (PumpSwap + Jito + token-2022) | ✅ `Executor` | bonding-curve buy, Jupiter router |
| Realtime ingest | pattern (dedup, reconnect) | Geyser wallet subs (follower) |
| Wallet PnL / ranking | ❌ nothing | **whole engine** (highest risk) |
| Evaluation (n≥100, drop-top3, journal, regime) | ✅ wholesale via `copy_trades`/`follow_list` mirror | thin adapters |

Bottom line: execution and evaluation are ~70% reusable; **intelligence (find good wallets) and
realtime-follow are net-new and are the whole ballgame.** Phases 0 and 1 are cheap and decisive — build
those first and let the data say whether to continue.
