# Research Archive — Graduation-Arbitrage (PARKED 2026-06-25)

This folder is the permanent record of the **graduation-arbitrage research line** that this repo
began as. That research is **exhausted** — the bot now focuses exclusively on **copy trading**
(`src/copytrade/`). The code that produced these artifacts (the `src/api/` analysis panels, the
`StrategyManager` T+30 trading path, the research dashboards) was removed in the copy-trading
refactor. This archive preserves the findings so the knowledge is never lost.

## The open question we were chasing

> Which single filter or combination of filters from the v2 search space yields a T+30
> post-graduation strategy that **accumulates SOL** after all costs, on n ≥ 100 trades, with
> regime-stable edge, not driven by 1–3 lottery-ticket trades?

**Answer after ~150 strategies and 32,477 paper trades: none.** Public T+30 chart features do not
contain a durable edge. See the lessons below.

## Key lessons (verbatim from the research journal)

### 1. Public T+30 chart features are exhausted as an edge source
After ~150 strategies / 32,477 lifetime paper trades (**−935.8 SOL, avg −5.9%/trade**) on T+30
entries filtered by public features (velocity, monotonicity, holders, concentration, snipers,
creator rep, path shape, regime, time-of-day, BTC/F&G), **zero strategies cleared the promotion
bar.** The universe median `pct_t300` is −11.7% and baseline avg −11.15%: filters reshape the loss,
they do not reverse it. Exit-engineering variants (trailing/breakeven/ratchet/1s-poll) never
flipped a negative entry signal positive. **Redirect effort to information-asymmetry signals
(copy-trading smart wallets) instead of new public-feature combos.**

### 2. Backfill-resolved features are survivorship-poisoned
`holders>=250 (backfill)` showed `opt_avg_ret +24.25%` (n=396) and Panel 7 ROBUST, and was
recommended for deployment 5+ times. It is a pure survivorship artifact: backfill re-resolves
holder count AFTER the outcome, so a token that still has 250 holders today is one that did not rug.
Walk-forward train/test splits **cannot** detect this class of bias because both halves share the
contaminated feature. **Rule: never deploy a filter whose field is resolved after entry time** (same
class as the `liq_t300` look-ahead bug, 2026-05-01). The "best-combos" leaderboard in
`best-combos.json` is dominated by these poisoned `(backfill)` / `confirmed_recovery` rows — treat
its top rows as artifacts, not signal.

### 3. Copy-trading is the only approach with large-n robust positive P&L
Shadow copy-trading (since ~2026-06-05): overall **n=3,128, +31.9 SOL, drop_top3 +12.0** at 0.5 SOL
size. Best variants: `copy-tp100-sl30` (+8.82, drop3 +4.23, n=211), `copy-followsell` (+7.77,
drop3 +2.38, n=401), `copy-conviction-consensus2` (+4.78, drop3 +1.46, n=108). This is why the
project pivoted. (Caveats noted at archival time: exit variants share entry signals so totals aren't
independent; open positions weren't marked-to-market; only ~5 days / one regime observed — these are
the live questions the copy-trading work now addresses.)

### 4. Live copy-buy "rent" failures are a wallet-balance symptom, not a retry bug
`InsufficientFundsForRent` failures fire when the live wallet sits near the preflight floor
(`MICRO_TRADE_SIZE_SOL 0.05 + WALLET_SOL_BUFFER 0.02`) with no headroom for ATA rent + fees + Jito
tip. Retrying adds no lamports — it cannot fix rent failures. A rising rent count is a funding
symptom, not a missed-trade bug. Don't re-investigate as new.

## Files in this archive

Point-in-time snapshots pulled from the `bot-status` branch on 2026-06-25:

| File | What it held |
|---|---|
| `journal.json` | Per-strategy hypothesis + prediction + auto_status ledger for the T+30 book |
| `report.json` | Full daily-report cross-session memory: `lessons`, `recommendations`, `recent_reports`, `weekly_aggregates` |
| `best-combos.json` | Filter-combo leaderboard (note: top rows are survivorship artifacts — see lesson 2) |
| `leave-one-out-pnl.json` | Outlier-robust per-strategy P&L (drop top1/top3) |
| `regime-analysis.json` | Universe-level GREEN/YELLOW/RED regime timeline |
| `strategy-percentiles.json` | Per-strategy return-distribution shape |
| `SPEC.md`, `NEXT_SESSION_ENTRY_TIME.md`, `v51-strategies.md` | Original research spec + working notes |

## If graduation research is ever revived

The graduation *detection + enrichment* pipeline is still live (it seeds copy-trade wallet
discovery and defines the copyable token universe). To re-enable full T+30 price-path collection,
set `GRADUATION_PRICE_PATH_ENABLED=true`. The deleted analysis code lives in git history before the
copy-trading refactor commit on branch `claude/copy-trading-refactor-t7f9vy`.
