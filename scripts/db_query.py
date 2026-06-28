"""Run a read-only SQL query against the bot's SQLite DB, on demand.

Runs inside the `DB Query (read-only)` GitHub Actions workflow. The bot's DB is
a SQLite file on the Railway volume, which a GitHub runner cannot reach
directly — so instead this POSTs the query to the bot's authenticated
`/api/db-query` endpoint (the runner has open egress and can reach the Railway
public URL; Claude's own session cannot). The endpoint runs each statement in an
isolated child process on a read-only connection. Results come back as JSON and
are printed here as a table. Stdlib only.

Read-only enforcement, in layers:
  1. The endpoint opens a read-only SQLite connection and rejects any statement
     better-sqlite3 doesn't report as `readonly` + `reader`. This is the real guard.
  2. This script does a lightweight lexical check first (rejects multi-statement
     and obvious write/DDL verbs) so bad input fails fast with a clear message.

Env:
    DB_QUERY_URL    (required) full URL of the endpoint, e.g.
                    https://<service>.up.railway.app/api/db-query
    DB_QUERY_TOKEN  (required) bearer token matching the service's DB_QUERY_TOKEN
    SQL             (required unless passed as argv[1]) a single read-only statement
    MAX_ROWS        (optional; default 200)
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request

# Write/DDL verbs that must never reach the database. The read-only endpoint
# already blocks these; this just fails fast. Matched on word boundaries so
# column names like `created_at` / `updated_at` don't trip `create` / `update`.
_FORBIDDEN = (
    "insert", "update", "delete", "drop", "alter",
    "truncate", "create", "grant", "revoke", "attach",
)

MAX_ROWS_DEFAULT = 200
CELL_WIDTH = 200  # truncate wide cells so the job log stays readable


def _resolve_sql() -> str:
    if len(sys.argv) > 1 and sys.argv[1].strip():
        return sys.argv[1]
    env_sql = os.environ.get("SQL", "").strip()
    if env_sql:
        return env_sql
    if not sys.stdin.isatty():
        return sys.stdin.read()
    raise SystemExit("No SQL provided (pass as arg, $SQL, or stdin).")


def _check_read_only(sql: str) -> str:
    s = sql.strip().rstrip(";").strip()
    if not s:
        raise SystemExit("Empty SQL.")
    if ";" in s:
        raise SystemExit("Only a single statement is allowed (no ';').")
    first = re.match(r"\s*([a-zA-Z]+)", s)
    verb = (first.group(1).lower() if first else "")
    # PRAGMA is allowed at this layer for read-only schema inspection
    # (e.g. PRAGMA table_info(x)); the endpoint still rejects any write-PRAGMA
    # via better-sqlite3's readonly check, so write-PRAGMAs can't get through.
    if verb not in ("select", "with", "explain", "values", "table", "pragma"):
        raise SystemExit(
            f"Only read-only queries allowed; statement starts with '{verb or '?'}'. "
            "Use SELECT / WITH / EXPLAIN / VALUES / TABLE / PRAGMA."
        )
    for word in re.findall(r"[a-zA-Z_]+", s.lower()):
        if word in _FORBIDDEN:
            raise SystemExit(f"Forbidden keyword '{word}' in query.")
    return s


def _print_table(result: dict) -> None:
    if not result.get("ok"):
        print(f"  ERROR: {result.get('error')}")
        return
    cols = result.get("columns") or []
    rows = result.get("rows") or []
    if not rows:
        print("  (0 rows)")
        return

    def cell(v: object) -> str:
        t = "" if v is None else str(v)
        return t if len(t) <= CELL_WIDTH else t[: CELL_WIDTH - 1] + "…"

    widths = {c: len(c) for c in cols}
    str_rows = []
    for r in rows:
        sr = {c: cell(r.get(c)) for c in cols}
        for c in cols:
            widths[c] = max(widths[c], len(sr[c]))
        str_rows.append(sr)
    header = " | ".join(c.ljust(widths[c]) for c in cols)
    print("  " + header)
    print("  " + "-+-".join("-" * widths[c] for c in cols))
    for sr in str_rows:
        print("  " + " | ".join(sr[c].ljust(widths[c]) for c in cols))
    extra = " (truncated)" if result.get("truncated") else ""
    print(f"  [{result.get('row_count', len(rows))} rows{extra}]")


def main() -> int:
    url = os.environ.get("DB_QUERY_URL", "").strip()
    token = os.environ.get("DB_QUERY_TOKEN", "").strip()
    if not url or not token:
        print("DB_QUERY_URL and DB_QUERY_TOKEN must both be set.", file=sys.stderr)
        return 1

    sql = _check_read_only(_resolve_sql())
    try:
        max_rows = int(os.environ.get("MAX_ROWS", str(MAX_ROWS_DEFAULT)))
    except ValueError:
        max_rows = MAX_ROWS_DEFAULT

    body = json.dumps({"id": "q", "sql": sql, "max_rows": max_rows}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=70) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise SystemExit(f"Endpoint HTTP {e.code}: {detail}") from None
    except urllib.error.URLError as e:
        raise SystemExit(f"Could not reach endpoint: {e.reason}") from None

    print(f"# {sql}")
    for result in payload.get("results", []):
        _print_table(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
