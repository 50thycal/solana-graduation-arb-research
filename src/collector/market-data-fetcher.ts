import type Database from 'better-sqlite3';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('market-data-fetcher');

/**
 * Daily-cadence external market data fetcher. Populates `market_daily` with
 * SOL/USD + BTC/USD OHLC (CoinGecko) + Fear & Greed Index (alternative.me).
 * Backs the trends-market panel.
 *
 * On start: backfills BACKFILL_DAYS if the table has fewer rows. Then refreshes
 * once per FETCH_INTERVAL_MS, upserting today's row (and the prior day if
 * still null — CoinGecko's daily OHLC for the current day can lag).
 *
 * Free-tier endpoints, no API key required. CoinGecko's free tier limits are
 * ~10-30 rpm — this fetcher uses ~3 requests per cycle (SOL OHLC, BTC OHLC,
 * F&G), well below the limit.
 *
 * Failure behaviour: any fetch error logs a warning and is retried on the
 * next interval. The bot never crashes on market-data failure — the trends-
 * market panel will simply have stale or missing rows, which it surfaces.
 */

const FETCH_INTERVAL_MS = 60 * 60 * 1000;          // 1 hour
const BACKFILL_DAYS = 60;
const COINGECKO_OHLC = (id: string, days: number) =>
  `https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=${days}`;
const FEAR_GREED = (limit: number) =>
  `https://api.alternative.me/fng/?limit=${limit}`;
const REQUEST_TIMEOUT_MS = 15_000;

interface OhlcCandle {
  date: string;        // 'YYYY-MM-DD' UTC
  open: number;
  high: number;
  low: number;
  close: number;
}

interface FearGreedRow {
  date: string;        // 'YYYY-MM-DD' UTC
  value: number;
  label: string;
}

export interface MarketDataFetcherStatus {
  /** Unix seconds of the last fetch attempt (success or failure). */
  last_attempt_at: number | null;
  /** Unix seconds of the last successful upsert. */
  last_success_at: number | null;
  /** Last error message, or null if last attempt succeeded. */
  last_error: string | null;
  /** Whether the initial backfill has completed at least once. */
  backfill_done: boolean;
  /** Configured hourly cadence, in ms. */
  interval_ms: number;
}

export class MarketDataFetcher {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastAttemptAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastError: string | null = null;
  private backfillDone = false;

  constructor(private db: Database.Database) {}

  getStatus(): MarketDataFetcherStatus {
    return {
      last_attempt_at: this.lastAttemptAt,
      last_success_at: this.lastSuccessAt,
      last_error: this.lastError,
      backfill_done: this.backfillDone,
      interval_ms: FETCH_INTERVAL_MS,
    };
  }

  async start(): Promise<void> {
    const existingCount = (this.db.prepare(`SELECT COUNT(*) AS n FROM market_daily`).get() as { n: number }).n;
    const needsBackfill = existingCount < BACKFILL_DAYS;
    this.lastAttemptAt = Math.floor(Date.now() / 1000);
    if (needsBackfill) {
      logger.info({ existing: existingCount, target: BACKFILL_DAYS }, 'Market data backfill starting');
      try {
        await this.backfill(BACKFILL_DAYS);
        this.lastSuccessAt = Math.floor(Date.now() / 1000);
        this.lastError = null;
        this.backfillDone = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = `backfill: ${msg}`;
        logger.warn({ err: msg }, 'Market data backfill failed (will retry next cycle)');
      }
    } else {
      this.backfillDone = true;
      logger.info({ existing: existingCount }, 'Market data already backfilled');
      try {
        await this.fetchOnce();
        this.lastSuccessAt = Math.floor(Date.now() / 1000);
        this.lastError = null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = `fetch: ${msg}`;
        logger.warn({ err: msg }, 'Initial market data refresh failed');
      }
    }
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      this.lastAttemptAt = Math.floor(Date.now() / 1000);
      try {
        await this.fetchOnce();
        this.lastSuccessAt = Math.floor(Date.now() / 1000);
        this.lastError = null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = `fetch: ${msg}`;
        logger.warn({ err: msg }, 'Market data refresh failed (will retry next cycle)');
      } finally {
        this.scheduleNext();
      }
    }, FETCH_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Refresh the most recent 3 days (handles CG daily-OHLC lag for today). */
  private async fetchOnce(): Promise<void> {
    const [solOhlc, btcOhlc, fng] = await Promise.all([
      this.fetchOhlc('solana', 7),
      this.fetchOhlc('bitcoin', 7),
      this.fetchFearGreed(7),
    ]);
    this.upsertCandles(solOhlc, btcOhlc, fng);
    logger.debug({ sol_n: solOhlc.length, btc_n: btcOhlc.length, fng_n: fng.length }, 'Market data refresh complete');
  }

  private async backfill(days: number): Promise<void> {
    // CoinGecko OHLC `days` param: 1, 7, 14, 30, 90, 180, 365 (daily granularity
    // is auto for days >=2). Pick the smallest value covering our window.
    const cgDays = days <= 7 ? 7 : days <= 14 ? 14 : days <= 30 ? 30 : days <= 90 ? 90 : 180;
    const [solOhlc, btcOhlc, fng] = await Promise.all([
      this.fetchOhlc('solana', cgDays),
      this.fetchOhlc('bitcoin', cgDays),
      this.fetchFearGreed(days),
    ]);
    this.upsertCandles(solOhlc, btcOhlc, fng);
    logger.info({ sol_n: solOhlc.length, btc_n: btcOhlc.length, fng_n: fng.length }, 'Market data backfill complete');
  }

  private async fetchOhlc(coinId: string, days: number): Promise<OhlcCandle[]> {
    const url = COINGECKO_OHLC(coinId, days);
    const json = await this.fetchJson<Array<[number, number, number, number, number]>>(url);
    // CoinGecko returns [[timestamp_ms, open, high, low, close], ...] in 4h
    // candles for days <= 30, daily for days > 30. We need daily — aggregate
    // by UTC date.
    const byDate = new Map<string, OhlcCandle>();
    for (const row of json) {
      const [tsMs, o, h, l, c] = row;
      const date = new Date(tsMs).toISOString().slice(0, 10);
      const cur = byDate.get(date);
      if (!cur) {
        byDate.set(date, { date, open: o, high: h, low: l, close: c });
      } else {
        // first candle of the day keeps open; ongoing keeps last close + high/low.
        cur.high = Math.max(cur.high, h);
        cur.low = Math.min(cur.low, l);
        cur.close = c;
      }
    }
    return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  private async fetchFearGreed(limit: number): Promise<FearGreedRow[]> {
    const url = FEAR_GREED(limit);
    const json = await this.fetchJson<{ data: Array<{ value: string; value_classification: string; timestamp: string }> }>(url);
    return json.data
      .map(r => ({
        date: new Date(Number(r.timestamp) * 1000).toISOString().slice(0, 10),
        value: Number(r.value),
        label: r.value_classification,
      }))
      .filter(r => Number.isFinite(r.value));
  }

  private upsertCandles(sol: OhlcCandle[], btc: OhlcCandle[], fng: FearGreedRow[]): void {
    const solByDate = new Map(sol.map(c => [c.date, c]));
    const btcByDate = new Map(btc.map(c => [c.date, c]));
    const fngByDate = new Map(fng.map(c => [c.date, c]));

    const allDates = new Set<string>([...solByDate.keys(), ...btcByDate.keys(), ...fngByDate.keys()]);
    const now = Math.floor(Date.now() / 1000);

    const upsert = this.db.prepare(`
      INSERT INTO market_daily (
        date, sol_usd_open, sol_usd_high, sol_usd_low, sol_usd_close,
        btc_usd_open, btc_usd_high, btc_usd_low, btc_usd_close,
        fear_greed_value, fear_greed_label, fetched_at
      ) VALUES (
        @date, @sol_o, @sol_h, @sol_l, @sol_c,
        @btc_o, @btc_h, @btc_l, @btc_c,
        @fg_v, @fg_l, @fetched_at
      )
      ON CONFLICT(date) DO UPDATE SET
        sol_usd_open = COALESCE(excluded.sol_usd_open, market_daily.sol_usd_open),
        sol_usd_high = COALESCE(excluded.sol_usd_high, market_daily.sol_usd_high),
        sol_usd_low = COALESCE(excluded.sol_usd_low, market_daily.sol_usd_low),
        sol_usd_close = COALESCE(excluded.sol_usd_close, market_daily.sol_usd_close),
        btc_usd_open = COALESCE(excluded.btc_usd_open, market_daily.btc_usd_open),
        btc_usd_high = COALESCE(excluded.btc_usd_high, market_daily.btc_usd_high),
        btc_usd_low = COALESCE(excluded.btc_usd_low, market_daily.btc_usd_low),
        btc_usd_close = COALESCE(excluded.btc_usd_close, market_daily.btc_usd_close),
        fear_greed_value = COALESCE(excluded.fear_greed_value, market_daily.fear_greed_value),
        fear_greed_label = COALESCE(excluded.fear_greed_label, market_daily.fear_greed_label),
        fetched_at = excluded.fetched_at
    `);

    const tx = this.db.transaction((rows: any[]) => {
      for (const row of rows) upsert.run(row);
    });

    const rows: any[] = [];
    for (const date of allDates) {
      const s = solByDate.get(date);
      const b = btcByDate.get(date);
      const f = fngByDate.get(date);
      rows.push({
        date,
        sol_o: s?.open ?? null, sol_h: s?.high ?? null, sol_l: s?.low ?? null, sol_c: s?.close ?? null,
        btc_o: b?.open ?? null, btc_h: b?.high ?? null, btc_l: b?.low ?? null, btc_c: b?.close ?? null,
        fg_v: f?.value ?? null, fg_l: f?.label ?? null,
        fetched_at: now,
      });
    }
    tx(rows);
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json', 'User-Agent': 'solana-graduation-arb-research' },
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText} from ${url}`);
      }
      return (await resp.json()) as T;
    } finally {
      clearTimeout(t);
    }
  }
}
