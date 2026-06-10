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
 * after their fill. Positions are tracked until they exit per the strategy rule.
 * net P&L is modeled after the SIM round-trip cost.
 *
 * Exit engine supports: fixed TP/SL, follow-the-lead's-sell, max-hold, a
 * breakeven stop, a tiered ratchet (raise the stop as the position climbs),
 * scale-out (sell a fraction at +X%, let the rest ride), and entry-side
 * conviction gates (only copy top-ranked leads, or tokens with consensus).
 * High-water mark + scale-out state persist on the row so restarts resume
 * correctly. Default-on, shadow only (COPY_TRADER_DISABLED to turn off).
 *
 * Self-contained: does NOT use the live PositionManager / trades_v2 path. Pool/
 * vaults resolved from graduations.new_pool_address (so only tokens we tracked
 * are copyable — a deliberate, expandable limitation).
 */

const POOL_BASE_VAULT_OFFSET = 139;   // matches PriceCollector / graduation-listener
const POOL_QUOTE_VAULT_OFFSET = 171;

export interface RatchetTier { atPct: number; stopPct: number; } // once HWM >= entry*(1+atPct), stop to entry*(1+stopPct)

export interface CopyStrategy {
  id: string;
  tpPct: number | null;
  slPct: number | null;        // base stop; may be raised by breakeven/ratchet
  exitFollow: boolean;
  maxHoldSec: number | null;   // null = hold indefinitely
  breakevenAtPct?: number;     // once HWM >= +this%, raise stop to entry + breakevenBufferPct
  breakevenBufferPct?: number; // default 3 (entry + cost)
  ratchet?: RatchetTier[];     // tiered raised cutoff
  scaleOut?: { atPct: number; fraction: number }; // sell fraction at +atPct, rest rides
  minLeadRank?: number;        // only copy if lead wallet's follow_list rank <= this
  minConsensusRecent?: number; // only copy if >= N distinct smart wallets bought this mint in last 10min
  walletAllowlist?: string[];  // only copy if the lead wallet is in this set (copy-best-wallet)
  entryPenaltyPct?: number;    // worsen entry price by this % to model realistic copy lag (shadow enters at the
                               // optimistic ~1.1s pool snapshot; a real tx confirms seconds later, after the
                               // token has run further — so we fill higher). TP/SL/HWM all key off the penalized entry.
  exitPenaltyPct?: number;     // worsen the exit fill by this % (sell lands 1-2 blocks after the trigger price,
                               // after the token has moved against us). Applied uniformly to every exit reason
                               // and to scale-out partials; the penalized fill is what gets stored + netted.
}

export const COPY_STRATEGIES: CopyStrategy[] = [
  // ── original 5 ──
  { id: 'copy-followsell',        tpPct: null, slPct: null, exitFollow: true,  maxHoldSec: null },
  { id: 'copy-tp50-sl20',         tpPct: 50,   slPct: 20,   exitFollow: false, maxHoldSec: null },
  { id: 'copy-tp100-sl30',        tpPct: 100,  slPct: 30,   exitFollow: false, maxHoldSec: null },
  { id: 'copy-tp200-sl40',        tpPct: 200,  slPct: 40,   exitFollow: false, maxHoldSec: null },
  { id: 'copy-tp100-sl50-follow', tpPct: 100,  slPct: 50,   exitFollow: true,  maxHoldSec: null },
  // ── E: conservative-lag shadows of the two promotable copy recs (drop3>0 at n>100).
  //    5% entry penalty models filling higher than the optimistic ~1.1s snapshot once a
  //    real copy tx confirms — the honest test of whether the edge survives realistic lag.
  //    2% exit penalty models the sell landing after the trigger (worse fill both ways).
  { id: 'copy-tp100-sl30-cons',   tpPct: 100,  slPct: 30,   exitFollow: false, maxHoldSec: null, entryPenaltyPct: 5, exitPenaltyPct: 2 },
  { id: 'copy-followsell-cons',   tpPct: null, slPct: null, exitFollow: true,  maxHoldSec: null, entryPenaltyPct: 5, exitPenaltyPct: 2 },
  // ── breakeven: once +10%, lock stop at entry+3% (covers our cost) ──
  { id: 'copy-be10-plus3',        tpPct: 150,  slPct: 30,   exitFollow: false, maxHoldSec: null, breakevenAtPct: 10, breakevenBufferPct: 3 },
  // ── tiered ratchet: raise the cutoff as it climbs, no fixed TP (let it run) ──
  { id: 'copy-ratchet',           tpPct: null, slPct: 30,   exitFollow: false, maxHoldSec: null,
    ratchet: [{ atPct: 10, stopPct: 3 }, { atPct: 30, stopPct: 15 }, { atPct: 60, stopPct: 35 }, { atPct: 100, stopPct: 70 }] },
  // ── A: scale-out — sell half at +50%, runner rides with SL + follow ──
  { id: 'copy-scaleout50',        tpPct: null, slPct: 30,   exitFollow: true,  maxHoldSec: null, scaleOut: { atPct: 50, fraction: 0.5 } },
  // ── B: conviction filters — copy quality, not quantity ──
  { id: 'copy-conviction-toplead',   tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null, minLeadRank: 15 },
  { id: 'copy-conviction-consensus2', tpPct: 100, slPct: 30, exitFollow: false, maxHoldSec: null, minConsensusRecent: 2 },
  // ── C: hold-time sweep — SL only, time-boxed, no TP/follow ──
  { id: 'copy-hold30m',           tpPct: null, slPct: 30,   exitFollow: false, maxHoldSec: 1800 },
  { id: 'copy-hold2h',            tpPct: null, slPct: 30,   exitFollow: false, maxHoldSec: 7200 },
  { id: 'copy-hold6h',            tpPct: null, slPct: 30,   exitFollow: false, maxHoldSec: 21600 },
  // ── D: copy-best-wallet — mirror only the 3 most outlier-robust smart wallets
  //    (highest total_realized_sol_drop_top3, ≥40 round-trips for signal frequency).
  //    GYAVBL is deliberately excluded — 90% of its profit is 3 lottery trades
  //    (drop_top3 only +30, WR 20%). These hold to the wallets' own behavior
  //    (median hold 2.6–3.4h), so long maxHoldSec + follow-sell / ratchet exits.
  //    FORWARD-SHADOW ONLY — multi-hour holds aren't backtestable (paths stop at T+600).
  // iGiyBN — most robust (drop3 +187, 159 RT, 100% WR): both exit styles.
  { id: 'copy-igiybn-follow',  tpPct: null, slPct: 40, exitFollow: true,  maxHoldSec: 21600,
    walletAllowlist: ['iGiyBNJ9eKcPfBLaoVCEMx3WCyrnUT1SfKZL2DYifcL'] },
  { id: 'copy-igiybn-ratchet', tpPct: null, slPct: 35, exitFollow: false, maxHoldSec: 21600,
    ratchet: [{ atPct: 30, stopPct: 10 }, { atPct: 100, stopPct: 60 }, { atPct: 300, stopPct: 200 }],
    walletAllowlist: ['iGiyBNJ9eKcPfBLaoVCEMx3WCyrnUT1SfKZL2DYifcL'] },
  // 2SNLnX — highest total (363 SOL, drop3 +171, 41% WR).
  { id: 'copy-2snlnx-follow',  tpPct: null, slPct: 40, exitFollow: true,  maxHoldSec: 21600,
    walletAllowlist: ['2SNLnXMjYSihEz3ujLaJzB92AzJTkfRih8RoWWoEQQAM'] },
  // BuWG6b — most signals (189 RT, drop3 +149, 53% WR).
  { id: 'copy-buwg6b-follow',  tpPct: null, slPct: 40, exitFollow: true,  maxHoldSec: 21600,
    walletAllowlist: ['BuWG6b9AeK1KuyG88Y7FsdLagCJtNcNwxmbQTDqPeNFr'] },
];

const STRAT_BY_ID = new Map(COPY_STRATEGIES.map((s) => [s.id, s]));

const COPY_SIZE_SOL = parseFloat(process.env.COPY_SIZE_SOL || '0.5');
const MAX_CONCURRENT_PER_STRATEGY = parseInt(process.env.COPY_MAX_CONCURRENT || '40', 10);
const POLL_INTERVAL_MS = parseInt(process.env.COPY_POLL_MS || '15000', 10);
const CONSENSUS_WINDOW_MS = 10 * 60 * 1000;

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
  baseSlPrice: number | null;
  exitFollow: boolean;
  maxHoldSec: number | null;
  entryTs: number;          // unix sec
  highPrice: number;        // HWM (persisted)
  scaledOut: boolean;       // persisted
  realizedPartial: number;  // SOL already realized via scale-out (persisted)
  lastWrittenPrice?: number; // in-memory dedupe for last_price_sol writes
}

interface PoolVaults { pool: string; baseVault: string; quoteVault: string; }

/** Current effective stop price from base SL + breakeven + ratchet (HWM-based).
 *  Pure + exported for testability. Returns null if no stop applies. */
export function effectiveStopPrice(entryPrice: number, highPrice: number, s: CopyStrategy): number | null {
  let stop: number | null = s.slPct != null ? entryPrice * (1 - s.slPct / 100) : null;
  const hwmUpPct = (highPrice / entryPrice - 1) * 100;
  if (s.breakevenAtPct != null && hwmUpPct >= s.breakevenAtPct) {
    const be = entryPrice * (1 + (s.breakevenBufferPct ?? 3) / 100);
    stop = stop == null ? be : Math.max(stop, be);
  }
  for (const t of s.ratchet ?? []) {
    if (hwmUpPct >= t.atPct) {
      const lvl = entryPrice * (1 + t.stopPct / 100);
      stop = stop == null ? lvl : Math.max(stop, lvl);
    }
  }
  return stop;
}

/** net SOL for a portion of `size` exiting at `exitPrice` from `entryPrice`,
 *  after the round-trip cost (%). Pure + exported for testability. */
export function tradeNetSol(entryPrice: number, exitPrice: number, size: number, costPct: number): number {
  const grossPct = entryPrice > 0 ? (exitPrice / entryPrice - 1) * 100 : 0;
  return size * ((grossPct - costPct) / 100);
}

export class CopyTrader {
  private readonly db: Database.Database;
  private readonly getConnection: () => Connection | null;
  private positions = new Map<number, OpenPos>();
  private poolCache = new Map<string, PoolVaults | null>();
  private leadRank = new Map<string, number>();
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
    this.refreshLeadRanks();
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

  private refreshLeadRanks(): void {
    try {
      const rows = this.db.prepare(`SELECT address, rank FROM follow_list`).all() as Array<{ address: string; rank: number | null }>;
      this.leadRank = new Map(rows.filter((r) => r.rank != null).map((r) => [r.address, r.rank as number]));
    } catch { /* table may be empty */ }
  }

  private loadOpenPositions(): void {
    const rows = this.db.prepare(`SELECT * FROM copy_trades WHERE status = 'open'`).all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      if (!r.base_vault || !r.quote_vault) continue;
      const entry = r.entry_price_sol as number;
      this.positions.set(r.id as number, {
        id: r.id as number,
        strategyId: r.strategy_id as string,
        mint: r.mint as string,
        pool: (r.pool_address as string) ?? '',
        baseVault: r.base_vault as string,
        quoteVault: r.quote_vault as string,
        entryPrice: entry,
        sizeSol: r.size_sol as number,
        tpPrice: (r.tp_price_sol as number) ?? null,
        baseSlPrice: (r.sl_price_sol as number) ?? null,
        exitFollow: r.exit_follow === 1,
        maxHoldSec: (r.max_hold_sec as number) ?? null,
        entryTs: r.entry_ts as number,
        highPrice: (r.high_price_sol as number) ?? entry,
        scaledOut: r.scaled_out === 1,
        realizedPartial: (r.realized_partial_sol as number) ?? 0,
      });
    }
  }

  /** A followed wallet bought `mint` — open shadow copies for armed strategies. */
  async onLeadBuy(mint: string, leadWallet: string, leadTier: string, detectionLagSec: number | null): Promise<void> {
    if (!this.enabled || this.stopped) return;
    const pv = await this.resolvePool(mint);
    if (!pv) return; // not a tracked-grad mint / pool unresolved
    const conn = this.getConnection();
    if (!conn) return;
    if (!(await globalRpcLimiter.throttleOrDrop(20))) return;
    const price = await fetchVaultPrice(conn, pv.baseVault, pv.quoteVault);
    if (!price || price.priceSol <= 0) return;

    const leadRank = this.leadRank.get(leadWallet) ?? Infinity;
    let consensusRecent: number | null = null; // computed lazily, once per call
    const nowSec = Math.floor(Date.now() / 1000);

    for (const s of COPY_STRATEGIES) {
      const open = [...this.positions.values()].filter((p) => p.strategyId === s.id);
      if (open.some((p) => p.mint === mint)) continue;       // one position per (strategy, mint)
      if (open.length >= MAX_CONCURRENT_PER_STRATEGY) continue;
      // conviction gates
      if (s.walletAllowlist && !s.walletAllowlist.includes(leadWallet)) continue;
      if (s.minLeadRank != null && leadRank > s.minLeadRank) continue;
      if (s.minConsensusRecent != null) {
        if (consensusRecent == null) consensusRecent = this.countRecentSmartBuyers(mint);
        if (consensusRecent < s.minConsensusRecent) continue;
      }

      // Penalized entry — models a realistic confirmation lag (fill higher than the
      // optimistic ~1.1s snapshot). Default 0 = enter at snapshot price as before.
      const entryP = s.entryPenaltyPct ? price.priceSol * (1 + s.entryPenaltyPct / 100) : price.priceSol;
      const tpPrice = s.tpPct != null ? entryP * (1 + s.tpPct / 100) : null;
      const slPrice = s.slPct != null ? entryP * (1 - s.slPct / 100) : null;
      const id = this.insertOpen({
        strategyId: s.id, mint, pool: pv.pool, baseVault: pv.baseVault, quoteVault: pv.quoteVault,
        leadWallet, leadTier, entryTs: nowSec, entryPrice: entryP, sizeSol: COPY_SIZE_SOL,
        tpPrice, slPrice, exitFollow: s.exitFollow, maxHoldSec: s.maxHoldSec, detectionLagSec,
      });
      if (id == null) continue;
      this.positions.set(id, {
        id, strategyId: s.id, mint, pool: pv.pool, baseVault: pv.baseVault, quoteVault: pv.quoteVault,
        entryPrice: entryP, sizeSol: COPY_SIZE_SOL, tpPrice, baseSlPrice: slPrice,
        exitFollow: s.exitFollow, maxHoldSec: s.maxHoldSec, entryTs: nowSec,
        highPrice: entryP, scaledOut: false, realizedPartial: 0,
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

  private countRecentSmartBuyers(mint: string): number {
    try {
      const since = Date.now() - CONSENSUS_WINDOW_MS;
      const row = this.db.prepare(
        `SELECT COUNT(DISTINCT wallet_address) AS c FROM copy_probe_events WHERE mint = ? AND action = 'buy' AND detected_at >= ?`,
      ).get(mint, since) as { c: number };
      return row.c;
    } catch { return 0; }
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped || this.positions.size === 0) return;
    this.polling = true;
    try {
      this.refreshLeadRanks();
      const now = Math.floor(Date.now() / 1000);
      const byVault = new Map<string, OpenPos[]>();
      for (const p of this.positions.values()) {
        if (!byVault.has(p.baseVault)) byVault.set(p.baseVault, []);
        byVault.get(p.baseVault)!.push(p);
      }
      for (const ps of byVault.values()) {
        const conn = this.getConnection();
        let price: number | null = null;
        if (conn && (await globalRpcLimiter.throttleOrDrop(15))) {
          const r = await fetchVaultPrice(conn, ps[0].baseVault, ps[0].quoteVault);
          price = r?.priceSol ?? null;
        }
        for (const p of ps) {
          const s = STRAT_BY_ID.get(p.strategyId);
          if (!s) continue;
          // max-hold doesn't need a price
          if (p.maxHoldSec != null && now - p.entryTs >= p.maxHoldSec) {
            this.closePosition(p, 'timeout', price ?? p.highPrice ?? p.entryPrice);
            continue;
          }
          if (price == null || price <= 0) continue;
          // update HWM (persist on new high)
          if (price > p.highPrice) {
            p.highPrice = price;
            try { this.db.prepare(`UPDATE copy_trades SET high_price_sol = ? WHERE id = ?`).run(price, p.id); } catch { /* noop */ }
          }
          // persist last seen price so copy-trades.json can mark open positions
          // to market. Skip the write when unchanged beyond 0.1% to keep poll cheap.
          if (p.lastWrittenPrice == null || Math.abs(price / p.lastWrittenPrice - 1) > 0.001) {
            p.lastWrittenPrice = price;
            try {
              this.db.prepare(`UPDATE copy_trades SET last_price_sol = ?, last_price_ts = ? WHERE id = ?`).run(price, now, p.id);
            } catch { /* noop */ }
          }
          // scale-out (partial realize, runner continues) — partial fill takes the
          // same exit penalty as a full close.
          if (s.scaleOut && !p.scaledOut && price >= p.entryPrice * (1 + s.scaleOut.atPct / 100)) {
            const portion = p.sizeSol * s.scaleOut.fraction;
            const fill = s.exitPenaltyPct ? price * (1 - s.exitPenaltyPct / 100) : price;
            const partialNet = +tradeNetSol(p.entryPrice, fill, portion, SIM_DEFAULT_COST_PCT).toFixed(5);
            p.realizedPartial += partialNet;
            p.scaledOut = true;
            try {
              this.db.prepare(`UPDATE copy_trades SET scaled_out = 1, realized_partial_sol = ? WHERE id = ?`)
                .run(p.realizedPartial, p.id);
            } catch { /* noop */ }
            logger.info('Copy scale-out %s %s +%d%% partial=%s SOL', p.strategyId, p.mint.slice(0, 6), s.scaleOut.atPct, partialNet);
          }
          // exits on the remainder
          const stop = effectiveStopPrice(p.entryPrice, p.highPrice, s);
          if (p.tpPrice != null && price >= p.tpPrice) { this.closePosition(p, 'take_profit', price); continue; }
          if (stop != null && price <= stop) {
            const raised = p.baseSlPrice == null || stop > p.baseSlPrice;
            this.closePosition(p, raised ? 'trail_stop' : 'stop_loss', price);
            continue;
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private closePosition(p: OpenPos, reason: string, rawExitPrice: number): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const remainingSize = this.remainderSize(p);
    // Penalized fill — the trigger price is what we observed; a real sell lands
    // ~1-2 blocks later. Stored + netted on the penalized fill (mirrors entry penalty).
    const exitPen = STRAT_BY_ID.get(p.strategyId)?.exitPenaltyPct ?? 0;
    const exitPrice = exitPen ? rawExitPrice * (1 - exitPen / 100) : rawExitPrice;
    const grossPct = p.entryPrice > 0 ? (exitPrice / p.entryPrice - 1) * 100 : 0;
    const remainderNet = tradeNetSol(p.entryPrice, exitPrice, remainingSize, SIM_DEFAULT_COST_PCT);
    const netSol = +(p.realizedPartial + remainderNet).toFixed(5);
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

  /** Remaining (un-scaled) size of a position. */
  private remainderSize(p: OpenPos): number {
    if (!p.scaledOut) return p.sizeSol;
    const s = STRAT_BY_ID.get(p.strategyId);
    const frac = s?.scaleOut?.fraction ?? 0;
    return p.sizeSol * (1 - frac);
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
         max_hold_sec, detection_lag_sec, high_price_sol, scaled_out, realized_partial_sol, status)
      VALUES
        (@strategy_id, @mint, @pool, @base_vault, @quote_vault, @lead_wallet, @lead_tier,
         @entry_ts, @entry_price, @size, @tp, @sl, @exit_follow,
         @max_hold, @lag, @entry_price, 0, 0, 'open')
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

/** Uniform exit-fill stress: re-net the remainder leg with the exit price worsened
 *  by `penPct`%. Scale-out partials are kept as recorded (their exit prices aren't
 *  stored), so scale-out strategies are slightly under-stressed — noted in the JSON. */
const EXIT_STRESS_PCT = 2;
function stressedNet(r: Record<string, unknown>, s: CopyStrategy | undefined, penPct: number): number | null {
  const entry = r.entry_price_sol as number;
  const exit = r.exit_price_sol as number;
  const size = r.size_sol as number;
  if (typeof entry !== 'number' || typeof exit !== 'number' || typeof size !== 'number' || entry <= 0) return null;
  const frac = r.scaled_out === 1 ? (s?.scaleOut?.fraction ?? 0) : 0;
  const partial = (r.realized_partial_sol as number) ?? 0;
  return partial + tradeNetSol(entry, exit * (1 - penPct / 100), size * (1 - frac), SIM_DEFAULT_COST_PCT);
}

/** Mark an open position to its last polled pool price (after round-trip cost). */
function unrealizedNet(r: Record<string, unknown>, s: CopyStrategy | undefined): number | null {
  const entry = r.entry_price_sol as number;
  const last = r.last_price_sol as number;
  const size = r.size_sol as number;
  if (typeof entry !== 'number' || typeof last !== 'number' || typeof size !== 'number' || entry <= 0 || last <= 0) return null;
  const frac = r.scaled_out === 1 ? (s?.scaleOut?.fraction ?? 0) : 0;
  const partial = (r.realized_partial_sol as number) ?? 0;
  return partial + tradeNetSol(entry, last, size * (1 - frac), SIM_DEFAULT_COST_PCT);
}

export function computeCopyTrades(db: Database.Database): unknown {
  let closed: Array<Record<string, unknown>> = [];
  let open: Array<Record<string, unknown>> = [];
  try {
    closed = db.prepare(`SELECT * FROM copy_trades WHERE status = 'closed'`).all() as Array<Record<string, unknown>>;
    open = db.prepare(`SELECT * FROM copy_trades WHERE status = 'open'`).all() as Array<Record<string, unknown>>;
  } catch {
    return { generated_at: new Date().toISOString(), phase: 'phase2-shadow-copy', pending: true };
  }

  const utcDay = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10);

  const summarize = (rows: Array<Record<string, unknown>>) => {
    const nets = rows.map((r) => r.net_sol as number).filter((v) => typeof v === 'number');
    const total = +nets.reduce((a, b) => a + b, 0).toFixed(4);
    const top3 = [...nets].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
    const wins = nets.filter((v) => v > 0).length;
    const holds = rows.map((r) => r.hold_sec as number).filter((v) => typeof v === 'number');
    const lags = rows.map((r) => r.detection_lag_sec as number).filter((v) => typeof v === 'number');
    const byReason: Record<string, number> = {};
    for (const r of rows) byReason[(r.exit_reason as string) ?? 'unknown'] = (byReason[(r.exit_reason as string) ?? 'unknown'] ?? 0) + 1;
    // exit-fill stress (uniform, on top of any per-strategy penalty already baked in)
    let stressTotal = 0;
    for (const r of rows) {
      const v = stressedNet(r, STRAT_BY_ID.get(r.strategy_id as string), EXIT_STRESS_PCT);
      if (v != null) stressTotal += v;
    }
    // per-UTC-day P&L so regime stability is visible on a young dataset
    const dayMap = new Map<string, { n: number; net: number }>();
    for (const r of rows) {
      const ts = r.exit_ts as number;
      const net = r.net_sol as number;
      if (typeof ts !== 'number' || typeof net !== 'number') continue;
      const d = utcDay(ts);
      const cur = dayMap.get(d) ?? { n: 0, net: 0 };
      cur.n += 1; cur.net += net;
      dayMap.set(d, cur);
    }
    const daily = [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, n: v.n, net_sol: +v.net.toFixed(4) }));
    return {
      n: rows.length,
      total_net_sol: total,
      total_net_sol_drop_top3: +(total - top3).toFixed(4),
      total_net_sol_exit_stress: +stressTotal.toFixed(4),
      win_rate: rows.length ? +(wins / rows.length).toFixed(3) : null,
      median_hold_sec: median(holds),
      avg_detection_lag_sec: lags.length ? +(lags.reduce((a, b) => a + b, 0) / lags.length).toFixed(2) : null,
      by_exit_reason: byReason,
      daily,
    };
  };

  // Open-position mark-to-market — kills the survivorship blind spot where
  // indefinite-hold strategies park losers as open bags outside closed-only P&L.
  const summarizeOpen = (rows: Array<Record<string, unknown>>) => {
    let unrealized = 0;
    let priced = 0;
    for (const r of rows) {
      const v = unrealizedNet(r, STRAT_BY_ID.get(r.strategy_id as string));
      if (v != null) { unrealized += v; priced += 1; }
    }
    return {
      open_positions: rows.length,
      open_priced: priced,
      open_unrealized_sol: +unrealized.toFixed(4),
    };
  };

  // Paired comparison vs a fixed baseline: every strategy copies the same lead-buy
  // events (keyed mint+entry_ts), so totals across strategies are NOT independent.
  // delta_net_sol on common events is the honest exit-variant comparison.
  const PAIRED_BASELINE = 'copy-tp100-sl30';
  const baseByEvent = new Map<string, number>();
  for (const r of closed) {
    if (r.strategy_id !== PAIRED_BASELINE) continue;
    if (typeof r.net_sol !== 'number') continue;
    baseByEvent.set(`${r.mint}:${r.entry_ts}`, r.net_sol as number);
  }
  const pairedVsBaseline: Record<string, unknown> = {};
  for (const s of COPY_STRATEGIES) {
    if (s.id === PAIRED_BASELINE) continue;
    let nCommon = 0;
    let delta = 0;
    for (const r of closed) {
      if (r.strategy_id !== s.id || typeof r.net_sol !== 'number') continue;
      const base = baseByEvent.get(`${r.mint}:${r.entry_ts}`);
      if (base == null) continue;
      nCommon += 1;
      delta += (r.net_sol as number) - base;
    }
    if (nCommon > 0) {
      pairedVsBaseline[s.id] = {
        n_common_events: nCommon,
        delta_net_sol: +delta.toFixed(4),
        avg_delta_sol_per_event: +(delta / nCommon).toFixed(5),
      };
    }
  }

  const byStrategy: Record<string, unknown> = {};
  for (const s of COPY_STRATEGIES) {
    const rows = closed.filter((r) => r.strategy_id === s.id);
    const openForStrat = open.filter((r) => r.strategy_id === s.id);
    const closedSummary = summarize(rows);
    // keep the per-strategy day series bounded; the overall block keeps full history
    closedSummary.daily = closedSummary.daily.slice(-14);
    const openSummary = summarizeOpen(openForStrat);
    byStrategy[s.id] = {
      config: {
        tp_pct: s.tpPct, sl_pct: s.slPct, exit_follow: s.exitFollow, max_hold_sec: s.maxHoldSec,
        breakeven_at_pct: s.breakevenAtPct ?? null, ratchet: s.ratchet ?? null,
        scale_out: s.scaleOut ?? null, min_lead_rank: s.minLeadRank ?? null, min_consensus: s.minConsensusRecent ?? null,
        entry_penalty_pct: s.entryPenaltyPct ?? null, exit_penalty_pct: s.exitPenaltyPct ?? null,
      },
      ...openSummary,
      total_incl_open_sol: +(closedSummary.total_net_sol + openSummary.open_unrealized_sol).toFixed(4),
      ...closedSummary,
    };
  }

  const overallClosed = summarize(closed);
  const overallOpen = summarizeOpen(open);

  return {
    generated_at: new Date().toISOString(),
    phase: 'phase2-shadow-copy',
    note: 'SHADOW copy trades — no real funds. Entry at pool price ~1.1s after the lead wallet; net_sol after the SIM round-trip cost (scale-out partials folded in). Coverage limited to tokens in our graduations table. CAVEATS: strategies share entry signals — totals are not independent (see paired_vs_baseline); total_net_sol_exit_stress re-nets every closed remainder leg with the exit fill worsened by ' + EXIT_STRESS_PCT + '% (scale-out partials kept as recorded); open_unrealized_sol marks open positions to the last polled pool price (open_priced = how many have one); total_incl_open_sol = closed + unrealized.',
    size_sol: COPY_SIZE_SOL,
    paired_baseline: PAIRED_BASELINE,
    overall: {
      ...overallOpen,
      total_incl_open_sol: +(overallClosed.total_net_sol + overallOpen.open_unrealized_sol).toFixed(4),
      ...overallClosed,
    },
    by_strategy: byStrategy,
    paired_vs_baseline: pairedVsBaseline,
    recent_closed: closed
      .sort((a, b) => (b.exit_ts as number ?? 0) - (a.exit_ts as number ?? 0))
      .slice(0, 30)
      .map((r) => ({
        strategy_id: r.strategy_id, mint: (r.mint as string).slice(0, 8), lead: (r.lead_wallet as string ?? '').slice(0, 6),
        tier: r.lead_tier, scaled_out: r.scaled_out === 1, entry_price_sol: r.entry_price_sol, exit_price_sol: r.exit_price_sol,
        exit_reason: r.exit_reason, gross_pct: r.gross_pct, net_sol: r.net_sol, hold_sec: r.hold_sec,
      })),
  };
}
