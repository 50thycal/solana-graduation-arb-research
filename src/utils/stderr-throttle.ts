/**
 * src/utils/stderr-throttle.ts
 *
 * Patches process.stderr.write to coalesce repeated noisy lines that come
 * from outside our logging pipeline. Specifically targets:
 *   - "ws error:" lines emitted by rpc-websockets (used internally by
 *     @solana/web3.js Connection) when the upstream socket flaps. These
 *     bypass our pino logger entirely, so they were flooding Railway logs
 *     during Helius outages.
 *
 * Strategy: keyed throttling. Each unique prefix (first ~60 chars) gets one
 * write per WINDOW_MS, plus a periodic summary line "[throttled] <prefix>:
 * <N> identical lines suppressed in last 30s". Non-matching writes pass
 * through untouched so real diagnostics are never lost.
 *
 * Install once during process boot (before Connection is created).
 */

const WINDOW_MS = 30_000;
const PREFIX_LEN = 60;

// Patterns that should be throttled. Match against the line's first chars.
const THROTTLE_PATTERNS: RegExp[] = [
  /^ws error/i,
  /^WebSocket error/i,
];

interface ThrottleState {
  lastEmittedAt: number;
  suppressed: number;
  fullLineSample: string;
}

const state = new Map<string, ThrottleState>();
let summaryTimer: NodeJS.Timeout | null = null;
let originalWrite: typeof process.stderr.write | null = null;

function flushSummaries(): void {
  const now = Date.now();
  for (const [key, s] of state.entries()) {
    if (s.suppressed > 0 && now - s.lastEmittedAt >= WINDOW_MS) {
      const summary = `[stderr-throttle] suppressed ${s.suppressed}× "${key}…" in last ${Math.round((now - s.lastEmittedAt) / 1000)}s\n`;
      if (originalWrite) originalWrite.call(process.stderr, summary);
      s.suppressed = 0;
      s.lastEmittedAt = now;
    }
    // Drop entries that have been quiet for >5 minutes to bound memory.
    if (s.suppressed === 0 && now - s.lastEmittedAt > 5 * 60_000) {
      state.delete(key);
    }
  }
}

export function installStderrThrottle(): void {
  if (originalWrite) return; // already installed
  originalWrite = process.stderr.write.bind(process.stderr);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = function patchedWrite(
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ): boolean {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const firstLine = text.split('\n', 1)[0] ?? '';

    let matched = false;
    for (const pat of THROTTLE_PATTERNS) {
      if (pat.test(firstLine)) { matched = true; break; }
    }

    if (!matched) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalWrite!.call(process.stderr, chunk as any, encodingOrCb as any, cb as any);
    }

    const key = firstLine.slice(0, PREFIX_LEN);
    const now = Date.now();
    const s = state.get(key) ?? { lastEmittedAt: 0, suppressed: 0, fullLineSample: firstLine };
    if (now - s.lastEmittedAt >= WINDOW_MS) {
      s.lastEmittedAt = now;
      s.fullLineSample = firstLine;
      state.set(key, s);
      // Let this one through.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalWrite!.call(process.stderr, chunk as any, encodingOrCb as any, cb as any);
    }
    // Suppress.
    s.suppressed += 1;
    state.set(key, s);
    if (typeof encodingOrCb === 'function') encodingOrCb();
    else if (typeof cb === 'function') cb();
    return true;
  };

  if (!summaryTimer) {
    summaryTimer = setInterval(flushSummaries, WINDOW_MS).unref();
  }
}
