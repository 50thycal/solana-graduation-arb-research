import Database from 'better-sqlite3';
import pino from 'pino';
import { getMomentumRow, labelMomentum } from '../db/queries';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'momentum-labeler' });

// Label thresholds based on T+300s price change
const PUMP_THRESHOLD_PCT = 10;
const DUMP_THRESHOLD_PCT = -10;

export class MomentumLabeler {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Label a graduation's momentum based on its T+300s price checkpoint.
   * >+10% = PUMP, <-10% = DUMP, else STABLE.
   * Falls back to T+600s if T+300 is missing.
   */
  label(graduationId: number): void {
    const row = getMomentumRow(this.db, graduationId);
    if (!row) {
      logger.debug({ graduationId }, 'No momentum row to label');
      return;
    }

    // Prefer T+300, fall back to T+600
    const pctChange: number | null = row.pct_t300 ?? row.pct_t600 ?? null;

    if (pctChange === null) {
      logger.debug({ graduationId }, 'No price checkpoint data — cannot label');
      return;
    }

    let label: 'PUMP' | 'DUMP' | 'STABLE';
    if (pctChange >= PUMP_THRESHOLD_PCT) {
      label = 'PUMP';
    } else if (pctChange <= DUMP_THRESHOLD_PCT) {
      label = 'DUMP';
    } else {
      label = 'STABLE';
    }

    labelMomentum(this.db, graduationId, label);

    logger.info(
      {
        graduationId,
        pctChange: pctChange.toFixed(1),
        label,
      },
      'Momentum labeled'
    );
  }
}
