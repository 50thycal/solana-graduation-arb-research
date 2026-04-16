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
      -- Label
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
      ['dip_and_recover_flag', 'INTEGER'], // 1 if price dropped >10% from running peak then recovered
      ['early_vs_late_0_30', 'REAL'],  // (pct_t15-pct_t0) - (pct_t30-pct_t15): positive = front-loaded
      ['early_vs_late_0_60', 'REAL'],  // (pct_t30-pct_t0) - (pct_t60-pct_t30): same for full window
      ['path_cluster', 'TEXT'],        // shape cluster label (populated later)
      // Buy pressure quality metrics (computed at T+35 from pool transactions in 0-30s window)
      ['buy_pressure_unique_buyers', 'INTEGER'],  // distinct wallets that bought in 0-30s
      ['buy_pressure_buy_ratio', 'REAL'],          // buys / (buys + sells) as 0-1
      ['buy_pressure_whale_pct', 'REAL'],          // largest single buy SOL / total buy SOL volume
      ['buy_pressure_trade_count', 'INTEGER'],     // total txs in 0-30s window (from signature count)
      // Wallet address tracking
      ['dev_wallet_address', 'TEXT'],              // wallet address of largest non-infrastructure holder
      ['creator_wallet_address', 'TEXT'],          // wallet that deployed the token on pump.fun
      // Creator reputation scores (computed at enrichment time via self-join)
      ['creator_prior_token_count', 'INTEGER'],    // how many tokens this creator graduated before this one
      ['creator_prior_rug_rate', 'REAL'],          // fraction of prior tokens that dumped >50% by T+300
      ['creator_prior_avg_return', 'REAL'],        // avg pct_t300 of their prior tokens
      ['creator_last_token_age_hours', 'REAL'],    // hours since their last graduation
    ];
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

  logger.info('Database migrations complete');
}
