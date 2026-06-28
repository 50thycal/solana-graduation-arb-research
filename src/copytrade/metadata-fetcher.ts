import Database from 'better-sqlite3';
import { makeLogger } from '../utils/logger';
import { globalRpcLimiter } from '../utils/rpc-limiter';

const logger = makeLogger('metadata-fetcher');

/**
 * TokenMetadataFetcher — out-of-band capture of token name/symbol/image/socials for the mints we
 * COPY, so we can later test the "no picture / no socials = rug-ish" hypothesis the on-chain
 * chart-features (liquidity/holders/dev%) miss.
 *
 * Design (RPC-safe, never on the hot copy path):
 *  - Scope = distinct mints in copy_trades not yet in token_metadata (bounded, small set).
 *  - Helius DAS `getAssetBatch` (1 RPC call per <=100 mints, droppable tier) → name/symbol/image/json_uri.
 *  - Best-effort fetch of json_uri (external HTTP) for twitter/telegram/website — pump.fun tokens put
 *    socials in the off-chain JSON, not the DAS content.metadata.
 *  - Upsert with precomputed has_image / has_socials flags so the rug analysis is a plain GROUP BY.
 *  - Metadata is immutable → cached per-mint forever; failures cached too (ok=0) so dead mints aren't
 *    re-hammered. Default-ON; COPYTRADE_META_DISABLED=true to stop.
 */
const DEFAULTS = {
  intervalMs: 10 * 60 * 1000, // re-scan for un-enriched traded mints every 10min
  firstRunDelayMs: 120 * 1000, // let boot settle before any RPC
  batchLimit: 60,             // mints enriched per tick (DAS batched <=100/call; socials fetched serially)
  dasChunk: 100,              // getAssetBatch max ids per call
  jsonTimeoutMs: 5000,
};

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface DasAsset {
  id: string;
  content?: {
    json_uri?: string;
    metadata?: { name?: string; symbol?: string; description?: string };
    links?: { image?: string; external_url?: string };
    files?: Array<{ uri?: string; cdn_uri?: string }>;
  };
}

interface MetaRow {
  mint: string;
  name: string | null;
  symbol: string | null;
  description: string | null;
  image_uri: string | null;
  json_uri: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  has_image: number;
  has_socials: number;
  ok: number;
  error: string | null;
}

export class TokenMetadataFetcher {
  private readonly db: Database.Database;
  private readonly rpcUrl: string | undefined;
  private readonly intervalMs: number;
  private readonly batchLimit: number;
  private firstRunTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private upsert: Database.Statement;

  constructor(opts: { db: Database.Database }) {
    this.db = opts.db;
    this.rpcUrl = process.env.HELIUS_RPC_URL;
    this.intervalMs = intEnv('COPYTRADE_META_INTERVAL_MS', DEFAULTS.intervalMs);
    this.batchLimit = intEnv('COPYTRADE_META_BATCH', DEFAULTS.batchLimit);
    this.upsert = this.db.prepare(`
      INSERT INTO token_metadata (mint, name, symbol, description, image_uri, json_uri, twitter, telegram, website, has_image, has_socials, ok, error, fetched_at)
      VALUES (@mint, @name, @symbol, @description, @image_uri, @json_uri, @twitter, @telegram, @website, @has_image, @has_socials, @ok, @error, unixepoch())
      ON CONFLICT(mint) DO UPDATE SET
        name=excluded.name, symbol=excluded.symbol, description=excluded.description, image_uri=excluded.image_uri,
        json_uri=excluded.json_uri, twitter=excluded.twitter, telegram=excluded.telegram, website=excluded.website,
        has_image=excluded.has_image, has_socials=excluded.has_socials, ok=excluded.ok, error=excluded.error, fetched_at=unixepoch()
    `);
  }

  start(): void {
    if (process.env.COPYTRADE_META_DISABLED === 'true') {
      logger.info('TokenMetadataFetcher disabled via COPYTRADE_META_DISABLED=true');
      return;
    }
    if (!this.rpcUrl) {
      logger.warn('TokenMetadataFetcher: no HELIUS_RPC_URL — metadata capture disabled');
      return;
    }
    this.firstRunTimer = setTimeout(() => {
      this.runOnce().catch((err) => logger.error({ err }, 'metadata first run failed'));
      this.interval = setInterval(() => {
        this.runOnce().catch((err) => logger.error({ err }, 'metadata run failed'));
      }, this.intervalMs);
    }, DEFAULTS.firstRunDelayMs);
    logger.info('TokenMetadataFetcher started (intervalMs=%d, batch=%d)', this.intervalMs, this.batchLimit);
  }

  stop(): void {
    if (this.firstRunTimer) { clearTimeout(this.firstRunTimer); this.firstRunTimer = null; }
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  /** Distinct copied mints with no metadata row yet. Pure SQL, no RPC. */
  private pendingMints(): string[] {
    try {
      const rows = this.db.prepare(`
        SELECT DISTINCT ct.mint AS mint FROM copy_trades ct
        LEFT JOIN token_metadata tm ON tm.mint = ct.mint
        WHERE tm.mint IS NULL
        LIMIT ?
      `).all(this.batchLimit) as Array<{ mint: string }>;
      return rows.map((r) => r.mint);
    } catch (err) {
      logger.warn('pendingMints query failed: %s', err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const mints = this.pendingMints();
      if (mints.length === 0) return;
      let enriched = 0;
      for (let i = 0; i < mints.length; i += DEFAULTS.dasChunk) {
        const chunk = mints.slice(i, i + DEFAULTS.dasChunk);
        const assets = await this.getAssetBatch(chunk);
        const byId = new Map(assets.map((a) => [a.id, a]));
        for (const mint of chunk) {
          const row = await this.buildRow(mint, byId.get(mint));
          this.upsert.run(row);
          enriched++;
        }
      }
      logger.info('TokenMetadataFetcher: enriched %d mints', enriched);
    } finally {
      this.running = false;
    }
  }

  /** Helius DAS getAssetBatch — one RPC call (droppable) for up to 100 mints. */
  private async getAssetBatch(ids: string[]): Promise<DasAsset[]> {
    if (!this.rpcUrl) return [];
    if (!(await globalRpcLimiter.throttleOrDrop(10, 'metadata'))) return [];
    try {
      const res = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'meta', method: 'getAssetBatch', params: { ids } }),
      });
      if (!res.ok) { logger.warn('getAssetBatch HTTP %d', res.status); return []; }
      const json = await res.json() as { result?: Array<DasAsset | null> };
      return (json.result ?? []).filter((a): a is DasAsset => a != null);
    } catch (err) {
      logger.warn('getAssetBatch failed: %s', err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  /** Build the metadata row: DAS fields + best-effort off-chain JSON for socials. */
  private async buildRow(mint: string, asset: DasAsset | undefined): Promise<MetaRow> {
    const base: MetaRow = {
      mint, name: null, symbol: null, description: null, image_uri: null, json_uri: null,
      twitter: null, telegram: null, website: null, has_image: 0, has_socials: 0, ok: 1, error: null,
    };
    if (!asset) { base.ok = 0; base.error = 'no_das_asset'; return base; }
    const c = asset.content ?? {};
    base.name = c.metadata?.name ?? null;
    base.symbol = c.metadata?.symbol ?? null;
    base.description = c.metadata?.description ?? null;
    base.image_uri = c.links?.image ?? c.files?.find((f) => f.uri || f.cdn_uri)?.cdn_uri ?? c.files?.[0]?.uri ?? null;
    base.json_uri = c.json_uri ?? null;
    base.website = c.links?.external_url ?? null;

    // pump.fun socials live in the off-chain JSON, not DAS content.metadata.
    if (base.json_uri) {
      const off = await this.fetchJson(base.json_uri);
      if (off) {
        base.twitter = pickStr(off, ['twitter', 'twitter_url', 'x']) ?? base.twitter;
        base.telegram = pickStr(off, ['telegram', 'telegram_url']) ?? base.telegram;
        base.website = pickStr(off, ['website', 'web']) ?? base.website;
        if (!base.image_uri) base.image_uri = pickStr(off, ['image', 'image_url']);
        if (!base.description) base.description = pickStr(off, ['description']);
      }
    }
    base.has_image = base.image_uri ? 1 : 0;
    base.has_socials = (base.twitter || base.telegram || base.website) ? 1 : 0;
    return base;
  }

  /** Fetch + parse the off-chain metadata JSON (ipfs:// → gateway). Best-effort, timed out. */
  private async fetchJson(uri: string): Promise<Record<string, unknown> | null> {
    const url = uri.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}` : uri;
    if (!/^https?:\/\//.test(url)) return null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), DEFAULTS.jsonTimeoutMs);
      const res = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
      if (!res.ok) return null;
      return await res.json() as Record<string, unknown>;
    } catch { return null; }
  }
}

/** First non-empty string value among the candidate keys (case-insensitive). */
function pickStr(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    for (const actual of Object.keys(obj)) {
      if (actual.toLowerCase() === k.toLowerCase()) {
        const v = obj[actual];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
  }
  return null;
}
