---
description: Fetch diagnose from bot-status branch and report the verdict + next action.
---

Fetch `diagnose.json` from the bot-status branch using `mcp__github__get_file_contents` with `owner=50thycal`, `repo=solana-graduation-arb-research`, `path=diagnose.json`, `ref=refs/heads/bot-status`.

Then:

1. Report `verdict` prominently (HEALTHY / LEVEL*_FAIL / NO_DATA).
2. Report `next_action` verbatim.
3. If any level failed, dump its `evidence` object inline so the user can see the failure mode without re-fetching.
4. If `recent_errors` is non-empty, list each with ts, name, and msg.
5. If the verdict is HEALTHY, end with: "Safe to interpret /snapshot and /best-combos as real signal."

Do NOT make code changes from this command — it's read-only. If a fix is needed, report it and wait for the user.
