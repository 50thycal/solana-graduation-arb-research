---
description: Fetch /api/best-combos and report the filter leaderboard. Args (optional) — min_n top.
---

Fetch `${RAILWAY_URL}/api/best-combos?min_n=<arg1>&top=<arg2>&pairs=true` via `WebFetch`.

Defaults if args missing: `min_n=50 top=20`.

Then:

1. Print the baseline: `baseline_avg_return_pct` from the response.
2. For each row in `rows` (top 20), print one line: `rank | filter_spec | n | sim_avg_return_10sl_50tp_pct | sim_win_rate | beats_baseline`.
3. Call out any rows where `beats_baseline = true` — these are candidates to promote.
4. Summarize: how many rows beat the baseline, and which filter dimensions dominate the top 10 (velocity / age / holders / top5 / liquidity / etc).
5. Suggest the next hypothesis based on what you see. Don't default to velocity if the data says otherwise.

Do NOT make code changes from this command — it's read-only.
