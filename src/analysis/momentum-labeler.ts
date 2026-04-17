import Database from 'better-sqlite3';
import { getMomentumRow, labelMomentum, type MomentumLabel } from '../db/queries';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('momentum-labeler');

// Label thresholds (shared across all horizons)
const PUMP_THRESHOLD_PCT = 10;
const DUMP_THRESHOLD_PCT = -10;

function classifyAtHorizon(pct: number | null | undefined): MomentumLabel | null {
  if (pct == null) return null;
  if (pct >= PUMP_THRESHOLD_PCT) return 'PUMP';
  if (pct <= DUMP_THRESHOLD_PCT) return 'DUMP';
  return 'STABLE';
}

export class MomentumLabeler {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Label a graduation's momentum at three horizons (T+60, T+120, T+300).
   * >=+10% = PUMP, <=-10% = DUMP, else STABLE.
   * Primary label (T+300) falls back to T+600 if T+300 is missing; the row
   * is skipped entirely if neither checkpoint is available. T+60 and T+120
   * labels are nullable — they fall through as null when their checkpoint
   * is missing, which can happen on partial observations.
   */
  label(graduationId: number): void {
    const row = getMomentumRow(this.db, graduationId);
    if (!row) {
      logger.debug({ graduationId }, 'No momentum row to label');
      return;
    }

    const pctT300: number | null = row.pct_t300 ?? row.pct_t600 ?? null;
    if (pctT300 === null) {
      logger.debug({ graduationId }, 'No T+300 checkpoint data — cannot label');
      return;
    }

    const labelT300 = classifyAtHorizon(pctT300)!;
    const labelT60 = classifyAtHorizon(row.pct_t60);
    const labelT120 = classifyAtHorizon(row.pct_t120);

    labelMomentum(this.db, graduationId, {
      t300: labelT300,
      t60: labelT60,
      t120: labelT120,
    });

    logger.info(
      {
        graduationId,
        pctT60: row.pct_t60 != null ? row.pct_t60.toFixed(1) : null,
        pctT120: row.pct_t120 != null ? row.pct_t120.toFixed(1) : null,
        pctT300: pctT300.toFixed(1),
        labelT60,
        labelT120,
        labelT300,
      },
      'Momentum labeled'
    );
  }
}
