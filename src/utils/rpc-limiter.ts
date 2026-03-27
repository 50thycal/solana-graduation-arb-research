import pino from 'pino';

const logger = pino({ name: 'rpc-limiter' });

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

  /** Call before every critical RPC request. Always waits for a token. */
  async throttle(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens--;
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
      this.queue.push(resolve);
      if (!this.processingQueue) {
        this.processQueue();
      }
    });
  }

  /**
   * High-priority version of throttle — jumps to the front of the queue.
   * Use for graduation detection and pool matching where latency matters.
   */
  async throttlePriority(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens--;
      return;
    }

    this.totalThrottled++;
    return new Promise<void>((resolve) => {
      this.queue.unshift(resolve); // front of queue
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
  async throttleOrDrop(maxQueue = 10): Promise<boolean> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens--;
      return true;
    }

    if (this.queue.length >= maxQueue) {
      this.totalDropped++;
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
      this.queue.push(() => resolve(true));
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

  getStats() {
    return {
      tokensAvailable: Math.floor(this.tokens),
      queued: this.queue.length,
      totalThrottled: this.totalThrottled,
      totalDropped: this.totalDropped,
    };
  }
}

// Singleton — shared across all components hitting the same Helius endpoint
export const globalRpcLimiter = new RpcLimiter(
  parseInt(process.env.RPC_REQUESTS_PER_SECOND || '8', 10)
);
