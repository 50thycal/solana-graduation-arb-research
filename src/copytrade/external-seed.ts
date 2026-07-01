import Database from 'better-sqlite3';
import { upsertCandidate, countCandidates } from './queries';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('external-seed');

/**
 * External top-trader seed (Idea 3). Pulls a candidate list of hot wallet
 * addresses from Solana Tracker's top-PnL leaderboard and registers them as
 * scoring candidates (source='external'). This is a CANDIDATE FEED only — we
 * never trust their PnL; every wallet still goes through our own FIFO scorer +
 * money-edge + copyability gates like any other. Its only job is to surface
 * wallets outside our own on-chain universe.
 *
 * Cost: it's a plain HTTPS call to Solana Tracker (NOT Helius), so it doesn't
 * touch the RPC/credit budget. Free tier = 2,500 requests; we call ~6x/day.
 *
 * Crowding caveat: publicly-listed top traders are the most-copied and therefore
 * most alpha-decayed. We bias toward recency (short `days` window) to reduce that,
 * and the whole point of the quarantined A/B strategy (copy-external-*) is to
 * measure empirically whether these copy-trade better than our OG/live-tape
 * wallets — the honest prior is they may be worse.
 *
 * Config (all env): SOLANATRACKER_API_KEY (required — disabled without it),
 * SOLANATRACKER_DAYS (default 7 — recency window), SOLANATRACKER_LIMIT (default
 * 100), SOLANATRACKER_BASE_URL (override), EXTERNAL_SEED_DISABLED (kill switch).
 */

const STATUS_KEY = 'external_seed_status';
const DEFAULT_BASE = 'https://data.solanatracker.io';

function intEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Fetch top trader wallet addresses from Solana Tracker's PnL leaderboard.
 * Returns [] (never throws) if disabled, no key, network/HTTP error, or an
 * unrecognized response shape — so a bad fetch can never break the worker tick.
 */
export async function fetchExternalTopTraders(): Promise<string[]> {
  const key = process.env.SOLANATRACKER_API_KEY;
  if (!key) return [];
  const base = process.env.SOLANATRACKER_BASE_URL || DEFAULT_BASE;
  const days = intEnv('SOLANATRACKER_DAYS', 7);
  const limit = intEnv('SOLANATRACKER_LIMIT', 100);
  const url = `${base}/v2/pnl/leaderboard/top?days=${days}&limit=${limit}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'x-api-key': key }, signal: ctrl.signal });
  } catch (err) {
    logger.warn('external fetch failed: %s', err instanceof Error ? err.message : String(err));
    return [];
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    logger.warn('external API returned %d', res.status);
    return [];
  }
  let body: unknown;
  try { body = await res.json(); } catch { return []; }

  // Defensive shape handling — accept an array, or a wrapper under a few common
  // keys, and pull the address from whichever field carries it.
  const items: unknown[] = Array.isArray(body)
    ? body
    : ((body as Record<string, unknown>)?.data as unknown[])
      ?? ((body as Record<string, unknown>)?.traders as unknown[])
      ?? ((body as Record<string, unknown>)?.leaderboard as unknown[])
      ?? ((body as Record<string, unknown>)?.results as unknown[])
      ?? [];
  const addrs = new Set<string>();
  for (const it of items) {
    const o = it as Record<string, unknown>;
    const a = (typeof it === 'string' ? it : (o?.wallet ?? o?.address ?? o?.owner ?? o?.trader)) as unknown;
    // base58 Solana addresses are ~32-44 chars; the scorer's PublicKey parse is
    // the real validator, this just filters obvious non-addresses.
    if (typeof a === 'string' && a.length >= 32 && a.length <= 44) addrs.add(a);
  }
  return [...addrs];
}

/** Fetch the external leaderboard and register the wallets as scoring candidates
 *  (source='external'). Returns the number of NEW candidates added. */
export async function seedExternalCandidates(
  db: Database.Database,
  now: number = Math.floor(Date.now() / 1000),
): Promise<number> {
  if (process.env.EXTERNAL_SEED_DISABLED === 'true') return 0;
  if (!process.env.SOLANATRACKER_API_KEY) return 0;

  const addrs = await fetchExternalTopTraders();
  const before = countCandidates(db);
  if (addrs.length > 0) {
    const tx = db.transaction(() => {
      for (const a of addrs) upsertCandidate(db, a, 'external', now);
    });
    tx();
  }
  const added = countCandidates(db) - before;

  try {
    db.prepare(`
      INSERT INTO bot_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(STATUS_KEY, JSON.stringify({ last_fetched: addrs.length, last_added: added, updated_at: Date.now() }));
  } catch { /* non-fatal */ }

  logger.info('External seed: fetched %d addresses, +%d new candidates', addrs.length, added);
  return added;
}

export interface ExternalSeedSummary {
  configured: boolean;
  last_fetched: number | null;
  updated_at: number | null;
  total_candidates: number;   // source='external'
  scored: number;
  external_smart: number;     // passing money-edge gate (tradeable-quality)
  top: Array<{ address: string; n_round_trips: number; total_realized_sol: number; is_smart: boolean }>;
}

/** Read-only funnel summary for the /copy-trades page. Cheap SQL. */
export function getExternalSeedSummary(db: Database.Database): ExternalSeedSummary {
  const out: ExternalSeedSummary = {
    configured: !!process.env.SOLANATRACKER_API_KEY,
    last_fetched: null, updated_at: null,
    total_candidates: 0, scored: 0, external_smart: 0, top: [],
  };
  try {
    const s = db.prepare(`SELECT value FROM bot_settings WHERE key = ?`).get(STATUS_KEY) as { value: string } | undefined;
    if (s) { const j = JSON.parse(s.value); out.last_fetched = j.last_fetched ?? null; out.updated_at = j.updated_at ?? null; }
  } catch { /* ignore */ }
  try {
    out.total_candidates = (db.prepare(`SELECT COUNT(*) c FROM wallet_candidates WHERE source='external'`).get() as { c: number }).c ?? 0;
    const sc = db.prepare(`
      SELECT COUNT(*) scored,
        SUM(CASE WHEN ws.total_realized_sol_drop_top3 > 0 AND ws.monthly_run_rate_sol >= 3.75 AND ws.total_realized_sol >= 0.5 THEN 1 ELSE 0 END) smart
      FROM wallet_candidates wc JOIN wallet_scores ws ON ws.address = wc.address
      WHERE wc.source='external'
    `).get() as { scored: number | null; smart: number | null };
    out.scored = sc.scored ?? 0;
    out.external_smart = sc.smart ?? 0;
    out.top = (db.prepare(`
      SELECT wc.address, ws.n_round_trips, ws.total_realized_sol,
             (ws.total_realized_sol_drop_top3 > 0 AND ws.monthly_run_rate_sol >= 3.75 AND ws.total_realized_sol >= 0.5) is_smart
      FROM wallet_candidates wc JOIN wallet_scores ws ON ws.address = wc.address
      WHERE wc.source='external'
      ORDER BY ws.total_realized_sol DESC LIMIT 15
    `).all() as Array<Record<string, number>>).map((r) => ({
      address: r.address as unknown as string,
      n_round_trips: r.n_round_trips, total_realized_sol: +(+r.total_realized_sol).toFixed(3),
      is_smart: !!r.is_smart,
    }));
  } catch { /* tables absent */ }
  return out;
}
