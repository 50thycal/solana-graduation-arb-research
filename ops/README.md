# `ops` branch — Claude's self-service request channel

This branch exists so Claude can fetch **Railway logs** and run **read-only DB
queries** on its own, without you clicking "Run workflow".

**Why this exists:** Claude Code web sessions can *read* GitHub Actions runs but
**cannot dispatch** `workflow_dispatch` workflows (the Claude GitHub App has no
`actions:write` scope, by design). Claude *can* push a file, though — so a push
to `ops/request.json` is used as the trigger.

**How it works:** Claude overwrites `ops/request.json` and pushes it here. That
push fires the `Ops Runner` workflow (`.github/workflows/ops-runner.yml`), which
runs the request and prints the result to the job log **and** commits it back to
`ops/result.txt`. Claude then reads `ops/result.txt` over plain git (or the job
log via the API).

**This branch is intentionally separate from `main`:**
- Request commits never touch `main`, so real history stays clean.
- Railway only deploys from the default branch, so these pushes **never redeploy
  the worker**.

`ops/request.json` shapes:

```jsonc
{"type": "logs", "limit": 200, "filter": "", "deployment_id": ""}
{"type": "db",   "sql": "select label, count(*) from graduation_momentum group by 1", "max_rows": 200}
{"type": "noop"}   // placeholder; do nothing
```

DB requests are read-only several ways over (read-only SQLite connection +
`readonly`/`reader` check + isolated child process + lexical guard in
`scripts/db_query.py`). The manually-triggered `Railway Logs` and
`DB Query (read-only)` workflows on `main` do the same thing on demand; this
branch just removes the manual click. See `docs/REMOTE_ACCESS.md`.
