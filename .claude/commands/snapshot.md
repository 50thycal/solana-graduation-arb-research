---
description: Fetch snapshot from bot-status branch and render a compact human-readable summary.
---

Fetch `snapshot.json` from the bot-status branch using `mcp__github__get_file_contents` with `owner=50thycal`, `repo=solana-graduation-arb-research`, `path=snapshot.json`, `ref=refs/heads/bot-status`.

Render a compact summary with:

1. **Header**: uptime, total graduations, labeled count (PUMP / DUMP / STABLE), raw win rate, vel 5-20 progress toward n=200.
2. **Baseline**: current best-known baseline (filter, SL, TP, avg return, n) from `scorecard.best_known_baseline`.
3. **Data quality**: `data_quality` fields — flag any non-HEALTHY field (null fields, stalled, missing pool, etc).
4. **RPC health**: if `rpc` section is present, report limiter stats (throttled/dropped) and vault_price_cache stats (hits/misses/coalesced).
5. **Last 10 graduations**: one-line each (id | label | pct_t30 | pct_t300 | holders | velocity).
6. **Last error**: if `last_error` is non-null, print ts + message.

If `data_quality.stalled` is true, prefix the whole report with "STALLED — bot has not seen a graduation in N seconds" and suggest running `/diagnose` next.
