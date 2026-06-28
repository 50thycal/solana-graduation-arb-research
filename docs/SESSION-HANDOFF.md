# Session Handoff — 2026-06-28

Quick "where are we / what's next" so you can pick up in a few days. Full detail in
`docs/copy-trade-journal.md` (cohorts P/Q/R/S). Live numbers always in `copy-trades.json` on
`bot-status`.

## TL;DR
This session: audited RPC usage, cut the roster to control the Helius budget, then spun up a wave of
**data-backed `copy-hotlead-hold30m` experiments** + **token-metadata capture**. Everything is
zero/low-RPC. Now it's a waiting game for data.

## ⚠️ First thing to check
**PR #488 — merge it to deploy** (cohorts Q/R/S + metadata capture). Until merged, those 5 variants
and the metadata fetcher are NOT running. Cohort P (7 variants) is already merged & collecting.
- Merging `main` auto-deploys (Railway). Clocks start at deploy.

## In-flight experiments (all on the `copy-hotlead-hold30m` base; kill per id: `n≥100 AND drop3 < parent's drop3`)
| Cohort | Variants | Tests | Status |
|---|---|---|---|
| P | hold45m, hold60m, hold20m, sl20, sl40, be30, hold30m-strict | hold-time / stop-level / breakeven / strict-entry sweep | **running** (merged) |
| Q | cap2, prune | repeat-buy cap (2/mint); per-strategy lead exclusion | in PR #488 |
| R | early, nochase | first-mover (≤1 prior buyer); buy ≤+50% of grad open | in PR #488 |
| S | crowdexit | exit when ≥2 smart wallets sell in 10min | in PR #488 |

## NEXT ACTIONS when you check back (~July 3–5, once n + metadata have accrued)

**1. Evaluate the cohorts (P first, then Q/R/S as they reach n≥100).**
Read `copy-trades.json → by_strategy` / `promotion.rows`. For each variant: keep if `drop3 >` parent
`copy-hotlead-hold30m`'s drop3; kill (propose roster edit) otherwise. Journal the verdicts.

**2. Run the RUG-SIGNAL analysis — the gated payoff of the metadata capture.**
Once `token_metadata` has a few days of rows, push this to the `ops` branch (`ops/request.json`):
```json
{"type":"db","sql":"SELECT tm.has_socials, tm.has_image, COUNT(*) AS n, ROUND(AVG(CASE WHEN ct.net_sol>0 THEN 1.0 ELSE 0 END),3) AS win_rate, ROUND(SUM(ct.net_sol),3) AS tot_net, ROUND(AVG(ct.net_sol),4) AS avg_net FROM copy_trades ct JOIN token_metadata tm ON tm.mint=ct.mint WHERE ct.strategy_id='copy-hotlead-hold30m' AND ct.status='closed' AND ct.net_sol IS NOT NULL AND tm.ok=1 GROUP BY tm.has_socials, tm.has_image ORDER BY tm.has_socials, tm.has_image","max_rows":50}
```
First sanity-check coverage: `SELECT COUNT(*) total, SUM(ok) ok, SUM(has_socials) socials, SUM(has_image) img FROM token_metadata`.
**Decision rule:** if no-socials / no-image tokens clearly underperform (lower win_rate AND negative
avg_net) at decent n, build a metadata-completeness entry gate (e.g. `requireSocials`/`requireImage`
field) as a new variant — same data-first discipline. If not, log the negative result and move on.

**3. Confirm the RPC budget is back under control (original task).**
Cap is 10M/mo (resets the 22nd). We cut ~14 strategies + you lowered the rps cap. By now there should
be enough of a billing window to confirm the new daily burn projects under 10M. Spot-check
`snapshot.json → rpc_limiter` (servedByLabel, projCallsPerDay) and the Helius dashboard.

## Backlog / not started
- Nothing major left from this session's brainstorm — the rug analysis (#2 above) is the main open
  thread, and it's data-gated.
- Possible future: metadata-gate variant (from #2), and a `crowdSellExit` threshold sweep if S looks
  promising.

## Reference (what was decided / killed this session — don't re-litigate)
- **Token chart-features** (liquidity/holders/top5/dev%) — TESTED, **dead** (liquidity 89% null; rest
  noisy/non-monotonic). Don't rebuild chart-feature gates.
- **Naive "skip if extended" cap** — refuted (U-shaped); the surviving version is `-nochase` (≤+50%).
- **`copy-tp100-sl30`** — keep (load-bearing baseline for the hot-lead gate).
- **db-query channel** — use the `ops` branch (`ops/request.json` → `ops/result.txt`); the old
  `bot-status` db-query channel is retired.
