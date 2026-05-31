import type Database from 'better-sqlite3';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('launch-counter');

const HOUR_SEC = 3600;
const FLUSH_INTERVAL_MS = 60_000;        // persist in-memory deltas once a minute
// Dedup window — Helius redelivers the same tx 4-5× on the firehose (see the
// seenSignatures comment in graduation-listener). 10 min comfortably covers a
// redelivery burst while keeping the seen-set small (~creates/min × 10).
const DEDUP_TTL_MS = 10 * 60_000;

/**
 * Universe-level token-launch counter.
 *
 * pump.fun emits an anchor `Instruction: Create` log for every new token mint.
 * Those events already arrive on the Helius `onLogs(PUMP_FUN_PROGRAM_ID)`
 * firehose we subscribe to for graduations — we just ignore them today. This
 * counter taps that same stream (no extra RPC, one string scan we already do)
 * and rolls the count into hourly buckets in `token_launches`.
 *
 * Launch rate is a genuinely LEADING regime signal: it reflects froth / risk
 * appetite the moment tokens are minted, with no dependence on T+300 outcomes
 * the way pump_rate / fast_rug_rate do. regime-analysis reads `token_launches`
 * and runs it through the same lag-correlation harness to test whether it leads
 * live PnL.
 *
 * Counting is deduped by signature so Helius redeliveries don't inflate the
 * rate; the additive upsert in flush() is therefore safe.
 */
export class LaunchCounter {
  private counts = new Map<number, number>();   // hourBucketSec -> unflushed delta
  private seen = new Map<string, number>();      // signature -> first-seen ms
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly upsert: Database.Statement;

  constructor(private db: Database.Database) {
    this.upsert = db.prepare(`
      INSERT INTO token_launches (bucket_start, launch_count, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(bucket_start) DO UPDATE SET
        launch_count = launch_count + excluded.launch_count,
        updated_at   = excluded.updated_at
    `);
  }

  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    // Don't keep the process alive solely for the flush timer.
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
    logger.info('Launch counter started (flush every %ds)', FLUSH_INTERVAL_MS / 1000);
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush(); // persist whatever's buffered
  }

  /**
   * Record a token-creation event. Deduped by signature to absorb Helius
   * redeliveries. Safe to call on the hot firehose path — pure in-memory.
   */
  record(signature: string, eventTimeMs: number = Date.now()): void {
    if (this.seen.has(signature)) return;
    this.seen.set(signature, eventTimeMs);
    const bucket = Math.floor(eventTimeMs / 1000 / HOUR_SEC) * HOUR_SEC;
    this.counts.set(bucket, (this.counts.get(bucket) ?? 0) + 1);
  }

  private prune(nowMs: number): void {
    for (const [sig, ts] of this.seen) {
      if (nowMs - ts > DEDUP_TTL_MS) this.seen.delete(sig);
    }
  }

  private flush(): void {
    const now = Date.now();
    this.prune(now);
    if (this.counts.size === 0) return;
    const entries = [...this.counts.entries()];
    try {
      const tx = this.db.transaction(() => {
        for (const [bucket, delta] of entries) this.upsert.run(bucket, delta, now);
      });
      tx();
      this.counts.clear(); // only clear once the write committed
    } catch (err) {
      // Keep the deltas buffered for the next tick rather than dropping them.
      logger.warn('Launch-count flush failed, will retry: %s',
        err instanceof Error ? err.message : String(err));
    }
  }
}
