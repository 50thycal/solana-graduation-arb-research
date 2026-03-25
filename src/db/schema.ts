import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import pino from 'pino';

const logger = pino({ name: 'db-schema' });

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
  `);

  logger.info('Database migrations complete');
}
