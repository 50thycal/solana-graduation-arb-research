import Database from 'better-sqlite3';
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchVaultPrice } from '../trading/executor';
import { SIM_DEFAULT_COST_PCT } from '../api/sim-constants';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('copy-trader');

/**
 * Shadow copy-trader (Option B, Phase 2).
 *
 * When a followed ("smart") wallet buys a graduated token, each armed copy
 * strategy opens a SHADOW position (no real funds) at the current pool price —
 * which already reflects the lead wallet's market impact, since we detect ~1.1s
 * after their fill (see copy-probe). Positions are tracked until they exit via
 * the strategy's rule: take-profit / stop-loss / max-hold / or following the
 * lead wallet's sell. net P&L is modeled after the SIM round-trip cost.
 *
 * Crucially, the smart wallets hold for HOURS (~4-5h avg, not minutes — see
 * smart-money.json behavior), so strategies hold INDEFINITELY by default
 * (maxHoldSec=null) — a 5-min cap would exit before their thesis plays out.
 *
 * Self-contained on purpose: it does NOT use the live PositionManager /
 * trades_v2 path (too coupled to graduations). Pool/vaults are resolved from
 * graduations.new_pool_address (so only tokens we tracked are copyable — a
 * deliberate, expandable limitation). Default-on, shadow only;
 * COPY_TRADER_DISABLED=true to turn off.
 */

const POOL_BASE_VAULT_OFFSET = 139;   // matches PriceCollector / graduation-listener
const POOL_QUOTE_VAULT_OFFSET = 171;

export interface CopyStrategy {
  id: string;
  tpPct: number | null;       // null = no take-profit
  slPct: number | null;       // null = no stop-loss
  exitFollow: boolean;        // also exit when the lead wallet sells
  maxHoldSec: number | null;  // null = hold indefinitely (no time exit)
}

export const COPY_STRATEGIES: CopyStrategy[] = [
  { id: 'copy-followsell',        tpPct: null, slPct: null, exitFollow: true,  maxHoldSec: null }, // exits ONLY on lead sell
  { id: 'copy-tp50-sl20',         tpPct: 50,   slPct: 20,   exitFollow: false, maxHoldSec: null },
  { id: 'copy-tp100-sl30',        tpPct: 100,  slPct: 30,   exitFollow: false, maxHoldSec: null },
  { id: 'copy-tp200-sl40',        tpPct: 200,  slPct: 40,   exitFollow: false, maxHoldSec: null },
  { id: 'copy-tp100-sl50-follow', tpPct: 100,  slPct: 50,   exitFollow: true,  maxHoldSec: null }, // hybrid: TP/SL or lead sell
];

const COPY_SIZE_SOL = parseFloat(process.env.COPY_SIZE_SOL || '0.5');
const MAX_CONCURRENT_PER_STRATEGY = parseInt(process.env.COPY_MAX_CONCURRENT || '40', 10);
const POLL_INTERVAL_MS = parseInt(process.env.COPY_POLL_MS || '15000', 10);

interface OpenPos {
  id: number;
  strategyId: string;
  mint: string;
  pool: string;
  baseVault: string;
  quoteVault: string;
  entryPrice: number;
  sizeSol: number;
  tpPrice: number | null;
  slPrice: number | null;
  exitFollow: boolean;
  maxHoldSec: number | null;
  entryTs: number; // unix sec
}

interface PoolVaults { pool: string; baseVault: string; quoteVault: string; }

export class CopyTrader {
  private readonly db: Database.Database;
  private readonly getConnection: () => Connection | null;
  private positions = new Map<number, OpenPos>();
  private poolCache = new Map<string, PoolVaults | null>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private polling = false;
  private enabled = false;

  constructor(opts: { db: Database.Database; getConnection: () => Connection | null }) {
    this.db = opts.db;
    this.getConnection = opts.getConnection;
  }

  start(): void {
    if (process.env.COPY_TRADER_DISABLED === 'true') {
      logger.info('CopyTrader disabled via COPY_TRADER_DISABLED=true');
      return;
    }
    this.enabled = true;
    this.loadOpenPositions();
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => logger.warn('poll error: %s', err instanceof Error ? err.message : String(err)));
    }, POLL_INTERVAL_MS);
    logger.info(`CopyTrader started (shadow): ${COPY_STRATEGIES.length} strategies, size=${COPY_SIZE_SOL} SOL, resumed ${this.positions.size} open positions`);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  isEnabled(): boolean { return this.enabled; }

  /** Resume tracking open positions across restarts (vaults persisted on the row). */
  private loadOpenPositions(): void {
    const rows = this.db.prepare(`SELECT * FROM copy_trades WHERE status = 'open'`).all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      if (!r.base_vault || !r.quote_vault) continue;
      this.positions.set(r.id as number, {
        id: r.id as number,
        strategyId: r.strategy_id as string,
        mint: r.mint as string,
        pool: (r.pool_address as string) ?? '',
        baseVault: r.base_vault as string,
        quoteVault: r.quote_vault as string,
        entryPrice: r.entry_price_sol as number,
        sizeSol: r.size_sol as number,
        tpPrice: (r.tp_price_sol as number) ?? null,
        slPrice: (r.sl_price_sol as number) ?? null,
        exitFollow: r.exit_follow === 1,
        maxHoldSec: (r.max_hold_sec as number) ?? null,
        entryTs: r.entry_ts as number,
      });
    }
  }

  /** A followed wallet bought `mint` — open shadow copies for armed strategies. */
  async onLeadBuy(mint: string, leadWallet: string, leadTier: string, detectionLagSec: number | null): Promise<void> {
    if (!this.enabled || this.stopped) return;
    const pv = await this.resolvePool(mint);
    if (!pv) return; // not a tracked-grad mint / pool unresolved — skip (coverage limit)
    const conn = this.getConnection();
    if (!conn) return;
    if (!(await globalRpcLimiter.throttleOrDrop(20))) return;
    const price = await fetchVaultPrice(conn, pv.baseVault, pv.quoteVault);
    if (!price || price.priceSol <= 0) return;

    const nowSec = Math.floor(Date.now() / 1000);
    for (const s of COPY_STRATEGIES) {
      // one position per (strategy, mint); respect the concurrency cap.
      const open = [...this.positions.values()].filter((p) => p.strategyId === s.id);
      if (open.some((p) => p.mint === mint)) continue;
      if (open.length >= MAX_CONCURRENT_PER_STRATEGY) continue;

      const tpPrice = s.tpPct != null ? price.priceSol * (1 + s.tpPct / 100) : null;
      const slPrice = s.slPct != null ? price.priceSol * (1 - s.slPct / 100) : null;
      const id = this.insertOpen({
        strategyId: s.id, mint, pool: pv.pool, baseVault: pv.baseVault, quoteVault: pv.quoteVault,
        leadWallet, leadTier, entryTs: nowSec, entryPrice: price.priceSol, sizeSol: COPY_SIZE_SOL,
        tpPrice, slPrice, exitFollow: s.exitFollow, maxHoldSec: s.maxHoldSec, detectionLagSec,
      });
      if (id == null) continue; // UNIQUE conflict (same strat+mint+sec) — skip
      this.positions.set(id, {
        id, strategyId: s.id, mint, pool: pv.pool, baseVault: pv.baseVault, quoteVault: pv.quoteVault,
        entryPrice: price.priceSol, sizeSol: COPY_SIZE_SOL, tpPrice, slPrice,
        exitFollow: s.exitFollow, maxHoldSec: s.maxHoldSec, entryTs: nowSec,
      });
    }
  }

  /** A followed wallet sold `mint` — close every follow-exit position in it. */
  async onLeadSell(mint: string): Promise<void> {
    if (!this.enabled || this.stopped) return;
    const toClose = [...this.positions.values()].filter((p) => p.mint === mint && p.exitFollow);
    if (toClose.length === 0) return;
    const conn = this.getConnection();
    let exitPrice: number | null = null;
    if (conn && (await globalRpcLimiter.throttleOrDrop(20))) {
      const price = await fetchVaultPrice(conn, toClose[0].baseVault, toClose[0].quoteVault);
      exitPrice = price?.priceSol ?? null;
    }
    for (const p of toClose) this.closePosition(p, 'follow_sell', exitPrice ?? p.entryPrice);
  }

  /** Periodic TP / SL / max-hold check on open positions (deduped by pool). */
  private async poll(): Promise<void> {
    if (this.polling || this.stopped || this.positions.size === 0) return;
    this.polling = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      const byPool = new Map<string, OpenPos[]>();
      for (const p of this.positions.values()) {
        if (!byPool.has(p.baseVault)) byPool.set(p.baseVault, []);
        byPool.get(p.baseVault)!.push(p);
      }
      for (const ps of byPool.values()) {
        const conn = this.getConnection();
        let price: number | null = null;
        if (conn && (await globalRpcLimiter.throttleOrDrop(15))) {
          const r = await fetchVaultPrice(conn, ps[0].baseVault, ps[0].quoteVault);
          price = r?.priceSol ?? null;
        }
        for (const p of ps) {
          if (p.maxHoldSec != null && now - p.entryTs >= p.maxHoldSec) {
            this.closePosition(p, 'timeout', price ?? p.entryPrice);
            continue;
          }
          if (price == null || price <= 0) continue;
          if (p.tpPrice != null && price >= p.tpPrice) { this.closePosition(p, 'take_profit', price); continue; }
          if (p.slPrice != null && price <= p.slPrice) { this.closePosition(p, 'stop_loss', price); continue; }
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private closePosition(p: OpenPos, reason: string, exitPrice: number): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const grossPct = p.entryPrice > 0 ? (exitPrice / p.entryPrice - 1) * 100 : 0;
    const netPct = grossPct - SIM_DEFAULT_COST_PCT; // shadow round-trip cost
    const netSol = +(p.sizeSol * (netPct / 100)).toFixed(5);
    const holdSec = nowSec - p.entryTs;
    try {
      this.db.prepare(`
        UPDATE copy_trades
        SET status = 'closed', exit_ts = @exit_ts, exit_price_sol = @exit_price,
            exit_reason = @reason, gross_pct = @gross, net_sol = @net, hold_sec = @hold
        WHERE id = @id
      `).run({
        id: p.id, exit_ts: nowSec, exit_price: exitPrice, reason,
        gross: +grossPct.toFixed(3), net: netSol, hold: holdSec,
      });
    } catch (err) {
      logger.warn('closePosition db error: %s', err instanceof Error ? err.message : String(err));
    }
    this.positions.delete(p.id);
    logger.info('Copy close %s %s %s net=%s SOL hold=%ds', p.strategyId, p.mint.slice(0, 6), reason, netSol, holdSec);
  }

  private async resolvePool(mint: string): Promise<PoolVaults | null> {
    if (this.poolCache.has(mint)) return this.poolCache.get(mint) ?? null;
    const row = this.db.prepare(
      `SELECT new_pool_address AS pool FROM graduations WHERE mint = ? AND new_pool_address IS NOT NULL`,
    ).get(mint) as { pool: string } | undefined;
    if (!row?.pool) { this.poolCache.set(mint, null); return null; }
    let pk: PublicKey;
    try { pk = new PublicKey(row.pool); } catch { this.poolCache.set(mint, null); return null; }
    const conn = this.getConnection();
    if (!conn) return null;
    if (!(await globalRpcLimiter.throttleOrDrop(20))) return null;
    let info;
    try { info = await conn.getAccountInfo(pk); } catch { return null; }
    if (!info || info.data.length < POOL_QUOTE_VAULT_OFFSET + 32) { this.poolCache.set(mint, null); return null; }
    const baseVault = new PublicKey(info.data.subarray(POOL_BASE_VAULT_OFFSET, POOL_BASE_VAULT_OFFSET + 32)).toBase58();
    const quoteVault = new PublicKey(info.data.subarray(POOL_QUOTE_VAULT_OFFSET, POOL_QUOTE_VAULT_OFFSET + 32)).toBase58();
    const pv: PoolVaults = { pool: row.pool, baseVault, quoteVault };
    this.poolCache.set(mint, pv);
    return pv;
  }

  private insertOpen(d: {
    strategyId: string; mint: string; pool: string; baseVault: string; quoteVault: string;
    leadWallet: string; leadTier: string; entryTs: number; entryPrice: number; sizeSol: number;
    tpPrice: number | null; slPrice: number | null; exitFollow: boolean; maxHoldSec: number | null;
    detectionLagSec: number | null;
  }): number | null {
    const res = this.db.prepare(`
      INSERT OR IGNORE INTO copy_trades
        (strategy_id, mint, pool_address, base_vault, quote_vault, lead_wallet, lead_tier,
         entry_ts, entry_price_sol, size_sol, tp_price_sol, sl_price_sol, exit_follow,
         max_hold_sec, detection_lag_sec, status)
      VALUES
        (@strategy_id, @mint, @pool, @base_vault, @quote_vault, @lead_wallet, @lead_tier,
         @entry_ts, @entry_price, @size, @tp, @sl, @exit_follow,
         @max_hold, @lag, 'open')
    `).run({
      strategy_id: d.strategyId, mint: d.mint, pool: d.pool, base_vault: d.baseVault, quote_vault: d.quoteVault,
      lead_wallet: d.leadWallet, lead_tier: d.leadTier, entry_ts: d.entryTs, entry_price: d.entryPrice,
      size: d.sizeSol, tp: d.tpPrice, sl: d.slPrice, exit_follow: d.exitFollow ? 1 : 0,
      max_hold: d.maxHoldSec, lag: d.detectionLagSec,
    });
    return res.changes > 0 ? (res.lastInsertRowid as number) : null;
  }
}

// ── Published summary (read-only; cheap SQL) ──────────────────────────────
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function computeCopyTrades(db: Database.Database): unknown {
  let closed: Array<Record<string, unknown>> = [];
  let openRows: Array<{ strategy_id: string; c: number }> = [];
  try {
    closed = db.prepare(`SELECT * FROM copy_trades WHERE status = 'closed'`).all() as Array<Record<string, unknown>>;
    openRows = db.prepare(`SELECT strategy_id, COUNT(*) AS c FROM copy_trades WHERE status = 'open' GROUP BY strategy_id`).all() as Array<{ strategy_id: string; c: number }>;
  } catch {
    return { generated_at: new Date().toISOString(), phase: 'phase2-shadow-copy', pending: true };
  }
  const openByStrat: Record<string, number> = {};
  for (const r of openRows) openByStrat[r.strategy_id] = r.c;

  const summarize = (rows: Array<Record<string, unknown>>) => {
    const nets = rows.map((r) => r.net_sol as number).filter((v) => typeof v === 'number');
    const total = +nets.reduce((a, b) => a + b, 0).toFixed(4);
    const top3 = [...nets].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
    const wins = nets.filter((v) => v > 0).length;
    const holds = rows.map((r) => r.hold_sec as number).filter((v) => typeof v === 'number');
    const lags = rows.map((r) => r.detection_lag_sec as number).filter((v) => typeof v === 'number');
    const byReason: Record<string, number> = {};
    for (const r of rows) byReason[(r.exit_reason as string) ?? 'unknown'] = (byReason[(r.exit_reason as string) ?? 'unknown'] ?? 0) + 1;
    return {
      n: rows.length,
      total_net_sol: total,
      total_net_sol_drop_top3: +(total - top3).toFixed(4),
      win_rate: rows.length ? +(wins / rows.length).toFixed(3) : null,
      median_hold_sec: median(holds),
      avg_detection_lag_sec: lags.length ? +(lags.reduce((a, b) => a + b, 0) / lags.length).toFixed(2) : null,
      by_exit_reason: byReason,
    };
  };

  const byStrategy: Record<string, unknown> = {};
  for (const s of COPY_STRATEGIES) {
    const rows = closed.filter((r) => r.strategy_id === s.id);
    byStrategy[s.id] = {
      config: { tp_pct: s.tpPct, sl_pct: s.slPct, exit_follow: s.exitFollow, max_hold_sec: s.maxHoldSec },
      open_positions: openByStrat[s.id] ?? 0,
      ...summarize(rows),
    };
  }

  return {
    generated_at: new Date().toISOString(),
    phase: 'phase2-shadow-copy',
    note: 'SHADOW copy trades — no real funds. Entry at pool price ~1.1s after the lead wallet (their impact already in price); net_sol after the SIM round-trip cost. Strategies hold indefinitely (smart wallets hold ~hours). Coverage limited to tokens in our graduations table (pool resolvable).',
    size_sol: COPY_SIZE_SOL,
    overall: summarize(closed),
    by_strategy: byStrategy,
    recent_closed: closed
      .sort((a, b) => (b.exit_ts as number ?? 0) - (a.exit_ts as number ?? 0))
      .slice(0, 30)
      .map((r) => ({
        strategy_id: r.strategy_id, mint: (r.mint as string).slice(0, 8), lead: (r.lead_wallet as string ?? '').slice(0, 6),
        tier: r.lead_tier, entry_price_sol: r.entry_price_sol, exit_price_sol: r.exit_price_sol,
        exit_reason: r.exit_reason, gross_pct: r.gross_pct, net_sol: r.net_sol, hold_sec: r.hold_sec,
      })),
  };
}
