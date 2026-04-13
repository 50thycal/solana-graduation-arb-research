---
description: Fetch best-combos from bot-status branch and report the filter leaderboard.
---

Fetch `best-combos.json` from the bot-status branch using `mcp__github__get_file_contents` with `owner=50thycal`, `repo=solana-graduation-arb-research`, `path=best-combos.json`, `ref=refs/heads/bot-status`.

Then:

1. Print the baseline: `baseline_avg_return_pct` from the response.
2. For each row in `rows` (top 20), print one line: `rank | filter_spec | n | sim_avg_return_10sl_50tp_pct | sim_win_rate | beats_baseline`.
3. Call out any rows where `beats_baseline = true` — these are candidates to promote.
4. Summarize: how many rows beat the baseline, and which filter dimensions dominate the top 10 (velocity / age / holders / top5 / liquidity / etc).
5. Suggest the next hypothesis based on what you see. Don't default to velocity if the data says otherwise.

Do NOT make code changes from this command — it's read-only.
