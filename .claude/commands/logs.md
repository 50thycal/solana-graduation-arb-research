---
description: Fetch /api/logs from the in-process ring buffer. Args — level grep limit.
---

Fetch `${RAILWAY_URL}/api/logs?level=<arg1>&grep=<arg2>&limit=<arg3>` via `WebFetch`.

Defaults: `level=warn`, no grep, `limit=200`.

Then:

1. Print `buffer_size` so we know how much history is available.
2. For each entry, print: `ts_iso | level | name | msg` (+ bindings if present).
3. Call out repeated errors (same msg appearing > 3 times) as likely a real bug.
4. Reminder: the ring buffer resets on redeploy. If you need older logs, fall back to the Railway dashboard.
