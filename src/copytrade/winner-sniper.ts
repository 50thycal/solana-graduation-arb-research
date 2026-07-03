import Database from 'better-sqlite3';
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchVaultPrice } from '../trading/executor';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('winner-sniper');

/**
 * Winner-sniper harvester (discovery source 'winner_sniper', 2026-07-02 — operator thesis,
 * S2+S3 fused). Finds wallets that repeatedly buy INTO the graduations that go on to win,
 * before they win — then hands them to the existing FIFO scorer.
 *
 * THE THESIS: "top tokens first": label each graduation WIN/LOSS by its return at ~T+30m,
 * credit the wallets that bought it in the 0-30s window (competition_signals — already
 * recorded for free at detection), and rank wallets by winner-hit PRECISION with a fast
 * time decay. A wallet that keeps early-buying winners has an entry edge with runway —
 * exactly the kind of edge that survives our 5s copy lag (unlike exit-timing scalp edges,
 * which the drift data shows die within seconds).
 *
 * WHY PRECISION (hits ÷ appearances), NOT RAW HITS: spray-bots buy EVERY graduation, so
 * they "hit" every winner too. The denominator is the whole signal.
 *
 * WHY FAST DECAY (half-life ~36h + eviction): the operator's observation, confirmed by the
 * book's own data (recency-gated hotlead beats every cumulative-reputation variant): good
 * wallets rotate fast — bots swap wallets constantly. Score decays exponentially; a wallet
 * that stops hitting falls off the promotion bar within ~2 days.
 *
 * RPC COST: ~2 reads per graduation, once (pool account → vaults, then vault balances),
 * on the DROPPABLE limiter tier — ~300-400 calls/day at current graduation rates, and a
 * missed label just retries next tick inside the window. Crediting is pure SQL. This is
 * intentionally the cheap reformulation of "which wallets made money on pumping tokens":
 * profit verification stays with the FIFO scorer (the expensive step), which this source
 * merely POINTS at better wallets (priority boost in discovery.ts).
 *
 * The probe strategy (copy-src-winner-sniper), quarantine routing, and scorecard verdict
 * all derive from the DISCOVERY_SOURCES registry row — see docs/discovery-playbook.md.
 */

const POOL_BASE_VAULT_OFFSET = 139; // matches PriceCollector / copy-trader
const POOL_QUOTE_VAULT_OFFSET = 171;

function numEnv(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] || '');
  return Number.isFinite(v) ? v : fallback;
}

export const WINNER_SNIPER_CFG = {
  /** A graduation is a WINNER when pool price at label time >= open * (1 + minRetPct/100). */
  minRetPct: numEnv('WINNER_MIN_RET_PCT', 50),
  /** Label window: earliest/latest seconds after graduation to take the one-shot read. */
  labelAfterSec: numEnv('WINNER_LABEL_AFTER_SEC', 1800),
  labelUntilSec: numEnv('WINNER_LABEL_UNTIL_SEC', 7200),
  /** Max labels attempted per tick (RPC bound per tick = 2×this). */
  labelBatch: numEnv('WINNER_LABEL_BATCH', 25),
  /** Max early buyers credited per graduation (biggest buys first — bounds tally writes). */
  creditCap: numEnv('WINNER_CREDIT_CAP', 40),
  /** Decay half-life for the sniper score, hours. */
  halfLifeHours: numEnv('WINNER_SNIPER_HALFLIFE_H', 36),
  /** Promotion bar: >= minHits winner-hits AND precision >= minPrecision AND decayed score >= minScore. */
  minHits: numEnv('WINNER_SNIPER_MIN_HITS', 2),
  minPrecision: numEnv('WINNER_SNIPER_MIN_PRECISION', 0.25),
  minScore: numEnv('WINNER_SNIPER_MIN_SCORE', 0.5),
  tickMs: numEnv('WINNER_SNIPER_TICK_MS', 5 * 60 * 1000),
};

/** Apply exponential decay to a stored score across (now - lastUpdate). */
function decayed(score: number, lastUpdate: number, now: number): number {
  const dtH = Math.max(0, now - lastUpdate) / 3600;
  return score * Math.pow(2, -dtH / WINNER_SNIPER_CFG.halfLifeHours);
}

export class WinnerSniperHarvester {
  private readonly db: Database.Database;
  private readonly getConnection: () => Connection | null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { db: Database.Database; getConnection: () => Connection | null }) {
    this.db = opts.db;
    this.getConnection = opts.getConnection;
  }

  start(): void {
    if (process.env.WINNER_SNIPER_DISABLED === 'true') {
      logger.warn('WinnerSniperHarvester disabled via WINNER_SNIPER_DISABLED');
      return;
    }
    this.ensureTables();
    this.timer = setInterval(() => {
      this.tick().catch((err) => logger.warn('tick failed: %s', err instanceof Error ? err.message : String(err)));
    }, WINNER_SNIPER_CFG.tickMs);
    logger.info(
      'WinnerSniperHarvester started: label T+%d..%ds, winner >= +%d%%, half-life %dh, promote at hits>=%d & precision>=%s',
      WINNER_SNIPER_CFG.labelAfterSec, WINNER_SNIPER_CFG.labelUntilSec, WINNER_SNIPER_CFG.minRetPct,
      WINNER_SNIPER_CFG.halfLifeHours, WINNER_SNIPER_CFG.minHits, WINNER_SNIPER_CFG.minPrecision,
    );
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS winner_labels (
        graduation_id INTEGER PRIMARY KEY REFERENCES graduations(id),
        mint TEXT,
        checked_at INTEGER NOT NULL,
        seconds_after_grad INTEGER,
        open_price_sol REAL,
        label_price_sol REAL,
        ret_pct REAL,
        is_winner INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_winner_labels_winner ON winner_labels(is_winner);
      CREATE TABLE IF NOT EXISTS winner_sniper_tally (
        address TEXT PRIMARY KEY,
        appearances INTEGER NOT NULL DEFAULT 0,
        winner_hits INTEGER NOT NULL DEFAULT 0,
        score REAL NOT NULL DEFAULT 0,        -- decayed winner-hit score (half-life above)
        last_update INTEGER NOT NULL,          -- when score was last decayed+bumped
        last_hit_ts INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_winner_sniper_hits ON winner_sniper_tally(winner_hits);
    `);
  }

  private async tick(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const labeledIds = await this.labelPending(now);
    if (labeledIds.length) this.credit(labeledIds, now);
    this.promote(now);
    this.evict(now);
  }

  /** One-shot WIN/LOSS label for graduations inside the label window. ~2 RPC reads each. */
  private async labelPending(now: number): Promise<number[]> {
    let rows: Array<{ id: number; mint: string; pool: string; open_price: number; ts: number }> = [];
    try {
      rows = this.db.prepare(`
        SELECT g.id, g.mint, g.new_pool_address AS pool, gm.open_price_sol AS open_price, g.timestamp AS ts
        FROM graduations g
        JOIN graduation_momentum gm ON gm.graduation_id = g.id
        LEFT JOIN winner_labels wl ON wl.graduation_id = g.id
        WHERE wl.graduation_id IS NULL
          AND g.new_pool_address IS NOT NULL
          AND gm.open_price_sol > 0
          AND (@now - g.timestamp) BETWEEN @after AND @until
        ORDER BY g.timestamp ASC
        LIMIT @batch
      `).all({
        now, after: WINNER_SNIPER_CFG.labelAfterSec, until: WINNER_SNIPER_CFG.labelUntilSec,
        batch: WINNER_SNIPER_CFG.labelBatch,
      }) as typeof rows;
    } catch (err) {
      logger.warn('label query failed: %s', err instanceof Error ? err.message : String(err));
      return [];
    }
    if (!rows.length) return [];
    const conn = this.getConnection();
    if (!conn) return [];

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO winner_labels
        (graduation_id, mint, checked_at, seconds_after_grad, open_price_sol, label_price_sol, ret_pct, is_winner)
      VALUES (@id, @mint, @now, @sec, @open, @price, @ret, @win)
    `);
    const done: number[] = [];
    for (const r of rows) {
      // Droppable tier: if the limiter is busy, skip — the window gives hours of retries.
      if (!(await globalRpcLimiter.throttleOrDrop(8, 'winner_label'))) break;
      let pk: PublicKey;
      try { pk = new PublicKey(r.pool); } catch { continue; }
      let info;
      try { info = await conn.getAccountInfo(pk); } catch { continue; }
      if (!info || info.data.length < POOL_QUOTE_VAULT_OFFSET + 32) continue;
      const baseVault = new PublicKey(info.data.subarray(POOL_BASE_VAULT_OFFSET, POOL_BASE_VAULT_OFFSET + 32)).toBase58();
      const quoteVault = new PublicKey(info.data.subarray(POOL_QUOTE_VAULT_OFFSET, POOL_QUOTE_VAULT_OFFSET + 32)).toBase58();
      if (!(await globalRpcLimiter.throttleOrDrop(8, 'winner_label'))) break;
      const price = await fetchVaultPrice(conn, baseVault, quoteVault);
      if (!price || price.priceSol <= 0) continue;
      const retPct = (price.priceSol / r.open_price - 1) * 100;
      try {
        insert.run({
          id: r.id, mint: r.mint, now, sec: now - r.ts, open: r.open_price,
          price: price.priceSol, ret: +retPct.toFixed(2),
          win: retPct >= WINNER_SNIPER_CFG.minRetPct ? 1 : 0,
        });
        done.push(r.id);
      } catch { /* raced */ }
    }
    if (done.length) logger.info('labeled %d graduations', done.length);
    return done;
  }

  /** Credit the 0-30s buyers of each newly labeled graduation (pure SQL, zero RPC). */
  private credit(gradIds: number[], now: number): void {
    const buyersStmt = this.db.prepare(`
      SELECT wallet_address AS w, SUM(amount_sol) AS sol
      FROM competition_signals
      WHERE graduation_id = ? AND action = 'buy' AND wallet_address IS NOT NULL
        AND COALESCE(is_likely_bot, 0) = 0
      GROUP BY wallet_address
      ORDER BY sol DESC
      LIMIT ${WINNER_SNIPER_CFG.creditCap}
    `);
    const labelStmt = this.db.prepare(`SELECT is_winner FROM winner_labels WHERE graduation_id = ?`);
    const upsert = this.db.prepare(`
      INSERT INTO winner_sniper_tally (address, appearances, winner_hits, score, last_update, last_hit_ts)
      VALUES (@a, 1, @hit, @hit, @now, CASE WHEN @hit = 1 THEN @now ELSE NULL END)
      ON CONFLICT(address) DO UPDATE SET
        appearances = appearances + 1,
        winner_hits = winner_hits + @hit,
        score = score * POWER(2, -MAX(0, @now - last_update) / 3600.0 / @hl) + @hit,
        last_update = @now,
        last_hit_ts = CASE WHEN @hit = 1 THEN @now ELSE last_hit_ts END
    `);
    const tx = this.db.transaction(() => {
      for (const id of gradIds) {
        const lab = labelStmt.get(id) as { is_winner: number } | undefined;
        if (!lab) continue;
        const buyers = buyersStmt.all(id) as Array<{ w: string; sol: number }>;
        for (const b of buyers) {
          upsert.run({ a: b.w, hit: lab.is_winner ? 1 : 0, now, hl: WINNER_SNIPER_CFG.halfLifeHours });
        }
      }
    });
    try { tx(); } catch (err) {
      logger.warn('credit failed: %s', err instanceof Error ? err.message : String(err));
    }
  }

  /** Promote wallets clearing the precision + decayed-score bar into the scorer's queue. */
  private promote(now: number): void {
    try {
      const rows = this.db.prepare(`
        SELECT t.address, t.appearances, t.winner_hits, t.score, t.last_update
        FROM winner_sniper_tally t
        LEFT JOIN wallet_candidates wc ON wc.address = t.address
        WHERE wc.address IS NULL AND t.winner_hits >= @minHits
      `).all({ minHits: WINNER_SNIPER_CFG.minHits }) as Array<{
        address: string; appearances: number; winner_hits: number; score: number; last_update: number;
      }>;
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO wallet_candidates (address, first_seen, source) VALUES (?, ?, 'winner_sniper')`,
      );
      let promoted = 0;
      for (const r of rows) {
        const precision = r.winner_hits / Math.max(1, r.appearances);
        if (precision < WINNER_SNIPER_CFG.minPrecision) continue;
        if (decayed(r.score, r.last_update, now) < WINNER_SNIPER_CFG.minScore) continue;
        insert.run(r.address, now);
        promoted += 1;
      }
      if (promoted) logger.info('promoted %d winner-sniper wallets to the scorer', promoted);
    } catch (err) {
      logger.warn('promote failed: %s', err instanceof Error ? err.message : String(err));
    }
  }

  /** Bound the tally: drop wallets whose decayed score is dust and last hit is old. */
  private evict(now: number): void {
    try {
      const cutoff = now - 7 * 86_400;
      this.db.prepare(`
        DELETE FROM winner_sniper_tally
        WHERE score * POWER(2, -MAX(0, @now - last_update) / 3600.0 / @hl) < 0.05
          AND COALESCE(last_hit_ts, 0) < @cutoff
      `).run({ now, hl: WINNER_SNIPER_CFG.halfLifeHours, cutoff });
    } catch { /* best-effort */ }
  }
}

/** Funnel summary for copy-trades.json — labels, winners, tally, promotion state. */
export function getWinnerSniperSummary(db: Database.Database): unknown {
  const now = Math.floor(Date.now() / 1000);
  try {
    const labels = db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(is_winner), 0) AS winners FROM winner_labels`,
    ).get() as { n: number; winners: number };
    const tally = db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN winner_hits >= ${WINNER_SNIPER_CFG.minHits} THEN 1 ELSE 0 END), 0) AS multi_hit
       FROM winner_sniper_tally`,
    ).get() as { n: number; multi_hit: number };
    const promotedRow = db.prepare(
      `SELECT COUNT(*) AS n FROM wallet_candidates WHERE source = 'winner_sniper'`,
    ).get() as { n: number };
    const top = (db.prepare(`
      SELECT address, appearances, winner_hits, score, last_update, last_hit_ts
      FROM winner_sniper_tally WHERE winner_hits >= 1
      ORDER BY winner_hits DESC, score DESC LIMIT 10
    `).all() as Array<{ address: string; appearances: number; winner_hits: number; score: number; last_update: number; last_hit_ts: number | null }>)
      .map((r) => ({
        address: r.address,
        appearances: r.appearances,
        winner_hits: r.winner_hits,
        precision: +(r.winner_hits / Math.max(1, r.appearances)).toFixed(3),
        decayed_score: +decayed(r.score, r.last_update, now).toFixed(3),
        last_hit_hours_ago: r.last_hit_ts ? +((now - r.last_hit_ts) / 3600).toFixed(1) : null,
      }));
    return {
      note:
        'Winner-sniper discovery (operator thesis 2026-07-02): label grads WIN/LOSS at ~T+30m (2 cheap reads each), ' +
        'credit 0-30s buyers from competition_signals (free), rank by winner-hit precision with a ' +
        `${WINNER_SNIPER_CFG.halfLifeHours}h half-life. Promotion bar: hits>=${WINNER_SNIPER_CFG.minHits}, ` +
        `precision>=${WINNER_SNIPER_CFG.minPrecision}, decayed score>=${WINNER_SNIPER_CFG.minScore}. ` +
        'Probe P&L + verdict live in discovery_scorecard (source=winner_sniper).',
      config: WINNER_SNIPER_CFG,
      graduations_labeled: labels.n,
      winners: labels.winners,
      wallets_tallied: tally.n,
      wallets_multi_hit: tally.multi_hit,
      promoted_candidates: promotedRow.n,
      top_snipers: top,
    };
  } catch {
    return { note: 'winner-sniper tables not yet created (harvester has not started)' };
  }
}
