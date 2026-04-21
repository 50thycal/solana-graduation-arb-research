/**
 * src/api/filter-v2-data.ts
 *
 * Pure data computation for the /filter-analysis-v2 dashboard. Returns the
 * FilterV2Data object consumed by renderFilterV2Html and exposed as JSON via
 * /api/filter-v2 (plus per-panel /api/panelN endpoints) and the bot-status
 * branch sync (panel{1,2,4-10}.json).
 *
 * Extracted from src/index.ts to let gist-sync reuse the same computation
 * without routing through Express.
 */

import type Database from 'better-sqlite3';
import { computePanel11 } from './panel11';

export function computeFilterV2Data(
  db: Database.Database,
  opts?: { p6Raw?: unknown },
) {
      // ── Panel 3 row type: feature columns referenced by any predicate ──
      type RegimeRow = {
        created_at: number;
        label: string;
        pct_t30: number;
        pct_t300: number;
        cost_pct: number;
        bc_velocity_sol_per_min: number | null;
        token_age_seconds: number | null;
        holder_count: number | null;
        top5_wallet_pct: number | null;
        dev_wallet_pct: number | null;
        total_sol_raised: number | null;
        liquidity_sol_t30: number | null;
        volatility_0_30: number | null;
        monotonicity_0_30: number | null;
        max_drawdown_0_30: number | null;
        dip_and_recover_flag: number | null;
        acceleration_t30: number | null;
        early_vs_late_0_30: number | null;
        max_tick_drop_0_30: number | null;
        sum_abs_returns_0_30: number | null;
        buy_pressure_buy_ratio: number | null;
        buy_pressure_unique_buyers: number | null;
        buy_pressure_whale_pct: number | null;
        creator_prior_token_count: number | null;
        creator_prior_rug_rate: number | null;
        creator_prior_avg_return: number | null;
        creator_last_token_age_hours: number | null;
        max_relret_0_300: number | null;
      };

      // ── Panel 4 row type: RegimeRow + TP/SL checkpoint walk (every 5s, t40-t295).
      // pct_t300 already on RegimeRow (number, non-null for eligible rows). ──
      type Panel4Checkpoint = `pct_t${number}`;
      type Panel4Row = RegimeRow & { [K in Panel4Checkpoint]?: number | null };

      type FilterDef = {
        name: string;
        group: string;
        column: string;        // column to NOT NULL check (or '' for baseline)
        where: string;         // SQL condition (or '' for baseline)
        predicate: (r: RegimeRow) => boolean; // Panel 3 in-memory equivalent of `where`
      };

      const PANEL_1_FILTERS: FilterDef[] = [
        // ── Bonding Curve Velocity ──
        { name: 'vel < 5 sol/min',        group: 'Velocity', column: 'bc_velocity_sol_per_min', where: 'bc_velocity_sol_per_min < 5',
          predicate: (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min < 5 },
        { name: 'vel 5-10 sol/min',       group: 'Velocity', column: 'bc_velocity_sol_per_min', where: 'bc_velocity_sol_per_min >= 5 AND bc_velocity_sol_per_min < 10',
          predicate: (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 5 && r.bc_velocity_sol_per_min < 10 },
        { name: 'vel 5-20 sol/min',       group: 'Velocity', column: 'bc_velocity_sol_per_min', where: 'bc_velocity_sol_per_min >= 5 AND bc_velocity_sol_per_min < 20',
          predicate: (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 5 && r.bc_velocity_sol_per_min < 20 },
        { name: 'vel 10-20 sol/min',      group: 'Velocity', column: 'bc_velocity_sol_per_min', where: 'bc_velocity_sol_per_min >= 10 AND bc_velocity_sol_per_min < 20',
          predicate: (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 10 && r.bc_velocity_sol_per_min < 20 },
        { name: 'vel < 20 sol/min',       group: 'Velocity', column: 'bc_velocity_sol_per_min', where: 'bc_velocity_sol_per_min < 20',
          predicate: (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min < 20 },
        { name: 'vel < 50 sol/min',       group: 'Velocity', column: 'bc_velocity_sol_per_min', where: 'bc_velocity_sol_per_min < 50',
          predicate: (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min < 50 },
        { name: 'vel 20-50 sol/min',      group: 'Velocity', column: 'bc_velocity_sol_per_min', where: 'bc_velocity_sol_per_min >= 20 AND bc_velocity_sol_per_min < 50',
          predicate: (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 20 && r.bc_velocity_sol_per_min < 50 },
        { name: 'vel 50-200 sol/min',     group: 'Velocity', column: 'bc_velocity_sol_per_min', where: 'bc_velocity_sol_per_min >= 50 AND bc_velocity_sol_per_min < 200',
          predicate: (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 50 && r.bc_velocity_sol_per_min < 200 },
        { name: 'vel > 200 sol/min',      group: 'Velocity', column: 'bc_velocity_sol_per_min', where: 'bc_velocity_sol_per_min >= 200',
          predicate: (r) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 200 },

        // ── Bonding Curve Age ──
        { name: 'bc_age < 10 min',        group: 'BC Age', column: 'token_age_seconds', where: 'token_age_seconds < 600',
          predicate: (r) => r.token_age_seconds != null && r.token_age_seconds < 600 },
        { name: 'bc_age > 10 min',        group: 'BC Age', column: 'token_age_seconds', where: 'token_age_seconds > 600',
          predicate: (r) => r.token_age_seconds != null && r.token_age_seconds > 600 },
        { name: 'bc_age > 30 min',        group: 'BC Age', column: 'token_age_seconds', where: 'token_age_seconds > 1800',
          predicate: (r) => r.token_age_seconds != null && r.token_age_seconds > 1800 },
        { name: 'bc_age > 1 hr',          group: 'BC Age', column: 'token_age_seconds', where: 'token_age_seconds > 3600',
          predicate: (r) => r.token_age_seconds != null && r.token_age_seconds > 3600 },
        { name: 'bc_age > 1 day',         group: 'BC Age', column: 'token_age_seconds', where: 'token_age_seconds > 86400',
          predicate: (r) => r.token_age_seconds != null && r.token_age_seconds > 86400 },

        // ── Holders ──
        { name: 'holders >= 5',           group: 'Holders', column: 'holder_count', where: 'holder_count >= 5',
          predicate: (r) => r.holder_count != null && r.holder_count >= 5 },
        { name: 'holders >= 10',          group: 'Holders', column: 'holder_count', where: 'holder_count >= 10',
          predicate: (r) => r.holder_count != null && r.holder_count >= 10 },
        { name: 'holders >= 15',          group: 'Holders', column: 'holder_count', where: 'holder_count >= 15',
          predicate: (r) => r.holder_count != null && r.holder_count >= 15 },
        { name: 'holders >= 18',          group: 'Holders', column: 'holder_count', where: 'holder_count >= 18',
          predicate: (r) => r.holder_count != null && r.holder_count >= 18 },

        // ── Top 5 Concentration ──
        { name: 'top5 < 10%',             group: 'Top 5 Concentration', column: 'top5_wallet_pct', where: 'top5_wallet_pct < 10',
          predicate: (r) => r.top5_wallet_pct != null && r.top5_wallet_pct < 10 },
        { name: 'top5 < 15%',             group: 'Top 5 Concentration', column: 'top5_wallet_pct', where: 'top5_wallet_pct < 15',
          predicate: (r) => r.top5_wallet_pct != null && r.top5_wallet_pct < 15 },
        { name: 'top5 < 20%',             group: 'Top 5 Concentration', column: 'top5_wallet_pct', where: 'top5_wallet_pct < 20',
          predicate: (r) => r.top5_wallet_pct != null && r.top5_wallet_pct < 20 },
        { name: 'top5 > 15%',             group: 'Top 5 Concentration', column: 'top5_wallet_pct', where: 'top5_wallet_pct > 15',
          predicate: (r) => r.top5_wallet_pct != null && r.top5_wallet_pct > 15 },

        // ── Dev Wallet ──
        { name: 'dev < 3%',               group: 'Dev Wallet', column: 'dev_wallet_pct', where: 'dev_wallet_pct < 3',
          predicate: (r) => r.dev_wallet_pct != null && r.dev_wallet_pct < 3 },
        { name: 'dev < 5%',               group: 'Dev Wallet', column: 'dev_wallet_pct', where: 'dev_wallet_pct < 5',
          predicate: (r) => r.dev_wallet_pct != null && r.dev_wallet_pct < 5 },
        { name: 'dev > 5%',               group: 'Dev Wallet', column: 'dev_wallet_pct', where: 'dev_wallet_pct > 5',
          predicate: (r) => r.dev_wallet_pct != null && r.dev_wallet_pct > 5 },

        // ── SOL Raised ──
        { name: 'sol >= 70',              group: 'SOL Raised', column: 'total_sol_raised', where: 'total_sol_raised >= 70',
          predicate: (r) => r.total_sol_raised != null && r.total_sol_raised >= 70 },
        { name: 'sol >= 80',              group: 'SOL Raised', column: 'total_sol_raised', where: 'total_sol_raised >= 80',
          predicate: (r) => r.total_sol_raised != null && r.total_sol_raised >= 80 },
        { name: 'sol >= 84',              group: 'SOL Raised', column: 'total_sol_raised', where: 'total_sol_raised >= 84',
          predicate: (r) => r.total_sol_raised != null && r.total_sol_raised >= 84 },

        // ── Liquidity at T+30 ──
        { name: 'liquidity > 50 SOL',     group: 'Liquidity (T+30)', column: 'liquidity_sol_t30', where: 'liquidity_sol_t30 > 50',
          predicate: (r) => r.liquidity_sol_t30 != null && r.liquidity_sol_t30 > 50 },
        { name: 'liquidity > 100 SOL',    group: 'Liquidity (T+30)', column: 'liquidity_sol_t30', where: 'liquidity_sol_t30 > 100',
          predicate: (r) => r.liquidity_sol_t30 != null && r.liquidity_sol_t30 > 100 },
        { name: 'liquidity > 150 SOL',    group: 'Liquidity (T+30)', column: 'liquidity_sol_t30', where: 'liquidity_sol_t30 > 150',
          predicate: (r) => r.liquidity_sol_t30 != null && r.liquidity_sol_t30 > 150 },

        // ── Volatility (0-30s) ──
        { name: 'volatility < 10%',       group: 'Volatility (0-30s)', column: 'volatility_0_30', where: 'volatility_0_30 < 10',
          predicate: (r) => r.volatility_0_30 != null && r.volatility_0_30 < 10 },
        { name: 'volatility 10-30%',      group: 'Volatility (0-30s)', column: 'volatility_0_30', where: 'volatility_0_30 >= 10 AND volatility_0_30 < 30',
          predicate: (r) => r.volatility_0_30 != null && r.volatility_0_30 >= 10 && r.volatility_0_30 < 30 },
        { name: 'volatility 30-60%',      group: 'Volatility (0-30s)', column: 'volatility_0_30', where: 'volatility_0_30 >= 30 AND volatility_0_30 < 60',
          predicate: (r) => r.volatility_0_30 != null && r.volatility_0_30 >= 30 && r.volatility_0_30 < 60 },
        { name: 'volatility > 60%',       group: 'Volatility (0-30s)', column: 'volatility_0_30', where: 'volatility_0_30 >= 60',
          predicate: (r) => r.volatility_0_30 != null && r.volatility_0_30 >= 60 },

        // ── Path Shape: Monotonicity ──
        { name: 'mono > 0.33',            group: 'Path: Monotonicity', column: 'monotonicity_0_30', where: 'monotonicity_0_30 > 0.33',
          predicate: (r) => r.monotonicity_0_30 != null && r.monotonicity_0_30 > 0.33 },
        { name: 'mono > 0.5',             group: 'Path: Monotonicity', column: 'monotonicity_0_30', where: 'monotonicity_0_30 > 0.5',
          predicate: (r) => r.monotonicity_0_30 != null && r.monotonicity_0_30 > 0.5 },
        { name: 'mono > 0.66',            group: 'Path: Monotonicity', column: 'monotonicity_0_30', where: 'monotonicity_0_30 > 0.66',
          predicate: (r) => r.monotonicity_0_30 != null && r.monotonicity_0_30 > 0.66 },

        // ── Path Shape: Drawdown ──
        { name: 'max_dd > -10% (shallow)',group: 'Path: Drawdown', column: 'max_drawdown_0_30', where: 'max_drawdown_0_30 > -10',
          predicate: (r) => r.max_drawdown_0_30 != null && r.max_drawdown_0_30 > -10 },
        { name: 'max_dd > -20%',          group: 'Path: Drawdown', column: 'max_drawdown_0_30', where: 'max_drawdown_0_30 > -20',
          predicate: (r) => r.max_drawdown_0_30 != null && r.max_drawdown_0_30 > -20 },

        // ── Path Shape: Other ──
        { name: 'dip_and_recover = 1',    group: 'Path: Other', column: 'dip_and_recover_flag', where: 'dip_and_recover_flag = 1',
          predicate: (r) => r.dip_and_recover_flag != null && r.dip_and_recover_flag === 1 },
        { name: 'acceleration > 0',       group: 'Path: Other', column: 'acceleration_t30', where: 'acceleration_t30 > 0',
          predicate: (r) => r.acceleration_t30 != null && r.acceleration_t30 > 0 },
        { name: 'front-loaded (early>late)',  group: 'Path: Other', column: 'early_vs_late_0_30', where: 'early_vs_late_0_30 > 0',
          predicate: (r) => r.early_vs_late_0_30 != null && r.early_vs_late_0_30 > 0 },
        { name: 'back-loaded (late>early)',   group: 'Path: Other', column: 'early_vs_late_0_30', where: 'early_vs_late_0_30 < 0',
          predicate: (r) => r.early_vs_late_0_30 != null && r.early_vs_late_0_30 < 0 },

        // ── Buy Pressure (T+0 to T+30) ──
        { name: 'buy_ratio > 0.5',        group: 'Buy Pressure', column: 'buy_pressure_buy_ratio', where: 'buy_pressure_buy_ratio > 0.5',
          predicate: (r) => r.buy_pressure_buy_ratio != null && r.buy_pressure_buy_ratio > 0.5 },
        { name: 'buy_ratio > 0.6',        group: 'Buy Pressure', column: 'buy_pressure_buy_ratio', where: 'buy_pressure_buy_ratio > 0.6',
          predicate: (r) => r.buy_pressure_buy_ratio != null && r.buy_pressure_buy_ratio > 0.6 },
        { name: 'unique_buyers >= 5',     group: 'Buy Pressure', column: 'buy_pressure_unique_buyers', where: 'buy_pressure_unique_buyers >= 5',
          predicate: (r) => r.buy_pressure_unique_buyers != null && r.buy_pressure_unique_buyers >= 5 },
        { name: 'unique_buyers >= 10',    group: 'Buy Pressure', column: 'buy_pressure_unique_buyers', where: 'buy_pressure_unique_buyers >= 10',
          predicate: (r) => r.buy_pressure_unique_buyers != null && r.buy_pressure_unique_buyers >= 10 },
        { name: 'whale_pct < 30%',        group: 'Buy Pressure', column: 'buy_pressure_whale_pct', where: 'buy_pressure_whale_pct < 30',
          predicate: (r) => r.buy_pressure_whale_pct != null && r.buy_pressure_whale_pct < 30 },
        { name: 'whale_pct < 50%',        group: 'Buy Pressure', column: 'buy_pressure_whale_pct', where: 'buy_pressure_whale_pct < 50',
          predicate: (r) => r.buy_pressure_whale_pct != null && r.buy_pressure_whale_pct < 50 },

        // ── Creator Reputation ──
        { name: 'fresh_dev',               group: 'Creator Rep', column: 'creator_prior_token_count', where: 'creator_prior_token_count IS NOT NULL AND creator_prior_token_count = 0',
          predicate: (r) => r.creator_prior_token_count != null && r.creator_prior_token_count === 0 },
        { name: 'repeat_dev >= 3',         group: 'Creator Rep', column: 'creator_prior_token_count', where: 'creator_prior_token_count >= 3',
          predicate: (r) => r.creator_prior_token_count != null && r.creator_prior_token_count >= 3 },
        { name: 'clean_dev',              group: 'Creator Rep', column: 'creator_prior_rug_rate', where: 'creator_prior_rug_rate IS NOT NULL AND creator_prior_rug_rate < 0.3',
          predicate: (r) => r.creator_prior_rug_rate != null && r.creator_prior_rug_rate < 0.3 },
        { name: 'serial_rugger',          group: 'Creator Rep', column: 'creator_prior_rug_rate', where: 'creator_prior_rug_rate >= 0.7',
          predicate: (r) => r.creator_prior_rug_rate != null && r.creator_prior_rug_rate >= 0.7 },
        { name: 'rapid_fire',             group: 'Creator Rep', column: 'creator_last_token_age_hours', where: 'creator_last_token_age_hours IS NOT NULL AND creator_last_token_age_hours < 1',
          predicate: (r) => r.creator_last_token_age_hours != null && r.creator_last_token_age_hours < 1 },

        // ── T+30 Entry Gate ──
        { name: 't30 > 0%',                       group: 'T+30 Entry', column: 'pct_t30', where: 'pct_t30 > 0',
          predicate: (r) => r.pct_t30 > 0 },
        { name: 't30 between +5% and +50%',       group: 'T+30 Entry', column: 'pct_t30', where: 'pct_t30 >= 5 AND pct_t30 <= 50',
          predicate: (r) => r.pct_t30 >= 5 && r.pct_t30 <= 50 },
        { name: 't30 between +5% and +100%',      group: 'T+30 Entry', column: 'pct_t30', where: 'pct_t30 >= 5 AND pct_t30 <= 100',
          predicate: (r) => r.pct_t30 >= 5 && r.pct_t30 <= 100 },
        { name: 't30 between +10% and +50%',      group: 'T+30 Entry', column: 'pct_t30', where: 'pct_t30 >= 10 AND pct_t30 <= 50',
          predicate: (r) => r.pct_t30 >= 10 && r.pct_t30 <= 50 },
      ];

      // Helper: run a single filter query and return normalized stats.
      // labelCol picks the horizon: 'label' (T+300, default), 'label_t60', or 'label_t120'.
      const runFilterStats = (
        column: string,
        whereCond: string,
        labelCol: 'label' | 'label_t60' | 'label_t120' = 'label',
      ) => {
        const baseWhere = `${labelCol} IS NOT NULL`;
        const colCheck = column ? `${column} IS NOT NULL` : '';
        const cond = whereCond || '';
        const fullWhere = [baseWhere, colCheck, cond].filter(Boolean).join(' AND ');
        const row = db.prepare(`
          SELECT
            COUNT(*) as n,
            SUM(CASE WHEN ${labelCol}='PUMP'   THEN 1 ELSE 0 END) as pump,
            SUM(CASE WHEN ${labelCol}='DUMP'   THEN 1 ELSE 0 END) as dump,
            SUM(CASE WHEN ${labelCol}='STABLE' THEN 1 ELSE 0 END) as stable
          FROM graduation_momentum
          WHERE ${fullWhere}
        `).get() as { n: number; pump: number; dump: number; stable: number };
        const winRate = row.n > 0 ? +(row.pump / row.n * 100).toFixed(1) : null;
        const pumpDump = row.dump > 0 ? +(row.pump / row.dump).toFixed(2) : null;
        return {
          n: row.n,
          pump: row.pump,
          dump: row.dump,
          stable: row.stable,
          win_rate_pct: winRate,
          pump_dump_ratio: pumpDump,
        };
      };

      // ── Panel 2 helpers: T+30-anchored MAE / MFE / Final return percentiles ──

      // Linear-interpolation percentile. `sorted` must be ascending.
      const percentile = (sorted: number[], p: number): number | null => {
        if (sorted.length === 0) return null;
        if (sorted.length === 1) return sorted[0];
        const idx = (p / 100) * (sorted.length - 1);
        const lo = Math.floor(idx);
        const hi = Math.ceil(idx);
        if (lo === hi) return sorted[lo];
        return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
      };

      // Snapshot columns scanned for MAE/MFE — every 5s from T+30 through T+300 inclusive.
      // Pre-rollout rows have NULL for t65-t295; the window builder skips them.
      const SNAPSHOT_COLS: string[] = (() => {
        const cols: string[] = [];
        for (let sec = 30; sec <= 300; sec += 5) cols.push(`price_t${sec}`);
        return cols;
      })();

      type SnapshotRow = Record<string, number | null>;

      const runFilterPercentiles = (column: string, whereCond: string) => {
        const baseWhere = "label IS NOT NULL AND price_t30 IS NOT NULL AND price_t30 > 0 AND price_t300 IS NOT NULL AND price_t300 > 0";
        const colCheck = column ? `${column} IS NOT NULL` : '';
        const cond = whereCond || '';
        const fullWhere = [baseWhere, colCheck, cond].filter(Boolean).join(' AND ');
        const rows = db.prepare(`
          SELECT ${SNAPSHOT_COLS.join(', ')}
          FROM graduation_momentum
          WHERE ${fullWhere}
        `).all() as SnapshotRow[];

        const maes: number[] = [];
        const mfes: number[] = [];
        const finals: number[] = [];

        for (const r of rows) {
          const t30 = r.price_t30;
          const t300 = r.price_t300;
          if (t30 == null || t30 <= 0 || t300 == null || t300 <= 0) continue;
          // Collect non-null, positive prices in the t30..t300 window
          const window: number[] = [];
          for (const c of SNAPSHOT_COLS) {
            const v = r[c];
            if (v != null && v > 0) window.push(v);
          }
          if (window.length < 2) continue;
          const minP = Math.min(...window);
          const maxP = Math.max(...window);
          maes.push((minP / t30 - 1) * 100);
          mfes.push((maxP / t30 - 1) * 100);
          finals.push((t300 / t30 - 1) * 100);
        }

        const n = finals.length;
        const round = (v: number | null) => v == null ? null : +v.toFixed(1);
        const round2 = (v: number | null) => v == null ? null : +v.toFixed(2);

        if (n === 0) {
          return {
            n: 0,
            mae_p10: null, mae_p25: null, mae_p50: null, mae_p75: null, mae_p90: null,
            mfe_p10: null, mfe_p25: null, mfe_p50: null, mfe_p75: null, mfe_p90: null,
            final_p10: null, final_p25: null, final_p50: null, final_p75: null, final_p90: null,
            final_mean: null, final_stddev: null, sharpe_ish: null,
          };
        }

        const maesSorted = [...maes].sort((a, b) => a - b);
        const mfesSorted = [...mfes].sort((a, b) => a - b);
        const finalsSorted = [...finals].sort((a, b) => a - b);

        const mean = finals.reduce((s, v) => s + v, 0) / n;
        let stddev: number | null = null;
        if (n >= 2) {
          const variance = finals.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
          stddev = Math.sqrt(variance);
        }
        const sharpe = stddev != null && stddev > 0 ? mean / stddev : null;

        return {
          n,
          mae_p10: round(percentile(maesSorted, 10)),
          mae_p25: round(percentile(maesSorted, 25)),
          mae_p50: round(percentile(maesSorted, 50)),
          mae_p75: round(percentile(maesSorted, 75)),
          mae_p90: round(percentile(maesSorted, 90)),
          mfe_p10: round(percentile(mfesSorted, 10)),
          mfe_p25: round(percentile(mfesSorted, 25)),
          mfe_p50: round(percentile(mfesSorted, 50)),
          mfe_p75: round(percentile(mfesSorted, 75)),
          mfe_p90: round(percentile(mfesSorted, 90)),
          final_p10: round(percentile(finalsSorted, 10)),
          final_p25: round(percentile(finalsSorted, 25)),
          final_p50: round(percentile(finalsSorted, 50)),
          final_p75: round(percentile(finalsSorted, 75)),
          final_p90: round(percentile(finalsSorted, 90)),
          final_mean: round(mean),
          final_stddev: round(stddev),
          sharpe_ish: round2(sharpe),
        };
      };

      // ── Panel 3 helpers: regime stability across time buckets ──

      const ROUND_TRIP_COST_PCT_V2 = 3.0;
      const PANEL_3_BUCKET_COUNT = 4;

      // Single load: all eligible rows for regime analysis, sorted by created_at ASC
      const regimeRows = db.prepare(`
        SELECT created_at, label, pct_t30, pct_t300,
               COALESCE(round_trip_slippage_pct, ${ROUND_TRIP_COST_PCT_V2}) as cost_pct,
               bc_velocity_sol_per_min, token_age_seconds, holder_count, top5_wallet_pct,
               dev_wallet_pct, total_sol_raised, liquidity_sol_t30, volatility_0_30,
               monotonicity_0_30, max_drawdown_0_30, dip_and_recover_flag, acceleration_t30,
               early_vs_late_0_30, buy_pressure_buy_ratio, buy_pressure_unique_buyers,
               buy_pressure_whale_pct,
               creator_prior_token_count, creator_prior_rug_rate, creator_prior_avg_return,
               creator_last_token_age_hours,
               max_relret_0_300,
               max_tick_drop_0_30, sum_abs_returns_0_30
        FROM graduation_momentum
        WHERE label IS NOT NULL
          AND pct_t30 IS NOT NULL
          AND pct_t300 IS NOT NULL
          AND created_at IS NOT NULL
        ORDER BY created_at ASC
      `).all() as RegimeRow[];

      // Global bucket boundaries — same for every filter so cross-row comparison is meaningful
      const bucketBoundaries: { start: number; end: number }[] = [];
      if (regimeRows.length > 0) {
        const bucketSize = Math.ceil(regimeRows.length / PANEL_3_BUCKET_COUNT);
        for (let i = 0; i < PANEL_3_BUCKET_COUNT; i++) {
          const startIdx = i * bucketSize;
          const endIdx = Math.min((i + 1) * bucketSize, regimeRows.length);
          if (startIdx >= regimeRows.length) break;
          bucketBoundaries.push({
            start: regimeRows[startIdx].created_at,
            end: regimeRows[endIdx - 1].created_at,
          });
        }
      }

      const runFilterRegime = (predicate: (r: RegimeRow) => boolean) => {
        const buckets: { n: number; pump: number; returns: number[] }[] =
          Array.from({ length: bucketBoundaries.length }, () => ({ n: 0, pump: 0, returns: [] }));

        for (const r of regimeRows) {
          if (!predicate(r)) continue;
          let bucketIdx = -1;
          for (let i = 0; i < bucketBoundaries.length; i++) {
            if (r.created_at <= bucketBoundaries[i].end) { bucketIdx = i; break; }
          }
          if (bucketIdx === -1) bucketIdx = bucketBoundaries.length - 1;
          if (bucketIdx < 0) continue;
          const b = buckets[bucketIdx];
          b.n++;
          if (r.label === 'PUMP') b.pump++;
          const ret = ((1 + r.pct_t300 / 100) / (1 + r.pct_t30 / 100) - 1) * 100 - r.cost_pct;
          b.returns.push(ret);
        }

        const MIN_BUCKET_N = 5;
        const perBucket = buckets.map(b => {
          if (b.n < MIN_BUCKET_N) return { n: b.n, win_rate_pct: null as number | null, avg_return_pct: null as number | null };
          const wr = +(b.pump / b.n * 100).toFixed(1);
          const avgRet = +(b.returns.reduce((s, v) => s + v, 0) / b.returns.length).toFixed(1);
          return { n: b.n, win_rate_pct: wr, avg_return_pct: avgRet };
        });

        const validWRs = perBucket.filter(b => b.win_rate_pct != null).map(b => b.win_rate_pct as number);
        let wrStdDev: number | null = null;
        let stability: 'STABLE' | 'MODERATE' | 'CLUSTERED' | 'INSUFFICIENT' = 'INSUFFICIENT';
        if (validWRs.length >= 2) {
          const mean = validWRs.reduce((a, b) => a + b, 0) / validWRs.length;
          wrStdDev = +Math.sqrt(validWRs.reduce((s, w) => s + (w - mean) ** 2, 0) / validWRs.length).toFixed(1);
          stability = wrStdDev < 8 ? 'STABLE' : wrStdDev < 15 ? 'MODERATE' : 'CLUSTERED';
        }

        return {
          n: buckets.reduce((s, b) => s + b.n, 0),
          buckets: perBucket,
          wr_std_dev: wrStdDev,
          stability,
        };
      };

      // Baseline: all labeled tokens, no filter
      const baselineStats = runFilterStats('', '');
      const baseline = {
        filter: 'ALL labeled (no filter)',
        group: 'Baseline',
        ...baselineStats,
      };

      // Run all panel 1 filters
      const filters = PANEL_1_FILTERS.map(f => ({
        filter: f.name,
        group: f.group,
        ...runFilterStats(f.column, f.where),
      }));

      // Panel 1 horizon variants — same predicates, but PUMP/DUMP/STABLE
      // counts from label_t60 / label_t120 instead of the T+300 label.
      const baseline_t60 = {
        filter: 'ALL labeled (no filter)',
        group: 'Baseline',
        ...runFilterStats('', '', 'label_t60'),
      };
      const filters_t60 = PANEL_1_FILTERS.map(f => ({
        filter: f.name,
        group: f.group,
        ...runFilterStats(f.column, f.where, 'label_t60'),
      }));
      const baseline_t120 = {
        filter: 'ALL labeled (no filter)',
        group: 'Baseline',
        ...runFilterStats('', '', 'label_t120'),
      };
      const filters_t120 = PANEL_1_FILTERS.map(f => ({
        filter: f.name,
        group: f.group,
        ...runFilterStats(f.column, f.where, 'label_t120'),
      }));

      // ── Panel 2: T+30-anchored MAE/MFE/Final percentiles + Sharpe-ish ──
      const baseline2 = {
        filter: 'ALL labeled (no filter)',
        group: 'Baseline',
        ...runFilterPercentiles('', ''),
      };
      const filters2 = PANEL_1_FILTERS.map(f => ({
        filter: f.name,
        group: f.group,
        ...runFilterPercentiles(f.column, f.where),
      }));

      // ── Panel 3: regime stability across 4 time buckets ──
      const baseline3 = {
        filter: 'ALL labeled (no filter)',
        group: 'Baseline',
        ...runFilterRegime(() => true),
      };
      const filters3 = PANEL_1_FILTERS.map(f => ({
        filter: f.name,
        group: f.group,
        ...runFilterRegime(f.predicate),
      }));

      // ── Panel 11: combo filter regime stability — delegated to src/api/panel11.ts ──
      const panel11Data = computePanel11(db);
      const { baseline: baseline11, filters: filters11 } = panel11Data;

      // ── Panel 4: dynamic TP/SL EV simulator ──
      // Constants MUST mirror simulateWithTP at src/index.ts:1283-1359 exactly.
      // SL gap recalibrated 2026-04-15 from 0.20 -> 0.30 (live SL fills observed at -34% to -40%)
      const PANEL_4_SL_GAP_PENALTY = 0.30;
      const PANEL_4_TP_GAP_PENALTY = 0.10;
      // Every 5s from T+40 to T+295. Pre-rollout rows have NULL past t60 / sparse 60-300;
      // the walk skips them via `if (v == null) continue`.
      const PANEL_4_CHECKPOINTS: readonly `pct_t${number}`[] = (() => {
        const cps: `pct_t${number}`[] = [];
        for (let sec = 40; sec <= 295; sec += 5) cps.push(`pct_t${sec}` as const);
        return cps;
      })();
      const PANEL_4_TP_GRID = [10, 15, 20, 25, 30, 35, 40, 50, 60, 75, 100, 150] as const;
      const PANEL_4_SL_GRID = [3, 4, 5, 7.5, 10, 12.5, 15, 20, 25, 30] as const;
      const PANEL_4_DEFAULT_TP = 30;
      const PANEL_4_DEFAULT_SL = 10;
      const PANEL_4_MIN_N_FOR_OPTIMUM = 30;
      const PANEL_4_MIN_TP_HITS_FOR_OPTIMUM = 3;

      // Single load: all eligible rows for Panel 4.
      // Stricter than regimeRows: also guards against pct_t30 <= -99 (division pathology).
      const panel4WalkCols = PANEL_4_CHECKPOINTS.join(', ');
      const panel4Rows = db.prepare(`
        SELECT
          created_at, label,
          pct_t30, ${panel4WalkCols}, pct_t300,
          COALESCE(round_trip_slippage_pct, ${ROUND_TRIP_COST_PCT_V2}) as cost_pct,
          bc_velocity_sol_per_min, token_age_seconds, holder_count, top5_wallet_pct,
          dev_wallet_pct, total_sol_raised, liquidity_sol_t30, volatility_0_30,
          monotonicity_0_30, max_drawdown_0_30, dip_and_recover_flag, acceleration_t30,
          early_vs_late_0_30, buy_pressure_buy_ratio, buy_pressure_unique_buyers,
          buy_pressure_whale_pct,
          creator_prior_token_count, creator_prior_rug_rate, creator_prior_avg_return,
          creator_last_token_age_hours,
          max_relret_0_300,
          max_tick_drop_0_30, sum_abs_returns_0_30
        FROM graduation_momentum
        WHERE label IS NOT NULL
          AND pct_t30 IS NOT NULL
          AND pct_t30 > -99
          AND pct_t300 IS NOT NULL
      `).all() as Panel4Row[];

      type Panel4Horizon = 'pct_t60' | 'pct_t120' | 'pct_t300';

      // Simulate one token at one (tp, sl). Byte-for-byte mirror of simulateWithTP
      // when maxCheckpoint === 'pct_t300' (default). For shorter horizons the
      // checkpoint scan is truncated at maxCheckpoint and the fall-through uses
      // that column's value (e.g. pct_t60). Returns { ret, tpHit } — ret is
      // already cost-adjusted.
      const simulateInMemory = (
        r: Panel4Row,
        tp: number,
        sl: number,
        maxCheckpoint: Panel4Horizon = 'pct_t300',
      ): { ret: number; tpHit: boolean } => {
        const entryRatio = 1 + r.pct_t30 / 100;
        const stopLevelPct = (entryRatio * (1 - sl / 100) - 1) * 100;
        const tpLevelPct   = (entryRatio * (1 + tp / 100) - 1) * 100;

        // Truncate checkpoint scan at maxCheckpoint. For 'pct_t300' the
        // indexOf is -1 (not in PANEL_4_CHECKPOINTS) → scan everything.
        const maxIdx = (PANEL_4_CHECKPOINTS as readonly string[]).indexOf(maxCheckpoint);
        const cps = maxIdx >= 0
          ? PANEL_4_CHECKPOINTS.slice(0, maxIdx + 1)
          : PANEL_4_CHECKPOINTS;

        for (const cp of cps) {
          const v = r[cp];
          if (v == null) continue;
          if (v <= stopLevelPct) {
            // Price-multiplier SL (mirrors trade-logger.ts:112)
            const exitRatio = (1 + v / 100) * (1 - PANEL_4_SL_GAP_PENALTY);
            const ret = (exitRatio / entryRatio - 1) * 100;
            return { ret: ret - r.cost_pct, tpHit: false };
          }
          if (v >= tpLevelPct)   return { ret:  (tp * (1 - PANEL_4_TP_GAP_PENALTY)) - r.cost_pct, tpHit: true };
        }
        // Fall-through: exit at maxCheckpoint. For 'pct_t300' the eligibility
        // predicate guarantees non-null; for shorter horizons we guard against
        // missing checkpoints on partial observations.
        const fallVal = r[maxCheckpoint as keyof Panel4Row] as number | null | undefined;
        if (fallVal == null) return { ret: -100 - r.cost_pct, tpHit: false };
        const fallRet = ((1 + fallVal / 100) / entryRatio - 1) * 100 - r.cost_pct;
        return { ret: fallRet, tpHit: false };
      };

      const runFilterPanel4 = (
        predicate: (r: Panel4Row) => boolean,
        maxCheckpoint: Panel4Horizon = 'pct_t300',
      ) => {
        const filtered = panel4Rows.filter(predicate);
        const n = filtered.length;
        const comboCount = PANEL_4_TP_GRID.length * PANEL_4_SL_GRID.length;
        const avgRet = new Array<number>(comboCount).fill(0);
        const medRet = new Array<number>(comboCount).fill(0);
        const winRate = new Array<number>(comboCount).fill(0);
        let optimal: { tp: number; sl: number; avg_ret: number; win_rate: number } | null = null;

        if (n === 0) {
          return { n: 0, combos: { avg_ret: avgRet, med_ret: medRet, win_rate: winRate }, optimal };
        }

        const tpHits = new Array<number>(comboCount).fill(0);

        for (let ti = 0; ti < PANEL_4_TP_GRID.length; ti++) {
          for (let si = 0; si < PANEL_4_SL_GRID.length; si++) {
            const tp = PANEL_4_TP_GRID[ti];
            const sl = PANEL_4_SL_GRID[si];
            const returns: number[] = new Array(n);
            let tpHit = 0;
            let wins = 0;
            let sum = 0;
            for (let k = 0; k < n; k++) {
              const out = simulateInMemory(filtered[k], tp, sl, maxCheckpoint);
              returns[k] = out.ret;
              if (out.tpHit) tpHit++;
              if (out.ret > 0) wins++;
              sum += out.ret;
            }
            const sorted = returns.slice().sort((a, b) => a - b);
            const median = sorted[Math.floor(n / 2)];
            const idx = ti * PANEL_4_SL_GRID.length + si;
            avgRet[idx] = +(sum / n).toFixed(1);
            medRet[idx] = +median.toFixed(1);
            winRate[idx] = Math.round(wins / n * 100);
            tpHits[idx] = tpHit;
          }
        }

        // Find optimal: max avg_ret among combos with tp_hit >= 3, gated by filter n >= 30
        if (n >= PANEL_4_MIN_N_FOR_OPTIMUM) {
          let bestIdx = -1;
          let bestAvg = -Infinity;
          for (let i = 0; i < comboCount; i++) {
            if (tpHits[i] < PANEL_4_MIN_TP_HITS_FOR_OPTIMUM) continue;
            if (avgRet[i] > bestAvg) { bestAvg = avgRet[i]; bestIdx = i; }
          }
          if (bestIdx !== -1) {
            const ti = Math.floor(bestIdx / PANEL_4_SL_GRID.length);
            const si = bestIdx % PANEL_4_SL_GRID.length;
            optimal = {
              tp: PANEL_4_TP_GRID[ti],
              sl: PANEL_4_SL_GRID[si],
              avg_ret: avgRet[bestIdx],
              win_rate: winRate[bestIdx],
            };
          }
        }

        return { n, combos: { avg_ret: avgRet, med_ret: medRet, win_rate: winRate }, optimal };
      };

      const baseline4 = {
        filter: 'ALL labeled (no filter)',
        group: 'Baseline',
        ...runFilterPanel4(() => true),
      };
      const filters4 = PANEL_1_FILTERS.map(f => ({
        filter: f.name,
        group: f.group,
        ...runFilterPanel4(f.predicate as (r: Panel4Row) => boolean),
      }));

      // Horizon variants: same predicate + grid, but simulation falls through
      // at T+60 / T+120 instead of T+300. Used by the Panel 4 horizon tabs.
      const baseline4_t60 = {
        filter: 'ALL labeled (no filter)',
        group: 'Baseline',
        ...runFilterPanel4(() => true, 'pct_t60'),
      };
      const filters4_t60 = PANEL_1_FILTERS.map(f => ({
        filter: f.name,
        group: f.group,
        ...runFilterPanel4(f.predicate as (r: Panel4Row) => boolean, 'pct_t60'),
      }));

      const baseline4_t120 = {
        filter: 'ALL labeled (no filter)',
        group: 'Baseline',
        ...runFilterPanel4(() => true, 'pct_t120'),
      };
      const filters4_t120 = PANEL_1_FILTERS.map(f => ({
        filter: f.name,
        group: f.group,
        ...runFilterPanel4(f.predicate as (r: Panel4Row) => boolean, 'pct_t120'),
      }));

      // Shared type alias for Panel 4 optimum — mirrors the shape returned
      // by runFilterPanel4 (src/index.ts:2342). Used by Panels 5 & 6.
      type Panel4Optimal = { tp: number; sl: number; avg_ret: number; win_rate: number } | null;

      // ── Panel 10: Dynamic Position Monitoring (DPM) EV Optimizer ──
      //
      // For each filter, brute-force the DPM parameter grid to find the combo
      // that maximizes avg return. Base TP/SL held fixed at 30/10 (thesis
      // defaults) so only DPM params vary. Mirrors the layered SL logic in
      // src/trading/position-manager.ts checkPosition(). Also aggregates
      // best DPM combos per filter category and overall.
      const PANEL_10_BASE_TP = 30;
      const PANEL_10_BASE_SL = 10;
      const PANEL_10_SL_GAP_PENALTY = 0.30; // recalibrated 2026-04-15 (live SL fills -34% to -40%)
      const PANEL_10_TP_GAP_PENALTY = 0.10;
      const PANEL_10_MIN_N = 30;
      const PANEL_10_MIN_ACTIVE_EXITS = 3;

      // checkpoint → seconds since entry (T+30)
      const PANEL_10_CHECKPOINT_DELAYS: Record<string, number> = {
        pct_t40: 10, pct_t50: 20, pct_t60: 30, pct_t90: 60,
        pct_t120: 90, pct_t150: 120, pct_t180: 150, pct_t240: 210,
      };

      // Paired trailing-SL configs (activation / distance) — keeps grid compact
      // and avoids nonsensical combinations where distance >= activation.
      const PANEL_10_TRAILING_SL = [
        { act: 0,  dist: 0,  label: 'off' },
        { act: 5,  dist: 3,  label: '5/3' },
        { act: 10, dist: 5,  label: '10/5' },
        { act: 15, dist: 7,  label: '15/7' },
        { act: 20, dist: 10, label: '20/10' },
      ] as const;
      const PANEL_10_SL_DELAY_SEC = [0, 10, 30, 60] as const;
      const PANEL_10_TRAILING_TP = [
        { en: false, drop: 0,  label: 'off' },
        { en: true,  drop: 3,  label: 'drop3' },
        { en: true,  drop: 5,  label: 'drop5' },
        { en: true,  drop: 10, label: 'drop10' },
      ] as const;
      const PANEL_10_BREAKEVEN = [0, 10, 15, 20] as const;

      type DpmCombo = {
        tsIdx: number;     // index into PANEL_10_TRAILING_SL
        sdIdx: number;     // index into PANEL_10_SL_DELAY_SEC
        ttIdx: number;     // index into PANEL_10_TRAILING_TP
        beIdx: number;     // index into PANEL_10_BREAKEVEN
      };

      const PANEL_10_COMBO_COUNT =
        PANEL_10_TRAILING_SL.length *
        PANEL_10_SL_DELAY_SEC.length *
        PANEL_10_TRAILING_TP.length *
        PANEL_10_BREAKEVEN.length; // = 5*4*4*4 = 320

      const panel10ComboIdx = (c: DpmCombo): number =>
        c.tsIdx * (PANEL_10_SL_DELAY_SEC.length * PANEL_10_TRAILING_TP.length * PANEL_10_BREAKEVEN.length) +
        c.sdIdx * (PANEL_10_TRAILING_TP.length * PANEL_10_BREAKEVEN.length) +
        c.ttIdx * PANEL_10_BREAKEVEN.length +
        c.beIdx;

      const panel10DecodeIdx = (idx: number): DpmCombo => {
        const beSize = PANEL_10_BREAKEVEN.length;
        const ttSize = PANEL_10_TRAILING_TP.length;
        const sdSize = PANEL_10_SL_DELAY_SEC.length;
        const beIdx = idx % beSize;
        const ttIdx = Math.floor(idx / beSize) % ttSize;
        const sdIdx = Math.floor(idx / (beSize * ttSize)) % sdSize;
        const tsIdx = Math.floor(idx / (beSize * ttSize * sdSize));
        return { tsIdx, sdIdx, ttIdx, beIdx };
      };

      type DpmExitType = 'stop_loss' | 'trailing_stop' | 'breakeven_stop' | 'take_profit' | 'trailing_tp' | 'fall_through';

      /**
       * Simulate a single token under one DPM combo. Base TP=30, SL=10.
       * Mirrors position-manager.ts checkPosition logic: layered SL composition
       * (each rule can only raise the floor), HWM tracking, SL activation delay,
       * trailing TP with post-TP peak tracking.
       * Returns { ret, exitType } — ret is cost-adjusted.
       */
      const simulateDpmInMemory = (r: Panel4Row, combo: DpmCombo): { ret: number; exitType: DpmExitType } => {
        const trailingSl = PANEL_10_TRAILING_SL[combo.tsIdx];
        const slDelay = PANEL_10_SL_DELAY_SEC[combo.sdIdx];
        const trailingTp = PANEL_10_TRAILING_TP[combo.ttIdx];
        const breakeven = PANEL_10_BREAKEVEN[combo.beIdx];

        const entryRatio = 1 + r.pct_t30 / 100;
        let hwm = 0;              // peak relative return (% from entry)
        let postTpPeak = 0;       // peak relative return after TP hit (for trailing TP)
        let tpHit = false;
        let trailingSlActive = false;

        const checkpointKeys: (keyof typeof PANEL_10_CHECKPOINT_DELAYS)[] = [
          'pct_t40', 'pct_t50', 'pct_t60', 'pct_t90',
          'pct_t120', 'pct_t150', 'pct_t180', 'pct_t240',
        ];

        for (const cp of checkpointKeys) {
          const v = (r as any)[cp];
          if (v == null) continue;
          const relRet = ((1 + v / 100) / entryRatio - 1) * 100;
          const secondsSinceEntry = PANEL_10_CHECKPOINT_DELAYS[cp];

          if (relRet > hwm) hwm = relRet;

          // Compute effective SL (layered — each rule can only raise the floor).
          // effSl is stored as a percentage return from entry (e.g. -10 = -10% from entry).
          let effSl = -PANEL_10_BASE_SL;

          // Breakeven stop
          if (breakeven > 0 && hwm >= breakeven) {
            if (0 > effSl) effSl = 0;
          }

          // Trailing SL — price-ratio based (matches position-manager.ts)
          if (trailingSl.act > 0) {
            if (hwm >= trailingSl.act) trailingSlActive = true;
            if (trailingSlActive) {
              const hwmRatio = 1 + hwm / 100;
              const trailingSlRatio = hwmRatio * (1 - trailingSl.dist / 100);
              const trailingSlPct = (trailingSlRatio - 1) * 100;
              if (trailingSlPct > effSl) effSl = trailingSlPct;
            }
          }

          // SL activation delay — suppress SL exits during the grace window
          const slActive = secondsSinceEntry >= slDelay;

          // Check SL exit (SL first, like Panel 4)
          if (slActive && relRet <= effSl) {
            // Price-multiplier SL (mirrors trade-logger.ts:111-120).
            // When the trigger floor is above -baseSL (trailing/breakeven set a higher floor)
            // AND we're exiting in profit, use TP gap (softer pullback); otherwise SL gap.
            const inProfit = relRet > 0;
            const gap = inProfit ? PANEL_10_TP_GAP_PENALTY : PANEL_10_SL_GAP_PENALTY;
            const exitRatio = (1 + relRet / 100) * (1 - gap);
            const realized = (exitRatio - 1) * 100;
            let exitType: DpmExitType;
            if (trailingSlActive && effSl > -PANEL_10_BASE_SL) {
              // Trailing or breakeven set the floor above the fixed SL
              if (effSl <= 0.001) exitType = 'breakeven_stop';
              else exitType = 'trailing_stop';
            } else {
              exitType = 'stop_loss';
            }
            return { ret: realized - r.cost_pct, exitType };
          }

          // Check TP exit
          if (trailingTp.en) {
            if (relRet >= PANEL_10_BASE_TP) tpHit = true;
            if (tpHit) {
              if (relRet > postTpPeak) postTpPeak = relRet;
              // Drop from peak in price-ratio terms (mirrors position-manager.ts)
              const postTpPeakRatio = 1 + postTpPeak / 100;
              const currRatio = 1 + relRet / 100;
              const dropFromPeakPct = ((postTpPeakRatio - currRatio) / postTpPeakRatio) * 100;
              if (dropFromPeakPct >= trailingTp.drop) {
                const realized = relRet * (1 - PANEL_10_TP_GAP_PENALTY);
                return { ret: realized - r.cost_pct, exitType: 'trailing_tp' };
              }
            }
          } else {
            // Fixed TP
            if (relRet >= PANEL_10_BASE_TP) {
              const realized = PANEL_10_BASE_TP * (1 - PANEL_10_TP_GAP_PENALTY);
              return { ret: realized - r.cost_pct, exitType: 'take_profit' };
            }
          }
        }

        // Fall-through at T+300 (guaranteed non-null by eligibility predicate)
        const fallRet = ((1 + r.pct_t300 / 100) / entryRatio - 1) * 100 - r.cost_pct;
        return { ret: fallRet, exitType: 'fall_through' };
      };

      type Panel10ComboResult = {
        avg_ret: number;    // per-combo avg return
        win_rate: number;   // per-combo win %
        active_exits: number; // non-fall-through exits (used for gating optimum)
      };
      type Panel10Optimal = {
        trailing_sl: string;     // e.g. '10/5' or 'off'
        sl_delay: number;
        trailing_tp: string;     // e.g. 'drop5' or 'off'
        breakeven: number;
        avg_ret: number;
        win_rate: number;
        fallthrough_avg_ret: number; // all-DPM-off baseline for this filter
      } | null;
      type Panel10FilterResult = {
        filter: string;
        group: string;
        n: number;
        combos: Panel10ComboResult[];  // length = PANEL_10_COMBO_COUNT
        optimal: Panel10Optimal;
      };

      const runFilterPanel10 = (
        filterName: string,
        group: string,
        predicate: (r: Panel4Row) => boolean,
      ): Panel10FilterResult => {
        const filtered = panel4Rows.filter(predicate);
        const n = filtered.length;
        const combos: Panel10ComboResult[] = new Array(PANEL_10_COMBO_COUNT);
        for (let i = 0; i < PANEL_10_COMBO_COUNT; i++) {
          combos[i] = { avg_ret: 0, win_rate: 0, active_exits: 0 };
        }
        let optimal: Panel10Optimal = null;

        if (n === 0) {
          return { filter: filterName, group, n: 0, combos, optimal };
        }

        // "Fallthrough" combo = all DPM features off (trailingSl=off, slDelay=0,
        // trailingTp=off, breakeven=0). This is the pure fixed 30/10 baseline.
        const fallthroughIdx = panel10ComboIdx({ tsIdx: 0, sdIdx: 0, ttIdx: 0, beIdx: 0 });

        for (let idx = 0; idx < PANEL_10_COMBO_COUNT; idx++) {
          const combo = panel10DecodeIdx(idx);
          let sum = 0;
          let wins = 0;
          let active = 0;
          for (let k = 0; k < n; k++) {
            const out = simulateDpmInMemory(filtered[k], combo);
            sum += out.ret;
            if (out.ret > 0) wins++;
            if (out.exitType !== 'fall_through') active++;
          }
          combos[idx] = {
            avg_ret: +(sum / n).toFixed(2),
            win_rate: Math.round((wins / n) * 100),
            active_exits: active,
          };
        }

        // Find the optimum: max avg_ret gated by n ≥ 30 AND ≥3 active exits.
        if (n >= PANEL_10_MIN_N) {
          let bestIdx = -1;
          let bestAvg = -Infinity;
          for (let i = 0; i < PANEL_10_COMBO_COUNT; i++) {
            if (combos[i].active_exits < PANEL_10_MIN_ACTIVE_EXITS) continue;
            if (combos[i].avg_ret > bestAvg) {
              bestAvg = combos[i].avg_ret;
              bestIdx = i;
            }
          }
          if (bestIdx !== -1) {
            const c = panel10DecodeIdx(bestIdx);
            optimal = {
              trailing_sl: PANEL_10_TRAILING_SL[c.tsIdx].label,
              sl_delay: PANEL_10_SL_DELAY_SEC[c.sdIdx],
              trailing_tp: PANEL_10_TRAILING_TP[c.ttIdx].label,
              breakeven: PANEL_10_BREAKEVEN[c.beIdx],
              avg_ret: combos[bestIdx].avg_ret,
              win_rate: combos[bestIdx].win_rate,
              fallthrough_avg_ret: combos[fallthroughIdx].avg_ret,
            };
          }
        }

        return { filter: filterName, group, n, combos, optimal };
      };

      const baseline10 = runFilterPanel10('ALL labeled (no filter)', 'Baseline', () => true);
      const filters10 = PANEL_1_FILTERS.map(f =>
        runFilterPanel10(f.name, f.group, f.predicate as (r: Panel4Row) => boolean)
      );

      /**
       * Given a list of per-filter panel-10 results, find the single DPM combo
       * that maximizes n-weighted avg return across those filters. Used for
       * per-category and overall aggregates.
       */
      const findAggregateOptimum = (
        results: Panel10FilterResult[],
      ): Panel10Optimal => {
        // Only consider filters with n >= 30 (same gate as per-filter optimum)
        const eligible = results.filter(r => r.n >= PANEL_10_MIN_N);
        if (eligible.length === 0) return null;

        // For each combo: compute n-weighted avg of per-filter avg_rets.
        // Also require total active exits across all filters to be meaningful.
        let bestIdx = -1;
        let bestWeightedAvg = -Infinity;
        const totalN = eligible.reduce((s, f) => s + f.n, 0);
        for (let i = 0; i < PANEL_10_COMBO_COUNT; i++) {
          let weightedSum = 0;
          let totalActive = 0;
          for (const f of eligible) {
            weightedSum += f.n * f.combos[i].avg_ret;
            totalActive += f.combos[i].active_exits;
          }
          if (totalActive < PANEL_10_MIN_ACTIVE_EXITS * eligible.length) continue;
          const weightedAvg = weightedSum / totalN;
          if (weightedAvg > bestWeightedAvg) {
            bestWeightedAvg = weightedAvg;
            bestIdx = i;
          }
        }

        if (bestIdx === -1) return null;
        const c = panel10DecodeIdx(bestIdx);
        // Compute n-weighted avg fallthrough and win rate for the winning combo
        const fallthroughIdx = panel10ComboIdx({ tsIdx: 0, sdIdx: 0, ttIdx: 0, beIdx: 0 });
        let fallthroughWeightedSum = 0;
        let winRateWeightedSum = 0;
        for (const f of eligible) {
          fallthroughWeightedSum += f.n * f.combos[fallthroughIdx].avg_ret;
          winRateWeightedSum += f.n * f.combos[bestIdx].win_rate;
        }
        return {
          trailing_sl: PANEL_10_TRAILING_SL[c.tsIdx].label,
          sl_delay: PANEL_10_SL_DELAY_SEC[c.sdIdx],
          trailing_tp: PANEL_10_TRAILING_TP[c.ttIdx].label,
          breakeven: PANEL_10_BREAKEVEN[c.beIdx],
          avg_ret: +bestWeightedAvg.toFixed(2),
          win_rate: Math.round(winRateWeightedSum / totalN),
          fallthrough_avg_ret: +(fallthroughWeightedSum / totalN).toFixed(2),
        };
      };

      // Group filters by category and compute per-category aggregate optima
      const groups10Map = new Map<string, Panel10FilterResult[]>();
      for (const f of filters10) {
        if (!groups10Map.has(f.group)) groups10Map.set(f.group, []);
        groups10Map.get(f.group)!.push(f);
      }
      const categoryAggregates10 = Array.from(groups10Map.entries()).map(([group, results]) => ({
        group,
        filter_count: results.length,
        eligible_count: results.filter(r => r.n >= PANEL_10_MIN_N).length,
        optimal: findAggregateOptimum(results),
      }));

      // Overall aggregate: across all filters
      const overallAggregate10 = findAggregateOptimum(filters10);

      // ── Panel 5 helpers: statistical significance ──
      //
      // Wilson score 95% confidence interval for a binomial proportion.
      // Closed-form, stable at small n (unlike normal approximation).
      const wilsonCI = (successes: number, n: number): { low: number; high: number } | null => {
        if (n === 0) return null;
        const z = 1.96; // 95%
        const p = successes / n;
        const denom = 1 + (z * z) / n;
        const center = (p + (z * z) / (2 * n)) / denom;
        const halfWidth = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
        return { low: Math.max(0, center - halfWidth) * 100, high: Math.min(1, center + halfWidth) * 100 };
      };

      // Two-proportion z-test (two-sided) p-value approximation using the
      // complementary error function. Returns p-value in [0, 1].
      const twoPropZPValue = (s1: number, n1: number, s2: number, n2: number): number | null => {
        if (n1 === 0 || n2 === 0) return null;
        const p1 = s1 / n1;
        const p2 = s2 / n2;
        const pPool = (s1 + s2) / (n1 + n2);
        const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
        if (se === 0) return 1.0;
        const z = Math.abs(p1 - p2) / se;
        // Two-sided p-value = 2 * (1 - Phi(|z|)); Phi via erf.
        // erf approximation (Abramowitz & Stegun 7.1.26), max error ~1.5e-7
        const erf = (x: number): number => {
          const sign = x < 0 ? -1 : 1;
          x = Math.abs(x);
          const a1 =  0.254829592;
          const a2 = -0.284496736;
          const a3 =  1.421413741;
          const a4 = -1.453152027;
          const a5 =  1.061405429;
          const p  =  0.3275911;
          const t = 1 / (1 + p * x);
          const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
          return sign * y;
        };
        const phi = 0.5 * (1 + erf(z / Math.SQRT2));
        return Math.max(0, Math.min(1, 2 * (1 - phi)));
      };

      // Bootstrap 95% confidence interval on the MEAN of a returns array.
      // Uses 1000 resamples; deterministic PRNG to make the dashboard reproducible.
      const bootstrapMeanCI = (returns: number[], iterations = 1000): { low: number; high: number } | null => {
        const n = returns.length;
        if (n < 2) return null;
        // Simple LCG for deterministic resampling per filter (seed from n + first return)
        let seed = (n * 2654435761 + Math.floor((returns[0] + 1e6) * 1000)) >>> 0;
        const rand = () => {
          seed = (seed * 1103515245 + 12345) >>> 0;
          return (seed & 0x7fffffff) / 0x7fffffff;
        };
        const means = new Array<number>(iterations);
        for (let it = 0; it < iterations; it++) {
          let sum = 0;
          for (let k = 0; k < n; k++) {
            sum += returns[Math.floor(rand() * n)];
          }
          means[it] = sum / n;
        }
        means.sort((a, b) => a - b);
        const low = means[Math.floor(iterations * 0.025)];
        const high = means[Math.floor(iterations * 0.975)];
        return { low, high };
      };

      // Simulate a single (tp, sl) on an arbitrary row subset and return
      // the cost-adjusted returns array. Mirrors simulateInMemory exactly.
      const simulateReturnsAtLevel = (rows: Panel4Row[], tp: number, sl: number): number[] => {
        const out: number[] = [];
        for (const r of rows) {
          out.push(simulateInMemory(r, tp, sl).ret);
        }
        return out;
      };

      // Baseline Panel 1 counts — needed for Panel 5 p-value computation
      const baselineP1 = runFilterStats('', '');
      const baselinePump = baselineP1.pump;
      const baselineN = baselineP1.n;

      type Panel5Row = {
        filter: string;
        group: string;
        n: number;
        win_rate_pct: number | null;
        win_ci_low: number | null;
        win_ci_high: number | null;
        p_value_vs_baseline: number | null;
        opt_tp: number | null;
        opt_sl: number | null;
        opt_avg_ret: number | null;
        boot_ret_low: number | null;
        boot_ret_high: number | null;
        verdict: 'SIGNIFICANT' | 'MARGINAL' | 'NOISE' | 'INSUFFICIENT';
      };

      const runFilterPanel5 = (
        column: string,
        whereCond: string,
        predicate: (r: Panel4Row) => boolean,
        optimal: Panel4Optimal,
      ): Omit<Panel5Row, 'filter' | 'group'> => {
        // Panel 1 counts for this filter (for Wilson CI + p-value vs baseline)
        const p1 = runFilterStats(column, whereCond);
        const n = p1.n;
        const winRate = p1.win_rate_pct;
        const wilson = wilsonCI(p1.pump, n);
        const pVal = (column === '' && whereCond === '')
          ? 1.0 // baseline vs itself
          : twoPropZPValue(p1.pump, n, baselinePump, baselineN);

        // Bootstrap CI on the per-token returns at this filter's optimum (Panel 4)
        let bootLow: number | null = null;
        let bootHigh: number | null = null;
        if (optimal && n >= PANEL_4_MIN_N_FOR_OPTIMUM) {
          const filtered = panel4Rows.filter(predicate);
          const returns = simulateReturnsAtLevel(filtered, optimal.tp, optimal.sl);
          const boot = bootstrapMeanCI(returns, 1000);
          if (boot) { bootLow = +boot.low.toFixed(2); bootHigh = +boot.high.toFixed(2); }
        }

        // Verdict: SIGNIFICANT if p<0.05 AND bootstrap CI excludes 0 AND n>=30
        //          MARGINAL if p<0.10 OR bootstrap CI excludes 0 (not both)
        //          NOISE otherwise
        //          INSUFFICIENT if n<30
        let verdict: Panel5Row['verdict'] = 'INSUFFICIENT';
        if (n >= PANEL_4_MIN_N_FOR_OPTIMUM) {
          const pOk = pVal != null && pVal < 0.05;
          const pMarginal = pVal != null && pVal < 0.10;
          const bootOk = bootLow != null && bootHigh != null && bootLow > 0;
          const bootMarginal = bootLow != null && bootHigh != null && (bootLow > 0 || bootHigh > 0);
          if (pOk && bootOk) verdict = 'SIGNIFICANT';
          else if (pMarginal || bootMarginal) verdict = 'MARGINAL';
          else verdict = 'NOISE';
        }

        return {
          n,
          win_rate_pct: winRate,
          win_ci_low: wilson ? +wilson.low.toFixed(1) : null,
          win_ci_high: wilson ? +wilson.high.toFixed(1) : null,
          p_value_vs_baseline: pVal == null ? null : +pVal.toFixed(4),
          opt_tp: optimal ? optimal.tp : null,
          opt_sl: optimal ? optimal.sl : null,
          opt_avg_ret: optimal ? optimal.avg_ret : null,
          boot_ret_low: bootLow,
          boot_ret_high: bootHigh,
          verdict,
        };
      };

      // Panel 5 depends on Panel 4's optimal per filter — we already computed it above.
      const baseline5: Panel5Row = {
        filter: 'ALL labeled (no filter)',
        group: 'Baseline',
        ...runFilterPanel5('', '', () => true, (baseline4 as any).optimal),
      };
      const filters5: Panel5Row[] = PANEL_1_FILTERS.map((f, idx) => ({
        filter: f.name,
        group: f.group,
        ...runFilterPanel5(
          f.column,
          f.where,
          f.predicate as (r: Panel4Row) => boolean,
          (filters4[idx] as any).optimal,
        ),
      }));

      // ── Panel 6: multi-filter intersection (dynamic + top-20 pairs) ──
      type Panel6Dynamic = {
        selected: string[];              // filter names in the chosen intersection
        n: number;
        opt_tp: number | null;
        opt_sl: number | null;
        opt_avg_ret: number | null;
        opt_win_rate: number | null;
        lift_vs_best_single: number | null;
      } | null;

      type Panel6PairRow = {
        filter_a: string;
        filter_b: string;
        n: number;
        opt_tp: number;
        opt_sl: number;
        opt_avg_ret: number;
        opt_win_rate: number;
        single_a_opt: number | null;
        single_b_opt: number | null;
        lift: number;
      };

      // Parse the ?p6= query param. Accepts up to 3 filter names separated by commas.
      // Example: ?p6=vel%205-20%20sol%2Fmin,liquidity%20%3E%20100%20SOL
      const parsePanel6Selection = (raw: unknown): string[] => {
        if (typeof raw !== 'string' || raw.length === 0) return [];
        return raw.split(',')
          .map(s => s.trim())
          .filter(s => s.length > 0 && PANEL_1_FILTERS.some(f => f.name === s))
          .slice(0, 3);
      };

      const panel6Selected = parsePanel6Selection(opts?.p6Raw);
      let panel6Dynamic: Panel6Dynamic = null;
      if (panel6Selected.length >= 1) {
        const selectedDefs = panel6Selected
          .map(name => PANEL_1_FILTERS.find(f => f.name === name))
          .filter((f): f is FilterDef => f !== undefined);
        const combinedPredicate = (r: Panel4Row) =>
          selectedDefs.every(def => (def.predicate as (r: Panel4Row) => boolean)(r));
        const res = runFilterPanel4(combinedPredicate);
        // "Lift vs best single component" = intersection opt_avg_ret - max(single opt_avg_ret)
        let bestSingleOpt: number | null = null;
        for (const def of selectedDefs) {
          const singleIdx = PANEL_1_FILTERS.findIndex(x => x.name === def.name);
          const singleOpt = (filters4[singleIdx] as any).optimal as Panel4Optimal;
          if (singleOpt && (bestSingleOpt == null || singleOpt.avg_ret > bestSingleOpt)) {
            bestSingleOpt = singleOpt.avg_ret;
          }
        }
        panel6Dynamic = {
          selected: panel6Selected,
          n: res.n,
          opt_tp: res.optimal ? res.optimal.tp : null,
          opt_sl: res.optimal ? res.optimal.sl : null,
          opt_avg_ret: res.optimal ? res.optimal.avg_ret : null,
          opt_win_rate: res.optimal ? res.optimal.win_rate : null,
          lift_vs_best_single: (res.optimal && bestSingleOpt != null)
            ? +(res.optimal.avg_ret - bestSingleOpt).toFixed(1)
            : null,
        };
      }

      // Top-20 filter pairs by Opt Avg Ret with n >= 30 and lift > 0.
      // O(C(N,2)) loop where N=53 → 1378 pairs. Each pair reuses runFilterPanel4
      // (~120 combos × ~n tokens). Acceptable request-time cost at current data size.
      const panel6TopPairs: Panel6PairRow[] = [];
      {
        const pairResults: Panel6PairRow[] = [];
        for (let i = 0; i < PANEL_1_FILTERS.length; i++) {
          const a = PANEL_1_FILTERS[i];
          const aOpt = (filters4[i] as any).optimal as Panel4Optimal;
          for (let j = i + 1; j < PANEL_1_FILTERS.length; j++) {
            const b = PANEL_1_FILTERS[j];
            const bOpt = (filters4[j] as any).optimal as Panel4Optimal;
            const combinedPredicate = (r: Panel4Row) =>
              (a.predicate as (r: Panel4Row) => boolean)(r) &&
              (b.predicate as (r: Panel4Row) => boolean)(r);
            const res = runFilterPanel4(combinedPredicate);
            if (res.n < PANEL_4_MIN_N_FOR_OPTIMUM) continue;
            if (!res.optimal) continue;
            const bestSingle = Math.max(
              aOpt ? aOpt.avg_ret : -Infinity,
              bOpt ? bOpt.avg_ret : -Infinity,
            );
            const lift = Number.isFinite(bestSingle)
              ? +(res.optimal.avg_ret - bestSingle).toFixed(1)
              : res.optimal.avg_ret;
            if (lift <= 0) continue;
            pairResults.push({
              filter_a: a.name,
              filter_b: b.name,
              n: res.n,
              opt_tp: res.optimal.tp,
              opt_sl: res.optimal.sl,
              opt_avg_ret: res.optimal.avg_ret,
              opt_win_rate: res.optimal.win_rate,
              single_a_opt: aOpt ? aOpt.avg_ret : null,
              single_b_opt: bOpt ? bOpt.avg_ret : null,
              lift,
            });
          }
        }
        pairResults.sort((x, y) => y.opt_avg_ret - x.opt_avg_ret);
        panel6TopPairs.push(...pairResults.slice(0, 20));
      }

      // Panel 6 top-pairs at shorter horizons. Same scan, different fall-through.
      // Single-filter optima are re-derived from the corresponding filters4_tN so
      // "lift vs best single" reflects performance at the same horizon.
      const computeTopPairsAtHorizon = (
        horizon: Panel4Horizon,
        singleFilterRows: Array<{ filter: string; optimal: Panel4Optimal }>,
      ): Panel6PairRow[] => {
        const out: Panel6PairRow[] = [];
        for (let i = 0; i < PANEL_1_FILTERS.length; i++) {
          const a = PANEL_1_FILTERS[i];
          const aOpt = singleFilterRows[i].optimal;
          for (let j = i + 1; j < PANEL_1_FILTERS.length; j++) {
            const b = PANEL_1_FILTERS[j];
            const bOpt = singleFilterRows[j].optimal;
            const combinedPredicate = (r: Panel4Row) =>
              (a.predicate as (r: Panel4Row) => boolean)(r) &&
              (b.predicate as (r: Panel4Row) => boolean)(r);
            const res = runFilterPanel4(combinedPredicate, horizon);
            if (res.n < PANEL_4_MIN_N_FOR_OPTIMUM) continue;
            if (!res.optimal) continue;
            const bestSingle = Math.max(
              aOpt ? aOpt.avg_ret : -Infinity,
              bOpt ? bOpt.avg_ret : -Infinity,
            );
            const lift = Number.isFinite(bestSingle)
              ? +(res.optimal.avg_ret - bestSingle).toFixed(1)
              : res.optimal.avg_ret;
            if (lift <= 0) continue;
            out.push({
              filter_a: a.name,
              filter_b: b.name,
              n: res.n,
              opt_tp: res.optimal.tp,
              opt_sl: res.optimal.sl,
              opt_avg_ret: res.optimal.avg_ret,
              opt_win_rate: res.optimal.win_rate,
              single_a_opt: aOpt ? aOpt.avg_ret : null,
              single_b_opt: bOpt ? bOpt.avg_ret : null,
              lift,
            });
          }
        }
        out.sort((x, y) => y.opt_avg_ret - x.opt_avg_ret);
        return out.slice(0, 20);
      };

      const panel6TopPairs_t60 = computeTopPairsAtHorizon(
        'pct_t60',
        filters4_t60.map(f => ({ filter: f.filter, optimal: (f as any).optimal as Panel4Optimal })),
      );
      const panel6TopPairs_t120 = computeTopPairsAtHorizon(
        'pct_t120',
        filters4_t120.map(f => ({ filter: f.filter, optimal: (f as any).optimal as Panel4Optimal })),
      );

      // Cache for use by /trading route

      // ── Panel 7: walk-forward validation of Panel 4 optimum ──
      //
      // Split panel4Rows by created_at at the 70/30 boundary. Find optimum
      // on the TRAIN half, then evaluate it on the TEST half using the same
      // TP/SL coordinates (no re-optimization on test).
      //
      // Verdict thresholds:
      //   ROBUST      — degradation (train - test) < 2 percentage points
      //   DEGRADED    — 2pp ≤ degradation ≤ 5pp
      //   OVERFIT     — degradation > 5pp
      //   INSUFFICIENT— train or test n < 20
      type Panel7Row = {
        filter: string;
        group: string;
        n_train: number;
        n_test: number;
        train_tp: number | null;
        train_sl: number | null;
        train_avg_ret: number | null;
        test_avg_ret: number | null;
        degradation: number | null;
        verdict: 'ROBUST' | 'DEGRADED' | 'OVERFIT' | 'INSUFFICIENT';
      };

      const PANEL_7_TRAIN_FRAC = 0.7;
      const PANEL_7_MIN_N_HALF = 20;

      // Sort a COPY of panel4Rows so the original (unsorted) load is untouched.
      const panel4RowsSorted = [...panel4Rows].sort((a, b) => a.created_at - b.created_at);
      const splitIdx = Math.floor(panel4RowsSorted.length * PANEL_7_TRAIN_FRAC);
      const trainRows = panel4RowsSorted.slice(0, splitIdx);
      const testRows = panel4RowsSorted.slice(splitIdx);

      // Parameterized version of runFilterPanel4 that works on any row subset.
      // Returns the SAME shape as runFilterPanel4, plus exposes the full combo grid.
      const runPanel4OnRows = (rows: Panel4Row[], predicate: (r: Panel4Row) => boolean) => {
        const filtered = rows.filter(predicate);
        const n = filtered.length;
        const comboCount = PANEL_4_TP_GRID.length * PANEL_4_SL_GRID.length;
        const avgRet = new Array<number>(comboCount).fill(0);
        const tpHits = new Array<number>(comboCount).fill(0);
        let optimal: { tp: number; sl: number; avg_ret: number } | null = null;

        if (n === 0) return { n: 0, avgRet, optimal };

        for (let ti = 0; ti < PANEL_4_TP_GRID.length; ti++) {
          for (let si = 0; si < PANEL_4_SL_GRID.length; si++) {
            const tp = PANEL_4_TP_GRID[ti];
            const sl = PANEL_4_SL_GRID[si];
            let sum = 0;
            let tpHit = 0;
            for (let k = 0; k < n; k++) {
              const out = simulateInMemory(filtered[k], tp, sl);
              sum += out.ret;
              if (out.tpHit) tpHit++;
            }
            const idx = ti * PANEL_4_SL_GRID.length + si;
            avgRet[idx] = +(sum / n).toFixed(2);
            tpHits[idx] = tpHit;
          }
        }

        if (n >= PANEL_7_MIN_N_HALF) {
          let bestIdx = -1;
          let bestAvg = -Infinity;
          for (let i = 0; i < comboCount; i++) {
            if (tpHits[i] < PANEL_4_MIN_TP_HITS_FOR_OPTIMUM) continue;
            if (avgRet[i] > bestAvg) { bestAvg = avgRet[i]; bestIdx = i; }
          }
          if (bestIdx !== -1) {
            const ti = Math.floor(bestIdx / PANEL_4_SL_GRID.length);
            const si = bestIdx % PANEL_4_SL_GRID.length;
            optimal = { tp: PANEL_4_TP_GRID[ti], sl: PANEL_4_SL_GRID[si], avg_ret: avgRet[bestIdx] };
          }
        }

        return { n, avgRet, optimal };
      };

      const runFilterPanel7 = (predicate: (r: Panel4Row) => boolean): Omit<Panel7Row, 'filter' | 'group'> => {
        const train = runPanel4OnRows(trainRows, predicate);
        const test = runPanel4OnRows(testRows, predicate);

        if (train.n < PANEL_7_MIN_N_HALF || test.n < PANEL_7_MIN_N_HALF || !train.optimal) {
          return {
            n_train: train.n,
            n_test: test.n,
            train_tp: train.optimal ? train.optimal.tp : null,
            train_sl: train.optimal ? train.optimal.sl : null,
            train_avg_ret: train.optimal ? train.optimal.avg_ret : null,
            test_avg_ret: null,
            degradation: null,
            verdict: 'INSUFFICIENT',
          };
        }

        // Look up test-half avg return at the train-half optimum coordinates.
        const ti = (PANEL_4_TP_GRID as readonly number[]).indexOf(train.optimal.tp);
        const si = (PANEL_4_SL_GRID as readonly number[]).indexOf(train.optimal.sl);
        const testAvg = test.avgRet[ti * PANEL_4_SL_GRID.length + si];
        const degradation = +(train.optimal.avg_ret - testAvg).toFixed(2);
        const verdict: Panel7Row['verdict'] =
          degradation < 2 ? 'ROBUST' : degradation <= 5 ? 'DEGRADED' : 'OVERFIT';

        return {
          n_train: train.n,
          n_test: test.n,
          train_tp: train.optimal.tp,
          train_sl: train.optimal.sl,
          train_avg_ret: train.optimal.avg_ret,
          test_avg_ret: +testAvg.toFixed(2),
          degradation,
          verdict,
        };
      };

      const baseline7: Panel7Row = {
        filter: 'ALL labeled (no filter)',
        group: 'Baseline',
        ...runFilterPanel7(() => true),
      };
      const filters7: Panel7Row[] = PANEL_1_FILTERS.map(f => ({
        filter: f.name,
        group: f.group,
        ...runFilterPanel7(f.predicate as (r: Panel4Row) => boolean),
      }));

      // ── Panel 8: loss tail & risk metrics ──
      //
      // Computed at each filter's Panel 4 optimum TP/SL on chronologically-
      // sorted rows (so "max consecutive losses" reflects true trade order).
      // All metrics are derived from the same per-token cost-adjusted return
      // vector that Panel 5's bootstrap CI uses.
      type Panel8Row = {
        filter: string;
        group: string;
        n: number;
        opt_tp: number | null;
        opt_sl: number | null;
        pct_loss_10: number | null;           // % trades with return < -10%
        pct_loss_25: number | null;           // % trades with return < -25%
        pct_loss_50: number | null;           // % trades with return < -50%
        var_95: number | null;                // 5th percentile of return distribution
        cvar_95: number | null;               // mean of returns at or below VaR 95%
        worst_trade: number | null;           // min return across all trades
        max_consecutive_losses: number | null;// longest streak of return<0 in chrono order
      };

      const runFilterPanel8 = (
        predicate: (r: Panel4Row) => boolean,
        optimal: Panel4Optimal,
      ): Omit<Panel8Row, 'filter' | 'group'> => {
        if (!optimal) {
          return {
            n: 0,
            opt_tp: null, opt_sl: null,
            pct_loss_10: null, pct_loss_25: null, pct_loss_50: null,
            var_95: null, cvar_95: null, worst_trade: null,
            max_consecutive_losses: null,
          };
        }
        const filtered = panel4RowsSorted.filter(predicate);
        const n = filtered.length;
        if (n < PANEL_4_MIN_N_FOR_OPTIMUM) {
          return {
            n,
            opt_tp: optimal.tp, opt_sl: optimal.sl,
            pct_loss_10: null, pct_loss_25: null, pct_loss_50: null,
            var_95: null, cvar_95: null, worst_trade: null,
            max_consecutive_losses: null,
          };
        }

        const returns = filtered.map(r => simulateInMemory(r, optimal.tp, optimal.sl).ret);

        // Loss threshold buckets
        const lossCount = (t: number) => returns.filter(r => r < -t).length;
        const pct_loss_10 = +(lossCount(10) / n * 100).toFixed(1);
        const pct_loss_25 = +(lossCount(25) / n * 100).toFixed(1);
        const pct_loss_50 = +(lossCount(50) / n * 100).toFixed(1);

        // VaR 95 / CVaR 95 (left tail)
        const sorted = [...returns].sort((a, b) => a - b);
        const tailSize = Math.max(1, Math.floor(n * 0.05));
        const var_95 = +sorted[tailSize - 1].toFixed(2);
        const tailSum = sorted.slice(0, tailSize).reduce((s, v) => s + v, 0);
        const cvar_95 = +(tailSum / tailSize).toFixed(2);

        // Worst single trade
        const worst_trade = +sorted[0].toFixed(2);

        // Max consecutive loss streak (chronological order — depends on panel4RowsSorted)
        let maxStreak = 0;
        let curStreak = 0;
        for (const r of returns) {
          if (r < 0) { curStreak++; if (curStreak > maxStreak) maxStreak = curStreak; }
          else curStreak = 0;
        }

        return {
          n,
          opt_tp: optimal.tp, opt_sl: optimal.sl,
          pct_loss_10, pct_loss_25, pct_loss_50,
          var_95, cvar_95, worst_trade,
          max_consecutive_losses: maxStreak,
        };
      };

      const baseline8: Panel8Row = {
        filter: 'ALL labeled (no filter)',
        group: 'Baseline',
        ...runFilterPanel8(() => true, (baseline4 as any).optimal),
      };
      const filters8: Panel8Row[] = PANEL_1_FILTERS.map((f, idx) => ({
        filter: f.name,
        group: f.group,
        ...runFilterPanel8(
          f.predicate as (r: Panel4Row) => boolean,
          (filters4[idx] as any).optimal,
        ),
      }));

      // ── Panel 9: equity curve & drawdown simulation ──
      //
      // Trade the filter's Panel 4 optimum TP/SL through panel4RowsSorted in
      // chronological order. Start at equity=1.0, geometrically compound each
      // trade return. Report final equity, max drawdown, longest losing
      // streak, per-trade Sharpe, and Kelly-optimal position size. Equity
      // curve is down-sampled to ≤60 points for an inline SVG sparkline.
      type Panel9Row = {
        filter: string;
        group: string;
        n: number;
        opt_tp: number | null;
        opt_sl: number | null;
        final_equity_mult: number | null;     // e.g. 1.45 = +45% cumulative
        max_drawdown_pct: number | null;      // max peak-to-trough decline (≤0)
        longest_losing_streak: number | null; // same as panel 8 but reported here too
        sharpe: number | null;                // mean/stddev of per-trade returns
        kelly_fraction: number | null;        // Kelly-optimal bet size [0, 1]
        equity_curve: number[];               // down-sampled sparkline points
      };

      const PANEL_9_SPARKLINE_POINTS = 60;

      const runFilterPanel9 = (
        predicate: (r: Panel4Row) => boolean,
        optimal: Panel4Optimal,
      ): Omit<Panel9Row, 'filter' | 'group'> => {
        if (!optimal) {
          return {
            n: 0,
            opt_tp: null, opt_sl: null,
            final_equity_mult: null, max_drawdown_pct: null,
            longest_losing_streak: null, sharpe: null, kelly_fraction: null,
            equity_curve: [],
          };
        }
        const filtered = panel4RowsSorted.filter(predicate);
        const n = filtered.length;
        if (n < PANEL_4_MIN_N_FOR_OPTIMUM) {
          return {
            n,
            opt_tp: optimal.tp, opt_sl: optimal.sl,
            final_equity_mult: null, max_drawdown_pct: null,
            longest_losing_streak: null, sharpe: null, kelly_fraction: null,
            equity_curve: [],
          };
        }

        const returns = filtered.map(r => simulateInMemory(r, optimal.tp, optimal.sl).ret);

        // Geometric equity curve (start=1.0). Tokens clamp at −100% so a single
        // catastrophic loss cannot wipe the account below zero.
        const equity: number[] = [1.0];
        let curr = 1.0;
        for (const r of returns) {
          const mult = Math.max(0.01, 1 + r / 100); // clamp at -99% to avoid pathology
          curr = curr * mult;
          equity.push(curr);
        }
        const final_equity_mult = +curr.toFixed(3);

        // Max drawdown: scan equity curve, track running peak
        let peak = 1.0;
        let maxDd = 0;
        for (const v of equity) {
          if (v > peak) peak = v;
          const dd = (v - peak) / peak;
          if (dd < maxDd) maxDd = dd;
        }
        const max_drawdown_pct = +(maxDd * 100).toFixed(1);

        // Longest losing streak (chronological)
        let longest = 0;
        let streak = 0;
        for (const r of returns) {
          if (r < 0) { streak++; if (streak > longest) longest = streak; }
          else streak = 0;
        }

        // Per-trade Sharpe (no annualization — trades are irregular)
        const mean = returns.reduce((s, v) => s + v, 0) / n;
        let sharpe: number | null = null;
        if (n >= 2) {
          const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
          const std = Math.sqrt(variance);
          sharpe = std > 0 ? +(mean / std).toFixed(3) : null;
        }

        // Kelly fraction: (p*b - q) / b, where p = win rate, b = avg_win/avg_loss, q = 1-p
        let kelly: number | null = null;
        const wins = returns.filter(r => r > 0);
        const losses = returns.filter(r => r <= 0);
        if (wins.length > 0 && losses.length > 0) {
          const avgWin = wins.reduce((s, v) => s + v, 0) / wins.length;
          const avgLoss = Math.abs(losses.reduce((s, v) => s + v, 0) / losses.length);
          if (avgLoss > 0) {
            const b = avgWin / avgLoss;
            const p = wins.length / n;
            const k = (p * b - (1 - p)) / b;
            kelly = +Math.max(0, Math.min(1, k)).toFixed(3);
          }
        }

        // Down-sample equity curve for sparkline
        const sparkline: number[] = [];
        const step = Math.max(1, Math.floor(equity.length / PANEL_9_SPARKLINE_POINTS));
        for (let i = 0; i < equity.length; i += step) {
          sparkline.push(+equity[i].toFixed(3));
        }
        if (sparkline[sparkline.length - 1] !== equity[equity.length - 1]) {
          sparkline.push(+equity[equity.length - 1].toFixed(3));
        }

        return {
          n,
          opt_tp: optimal.tp, opt_sl: optimal.sl,
          final_equity_mult,
          max_drawdown_pct,
          longest_losing_streak: longest,
          sharpe,
          kelly_fraction: kelly,
          equity_curve: sparkline,
        };
      };

      const baseline9: Panel9Row = {
        filter: 'ALL labeled (no filter)',
        group: 'Baseline',
        ...runFilterPanel9(() => true, (baseline4 as any).optimal),
      };
      const filters9: Panel9Row[] = PANEL_1_FILTERS.map((f, idx) => ({
        filter: f.name,
        group: f.group,
        ...runFilterPanel9(
          f.predicate as (r: Panel4Row) => boolean,
          (filters4[idx] as any).optimal,
        ),
      }));

      // ══════════════════════════════════════════════════════════════════════
      // ── FILTER-ANALYSIS-V3 PANELS ─────────────────────────────────────────
      // ══════════════════════════════════════════════════════════════════════
      //
      // v3 extends v2 with: triple-filter combos (Panel 1), drawdown-gate
      // stacking on best singles/pairs (Panel 2), crash-survival curves (Panel
      // 3), two new filter dimensions backed by schema columns — max_tick_drop
      // and sum_abs_returns (Panels 4 & 6), and a velocity × liquidity
      // interaction heatmap (Panel 5). Reuses panel4Rows, PANEL_1_FILTERS,
      // runFilterPanel4, filters4, and panel6TopPairs — no extra DB loads.
      //
      // Crash-prediction thesis: current baseline `vel<20 + top5<10%` has a
      // 59% live SL-hit rate. v3 panels are designed to surface filters or
      // combos that push the time-to-SL-trigger out beyond the typical
      // 60–180s window, or to identify entry conditions where the SL is
      // genuinely improbable vs. baseline.

      // ── Shared v3 constants ──────────────────────────────────────────────
      //
      // 2026-04-21: the old fixed +6.44% reference is retired. Main's
      // refactor moved the promotion bar to the rolling all-labeled
      // Panel 4 optimum (baseline4.optimal.avg_ret). Combos qualify when
      // their opt_avg_ret exceeds that rolling baseline. A null optimum
      // (insufficient baseline n) falls through to 0 so the flag remains
      // usable.
      const V3_BASELINE_SIM_RETURN: number =
        ((baseline4 as any).optimal as Panel4Optimal)?.avg_ret ?? 0;

      // Look up FilterDef by name (used by Panels 1 & 2 to rehydrate pair
      // components from panel6TopPairs, which only stores filter names).
      const findFilterDef = (name: string): FilterDef | undefined =>
        PANEL_1_FILTERS.find(f => f.name === name);

      // ── v3 Panel 1: Top 20 three-filter combos (focused scan) ────────────
      // For each of the top-20 pairs from Panel 6 (at T+300), iterate through
      // the remaining PANEL_1_FILTERS. Skip candidates whose group matches
      // either parent-pair member (no within-group conflicts). That yields
      // up to 20 × ~50 = ~1000 triple evaluations per horizon.
      type PanelV3_1_Row = {
        filter_a: string;
        filter_b: string;
        filter_c: string;
        n: number;
        opt_tp: number;
        opt_sl: number;
        opt_avg_ret: number;
        opt_win_rate: number;
        parent_pair_opt: number;
        lift_vs_pair: number;
        beats_baseline: boolean;
      };

      const computeTopTriplesAtHorizon = (
        horizon: Panel4Horizon,
        parentPairs: Panel6PairRow[],
      ): PanelV3_1_Row[] => {
        const out: PanelV3_1_Row[] = [];
        for (const pair of parentPairs) {
          const defA = findFilterDef(pair.filter_a);
          const defB = findFilterDef(pair.filter_b);
          if (!defA || !defB) continue;
          const parentOpt = pair.opt_avg_ret;
          const excludedGroups = new Set([defA.group, defB.group]);
          for (const defC of PANEL_1_FILTERS) {
            if (excludedGroups.has(defC.group)) continue;
            if (defC.name === defA.name || defC.name === defB.name) continue;
            const combined = (r: Panel4Row) =>
              (defA.predicate as (r: Panel4Row) => boolean)(r) &&
              (defB.predicate as (r: Panel4Row) => boolean)(r) &&
              (defC.predicate as (r: Panel4Row) => boolean)(r);
            const res = runFilterPanel4(combined, horizon);
            if (res.n < PANEL_4_MIN_N_FOR_OPTIMUM) continue;
            if (!res.optimal) continue;
            const lift = +(res.optimal.avg_ret - parentOpt).toFixed(2);
            if (lift <= 0) continue;
            out.push({
              filter_a: defA.name,
              filter_b: defB.name,
              filter_c: defC.name,
              n: res.n,
              opt_tp: res.optimal.tp,
              opt_sl: res.optimal.sl,
              opt_avg_ret: res.optimal.avg_ret,
              opt_win_rate: res.optimal.win_rate,
              parent_pair_opt: parentOpt,
              lift_vs_pair: lift,
              beats_baseline: res.optimal.avg_ret > V3_BASELINE_SIM_RETURN,
            });
          }
        }
        out.sort((x, y) => y.opt_avg_ret - x.opt_avg_ret);
        return out.slice(0, 20);
      };

      const panelV3_1_topTriples_t300 = computeTopTriplesAtHorizon('pct_t300', panel6TopPairs);
      const panelV3_1_topTriples_t120 = computeTopTriplesAtHorizon('pct_t120', panel6TopPairs_t120);
      const panelV3_1_topTriples_t60  = computeTopTriplesAtHorizon('pct_t60',  panel6TopPairs_t60);

      // ── v3 Panel 2: max_dd_0_30 gate stacked on best singles and pairs ───
      // For each base filter × threshold, compute the combined-predicate
      // Panel 4 optimum. "Unconditional" section = max_dd_0_30 alone across
      // thresholds. Retention % = gated_n / base_n × 100.
      const PANEL_V3_2_DD_THRESHOLDS = [-5, -10, -15, -20, -25] as const;

      type PanelV3_2_Row = {
        base: string;        // e.g. "vel < 20 sol/min" or "vel<20 + top5<10%"
        base_kind: 'single' | 'pair' | 'unconditional';
        threshold: number;   // e.g. -10 (max_dd_0_30 > -10)
        base_n: number;
        base_opt_avg_ret: number | null;
        gated_n: number;
        gated_opt_tp: number | null;
        gated_opt_sl: number | null;
        gated_opt_avg_ret: number | null;
        gated_opt_win_rate: number | null;
        n_retention_pct: number | null;
        delta_vs_base: number | null; // gated - base (pp)
        beats_baseline: boolean;
      };

      const ddPredicate = (threshold: number) =>
        (r: Panel4Row) => r.max_drawdown_0_30 != null && r.max_drawdown_0_30 > threshold;

      const buildPanelV3_2_Row = (
        baseName: string,
        baseKind: PanelV3_2_Row['base_kind'],
        basePredicate: (r: Panel4Row) => boolean,
        baseN: number,
        baseOpt: number | null,
        threshold: number,
      ): PanelV3_2_Row => {
        const combined = (r: Panel4Row) => basePredicate(r) && ddPredicate(threshold)(r);
        const res = runFilterPanel4(combined);
        const gatedN = res.n;
        const gatedOpt = res.optimal;
        return {
          base: baseName,
          base_kind: baseKind,
          threshold,
          base_n: baseN,
          base_opt_avg_ret: baseOpt,
          gated_n: gatedN,
          gated_opt_tp: gatedOpt ? gatedOpt.tp : null,
          gated_opt_sl: gatedOpt ? gatedOpt.sl : null,
          gated_opt_avg_ret: gatedOpt ? gatedOpt.avg_ret : null,
          gated_opt_win_rate: gatedOpt ? gatedOpt.win_rate : null,
          n_retention_pct: baseN > 0 ? +((gatedN / baseN) * 100).toFixed(1) : null,
          delta_vs_base: (gatedOpt && baseOpt != null)
            ? +(gatedOpt.avg_ret - baseOpt).toFixed(2)
            : null,
          beats_baseline: gatedOpt != null && gatedOpt.avg_ret > V3_BASELINE_SIM_RETURN,
        };
      };

      // Pick top 5 singles by Panel 4 optimum (must have an optimum).
      const panelV3_2_topSingles = (filters4 as Array<{ filter: string; group: string; n: number; optimal: Panel4Optimal }>)
        .map((f, idx) => ({ def: PANEL_1_FILTERS[idx], n: f.n, optimal: f.optimal }))
        .filter(x => x.optimal != null)
        .sort((a, b) => (b.optimal!.avg_ret) - (a.optimal!.avg_ret))
        .slice(0, 5);

      const panelV3_2_topPairs = panel6TopPairs.slice(0, 5);

      const panelV3_2_rows: PanelV3_2_Row[] = [];

      // Unconditional: max_dd_0_30 alone across thresholds
      for (const t of PANEL_V3_2_DD_THRESHOLDS) {
        panelV3_2_rows.push(
          buildPanelV3_2_Row(`unconditional`, 'unconditional', () => true, panel4Rows.length, null, t),
        );
      }

      // Top singles × thresholds
      for (const s of panelV3_2_topSingles) {
        const basePred = s.def.predicate as (r: Panel4Row) => boolean;
        const baseOpt = s.optimal ? s.optimal.avg_ret : null;
        for (const t of PANEL_V3_2_DD_THRESHOLDS) {
          panelV3_2_rows.push(
            buildPanelV3_2_Row(s.def.name, 'single', basePred, s.n, baseOpt, t),
          );
        }
      }

      // Top pairs × thresholds
      for (const p of panelV3_2_topPairs) {
        const defA = findFilterDef(p.filter_a);
        const defB = findFilterDef(p.filter_b);
        if (!defA || !defB) continue;
        const basePred = (r: Panel4Row) =>
          (defA.predicate as (r: Panel4Row) => boolean)(r) &&
          (defB.predicate as (r: Panel4Row) => boolean)(r);
        const baseName = `${p.filter_a} + ${p.filter_b}`;
        const baseOpt = p.opt_avg_ret;
        for (const t of PANEL_V3_2_DD_THRESHOLDS) {
          panelV3_2_rows.push(
            buildPanelV3_2_Row(baseName, 'pair', basePred, p.n, baseOpt, t),
          );
        }
      }

      // ── v3 Panel 3: Crash survival curves ────────────────────────────────
      // For each selected filter, compute P(return > threshold | held through t)
      // at each of 8 timepoints and 3 thresholds. "Alive at t" = min rel_ret
      // over the [T+30, t] window is strictly greater than threshold.
      // Rel_ret_t = ((1 + pct_t/100) / (1 + pct_t30/100) - 1) * 100.
      const PANEL_V3_3_TIMEPOINTS = [30, 45, 60, 90, 120, 180, 240, 300] as const;
      const PANEL_V3_3_THRESHOLDS = [-5, -10, -20] as const;

      type PanelV3_3_Filter = {
        name: string;
        kind: 'pair' | 'triple';
        n: number;
        // Two-level array: curves[thresholdIdx][timepointIdx] = survival fraction
        curves: number[][];
      };

      const computeSurvivalCurve = (
        rows: Panel4Row[],
      ): number[][] => {
        const n = rows.length;
        const curves: number[][] = PANEL_V3_3_THRESHOLDS.map(() =>
          new Array<number>(PANEL_V3_3_TIMEPOINTS.length).fill(0),
        );
        if (n === 0) return curves;

        // For each token, precompute rel_ret at each timepoint, then the
        // running min through each timepoint. Count survivors per threshold.
        for (const r of rows) {
          const entryRatio = 1 + r.pct_t30 / 100;
          if (entryRatio <= 0) continue;
          let runningMin = 0; // rel_ret at t=30 is 0 by construction
          for (let ti = 0; ti < PANEL_V3_3_TIMEPOINTS.length; ti++) {
            const sec = PANEL_V3_3_TIMEPOINTS[ti];
            let relRet: number;
            if (sec === 30) {
              relRet = 0;
            } else {
              const key = `pct_t${sec}` as keyof Panel4Row;
              const v = r[key] as number | null | undefined;
              if (v == null) {
                // Missing checkpoint — hold runningMin constant for this token
                // (don't count as a breach; curve still reflects last known state).
                for (let thi = 0; thi < PANEL_V3_3_THRESHOLDS.length; thi++) {
                  if (runningMin > PANEL_V3_3_THRESHOLDS[thi]) curves[thi][ti]++;
                }
                continue;
              }
              relRet = ((1 + v / 100) / entryRatio - 1) * 100;
            }
            if (relRet < runningMin) runningMin = relRet;
            for (let thi = 0; thi < PANEL_V3_3_THRESHOLDS.length; thi++) {
              if (runningMin > PANEL_V3_3_THRESHOLDS[thi]) curves[thi][ti]++;
            }
          }
        }

        // Normalize to fractions.
        return curves.map(counts =>
          counts.map(c => +(c / n).toFixed(4)),
        );
      };

      const panelV3_3_filters: PanelV3_3_Filter[] = [];

      // Top 10 pairs from Panel 6
      for (const p of panel6TopPairs.slice(0, 10)) {
        const defA = findFilterDef(p.filter_a);
        const defB = findFilterDef(p.filter_b);
        if (!defA || !defB) continue;
        const predicate = (r: Panel4Row) =>
          (defA.predicate as (r: Panel4Row) => boolean)(r) &&
          (defB.predicate as (r: Panel4Row) => boolean)(r);
        const filtered = panel4Rows.filter(predicate);
        panelV3_3_filters.push({
          name: `${p.filter_a} + ${p.filter_b}`,
          kind: 'pair',
          n: filtered.length,
          curves: computeSurvivalCurve(filtered),
        });
      }

      // Top 10 triples from v3 Panel 1 (T+300)
      for (const t of panelV3_1_topTriples_t300.slice(0, 10)) {
        const defA = findFilterDef(t.filter_a);
        const defB = findFilterDef(t.filter_b);
        const defC = findFilterDef(t.filter_c);
        if (!defA || !defB || !defC) continue;
        const predicate = (r: Panel4Row) =>
          (defA.predicate as (r: Panel4Row) => boolean)(r) &&
          (defB.predicate as (r: Panel4Row) => boolean)(r) &&
          (defC.predicate as (r: Panel4Row) => boolean)(r);
        const filtered = panel4Rows.filter(predicate);
        panelV3_3_filters.push({
          name: `${t.filter_a} + ${t.filter_b} + ${t.filter_c}`,
          kind: 'triple',
          n: filtered.length,
          curves: computeSurvivalCurve(filtered),
        });
      }

      // Baseline curve (all eligible tokens, no filter) for reference.
      const panelV3_3_baseline: PanelV3_3_Filter = {
        name: 'ALL eligible (no filter)',
        kind: 'pair', // arbitrary — not displayed
        n: panel4Rows.length,
        curves: computeSurvivalCurve(panel4Rows),
      };

      // ── v3 Panel 4: max_tick_drop_0_30 (new filter dimension) ────────────
      // Standalone across thresholds + stacked on current baseline.
      const PANEL_V3_4_THRESHOLDS = [-3, -5, -8, -10, -15] as const;

      type PanelV3_4_Row = {
        threshold: number;
        mode: 'standalone' | 'stacked_baseline';
        n: number;
        opt_tp: number | null;
        opt_sl: number | null;
        opt_avg_ret: number | null;
        opt_win_rate: number | null;
        beats_baseline: boolean;
      };

      const tickDropPredicate = (threshold: number) =>
        (r: Panel4Row) => r.max_tick_drop_0_30 != null && r.max_tick_drop_0_30 > threshold;

      // Baseline composite predicate: vel<20 AND top5<10%
      const defVelLt20 = findFilterDef('vel < 20 sol/min');
      const defTop5Lt10 = findFilterDef('top5 < 10%');
      const baselineCompositePredicate = (r: Panel4Row): boolean => {
        if (!defVelLt20 || !defTop5Lt10) return true;
        return (defVelLt20.predicate as (r: Panel4Row) => boolean)(r)
            && (defTop5Lt10.predicate as (r: Panel4Row) => boolean)(r);
      };

      const panelV3_4_rows: PanelV3_4_Row[] = [];
      for (const t of PANEL_V3_4_THRESHOLDS) {
        const standalone = runFilterPanel4(tickDropPredicate(t));
        panelV3_4_rows.push({
          threshold: t,
          mode: 'standalone',
          n: standalone.n,
          opt_tp: standalone.optimal ? standalone.optimal.tp : null,
          opt_sl: standalone.optimal ? standalone.optimal.sl : null,
          opt_avg_ret: standalone.optimal ? standalone.optimal.avg_ret : null,
          opt_win_rate: standalone.optimal ? standalone.optimal.win_rate : null,
          beats_baseline: standalone.optimal != null && standalone.optimal.avg_ret > V3_BASELINE_SIM_RETURN,
        });

        const stacked = runFilterPanel4((r) => baselineCompositePredicate(r) && tickDropPredicate(t)(r));
        panelV3_4_rows.push({
          threshold: t,
          mode: 'stacked_baseline',
          n: stacked.n,
          opt_tp: stacked.optimal ? stacked.optimal.tp : null,
          opt_sl: stacked.optimal ? stacked.optimal.sl : null,
          opt_avg_ret: stacked.optimal ? stacked.optimal.avg_ret : null,
          opt_win_rate: stacked.optimal ? stacked.optimal.win_rate : null,
          beats_baseline: stacked.optimal != null && stacked.optimal.avg_ret > V3_BASELINE_SIM_RETURN,
        });
      }

      // ── v3 Panel 5: Velocity × Liquidity heatmap ─────────────────────────
      // 5 velocity buckets × 4 liquidity buckets = 20 cells.
      const velBuckets = [
        { name: 'vel < 5',       pred: (r: Panel4Row) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min < 5 },
        { name: 'vel 5-20',      pred: (r: Panel4Row) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 5  && r.bc_velocity_sol_per_min < 20 },
        { name: 'vel 20-50',     pred: (r: Panel4Row) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 20 && r.bc_velocity_sol_per_min < 50 },
        { name: 'vel 50-200',    pred: (r: Panel4Row) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 50 && r.bc_velocity_sol_per_min < 200 },
        { name: 'vel >= 200',    pred: (r: Panel4Row) => r.bc_velocity_sol_per_min != null && r.bc_velocity_sol_per_min >= 200 },
      ] as const;
      const liqBuckets = [
        { name: 'liq < 50',     pred: (r: Panel4Row) => r.liquidity_sol_t30 != null && r.liquidity_sol_t30 < 50 },
        { name: 'liq 50-100',   pred: (r: Panel4Row) => r.liquidity_sol_t30 != null && r.liquidity_sol_t30 >= 50  && r.liquidity_sol_t30 < 100 },
        { name: 'liq 100-150',  pred: (r: Panel4Row) => r.liquidity_sol_t30 != null && r.liquidity_sol_t30 >= 100 && r.liquidity_sol_t30 < 150 },
        { name: 'liq >= 150',   pred: (r: Panel4Row) => r.liquidity_sol_t30 != null && r.liquidity_sol_t30 >= 150 },
      ] as const;

      type PanelV3_5_Cell = {
        vel: string;
        liq: string;
        n: number;
        opt_tp: number | null;
        opt_sl: number | null;
        opt_avg_ret: number | null;
        opt_win_rate: number | null;
        beats_baseline: boolean;
      };

      const panelV3_5_cells: PanelV3_5_Cell[] = [];
      for (const v of velBuckets) {
        for (const l of liqBuckets) {
          const res = runFilterPanel4((r) => v.pred(r) && l.pred(r));
          panelV3_5_cells.push({
            vel: v.name,
            liq: l.name,
            n: res.n,
            opt_tp: res.optimal ? res.optimal.tp : null,
            opt_sl: res.optimal ? res.optimal.sl : null,
            opt_avg_ret: res.optimal ? res.optimal.avg_ret : null,
            opt_win_rate: res.optimal ? res.optimal.win_rate : null,
            beats_baseline: res.optimal != null && res.optimal.avg_ret > V3_BASELINE_SIM_RETURN,
          });
        }
      }

      // ── v3 Panel 6: sum_abs_returns_0_30 (pre-entry realized vol) ────────
      // Smaller sum_abs_returns = smoother path pre-entry.
      // Larger = choppier. Explore both directions with < thresholds and > thresholds.
      const PANEL_V3_6_THRESHOLDS_LT = [20, 40, 60, 100] as const;
      const PANEL_V3_6_THRESHOLDS_GT = [20, 40, 60] as const;

      type PanelV3_6_Row = {
        op: '<' | '>';
        threshold: number;
        mode: 'standalone' | 'stacked_baseline';
        n: number;
        opt_tp: number | null;
        opt_sl: number | null;
        opt_avg_ret: number | null;
        opt_win_rate: number | null;
        beats_baseline: boolean;
      };

      const sumAbsPredicate = (op: '<' | '>', threshold: number) =>
        (r: Panel4Row) => {
          if (r.sum_abs_returns_0_30 == null) return false;
          return op === '<' ? r.sum_abs_returns_0_30 < threshold : r.sum_abs_returns_0_30 > threshold;
        };

      const panelV3_6_rows: PanelV3_6_Row[] = [];
      const pushV3_6 = (op: '<' | '>', threshold: number) => {
        const standalone = runFilterPanel4(sumAbsPredicate(op, threshold));
        panelV3_6_rows.push({
          op, threshold, mode: 'standalone',
          n: standalone.n,
          opt_tp: standalone.optimal ? standalone.optimal.tp : null,
          opt_sl: standalone.optimal ? standalone.optimal.sl : null,
          opt_avg_ret: standalone.optimal ? standalone.optimal.avg_ret : null,
          opt_win_rate: standalone.optimal ? standalone.optimal.win_rate : null,
          beats_baseline: standalone.optimal != null && standalone.optimal.avg_ret > V3_BASELINE_SIM_RETURN,
        });

        const stacked = runFilterPanel4((r) => baselineCompositePredicate(r) && sumAbsPredicate(op, threshold)(r));
        panelV3_6_rows.push({
          op, threshold, mode: 'stacked_baseline',
          n: stacked.n,
          opt_tp: stacked.optimal ? stacked.optimal.tp : null,
          opt_sl: stacked.optimal ? stacked.optimal.sl : null,
          opt_avg_ret: stacked.optimal ? stacked.optimal.avg_ret : null,
          opt_win_rate: stacked.optimal ? stacked.optimal.win_rate : null,
          beats_baseline: stacked.optimal != null && stacked.optimal.avg_ret > V3_BASELINE_SIM_RETURN,
        });
      };
      for (const t of PANEL_V3_6_THRESHOLDS_LT) pushV3_6('<', t);
      for (const t of PANEL_V3_6_THRESHOLDS_GT) pushV3_6('>', t);

      // ── v3 Panel 7: Regime stability + walk-forward on v3 leaders ────────
      // For each of the top 10 pairs (Panel 6 top_pairs) and top 10 triples
      // (v3 Panel 1 top_triples_t300), run BOTH:
      //   (a) walk-forward on panel4Rows — train opt on first 70% by time,
      //       evaluate same (TP, SL) on last 30%; degradation + verdict.
      //   (b) regime buckets — same 4 time-quartile buckets Panel 3/11 use;
      //       per-bucket n/WR/avg_return, WR std-dev + stability label.
      // This answers the "is the leaderboard edge stable or overfit?" question
      // for v3 specifically, before we promote any triple to a live strategy.
      type PanelV3_7_Row = {
        name: string;
        kind: 'pair' | 'triple';
        n_total: number;
        opt_tp: number | null;
        opt_sl: number | null;
        opt_avg_ret: number | null;
        // Walk-forward
        n_train: number;
        n_test: number;
        train_tp: number | null;
        train_sl: number | null;
        train_avg_ret: number | null;
        test_avg_ret: number | null;
        degradation: number | null;
        wf_verdict: Panel7Row['verdict'];
        // Regime (time-bucketed WR + avg return)
        buckets: { n: number; win_rate_pct: number | null; avg_return_pct: number | null }[];
        wr_std_dev: number | null;
        regime_stability: 'STABLE' | 'MODERATE' | 'CLUSTERED' | 'INSUFFICIENT';
      };

      const buildV3_7Row = (
        name: string,
        kind: 'pair' | 'triple',
        predicate: (r: Panel4Row) => boolean,
      ): PanelV3_7_Row => {
        const filtered = panel4Rows.filter(predicate);
        const nTotal = filtered.length;
        const optRes = runFilterPanel4(predicate);
        const opt = optRes.optimal;

        const wf = runFilterPanel7(predicate);
        const regime = runFilterRegime(predicate as (r: RegimeRow) => boolean);

        return {
          name,
          kind,
          n_total: nTotal,
          opt_tp: opt ? opt.tp : null,
          opt_sl: opt ? opt.sl : null,
          opt_avg_ret: opt ? opt.avg_ret : null,
          n_train: wf.n_train,
          n_test: wf.n_test,
          train_tp: wf.train_tp,
          train_sl: wf.train_sl,
          train_avg_ret: wf.train_avg_ret,
          test_avg_ret: wf.test_avg_ret,
          degradation: wf.degradation,
          wf_verdict: wf.verdict,
          buckets: regime.buckets,
          wr_std_dev: regime.wr_std_dev,
          regime_stability: regime.stability,
        };
      };

      const panelV3_7_rows: PanelV3_7_Row[] = [];

      // Top 10 pairs
      for (const p of panel6TopPairs.slice(0, 10)) {
        const defA = findFilterDef(p.filter_a);
        const defB = findFilterDef(p.filter_b);
        if (!defA || !defB) continue;
        const pred = (r: Panel4Row) =>
          (defA.predicate as (r: Panel4Row) => boolean)(r) &&
          (defB.predicate as (r: Panel4Row) => boolean)(r);
        panelV3_7_rows.push(
          buildV3_7Row(`${p.filter_a} + ${p.filter_b}`, 'pair', pred),
        );
      }

      // Top 10 triples
      for (const t of panelV3_1_topTriples_t300.slice(0, 10)) {
        const defA = findFilterDef(t.filter_a);
        const defB = findFilterDef(t.filter_b);
        const defC = findFilterDef(t.filter_c);
        if (!defA || !defB || !defC) continue;
        const pred = (r: Panel4Row) =>
          (defA.predicate as (r: Panel4Row) => boolean)(r) &&
          (defB.predicate as (r: Panel4Row) => boolean)(r) &&
          (defC.predicate as (r: Panel4Row) => boolean)(r);
        panelV3_7_rows.push(
          buildV3_7Row(`${t.filter_a} + ${t.filter_b} + ${t.filter_c}`, 'triple', pred),
        );
      }

      const filterV2Data = {
        generated_at: new Date().toISOString(),
        panel1: {
          title: 'Single-Feature Filter Comparison',
          description:
            'Each row applies ONE filter to the labeled dataset. n is normalized — only tokens where the feature has a non-null value are counted, so monotonicity rows have smaller n than velocity rows. PUMP:DUMP ratio shows asymmetry: >1.0 = more winners than losers, >2.0 = strong asymmetry. Tabs switch the classification horizon (T+300, T+120, T+60) — same thresholds (>=+10% PUMP, <=-10% DUMP), just applied to the earlier checkpoint.',
          baseline,
          filters,
          flags: {
            low_n_threshold: 20,
            strong_n_threshold: 100,
          },
        },
        panel1_t60: {
          title: 'Single-Feature Filter Comparison — T+60 Horizon',
          description: 'Same predicate as Panel 1, but PUMP/DUMP/STABLE counts come from label_t60.',
          baseline: baseline_t60,
          filters: filters_t60,
          flags: {
            low_n_threshold: 20,
            strong_n_threshold: 100,
          },
        },
        panel1_t120: {
          title: 'Single-Feature Filter Comparison — T+120 Horizon',
          description: 'Same predicate as Panel 1, but PUMP/DUMP/STABLE counts come from label_t120.',
          baseline: baseline_t120,
          filters: filters_t120,
          flags: {
            low_n_threshold: 20,
            strong_n_threshold: 100,
          },
        },
        panel2: {
          title: 'T+30-Anchored Return Percentiles (MAE / MFE / Final)',
          description:
            'Percentiles of MAE, MFE, and final return — all anchored from price_t30 (entry price). MAE = worst dip from entry between T+30 and T+300 (≤ 0). MFE = best peak from entry in same window (≥ 0). Final = (price_t300/price_t30 - 1). Sharpe-ish = mean(final)/stddev(final), single-number "profitable AND consistent" score. Tokens missing price_t30 or price_t300 are excluded, so n may be slightly smaller than Panel 1.',
          baseline: baseline2,
          filters: filters2,
          flags: {
            low_n_threshold: 20,
            strong_n_threshold: 100,
          },
        },
        panel3: {
          title: 'Regime Stability — Win Rate & Avg Return Across Time Buckets',
          description:
            'Each filter cohort is split into 4 equal-sized time buckets (sorted by created_at). Per-bucket win rate and avg return (T+30-anchored, cost-adjusted) reveal whether the edge persists across regimes. WR StdDev = population std dev of win rates across buckets. Stability label uses the same thresholds as the existing regime_analysis: <8% STABLE, 8-15% MODERATE, ≥15% CLUSTERED. Buckets with n<5 are excluded from the std dev compute.',
          bucket_windows: bucketBoundaries.map((b, i) => ({
            bucket: i + 1,
            start_iso: new Date(b.start * 1000).toISOString(),
            end_iso: new Date(b.end * 1000).toISOString(),
          })),
          baseline: baseline3,
          filters: filters3,
          flags: {
            low_n_threshold: 20,
            strong_n_threshold: 100,
          },
        },
        panel4: {
          title: 'TP/SL EV Simulator — T+30 Entry, User-Selectable TP/SL + Per-Filter Optimum',
          description:
            'Entry at T+30. Each row precomputes EV across a 12×10 (TP × SL) grid. Dropdowns above the table pick the active cell — all Sel* columns update in place. Opt* columns show the per-filter optimum (max avg return with ≥3 TP hits among combos, requires filter n ≥ 30). Mirrors simulateWithTP (src/index.ts:1283) exactly: SL 30% adverse gap (recalibrated 2026-04-15), TP 10% adverse gap, per-token round_trip_slippage_pct with 3% fallback, null pct_t300 excluded via eligibility.',
          grid: {
            tp_levels: PANEL_4_TP_GRID,
            sl_levels: PANEL_4_SL_GRID,
            default_tp: PANEL_4_DEFAULT_TP,
            default_sl: PANEL_4_DEFAULT_SL,
          },
          constants: {
            sl_gap_penalty_pct: PANEL_4_SL_GAP_PENALTY * 100,
            tp_gap_penalty_pct: PANEL_4_TP_GAP_PENALTY * 100,
            cost_pct_fallback: ROUND_TRIP_COST_PCT_V2,
            checkpoints: PANEL_4_CHECKPOINTS,
            fall_through_column: 'pct_t300',
            min_n_for_optimum: PANEL_4_MIN_N_FOR_OPTIMUM,
            min_tp_hits_for_optimum: PANEL_4_MIN_TP_HITS_FOR_OPTIMUM,
          },
          baseline: baseline4,
          filters: filters4,
          flags: {
            low_n_threshold: 20,
            strong_n_threshold: 100,
          },
        },
        panel4_t60: {
          title: 'TP/SL EV Simulator — T+30 Entry, 60s Hold',
          description:
            'Same grid and predicate as Panel 4, but the checkpoint scan truncates at pct_t60 and falls through at pct_t60 instead of pct_t300. Use this to see whether a filter captures its edge inside a 60-second window.',
          grid: {
            tp_levels: PANEL_4_TP_GRID,
            sl_levels: PANEL_4_SL_GRID,
            default_tp: PANEL_4_DEFAULT_TP,
            default_sl: PANEL_4_DEFAULT_SL,
          },
          constants: {
            sl_gap_penalty_pct: PANEL_4_SL_GAP_PENALTY * 100,
            tp_gap_penalty_pct: PANEL_4_TP_GAP_PENALTY * 100,
            cost_pct_fallback: ROUND_TRIP_COST_PCT_V2,
            checkpoints: ['pct_t40', 'pct_t50', 'pct_t60'],
            fall_through_column: 'pct_t60',
            min_n_for_optimum: PANEL_4_MIN_N_FOR_OPTIMUM,
            min_tp_hits_for_optimum: PANEL_4_MIN_TP_HITS_FOR_OPTIMUM,
          },
          baseline: baseline4_t60,
          filters: filters4_t60,
          flags: {
            low_n_threshold: 20,
            strong_n_threshold: 100,
          },
        },
        panel4_t120: {
          title: 'TP/SL EV Simulator — T+30 Entry, 120s Hold',
          description:
            'Same grid and predicate as Panel 4, but the checkpoint scan truncates at pct_t120 and falls through at pct_t120 instead of pct_t300.',
          grid: {
            tp_levels: PANEL_4_TP_GRID,
            sl_levels: PANEL_4_SL_GRID,
            default_tp: PANEL_4_DEFAULT_TP,
            default_sl: PANEL_4_DEFAULT_SL,
          },
          constants: {
            sl_gap_penalty_pct: PANEL_4_SL_GAP_PENALTY * 100,
            tp_gap_penalty_pct: PANEL_4_TP_GAP_PENALTY * 100,
            cost_pct_fallback: ROUND_TRIP_COST_PCT_V2,
            checkpoints: ['pct_t40', 'pct_t50', 'pct_t60', 'pct_t90', 'pct_t120'],
            fall_through_column: 'pct_t120',
            min_n_for_optimum: PANEL_4_MIN_N_FOR_OPTIMUM,
            min_tp_hits_for_optimum: PANEL_4_MIN_TP_HITS_FOR_OPTIMUM,
          },
          baseline: baseline4_t120,
          filters: filters4_t120,
          flags: {
            low_n_threshold: 20,
            strong_n_threshold: 100,
          },
        },
        panel5: {
          title: 'Statistical Significance — Wilson CI on Win Rate + Bootstrap CI on Opt Avg Return',
          description:
            'For every filter, shows a 95% Wilson confidence interval on the Panel 1 win rate and a two-proportion z-test p-value vs the ALL-labeled baseline. Opt Avg Ret is inherited from Panel 4; the bootstrap 95% CI resamples the per-token return vector at that filter\'s optimum TP/SL 1000 times. Verdict: SIGNIFICANT (p<0.05 AND bootstrap CI > 0), MARGINAL (one of the two conditions), NOISE (neither), INSUFFICIENT (n<30). Use this to gate any filter ranking — at small n, a high raw win rate can still be noise.',
          baseline: baseline5,
          filters: filters5,
          flags: {
            low_n_threshold: 30,
            strong_n_threshold: 100,
          },
        },
        panel6: {
          title: 'Multi-Filter Intersection (2-way + 3-way AND) — Drill-Down',
          description:
            'Pick up to 3 filters from the dropdowns. The page reloads with the intersection run through Panel 4\'s optimum-finder. Lift vs best single component tells you whether the combo improves on its strongest constituent (positive lift = compounding edge; zero or negative = no extra information). Selection is encoded in the URL (?p6=name1,name2,name3) so links are shareable. The Top 20 Pairs table below auto-scans all C(53,2)=1378 two-filter intersections where n≥30 and lift>0, sorted by Opt Avg Ret.',
          filter_names: PANEL_1_FILTERS.map(f => ({ name: f.name, group: f.group })),
          dynamic: panel6Dynamic,
          top_pairs: panel6TopPairs,
          top_pairs_t60: panel6TopPairs_t60,
          top_pairs_t120: panel6TopPairs_t120,
          flags: {
            low_n_threshold: 30,
            strong_n_threshold: 100,
          },
        },
        panel7: {
          title: 'Walk-Forward Validation — Train on First 70%, Test on Last 30%',
          description:
            'Detects whether Panel 4\'s per-filter optimum is a genuine edge or an overfit corner of the 120-combo grid. panel4Rows is sorted by created_at and split 70/30. Panel 4\'s optimum is found on the TRAIN half only; that same (TP, SL) pair is then applied (NOT re-optimized) to the TEST half. Degradation = train_avg_ret − test_avg_ret. Verdict: ROBUST (<2pp), DEGRADED (2–5pp), OVERFIT (>5pp), INSUFFICIENT (train or test n<20). Cross-reference with Panel 3 stability: ROBUST filters should also be STABLE or MODERATE.',
          split: {
            train_frac: PANEL_7_TRAIN_FRAC,
            n_total: panel4RowsSorted.length,
            n_train: trainRows.length,
            n_test: testRows.length,
            train_start_iso: trainRows.length > 0 ? new Date(trainRows[0].created_at * 1000).toISOString() : null,
            train_end_iso: trainRows.length > 0 ? new Date(trainRows[trainRows.length - 1].created_at * 1000).toISOString() : null,
            test_start_iso: testRows.length > 0 ? new Date(testRows[0].created_at * 1000).toISOString() : null,
            test_end_iso: testRows.length > 0 ? new Date(testRows[testRows.length - 1].created_at * 1000).toISOString() : null,
          },
          baseline: baseline7,
          filters: filters7,
          flags: {
            low_n_threshold: 30,
            strong_n_threshold: 100,
          },
        },
        panel8: {
          title: 'Loss Tail & Risk Metrics — At Per-Filter Optimum TP/SL',
          description:
            'Quantifies the downside that the TP/SL is supposed to contain. All metrics are computed from per-token cost-adjusted returns at each filter\'s Panel 4 optimum, sorted chronologically. % loss columns count trades below the given threshold. VaR 95% = 5th percentile of the return distribution (you should expect to lose at least this much 5% of the time). CVaR 95% = mean of the bottom-5% tail (expected shortfall when VaR triggers). Worst = single worst trade. Max consecutive losses = longest streak of negative trades in chronological order.',
          baseline: baseline8,
          filters: filters8,
          flags: {
            low_n_threshold: 30,
            strong_n_threshold: 100,
          },
        },
        panel9: {
          title: 'Equity Curve & Drawdown Simulation — Trade Sequence View',
          description:
            'Simulates trading every qualifying token in chronological order at each filter\'s Panel 4 optimum TP/SL. Equity starts at 1.0 and compounds geometrically (per-trade returns are clamped at −99% to avoid zero-out pathology). Final equity multiplier, max drawdown, longest losing streak, per-trade Sharpe, and Kelly-optimal bet fraction. The sparkline shows the down-sampled equity curve (≤60 points). This converts "avg return per trade" into the portfolio view you\'d actually experience.',
          baseline: baseline9,
          filters: filters9,
          flags: {
            low_n_threshold: 30,
            strong_n_threshold: 100,
          },
        },
        panel11: panel11Data,
        panel10: {
          title: 'Dynamic Position Monitoring (DPM) Optimizer — Per-Filter, Per-Category, Overall',
          description:
            'For each filter, brute-force a 320-cell grid of DPM parameter combos (trailing SL, SL activation delay, trailing TP, breakeven stop) to find the set that maximizes avg return. Base TP/SL held fixed at 30/10 (thesis defaults) so only DPM values vary. Mirrors the layered SL logic in position-manager.ts exactly: HWM tracking, composable SL floors (each rule can only raise), SL activation delay, price-ratio trailing distances. Also reports the best DPM combo for each filter category (n-weighted across filters in the category) and the best DPM combo across ALL filters (n-weighted). Per-filter optimum gated by n≥30 AND ≥3 non-fall-through exits.',
          constants: {
            base_tp_pct: PANEL_10_BASE_TP,
            base_sl_pct: PANEL_10_BASE_SL,
            sl_gap_penalty_pct: PANEL_10_SL_GAP_PENALTY * 100,
            tp_gap_penalty_pct: PANEL_10_TP_GAP_PENALTY * 100,
            min_n_for_optimum: PANEL_10_MIN_N,
            min_active_exits_for_optimum: PANEL_10_MIN_ACTIVE_EXITS,
            combo_count: PANEL_10_COMBO_COUNT,
          },
          grid: {
            trailing_sl: PANEL_10_TRAILING_SL.map(x => ({ label: x.label, activation_pct: x.act, distance_pct: x.dist })),
            sl_delay_sec: PANEL_10_SL_DELAY_SEC,
            trailing_tp: PANEL_10_TRAILING_TP.map(x => ({ label: x.label, enabled: x.en, drop_pct: x.drop })),
            breakeven_pct: PANEL_10_BREAKEVEN,
          },
          baseline: baseline10,
          filters: filters10.map(f => {
            // top_n = top 10 DPM combos per filter (≥3 active exits), sorted by avg_ret desc.
            // Gives Claude the runners-up alongside the single optimum without publishing
            // the full 320-cell grid.
            const ranked = f.combos
              .map((c, idx) => ({ idx, ...c }))
              .filter(c => c.active_exits >= PANEL_10_MIN_ACTIVE_EXITS)
              .sort((a, b) => b.avg_ret - a.avg_ret)
              .slice(0, 10)
              .map(c => {
                const d = panel10DecodeIdx(c.idx);
                return {
                  trailing_sl: PANEL_10_TRAILING_SL[d.tsIdx].label,
                  sl_delay: PANEL_10_SL_DELAY_SEC[d.sdIdx],
                  trailing_tp: PANEL_10_TRAILING_TP[d.ttIdx].label,
                  breakeven: PANEL_10_BREAKEVEN[d.beIdx],
                  avg_ret: c.avg_ret,
                  win_rate: c.win_rate,
                  active_exits: c.active_exits,
                };
              });
            return {
              filter: f.filter,
              group: f.group,
              n: f.n,
              optimal: f.optimal,
              top_n: f.n >= PANEL_10_MIN_N ? ranked : [],
            };
          }),
          category_aggregates: categoryAggregates10,
          overall_aggregate: overallAggregate10,
          flags: {
            low_n_threshold: 30,
            strong_n_threshold: 100,
          },
        },
        // ── FILTER-ANALYSIS-V3 PANELS ──
        panelv3_1: {
          title: 'Top 20 Three-Filter Combos — Focused Scan Around Panel 6 Top Pairs',
          description:
            'For each of the top 20 two-filter pairs from Panel 6 (at T+300), this scan tries every remaining single filter as a third component, skipping candidates whose group matches either parent-pair member to avoid within-group conflicts. Each triple is run through Panel 4\'s 12×10 TP/SL grid; rows are kept only if n ≥ 30 AND the triple\'s optimum beats the parent pair\'s optimum (lift_vs_pair > 0). Top 20 surfaced per horizon (T+300 / T+120 / T+60), ranked by opt_avg_ret. beats_baseline = opt_avg_ret > rolling ALL-labeled Panel 4 optimum (see constants.baseline_sim_return).',
          constants: {
            baseline_sim_return: V3_BASELINE_SIM_RETURN,
            min_n_for_optimum: PANEL_4_MIN_N_FOR_OPTIMUM,
            horizons: ['pct_t300', 'pct_t120', 'pct_t60'],
          },
          top_triples_t300: panelV3_1_topTriples_t300,
          top_triples_t120: panelV3_1_topTriples_t120,
          top_triples_t60:  panelV3_1_topTriples_t60,
          flags: { low_n_threshold: 30, strong_n_threshold: 100 },
        },
        panelv3_2: {
          title: 'Drawdown Gate Stacking — max_dd_0_30 Layered on Top Singles & Pairs',
          description:
            'How much does adding a max_drawdown_0_30 gate improve each of the top 5 single filters and top 5 pairs? Each base is combined with max_dd_0_30 > {−5, −10, −15, −20, −25} and re-optimized through Panel 4\'s grid. n_retention_pct tells you how many tokens survive the gate (tighter threshold = fewer survivors). delta_vs_base is the pp improvement in opt_avg_ret. "unconditional" rows = max_dd_0_30 alone (no base filter). Thesis: crashes often have a tell in the 0–30s window, and pre-entry drawdown may predict which tokens keep dumping post-entry.',
          constants: {
            baseline_sim_return: V3_BASELINE_SIM_RETURN,
            dd_thresholds: PANEL_V3_2_DD_THRESHOLDS,
            min_n_for_optimum: PANEL_4_MIN_N_FOR_OPTIMUM,
          },
          rows: panelV3_2_rows,
          flags: { low_n_threshold: 30, strong_n_threshold: 100 },
        },
        panelv3_3: {
          title: 'Crash Survival Curves — Time-to-Threshold-Breach by Filter',
          description:
            'For each of ~20 selected combos (top 10 pairs + top 10 triples), this panel walks the 5s grid from T+30 to T+300 and tracks the fraction of tokens whose rel-return (vs T+30 entry) has NOT yet breached {−5%, −10%, −20%} by each checkpoint. curves[threshold_idx][timepoint_idx] = survival fraction. A filter whose P(return > −10%) stays high for longer is one where the SL is genuinely less likely to fire in the typical 60–180s window — which is the core crash-prediction question for this branch. A flat curve = tokens that survive 30s tend to survive 300s; a falling curve = steady attrition; a cliff at t=60 = the 60s crash bucket.',
          constants: {
            timepoints_sec: PANEL_V3_3_TIMEPOINTS,
            thresholds_pct: PANEL_V3_3_THRESHOLDS,
          },
          baseline: panelV3_3_baseline,
          filters: panelV3_3_filters,
          flags: { low_n_threshold: 30, strong_n_threshold: 100 },
        },
        panelv3_4: {
          title: 'max_tick_drop_0_30 — New Filter Dimension',
          description:
            'max_tick_drop_0_30 is the worst single 5s-interval price drop in the 0–30s pre-entry window, measured in percentage points. Values are ≤ 0; closer to 0 = smoother early path, more negative = a sudden flush before T+30. This panel tests it standalone and stacked on the legacy baseline composite (`vel<20 + top5<10%`) across thresholds {> −3, > −5, > −8, > −10, > −15}. Hypothesis: a large early tick-drop signals coordinated dumping that tends to continue post-entry. beats_baseline = opt_avg_ret > rolling ALL-labeled Panel 4 optimum (see constants.baseline_sim_return).',
          constants: {
            baseline_sim_return: V3_BASELINE_SIM_RETURN,
            thresholds: PANEL_V3_4_THRESHOLDS,
            min_n_for_optimum: PANEL_4_MIN_N_FOR_OPTIMUM,
          },
          rows: panelV3_4_rows,
          flags: { low_n_threshold: 30, strong_n_threshold: 100 },
        },
        panelv3_5: {
          title: 'Velocity × Liquidity Interaction Heatmap',
          description:
            'Are current edges regime-specific? 5 velocity buckets × 4 liquidity buckets = 20 cells. Each cell re-runs Panel 4\'s TP/SL optimizer on the intersection and reports opt_avg_ret. Look for: (a) whether `vel<20` beats the rolling baseline everywhere or only in certain liquidity bands; (b) whether high-liquidity tokens (>150 SOL) offer a better risk/reward than the low-liquidity long tail. beats_baseline = opt_avg_ret > rolling ALL-labeled Panel 4 optimum (see constants.baseline_sim_return). Cells with n < 30 have opt_avg_ret = null.',
          constants: {
            baseline_sim_return: V3_BASELINE_SIM_RETURN,
            vel_buckets: velBuckets.map(b => b.name),
            liq_buckets: liqBuckets.map(b => b.name),
          },
          cells: panelV3_5_cells,
          flags: { low_n_threshold: 30, strong_n_threshold: 100 },
        },
        panelv3_6: {
          title: 'sum_abs_returns_0_30 — Pre-Entry Realized Volatility',
          description:
            'sum_abs_returns_0_30 = Σ|Δpct| over the 5s intervals through T+30. Proxy for how much distance the price covered before entry, regardless of direction. Complements monotonicity: a token can be smooth-and-up (low sum_abs, monotonic) or chop-and-up (high sum_abs, non-monotonic). Tested with < thresholds {20, 40, 60, 100} (calm paths) and > thresholds {20, 40, 60} (choppy paths), standalone and stacked on `vel<20 + top5<10%`. Hypothesis: calmer pre-entry paths are more predictable post-entry.',
          constants: {
            baseline_sim_return: V3_BASELINE_SIM_RETURN,
            thresholds_lt: PANEL_V3_6_THRESHOLDS_LT,
            thresholds_gt: PANEL_V3_6_THRESHOLDS_GT,
            min_n_for_optimum: PANEL_4_MIN_N_FOR_OPTIMUM,
          },
          rows: panelV3_6_rows,
          flags: { low_n_threshold: 30, strong_n_threshold: 100 },
        },
        panelv3_7: {
          title: 'Regime Stability & Walk-Forward Validation — v3 Leaders',
          description:
            'For each of the top 10 pairs (Panel 6) and top 10 triples (v3 Panel 1 T+300), runs TWO stability checks: (a) walk-forward — train Panel 4\'s TP/SL optimum on the first 70% of rows by created_at, then evaluate THAT SAME coordinate (no re-optimization) on the held-out last 30%. Degradation = train_avg − test_avg. Verdict: ROBUST (<2pp), DEGRADED (2–5pp), OVERFIT (>5pp), INSUFFICIENT (train or test n<20). (b) Regime buckets — same 4 time-quartile buckets Panel 3/11 use. Per-bucket WR and avg return (T+30-anchored, cost-adjusted, no TP/SL). WR StdDev < 8 = STABLE, < 15 = MODERATE, ≥ 15 = CLUSTERED. A v3 leader that\'s both ROBUST and STABLE/MODERATE is a genuine promotion candidate; one that\'s OVERFIT or CLUSTERED is leaderboard noise.',
          constants: {
            wf_train_frac: PANEL_7_TRAIN_FRAC,
            wf_min_n_half: PANEL_7_MIN_N_HALF,
            regime_bucket_count: PANEL_3_BUCKET_COUNT,
          },
          rows: panelV3_7_rows,
          flags: { low_n_threshold: 30, strong_n_threshold: 100 },
        },
      };

  return filterV2Data;
}

export type FilterV2Data = ReturnType<typeof computeFilterV2Data>;
