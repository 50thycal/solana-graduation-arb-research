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

// ==================== Graduation momentum ====================

export interface MomentumInsert {
  graduation_id: number;
  open_price_sol?: number;
  holder_count?: number;
  top5_wallet_pct?: number;
  dev_wallet_pct?: number;
  token_age_seconds?: number;
  total_sol_raised?: number;
}

export function insertMomentum(db: Database.Database, data: MomentumInsert): number {
  const result = db.prepare(`
    INSERT OR IGNORE INTO graduation_momentum (
      graduation_id, open_price_sol, holder_count, top5_wallet_pct,
      dev_wallet_pct, token_age_seconds, total_sol_raised
    ) VALUES (
      @graduation_id, @open_price_sol, @holder_count, @top5_wallet_pct,
      @dev_wallet_pct, @token_age_seconds, @total_sol_raised
    )
  `).run({
    graduation_id: data.graduation_id,
    open_price_sol: data.open_price_sol ?? null,
    holder_count: data.holder_count ?? null,
    top5_wallet_pct: data.top5_wallet_pct ?? null,
    dev_wallet_pct: data.dev_wallet_pct ?? null,
    token_age_seconds: data.token_age_seconds ?? null,
    total_sol_raised: data.total_sol_raised ?? null,
  });
  return result.lastInsertRowid as number;
}

/**
 * UPDATE holder-enrichment fields onto an existing graduation_momentum row.
 * Called from the async enrichment callback AFTER the row was already created
 * synchronously at graduation-detection time. This split ensures the row
 * always exists before the price-collector's first snapshot UPDATE lands.
 */
export function updateMomentumEnrichment(
  db: Database.Database,
  graduationId: number,
  data: {
    holder_count?: number;
    top5_wallet_pct?: number;
    dev_wallet_pct?: number;
    token_age_seconds?: number;
    dev_wallet_address?: string;
    creator_wallet_address?: string;
  }
): void {
  db.prepare(`
    UPDATE graduation_momentum SET
      holder_count           = COALESCE(@holder_count,           holder_count),
      top5_wallet_pct        = COALESCE(@top5_wallet_pct,        top5_wallet_pct),
      dev_wallet_pct         = COALESCE(@dev_wallet_pct,         dev_wallet_pct),
      token_age_seconds      = COALESCE(@token_age_seconds,      token_age_seconds),
      dev_wallet_address     = COALESCE(@dev_wallet_address,     dev_wallet_address),
      creator_wallet_address = COALESCE(@creator_wallet_address, creator_wallet_address)
    WHERE graduation_id = @graduation_id
  `).run({
    graduation_id: graduationId,
    holder_count: data.holder_count ?? null,
    top5_wallet_pct: data.top5_wallet_pct ?? null,
    dev_wallet_pct: data.dev_wallet_pct ?? null,
    token_age_seconds: data.token_age_seconds ?? null,
    dev_wallet_address: data.dev_wallet_address ?? null,
    creator_wallet_address: data.creator_wallet_address ?? null,
  });
}

// Fix Issue 4: whitelist prevents SQL column-name injection if a future caller
// passes unsanitized input. All current callers use values from CHECKPOINT_MAP.
const VALID_MOMENTUM_CHECKPOINTS = new Set([
  't5','t10','t15','t20','t25','t30','t35','t40','t45','t50','t55',
  't60','t90','t120','t150','t180','t240','t300','t600',
]);

export function updateMomentumPrice(
  db: Database.Database,
  graduationId: number,
  checkpoint: string,
  price: number,
  pctChange: number
): void {
  if (!VALID_MOMENTUM_CHECKPOINTS.has(checkpoint)) {
    throw new Error(`Invalid momentum checkpoint: ${checkpoint}`);
  }
  db.prepare(
    `UPDATE graduation_momentum SET price_${checkpoint} = ?, pct_${checkpoint} = ? WHERE graduation_id = ?`
  ).run(price, pctChange, graduationId);
}

export function updateMomentumOpenPrice(
  db: Database.Database,
  graduationId: number,
  openPrice: number
): void {
  db.prepare(
    'UPDATE graduation_momentum SET open_price_sol = ? WHERE graduation_id = ? AND open_price_sol IS NULL'
  ).run(openPrice, graduationId);
}

export type MomentumLabel = 'PUMP' | 'DUMP' | 'STABLE';

export function labelMomentum(
  db: Database.Database,
  graduationId: number,
  labels: {
    t300: MomentumLabel;
    t60: MomentumLabel | null;
    t120: MomentumLabel | null;
  }
): void {
  db.prepare(
    'UPDATE graduation_momentum SET label = ?, label_t60 = ?, label_t120 = ? WHERE graduation_id = ?'
  ).run(labels.t300, labels.t60, labels.t120, graduationId);
}

export function getMomentumRow(db: Database.Database, graduationId: number) {
  return db.prepare('SELECT * FROM graduation_momentum WHERE graduation_id = ?').get(graduationId) as any;
}

// ==================== Buy pressure quality ====================

export function updateBuyPressureMetrics(
  db: Database.Database,
  graduationId: number,
  metrics: {
    unique_buyers: number;
    buy_ratio: number | null;
    whale_pct: number | null;
    trade_count: number;
  }
): void {
  db.prepare(`
    UPDATE graduation_momentum
    SET buy_pressure_unique_buyers = ?,
        buy_pressure_buy_ratio = ?,
        buy_pressure_whale_pct = ?,
        buy_pressure_trade_count = ?
    WHERE graduation_id = ?
  `).run(
    metrics.unique_buyers,
    metrics.buy_ratio,
    metrics.whale_pct,
    metrics.trade_count,
    graduationId
  );
}

export function getExistingSignatures(
  db: Database.Database,
  graduationId: number
): Set<string> {
  const rows = db.prepare(
    'SELECT tx_signature FROM competition_signals WHERE graduation_id = ?'
  ).all(graduationId) as Array<{ tx_signature: string | null }>;
  return new Set(rows.map(r => r.tx_signature).filter((s): s is string => s !== null));
}

export function computeBuyPressureAggregates(
  db: Database.Database,
  graduationId: number
): { unique_buyers: number; buy_ratio: number | null; whale_pct: number | null; trade_count: number } {
  const row = db.prepare(`
    SELECT
      COUNT(DISTINCT CASE WHEN action = 'buy' THEN wallet_address END) as unique_buyers,
      CAST(SUM(CASE WHEN action = 'buy' THEN 1 ELSE 0 END) AS REAL) /
        NULLIF(SUM(CASE WHEN action IN ('buy', 'sell') THEN 1 ELSE 0 END), 0) as buy_ratio,
      CAST(MAX(CASE WHEN action = 'buy' THEN amount_sol ELSE 0 END) AS REAL) /
        NULLIF(SUM(CASE WHEN action = 'buy' THEN amount_sol ELSE 0 END), 0) as whale_pct,
      COUNT(*) as trade_count
    FROM competition_signals
    WHERE graduation_id = ? AND seconds_since_graduation >= 0 AND seconds_since_graduation <= 30
  `).get(graduationId) as any;

  return {
    unique_buyers: row?.unique_buyers ?? 0,
    buy_ratio: row?.buy_ratio ?? null,
    whale_pct: row?.whale_pct ?? null,
    trade_count: row?.trade_count ?? 0,
  };
}

export function updateGraduationEnrichment(
  db: Database.Database,
  graduationId: number,
  data: {
    holder_count?: number;
    top5_wallet_pct?: number;
    dev_wallet_pct?: number;
    token_age_seconds?: number;
    dev_wallet_address?: string;
    creator_wallet_address?: string;
  }
): void {
  db.prepare(`
    UPDATE graduations SET
      holder_count = @holder_count,
      top5_wallet_pct = @top5_wallet_pct,
      dev_wallet_pct = @dev_wallet_pct,
      token_age_seconds = @token_age_seconds,
      dev_wallet_address = @dev_wallet_address,
      creator_wallet_address = @creator_wallet_address
    WHERE id = @id
  `).run({
    id: graduationId,
    holder_count: data.holder_count ?? null,
    top5_wallet_pct: data.top5_wallet_pct ?? null,
    dev_wallet_pct: data.dev_wallet_pct ?? null,
    token_age_seconds: data.token_age_seconds ?? null,
    dev_wallet_address: data.dev_wallet_address ?? null,
    creator_wallet_address: data.creator_wallet_address ?? null,
  });
}

// ==================== Creator reputation queries ====================

export interface CreatorReputation {
  priorCount: number;
  rugRate: number | null;
  avgReturn: number | null;
  lastTokenAgeHours: number | null;
}

/**
 * Compute creator reputation by looking up all prior graduations from the same
 * creator wallet. Only considers tokens with completed T+300 price data.
 */
export function computeCreatorReputation(
  db: Database.Database,
  creatorWallet: string,
  currentGradTimestamp: number
): CreatorReputation {
  const row = db.prepare(`
    SELECT
      COUNT(*) as prior_count,
      AVG(CASE WHEN pct_t300 < -50 THEN 1.0 ELSE 0.0 END) as rug_rate,
      AVG(pct_t300) as avg_return,
      MAX(gm.created_at) as last_created_at
    FROM graduation_momentum gm
    JOIN graduations g ON g.id = gm.graduation_id
    WHERE gm.creator_wallet_address = @creator
      AND g.timestamp < @ts
      AND gm.pct_t300 IS NOT NULL
  `).get({ creator: creatorWallet, ts: currentGradTimestamp }) as any;

  const priorCount = row?.prior_count ?? 0;
  const lastCreatedAt = row?.last_created_at;
  const lastTokenAgeHours = (priorCount > 0 && lastCreatedAt)
    ? (currentGradTimestamp - lastCreatedAt) / 3600
    : null;

  return {
    priorCount,
    rugRate: priorCount > 0 ? (row.rug_rate ?? null) : null,
    avgReturn: priorCount > 0 ? (row.avg_return ?? null) : null,
    lastTokenAgeHours,
  };
}

/**
 * Write creator reputation scores to an existing graduation_momentum row.
 */
export function updateMomentumReputation(
  db: Database.Database,
  graduationId: number,
  rep: CreatorReputation
): void {
  db.prepare(`
    UPDATE graduation_momentum SET
      creator_prior_token_count    = @prior_count,
      creator_prior_rug_rate       = @rug_rate,
      creator_prior_avg_return     = @avg_return,
      creator_last_token_age_hours = @last_token_age_hours
    WHERE graduation_id = @graduation_id
  `).run({
    graduation_id: graduationId,
    prior_count: rep.priorCount,
    rug_rate: rep.rugRate,
    avg_return: rep.avgReturn,
    last_token_age_hours: rep.lastTokenAgeHours,
  });
}

// ==================== Trading queries ====================

export interface TradeInsert {
  graduation_id: number;
  mode: string;
  mint: string;
  pool_address: string;
  base_vault?: string;
  quote_vault?: string;
  entry_timestamp: number;
  entry_price_sol: number;
  entry_pct_from_open: number;
  entry_liquidity_sol: number;
  trade_size_sol: number;
  take_profit_pct: number;
  stop_loss_pct: number;
  max_hold_seconds: number;
  entry_slippage_pct?: number;
  filter_results_json?: string;
  filter_config_json?: string;
  strategy_id?: string;
}

export function insertTrade(db: Database.Database, data: TradeInsert): number {
  // entry_effective_price and entry_tokens_received are left NULL here — they
  // are populated via updateTradeEntryFill() after the buy actually fills.
  const result = db.prepare(`
    INSERT INTO trades_v2 (
      graduation_id, mode, status, mint, pool_address, base_vault, quote_vault,
      entry_timestamp, entry_price_sol, entry_pct_from_open, entry_liquidity_sol,
      entry_slippage_pct,
      trade_size_sol, take_profit_pct, stop_loss_pct, max_hold_seconds,
      filter_results_json, filter_config_json, strategy_id
    ) VALUES (
      @graduation_id, @mode, 'open', @mint, @pool_address, @base_vault, @quote_vault,
      @entry_timestamp, @entry_price_sol, @entry_pct_from_open, @entry_liquidity_sol,
      @entry_slippage_pct,
      @trade_size_sol, @take_profit_pct, @stop_loss_pct, @max_hold_seconds,
      @filter_results_json, @filter_config_json, @strategy_id
    )
  `).run({
    graduation_id: data.graduation_id,
    mode: data.mode,
    mint: data.mint,
    pool_address: data.pool_address,
    base_vault: data.base_vault ?? null,
    quote_vault: data.quote_vault ?? null,
    entry_timestamp: data.entry_timestamp,
    entry_price_sol: data.entry_price_sol,
    entry_pct_from_open: data.entry_pct_from_open,
    entry_liquidity_sol: data.entry_liquidity_sol,
    entry_slippage_pct: data.entry_slippage_pct ?? null,
    trade_size_sol: data.trade_size_sol,
    take_profit_pct: data.take_profit_pct,
    stop_loss_pct: data.stop_loss_pct,
    max_hold_seconds: data.max_hold_seconds,
    filter_results_json: data.filter_results_json ?? null,
    filter_config_json: data.filter_config_json ?? null,
    strategy_id: data.strategy_id ?? 'default',
  });
  return result.lastInsertRowid as number;
}

export interface TradeClose {
  exit_timestamp: number;
  exit_price_sol: number;
  exit_reason: string;
  exit_effective_price: number;
  gross_return_pct: number;
  gap_adjusted_return_pct: number;
  estimated_fees_sol: number;
  net_profit_sol: number;
  net_return_pct: number;
  exit_tx_signature?: string;
}

export function closeTrade(db: Database.Database, tradeId: number, data: TradeClose): void {
  db.prepare(`
    UPDATE trades_v2 SET
      status = 'closed',
      exit_timestamp = @exit_timestamp,
      exit_price_sol = @exit_price_sol,
      exit_reason = @exit_reason,
      exit_effective_price = @exit_effective_price,
      exit_tx_signature = @exit_tx_signature,
      gross_return_pct = @gross_return_pct,
      gap_adjusted_return_pct = @gap_adjusted_return_pct,
      estimated_fees_sol = @estimated_fees_sol,
      net_profit_sol = @net_profit_sol,
      net_return_pct = @net_return_pct
    WHERE id = @tradeId
  `).run({
    tradeId,
    exit_timestamp: data.exit_timestamp,
    exit_price_sol: data.exit_price_sol,
    exit_reason: data.exit_reason,
    exit_effective_price: data.exit_effective_price,
    exit_tx_signature: data.exit_tx_signature ?? null,
    gross_return_pct: data.gross_return_pct,
    gap_adjusted_return_pct: data.gap_adjusted_return_pct,
    estimated_fees_sol: data.estimated_fees_sol,
    net_profit_sol: data.net_profit_sol,
    net_return_pct: data.net_return_pct,
  });
}

export function markTradeFailed(db: Database.Database, tradeId: number, reason: string): void {
  db.prepare(`UPDATE trades_v2 SET status = 'failed', exit_reason = ? WHERE id = ?`)
    .run(reason, tradeId);
}

/**
 * Patch the entry fields after the buy actually fills — captures the real
 * effective price (with slippage) and tokens received. Called from
 * TradeEvaluator.onT30 between openTrade() and addPosition().
 */
export function updateTradeEntryFill(
  db: Database.Database,
  tradeId: number,
  data: {
    entry_effective_price: number;
    entry_tokens_received: number;
    entry_tx_signature?: string;
  }
): void {
  db.prepare(`
    UPDATE trades_v2 SET
      entry_effective_price = @entry_effective_price,
      entry_tokens_received = @entry_tokens_received,
      entry_tx_signature    = @entry_tx_signature
    WHERE id = @tradeId
  `).run({
    tradeId,
    entry_effective_price: data.entry_effective_price,
    entry_tokens_received: data.entry_tokens_received,
    entry_tx_signature: data.entry_tx_signature ?? null,
  });
}

export function insertTradeSkip(
  db: Database.Database,
  graduationId: number,
  skipReason: string,
  skipValue: number | null,
  pctT30: number | null,
  strategyId: string = 'default',
): void {
  db.prepare(`
    INSERT INTO trade_skips (graduation_id, skip_reason, skip_value, pct_t30, strategy_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(graduationId, skipReason, skipValue ?? null, pctT30 ?? null, strategyId);
}

export function getOpenTrades(db: Database.Database) {
  return db.prepare(`SELECT * FROM trades_v2 WHERE status = 'open'`).all();
}

export function getRecentTrades(db: Database.Database, limit = 50, includeArchived = false) {
  const archiveFilter = includeArchived ? '' : 'AND (t.archived IS NULL OR t.archived = 0)';
  return db.prepare(`
    SELECT t.*, g.mint as grad_mint
    FROM trades_v2 t
    JOIN graduations g ON g.id = t.graduation_id
    WHERE 1=1 ${archiveFilter}
    ORDER BY t.created_at DESC
    LIMIT ?
  `).all(limit);
}

export function getTradeStats(db: Database.Database, includeArchived = false) {
  const archiveFilter = includeArchived ? '' : 'WHERE (archived IS NULL OR archived = 0)';
  return db.prepare(`
    SELECT
      mode,
      COUNT(*) as total,
      COUNT(CASE WHEN status='closed' THEN 1 END) as closed,
      COUNT(CASE WHEN status='open' THEN 1 END) as open_count,
      COUNT(CASE WHEN status='failed' THEN 1 END) as failed,
      AVG(CASE WHEN status='closed' THEN net_return_pct END) as avg_net_return_pct,
      SUM(CASE WHEN status='closed' AND exit_reason IN ('take_profit','trailing_tp') THEN 1 ELSE 0 END) as tp_exits,
      SUM(CASE WHEN status='closed' AND exit_reason IN ('stop_loss','trailing_stop','breakeven_stop') THEN 1 ELSE 0 END) as sl_exits,
      SUM(CASE WHEN status='closed' AND exit_reason='timeout' THEN 1 ELSE 0 END) as timeout_exits,
      SUM(CASE WHEN status='closed' THEN net_profit_sol ELSE 0 END) as total_net_profit_sol
    FROM trades_v2
    ${archiveFilter}
    GROUP BY mode
  `).all();
}

export function getRecentSkips(db: Database.Database, limit = 50) {
  return db.prepare(`
    SELECT ts.*, g.mint
    FROM trade_skips ts
    JOIN graduations g ON g.id = ts.graduation_id
    ORDER BY ts.created_at DESC
    LIMIT ?
  `).all(limit);
}

export function getSkipReasonCounts(db: Database.Database) {
  return db.prepare(`
    SELECT skip_reason, COUNT(*) as count
    FROM trade_skips
    GROUP BY skip_reason
    ORDER BY count DESC
  `).all();
}

// ==================== Strategy config queries ====================

export interface StrategyConfigRow {
  id: string;
  label: string;
  enabled: number;
  config_json: string;
  created_at: number;
  updated_at: number;
}

export function getStrategyConfigs(db: Database.Database): StrategyConfigRow[] {
  return db.prepare('SELECT * FROM strategy_configs ORDER BY created_at').all() as StrategyConfigRow[];
}

export function getStrategyConfig(db: Database.Database, id: string): StrategyConfigRow | undefined {
  return db.prepare('SELECT * FROM strategy_configs WHERE id = ?').get(id) as StrategyConfigRow | undefined;
}

export function upsertStrategyConfig(
  db: Database.Database,
  id: string,
  label: string,
  configJson: string,
  enabled: number = 1,
): void {
  db.prepare(`
    INSERT INTO strategy_configs (id, label, enabled, config_json, updated_at)
    VALUES (@id, @label, @enabled, @config_json, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      label = @label,
      enabled = @enabled,
      config_json = @config_json,
      updated_at = unixepoch()
  `).run({ id, label, enabled, config_json: configJson });
}

export function deleteStrategyConfig(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM strategy_configs WHERE id = ?').run(id);
}

export function getTradeStatsByStrategy(db: Database.Database, includeArchived = false) {
  const archiveFilter = includeArchived ? '' : 'WHERE (archived IS NULL OR archived = 0)';
  return db.prepare(`
    SELECT
      strategy_id,
      mode,
      COUNT(*) as total,
      COUNT(CASE WHEN status='closed' THEN 1 END) as closed,
      COUNT(CASE WHEN status='open' THEN 1 END) as open_count,
      COUNT(CASE WHEN status='failed' THEN 1 END) as failed,
      ROUND(AVG(CASE WHEN status='closed' THEN net_return_pct END), 2) as avg_net_return_pct,
      SUM(CASE WHEN status='closed' AND exit_reason IN ('take_profit','trailing_tp') THEN 1 ELSE 0 END) as tp_exits,
      SUM(CASE WHEN status='closed' AND exit_reason IN ('stop_loss','trailing_stop','breakeven_stop') THEN 1 ELSE 0 END) as sl_exits,
      SUM(CASE WHEN status='closed' AND exit_reason='timeout' THEN 1 ELSE 0 END) as timeout_exits,
      ROUND(SUM(CASE WHEN status='closed' THEN net_profit_sol ELSE 0 END), 4) as total_net_profit_sol,
      MIN(entry_timestamp) as first_trade_ts,
      MAX(entry_timestamp) as last_trade_ts
    FROM trades_v2
    ${archiveFilter}
    GROUP BY strategy_id, mode
    ORDER BY strategy_id, mode
  `).all();
}

export function getOpenTradesByStrategy(db: Database.Database, strategyId: string) {
  return db.prepare(`SELECT * FROM trades_v2 WHERE status = 'open' AND strategy_id = ?`).all(strategyId);
}

/** Backfill momentum comparison fields on closed trades once graduation_momentum is complete */
export function backfillTradeMomentum(db: Database.Database): number {
  const result = db.prepare(`
    UPDATE trades_v2
    SET
      momentum_pct_t60  = (SELECT pct_t60  FROM graduation_momentum WHERE graduation_id = trades_v2.graduation_id),
      momentum_pct_t120 = (SELECT pct_t120 FROM graduation_momentum WHERE graduation_id = trades_v2.graduation_id),
      momentum_pct_t300 = (SELECT pct_t300 FROM graduation_momentum WHERE graduation_id = trades_v2.graduation_id),
      momentum_label    = (SELECT label    FROM graduation_momentum WHERE graduation_id = trades_v2.graduation_id)
    WHERE status = 'closed'
      AND momentum_pct_t300 IS NULL
      AND EXISTS (
        SELECT 1 FROM graduation_momentum
        WHERE graduation_id = trades_v2.graduation_id AND pct_t300 IS NOT NULL
      )
  `).run();
  return result.changes;
}

// ==================== Bot error log ====================

export interface BotErrorInsert {
  ts: number;          // epoch millis
  level: string;       // 'error' | 'fatal'
  name?: string;       // logger name or error class
  message: string;
  stack?: string;
  git_sha?: string;
}

export function insertBotError(db: Database.Database, data: BotErrorInsert): number {
  const result = db.prepare(`
    INSERT INTO bot_errors (ts, level, name, message, stack, git_sha)
    VALUES (@ts, @level, @name, @message, @stack, @git_sha)
  `).run({
    ts: data.ts,
    level: data.level,
    name: data.name ?? null,
    message: data.message,
    stack: data.stack ?? null,
    git_sha: data.git_sha ?? null,
  });
  return result.lastInsertRowid as number;
}

export interface BotErrorRow {
  id: number;
  ts: number;
  level: string;
  name: string | null;
  message: string;
  stack: string | null;
  git_sha: string | null;
}

export function getLastBotError(db: Database.Database): BotErrorRow | null {
  const row = db.prepare(
    'SELECT * FROM bot_errors ORDER BY id DESC LIMIT 1'
  ).get() as BotErrorRow | undefined;
  return row ?? null;
}

export function getRecentBotErrors(db: Database.Database, limit = 20): BotErrorRow[] {
  return db.prepare(
    'SELECT * FROM bot_errors ORDER BY id DESC LIMIT ?'
  ).all(limit) as BotErrorRow[];
}
