import Database from 'better-sqlite3';
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchVaultPrice } from '../trading/executor';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('winner-sniper');

/**
 * Winner-sniper harvester (discovery source 'winner_sniper', 2026-07-02 — operator thesis,
 * S2+S3 fused; observation upgraded to a minute-cadence path 2026-07-03 on operator request).
 * Finds wallets that repeatedly buy INTO the graduations that go on to win, before they win —
 * then hands them to the existing FIFO scorer.
 *
 * THE THESIS: "top tokens first": watch each graduation's price for its first ~20 minutes,
 * label it WIN/LOSS from the OBSERVED PATH (not a single endpoint), credit EVERY wallet that
 * bought it ANYWHERE in that window (operator 2026-07-03 — not just the 0-30s snipers: a wallet
 * that dips in at minute 9 of a winner is exactly as interesting), and rank wallets by winner-hit
 * PRECISION with a fast time decay. Buyers = the free 0-30s competition_signals UNION a capped
 * sample of pool-vault swap signers across the whole window. Profit itself is NOT judged here —
 * the FIFO scorer verifies real PnL on the shortlist; this source just POINTS scoring at wallets
 * that keep showing up on winners.
 *
 * OBSERVATION (operator-specified): one price check per minute for OBS_CHECKS minutes
 * (default 20 checks over T+1m..T+20m). A single T+30m snapshot misses the shape — a token
 * that spikes +80% at minute 8 and dies by minute 30 was a real, bankable winner; one that
 * limps to +50% at minute 30 on no path is a weaker signal. WIN requires BOTH:
 *   peak_ret >= minRetPct  AND  >= minSustainChecks checks at/above minRetPct
 * (3 minutes above the bar = a real exit window a copier could have used, not a one-tick
 * wick). The full minute path is stored (path_json) so the bar can be recalibrated from data
 * later without re-collecting.
 *
 * WHY PRECISION (hits ÷ appearances), NOT RAW HITS: spray-bots buy EVERY graduation, so they
 * "hit" every winner too. The denominator is the whole signal.
 *
 * WHY FAST DECAY (half-life ~36h + eviction): the operator's observation, confirmed by the
 * book's own data (recency-gated hotlead beats every cumulative-reputation variant): good
 * wallets rotate fast. Score decays exponentially; a wallet that stops hitting falls off the
 * promotion bar within ~2 days.
 *
 * RPC COST: per graduation ≈ 1 vault-resolve + OBS_CHECKS price reads (~21) + full-window buyer
 * capture (≤ windowSigMaxPages signature pages + ≤ windowFetchCap parsed-tx reads, once at
 * finalize) ≈ ~60 reads, all on the DROPPABLE limiter tier ≈ 8-10k calls/day at current
 * graduation rates (~2% of the daily budget). Capture runs for BOTH winners and losers (the
 * precision denominator needs loser appearances too), capped so a firehose token can't blow the
 * budget. Profit verification remains with the FIFO scorer (the expensive step). NOTE: still a
 * bounded LABEL+CAPTURE path, not a revival of the retired dense research price-path.
 *
 * The probe strategy (copy-src-winner-sniper), quarantine routing, and scorecard verdict all
 * derive from the DISCOVERY_SOURCES registry row — see docs/discovery-playbook.md.
 */

const POOL_BASE_VAULT_OFFSET = 139; // matches PriceCollector / copy-trader
const POOL_QUOTE_VAULT_OFFSET = 171;

function numEnv(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] || '');
  return Number.isFinite(v) ? v : fallback;
}

export const WINNER_SNIPER_CFG = {
  /** A graduation is a WINNER when the path clears BOTH peak and sustain bars below. */
  minRetPct: numEnv('WINNER_MIN_RET_PCT', 50),
  /** Checks at/above minRetPct required (1-min cadence → minutes above the bar). */
  minSustainChecks: numEnv('WINNER_MIN_SUSTAIN_CHECKS', 3),
  /** First check at T+obsStartSec, then one per obsIntervalSec, obsChecks times. */
  obsStartSec: numEnv('WINNER_OBS_START_SEC', 60),
  obsIntervalSec: numEnv('WINNER_OBS_INTERVAL_SEC', 60),
  obsChecks: numEnv('WINNER_OBS_CHECKS', 20),
  /** Max new graduations enrolled per tick (bounds restart backfill bursts). */
  enrollBatch: numEnv('WINNER_ENROLL_BATCH', 20),
  /** Max distinct buyers credited per graduation (bounds tally writes). */
  creditCap: numEnv('WINNER_CREDIT_CAP', 60),
  /** Full-window buyer capture: max getParsedTransaction fetches per graduation (RPC bound). */
  windowFetchCap: numEnv('WINNER_WINDOW_FETCH_CAP', 80),
  /** Max getSignaturesForAddress pages (1000 sigs each) to page back through the window. */
  windowSigMaxPages: numEnv('WINNER_WINDOW_SIG_PAGES', 3),
  /** Decay half-life for the sniper score, hours. */
  halfLifeHours: numEnv('WINNER_SNIPER_HALFLIFE_H', 36),
  /** Promotion bar: >= minHits winner-hits AND precision >= minPrecision AND decayed score >= minScore. */
  minHits: numEnv('WINNER_SNIPER_MIN_HITS', 2),
  minPrecision: numEnv('WINNER_SNIPER_MIN_PRECISION', 0.25),
  minScore: numEnv('WINNER_SNIPER_MIN_SCORE', 0.5),
  /** Tick must match the check cadence (one observation pass per interval). */
  tickMs: numEnv('WINNER_SNIPER_TICK_MS', 60 * 1000),
};

/** End of a graduation's observation window, seconds after graduation. */
function obsWindowEndSec(): number {
  return WINNER_SNIPER_CFG.obsStartSec + WINNER_SNIPER_CFG.obsIntervalSec * WINNER_SNIPER_CFG.obsChecks;
}

/** Apply exponential decay to a stored score across (now - lastUpdate). */
function decayed(score: number, lastUpdate: number, now: number): number {
  const dtH = Math.max(0, now - lastUpdate) / 3600;
  return score * Math.pow(2, -dtH / WINNER_SNIPER_CFG.halfLifeHours);
}

interface ObsRow {
  graduation_id: number;
  mint: string;
  base_vault: string;
  quote_vault: string;
  open_price_sol: number;
  grad_ts: number;
  n_checks: number;
  path_json: string;
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
      'WinnerSniperHarvester started: %d checks @ %ds from T+%ds, WIN = peak>=+%d%% & >=%d checks above, half-life %dh, promote at hits>=%d & precision>=%s',
      WINNER_SNIPER_CFG.obsChecks, WINNER_SNIPER_CFG.obsIntervalSec, WINNER_SNIPER_CFG.obsStartSec,
      WINNER_SNIPER_CFG.minRetPct, WINNER_SNIPER_CFG.minSustainChecks,
      WINNER_SNIPER_CFG.halfLifeHours, WINNER_SNIPER_CFG.minHits, WINNER_SNIPER_CFG.minPrecision,
    );
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS winner_obs (
        graduation_id INTEGER PRIMARY KEY REFERENCES graduations(id),
        mint TEXT,
        base_vault TEXT NOT NULL,
        quote_vault TEXT NOT NULL,
        open_price_sol REAL NOT NULL,
        grad_ts INTEGER NOT NULL,
        n_checks INTEGER NOT NULL DEFAULT 0,
        path_json TEXT NOT NULL DEFAULT '[]'   -- [{s: secondsAfterGrad, r: retPct}, ...]
      );
      CREATE TABLE IF NOT EXISTS winner_labels (
        graduation_id INTEGER PRIMARY KEY REFERENCES graduations(id),
        mint TEXT,
        checked_at INTEGER NOT NULL,
        open_price_sol REAL,
        peak_ret_pct REAL,
        final_ret_pct REAL,
        time_to_peak_sec INTEGER,
        sustained_checks INTEGER,              -- checks at/above minRetPct
        checks_done INTEGER,
        path_json TEXT,                        -- full minute path, for post-hoc recalibration
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
    await this.enroll(now);
    await this.observe(now);
    await this.finalizeAndCredit(now);
    this.promote(now);
    this.evict(now);
  }

  /** Enroll graduations entering their observation window: resolve pool vaults once (1 read). */
  private async enroll(now: number): Promise<void> {
    let rows: Array<{ id: number; mint: string; pool: string; open_price: number; ts: number }> = [];
    try {
      rows = this.db.prepare(`
        SELECT g.id, g.mint, g.new_pool_address AS pool, gm.open_price_sol AS open_price, g.timestamp AS ts
        FROM graduations g
        JOIN graduation_momentum gm ON gm.graduation_id = g.id
        LEFT JOIN winner_obs wo ON wo.graduation_id = g.id
        LEFT JOIN winner_labels wl ON wl.graduation_id = g.id
        WHERE wo.graduation_id IS NULL AND wl.graduation_id IS NULL
          AND g.new_pool_address IS NOT NULL
          AND gm.open_price_sol > 0
          AND (@now - g.timestamp) BETWEEN @start AND @end
        ORDER BY g.timestamp ASC
        LIMIT @batch
      `).all({
        now, start: WINNER_SNIPER_CFG.obsStartSec, end: obsWindowEndSec(),
        batch: WINNER_SNIPER_CFG.enrollBatch,
      }) as typeof rows;
    } catch (err) {
      logger.warn('enroll query failed: %s', err instanceof Error ? err.message : String(err));
      return;
    }
    if (!rows.length) return;
    const conn = this.getConnection();
    if (!conn) return;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO winner_obs
        (graduation_id, mint, base_vault, quote_vault, open_price_sol, grad_ts, n_checks, path_json)
      VALUES (@id, @mint, @bv, @qv, @open, @ts, 0, '[]')
    `);
    for (const r of rows) {
      if (!(await globalRpcLimiter.throttleOrDrop(8, 'winner_label'))) break;
      let pk: PublicKey;
      try { pk = new PublicKey(r.pool); } catch { continue; }
      let info;
      try { info = await conn.getAccountInfo(pk); } catch { continue; }
      if (!info || info.data.length < POOL_QUOTE_VAULT_OFFSET + 32) continue;
      const bv = new PublicKey(info.data.subarray(POOL_BASE_VAULT_OFFSET, POOL_BASE_VAULT_OFFSET + 32)).toBase58();
      const qv = new PublicKey(info.data.subarray(POOL_QUOTE_VAULT_OFFSET, POOL_QUOTE_VAULT_OFFSET + 32)).toBase58();
      try { insert.run({ id: r.id, mint: r.mint, bv, qv, open: r.open_price, ts: r.ts }); } catch { /* raced */ }
    }
  }

  /** One price check per enrolled graduation per tick (1 read each, droppable tier). */
  private async observe(now: number): Promise<void> {
    let rows: ObsRow[] = [];
    try {
      rows = this.db.prepare(`
        SELECT graduation_id, mint, base_vault, quote_vault, open_price_sol, grad_ts, n_checks, path_json
        FROM winner_obs
        WHERE n_checks < @maxChecks AND (@now - grad_ts) <= @end
      `).all({ now, maxChecks: WINNER_SNIPER_CFG.obsChecks, end: obsWindowEndSec() }) as ObsRow[];
    } catch { return; }
    if (!rows.length) return;
    const conn = this.getConnection();
    if (!conn) return;
    const update = this.db.prepare(
      `UPDATE winner_obs SET n_checks = @n, path_json = @path WHERE graduation_id = @id`,
    );
    for (const r of rows) {
      if (!(await globalRpcLimiter.throttleOrDrop(8, 'winner_label'))) break;
      const price = await fetchVaultPrice(conn, r.base_vault, r.quote_vault);
      if (!price || price.priceSol <= 0) continue;
      const retPct = +((price.priceSol / r.open_price_sol - 1) * 100).toFixed(2);
      let path: Array<{ s: number; r: number }> = [];
      try { path = JSON.parse(r.path_json); } catch { path = []; }
      path.push({ s: now - r.grad_ts, r: retPct });
      try {
        update.run({ id: r.graduation_id, n: r.n_checks + 1, path: JSON.stringify(path) });
      } catch { /* best-effort */ }
    }
  }

  /**
   * Fold completed observations into winner_labels and credit their buyers. For each finalizing
   * graduation we gather the buyer set from the FULL observation window (operator 2026-07-03 —
   * ANY wallet that bought during the ~20min, not just the 0-30s snipers): the free 0-30s
   * competition_signals rows UNION a capped, strided sample of the pool-vault swap signatures
   * across the whole window. Both WINNERS and LOSERS credit their buyers (losers only bump the
   * appearances denominator — that's what makes precision = winner_hits/appearances meaningful).
   * The RPC (signature + parsed-tx reads) happens OUTSIDE the DB transaction; the write is one
   * sync tx. async because of the buyer capture.
   */
  private async finalizeAndCredit(now: number): Promise<void> {
    let rows: ObsRow[] = [];
    try {
      rows = this.db.prepare(`
        SELECT graduation_id, mint, base_vault, quote_vault, open_price_sol, grad_ts, n_checks, path_json
        FROM winner_obs
        WHERE n_checks >= @maxChecks OR (@now - grad_ts) > @end
      `).all({ now, maxChecks: WINNER_SNIPER_CFG.obsChecks, end: obsWindowEndSec() }) as ObsRow[];
    } catch { return; }
    if (!rows.length) return;

    // Phase 1 (async, no DB tx held): compute each label + gather its full-window buyer set.
    const prepared: Array<{
      row: ObsRow; peak: number; ttp: number; sustained: number; final: number; win: number; buyers: string[];
    }> = [];
    for (const r of rows) {
      let path: Array<{ s: number; r: number }> = [];
      try { path = JSON.parse(r.path_json); } catch { path = []; }
      // Restart-gapped / zero-check paths still finalize honestly (checks_done reflects it).
      let peak = -Infinity; let ttp = 0;
      for (const p of path) { if (p.r > peak) { peak = p.r; ttp = p.s; } }
      if (!Number.isFinite(peak)) { peak = 0; ttp = 0; }
      const sustained = path.filter((p) => p.r >= WINNER_SNIPER_CFG.minRetPct).length;
      const final = path.length ? path[path.length - 1].r : 0;
      const win = peak >= WINNER_SNIPER_CFG.minRetPct && sustained >= WINNER_SNIPER_CFG.minSustainChecks ? 1 : 0;
      const buyers = await this.gatherWindowBuyers(r, now);
      prepared.push({ row: r, peak, ttp, sustained, final, win, buyers });
    }

    // Phase 2 (sync tx): write labels, credit distinct buyers, drop the obs rows.
    const insertLabel = this.db.prepare(`
      INSERT OR IGNORE INTO winner_labels
        (graduation_id, mint, checked_at, open_price_sol, peak_ret_pct, final_ret_pct,
         time_to_peak_sec, sustained_checks, checks_done, path_json, is_winner)
      VALUES (@id, @mint, @now, @open, @peak, @final, @ttp, @sustained, @checks, @path, @win)
    `);
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
    const del = this.db.prepare(`DELETE FROM winner_obs WHERE graduation_id = ?`);
    let labeled = 0; let winners = 0;
    const tx = this.db.transaction(() => {
      for (const p of prepared) {
        insertLabel.run({
          id: p.row.graduation_id, mint: p.row.mint, now, open: p.row.open_price_sol,
          peak: +p.peak.toFixed(2), final: p.final, ttp: p.ttp, sustained: p.sustained,
          checks: (() => { try { return JSON.parse(p.row.path_json).length; } catch { return 0; } })(),
          path: p.row.path_json, win: p.win,
        });
        for (const w of p.buyers) {
          upsert.run({ a: w, hit: p.win, now, hl: WINNER_SNIPER_CFG.halfLifeHours });
        }
        del.run(p.row.graduation_id);
        labeled += 1; winners += p.win;
      }
    });
    try { tx(); } catch (err) {
      logger.warn('finalize/credit failed: %s', err instanceof Error ? err.message : String(err));
      return;
    }
    if (labeled) logger.info('labeled %d graduations (%d winners) from observed paths', labeled, winners);
  }

  /**
   * Distinct buyers of a graduation across its FULL observation window: the free 0-30s
   * competition_signals rows UNION a capped, strided sample of pool-vault swap signers. Capped
   * at creditCap distinct wallets and windowFetchCap parsed-tx reads (droppable tier).
   */
  private async gatherWindowBuyers(r: ObsRow, now: number): Promise<string[]> {
    const buyers = new Set<string>();
    // Free: the 0-30s early buyers already captured at detection (non-bot).
    try {
      const early = this.db.prepare(`
        SELECT DISTINCT wallet_address AS w FROM competition_signals
        WHERE graduation_id = ? AND action = 'buy' AND wallet_address IS NOT NULL
          AND COALESCE(is_likely_bot, 0) = 0
      `).all(r.graduation_id) as Array<{ w: string }>;
      for (const e of early) buyers.add(e.w);
    } catch { /* competition_signals may be empty */ }

    // Paid: sample swap signers across the full window off the base-vault signatures.
    const conn = this.getConnection();
    if (conn) {
      const windowEnd = r.grad_ts + obsWindowEndSec();
      let sigs: Array<{ signature: string; blockTime: number | null | undefined }> = [];
      try {
        let before: string | undefined;
        for (let page = 0; page < WINNER_SNIPER_CFG.windowSigMaxPages; page++) {
          if (!(await globalRpcLimiter.throttleOrDrop(8, 'winner_buyers'))) break;
          const pg = await conn.getSignaturesForAddress(new PublicKey(r.base_vault), { limit: 1000, before });
          if (!pg.length) break;
          sigs.push(...pg.map((s) => ({ signature: s.signature, blockTime: s.blockTime })));
          const oldest = pg[pg.length - 1];
          before = oldest.signature;
          if ((oldest.blockTime ?? 0) < r.grad_ts) break; // paged past the window start
        }
      } catch { /* sig fetch failed — early buyers still credited */ }

      const inWindow = sigs.filter((s) => {
        const t = s.blockTime ?? 0;
        return t >= r.grad_ts && t <= windowEnd;
      });
      if (inWindow.length) {
        const stride = Math.max(1, Math.floor(inWindow.length / WINNER_SNIPER_CFG.windowFetchCap));
        let fetched = 0;
        for (let i = 0; i < inWindow.length && fetched < WINNER_SNIPER_CFG.windowFetchCap && buyers.size < WINNER_SNIPER_CFG.creditCap; i += stride) {
          if (!(await globalRpcLimiter.throttleOrDrop(8, 'winner_buyers'))) break;
          fetched += 1;
          try {
            const tx = await conn.getParsedTransaction(inWindow[i].signature, {
              commitment: 'confirmed', maxSupportedTransactionVersion: 0,
            });
            if (!tx || !tx.meta || tx.meta.err) continue;
            const keys = tx.transaction.message.accountKeys;
            const signer = typeof keys[0] === 'string' ? keys[0] : (keys[0] as { pubkey: PublicKey }).pubkey.toBase58();
            const solChange = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1_000_000_000;
            if (solChange < -0.01) buyers.add(signer); // net SOL out = a buy
          } catch { /* skip unparseable tx */ }
        }
      }
    }

    // Cap distinct buyers written per graduation.
    return [...buyers].slice(0, WINNER_SNIPER_CFG.creditCap);
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

/** Funnel summary for copy-trades.json — observation, labels, tally, promotion state. */
export function getWinnerSniperSummary(db: Database.Database): unknown {
  const now = Math.floor(Date.now() / 1000);
  try {
    const obs = db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(AVG(n_checks), 0) AS avg_checks FROM winner_obs`,
    ).get() as { n: number; avg_checks: number };
    const labels = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(is_winner), 0) AS winners,
             COALESCE(AVG(checks_done), 0) AS avg_checks,
             COALESCE(AVG(peak_ret_pct), 0) AS avg_peak
      FROM winner_labels
    `).get() as { n: number; winners: number; avg_checks: number; avg_peak: number };
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
        'Winner-sniper discovery (operator thesis 2026-07-02, path observation 2026-07-03): watch each ' +
        `graduation ${WINNER_SNIPER_CFG.obsChecks}x @ ${WINNER_SNIPER_CFG.obsIntervalSec}s from T+${WINNER_SNIPER_CFG.obsStartSec}s; ` +
        `WIN = peak >= +${WINNER_SNIPER_CFG.minRetPct}% AND >= ${WINNER_SNIPER_CFG.minSustainChecks} checks above the bar. ` +
        'Credit EVERY buyer across the full window (0-30s competition_signals UNION sampled pool-vault swap signers), rank by winner-hit precision with a ' +
        `${WINNER_SNIPER_CFG.halfLifeHours}h half-life. Promotion bar: hits>=${WINNER_SNIPER_CFG.minHits}, ` +
        `precision>=${WINNER_SNIPER_CFG.minPrecision}, decayed score>=${WINNER_SNIPER_CFG.minScore}. ` +
        'Probe P&L + verdict live in discovery_scorecard (source=winner_sniper).',
      config: WINNER_SNIPER_CFG,
      observing_now: obs.n,
      observing_avg_checks: +obs.avg_checks.toFixed(1),
      graduations_labeled: labels.n,
      winners: labels.winners,
      label_avg_checks: +labels.avg_checks.toFixed(1),
      label_avg_peak_ret_pct: +labels.avg_peak.toFixed(1),
      wallets_tallied: tally.n,
      wallets_multi_hit: tally.multi_hit,
      promoted_candidates: promotedRow.n,
      top_snipers: top,
    };
  } catch {
    return { note: 'winner-sniper tables not yet created (harvester has not started)' };
  }
}
