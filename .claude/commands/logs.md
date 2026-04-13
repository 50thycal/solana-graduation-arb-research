---
description: Report that logs are only available on the live Railway dashboard (not synced to bot-status).
---

Logs are **NOT synced to the bot-status branch**. The `/api/logs` endpoint is live-only on the Railway deployment, and Railway returns 403 from Claude sessions.

To check logs, the human operator needs to check the Railway dashboard directly.

**What Claude CAN check instead:**
- `/diagnose` — runs the Level 1-4 bug triage which catches most issues
- `/snapshot` — shows recent errors, data quality flags, and listener stats
- `/recent-trades` — shows paper trade results including any failed trades

If you're looking for specific error information, try `/diagnose` first — it surfaces the most actionable issues without needing raw logs.
