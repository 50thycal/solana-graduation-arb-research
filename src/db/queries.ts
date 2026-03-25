import Database from 'better-sqlite3';

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

export function insertGraduation(db: Database.Database, data: GraduationInsert): number {
  const stmt = db.prepare(`
    INSERT INTO graduations (
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
  const stmt = db.prepare(`
    UPDATE graduations SET
      new_pool_address = @poolAddress,
      new_pool_dex = @poolDex,
      migration_signature = @migrationSignature,
      migration_slot = @migrationSlot,
      migration_timestamp = @migrationTimestamp
    WHERE id = @graduationId
  `);

  stmt.run({
    graduationId,
    poolAddress,
    poolDex,
    migrationSignature: migrationSignature ?? null,
    migrationSlot: migrationSlot ?? null,
    migrationTimestamp: migrationTimestamp ?? null,
  });
}

export function getGraduationCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM graduations').get() as { count: number };
  return row.count;
}

export function getRecentGraduations(db: Database.Database, limit: number = 10) {
  return db.prepare('SELECT * FROM graduations ORDER BY timestamp DESC LIMIT ?').all(limit);
}

export function getGraduationById(db: Database.Database, id: number) {
  return db.prepare('SELECT * FROM graduations WHERE id = ?').get(id);
}

export function getPendingPoolGraduations(db: Database.Database) {
  return db.prepare(
    'SELECT * FROM graduations WHERE new_pool_address IS NULL AND observation_complete = 0 ORDER BY timestamp DESC'
  ).all();
}
