/**
 * src/api/gist-sync-worker.ts
 *
 * Per-cycle worker-thread entry that runs the heaviest two synchronous
 * computes of every gist-sync cycle off the main event loop:
 *   - computeBestCombos       (~25-45s wall-clock on the current dataset)
 *   - computeCounterfactual   (~3-5s)
 *
 * Why: even with the per-iteration yields in aggregates.ts, these runs
 * accumulate ~46s of wall-clock work that monopolizes the main thread in
 * 130ms chunks 350+ times per cycle. That's enough for an unlucky
 * graduation to land its T+30 deadline timer past the 15s margin and get
 * torn down. Moving them off-thread eliminates the regular gist-sync
 * lag spikes entirely.
 *
 * Spawned fresh by gist-sync.ts on every cycle (~every 2 min). Spawn
 * overhead is ~50-200ms — lost in the noise vs the ~30s of work
 * it offloads. Falls back to in-process if the worker file isn't
 * resolvable (dev mode, ts-node, missing dist build).
 *
 * Mirrors the heavy-cache-worker.ts pattern: opens its own readonly
 * better-sqlite3 connection (native module, per-thread), busy_timeout
 * 30s, returns serialized JSON via parentPort.postMessage.
 */

import { parentPort, workerData } from 'worker_threads';
import Database from 'better-sqlite3';
import { computeBestCombos } from './aggregates';
import { computeCounterfactual } from './counterfactual';

interface WorkerInput {
  dbPath: string;
  bestCombos: { min_n?: number; top?: number; include_pairs?: boolean };
}

async function main(): Promise<void> {
  if (!parentPort) {
    throw new Error('gist-sync-worker: parentPort is null — not running as worker_thread');
  }
  const { dbPath, bestCombos: bcOpts } = workerData as WorkerInput;

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 30000');

    // Order: bestCombos first (the slow one), then counterfactual. Both are
    // independent — could be parallelized within the worker, but native better-
    // sqlite3 is single-threaded per connection and parallel queries against the
    // same handle serialize anyway. Sequential is simpler and the wall-clock is
    // bounded by computeBestCombos regardless.
    const bestCombosT0 = Date.now();
    const bestCombosFull = await computeBestCombos(db, bcOpts);
    const bestCombosMs = Date.now() - bestCombosT0;

    const cfT0 = Date.now();
    const counterfactual = await computeCounterfactual(db);
    const counterfactualMs = Date.now() - cfT0;

    parentPort.postMessage({
      ok: true,
      bestCombosFull,
      counterfactual,
      timings: { bestCombosMs, counterfactualMs },
    });
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore — process is exiting */ }
    }
  }
}

main();
