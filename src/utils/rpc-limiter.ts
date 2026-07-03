import { makeLogger } from './logger';

const logger = makeLogger('rpc-limiter');

/** Served-call tiers — one per acquire method, so the snapshot shows WHICH
 *  caller class is driving demand, not just the aggregate:
 *   - wait     → throttle()                (critical reads; never drop)
 *   - priority → throttlePriority()        (graduation detection, pool match, T+30)
 *   - droppable→ throttleOrDrop()          (research/enrichment; first to drop)
 *   - copyHot  → throttleOrDropPriority()  (copy entries/exits/polls) */
type ServedTier = 'wait' | 'priority' | 'droppable' | 'copyHot';

/** Rolling throughput window. Second-resolution circular buffer so we can report
 *  calls/sec over the last 1m / 5m without storing a timestamp per call (which
 *  would balloon at high request rates). */
const RATE_WINDOW_SEC = 300;

/**
 * Token-bucket rate limiter for Helius RPC calls.
 * Prevents 429 errors by smoothing out burst request patterns across
 * the graduation listener, pool tracker, price collector, and competition detector.
 */
export class RpcLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRatePerMs: number;
  private queue: Array<() => void> = [];
  private processingQueue = false;
  private totalThrottled = 0;
  private totalDropped = 0;

  // --- throughput instrumentation (added 2026-06-20) ---
  // Every GRANTED token is counted once, whether served immediately (fast path)
  // or after queueing. Dropped requests are NOT counted in totalServed — they make
  // no RPC call and live in totalDropped / droppedByLabel. This is the demand meter
  // the limiter previously lacked: getStats() could show saturation (tokens=0,
  // queued>0) but never the actual calls/sec throughput by caller.
  private totalServed = 0;
  private servedByTier: Record<ServedTier, number> = {
    wait: 0, priority: 0, droppable: 0, copyHot: 0,
  };
  // Per-call-site breakdown (added 2026-06-20): served + dropped keyed by the
  // `label` each caller passes. The coarse tiers tell you droppable vs copyHot;
  // these tell you WHICH droppable caller (wallet_pnl vs swap_logger vs enrichment)
  // is actually eating the budget — so we cut the right thing, not blindly.
  private servedByLabel: Record<string, number> = {};
  private droppedByLabel: Record<string, number> = {};
  private readonly startSec = Math.floor(Date.now() / 1000);
  private rateBuckets = new Array<number>(RATE_WINDOW_SEC).fill(0);
  private rateHeadSec = Math.floor(Date.now() / 1000);
  private rateHeadIdx = 0;

  constructor(requestsPerSecond: number) {
    this.maxTokens = requestsPerSecond;
    this.tokens = requestsPerSecond;
    this.lastRefill = Date.now();
    this.refillRatePerMs = requestsPerSecond / 1000;
    logger.info({ requestsPerSecond }, 'RPC limiter initialized');
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRatePerMs);
    this.lastRefill = now;
  }

  /** Roll the circular rate buffer forward to `nowSec`, zeroing any seconds
   *  skipped since the last write so stale counts never bleed into a fresh
   *  window. Idempotent within the same second (delta <= 0 is a no-op). */
  private advanceRate(nowSec: number): void {
    const delta = nowSec - this.rateHeadSec;
    if (delta <= 0) return;
    if (delta >= this.rateBuckets.length) {
      this.rateBuckets.fill(0);
      this.rateHeadIdx = 0;
    } else {
      for (let i = 0; i < delta; i++) {
        this.rateHeadIdx = (this.rateHeadIdx + 1) % this.rateBuckets.length;
        this.rateBuckets[this.rateHeadIdx] = 0;
      }
    }
    this.rateHeadSec = nowSec;
  }

  /** Record one granted token against its tier, its caller label, and the rolling
   *  throughput meter. */
  private recordServed(tier: ServedTier, label: string): void {
    this.totalServed++;
    this.servedByTier[tier]++;
    this.servedByLabel[label] = (this.servedByLabel[label] ?? 0) + 1;
    this.advanceRate(Math.floor(Date.now() / 1000));
    this.rateBuckets[this.rateHeadIdx]++;
  }

  /** Record one dropped (skipped, no RPC call) request against its caller label. */
  private recordDropped(label: string): void {
    this.totalDropped++;
    this.droppedByLabel[label] = (this.droppedByLabel[label] ?? 0) + 1;
  }

  /** Mean calls/sec over the last `seconds`. While the buffer is still filling
   *  we divide by elapsed uptime (not the full window) so early-life rates
   *  aren't understated. */
  private rateOver(seconds: number): number {
    const nowSec = Math.floor(Date.now() / 1000);
    this.advanceRate(nowSec);
    const window = Math.min(seconds, this.rateBuckets.length);
    let sum = 0;
    for (let i = 0; i < window; i++) {
      const idx = (this.rateHeadIdx - i + this.rateBuckets.length) % this.rateBuckets.length;
      sum += this.rateBuckets[idx];
    }
    const elapsed = Math.max(1, Math.min(window, nowSec - this.startSec + 1));
    return +(sum / elapsed).toFixed(3);
  }

  /** Call before every critical RPC request. Always waits for a token. */
  async throttle(label = 'other'): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens--;
      this.recordServed('wait', label);
      return;
    }

    this.totalThrottled++;
    if (this.totalThrottled % 20 === 1) {
      logger.warn(
        { queued: this.queue.length + 1, totalThrottled: this.totalThrottled },
        'RPC rate limit reached, queuing request'
      );
    }

    return new Promise<void>((resolve) => {
      this.queue.push(() => { this.recordServed('wait', label); resolve(); });
      if (!this.processingQueue) {
        this.processQueue();
      }
    });
  }

  /**
   * High-priority version of throttle — jumps to the front of the queue.
   * Use for graduation detection and pool matching where latency matters.
   */
  async throttlePriority(label = 'other'): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens--;
      this.recordServed('priority', label);
      return;
    }

    this.totalThrottled++;
    return new Promise<void>((resolve) => {
      this.queue.unshift(() => { this.recordServed('priority', label); resolve(); }); // front of queue
      if (!this.processingQueue) {
        this.processQueue();
      }
    });
  }

  /**
   * For non-critical requests (e.g. price snapshots, competition detection).
   * Returns false immediately if the queue already has more than maxQueue entries,
   * signalling the caller to skip the request rather than pile onto the backlog.
   */
  async throttleOrDrop(maxQueue = 10, label = 'other'): Promise<boolean> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens--;
      this.recordServed('droppable', label);
      return true;
    }

    if (this.queue.length >= maxQueue) {
      this.recordDropped(label);
      if (this.totalDropped % 20 === 1) {
        logger.warn(
          { queued: this.queue.length, totalDropped: this.totalDropped },
          'RPC queue full, dropping non-critical request'
        );
      }
      return false;
    }

    this.totalThrottled++;
    return new Promise<boolean>((resolve) => {
      this.queue.push(() => { this.recordServed('droppable', label); resolve(true); });
      if (!this.processingQueue) {
        this.processQueue();
      }
    });
  }

  /**
   * Priority version of throttleOrDrop — jumps to the FRONT of the queue but
   * still refuses to pile onto a saturated backlog. Copy-trade hot path
   * (lead-buy/sell parsing, copy entries/exits, copy position polls): when the
   * bucket is contended, copy-trade calls win and the research/enrichment
   * callers using plain throttleOrDrop are the ones that drop.
   */
  async throttleOrDropPriority(maxQueue = 20, label = 'other'): Promise<boolean> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens--;
      this.recordServed('copyHot', label);
      return true;
    }

    if (this.queue.length >= maxQueue) {
      this.recordDropped(label);
      return false;
    }

    this.totalThrottled++;
    return new Promise<boolean>((resolve) => {
      this.queue.unshift(() => { this.recordServed('copyHot', label); resolve(true); });
      if (!this.processingQueue) {
        this.processQueue();
      }
    });
  }

  private processQueue(): void {
    this.processingQueue = true;
    const check = () => {
      this.refill();
      while (this.queue.length > 0 && this.tokens >= 1) {
        const resolve = this.queue.shift()!;
        this.tokens--;
        resolve();
      }
      if (this.queue.length > 0) {
        const msUntilToken = (1 - this.tokens) / this.refillRatePerMs;
        setTimeout(check, Math.max(Math.ceil(msUntilToken), 10));
      } else {
        this.processingQueue = false;
      }
    };
    const msUntilToken = (1 - this.tokens) / this.refillRatePerMs;
    setTimeout(check, Math.max(Math.ceil(msUntilToken), 10));
  }

  /** Sort a label→count map descending so the snapshot leads with the heaviest
   *  callers. Returned as a plain object (insertion order preserved in JSON). */
  private sortedLabels(m: Record<string, number>): Record<string, number> {
    return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
  }

  getStats() {
    // 5m rate is the most stable; reuse it for the daily projection so the two
    // figures can't disagree. projCallsPerDay is CALLS, not Helius credits —
    // most methods are ~1 credit but some (getProgramAccounts, DAS) cost more,
    // so treat it as a floor for the credit burn, not an exact figure.
    const callsPerSec5m = this.rateOver(300);
    return {
      tokensAvailable: Math.floor(this.tokens),
      queued: this.queue.length,
      maxTokens: this.maxTokens,
      totalThrottled: this.totalThrottled,
      totalDropped: this.totalDropped,
      totalServed: this.totalServed,
      servedByTier: { ...this.servedByTier },
      servedByLabel: this.sortedLabels(this.servedByLabel),
      droppedByLabel: this.sortedLabels(this.droppedByLabel),
      callsPerSec1m: this.rateOver(60),
      callsPerSec5m,
      projCallsPerDay: Math.round(callsPerSec5m * 86400),
      uptimeSec: Math.max(1, Math.floor(Date.now() / 1000) - this.startSec),
    };
  }
}

// Singleton — shared across all components hitting the same Helius endpoint.
// Default 10 rps ≈ 864k req/day hard ceiling (raised from 5 on 2026-07-03 to spend the
// added ~5M-credit budget on clearing the wallet-scoring backlog — only ~2.5k of ~71k
// candidates scored; scoring throughput was the bottleneck, and 5 rps capped it). Scoring
// runs on the droppable tier so copy entries/exits/polls (copyHot tier) still preempt it.
// Verify the Helius plan's own rps cap supports this; lower via RPC_REQUESTS_PER_SECOND if
// the plan resets to a tighter budget.
export const globalRpcLimiter = new RpcLimiter(
  parseInt(process.env.RPC_REQUESTS_PER_SECOND || '10', 10)
);
