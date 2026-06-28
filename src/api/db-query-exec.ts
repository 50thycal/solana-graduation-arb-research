/**
 * src/api/db-query-exec.ts
 *
 * Parent-side launcher for ad-hoc read-only DB queries. Runs each batch in a
 * SEPARATE child process (db-query-runner.js) so a native better-sqlite3 abort
 * or an OOM in an arbitrary query kills only that child — never the bot. This
 * is the isolation proven necessary in #480.
 *
 * Used by the authenticated POST /api/db-query HTTP endpoint, which a GitHub
 * Actions runner calls on demand (the "Railway-style" remote access — see
 * docs/REMOTE_ACCESS.md). The old gist-sync `db-query.json` → bot-status channel
 * is retired in favour of this on-demand path, which is fully decoupled from the
 * trading-critical status-sync loop.
 */
import path from 'path';
import { execFile } from 'child_process';
import Database from 'better-sqlite3';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('db-query-exec');

export const DB_QUERY_HARD_ROW_CAP = 50_000;
export const DB_QUERY_DEFAULT_ROW_CAP = 1000;
const CHILD_TIMEOUT_MS = 60_000;
const CHILD_MAX_BUFFER = 64 * 1024 * 1024;

export interface DbQueryRequest {
  id: string;
  sql: string;
  max_rows?: number;
}

export interface DbQueryResult {
  id: string;
  sql: string;
  ok: boolean;
  error?: string;
  columns?: string[];
  rows?: unknown[];
  row_count?: number;
  truncated?: boolean;
  elapsed_ms?: number;
}

/** Resolve the better-sqlite3 file path from a live handle. */
export function resolveDbPath(db: Database.Database): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filename = (db as any).name as string | undefined;
  if (!filename) throw new Error('Cannot resolve DB path from better-sqlite3 handle');
  return filename;
}

/**
 * Resolve the compiled db-query-runner.js path. Only exists in the compiled
 * (dist) layout: dist/api/db-query-exec.js -> __dirname = dist/api/. Under
 * ts-node (dev) there's no compiled runner — return null so we fall back to an
 * in-process readonly query (acceptable in dev; production always has dist).
 */
function resolveRunnerPath(): string | null {
  const here = __dirname;
  if (!here.endsWith(`${path.sep}dist${path.sep}api`)) return null;
  return path.join(here, 'db-query-runner.js');
}

const errResult = (q: DbQueryRequest | undefined, error: string): DbQueryResult => ({
  id: (q && typeof q.id === 'string') ? q.id : '(missing id)',
  sql: (q && typeof q.sql === 'string') ? q.sql : '',
  ok: false,
  error,
});

/** Dev-only fallback: run a single guarded query in-process on a readonly conn. */
function runOneInProcess(dbPath: string, q: DbQueryRequest): DbQueryResult {
  const startedAt = Date.now();
  const id = typeof q?.id === 'string' ? q.id : '(missing id)';
  const sql = typeof q?.sql === 'string' ? q.sql : '';
  if (!sql || typeof q?.id !== 'string') return errResult(q, 'each query needs string id + sql');
  const cap = Math.min(
    Math.max(1, Number.isFinite(q.max_rows as number) ? (q.max_rows as number) : DB_QUERY_DEFAULT_ROW_CAP),
    DB_QUERY_HARD_ROW_CAP,
  );
  let conn: Database.Database | null = null;
  try {
    conn = new Database(dbPath, { readonly: true, fileMustExist: true });
    conn.pragma('busy_timeout = 5000');
    let stmt: Database.Statement;
    try { stmt = conn.prepare(sql); }
    catch (err) { return errResult(q, `prepare failed: ${err instanceof Error ? err.message : String(err)}`); }
    if (!stmt.readonly) return errResult(q, 'rejected: only read-only queries are allowed (statement writes or is DDL/PRAGMA-write)');
    if (!stmt.reader) return errResult(q, 'rejected: query returns no rows (must be a SELECT or other row-returning read)');
    const rows: unknown[] = [];
    let truncated = false;
    for (const row of stmt.iterate()) { if (rows.length >= cap) { truncated = true; break; } rows.push(row); }
    const first = rows[0];
    const columns = first && typeof first === 'object' && !Array.isArray(first) ? Object.keys(first as Record<string, unknown>) : [];
    return { id, sql, ok: true, columns, rows, row_count: rows.length, truncated, elapsed_ms: Date.now() - startedAt };
  } catch (err) {
    return errResult(q, `query connection failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (conn) { try { conn.close(); } catch { /* ignore */ } }
  }
}

/**
 * Run a batch of read-only queries in an isolated child process. Returns one
 * result per input query (errored results on any failure — never throws). A
 * child crash / timeout is reported per-query; the caller (the HTTP handler)
 * stays up regardless.
 */
export function runDbQueriesIsolated(dbPath: string, queries: DbQueryRequest[]): Promise<DbQueryResult[]> {
  const runnerPath = resolveRunnerPath();
  if (!runnerPath) {
    // Dev (ts-node): no compiled runner — run in-process on isolated readonly
    // connections. Never reached in production (dist always present).
    return Promise.resolve(queries.map((q) => runOneInProcess(dbPath, q)));
  }

  const payload = JSON.stringify({
    dbPath,
    defaultRowCap: DB_QUERY_DEFAULT_ROW_CAP,
    hardRowCap: DB_QUERY_HARD_ROW_CAP,
    queries,
  });

  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [runnerPath],
      { timeout: CHILD_TIMEOUT_MS, maxBuffer: CHILD_MAX_BUFFER },
      (err, stdout) => {
        if (err) {
          const reason = err.signal
            ? `child killed by ${err.signal}`
            : ((err as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
              ? 'result exceeded 64MB buffer'
              : err.message);
          logger.warn({ err: reason }, 'db-query child process failed — endpoint unaffected');
          resolve(queries.map((q) => errResult(q, `query runner failed: ${reason}`)));
          return;
        }
        try {
          const out = JSON.parse(stdout) as { results?: DbQueryResult[] };
          resolve(Array.isArray(out.results) ? out.results : []);
        } catch (e) {
          resolve(queries.map((q) => errResult(q, `runner output parse failed: ${e instanceof Error ? e.message : String(e)}`)));
        }
      },
    );
    child.stdin?.end(payload);
  });
}
