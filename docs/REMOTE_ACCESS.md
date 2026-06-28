# Remote access: Railway logs & read-only DB queries (for Claude)

This lets Claude (running in the Claude Code web environment) fetch **real
Railway platform logs** and run **read-only SQL** against the bot's database on
demand, without you copy-pasting console output.

## Why it works this way

The Claude web environment can only reach an **allowlisted set of hosts over
HTTP** — GitHub is on it, but Railway and the bot's own URL are not (the bot's
Railway URL returns 403 to Claude's proxy). Rather than poke holes in that
allowlist, both features run as **manually-triggered GitHub Actions workflows**:

```
Claude --(GitHub API: trigger workflow)--> GitHub Actions runner --(open internet)--> Railway API / bot URL
  ^                                                                                          |
  +----------------------- reads the job log via the GitHub API <-----------------------------+
```

GitHub runners have open egress, so they reach Railway fine. Secrets live in
**GitHub Actions secrets** — never in the repo and never in Claude's context.

### Logs vs the in-process `logs.json`

`logs.json` on the `bot-status` branch is a convenience snapshot of the bot's
**in-process** log ring buffer. It is great for recent app-level lines but it
**cannot** capture native crashes, OOM `SIGKILL`s, or anything on stderr — the
process dies before it can publish. The **Railway Logs workflow** pulls the
**actual platform logs** (`backboard.railway.com` GraphQL), so it sees crashes,
restarts, and exit codes. Use it whenever the bot is misbehaving.

### DB: why a workflow → HTTP endpoint (not a direct DB connection)

The bot's DB is **SQLite — a file on the Railway volume** (`/app/data`), which a
GitHub runner can't open remotely. So the DB workflow POSTs the query to the
bot's authenticated **`POST /api/db-query`** endpoint instead. The endpoint runs
each statement in an **isolated child process** on a **read-only** connection
(`src/api/db-query-exec.ts` → `db-query-runner.ts`), so an arbitrary query can
never crash the live trading bot. This replaces the old
`db-query.json` → `bot-status` channel, which was coupled to the 2-minute
status-sync loop.

## One-time setup

### 1. A Railway API token + IDs

Railway → **Account/Workspace Settings → Tokens** → create a token (a
**Workspace**/team token is the most reliable against the GraphQL API). The three
IDs are in your service URL:
`railway.com/project/<projectId>/service/<serviceId>?environmentId=<environmentId>`
(current: project `251ffd8d-…`, service `bad7d76c-…`).

### 2. A DB-query token on the service

Pick a long random string. Add it as an environment variable on the Railway
**service**: `DB_QUERY_TOKEN=<random>`. The `/api/db-query` endpoint stays
disabled (503) until this is set.

### 3. The bot's public URL

Railway → your service → **Settings → Networking → Public Networking** (e.g.
`https://<service>.up.railway.app`). The endpoint path is `/api/db-query`.

### 4. GitHub Actions secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `RAILWAY_TOKEN` | Railway token from step 1 |
| `RAILWAY_PROJECT_ID` | `251ffd8d-…` |
| `RAILWAY_ENVIRONMENT_ID` | the environment ID from the URL |
| `RAILWAY_SERVICE_ID` | `bad7d76c-…` (optional but recommended) |
| `DB_QUERY_URL` | `https://<service>.up.railway.app/api/db-query` |
| `DB_QUERY_TOKEN` | the same random string from step 2 |

### 5. Get the workflows onto the default branch

`workflow_dispatch` workflows can only be **triggered** once they exist on the
repo's **default branch**. Merge this branch into `main`. Until then the
workflows are visible but not runnable.

## How Claude uses it

Claude triggers the workflows through the GitHub API and reads the result from
the job log:

- **Logs** — runs the **`Railway Logs`** workflow (`railway-logs.yml`),
  optionally with `limit`, a `deployment_id`, or a `filter`.
- **Data** — runs the **`DB Query (read-only)`** workflow (`db-query.yml`) with a
  single read-only statement, e.g.
  `select label, count(*) from graduation_momentum group by 1 order by 2 desc`.

Each run takes ~30–60 s to spin up. You can also trigger either from the repo's
**Actions** tab.

## Safety

- **Logs** are read-only by nature.
- **DB queries** are read-only several times over: the endpoint opens a SQLite
  **read-only** connection and rejects any statement better-sqlite3 doesn't
  report as `readonly` + `reader`; each query runs in an **isolated child
  process** (a crash/OOM can't reach the bot); rows are capped; and
  `scripts/db_query.py` lexically rejects multi-statement and write/DDL SQL
  before it's sent. The endpoint requires the `DB_QUERY_TOKEN` bearer.

## If Railway's log query stops working

Railway's GraphQL schema occasionally changes. The queries live at the top of
[`scripts/railway_logs.py`](../scripts/railway_logs.py). For a quick probe the
script honors `RAILWAY_RAW_QUERY` (+ optional `RAILWAY_RAW_VARS` JSON) to run an
arbitrary GraphQL query — introspection works from the runner.
