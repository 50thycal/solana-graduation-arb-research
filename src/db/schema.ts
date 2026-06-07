import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('db-schema');

export function initDatabase(dataDir: string): Database.Database {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'graduation-arb.db');
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read/write performance
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  logger.info({ dbPath }, 'Database initialized');
  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graduations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      signature TEXT NOT NULL UNIQUE,
      slot INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      bonding_curve_address TEXT,
      final_price_sol REAL,
      final_sol_reserves REAL,
      final_token_reserves REAL,
      virtual_sol_reserves REAL,
      virtual_token_reserves REAL,
      new_pool_address TEXT,
      new_pool_dex TEXT,
      migration_signature TEXT,
      migration_slot INTEGER,
      migration_timestamp INTEGER,
      observation_complete INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_graduations_mint ON graduations(mint);
    CREATE INDEX IF NOT EXISTS idx_graduations_timestamp ON graduations(timestamp);

    CREATE TABLE IF NOT EXISTS pool_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      graduation_id INTEGER NOT NULL REFERENCES graduations(id),
      timestamp INTEGER NOT NULL,
      seconds_since_graduation REAL NOT NULL,
      pool_price_sol REAL,
      pool_sol_reserves REAL,
      pool_token_reserves REAL,
      pool_liquidity_usd REAL,
      jupiter_price_sol REAL,
      tx_count_since_graduation INTEGER,
      buy_count INTEGER,
      sell_count INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_pool_obs_grad ON pool_observations(graduation_id);

    -- Per-swap log across the post-graduation window (0..300s). Populated via
    -- T+305 backfill from getSignaturesForAddress(poolAddress). Used by the
    -- whale-sell / liquidity-drop exit strategy (see api/exit-sim.ts whale_liq).
    CREATE TABLE IF NOT EXISTS post_grad_swaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      graduation_id INTEGER NOT NULL REFERENCES graduations(id),
      tx_signature TEXT NOT NULL,
      block_time INTEGER NOT NULL,
      seconds_since_graduation INTEGER NOT NULL,
      wallet_address TEXT,
      action TEXT,
      amount_sol REAL,
      amount_token REAL,
      pool_sol_after REAL,
      UNIQUE(graduation_id, tx_signature)
    );

    CREATE INDEX IF NOT EXISTS idx_post_grad_swaps_grad_time
      ON post_grad_swaps(graduation_id, seconds_since_graduation);

    CREATE TABLE IF NOT EXISTS price_comparisons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      graduation_id INTEGER NOT NULL REFERENCES graduations(id),
      timestamp INTEGER NOT NULL,
      seconds_since_graduation REAL NOT NULL,
      bonding_curve_price REAL,
      dex_pool_price REAL,
      jupiter_price REAL,
      bc_to_dex_spread_pct REAL,
      bc_to_jupiter_spread_pct REAL,
      dex_to_jupiter_spread_pct REAL
    );

    CREATE INDEX IF NOT EXISTS idx_price_comp_grad ON price_comparisons(graduation_id);

    CREATE TABLE IF NOT EXISTS opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      graduation_id INTEGER NOT NULL REFERENCES graduations(id),
      max_spread_pct REAL,
      max_spread_timestamp INTEGER,
      seconds_to_max_spread REAL,
      duration_above_05_pct REAL,
      duration_above_1_pct REAL,
      duration_above_2_pct REAL,
      spread_collapse_seconds REAL,
      estimated_profit_sol REAL,
      estimated_gas_sol REAL,
      estimated_jito_tip_sol REAL,
      estimated_slippage_pct REAL,
      net_profit_sol REAL,
      is_fillable INTEGER,
      available_liquidity_sol REAL,
      competition_tx_count_10s INTEGER,
      viability_score REAL,
      classification TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_opp_grad ON opportunities(graduation_id);

    CREATE TABLE IF NOT EXISTS paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      graduation_id INTEGER NOT NULL REFERENCES graduations(id),
      entry_timestamp INTEGER,
      entry_price_sol REAL,
      entry_seconds_after_graduation REAL,
      exit_timestamp INTEGER,
      exit_price_sol REAL,
      exit_seconds_after_graduation REAL,
      trade_size_sol REAL,
      gross_profit_sol REAL,
      estimated_fees_sol REAL,
      net_profit_sol REAL,
      net_profit_pct REAL,
      exit_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS competition_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      graduation_id INTEGER NOT NULL REFERENCES graduations(id),
      timestamp INTEGER NOT NULL,
      seconds_since_graduation REAL,
      tx_signature TEXT,
      wallet_address TEXT,
      action TEXT,
      amount_sol REAL,
      is_likely_bot INTEGER
    );

    -- Momentum research: one row per graduation with T+0 context and price checkpoints
    CREATE TABLE IF NOT EXISTS graduation_momentum (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      graduation_id INTEGER NOT NULL UNIQUE REFERENCES graduations(id),
      -- T+0 context
      open_price_sol REAL,
      holder_count INTEGER,
      top5_wallet_pct REAL,
      dev_wallet_pct REAL,
      token_age_seconds INTEGER,
      total_sol_raised REAL,
      -- Price checkpoints (filled as snapshots arrive)
      price_t30 REAL,
      price_t60 REAL,
      price_t120 REAL,
      price_t300 REAL,
      price_t600 REAL,
      pct_t30 REAL,
      pct_t60 REAL,
      pct_t120 REAL,
      pct_t300 REAL,
      pct_t600 REAL,
      -- Label (T+300 horizon; label_t60 / label_t120 added via migration below)
      label TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_grad_momentum_label ON graduation_momentum(label);
  `);

  // Add granular momentum checkpoint columns (safe migration)
  {
    const momCols = db.prepare("PRAGMA table_info(graduation_momentum)").all() as Array<{ name: string }>;
    const momExisting = new Set(momCols.map(c => c.name));
    const newMomCols: Array<[string, string]> = [
      ['price_t10', 'REAL'], ['pct_t10', 'REAL'],
      ['price_t20', 'REAL'], ['pct_t20', 'REAL'],
      ['price_t40', 'REAL'], ['pct_t40', 'REAL'],
      ['price_t50', 'REAL'], ['pct_t50', 'REAL'],
      ['price_t90', 'REAL'], ['pct_t90', 'REAL'],
      ['price_t150', 'REAL'], ['pct_t150', 'REAL'],
      ['price_t180', 'REAL'], ['pct_t180', 'REAL'],
      ['price_t240', 'REAL'], ['pct_t240', 'REAL'],
      // Peak/drawdown metrics
      ['max_peak_pct', 'REAL'],       // highest pct change from open during observation
      ['max_peak_sec', 'INTEGER'],    // seconds since graduation when peak occurred
      ['max_drawdown_pct', 'REAL'],   // worst drop from peak (negative)
      ['max_drawdown_sec', 'INTEGER'],// seconds since graduation when max drawdown occurred
      ['max_relret_0_300', 'REAL'],       // peak %-return from T+30 entry during 0-300s window
      ['max_relret_0_300_sec', 'INTEGER'],// seconds since graduation when peak relret occurred
      // Trading readiness metrics (computed at T+30)
      ['volatility_0_30', 'REAL'],       // price range (max-min)/open as % in first 30s
      ['liquidity_sol_t30', 'REAL'],     // SOL reserves in pool at T+30
      ['slippage_est_05sol', 'REAL'],    // estimated slippage % for 0.5 SOL buy at T+30
      ['round_trip_slippage_pct', 'REAL'], // estimated round-trip slippage % (entry + exit, conservative: 2x entry)
      ['bc_velocity_sol_per_min', 'REAL'], // bonding curve fill rate (sol_raised / age in minutes)
      // 5s granular price snapshots (added for price path shape analysis)
      ['price_t5', 'REAL'],  ['pct_t5', 'REAL'],
      ['price_t15', 'REAL'], ['pct_t15', 'REAL'],
      ['price_t25', 'REAL'], ['pct_t25', 'REAL'],
      ['price_t35', 'REAL'], ['pct_t35', 'REAL'],
      ['price_t45', 'REAL'], ['pct_t45', 'REAL'],
      ['price_t55', 'REAL'], ['pct_t55', 'REAL'],
      // Derived path shape metrics (computed at T+30 and T+60)
      ['acceleration_t30', 'REAL'],    // (pct_t30-pct_t25) - (pct_t25-pct_t20): momentum acceleration at T+30
      ['acceleration_t60', 'REAL'],    // same logic at T+60
      ['monotonicity_0_30', 'REAL'],   // fraction of 5s intervals that were positive (0-1)
      ['monotonicity_0_60', 'REAL'],   // same for 0-60s window
      ['path_smoothness_0_30', 'REAL'],// std dev of the six 5s interval returns (0-30s)
      ['path_smoothness_0_60', 'REAL'],// same for 0-60s
      ['max_drawdown_0_30', 'REAL'],   // max peak-to-trough % drop within 0-30s (negative)
      ['max_drawdown_0_60', 'REAL'],   // same for 0-60s
      ['max_tick_drop_0_30', 'REAL'],  // worst single 5s-interval drop in pct points within 0-30s (≤ 0)
      ['sum_abs_returns_0_30', 'REAL'],// sum of |Δpct| across 5s intervals in 0-30s — realized vol proxy
      ['dip_and_recover_flag', 'INTEGER'], // 1 if price dropped >10% from running peak then recovered
      ['early_vs_late_0_30', 'REAL'],  // (pct_t15-pct_t0) - (pct_t30-pct_t15): positive = front-loaded
      ['early_vs_late_0_60', 'REAL'],  // (pct_t30-pct_t0) - (pct_t60-pct_t30): same for full window
      ['path_cluster', 'TEXT'],        // shape cluster label (populated later)
      // Buy pressure quality metrics (computed at T+35 from pool transactions in 0-30s window)
      ['buy_pressure_unique_buyers', 'INTEGER'],  // distinct wallets that bought in 0-30s
      ['buy_pressure_buy_ratio', 'REAL'],          // buys / (buys + sells) as 0-1
      ['buy_pressure_whale_pct', 'REAL'],          // largest single buy SOL / total buy SOL volume
      ['buy_pressure_trade_count', 'INTEGER'],     // total txs in 0-30s window (from signature count)
      // Sniper metrics (computed at T+35 from competition_signals in T+0..T+2s window).
      // Strategies that filter on these fields are auto-delayed by 5s in StrategyManager,
      // matching the buy_pressure_* pattern.
      ['sniper_count_t0_t2', 'INTEGER'],          // distinct wallets with a 'buy' signal in T+0..T+2s
      ['sniper_sol_t0_t2', 'REAL'],               // total SOL spent on T+0..T+2s 'buy' signals
      ['sniper_wallet_velocity_avg', 'REAL'],     // avg # of EARLIER graduations these snipers also sniped (T+0..T+2)
      ['sniper_wallet_velocity_max', 'INTEGER'],  // max # of earlier graduations any of these snipers sniped
      // Wallet address tracking
      ['dev_wallet_address', 'TEXT'],              // wallet address of largest non-infrastructure holder
      ['creator_wallet_address', 'TEXT'],          // wallet that deployed the token on pump.fun
      // Creator reputation scores (computed at enrichment time via self-join)
      ['creator_prior_token_count', 'INTEGER'],    // how many tokens this creator graduated before this one
      ['creator_prior_rug_rate', 'REAL'],          // fraction of prior tokens that dumped >50% by T+300
      ['creator_prior_avg_return', 'REAL'],        // avg pct_t300 of their prior tokens
      ['creator_last_token_age_hours', 'REAL'],    // hours since their last graduation
      // Multi-horizon labels (existing `label` column is the T+300 horizon).
      ['label_t60', 'TEXT'],                        // PUMP/DUMP/STABLE at T+60
      ['label_t120', 'TEXT'],                       // PUMP/DUMP/STABLE at T+120
      // B2 — PumpSwap initial pool depth at migration. Captured at T+0 by the
      // price-collector alongside the open-price write. NULL on historical rows
      // (impossible to backfill — pool state at migration is no longer readable).
      ['pumpswap_initial_lp_sol', 'REAL'],          // SOL reserves at first snapshot
      ['pumpswap_initial_lp_tokens', 'REAL'],       // token reserves at first snapshot
      ['pumpswap_initial_lp_capture_sec', 'INTEGER'], // elapsedSec when initial-LP was captured (0 = true T+0)
      ['pumpswap_lp_growth_t0_to_t30_pct', 'REAL'], // (liq_t30 - initial_lp) / initial_lp * 100
      // B4 — concurrent-graduation density + batch rank. Pure derivation from
      // graduations.created_at; populated synchronously at insertMomentum time
      // and backfilled at boot.
      ['graduation_density_5min', 'INTEGER'],       // count of grads in trailing 5 min including self
      ['batch_rank_within_5min', 'INTEGER'],        // 1-indexed rank by created_at within the 5-min window
      // B5 — buy/sell flow imbalance + VWAP at T+30. Computed at T+35 in
      // detectBuyPressure() from the same competition_signals window.
      ['flow_sol_buys_0_30', 'REAL'],               // total SOL across action='buy' txs in 0-30s
      ['flow_sol_sells_0_30', 'REAL'],              // total SOL across action='sell' txs in 0-30s
      ['flow_imbalance_t30', 'REAL'],               // (buys-sells) / total, range -1..+1
      ['vwap_0_30', 'REAL'],                        // SOL-weighted average price across 5s checkpoints in 0-30s
      ['price_vs_vwap_t30_pct', 'REAL'],            // (price_t30 - vwap_0_30) / vwap_0_30 * 100
      // B3 — first-buyer-priors flag. Populated at T+35; firstbuyer_priors backfilled
      // at boot via the same chronological pass as sniper_wallet_velocity_avg.
      ['firstbuyer_wallet', 'TEXT'],                // wallet of first non-bot action='buy' in T+0..T+5s
      ['firstbuyer_priors', 'INTEGER'],             // # earlier grads this wallet sniped (PRIOR-only)
      // C3 — wider holder concentration metrics. Same RPC as top5 (extends the
      // existing getTokenLargestAccounts result). NULL on historical rows
      // (raw holder lists weren't stored, so no backfill is possible).
      ['top10_wallet_pct', 'REAL'],                 // supply % held by top 10 wallets
      ['wallet_gini_top20', 'REAL'],                // Gini coefficient across top 20 wallets, 0..1
      // C5 — confirmed dip-and-recover flags. Pure derivation from existing
      // pct_t15/t30/t45 columns. Computed at T+45 snapshot time and backfilled
      // at boot. Strategies using these fields must set entryTimingSec=45 so
      // evaluation fires after the flags are populated.
      ['recovery_t30_above_t15', 'INTEGER'],        // 1 if pct_t30 > pct_t15
      ['recovery_t45_above_t30', 'INTEGER'],        // 1 if pct_t45 > pct_t30
      ['confirmed_dip_recovery', 'INTEGER'],        // 1 if dip_and_recover_flag=1 AND both above
      // Holder-count backfill marker. 1 = holder_count/top5/dev were re-resolved
      // AFTER graduation via the DAS getTokenAccounts backfill (current-state, not
      // graduation-time). Lets analysis exclude temporally-contaminated rows the
      // same way the look-ahead guardrail does for _t300 columns. NULL/0 = the
      // value is the original graduation-time enrichment.
      ['holder_count_backfilled', 'INTEGER'],
      // ── Full-distribution holder metrics (T+0, from the complete DAS list) ──
      // Only the DAS path can compute these; getTokenLargestAccounts (top 20) can't.
      ['nakamoto_coef', 'INTEGER'],       // min wallets controlling > 50% of supply
      ['holder_gini', 'REAL'],            // Gini across ALL holders (vs wallet_gini_top20)
      ['whale_count_1pct', 'INTEGER'],    // # wallets each holding > 1% of total supply
      ['whale_supply_pct', 'REAL'],       // true % of supply held by those whales
      ['dust_holder_pct', 'REAL'],        // fraction of holders with < 0.01% supply
      // ── Holder flow (second DAS sample at T+35) ──
      // holder_count_t35 + delta give the change in unique holders over the first
      // ~30s — a flow signal independent of the T+0 level. Look-ahead-safe (T+35 is
      // the same window buy_pressure_* uses; strategies must set entryTimingSec≥35).
      ['holder_count_t35', 'INTEGER'],    // unique holders re-counted at T+35
      ['holder_delta_t35', 'INTEGER'],    // holder_count_t35 - holder_count (signed)
      ['holder_velocity_t35', 'REAL'],    // holders gained per minute over the window
      ['holder_sniper_ratio', 'REAL'],    // holder_count / sniper_count_t0_t2
      // Copy-trade B: # distinct "money-edge" wallets (smart set, see
      // src/copytrade/queries.ts getSmartSet) that bought in the 0-30s window.
      // Computed live at T+35 in detectBuyPressure against the CURRENT smart set
      // (forward-only — historical rows stay NULL on purpose; backfilling would
      // be look-ahead since smart status is defined by realized P&L). Usable as a
      // strategy filter field; NOT added to FILTER_CATALOG to keep backtests clean.
      ['smart_money_early_count', 'INTEGER'],
    ];
    // Every-5s price snapshots across the full 300s monitoring window — dedupes against
    // explicit entries above (t5, t10, ..., t60, t90, t120, t150, t180, t240, t300).
    // Liquidity snapshots use the same grid — whale-sell / pool-drop exit rules need
    // sub-30s resolution because dumps usually complete in seconds, not minutes.
    {
      const planned = new Set(newMomCols.map(([c]) => c));
      for (let sec = 5; sec <= 300; sec += 5) {
        const priceCol = `price_t${sec}`;
        const pctCol = `pct_t${sec}`;
        const liqCol = `liquidity_sol_t${sec}`;
        if (!planned.has(priceCol)) newMomCols.push([priceCol, 'REAL']);
        if (!planned.has(pctCol)) newMomCols.push([pctCol, 'REAL']);
        if (!planned.has(liqCol)) newMomCols.push([liqCol, 'REAL']);
      }
    }
    // Path-shape metrics over longer horizons (0-120, 0-180, 0-300). Only populated
    // for graduations with the full every-5s snapshot grid — pre-rollout rows stay NULL.
    for (const win of [120, 180, 300] as const) {
      newMomCols.push([`acceleration_t${win}`, 'REAL']);
      newMomCols.push([`monotonicity_0_${win}`, 'REAL']);
      newMomCols.push([`path_smoothness_0_${win}`, 'REAL']);
      newMomCols.push([`max_drawdown_0_${win}`, 'REAL']);
      newMomCols.push([`early_vs_late_0_${win}`, 'REAL']);
    }
    for (const [col, type] of newMomCols) {
      if (!momExisting.has(col)) {
        db.exec(`ALTER TABLE graduation_momentum ADD COLUMN ${col} ${type}`);
      }
    }
    // Backfill round_trip_slippage_pct for rows that have slippage_est_05sol but no round_trip value.
    // round_trip = 2 * entry slippage (conservative: assumes exit cost equals entry cost).
    db.exec(`
      UPDATE graduation_momentum
      SET round_trip_slippage_pct = ROUND(slippage_est_05sol * 2, 3)
      WHERE slippage_est_05sol IS NOT NULL AND round_trip_slippage_pct IS NULL
    `);
    // Cap any existing bc_velocity_sol_per_min values > 500 (bot-rush / instant graduations).
    // New rows are capped at write time. This fixes pre-migration outliers that skew averages.
    db.exec(`
      UPDATE graduation_momentum
      SET bc_velocity_sol_per_min = 500
      WHERE bc_velocity_sol_per_min > 500
    `);
    // Backfill max_relret_0_300 / max_relret_0_300_sec from existing pct_tN checkpoints.
    // Formula mirrors src/index.ts:2617 (Panel 4 simulateInMemory):
    //   relret_N = ((1 + pct_tN/100) / (1 + pct_t30/100) - 1) * 100
    // SQLite can't cleanly do correlated MAX-of-UNION, so compute in JS.
    const backfillRows = db.prepare(`
      SELECT id, pct_t30,
             pct_t35, pct_t40, pct_t45, pct_t50, pct_t55, pct_t60,
             pct_t90, pct_t120, pct_t150, pct_t180, pct_t240, pct_t300
      FROM graduation_momentum
      WHERE max_relret_0_300 IS NULL
        AND pct_t30 IS NOT NULL
        AND pct_t300 IS NOT NULL
    `).all() as Array<Record<string, number | null>>;
    if (backfillRows.length > 0) {
      const updateStmt = db.prepare(
        `UPDATE graduation_momentum SET max_relret_0_300 = ?, max_relret_0_300_sec = ? WHERE id = ?`
      );
      const postEntry: Array<[string, number]> = [
        ['pct_t35', 35], ['pct_t40', 40], ['pct_t45', 45], ['pct_t50', 50],
        ['pct_t55', 55], ['pct_t60', 60], ['pct_t90', 90], ['pct_t120', 120],
        ['pct_t150', 150], ['pct_t180', 180], ['pct_t240', 240], ['pct_t300', 300],
      ];
      const tx = db.transaction((rows: typeof backfillRows) => {
        for (const r of rows) {
          const t30 = r.pct_t30;
          if (t30 == null) continue;
          const entryRatio = 1 + t30 / 100;
          if (entryRatio <= 0) continue;
          let maxRel = 0;
          let maxSec = 30;
          for (const [col, sec] of postEntry) {
            const v = r[col];
            if (v == null) continue;
            const rel = ((1 + v / 100) / entryRatio - 1) * 100;
            if (rel > maxRel) {
              maxRel = rel;
              maxSec = sec;
            }
          }
          updateStmt.run(+maxRel.toFixed(2), maxSec, r.id);
        }
      });
      tx(backfillRows);
    }

    // Backfill multi-horizon labels from pct_t60 / pct_t120.
    // Thresholds mirror src/analysis/momentum-labeler.ts: >=10% PUMP, <=-10% DUMP, else STABLE.
    db.exec(`
      UPDATE graduation_momentum
      SET label_t60 = CASE
            WHEN pct_t60 >= 10  THEN 'PUMP'
            WHEN pct_t60 <= -10 THEN 'DUMP'
            ELSE 'STABLE'
          END
      WHERE pct_t60 IS NOT NULL AND label_t60 IS NULL
    `);
    db.exec(`
      UPDATE graduation_momentum
      SET label_t120 = CASE
            WHEN pct_t120 >= 10  THEN 'PUMP'
            WHEN pct_t120 <= -10 THEN 'DUMP'
            ELSE 'STABLE'
          END
      WHERE pct_t120 IS NOT NULL AND label_t120 IS NULL
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_grad_momentum_label_t60  ON graduation_momentum(label_t60)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_grad_momentum_label_t120 ON graduation_momentum(label_t120)`);

    // Sniper-window index (used by both backfill and live writes — wallet
    // self-join is what makes wallet_velocity tractable). Idempotent.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_competition_signals_wallet ON competition_signals(wallet_address)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_grad_momentum_sniper_count ON graduation_momentum(sniper_count_t0_t2)`);

    // Backfill sniper_count_t0_t2 / sniper_sol_t0_t2 from competition_signals.
    // SQL alone since these are per-graduation aggregates with no cross-row
    // dependencies. Only touches rows where the column is still NULL.
    db.exec(`
      UPDATE graduation_momentum
      SET sniper_count_t0_t2 = (
            SELECT COUNT(DISTINCT wallet_address)
            FROM competition_signals cs
            WHERE cs.graduation_id = graduation_momentum.graduation_id
              AND cs.action = 'buy'
              AND cs.seconds_since_graduation >= 0
              AND cs.seconds_since_graduation <= 2
              AND cs.wallet_address IS NOT NULL
          ),
          sniper_sol_t0_t2 = (
            SELECT COALESCE(SUM(amount_sol), 0)
            FROM competition_signals cs
            WHERE cs.graduation_id = graduation_momentum.graduation_id
              AND cs.action = 'buy'
              AND cs.seconds_since_graduation >= 0
              AND cs.seconds_since_graduation <= 2
              AND cs.amount_sol IS NOT NULL
          )
      WHERE sniper_count_t0_t2 IS NULL
        AND graduation_id IN (
          SELECT DISTINCT graduation_id FROM competition_signals
          WHERE seconds_since_graduation >= 0 AND seconds_since_graduation <= 2
        )
    `);

    // Backfill wallet velocity in JS — chronological pass keeps this O(n_signals)
    // instead of O(n²) self-joins. For each graduation in id-asc order, look up
    // each sniper wallet's accumulated prior count, average + max, then increment
    // the wallet's count. PRIOR-only by construction (counter increments AFTER
    // recording) — matches what would have been knowable at trade time.
    // bot_settings is created lower in this function; ensure it exists first
    // so the backfill marker check works on first boot.
    db.exec(`
      CREATE TABLE IF NOT EXISTS bot_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER DEFAULT (unixepoch())
      )
    `);
    const velAlreadyDone = db.prepare(`SELECT 1 FROM bot_settings WHERE key = ?`)
      .get('sniper_wallet_velocity_backfill_v1') != null;
    if (!velAlreadyDone) {
      const snipers = db.prepare(`
        SELECT graduation_id, wallet_address
        FROM competition_signals
        WHERE action = 'buy'
          AND seconds_since_graduation >= 0
          AND seconds_since_graduation <= 2
          AND wallet_address IS NOT NULL
        GROUP BY graduation_id, wallet_address
        ORDER BY graduation_id ASC
      `).all() as Array<{ graduation_id: number; wallet_address: string }>;

      // Group rows by graduation_id while preserving chronological order
      const byGrad = new Map<number, string[]>();
      for (const r of snipers) {
        if (!byGrad.has(r.graduation_id)) byGrad.set(r.graduation_id, []);
        byGrad.get(r.graduation_id)!.push(r.wallet_address);
      }

      const walletPriorCount = new Map<string, number>();
      const updateStmt = db.prepare(`
        UPDATE graduation_momentum
        SET sniper_wallet_velocity_avg = ?,
            sniper_wallet_velocity_max = ?
        WHERE graduation_id = ?
      `);

      const tx = db.transaction(() => {
        for (const [gid, wallets] of byGrad) {
          let sum = 0;
          let max = 0;
          for (const w of wallets) {
            const c = walletPriorCount.get(w) ?? 0;
            sum += c;
            if (c > max) max = c;
          }
          const avg = wallets.length > 0 ? sum / wallets.length : 0;
          updateStmt.run(+avg.toFixed(3), max, gid);
          // Increment AFTER recording so this graduation's sniper count
          // doesn't include itself in its own prior.
          for (const w of wallets) {
            walletPriorCount.set(w, (walletPriorCount.get(w) ?? 0) + 1);
          }
        }
      });
      tx();

      db.prepare(`INSERT OR REPLACE INTO bot_settings (key, value, updated_at) VALUES (?, ?, unixepoch())`)
        .run('sniper_wallet_velocity_backfill_v1', String(byGrad.size));
      logger.info({ graduationsUpdated: byGrad.size, snipers: snipers.length }, 'Backfilled sniper wallet velocity (chronological)');
    }

    // ── B4 backfill: graduation_density_5min + batch_rank_within_5min ──
    // Pure derivation from graduations.timestamp. Idempotent — only touches
    // rows where graduation_density_5min IS NULL. Single self-correlated UPDATE.
    db.exec(`
      UPDATE graduation_momentum AS gm
      SET graduation_density_5min = (
            SELECT COUNT(*) FROM graduations g2
            JOIN graduations g1 ON g1.id = gm.graduation_id
            WHERE g2.timestamp BETWEEN (g1.timestamp - 300) AND g1.timestamp
          ),
          batch_rank_within_5min = (
            SELECT COUNT(*) FROM graduations g2
            JOIN graduations g1 ON g1.id = gm.graduation_id
            WHERE g2.timestamp BETWEEN (g1.timestamp - 300) AND g1.timestamp
              AND g2.id <= g1.id
          )
      WHERE gm.graduation_density_5min IS NULL
    `);

    // ── B3 backfill: firstbuyer_wallet + firstbuyer_priors ──
    // Chronological pass like sniper_wallet_velocity_avg. Bounded by a
    // bot_settings marker so it runs once per release. Skip if there are no
    // existing competition_signals rows (clean DB).
    const fbAlreadyDone = db.prepare(`SELECT 1 FROM bot_settings WHERE key = ?`)
      .get('firstbuyer_priors_backfill_v1') != null;
    if (!fbAlreadyDone) {
      // Per-grad: pick the earliest non-bot 'buy' in T+0..T+5s. is_likely_bot may
      // be NULL on rows from before that flag landed — treat NULL as "not bot".
      const firstBuyers = db.prepare(`
        SELECT cs.graduation_id, cs.wallet_address
        FROM competition_signals cs
        INNER JOIN (
          SELECT graduation_id, MIN(seconds_since_graduation) AS first_sec
          FROM competition_signals
          WHERE action = 'buy'
            AND seconds_since_graduation >= 0
            AND seconds_since_graduation <= 5
            AND wallet_address IS NOT NULL
            AND (is_likely_bot IS NULL OR is_likely_bot = 0)
          GROUP BY graduation_id
        ) f ON f.graduation_id = cs.graduation_id AND f.first_sec = cs.seconds_since_graduation
        WHERE cs.action = 'buy'
          AND cs.wallet_address IS NOT NULL
          AND (cs.is_likely_bot IS NULL OR cs.is_likely_bot = 0)
        GROUP BY cs.graduation_id
        ORDER BY cs.graduation_id ASC
      `).all() as Array<{ graduation_id: number; wallet_address: string }>;

      const walletPriorCount = new Map<string, number>();
      const updateStmt = db.prepare(`
        UPDATE graduation_momentum
        SET firstbuyer_wallet = ?, firstbuyer_priors = ?
        WHERE graduation_id = ?
      `);
      const tx = db.transaction(() => {
        for (const r of firstBuyers) {
          const priors = walletPriorCount.get(r.wallet_address) ?? 0;
          updateStmt.run(r.wallet_address, priors, r.graduation_id);
          walletPriorCount.set(r.wallet_address, priors + 1);
        }
      });
      tx();

      db.prepare(`INSERT OR REPLACE INTO bot_settings (key, value, updated_at) VALUES (?, ?, unixepoch())`)
        .run('firstbuyer_priors_backfill_v1', String(firstBuyers.length));
      logger.info({ graduationsUpdated: firstBuyers.length }, 'Backfilled firstbuyer_priors (chronological)');
    }

    // ── B5 backfill: flow_imbalance + VWAP ──
    // Pure SQL aggregate over competition_signals (no chronological dependency).
    // Computed in JS for each row that still has a NULL flow_imbalance_t30, calling
    // the same computeFlowAndVwap helper used at live time.
    const fvAlreadyDone = db.prepare(`SELECT 1 FROM bot_settings WHERE key = ?`)
      .get('flow_vwap_backfill_v1') != null;
    if (!fvAlreadyDone) {
      // Lazy-require to avoid circular import (queries.ts depends on schema.ts at load time).
      const { computeFlowAndVwap, updateMomentumFlowVwap } = require('./queries') as typeof import('./queries');
      const rowsToFill = db.prepare(`
        SELECT graduation_id
        FROM graduation_momentum
        WHERE flow_imbalance_t30 IS NULL
          AND graduation_id IN (SELECT DISTINCT graduation_id FROM competition_signals)
      `).all() as Array<{ graduation_id: number }>;

      const tx = db.transaction(() => {
        for (const r of rowsToFill) {
          try {
            const m = computeFlowAndVwap(db, r.graduation_id);
            updateMomentumFlowVwap(db, r.graduation_id, m);
          } catch {
            // skip rows where the helper fails (e.g. missing price_t* snapshots)
          }
        }
      });
      tx();

      db.prepare(`INSERT OR REPLACE INTO bot_settings (key, value, updated_at) VALUES (?, ?, unixepoch())`)
        .run('flow_vwap_backfill_v1', String(rowsToFill.length));
      logger.info({ graduationsUpdated: rowsToFill.length }, 'Backfilled flow_imbalance + vwap_0_30');
    }

    // ── C5 backfill: recovery_t30_above_t15 / recovery_t45_above_t30 / confirmed_dip_recovery ──
    // Pure derivation from pct_t15/t30/t45 (and existing dip_and_recover_flag).
    // Idempotent — only touches rows where confirmed_dip_recovery IS NULL and
    // all three pct checkpoints exist. Backfills historical rows for free.
    db.exec(`
      UPDATE graduation_momentum
      SET recovery_t30_above_t15 = CASE WHEN pct_t30 > pct_t15 THEN 1 ELSE 0 END,
          recovery_t45_above_t30 = CASE WHEN pct_t45 > pct_t30 THEN 1 ELSE 0 END,
          confirmed_dip_recovery = CASE
            WHEN dip_and_recover_flag = 1
              AND pct_t30 > pct_t15
              AND pct_t45 > pct_t30
            THEN 1 ELSE 0 END
      WHERE confirmed_dip_recovery IS NULL
        AND pct_t15 IS NOT NULL
        AND pct_t30 IS NOT NULL
        AND pct_t45 IS NOT NULL
    `);
  }

  // Add columns to graduations if they don't exist yet (safe migration)
  const cols = db.prepare("PRAGMA table_info(graduations)").all() as Array<{ name: string }>;
  const existing = new Set(cols.map(c => c.name));
  const newCols: Array<[string, string]> = [
    ['holder_count', 'INTEGER'],
    ['top5_wallet_pct', 'REAL'],
    ['dev_wallet_pct', 'REAL'],
    ['token_age_seconds', 'INTEGER'],
    ['dev_wallet_address', 'TEXT'],
    ['creator_wallet_address', 'TEXT'],
  ];
  for (const [col, type] of newCols) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE graduations ADD COLUMN ${col} ${type}`);
    }
  }

  // Migration: unique constraint on mint in graduations table.
  // First deduplicate existing rows (keep lowest id per mint), cleaning up
  // all child tables that reference the dropped graduation ids.
  const mintUniqueExists = (db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_graduations_mint_unique'`
  ).get() as any);

  if (!mintUniqueExists) {
    logger.info('Adding unique mint constraint — deduplicating graduations first');
    db.exec(`
      DELETE FROM graduation_momentum WHERE graduation_id NOT IN (
        SELECT MIN(id) FROM graduations GROUP BY mint
      );
      DELETE FROM pool_observations WHERE graduation_id NOT IN (
        SELECT MIN(id) FROM graduations GROUP BY mint
      );
      DELETE FROM price_comparisons WHERE graduation_id NOT IN (
        SELECT MIN(id) FROM graduations GROUP BY mint
      );
      DELETE FROM opportunities WHERE graduation_id NOT IN (
        SELECT MIN(id) FROM graduations GROUP BY mint
      );
      DELETE FROM paper_trades WHERE graduation_id NOT IN (
        SELECT MIN(id) FROM graduations GROUP BY mint
      );
      DELETE FROM competition_signals WHERE graduation_id NOT IN (
        SELECT MIN(id) FROM graduations GROUP BY mint
      );
      DELETE FROM graduations WHERE id NOT IN (
        SELECT MIN(id) FROM graduations GROUP BY mint
      );
    `);
    db.exec(`CREATE UNIQUE INDEX idx_graduations_mint_unique ON graduations(mint)`);
    logger.info('Unique mint index created');
  }

  // Trading extension tables (safe migrations)
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      graduation_id INTEGER NOT NULL REFERENCES graduations(id),
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      mint TEXT NOT NULL,
      pool_address TEXT NOT NULL,
      base_vault TEXT,
      quote_vault TEXT,
      entry_timestamp INTEGER,
      entry_price_sol REAL,
      entry_pct_from_open REAL,
      entry_liquidity_sol REAL,
      entry_tx_signature TEXT,
      entry_effective_price REAL,
      entry_tokens_received REAL,
      entry_slippage_pct REAL,
      trade_size_sol REAL,
      take_profit_pct REAL,
      stop_loss_pct REAL,
      max_hold_seconds INTEGER,
      exit_timestamp INTEGER,
      exit_price_sol REAL,
      exit_reason TEXT,
      exit_tx_signature TEXT,
      exit_effective_price REAL,
      gross_return_pct REAL,
      gap_adjusted_return_pct REAL,
      estimated_fees_sol REAL,
      net_profit_sol REAL,
      net_return_pct REAL,
      filter_results_json TEXT,
      filter_config_json TEXT,
      momentum_pct_t60 REAL,
      momentum_pct_t120 REAL,
      momentum_pct_t300 REAL,
      momentum_label TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_trades_v2_graduation ON trades_v2(graduation_id);
    CREATE INDEX IF NOT EXISTS idx_trades_v2_status ON trades_v2(status);
    CREATE INDEX IF NOT EXISTS idx_trades_v2_mode ON trades_v2(mode);

    CREATE TABLE IF NOT EXISTS trade_skips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      graduation_id INTEGER NOT NULL REFERENCES graduations(id),
      skip_reason TEXT NOT NULL,
      skip_value REAL,
      pct_t30 REAL,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_trade_skips_graduation ON trade_skips(graduation_id);
  `);

  // Strategy configs table for multi-strategy parallel testing
  db.exec(`
    CREATE TABLE IF NOT EXISTS strategy_configs (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );
  `);

  // Strategy journal — per-cohort hypothesis + prediction + status, with an
  // append-only updates trail. Keyed by `strategy_id` but NOT a FK: entries
  // intentionally outlive a strategy delete/disable so the research arc is
  // preserved (we want to re-read what we predicted v9 would do, even after
  // v9 is dead). Manual `status` (OPEN/PROMOTED/KILLED/PAUSED) is set by the
  // operator; the live auto-badge in journal.json is computed against the
  // strategy's current closed-trade percentiles and is independent of this
  // column.
  db.exec(`
    CREATE TABLE IF NOT EXISTS strategy_journal (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      cohort_label TEXT,
      hypothesis TEXT NOT NULL,
      prediction_json TEXT,
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      updates_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_journal_strategy ON strategy_journal(strategy_id);
    CREATE INDEX IF NOT EXISTS idx_journal_status ON strategy_journal(status);
  `);

  // Daily trading report — one row per UTC day, written by the routine Claude
  // run via /daily-report and consumed by the `/report` page. Stores the
  // narrative + structured fields a fresh Claude session needs to pick up
  // where the last one left off (winners/losers, recommendations, action
  // items, anomalies, patterns). action_items_json is the loop-closer:
  // each item has a status (PROPOSED / EXECUTED / DEFERRED / REJECTED) so
  // tomorrow's Claude can audit what happened to yesterday's plan.
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_reports (
      date TEXT PRIMARY KEY,
      generated_at INTEGER NOT NULL,
      generated_by TEXT,
      winners_json TEXT,
      losers_json TEXT,
      recommendations_json TEXT,
      anomalies_json TEXT,
      patterns_json TEXT,
      action_items_json TEXT NOT NULL DEFAULT '[]',
      narrative TEXT,
      updates_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_reports_generated_at ON daily_reports(generated_at);
  `);

  // Lessons-learned memo — long-running insights confirmed across many
  // sessions. Sits above daily reports as institutional memory. Archived
  // entries (archived=1) are kept for history but hidden from the active
  // memo render.
  db.exec(`
    CREATE TABLE IF NOT EXISTS lessons_learned (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      evidence_json TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_lessons_archived ON lessons_learned(archived);
  `);

  // Market regime context — daily SOL/USD + BTC/USD OHLC + Fear & Greed
  // Index. One row per UTC date. Populated by MarketDataFetcher (CoinGecko
  // + alternative.me). Used by the trends-market panel to bucket trades by
  // external-market regime (SOL return quintile, BTC return quintile, F&G).
  // Safe ALTER TABLE pattern not needed — schema is fixed at table creation.
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_daily (
      date TEXT PRIMARY KEY,                -- 'YYYY-MM-DD' UTC
      sol_usd_open REAL,
      sol_usd_high REAL,
      sol_usd_low REAL,
      sol_usd_close REAL,
      btc_usd_open REAL,
      btc_usd_high REAL,
      btc_usd_low REAL,
      btc_usd_close REAL,
      fear_greed_value INTEGER,
      fear_greed_label TEXT,
      fetched_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_market_daily_fetched ON market_daily(fetched_at);
  `);

  // Universe-level token-launch rate — one row per UTC hour bucket, counting
  // pump.fun `Instruction: Create` events seen on the Helius firehose. This is
  // a genuinely LEADING regime signal (froth / risk appetite): unlike the
  // pump_rate / fast_rug_rate signals it does NOT wait on T+300 outcomes, so it
  // updates the moment tokens are minted rather than ~5 min + window-lag later.
  // Counts are deduped by signature in LaunchCounter before landing here, so the
  // additive upsert is safe to call repeatedly. No backfill possible — the
  // create firehose is not retained, so the series starts at deploy time.
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_launches (
      bucket_start INTEGER PRIMARY KEY,   -- unix seconds, floored to the hour (UTC)
      launch_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER
    );
  `);

  // Bot error log — one row per uncaught exception / unhandled rejection so
  // /api/snapshot can surface the last crash without depending on Railway logs.
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      level TEXT NOT NULL,
      name TEXT,
      message TEXT NOT NULL,
      stack TEXT,
      git_sha TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bot_errors_ts ON bot_errors(ts);
  `);

  // Dismissed anomaly suppressions — the unified Action Items panel folds
  // auto-detected anomalies in alongside Claude proposals. Dismissing one
  // (via inline button on /report) stores the (kind, target_id) pair here for
  // a rolling 24h suppression so the same anomaly doesn't re-spam the panel
  // every render. Keyed by composite "kind|target_id" string.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dismissed_anomalies (
      key TEXT PRIMARY KEY,
      dismissed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dismissed_anomalies_at ON dismissed_anomalies(dismissed_at);
  `);

  // ── Copy-trading (Option B) wallet-intelligence tables ──────────────────
  // Phase 1 subsystem: discover candidate wallets, reconstruct their realized
  // SOL P&L from on-chain swap history (FIFO), and rank them under the SAME
  // bar the strategy book uses (n>=100 · drop_top3>0 · monthly>=3.75). This is
  // a parallel subsystem — it does NOT feed the graduation pipeline. See
  // docs/copy-trading-option-b-design.md. All tables are additive and isolated;
  // dropping the copytrade module leaves the rest of the schema untouched.
  db.exec(`
    -- Candidate wallets worth scoring. Seeded from existing DB wallets
    -- (competition_signals + graduation_momentum.firstbuyer/dev/creator) at
    -- zero new RPC cost; 'source' records where each came from.
    CREATE TABLE IF NOT EXISTS wallet_candidates (
      address TEXT PRIMARY KEY,
      first_seen INTEGER NOT NULL,
      source TEXT NOT NULL,
      last_refreshed INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_candidates_refreshed ON wallet_candidates(last_refreshed);

    -- Raw parsed swaps per wallet — the PnL engine's input. One row per
    -- (wallet, signature). 'venue' is best-effort program attribution.
    -- sol_delta is the SIGNER's net SOL change (negative = bought, positive =
    -- sold); token_delta is the signed change in the traded mint balance.
    CREATE TABLE IF NOT EXISTS wallet_tx_cache (
      address TEXT NOT NULL,
      signature TEXT NOT NULL,
      block_time INTEGER NOT NULL,
      mint TEXT,
      action TEXT,
      sol_delta REAL,
      token_delta REAL,
      venue TEXT,
      PRIMARY KEY (address, signature)
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_tx_cache_addr_time ON wallet_tx_cache(address, block_time);

    -- FIFO-matched round trips. open_ts/close_ts are block times; realized_sol
    -- is sol_out - sol_in for the matched lot AFTER our copy-cost model.
    CREATE TABLE IF NOT EXISTS wallet_round_trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      mint TEXT NOT NULL,
      open_ts INTEGER NOT NULL,
      close_ts INTEGER NOT NULL,
      sol_in REAL NOT NULL,
      sol_out REAL NOT NULL,
      realized_sol REAL NOT NULL,
      hold_sec INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_round_trips_addr ON wallet_round_trips(address);

    -- Per-wallet aggregate score. Mirrors the strategy promotion metrics so the
    -- ranker can apply the identical bar. drop_top3 is the outlier-robustness
    -- check (CLAUDE.md item 2). scored_at = when this snapshot was computed.
    CREATE TABLE IF NOT EXISTS wallet_scores (
      address TEXT PRIMARY KEY,
      n_round_trips INTEGER NOT NULL,
      total_realized_sol REAL NOT NULL,
      total_realized_sol_drop_top3 REAL NOT NULL,
      median_rt_pct REAL,
      monthly_run_rate_sol REAL,
      win_rate REAL,
      avg_hold_sec REAL,
      last_active INTEGER,
      venues_json TEXT,
      scored_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_scores_runrate ON wallet_scores(monthly_run_rate_sol);

    -- Wallets promoted onto the live follow list. Same shape role as a strategy
    -- config: copy_size_sol + max_concurrent + kill_criterion + enabled. The
    -- realtime follower (Phase 2) reads enabled=1 rows. kill_criterion uses the
    -- SOL-denominated forms from CLAUDE.md.
    CREATE TABLE IF NOT EXISTS follow_list (
      address TEXT PRIMARY KEY,
      rank INTEGER,
      copy_size_sol REAL NOT NULL DEFAULT 0.05,
      max_concurrent INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 0,
      kill_criterion TEXT,
      added_at INTEGER NOT NULL
    );
  `);

  // Additive: priority column on wallet_candidates. The first copytrade deploy
  // created the table without it, so existing DBs need the ALTER. Priority is a
  // heuristic ranking (frequency on PUMP graduations + first-buyer hits) that
  // decides WHICH candidates the scorer evaluates first — see
  // recomputeCandidatePriorities in src/copytrade/discovery.ts. NULL = no signal
  // yet (sorts last).
  {
    const cc = db.prepare("PRAGMA table_info(wallet_candidates)").all() as Array<{ name: string }>;
    if (!cc.some((c) => c.name === 'priority')) {
      db.exec(`ALTER TABLE wallet_candidates ADD COLUMN priority INTEGER`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_wallet_candidates_priority ON wallet_candidates(priority)`);
  }

  // Copy-follower latency PROBE (Option B, Phase 2 pre-work). One row per
  // smart-wallet swap we detect in real time via Helius transactionSubscribe.
  // Records how late we saw it (detection_lag_sec = our WS-notification time −
  // the tx's on-chain block time) so we can measure our latency disadvantage
  // BEFORE building the real shadow-copy executor. No positions are taken.
  db.exec(`
    CREATE TABLE IF NOT EXISTS copy_probe_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL,
      signature TEXT NOT NULL,
      mint TEXT,
      action TEXT,
      sol_delta REAL,
      venue TEXT,
      tier TEXT,
      their_block_time INTEGER,
      detected_at INTEGER,
      detection_lag_sec REAL,
      slot INTEGER,
      UNIQUE(wallet_address, signature)
    );
    CREATE INDEX IF NOT EXISTS idx_copy_probe_detected ON copy_probe_events(detected_at);
  `);

  // Shadow copy-trader (Option B, Phase 2). One row per SHADOW copy position:
  // when a followed wallet buys a graduated token, each armed copy strategy
  // opens a modeled position here (no real funds). Tracked by CopyTrader until
  // it exits via TP / SL / max-hold / follow-the-lead-wallet's-sell. net_sol is
  // shadow P&L after the SIM round-trip cost. base/quote vaults are stored so a
  // restart can resume tracking open positions without re-resolving the pool.
  db.exec(`
    CREATE TABLE IF NOT EXISTS copy_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id TEXT NOT NULL,
      mint TEXT NOT NULL,
      pool_address TEXT,
      base_vault TEXT,
      quote_vault TEXT,
      lead_wallet TEXT,
      lead_tier TEXT,
      entry_ts INTEGER NOT NULL,
      entry_price_sol REAL NOT NULL,
      size_sol REAL NOT NULL,
      tp_price_sol REAL,
      sl_price_sol REAL,
      exit_follow INTEGER NOT NULL DEFAULT 0,
      max_hold_sec INTEGER,
      detection_lag_sec REAL,
      exit_ts INTEGER,
      exit_price_sol REAL,
      exit_reason TEXT,
      gross_pct REAL,
      net_sol REAL,
      hold_sec INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(strategy_id, mint, entry_ts)
    );
    CREATE INDEX IF NOT EXISTS idx_copy_trades_status ON copy_trades(status);
    CREATE INDEX IF NOT EXISTS idx_copy_trades_strategy ON copy_trades(strategy_id);
  `);
  // Additive: dynamic-exit state columns (high-water mark, scale-out) so the
  // CopyTrader resumes breakeven/ratchet/scale-out correctly across restarts.
  {
    const cc = db.prepare("PRAGMA table_info(copy_trades)").all() as Array<{ name: string }>;
    const have = new Set(cc.map((c) => c.name));
    if (!have.has('high_price_sol')) db.exec(`ALTER TABLE copy_trades ADD COLUMN high_price_sol REAL`);
    if (!have.has('scaled_out')) db.exec(`ALTER TABLE copy_trades ADD COLUMN scaled_out INTEGER DEFAULT 0`);
    if (!have.has('realized_partial_sol')) db.exec(`ALTER TABLE copy_trades ADD COLUMN realized_partial_sol REAL DEFAULT 0`);
  }
  // Additive: tier column (promotable vs smart-only) for DBs created before it.
  {
    const pc = db.prepare("PRAGMA table_info(copy_probe_events)").all() as Array<{ name: string }>;
    if (!pc.some((c) => c.name === 'tier')) {
      db.exec(`ALTER TABLE copy_probe_events ADD COLUMN tier TEXT`);
    }
  }

  // Add strategy_id to trades_v2 and trade_skips (safe migration)
  {
    const tradeCols = db.prepare("PRAGMA table_info(trades_v2)").all() as Array<{ name: string }>;
    const tradeExisting = new Set(tradeCols.map(c => c.name));
    if (!tradeExisting.has('strategy_id')) {
      db.exec(`ALTER TABLE trades_v2 ADD COLUMN strategy_id TEXT DEFAULT 'default'`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_v2_strategy ON trades_v2(strategy_id)`);
    }

    const skipCols = db.prepare("PRAGMA table_info(trade_skips)").all() as Array<{ name: string }>;
    const skipExisting = new Set(skipCols.map(c => c.name));
    if (!skipExisting.has('strategy_id')) {
      db.exec(`ALTER TABLE trade_skips ADD COLUMN strategy_id TEXT DEFAULT 'default'`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_trade_skips_strategy ON trade_skips(strategy_id)`);
    }
  }

  // Live-execution columns on trades_v2 (safe migration).
  // execution_mode is the per-phase rollout flag (paper/shadow/live_micro/live_full).
  // shadow_measured_* capture on-chain pool state at entry/exit in shadow mode —
  // we never submit a tx but record what the fill would have been so paper gap
  // penalties can be compared to reality. jito_tip_sol and tx_land_ms are only
  // populated in live_micro/live_full.
  {
    const tradeColsLive = db.prepare("PRAGMA table_info(trades_v2)").all() as Array<{ name: string }>;
    const tradeExistingLive = new Set(tradeColsLive.map(c => c.name));
    const newTradeCols: Array<[string, string]> = [
      ['execution_mode', `TEXT DEFAULT 'paper'`],
      ['shadow_measured_entry_slippage_pct', 'REAL'],
      ['shadow_measured_exit_slippage_pct', 'REAL'],
      ['measured_exit_slippage_pct', 'REAL'],
      ['jito_tip_sol', 'REAL'],
      ['tx_land_ms', 'INTEGER'],
      // Populated when a non-live exit closes via a degraded path — e.g. shadow
      // sell fell back to gap-penalty modeling because the pool read failed.
      // Lets promotion logic down-weight shadow trades whose measured-slippage
      // numbers are actually modeled, not measured.
      ['execution_failure_reason', 'TEXT'],
      // Diagnostic context for failed live trades. JSON blob containing path
      // (jito/rpc), mint extensions (token2022, transfer_fee, transfer_hook),
      // expected/min out amounts, latency. Populated by markTradeFailed when a
      // live buy/sell tx doesn't land. Lets the dashboard + post-mortem
      // analyses see WHY a tx failed without scraping logs. Added 2026-05-21.
      ['failure_context_json', 'TEXT'],
      // Structured columns lifted from failure_context_json for quick filtering.
      // Both default NULL on paper/shadow rows.
      ['tx_failure_path', 'TEXT'],
      ['mint_extension_flags', 'TEXT'],
      // SOL spent on ATA rent at buy time. The PumpSwap swap creates ATAs that
      // are NOT closed at sell time, so rent is a permanent wallet outflow per
      // unique mint (~0.00204 SOL × number of new ATAs created at buy). Stored
      // here so closeTrade can deduct it from net_profit_sol — without this,
      // accumulated rent showed up as a 0.10–0.20 SOL "missing" gap between
      // sum-of-strategy-net_sol and actual wallet delta (audited 2026-05-26).
      // Populated only on live_micro/live_full rows where ATAs were pre-created.
      ['entry_ata_rent_sol', 'REAL'],
    ];
    for (const [col, type] of newTradeCols) {
      if (!tradeExistingLive.has(col)) {
        db.exec(`ALTER TABLE trades_v2 ADD COLUMN ${col} ${type}`);
      }
    }
    // Backfill legacy rows: anything already in DB pre-migration was paper.
    db.exec(`UPDATE trades_v2 SET execution_mode = 'paper' WHERE execution_mode IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_v2_execution_mode ON trades_v2(execution_mode)`);
  }

  // One-time backfill: recompute net_return_pct on existing closed shadow
  // trades under the measured-cost model (gross − measured entry slip −
  // measured exit slip − simulated jito tip − tx fee). Pre-fix shadow rows
  // were stored with the static gap-penalty model, which over-charges by
  // ~25 pp vs reality. Guarded by a marker so it runs at most once per row.
  {
    // bot_settings is created lower down in this function; create-if-not-exists
    // here so the marker check works on first boot too.
    db.exec(`
      CREATE TABLE IF NOT EXISTS bot_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER DEFAULT (unixepoch())
      )
    `);
    const alreadyDone = db.prepare(`SELECT 1 FROM bot_settings WHERE key = ?`)
      .get('shadow_net_return_backfill_v1') != null;
    if (!alreadyDone) {
      // Use COALESCE to default missing jito_tip_sol to 0.0002 SOL (entry+exit
      // simulated tips at DEFAULT_JITO_TIP_SOL = 0.0001 each). tx_overhead is a
      // constant 0.00001 SOL (2 × 5000 lamports).
      const sim2Tips = 0.0002;
      const txOverheadSol = 1e-5;
      const result = db.prepare(`
        UPDATE trades_v2
        SET net_return_pct = ROUND(
              gross_return_pct
              - COALESCE(shadow_measured_entry_slippage_pct, 0)
              - COALESCE(shadow_measured_exit_slippage_pct, 0)
              - ((COALESCE(jito_tip_sol, ?) + ?) / NULLIF(trade_size_sol, 0)) * 100
            , 6),
            net_profit_sol = ROUND(
              trade_size_sol * (
                gross_return_pct
                - COALESCE(shadow_measured_entry_slippage_pct, 0)
                - COALESCE(shadow_measured_exit_slippage_pct, 0)
                - ((COALESCE(jito_tip_sol, ?) + ?) / NULLIF(trade_size_sol, 0)) * 100
              ) / 100
            , 8)
        WHERE status = 'closed'
          AND COALESCE(execution_mode, 'paper') = 'shadow'
          AND gross_return_pct IS NOT NULL
          AND shadow_measured_entry_slippage_pct IS NOT NULL
          AND shadow_measured_exit_slippage_pct IS NOT NULL
      `).run(sim2Tips, txOverheadSol, sim2Tips, txOverheadSol);
      db.prepare(`INSERT OR REPLACE INTO bot_settings (key, value, updated_at) VALUES (?, ?, unixepoch())`)
        .run('shadow_net_return_backfill_v1', String(result.changes));
      logger.info({ rowsUpdated: result.changes }, 'Backfilled net_return_pct on closed shadow trades (measured-cost model)');
    }

    // 2026-05-22 fix: live_micro trades pre-fix had trade_size_sol=0.5 (the
    // strategy's configured tradeSizeSol) but the executor only actually swaps
    // MICRO_TRADE_SIZE_SOL (0.05). Their net_profit_sol = trade_size_sol × pct
    // was therefore 10x too negative. Backfill those rows: set trade_size_sol
    // to 0.05 and recompute net_profit_sol against the correct size.
    // Idempotent via bot_settings marker.
    const microFixDone = db.prepare(`SELECT 1 FROM bot_settings WHERE key = ?`)
      .get('live_micro_trade_size_backfill_v1') != null;
    if (!microFixDone) {
      const MICRO_SIZE = 0.05;
      const result = db.prepare(`
        UPDATE trades_v2
        SET trade_size_sol = ?,
            net_profit_sol = CASE
              WHEN net_return_pct IS NOT NULL
                THEN ROUND(? * (net_return_pct / 100), 8)
              ELSE net_profit_sol
            END
        WHERE execution_mode = 'live_micro'
          AND trade_size_sol IS NOT NULL
          AND trade_size_sol > ?
      `).run(MICRO_SIZE, MICRO_SIZE, MICRO_SIZE);
      db.prepare(`INSERT OR REPLACE INTO bot_settings (key, value, updated_at) VALUES (?, ?, unixepoch())`)
        .run('live_micro_trade_size_backfill_v1', String(result.changes));
      logger.info(
        { rowsUpdated: result.changes },
        'Backfilled live_micro trade_size_sol → 0.05 + recomputed net_profit_sol',
      );
    }

    // 2026-05-26 fix: closed live trades' net_profit_sol pre-fix used
    // measuredRoundTripPct (~1.75% modeling shadow slippage) and ignored
    // ATA rent entirely. Actual per-trade overhead is:
    //   entry tip + exit tip + 2 × tx fee + ATA rent (~0.00204 SOL per new mint)
    // ATA rent dominates on micro trades — 0.00204 SOL on 0.05 SOL is 4 pp,
    // way more than the 1.75% the old math assumed. Aggregate impact was
    // ~0.15-0.20 SOL of unrecognized losses across ~100 historical live
    // trades. Backfill: assume every live trade created a new base ATA
    // (true since each mint is unique post-graduation) and apply the new
    // math. Skip already-closed-with-correct-math via marker.
    const liveOverheadFixDone = db.prepare(`SELECT 1 FROM bot_settings WHERE key = ?`)
      .get('live_overhead_recompute_v1') != null;
    if (!liveOverheadFixDone) {
      const TOKEN_ACCOUNT_RENT_SOL = 0.00203928;  // TOKEN_ACCOUNT_RENT_LAMPORTS / 1e9
      const TX_OVERHEAD_SOL = 0.00001;            // 2 × 5_000 lamports
      const DEFAULT_TIP_SOL = 0.0001;             // DEFAULT_JITO_TIP_SOL fallback
      // Set entry_ata_rent_sol on all live closed trades that don't have it
      // (every live trade is on a unique mint = new base ATA was created).
      db.prepare(`
        UPDATE trades_v2
        SET entry_ata_rent_sol = ?
        WHERE execution_mode IN ('live_micro', 'live_full')
          AND entry_ata_rent_sol IS NULL
      `).run(TOKEN_ACCOUNT_RENT_SOL);
      // Recompute net_profit_sol + net_return_pct using the new live overhead
      // formula. We approximate exit tip via the same DEFAULT_TIP_SOL since
      // per-row exit-side tip wasn't persisted on most pre-fix rows (jito_tip_sol
      // captures the most-recent leg of the last submission; not strictly entry
      // OR exit). Conservative — uses gross_return_pct adjusted by overhead %.
      const result = db.prepare(`
        UPDATE trades_v2
        SET net_return_pct = ROUND(
              COALESCE(gap_adjusted_return_pct, gross_return_pct)
              - ((? + ? + ? + COALESCE(entry_ata_rent_sol, 0)) / NULLIF(trade_size_sol, 0)) * 100
            , 6),
            net_profit_sol = ROUND(
              trade_size_sol * (
                COALESCE(gap_adjusted_return_pct, gross_return_pct)
                - ((? + ? + ? + COALESCE(entry_ata_rent_sol, 0)) / NULLIF(trade_size_sol, 0)) * 100
              ) / 100
            , 8),
            estimated_fees_sol = ROUND(
              ? + ? + ? + COALESCE(entry_ata_rent_sol, 0)
            , 8)
        WHERE status = 'closed'
          AND execution_mode IN ('live_micro', 'live_full')
          AND gross_return_pct IS NOT NULL
          AND trade_size_sol IS NOT NULL
          AND trade_size_sol > 0
      `).run(
        DEFAULT_TIP_SOL, DEFAULT_TIP_SOL, TX_OVERHEAD_SOL,  // net_return_pct
        DEFAULT_TIP_SOL, DEFAULT_TIP_SOL, TX_OVERHEAD_SOL,  // net_profit_sol
        DEFAULT_TIP_SOL, DEFAULT_TIP_SOL, TX_OVERHEAD_SOL,  // estimated_fees_sol
      );
      db.prepare(`INSERT OR REPLACE INTO bot_settings (key, value, updated_at) VALUES (?, ?, unixepoch())`)
        .run('live_overhead_recompute_v1', String(result.changes));
      logger.info(
        { rowsUpdated: result.changes },
        'Backfilled live trade overhead (tips + fees + ATA rent) into net_profit_sol',
      );
    }

    // 2026-05-26 fix: convert historical live trades stuck at status='failed'
    // with exit_reason starting 'live_sell_failed_after_' into status='closed'
    // with net_profit_sol = -(entry cost + overhead). Pre-fix the bot gave up
    // after 5 sell-retry attempts and marked the trade failed, hiding the
    // ~0.05 SOL buy cost loss from every strategy's net P&L. Tokens are
    // realistically stuck on-chain — for accounting purposes treat them as
    // worthless. (Future failed sells are retried indefinitely with backoff
    // via 2b — this only backfills the historical orphans.) Idempotent.
    const stuckSellFixDone = db.prepare(`SELECT 1 FROM bot_settings WHERE key = ?`)
      .get('live_stuck_failed_sells_v1') != null;
    if (!stuckSellFixDone) {
      const DEFAULT_TIP_SOL = 0.0001;
      const TX_OVERHEAD_SOL = 0.00001;
      // For each stuck sell: net_profit_sol = -(trade_size + entry_tip + exit_tip
      // estimate + 2×tx_fee + entry_ata_rent). The tokens are treated as
      // worthless (sell never landed).
      const result = db.prepare(`
        UPDATE trades_v2
        SET status = 'closed',
            net_profit_sol = ROUND(
              -1 * (trade_size_sol
                    + COALESCE(jito_tip_sol, ?)
                    + ?
                    + ?
                    + COALESCE(entry_ata_rent_sol, 0))
            , 8),
            net_return_pct = -100,
            estimated_fees_sol = ROUND(
              COALESCE(jito_tip_sol, ?) + ? + ? + COALESCE(entry_ata_rent_sol, 0)
            , 8)
        WHERE status = 'failed'
          AND execution_mode IN ('live_micro', 'live_full')
          AND exit_reason LIKE 'live_sell_failed_after_%'
          AND trade_size_sol IS NOT NULL
      `).run(
        DEFAULT_TIP_SOL, DEFAULT_TIP_SOL, TX_OVERHEAD_SOL,  // net_profit_sol
        DEFAULT_TIP_SOL, DEFAULT_TIP_SOL, TX_OVERHEAD_SOL,  // estimated_fees_sol
      );
      db.prepare(`INSERT OR REPLACE INTO bot_settings (key, value, updated_at) VALUES (?, ?, unixepoch())`)
        .run('live_stuck_failed_sells_v1', String(result.changes));
      logger.info(
        { rowsUpdated: result.changes },
        'Converted historical stuck-sell failures to closed losses',
      );
    }

    // 2026-05-29 fix: correct mis-paired live sells. When two live strategies
    // bought the SAME mint concurrently, liveBuy's full-wallet balance delta
    // booked the COMBINED token amount on BOTH rows (identical
    // entry_tokens_received). Whichever sold first drained the shared wallet
    // position; the other found 0 tokens and terminal-closed as a ~-104% total
    // loss (exit_reason='sell_failed_terminal') even though its tokens had in
    // fact been liquidated by the sibling's sell at the sibling's exit price.
    // Trade 16341 (v44-climb-1s-ttp10-live-micro) is the known victim; its
    // tokens were sold inside 16342's (v44-climb-live-micro) timeout exit.
    //
    // The going-forward fix (executor.fetchTxBalanceDeltas, same release)
    // attributes each buy's tokens/SOL from its OWN confirmed tx meta, so this
    // can't recur. This backfill repairs the historical rows: each victim
    // inherits the realized exit economics of the sibling that actually sold
    // the shared position. Because both strategies deployed the same per-trade
    // SOL and the per-token return is identical, mirroring the sibling makes
    // the two halves sum to the true wallet outcome (no double-count).
    //
    // Matched on the bug SIGNATURE, not a hardcoded row id: a terminal-failed
    // live sell that has a sibling live trade on the same graduation which (a)
    // closed via a real (non-terminal) exit at a >0 price and (b) recorded the
    // identical inflated entry_tokens_received. That EXISTS guard means a
    // genuine stuck-sell (tokens truly lost, no sibling drained them) is NEVER
    // converted to a profit. Idempotent via marker.
    const mispairedSellFixDone = db.prepare(`SELECT 1 FROM bot_settings WHERE key = ?`)
      .get('live_mispaired_sell_correction_v1') != null;
    if (!mispairedSellFixDone) {
      const result = db.prepare(`
        UPDATE trades_v2 AS v
        SET exit_price_sol = s.exit_price_sol,
            exit_effective_price = s.exit_effective_price,
            exit_reason = s.exit_reason,
            exit_timestamp = s.exit_timestamp,
            gross_return_pct = s.gross_return_pct,
            gap_adjusted_return_pct = s.gap_adjusted_return_pct,
            estimated_fees_sol = s.estimated_fees_sol,
            net_profit_sol = s.net_profit_sol,
            net_return_pct = s.net_return_pct
        FROM trades_v2 AS s
        WHERE v.exit_reason = 'sell_failed_terminal'
          AND v.execution_mode IN ('live_micro', 'live_full')
          AND v.entry_tokens_received IS NOT NULL
          AND s.id <> v.id
          AND s.graduation_id = v.graduation_id
          AND s.execution_mode IN ('live_micro', 'live_full')
          AND s.status = 'closed'
          AND s.exit_reason <> 'sell_failed_terminal'
          AND s.exit_price_sol > 0
          AND s.entry_tokens_received = v.entry_tokens_received
      `).run();
      db.prepare(`INSERT OR REPLACE INTO bot_settings (key, value, updated_at) VALUES (?, ?, unixepoch())`)
        .run('live_mispaired_sell_correction_v1', String(result.changes));
      logger.info(
        { rowsUpdated: result.changes },
        'Corrected mis-paired live sells (victim inherits sibling realized exit)',
      );
    }
  }

  // Add archived column to trades_v2 — backfill legacy strategy trades so they
  // stay queryable but are excluded from dashboard/snapshot by default.
  {
    const tradeColsArchive = db.prepare("PRAGMA table_info(trades_v2)").all() as Array<{ name: string }>;
    if (!new Set(tradeColsArchive.map(c => c.name)).has('archived')) {
      db.exec(`ALTER TABLE trades_v2 ADD COLUMN archived INTEGER DEFAULT 0`);
      // Archive all trades from strategies that pre-date the combo1/2/3 era.
      // New strategies default to archived=0, so this only runs once on migration.
      db.exec(`
        UPDATE trades_v2 SET archived = 1
        WHERE strategy_id NOT IN (
          'combo1-std', 'combo1-dpm',
          'combo2-std', 'combo2-dpm',
          'combo3-std', 'combo3-dpm'
        )
      `);
    }
  }

  // Generic key-value store for bot settings (e.g. persisted Gist ID).
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    );
  `);

  // Persistent cache for heavy precomputed JSON blobs (filter-v2 panels,
  // price-path detail, etc.). Survives process restarts so a redeploy doesn't
  // trigger another ~100s blocking recompute. Read on boot, written after
  // each refreshHeavyData() completes. value_json can be MB-sized.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_kv (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      computed_at INTEGER NOT NULL
    );
  `);

  logger.info('Database migrations complete');
}
