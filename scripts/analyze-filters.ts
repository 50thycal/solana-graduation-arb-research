/**
 * Filter Analysis Script
 * Run against the live DB without stopping the bot:
 *   npx ts-node scripts/analyze-filters.ts
 *   DATA_DIR=/your/path npx ts-node scripts/analyze-filters.ts
 */

import Database from 'better-sqlite3';
import path from 'path';

const dataDir = process.env.DATA_DIR || './data';
const dbPath = path.join(dataDir, 'graduation-arb.db');
const db = new Database(dbPath, { readonly: true });

function pct(pump: number, total: number) {
  if (total === 0) return 'n/a';
  return `${(pump / total * 100).toFixed(1)}%`;
}

function runFilter(label: string, sql: string) {
  const rows = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN label = 'PUMP' THEN 1 ELSE 0 END) as pump,
      SUM(CASE WHEN label = 'DUMP' THEN 1 ELSE 0 END) as dump,
      SUM(CASE WHEN label = 'STABLE' THEN 1 ELSE 0 END) as stable,
      ROUND(AVG(total_sol_raised), 1) as avg_sol,
      ROUND(AVG(holder_count), 1) as avg_holders,
      ROUND(AVG(top5_wallet_pct), 1) as avg_top5,
      ROUND(AVG(pct_t300), 1) as avg_t300
    FROM graduation_momentum
    WHERE label IS NOT NULL ${sql ? 'AND ' + sql : ''}
  `).get() as any;

  const winRate = rows.total > 0 ? (rows.pump / rows.total * 100).toFixed(1) : 'n/a';
  console.log(
    `${label.padEnd(45)} | n=${String(rows.total).padStart(3)} | PUMP=${String(rows.pump).padStart(3)} DUMP=${String(rows.dump).padStart(3)} | win=${String(winRate + '%').padStart(6)} | avg_sol=${rows.avg_sol} avg_holders=${rows.avg_holders} avg_top5=${rows.avg_top5}%`
  );
}

// ── OVERVIEW ─────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════════');
console.log(' FULL DATASET (all labeled)');
console.log('══════════════════════════════════════════════════════════════════');
runFilter('ALL labeled', '');

console.log('\n── SINGLE FILTERS (sol_raised) ─────────────────────────────────────');
runFilter('sol_raised >= 30', 'total_sol_raised >= 30');
runFilter('sol_raised >= 50', 'total_sol_raised >= 50');
runFilter('sol_raised >= 70', 'total_sol_raised >= 70');
runFilter('sol_raised >= 80', 'total_sol_raised >= 80');
runFilter('sol_raised >= 84', 'total_sol_raised >= 84');

console.log('\n── SINGLE FILTERS (holders) ─────────────────────────────────────────');
runFilter('holders >= 5',  'holder_count >= 5');
runFilter('holders >= 10', 'holder_count >= 10');
runFilter('holders >= 12', 'holder_count >= 12');
runFilter('holders >= 15', 'holder_count >= 15');
runFilter('holders >= 18', 'holder_count >= 18');

console.log('\n── SINGLE FILTERS (top5_wallet_pct) ────────────────────────────────');
runFilter('top5_pct > 5',  'top5_wallet_pct > 5');
runFilter('top5_pct > 8',  'top5_wallet_pct > 8');
runFilter('top5_pct > 10', 'top5_wallet_pct > 10');
runFilter('top5_pct > 12', 'top5_wallet_pct > 12');
runFilter('top5_pct > 15', 'top5_wallet_pct > 15');
runFilter('top5_pct < 20', 'top5_wallet_pct < 20');

console.log('\n── SINGLE FILTERS (dev_wallet_pct) ─────────────────────────────────');
runFilter('dev_pct < 3',  'dev_wallet_pct < 3');
runFilter('dev_pct < 5',  'dev_wallet_pct < 5');
runFilter('dev_pct < 10', 'dev_wallet_pct < 10');
runFilter('dev_pct > 3',  'dev_wallet_pct > 3');

console.log('\n── SINGLE FILTERS (token_age_seconds) ──────────────────────────────');
runFilter('bc_age > 600s (10min)',   'token_age_seconds > 600');
runFilter('bc_age > 1800s (30min)',  'token_age_seconds > 1800');
runFilter('bc_age > 3600s (1hr)',    'token_age_seconds > 3600');
runFilter('bc_age > 86400s (1day)', 'token_age_seconds > 86400');
runFilter('bc_age < 3600s (<1hr)',  'token_age_seconds < 3600');

console.log('\n── T+30 ENTRY FILTER (momentum continuation thesis) ─────────────────');
runFilter('t30 between +5% and +50% (modest pump)', 'pct_t30 >= 5 AND pct_t30 <= 50');
runFilter('t30 between +5% and +100%',              'pct_t30 >= 5 AND pct_t30 <= 100');
runFilter('t30 > 0% (any gain at T+30)',            'pct_t30 > 0');
runFilter('t30 > 10%',                              'pct_t30 > 10');
runFilter('t30 < 200% (exclude mega-spikes)',       'pct_t30 < 200');
runFilter('t30 < 100% (exclude spikes)',            'pct_t30 < 100');
runFilter('t30 between -10% and +100%',             'pct_t30 >= -10 AND pct_t30 <= 100');

console.log('\n── COMBINATION FILTERS ──────────────────────────────────────────────');
runFilter('sol>=70 AND holders>=12',                        'total_sol_raised >= 70 AND holder_count >= 12');
runFilter('sol>=70 AND holders>=15',                        'total_sol_raised >= 70 AND holder_count >= 15');
runFilter('sol>=80 AND holders>=12',                        'total_sol_raised >= 80 AND holder_count >= 12');
runFilter('sol>=80 AND holders>=15',                        'total_sol_raised >= 80 AND holder_count >= 15');
runFilter('sol>=70 AND top5>10',                            'total_sol_raised >= 70 AND top5_wallet_pct > 10');
runFilter('sol>=80 AND top5>10',                            'total_sol_raised >= 80 AND top5_wallet_pct > 10');
runFilter('holders>=10 AND top5>10',                        'holder_count >= 10 AND top5_wallet_pct > 10');
runFilter('holders>=12 AND top5>10',                        'holder_count >= 12 AND top5_wallet_pct > 10');
runFilter('holders>=15 AND top5>10',                        'holder_count >= 15 AND top5_wallet_pct > 10');
runFilter('sol>=70 AND holders>=10 AND top5>10',            'total_sol_raised >= 70 AND holder_count >= 10 AND top5_wallet_pct > 10');
runFilter('sol>=80 AND holders>=12 AND top5>10',            'total_sol_raised >= 80 AND holder_count >= 12 AND top5_wallet_pct > 10');
runFilter('sol>=80 AND holders>=15 AND top5>10',            'total_sol_raised >= 80 AND holder_count >= 15 AND top5_wallet_pct > 10');
runFilter('sol>=80 AND holders>=10 AND dev<5',              'total_sol_raised >= 80 AND holder_count >= 10 AND dev_wallet_pct < 5');
runFilter('sol>=80 AND holders>=10 AND t30<200%',           'total_sol_raised >= 80 AND holder_count >= 10 AND pct_t30 < 200');
runFilter('sol>=80 AND t30 between +5% and +100%',          'total_sol_raised >= 80 AND pct_t30 >= 5 AND pct_t30 <= 100');
runFilter('holders>=10 AND t30 between +5% and +100%',      'holder_count >= 10 AND pct_t30 >= 5 AND pct_t30 <= 100');
runFilter('sol>=70 AND holders>=10 AND t30<200%',           'total_sol_raised >= 70 AND holder_count >= 10 AND pct_t30 < 200');

console.log('\n── T+30 MOMENTUM CONTINUATION (re-label: win = t300 > t30) ─────────');
// Does the token CONTINUE to gain from T+30 to T+300?
const contRows = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN pct_t300 > pct_t30 THEN 1 ELSE 0 END) as continued,
    SUM(CASE WHEN pct_t300 > pct_t30 AND total_sol_raised >= 80 THEN 1 ELSE 0 END) as cont_hq,
    COUNT(CASE WHEN total_sol_raised >= 80 THEN 1 END) as total_hq
  FROM graduation_momentum
  WHERE pct_t30 IS NOT NULL AND pct_t300 IS NOT NULL
`).get() as any;
console.log(`  T+300 > T+30 (price continues rising): ${contRows.continued}/${contRows.total} = ${pct(contRows.continued, contRows.total)}`);
console.log(`  T+300 > T+30 AND sol>=80:              ${contRows.cont_hq}/${contRows.total_hq} = ${pct(contRows.cont_hq, contRows.total_hq)}`);

console.log('\n── DUPLICATE MINT CHECK ─────────────────────────────────────────────');
const dupes = db.prepare(`
  SELECT mint, COUNT(*) as cnt FROM graduations GROUP BY mint HAVING cnt > 1
`).all() as any[];
console.log(`  Duplicate mints: ${dupes.length} (${dupes.map((d: any) => `${d.mint.slice(0,8)}:${d.cnt}`).join(', ') || 'none'})`);

console.log('\n── SAMPLE DISTRIBUTION BY SOL RAISED ───────────────────────────────');
const buckets = db.prepare(`
  SELECT
    CASE
      WHEN total_sol_raised IS NULL THEN 'null'
      WHEN total_sol_raised < 1    THEN '<1 SOL'
      WHEN total_sol_raised < 10   THEN '1-10 SOL'
      WHEN total_sol_raised < 50   THEN '10-50 SOL'
      WHEN total_sol_raised < 80   THEN '50-80 SOL'
      WHEN total_sol_raised < 86   THEN '80-86 SOL'
      ELSE '86+ SOL'
    END as bucket,
    COUNT(*) as total,
    SUM(CASE WHEN label='PUMP' THEN 1 ELSE 0 END) as pump,
    SUM(CASE WHEN label='DUMP' THEN 1 ELSE 0 END) as dump
  FROM graduation_momentum
  WHERE label IS NOT NULL
  GROUP BY bucket
  ORDER BY MIN(COALESCE(total_sol_raised, -1))
`).all() as any[];
for (const b of buckets) {
  console.log(`  ${b.bucket.padEnd(12)} | n=${b.total} | PUMP=${b.pump} DUMP=${b.dump} | win=${pct(b.pump, b.total)}`);
}

console.log('\n── BC AGE DISTRIBUTION ──────────────────────────────────────────────');
const ageBuckets = db.prepare(`
  SELECT
    CASE
      WHEN token_age_seconds IS NULL THEN 'null'
      WHEN token_age_seconds < 3600    THEN '<1h'
      WHEN token_age_seconds < 86400   THEN '1h-24h'
      WHEN token_age_seconds < 604800  THEN '1d-7d'
      ELSE '7d+'
    END as bucket,
    COUNT(*) as total,
    SUM(CASE WHEN label='PUMP' THEN 1 ELSE 0 END) as pump,
    SUM(CASE WHEN label='DUMP' THEN 1 ELSE 0 END) as dump
  FROM graduation_momentum
  WHERE label IS NOT NULL
  GROUP BY bucket
  ORDER BY MIN(COALESCE(token_age_seconds, -1))
`).all() as any[];
for (const b of ageBuckets) {
  console.log(`  ${b.bucket.padEnd(12)} | n=${b.total} | PUMP=${b.pump} DUMP=${b.dump} | win=${pct(b.pump, b.total)}`);
}

console.log('\n══════════════════════════════════════════════════════════════════\n');
db.close();
