/**
 * src/api/panel3-summary.ts
 *
 * Single-filter regime stability — same data as Panel 3 on /filter-analysis-v2
 * but as JSON for Claude self-serve via /api/panel3 and panel3.json in bot-status.
 *
 * Reuses the regime computation helpers from panel11.ts.
 */

import Database from 'better-sqlite3';
import { FILTER_CATALOG } from './aggregates';
import {
  loadRegimeRows,
  computeBucketBoundaries,
  runFilterRegime,
  CATALOG_PREDICATES,
  type RegimeRow,
} from './panel11';

export interface Panel3Row {
  filter: string;
  group: string;
  n: number;
  buckets: { n: number; win_rate_pct: number | null; avg_return_pct: number | null }[];
  wr_std_dev: number | null;
  stability: 'STABLE' | 'MODERATE' | 'CLUSTERED' | 'INSUFFICIENT';
}

export interface Panel3Data {
  generated_at: string;
  title: string;
  bucket_windows: { bucket: number; start_iso: string; end_iso: string }[];
  baseline: Panel3Row & { filter: string; group: string };
  filters: Panel3Row[];
}

export function computePanel3Summary(db: Database.Database): Panel3Data {
  const rows = loadRegimeRows(db);
  const boundaries = computeBucketBoundaries(rows);

  const bucket_windows = boundaries.map((b, i) => ({
    bucket: i + 1,
    start_iso: new Date(b.start * 1000).toISOString(),
    end_iso: new Date(b.end * 1000).toISOString(),
  }));

  const baseline: Panel3Row & { filter: string; group: string } = {
    filter: 'ALL labeled (no filter)',
    group: 'Baseline',
    ...runFilterRegime((_r: RegimeRow) => true, rows, boundaries),
  };

  const filters: Panel3Row[] = Array.from(CATALOG_PREDICATES.entries()).map(([name, pred]) => {
    const group = FILTER_CATALOG.find(f => f.name === name)?.group ?? 'Unknown';
    return {
      filter: name,
      group,
      ...runFilterRegime(pred, rows, boundaries),
    };
  });

  return {
    generated_at: new Date().toISOString(),
    title: 'Single-Filter Regime Stability',
    bucket_windows,
    baseline,
    filters,
  };
}
