/**
 * src/utils/event-loop-lag-monitor.ts
 *
 * Continuous event-loop lag sampler. Schedules a setTimeout at a fixed cadence
 * and measures how late each firing actually arrives. Healthy node event loop
 * shows lag of 0-10 ms; sustained 100+ ms means the loop is being blocked by
 * synchronous CPU or sync I/O (better-sqlite3 prepare/run, JSON.parse on huge
 * blobs, etc.). 1000+ ms means a single hot-path step is monopolizing the loop
 * for a full second — at that level, setTimeout-driven snapshot/deadline timers
 * in the price collector start drifting and observations time out.
 *
 * Singleton pattern: one monitor per process. Auto-starts on first access.
 * Stats are exposed via getStats() for inclusion in snapshot.json /
 * pipeline_health so the operator can see loop health without live log access.
 *
 * Added 2026-05-04 to confirm/quantify the gist-sync synchronous compute
 * blocking hypothesis (24s timer drift observed on T+30 deadline timers).
 */

const SAMPLE_INTERVAL_MS = 1000;
const RING_BUFFER_MAX = 600; // 10 minutes of 1Hz samples

class EventLoopLagMonitor {
  private samples: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastTickAt: number = 0;
  // Worst single sample observed since boot. The ring buffer drops old samples
  // every 10 min; this preserves the all-time max so a one-off 30s freeze
  // still shows up hours later.
  private allTimeMaxLagMs: number = 0;

  start(): void {
    if (this.timer) return;
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      // expected delta = SAMPLE_INTERVAL_MS; anything over that is loop lag.
      const lagMs = Math.max(0, (now - this.lastTickAt) - SAMPLE_INTERVAL_MS);
      this.lastTickAt = now;
      this.samples.push(lagMs);
      if (this.samples.length > RING_BUFFER_MAX) this.samples.shift();
      if (lagMs > this.allTimeMaxLagMs) this.allTimeMaxLagMs = lagMs;
    }, SAMPLE_INTERVAL_MS);
    // Don't keep the process alive just for this monitor.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStats(): {
    n_samples: number;
    window_minutes: number;
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
    max_ms_in_window: number;
    mean_ms: number;
    pct_over_100ms: number;
    pct_over_1000ms: number;
    all_time_max_lag_ms: number;
  } | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const n = sorted.length;
    const pct = (p: number) => sorted[Math.min(Math.floor((p / 100) * n), n - 1)];
    const overN = (threshold: number) => sorted.filter((s) => s > threshold).length;
    return {
      n_samples: n,
      window_minutes: +(n * SAMPLE_INTERVAL_MS / 60000).toFixed(1),
      p50_ms: pct(50),
      p95_ms: pct(95),
      p99_ms: pct(99),
      max_ms_in_window: sorted[n - 1],
      mean_ms: Math.round(sorted.reduce((a, b) => a + b, 0) / n),
      pct_over_100ms: +((overN(100) / n) * 100).toFixed(1),
      pct_over_1000ms: +((overN(1000) / n) * 100).toFixed(1),
      all_time_max_lag_ms: this.allTimeMaxLagMs,
    };
  }
}

const singleton = new EventLoopLagMonitor();

/** Start the singleton monitor. Idempotent. Call once at process boot. */
export function startEventLoopLagMonitor(): void {
  singleton.start();
}

/** Snapshot of lag stats over the rolling 10-min window plus all-time max. */
export function getEventLoopLagStats(): ReturnType<EventLoopLagMonitor['getStats']> {
  return singleton.getStats();
}
