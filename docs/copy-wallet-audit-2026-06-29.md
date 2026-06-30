# Copy-Trading Wallet Audit — 2026-06-29

One-off deep audit of the wallets we copy: what we can observe about them, how they actually perform
when copied, and what the data says about reaching **continuous profit**. Data pulled live from the
`bot-status` branch (`copy-trades.json`, `wallet-leaderboard.json`) + four custom `ops`-branch DB
queries against `copy_trades` / `wallet_scores` / `follow_list` / `copy_probe_events`.

> All figures are as-of `generated_at 2026-06-29T17:33Z`. Numbers are evidence for a proposal, not a
> roster change — roster edits are operator-approved code changes to `COPY_STRATEGIES`.

---

## TL;DR (the three findings that matter)

1. **Our wallet-scoring system has ~zero predictive validity for copy profit.** Across 81 leads with
   ≥8 copies, the correlation between a wallet's *own* on-chain track record and *our* net when we
   copy it is statistically nil: `monthly_run_rate` r = **−0.08**, own `win_rate` r = **−0.06**,
   `median_rt_pct` r = **+0.02**, `n_round_trips` r = **−0.20**. The top quartile of wallets *by their
   own score* lost us **−6.49 SOL** when copied; the bottom quartile *made* **+1.32 SOL**. We are
   spending RPC scoring 4,929 wallets on metrics that do not select profitable copies.

2. **What *does* predict copy profit is our own prior copy performance of that lead** — and it
   persists. Split-half autocorrelation of per-lead copy net is **r = +0.43**. Leads profitable in
   the first half of their history returned **+5.42 SOL** in the second half (60% stayed positive);
   leads unprofitable in the first half returned **−7.85 SOL**. This is exactly what the `hotLeadGate`
   keys on — and it is the only lead-selection signal in the book that works.

3. **The edge does not survive realistic, let alone live, execution.** The flagship
   `copy-hotlead-hold30m` shows **+40.8 SOL idealized**, but its realistic 5s-lag twin
   (`-pair-shadow`) is **+0.30 SOL** over 320 trades, and the **live** twin is **−0.68**. The one
   matched live-vs-shadow cohort shows a **−6.64 pp** execution gap (live −0.13 vs shadow +2.89 over
   126 matched trades). Idealized profit is an accounting artifact; real profit is ≈0 before
   execution costs and **negative** after.

**Bottom line:** the copy book as constructed does not have a durable, post-cost edge. The closest
thing to one — recency-gated lead selection — is real but thin and front-loaded, and is currently
buried under (a) a discovery/scoring pipeline that selects on the wrong metric, (b) a structurally
fat-tailed return distribution, and (c) an execution gap that erases what little edge remains.

---

## 1. What we copy, and what we can observe

**The funnel:** 79,247 `wallet_candidates` (seeded from graduation firstbuyer/dev/creator + cotrade
signals) → 4,929 scored in `wallet_scores` → 137 in `follow_list` (**0 currently `enabled`**) → 257
distinct wallets actually watched on the Helius `transactionSubscribe` socket in the last 7d, firing
**341,598** lead events. Live trading is driven by the `-live-micro` strategy (pair-shadow-driven),
**not** by the follow_list: 639 closed live trades across 94 distinct leads.

**Observable metrics per wallet** (the surface we have to work with):

| Source | Metrics |
|---|---|
| `wallet_scores` (their own edge) | `n_round_trips`, `total_realized_sol`, `total_realized_sol_drop_top3`, `median_rt_pct`, `monthly_run_rate_sol`, `win_rate`, `avg_hold_sec`, `last_active`, venue mix (`pumpswap_share`) |
| `copy_trades` (our edge copying them) | per-trade `net_sol`, `gross_pct`, `hold_sec`, `exit_reason`, `detection_lag_sec`, `lead_tier`, entry/exit price |
| `copy_probe_events` (their live flow) | `action`, `sol_delta`, `venue`, `tier`, `their_block_time`, `detection_lag_sec` |
| `wallet_round_trips` | individual realized round-trips (basis for scores) |

The leaderboard gate (`min_round_trips 100`, `min_total_sol 0.5`, `min_drop_top3_sol 0`,
`min_monthly_run_rate_sol 3.75`, `max_days_since_active 14`) yields 7 "promotable" / 5 "watch"
wallets — **but it gates on the wallet's own PnL, which Finding #1 shows is the wrong target.**

---

## 2. The wallet-scoring validity problem (Finding #1, detail)

Query: per-lead copy net on the broadest strategy (`copy-tp100-sl30`, which copies *every* lead with
a standard TP100/SL30 ruleset), left-joined to that wallet's own `wallet_scores`. 81 leads, ≥8 copies.

- corr(copy_net, own `monthly_run_rate_sol`) = **−0.081**
- corr(copy_net, own `win_rate`) = **−0.059**
- corr(copy_net, own `median_rt_pct`) = **+0.020**
- corr(copy_net, own `n_round_trips`) = **−0.199**  ← *more-active wallets are slightly worse to copy*
- corr(copy_net, our copy `win_rate`) = +0.675 (tautological), corr(copy_net, copy `n`) = **−0.466**

Concrete contradictions:
- `9LxMdvs1…` — best own run-rate on the board (`s_mrr` **+609**, passed all gates) → copy net **+0.14** (≈0).
- `B6yHBbrf…` — own run-rate **−519** → copy net **+3.51** (a top-5 copy winner).
- `3iZG5TLva…` — own `win_rate` 0.77, `median_rt` +276% → copy net **+0.17**, and it's a *worst* lead on two hot-lead strategies.

**Why:** a wallet's realized PnL comes from *its own entries and its own exits and its own sizing*.
We replicate only the entry, ~1.1–6s late, and impose our exit rules. The lead's skill lives mostly
in the parts we don't copy (and often in non-replicable information edge as the dev/early wallet).
So own-PnL is the wrong selector. **The "promotable"/"smart" tiers don't help either:** promotable-tier
leads summed to **−7.78 SOL** copied; smart-tier to **−2.52**; ~half of each were net-negative.

The same point shows up *within our own strategies*: leads flip sign across exit rules.
`DVhwSE98` is the **worst** lead on `copy-hotlead-hold30m` (−3.6) but a **top** lead on
`copy-hotlead-strict` (+2.3). `57YFGs6` is a top lead on hold30m (+5.8) and a worst lead on plain
hotlead (−2.2). Copy-profit is not a stable wallet property — it's an entry×exit×regime interaction.

---

## 3. The signal that does work: recency persistence (Finding #2, detail)

Split-half test on the 60 leads with ≥12 baseline copies (ordered by time, first half vs second half):

- corr(first-half net, second-half net) = **+0.429** — a real, moderate, exploitable autocorrelation.
- First-half **winners** (n=25): second-half sum **+5.42 SOL**, 60% still positive.
- First-half **losers** (n=35): second-half sum **−7.85 SOL**, only 51% turn positive (coin flip).
- "Follow only proven-hot leads" = **+5.42** vs "follow everyone" = **−2.44** on the same second halves.

This is precisely the `hotLeadGate` mechanic (`{lastN:10, minTrades:3, minNetSol:0|0.5}`): gate entries
on *our last 10 copies of this lead being net-positive*. It is the right idea and the only lead
selector with evidence behind it. Caveat from the journal (06-27, cohort N): a fresh same-age twin of
`copy-hotlead` ran negative while the older instance booked +14.5 — **the hotlead edge is front-loaded
and regime-sensitive.** Persistence is real but decays; it is a tilt, not a money printer.

---

## 4. Idealized → realistic → live: the execution cliff

| Strategy (same hot-lead entry, 30m runner exit) | net SOL | n | drop3 | exit_stress | monthly |
|---|---|---|---|---|---|
| `copy-hotlead-hold30m` (idealized 1:1, ~1.1s fill) | **+40.8** | 860 | +9.7 | +31.1 | 87.4 |
| `…-pair-shadow` (realistic, 5s lag, re-fetched price) | **+0.30** | 320 | −0.9 | −0.03 | 1.3 |
| `…-live-micro` (real funds, pair-shadow-driven) | **−0.68** | 320 | −1.4 | −0.7 | −2.9 |

The matched live-vs-shadow cohort: **live −0.13 vs shadow +2.89 over 126 matched trades, exec gap
−6.64 pp**. The promotion table's three "score 100 / promotable" rows are flattered by the idealized
mirror feeding the realistic scorer; the *genuinely* realistic twins are flat-to-negative.

The whole active book reflects this: **n=7,866, net +25.4 SOL but drop_top3 −19.5 and exit_stress
−49.99, win rate 29.7%.** Removing the 3 best trades flips the book negative — the textbook signature
of no robust edge. Retired strategies: −95.7 SOL over 19,256 trades. Daily P&L is violent: −40.3 SOL
on 2026-06-29 alone, +26.4 the day before.

---

## 5. Structural fat tail (why drop3 never converges)

The lab has been stuck on "drop3 < 0" for weeks, and the audit explains why it's structural, not a
tuning miss. `lead_attribution`:
- `copy-hotlead-hold45m`: **one wallet** (`C4eNLxxC`, +20.5) is **76.7%** of net; top-3 = **94.2%**.
  Strip it → the strategy is deeply negative. Pure lottery (drop3 −13.2).
- Even the flagship hold30m: top wallet 15.2%, top-3 35.7% of net.
- Across all leads, gross gains **+60.25 SOL** but the top-5 leads are **30%** of them; only 49% of
  leads are net-positive.

Three full exit-engineering cohorts (K, O, P — trailing-TP, scale-out, ratchet, breakeven, hold-sweep)
**all failed to make drop3 positive**. The journal's own conclusion is right: exit shape can't rescue
a base whose winners are 3 moonshots. **drop3 is an *entry-selection* problem, not an exit problem** —
and the only entry lever that broadens the winner base is recency-gated lead selection (Finding #2).

---

## 6. Live-execution operational health

From `live_execution`: **139 failures — 131 "rent", 8 slippage(6004)** — plus **87 anomalous fills**
and **11 reconciliation orphans** (positions with 0 tokens). Per CLAUDE.md, rent failures are a
wallet-balance symptom, not a retry bug. The −6.64 pp exec gap is the sum of slippage + failed/partial
fills + the 5s detection-to-fill reality. **No copy edge can be evaluated live until this is clean** —
right now execution noise is larger than any edge being measured.

---

## 7. Recommendations toward continuous profit (proposals)

Ordered by leverage. All are proposals for operator review; roster items are code edits to
`COPY_STRATEGIES`.

1. **Stop selecting/scoring leads on their own PnL.** The `wallet_scores` gate has r≈0 with copy
   profit. Repoint discovery at the metric that works: **realized copy net per lead** (`copy_trades`),
   which the `hotLeadGate` already uses. Concretely — propose demoting `wallet_scores`/leaderboard
   from a *selection* input to a *seed-only* input (find candidates, don't rank copyability by it),
   and freeing the RPC currently spent scoring 4,929 wallets. This is the single biggest finding.

2. **Make hot-lead selection the spine, and harden it.** It's the only evidenced edge (autocorr
   +0.43). Two cheap, on-data experiments: (a) a **decay/half-life** on the lastN window (recent
   copies weighted more, since the edge is front-loaded); (b) a **demote-on-cold** rule symmetric to
   the promote-on-hot gate (first-half losers lose −7.85 — actively *bench* them, not just "don't
   promote"). Both are gate tweaks, zero marginal RPC.

3. **Judge everything on the realistic/live twin, never the idealized mirror.** Propose the daily
   report headline the `-pair-shadow`/`-live-micro` net as the *only* P&L that counts, and treat the
   idealized number purely as an upper bound (the bar already says this; the promotion table currently
   still surfaces idealized-flattered "score 100" rows — worth a reporting fix).

4. **Fix execution before scaling live.** Resolve the 131 rent failures (wallet SOL buffer) and the
   87 anomalous fills + 11 orphans first. Until the live↔shadow gap is < ~2 pp, live numbers measure
   plumbing, not strategy.

5. **Accept the fat tail or change the universe.** If drop3>0 at n≥100 remains unreachable on
   post-graduation PumpFun tokens after (1)–(2), that's evidence the *token universe* is structurally
   lottery-shaped. Options to weigh: position-size by lead-hotness (bet more on proven leads), or
   widen beyond same-token consensus. Don't spend another cohort on exit rules — that search is closed.

---

## 8. Further investigations worth running

- **Per-lead realistic (not idealized) ranking** — repeat the §2/§3 analysis on `-pair-shadow` rows,
  not `copy-tp100-sl30`, to rank leads on the surface we'd actually trade. (Baseline was used here for
  coverage; n per lead on the realistic twin is still thin.)
- **Detection-latency vs net** — does `detection_lag_sec` predict per-trade net? p95 total lag is
  2.52s but max 8.6s; quantify the cost of the slow tail (cheap, in `copy_trades`).
- **Time-of-day / regime conditioning of the *hotlead* edge** — the journal says it's regime-sensitive;
  test whether hot-lead persistence concentrates in specific windows (without re-introducing a
  standalone regime gate, which already failed).
- **Lead overlap / crowding** — when ≥N of our watched leads buy the same mint within a window, is
  forward copy net better? (consensus2 hints yes; quantify the crowding curve.)
- **Survivorship in discovery** — of the 79k candidates, what fraction ever produce a *copyable*
  (post-graduation, pumpswap) buy we can act on? Sizing the usable universe bounds the whole thesis.

---

### Appendix — queries used
1. Per-lead copy net (`copy-tp100-sl30`) ⨝ `wallet_scores` (validity test).
2. Per-lead per-trade net, split-half via window functions (persistence test).
3. `lead_attribution` / `by_strategy` / `live_vs_shadow` from `copy-trades.json`.
4. Table sizes: `follow_list` (137, 0 enabled), `wallet_scores` (4,929), `wallet_candidates`
   (79,247), `copy_probe_events` 7d (341,598 / 257 wallets), live trades (639 / 94 leads).
