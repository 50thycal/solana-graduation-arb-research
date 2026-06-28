/**
 * src/api/db-query-runner.ts
 *
 * Child-process entry point for ad-hoc read-only Claude DB queries. Spawned by
 * db-query-exec.ts (the parent-side launcher) for each query batch that arrives
 * via the authenticated POST /api/db-query endpoint — see docs/REMOTE_ACCESS.md.
 *
 * Why a child PROCESS (not a worker thread): an arbitrary read-only query can
 * trip a native better-sqlite3 abort or an OOM. A worker thread shares the
 * process, so a native crash there still kills the whole bot. A separate OS
 * process has its own Node runtime, its own native-module load, and its own
 * heap — if a query crashes or runs the heap out of memory, only THIS process
 * dies. The parent (the live trading bot) observes the non-zero exit / missing
 * output and records an error result; it never goes down.
 *
 * This isolation is the fix for the crash where processing a db-query in the
 * bot's main process (even on a dedicated read-only connection, as #473 tried)
 * destabilized the same cycle's heavy buildPayloads + worker thread and the
 * container was silently SIGKILL'd ~14s later. Concurrent read-only access from
 * a separate process is already proven safe (manual repro: a standalone
 * `new Database(path,{readonly:true})` + query against the live DB ran clean
 * while the bot was up).
 *
 * Protocol (stdin → stdout, both JSON):
 *   in:  { dbPath, defaultRowCap, hardRowCap, queries: [{ id, sql, max_rows }] }
 *   out: { results: DbQueryResult[] }
 * Exits 0 on success. A hard crash exits non-zero / on a signal — the parent
 * treats that as "all queries errored" and carries on.
 */
import Database from 'better-sqlite3';

interface QueryRequest {
  id: string;
  sql: string;
  max_rows?: number;
}

interface RunnerInput {
  dbPath: string;
  defaultRowCap: number;
  hardRowCap: number;
  queries: QueryRequest[];
}

interface QueryResult {
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

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
  });
}

/** Run one guarded read-only query. Mirrors the rejection rules of the bot. */
function runOne(db: Database.Database, q: QueryRequest, defaultCap: number, hardCap: number): QueryResult {
  const startedAt = Date.now();
  const id = typeof q?.id === 'string' ? q.id : '(missing id)';
  const sql = typeof q?.sql === 'string' ? q.sql : '';
  if (!sql || typeof q?.id !== 'string') {
    return { id, sql, ok: false, error: 'each query needs string id + sql' };
  }
  const cap = Math.min(
    Math.max(1, Number.isFinite(q.max_rows as number) ? (q.max_rows as number) : defaultCap),
    hardCap,
  );
  let stmt: Database.Statement;
  try {
    // prepare() compiles exactly one statement and throws on a multi-statement
    // string, so "SELECT 1; DROP TABLE x" never reaches exec.
    stmt = db.prepare(sql);
  } catch (err) {
    return { id, sql, ok: false, error: `prepare failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!stmt.readonly) {
    return { id, sql, ok: false, error: 'rejected: only read-only queries are allowed (statement writes or is DDL/PRAGMA-write)' };
  }
  if (!stmt.reader) {
    return { id, sql, ok: false, error: 'rejected: query returns no rows (must be a SELECT or other row-returning read)' };
  }
  const rows: unknown[] = [];
  let truncated = false;
  try {
    for (const row of stmt.iterate()) {
      if (rows.length >= cap) { truncated = true; break; }
      rows.push(row);
    }
  } catch (err) {
    return { id, sql, ok: false, error: `execution failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Column order from the first row's keys — avoids the native stmt.columns().
  const first = rows[0];
  const columns = first && typeof first === 'object' && !Array.isArray(first)
    ? Object.keys(first as Record<string, unknown>)
    : [];
  return { id, sql, ok: true, columns, rows, row_count: rows.length, truncated, elapsed_ms: Date.now() - startedAt };
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: RunnerInput;
  try {
    input = JSON.parse(raw) as RunnerInput;
  } catch {
    process.stdout.write(JSON.stringify({ results: [], error: 'bad request json' }));
    return;
  }
  const queries = Array.isArray(input.queries) ? input.queries : [];
  const defaultCap = Number.isFinite(input.defaultRowCap) ? input.defaultRowCap : 1000;
  const hardCap = Number.isFinite(input.hardRowCap) ? input.hardRowCap : 50000;

  let db: Database.Database | null = null;
  let results: QueryResult[];
  try {
    db = new Database(input.dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    results = queries.map((q) => runOne(db as Database.Database, q, defaultCap, hardCap));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results = queries.map((q) => ({
      id: typeof q?.id === 'string' ? q.id : '(missing id)',
      sql: typeof q?.sql === 'string' ? q.sql : '',
      ok: false,
      error: `query connection failed: ${msg}`,
    }));
  } finally {
    if (db) { try { db.close(); } catch { /* ignore — process is exiting */ } }
  }
  process.stdout.write(JSON.stringify({ results }));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stdout.write(JSON.stringify({ results: [], error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
