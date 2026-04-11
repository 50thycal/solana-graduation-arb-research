---
description: Fetch /api/snapshot from the Railway-deployed bot and render a compact human-readable summary.
---

Fetch `${RAILWAY_URL}/api/snapshot` via `WebFetch`.

Render a compact summary with:

1. **Header**: uptime, total graduations, labeled count (PUMP / DUMP / STABLE), raw win rate, vel 5-20 progress toward n=200.
2. **Baseline**: current best-known baseline (filter, SL, TP, avg return, n) from `scorecard.best_known_baseline`.
3. **Data quality**: `data_quality` fields — flag any non-HEALTHY field (null fields, stalled, missing pool, etc).
4. **Last 10 graduations**: one-line each (id | label | pct_t30 | pct_t300 | holders | velocity).
5. **Last error**: if `last_error` is non-null, print ts + message.

If `data_quality.stalled` is true, prefix the whole report with "⚠ STALLED — bot has not seen a graduation in N seconds" and suggest running `/diagnose` next.
