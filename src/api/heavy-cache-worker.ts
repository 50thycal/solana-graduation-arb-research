/**
 * src/api/heavy-cache-worker.ts
 *
 * Worker-thread entry that runs the ~100s heavy aggregation pipeline off the
 * main event loop. Spawned by heavy-cache.ts.
 *
 * Why this exists: in-process the heavy compute starves request handlers
 * (`/health` was clocking 35-50s in production because the JS loop was
 * monopolised). worker_threads gives the heavy work its own thread + event
 * loop while the main thread keeps serving HTTP, WS, and the gist-sync push.
 *
 * The worker opens its own readonly better-sqlite3 connection. better-sqlite3
 * is a native module and each connection is per-thread; sharing the parent's
 * Database handle would deadlock. WAL mode (set in db/schema.ts) allows our
 * readonly read to coexist with the parent's writers without blocking either.
 */

import { parentPort, workerData } from 'worker_threads';
import Database from 'better-sqlite3';
import { computeFilterV2Data } from './filter-v2-data';
import { computePricePathData } from './price-path-data';
import { renderPricePathHtml } from '../utils/html-renderer';

interface WorkerInput {
  dbPath: string;
}

async function main(): Promise<void> {
  if (!parentPort) {
    throw new Error('heavy-cache-worker: parentPort is null — not running as worker_thread');
  }
  const { dbPath } = workerData as WorkerInput;

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    // busy_timeout: if a writer is mid-transaction, wait up to 30s instead of
    // throwing SQLITE_BUSY. WAL means most reads bypass the write lock anyway.
    db.pragma('busy_timeout = 30000');

    const v2 = await computeFilterV2Data(db);
    const pricePathDetail = computePricePathData(db);
    const pricePathHtml = renderPricePathHtml(db);

    parentPort.postMessage({
      ok: true,
      v2,
      pricePathDetail,
      pricePathHtml,
    });
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore — process is exiting anyway */ }
    }
  }
}

main();
