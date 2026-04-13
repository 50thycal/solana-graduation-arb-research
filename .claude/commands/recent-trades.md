---
description: Fetch trades from bot-status branch and report recent paper trades.
---

Fetch `trades.json` from the bot-status branch using `mcp__github__get_file_contents` with `owner=50thycal`, `repo=solana-graduation-arb-research`, `path=trades.json`, `ref=refs/heads/bot-status`.

NOTE: trades.json can be large. If the MCP call says the result was saved to a temp file, use Bash + python3 to extract only what you need (see CLAUDE.md "trades.json large-file workaround" for the pattern).

Then:

1. Print `stats` summary per strategy: total trades, closed, avg net return, TP / SL / timeout exit counts.
2. Print the most recent 10 trades as a table: id | strategy_id | mint (first 8 chars) | entry_pct_from_open | exit_reason | net_return_pct.
3. Call out any trade where `exit_reason` is unexpected (crash, error) or where slippage exceeded the fallback estimate.
4. If `stats.avg_net_return_pct` is negative and n >= 30, flag it — the live bot is losing money.

Do NOT make code changes from this command — it's read-only.
