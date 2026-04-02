import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'db-schema' });

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
      ['bc_velocity_sol_per_min', 'REAL'], // bonding curve fill rate (sol_raised / age in minutes)
    ];
    for (const [col, type] of newMomCols) {
      if (!momExisting.has(col)) {
        db.exec(`ALTER TABLE graduation_momentum ADD COLUMN ${col} ${type}`);
      }
    }
  }

  // Add columns to graduations if they don't exist yet (safe migration)
  const cols = db.prepare("PRAGMA table_info(graduations)").all() as Array<{ name: string }>;
  const existing = new Set(cols.map(c => c.name));
  const newCols: Array<[string, string]> = [
    ['holder_count', 'INTEGER'],
    ['top5_wallet_pct', 'REAL'],
    ['dev_wallet_pct', 'REAL'],
    ['token_age_seconds', 'INTEGER'],
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

  logger.info('Database migrations complete');
}
