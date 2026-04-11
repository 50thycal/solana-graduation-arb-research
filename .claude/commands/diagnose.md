---
description: Fetch /api/diagnose from the Railway-deployed bot and report the verdict + next action.
---

Fetch the bot's self-diagnosis from `${RAILWAY_URL}/api/diagnose` using `WebFetch`. If `RAILWAY_URL` is not set, check `.claude/settings.json` or ask the user.

Then:

1. Report `verdict` prominently (HEALTHY / LEVEL*_FAIL / NO_DATA).
2. Report `next_action` verbatim.
3. If any level failed, dump its `evidence` object inline so the user can see the failure mode without re-fetching.
4. If `recent_errors` is non-empty, list each with ts, name, and msg.
5. If the verdict is HEALTHY, end with: "Safe to interpret /api/snapshot and /api/best-combos as real signal."

Do NOT make code changes from this command — it's read-only. If a fix is needed, report it and wait for the user.
