import pino, { Logger } from 'pino';
import { logBuffer, makeBufferStream } from './log-buffer';

/**
 * Per-logger level factory.
 *
 * Reads LOG_LEVEL from env once at module load:
 *   - unset / any standard pino level ('debug', 'info', 'warn', 'error', etc.):
 *       every logger uses that level. Original behavior.
 *   - 'trade': trade-focused filter — only logs relevant to debugging the
 *       trading extension pass through. Data-collection chatter is silenced
 *       by raising non-trading loggers to 'warn' so errors/warnings still
 *       surface but routine info is hidden.
 *
 * The 'trade' policy is specifically tuned for debugging paper/live trades:
 *   - Trading modules (src/trading/*) → 'debug'
 *     Shows every trade event including 'Trade entry fill recorded',
 *     'Trade skipped', 'Position added', 'Position exit triggered', 'Trade
 *     opened', 'Trade closed', and 'TradingEngine initializing'.
 *   - main → 'info'
 *     Shows engine init, shutdown, and 'TradingEngine Connection refreshed
 *     after listener reconnect' (critical for verifying the reconnect fix).
 *   - graduation-listener → 'info'
 *     Shows 'Graduation detected', reconnect sequence, and inline vault
 *     extraction results — essential context for why a trade fired or not.
 *   - Everything else (price-collector, pool-tracker, holder-enrichment,
 *     competition-detector, rpc-limiter, momentum-labeler, db-schema) → 'warn'
 *     Silences routine info (momentum checkpoints, RPC throttling) but keeps
 *     warnings and errors so root causes of trade failures remain visible.
 *
 * Example — show only trade-relevant logs:
 *   LOG_LEVEL=trade npm start
 */

const RAW_LEVEL = process.env.LOG_LEVEL ?? 'info';
const TRADE_MODE = RAW_LEVEL === 'trade';

/**
 * Per-name level overrides applied only when LOG_LEVEL=trade.
 * Any name not listed falls through to DEFAULT_TRADE_MODE_LEVEL.
 */
const TRADE_MODE_LEVELS: Record<string, string> = {
  // Trading modules — full verbosity
  'trading-engine':   'debug',
  'trade-evaluator':  'debug',
  'position-manager': 'debug',
  'trading-executor': 'debug',
  'trade-logger':     'debug',
  'trading-config':   'debug',

  // Harness + listener — keep startup, shutdown, reconnect, graduation-detected
  'main':                'info',
  'graduation-listener': 'info',
};

/** Fallback for any logger name not in TRADE_MODE_LEVELS when in trade mode. */
const DEFAULT_TRADE_MODE_LEVEL = 'warn';

/**
 * Fan out every log line to both stdout (Railway captures) and the in-process
 * ring buffer (serves /api/logs). Level filtering is done per-logger below,
 * so the multistream always receives everything; each stream decides what
 * to drop via its own minimum level.
 */
const bufferStream = makeBufferStream(logBuffer);
const multiStream = pino.multistream([
  { stream: process.stdout },
  { stream: bufferStream as unknown as NodeJS.WritableStream, level: 'trace' },
]);

/**
 * Build a pino logger whose level respects the LOG_LEVEL env var, with
 * special handling for the 'trade' sentinel value.
 */
export function makeLogger(name: string): Logger {
  const level = TRADE_MODE
    ? (TRADE_MODE_LEVELS[name] ?? DEFAULT_TRADE_MODE_LEVEL)
    : RAW_LEVEL;
  return pino({ level, name }, multiStream);
}

/** Shared log buffer singleton — re-exported for convenience. */
export { logBuffer };
