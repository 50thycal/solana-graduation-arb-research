---
description: Fetch /api/trades and report recent paper trades. Optional arg — limit.
---

Fetch `${RAILWAY_URL}/api/trades?limit=<arg1>&status=all` via `WebFetch`. Default limit = 50.

Then:

1. Print `stats` summary per strategy: total trades, closed, avg net return, TP / SL / timeout exit counts.
2. Print the most recent 10 trades as a table: id | mint | status | entry_pct_from_open | exit_reason | net_return_pct.
3. Call out any trade where `exit_reason` is unexpected (crash, error) or where slippage exceeded the fallback estimate.
4. If `stats.avg_net_return_pct` is negative and n ≥ 30, flag it — the live bot is losing money.
