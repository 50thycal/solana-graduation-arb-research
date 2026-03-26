import Database from 'better-sqlite3';

// ==================== Graduation queries (existing) ====================

export interface GraduationInsert {
  mint: string;
  signature: string;
  slot: number;
  timestamp: number;
  bonding_curve_address?: string;
  final_price_sol?: number;
  final_sol_reserves?: number;
  final_token_reserves?: number;
  virtual_sol_reserves?: number;
  virtual_token_reserves?: number;
}

export function insertGraduation(db: Database.Database, data: GraduationInsert): number | null {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO graduations (
      mint, signature, slot, timestamp,
      bonding_curve_address, final_price_sol,
      final_sol_reserves, final_token_reserves,
      virtual_sol_reserves, virtual_token_reserves
    ) VALUES (
      @mint, @signature, @slot, @timestamp,
      @bonding_curve_address, @final_price_sol,
      @final_sol_reserves, @final_token_reserves,
      @virtual_sol_reserves, @virtual_token_reserves
    )
  `);

  const result = stmt.run({
    mint: data.mint,
    signature: data.signature,
    slot: data.slot,
    timestamp: data.timestamp,
    bonding_curve_address: data.bonding_curve_address ?? null,
    final_price_sol: data.final_price_sol ?? null,
    final_sol_reserves: data.final_sol_reserves ?? null,
    final_token_reserves: data.final_token_reserves ?? null,
    virtual_sol_reserves: data.virtual_sol_reserves ?? null,
    virtual_token_reserves: data.virtual_token_reserves ?? null,
  });

  if (result.changes === 0) return null;
  return result.lastInsertRowid as number;
}

export function updateGraduationPool(
  db: Database.Database,
  graduationId: number,
  poolAddress: string,
  poolDex: string,
  migrationSignature?: string,
  migrationSlot?: number,
  migrationTimestamp?: number
): void {
  db.prepare(`
    UPDATE graduations SET
      new_pool_address = @poolAddress,
      new_pool_dex = @poolDex,
      migration_signature = @migrationSignature,
      migration_slot = @migrationSlot,
      migration_timestamp = @migrationTimestamp
    WHERE id = @graduationId
  `).run({
    graduationId,
    poolAddress,
    poolDex,
    migrationSignature: migrationSignature ?? null,
    migrationSlot: migrationSlot ?? null,
    migrationTimestamp: migrationTimestamp ?? null,
  });
}

export function markObservationComplete(db: Database.Database, graduationId: number): void {
  db.prepare('UPDATE graduations SET observation_complete = 1 WHERE id = ?').run(graduationId);
}

export function getGraduationCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM graduations').get() as { count: number };
  return row.count;
}

export function getGraduationById(db: Database.Database, id: number) {
  return db.prepare('SELECT * FROM graduations WHERE id = ?').get(id);
}

export function getRecentGraduations(db: Database.Database, limit: number = 10) {
  return db.prepare('SELECT * FROM graduations ORDER BY timestamp DESC LIMIT ?').all(limit);
}

export function getPendingPoolGraduations(db: Database.Database) {
  return db.prepare(
    'SELECT * FROM graduations WHERE new_pool_address IS NULL AND observation_complete = 0 ORDER BY timestamp DESC'
  ).all();
}

// ==================== Pool observations ====================

export interface PoolObservationInsert {
  graduation_id: number;
  timestamp: number;
  seconds_since_graduation: number;
  pool_price_sol?: number;
  pool_sol_reserves?: number;
  pool_token_reserves?: number;
  pool_liquidity_usd?: number;
  jupiter_price_sol?: number;
  tx_count_since_graduation?: number;
  buy_count?: number;
  sell_count?: number;
}

export function insertPoolObservation(db: Database.Database, data: PoolObservationInsert): number {
  const result = db.prepare(`
    INSERT INTO pool_observations (
      graduation_id, timestamp, seconds_since_graduation,
      pool_price_sol, pool_sol_reserves, pool_token_reserves,
      pool_liquidity_usd, jupiter_price_sol,
      tx_count_since_graduation, buy_count, sell_count
    ) VALUES (
      @graduation_id, @timestamp, @seconds_since_graduation,
      @pool_price_sol, @pool_sol_reserves, @pool_token_reserves,
      @pool_liquidity_usd, @jupiter_price_sol,
      @tx_count_since_graduation, @buy_count, @sell_count
    )
  `).run({
    graduation_id: data.graduation_id,
    timestamp: data.timestamp,
    seconds_since_graduation: data.seconds_since_graduation,
    pool_price_sol: data.pool_price_sol ?? null,
    pool_sol_reserves: data.pool_sol_reserves ?? null,
    pool_token_reserves: data.pool_token_reserves ?? null,
    pool_liquidity_usd: data.pool_liquidity_usd ?? null,
    jupiter_price_sol: data.jupiter_price_sol ?? null,
    tx_count_since_graduation: data.tx_count_since_graduation ?? null,
    buy_count: data.buy_count ?? null,
    sell_count: data.sell_count ?? null,
  });

  return result.lastInsertRowid as number;
}

// ==================== Price comparisons ====================

export interface PriceComparisonInsert {
  graduation_id: number;
  timestamp: number;
  seconds_since_graduation: number;
  bonding_curve_price?: number;
  dex_pool_price?: number;
  jupiter_price?: number;
  bc_to_dex_spread_pct?: number;
  bc_to_jupiter_spread_pct?: number;
  dex_to_jupiter_spread_pct?: number;
}

export function insertPriceComparison(db: Database.Database, data: PriceComparisonInsert): number {
  const result = db.prepare(`
    INSERT INTO price_comparisons (
      graduation_id, timestamp, seconds_since_graduation,
      bonding_curve_price, dex_pool_price, jupiter_price,
      bc_to_dex_spread_pct, bc_to_jupiter_spread_pct, dex_to_jupiter_spread_pct
    ) VALUES (
      @graduation_id, @timestamp, @seconds_since_graduation,
      @bonding_curve_price, @dex_pool_price, @jupiter_price,
      @bc_to_dex_spread_pct, @bc_to_jupiter_spread_pct, @dex_to_jupiter_spread_pct
    )
  `).run({
    graduation_id: data.graduation_id,
    timestamp: data.timestamp,
    seconds_since_graduation: data.seconds_since_graduation,
    bonding_curve_price: data.bonding_curve_price ?? null,
    dex_pool_price: data.dex_pool_price ?? null,
    jupiter_price: data.jupiter_price ?? null,
    bc_to_dex_spread_pct: data.bc_to_dex_spread_pct ?? null,
    bc_to_jupiter_spread_pct: data.bc_to_jupiter_spread_pct ?? null,
    dex_to_jupiter_spread_pct: data.dex_to_jupiter_spread_pct ?? null,
  });

  return result.lastInsertRowid as number;
}

export function getPriceComparisons(db: Database.Database, graduationId: number) {
  return db.prepare(
    'SELECT * FROM price_comparisons WHERE graduation_id = ? ORDER BY seconds_since_graduation'
  ).all(graduationId) as PriceComparisonInsert[];
}

// ==================== Opportunities ====================

export interface OpportunityInsert {
  graduation_id: number;
  max_spread_pct?: number;
  max_spread_timestamp?: number;
  seconds_to_max_spread?: number;
  duration_above_05_pct?: number;
  duration_above_1_pct?: number;
  duration_above_2_pct?: number;
  spread_collapse_seconds?: number;
  estimated_profit_sol?: number;
  estimated_gas_sol?: number;
  estimated_jito_tip_sol?: number;
  estimated_slippage_pct?: number;
  net_profit_sol?: number;
  is_fillable?: number;
  available_liquidity_sol?: number;
  competition_tx_count_10s?: number;
  viability_score?: number;
  classification?: string;
}

export function insertOpportunity(db: Database.Database, data: OpportunityInsert): number {
  const result = db.prepare(`
    INSERT INTO opportunities (
      graduation_id, max_spread_pct, max_spread_timestamp,
      seconds_to_max_spread, duration_above_05_pct,
      duration_above_1_pct, duration_above_2_pct,
      spread_collapse_seconds, estimated_profit_sol,
      estimated_gas_sol, estimated_jito_tip_sol,
      estimated_slippage_pct, net_profit_sol,
      is_fillable, available_liquidity_sol,
      competition_tx_count_10s, viability_score, classification
    ) VALUES (
      @graduation_id, @max_spread_pct, @max_spread_timestamp,
      @seconds_to_max_spread, @duration_above_05_pct,
      @duration_above_1_pct, @duration_above_2_pct,
      @spread_collapse_seconds, @estimated_profit_sol,
      @estimated_gas_sol, @estimated_jito_tip_sol,
      @estimated_slippage_pct, @net_profit_sol,
      @is_fillable, @available_liquidity_sol,
      @competition_tx_count_10s, @viability_score, @classification
    )
  `).run({
    graduation_id: data.graduation_id,
    max_spread_pct: data.max_spread_pct ?? null,
    max_spread_timestamp: data.max_spread_timestamp ?? null,
    seconds_to_max_spread: data.seconds_to_max_spread ?? null,
    duration_above_05_pct: data.duration_above_05_pct ?? null,
    duration_above_1_pct: data.duration_above_1_pct ?? null,
    duration_above_2_pct: data.duration_above_2_pct ?? null,
    spread_collapse_seconds: data.spread_collapse_seconds ?? null,
    estimated_profit_sol: data.estimated_profit_sol ?? null,
    estimated_gas_sol: data.estimated_gas_sol ?? null,
    estimated_jito_tip_sol: data.estimated_jito_tip_sol ?? null,
    estimated_slippage_pct: data.estimated_slippage_pct ?? null,
    net_profit_sol: data.net_profit_sol ?? null,
    is_fillable: data.is_fillable ?? null,
    available_liquidity_sol: data.available_liquidity_sol ?? null,
    competition_tx_count_10s: data.competition_tx_count_10s ?? null,
    viability_score: data.viability_score ?? null,
    classification: data.classification ?? null,
  });

  return result.lastInsertRowid as number;
}

// ==================== Competition signals ====================

export interface CompetitionSignalInsert {
  graduation_id: number;
  timestamp: number;
  seconds_since_graduation?: number;
  tx_signature?: string;
  wallet_address?: string;
  action?: string;
  amount_sol?: number;
  is_likely_bot?: number;
}

export function insertCompetitionSignal(db: Database.Database, data: CompetitionSignalInsert): number {
  const result = db.prepare(`
    INSERT INTO competition_signals (
      graduation_id, timestamp, seconds_since_graduation,
      tx_signature, wallet_address, action, amount_sol, is_likely_bot
    ) VALUES (
      @graduation_id, @timestamp, @seconds_since_graduation,
      @tx_signature, @wallet_address, @action, @amount_sol, @is_likely_bot
    )
  `).run({
    graduation_id: data.graduation_id,
    timestamp: data.timestamp,
    seconds_since_graduation: data.seconds_since_graduation ?? null,
    tx_signature: data.tx_signature ?? null,
    wallet_address: data.wallet_address ?? null,
    action: data.action ?? null,
    amount_sol: data.amount_sol ?? null,
    is_likely_bot: data.is_likely_bot ?? null,
  });

  return result.lastInsertRowid as number;
}

export function getCompetitionCount10s(db: Database.Database, graduationId: number): number {
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM competition_signals WHERE graduation_id = ? AND seconds_since_graduation <= 10'
  ).get(graduationId) as { count: number };
  return row.count;
}
