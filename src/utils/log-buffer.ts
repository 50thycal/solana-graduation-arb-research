/**
 * src/utils/log-buffer.ts
 *
 * In-process ring buffer for Pino log lines so /api/logs can serve recent
 * log output without needing the Railway log dashboard. Pino writes NDJSON
 * to stdout; we attach a second stream via pino.multistream that parses each
 * line into a structured entry and appends to the ring.
 *
 * Cap: 5000 entries (~2 MB). Oldest entries are dropped when full.
 * Reset on redeploy — acceptable since "push code → check logs" happens
 * within a single process lifetime.
 */

export interface LogEntry {
  ts: number;            // epoch millis (from Pino's `time` field)
  level: string;         // 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  name: string;          // Pino logger name
  msg: string;           // Log message
  // Any additional bindings the caller passed (mint, graduationId, etc)
  // Stored as a shallow copy so we don't hold refs to large user objects.
  bindings?: Record<string, unknown>;
}

const PINO_LEVEL_LABELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

const DEFAULT_CAP = 5000;

export class LogBuffer {
  private entries: LogEntry[] = [];
  private idx = 0;
  private filled = false;

  constructor(private readonly cap: number = DEFAULT_CAP) {}

  /** Append an entry to the ring, overwriting the oldest when full. */
  push(entry: LogEntry): void {
    if (this.entries.length < this.cap) {
      this.entries.push(entry);
      return;
    }
    this.entries[this.idx] = entry;
    this.idx = (this.idx + 1) % this.cap;
    this.filled = true;
  }

  /** Return a snapshot of entries in chronological order (oldest first). */
  all(): LogEntry[] {
    if (!this.filled) return this.entries.slice();
    return this.entries.slice(this.idx).concat(this.entries.slice(0, this.idx));
  }

  query(opts: {
    level?: string;        // minimum level — returns entries at or above this severity
    since?: number;        // epoch millis; only entries with ts >= since
    limit?: number;        // max entries to return (default 500)
    grep?: string;         // substring match on msg (case-insensitive)
  } = {}): LogEntry[] {
    const limit = opts.limit ?? 500;
    const minLevel = opts.level ? levelRank(opts.level) : 0;
    const since = opts.since ?? 0;
    const needle = opts.grep ? opts.grep.toLowerCase() : null;

    const out: LogEntry[] = [];
    const all = this.all();
    // Iterate newest-first so we can early-stop once we hit the limit
    for (let i = all.length - 1; i >= 0; i--) {
      const e = all[i];
      if (e.ts < since) continue;
      if (levelRank(e.level) < minLevel) continue;
      if (needle !== null && !e.msg.toLowerCase().includes(needle)) continue;
      out.push(e);
      if (out.length >= limit) break;
    }
    // Return oldest-first within the window
    return out.reverse();
  }

  size(): number {
    return this.entries.length;
  }
}

function levelRank(level: string): number {
  switch (level) {
    case 'trace': return 10;
    case 'debug': return 20;
    case 'info':  return 30;
    case 'warn':  return 40;
    case 'error': return 50;
    case 'fatal': return 60;
    default: return 30;
  }
}

/**
 * Wrap a LogBuffer as a Pino-compatible destination stream.
 * Pino multistream passes each log line as an NDJSON string; we parse it,
 * pull out the standard fields, and append to the ring.
 *
 * Unknown / malformed lines are silently dropped — better to lose a log
 * line than to crash the logging subsystem.
 */
export function makeBufferStream(buffer: LogBuffer): { write: (chunk: string) => void } {
  return {
    write(chunk: string): void {
      // Pino sends one JSON object per write, already terminated with \n.
      // Strip the trailing newline and parse.
      const line = chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk;
      if (!line) return;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const levelRaw = obj.level;
      const level = typeof levelRaw === 'number'
        ? (PINO_LEVEL_LABELS[levelRaw] ?? 'info')
        : (typeof levelRaw === 'string' ? levelRaw : 'info');
      const ts = typeof obj.time === 'number' ? obj.time : Date.now();
      const name = typeof obj.name === 'string' ? obj.name : 'unknown';
      const msg = typeof obj.msg === 'string' ? obj.msg : '';
      // Strip the standard fields; keep the rest as bindings.
      const { level: _l, time: _t, name: _n, msg: _m, pid: _p, hostname: _h, ...rest } = obj;
      buffer.push({ ts, level, name, msg, bindings: Object.keys(rest).length > 0 ? rest : undefined });
    },
  };
}

/** Shared singleton used by the logger and the /api/logs route. */
export const logBuffer = new LogBuffer();
