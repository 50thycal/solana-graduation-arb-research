import express from 'express';
import pino from 'pino';
import { initDatabase } from './db/schema';
import { getGraduationCount } from './db/queries';
import { GraduationListener } from './monitor/graduation-listener';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'main' });

// Send JSON as a browser-friendly HTML page (with copy button) when Accept: text/html,
// otherwise return plain JSON for API/curl clients.
function sendJsonOrHtml(req: express.Request, res: express.Response, data: object): void {
  const wantHtml = (req.headers.accept || '').includes('text/html');
  if (!wantHtml) { res.json(data); return; }
  const json = JSON.stringify(data, null, 2);
  const escaped = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${req.path}</title>
<style>
  body{margin:0;background:#111;color:#e0e0e0;font-family:monospace;font-size:13px}
  #bar{position:sticky;top:0;background:#222;padding:8px 12px;display:flex;gap:8px;align-items:center;border-bottom:1px solid #444}
  #bar span{flex:1;color:#aaa;font-size:12px}
  button{background:#2563eb;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:13px}
  button:active{background:#1d4ed8}
  #copied{color:#4ade80;font-size:12px;display:none}
  pre{margin:0;padding:12px;white-space:pre-wrap;word-break:break-all}
</style></head><body>
<div id="bar">
  <span>${req.path} — ${new Date().toISOString()}</span>
  <button onclick="copy()">Copy All</button>
  <span id="copied">Copied!</span>
</div>
<pre id="json">${escaped}</pre>
<script>
function copy(){
  navigator.clipboard.writeText(document.getElementById('json').textContent)
    .then(()=>{var c=document.getElementById('copied');c.style.display='inline';setTimeout(()=>c.style.display='none',1500)});
}
</script>
</body></html>`);
}

const startTime = Date.now();
let listenerStatus: 'running' | 'stopped' | 'error' = 'stopped';
let listenerError: string | null = null;

async function main() {
  logger.info('Starting solana-graduation-arb-research');

  // Log env var presence for debugging (not values — they contain API keys)
  logger.info({
    hasHeliusRpc: !!process.env.HELIUS_RPC_URL,
    hasHeliusWs: !!process.env.HELIUS_WS_URL,
    dataDir: process.env.DATA_DIR || './data',
    healthPort: process.env.HEALTH_PORT || '8080',
  }, 'Environment check');

  // Initialize database
  const dataDir = process.env.DATA_DIR || './data';
  const db = initDatabase(dataDir);

  // Start health/API server first so we can always debug via /health
  const healthPort = parseInt(process.env.HEALTH_PORT || '8080', 10);
  const app = express();

  // Reset research data — wipes all rows but keeps tables/schema intact
  // Support both GET and POST so it works from a phone browser
  app.get('/reset', (req, res) => resetHandler(req, res));
  app.post('/reset', (req, res) => resetHandler(req, res));

  function resetHandler(_req: any, res: any) {
    try {
      const tables = [
        'competition_signals',
        'opportunities',
        'price_comparisons',
        'pool_observations',
        'graduation_momentum',
        'graduations',
      ];
      // Delete in dependency order (children first due to foreign keys)
      for (const table of tables) {
        db.prepare(`DELETE FROM ${table}`).run();
      }
      res.json({
        status: 'ok',
        message: 'All research data cleared. Schema and tables preserved. Bot will continue collecting fresh data.',
        tables_cleared: tables,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // MOMENTUM RESEARCH DASHBOARD
  // See CLAUDE.md for full dashboard spec
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  app.get('/thesis', (req, res) => {
    try {
      const uptimeMs = Date.now() - startTime;
      const uptimeSec = Math.floor(uptimeMs / 1000);
      const uptimeMin = Math.floor(uptimeSec / 60);
      const uptimeHrs = Math.floor(uptimeMin / 60);

      // ── HEADER ──
      const pipeline = db.prepare(`
        SELECT
          COUNT(*) as total_graduations,
          COUNT(new_pool_address) as with_pool,
          SUM(observation_complete) as observations_done,
          MAX(timestamp) as last_graduation_ts
        FROM graduations
      `).get() as any;

      const lastGradSecondsAgo = pipeline.last_graduation_ts
        ? Math.floor(Date.now() / 1000) - pipeline.last_graduation_ts
        : null;

      const completedWithT300 = db.prepare(
        'SELECT COUNT(*) as count FROM graduation_momentum WHERE pct_t300 IS NOT NULL'
      ).get() as any;

      const botStatus = listenerStatus === 'running'
        ? (lastGradSecondsAgo !== null && lastGradSecondsAgo > 300 ? 'STALLED' : 'RUNNING')
        : 'ERROR';

      // ── THESIS SCORECARD ──
      const labels = db.prepare(`
        SELECT
          label,
          COUNT(*) as count,
          ROUND(AVG(pct_t30), 1) as avg_pct_t30,
          ROUND(AVG(pct_t60), 1) as avg_pct_t60,
          ROUND(AVG(pct_t120), 1) as avg_pct_t120,
          ROUND(AVG(pct_t300), 1) as avg_pct_t300,
          ROUND(AVG(pct_t600), 1) as avg_pct_t600
        FROM graduation_momentum
        WHERE label IS NOT NULL
        GROUP BY label
      `).all() as any[];

      // Quality-filtered labels — exclude self-graduated scam tokens (sol_raised < 50)
      // Real pump.fun graduations need ~85 SOL; tiny-liquidity tokens distort price stats
      const labelsFiltered = db.prepare(`
        SELECT label, COUNT(*) as count
        FROM graduation_momentum
        WHERE label IS NOT NULL AND total_sol_raised >= 50
        GROUP BY label
      `).all() as any[];

      const totalLabeled = labels.reduce((s: number, l: any) => s + l.count, 0);
      const pumpCount = labels.find((l: any) => l.label === 'PUMP')?.count || 0;
      const dumpCount = labels.find((l: any) => l.label === 'DUMP')?.count || 0;
      const stableCount = labels.find((l: any) => l.label === 'STABLE')?.count || 0;
      const unlabeled = db.prepare(
        'SELECT COUNT(*) as count FROM graduation_momentum WHERE label IS NULL'
      ).get() as any;
      const rawWinRate = totalLabeled > 0 ? +(pumpCount / totalLabeled * 100).toFixed(1) : null;
      const samplesRemaining = Math.max(0, 30 - totalLabeled);

      const totalLabeledFiltered = labelsFiltered.reduce((s: number, l: any) => s + l.count, 0);
      const pumpFiltered = labelsFiltered.find((l: any) => l.label === 'PUMP')?.count || 0;
      const filteredWinRate = totalLabeledFiltered > 0 ? +(pumpFiltered / totalLabeledFiltered * 100).toFixed(1) : null;

      // ── BEST FILTER (simple: try each filter, pick highest win rate) ──
      let bestFilter: { name: string; rule: string; win_rate: number; sample_size: number } | null = null;
      if (totalLabeled >= 5) {
        const filterTests = [
          { name: 'top5_wallet_pct < 30', sql: "top5_wallet_pct IS NOT NULL AND top5_wallet_pct < 30" },
          { name: 'top5_wallet_pct < 20', sql: "top5_wallet_pct IS NOT NULL AND top5_wallet_pct < 20" },
          { name: 'dev_wallet_pct < 10', sql: "dev_wallet_pct IS NOT NULL AND dev_wallet_pct < 10" },
          { name: 'dev_wallet_pct < 5', sql: "dev_wallet_pct IS NOT NULL AND dev_wallet_pct < 5" },
          { name: 'holder_count >= 10', sql: "holder_count IS NOT NULL AND holder_count >= 10" },
          { name: 'holder_count >= 15', sql: "holder_count IS NOT NULL AND holder_count >= 15" },
          { name: 'total_sol_raised >= 80', sql: "total_sol_raised IS NOT NULL AND total_sol_raised >= 80" },
          { name: 'total_sol_raised >= 85', sql: "total_sol_raised IS NOT NULL AND total_sol_raised >= 85" },
        ];
        for (const ft of filterTests) {
          const r = db.prepare(`
            SELECT
              COUNT(*) as total,
              SUM(CASE WHEN label = 'PUMP' THEN 1 ELSE 0 END) as pumps
            FROM graduation_momentum
            WHERE label IS NOT NULL AND ${ft.sql}
          `).get() as any;
          if (r.total >= 3) {
            const wr = +(r.pumps / r.total * 100).toFixed(1);
            if (!bestFilter || wr > bestFilter.win_rate) {
              bestFilter = { name: ft.name, rule: ft.sql, win_rate: wr, sample_size: r.total };
            }
          }
        }
      }

      // ── AVG PRICE CHANGE BY CHECKPOINT ──
      const avgByCheckpoint = db.prepare(`
        SELECT
          ROUND(AVG(pct_t30), 2) as avg_t30,
          ROUND(AVG(pct_t60), 2) as avg_t60,
          ROUND(AVG(pct_t120), 2) as avg_t120,
          ROUND(AVG(pct_t300), 2) as avg_t300,
          ROUND(AVG(pct_t600), 2) as avg_t600,
          COUNT(pct_t30) as n_t30,
          COUNT(pct_t60) as n_t60,
          COUNT(pct_t120) as n_t120,
          COUNT(pct_t300) as n_t300,
          COUNT(pct_t600) as n_t600
        FROM graduation_momentum
      `).get() as any;

      // ── FILTER SIGNALS BY LABEL ──
      const filterSignals = db.prepare(`
        SELECT
          label,
          COUNT(*) as n,
          ROUND(AVG(holder_count), 0) as avg_holders,
          ROUND(AVG(top5_wallet_pct), 1) as avg_top5_pct,
          ROUND(AVG(dev_wallet_pct), 1) as avg_dev_pct,
          ROUND(AVG(total_sol_raised), 2) as avg_sol_raised
        FROM graduation_momentum
        WHERE label IS NOT NULL
        GROUP BY label
      `).all();

      // ── LAST 10 GRADUATIONS ──
      const last10 = db.prepare(`
        SELECT
          m.graduation_id as id,
          SUBSTR(g.mint, 1, 8) || '...' as mint,
          ROUND(m.open_price_sol, 10) as open_price,
          ROUND(m.pct_t60, 1) as t60,
          ROUND(m.pct_t300, 1) as t300,
          m.label,
          m.holder_count as holders,
          ROUND(m.top5_wallet_pct, 1) as top5_pct,
          ROUND(m.dev_wallet_pct, 1) as dev_pct,
          ROUND(m.total_sol_raised, 2) as sol_raised,
          g.new_pool_address IS NOT NULL as has_pool
        FROM graduation_momentum m
        JOIN graduations g ON g.id = m.graduation_id
        ORDER BY m.graduation_id DESC
        LIMIT 10
      `).all() as any[];

      // ── DATA QUALITY FLAGS ──
      const nullsInLast10 = last10.reduce((acc: string[], row: any, i: number) => {
        const nullFields: string[] = [];
        if (row.open_price === null) nullFields.push('open_price');
        if (row.t300 === null) nullFields.push('t300');
        if (row.holders === null) nullFields.push('holders');
        if (row.top5_pct === null) nullFields.push('top5_pct');
        if (row.dev_pct === null) nullFields.push('dev_pct');
        if (nullFields.length > 0) acc.push(`#${row.id}: ${nullFields.join(',')}`);
        return acc;
      }, []);

      const allHavePumpswapPool = last10.every((r: any) => r.has_pool);
      const listenerStats = listener ? listener.getStats() : null;

      // ── VERDICT ──
      const verdict = totalLabeled < 10 ? `COLLECTING DATA — ${totalLabeled}/30 labeled (${samplesRemaining} more needed)` :
        totalLabeled < 30 ? `COLLECTING — ${totalLabeled}/30 labeled, raw win rate ${rawWinRate}%` :
        (rawWinRate !== null && rawWinRate > 60) ? `THESIS VALID — ${rawWinRate}% raw win rate (${pumpCount}/${totalLabeled})` :
        (bestFilter && bestFilter.win_rate > 51) ? `PROMISING — raw ${rawWinRate}%, filtered ${bestFilter.win_rate}% with ${bestFilter.name} (n=${bestFilter.sample_size})` :
        (rawWinRate !== null && rawWinRate > 40) ? `MARGINAL — ${rawWinRate}% raw, filters may help` :
        `WEAK — ${rawWinRate}% raw win rate`;

      // ── CODE VERSION ──
      const codeVersion = {
        version: 'momentum-v7',
        last_change: 'Disable poolTracker.priceCollector (was producing 0 snapshots with wrong addresses). Add sol_raised >= 50 quality filter to scorecard. pfeeUxB6 confirmed as Raydium migration — thesis scope narrowed to PumpSwap-only graduations.',
        bug_fixed: 'poolTracker.priceCollector.startObservation was called with wrong pool addresses from extractPoolInfo (vault_parse_fail dataLen=0 on all 7 sessions, 76 wasted failures). totalExpired: 97 confirmed pfeeUxB6 goes to Raydium not PumpSwap — pool-tracker subscription never fired for those.',
        watch_for: 'poolTracker.priceCollector.totalStarted should be 0. directPriceCollector continues collecting clean data. scorecard.quality_filtered shows win rate without scam tokens.',
      };

      sendJsonOrHtml(req, res, {
        // ── HEADER ──
        bot_status: botStatus,
        uptime: `${uptimeHrs}h ${uptimeMin % 60}m`,
        total_graduations: pipeline.total_graduations,
        with_complete_t300: completedWithT300.count,
        last_graduation_seconds_ago: lastGradSecondsAgo,

        // ── THESIS SCORECARD ──
        scorecard: {
          total_labeled: totalLabeled,
          unlabeled: unlabeled.count,
          PUMP: pumpCount,
          DUMP: dumpCount,
          STABLE: stableCount,
          raw_win_rate_pct: rawWinRate,
          best_filter: bestFilter,
          samples_remaining: samplesRemaining,
          // Quality filter: excludes self-graduated scam tokens (sol_raised < 50 SOL)
          quality_filtered: {
            note: 'sol_raised >= 50 SOL only',
            total_labeled: totalLabeledFiltered,
            PUMP: pumpFiltered,
            DUMP: labelsFiltered.find((l: any) => l.label === 'DUMP')?.count || 0,
            win_rate_pct: filteredWinRate,
          },
        },

        // ── THESIS VERDICT ──
        thesis_verdict: verdict,

        // ── AVG BY CHECKPOINT ──
        avg_pct_by_checkpoint: avgByCheckpoint,

        // ── FILTER SIGNALS ──
        filter_signals: filterSignals,
        labels_detail: labels,

        // ── LAST 10 GRADUATIONS ──
        last_10: last10,

        // ── DATA QUALITY ──
        data_quality: {
          price_source_pumpswap: allHavePumpswapPool,
          null_fields_in_last_10: nullsInLast10.length > 0 ? nullsInLast10 : 'CLEAN',
          last_grad_stale: lastGradSecondsAgo !== null && lastGradSecondsAgo > 300,
          listener_connected: listenerStats?.wsConnected ?? false,
        },

        // ── CODE VERSION ──
        code_version: codeVersion,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Research data export — dump all collected spread/opportunity data
  app.get('/data', (req, res) => {
    try {
      const graduations = db.prepare(`
        SELECT id, mint, final_price_sol, virtual_sol_reserves, virtual_token_reserves,
               final_sol_reserves, final_token_reserves,
               new_pool_address, new_pool_dex,
               datetime(timestamp, 'unixepoch') as grad_time,
               datetime(migration_timestamp, 'unixepoch') as migration_time,
               observation_complete
        FROM graduations ORDER BY timestamp DESC
      `).all();

      const priceComparisons = db.prepare(`
        SELECT pc.graduation_id, pc.seconds_since_graduation,
               pc.bonding_curve_price, pc.dex_pool_price,
               pc.bc_to_dex_spread_pct,
               g.mint
        FROM price_comparisons pc
        JOIN graduations g ON g.id = pc.graduation_id
        ORDER BY pc.graduation_id, pc.seconds_since_graduation
      `).all();

      const poolObservations = db.prepare(`
        SELECT graduation_id, seconds_since_graduation,
               pool_price_sol, pool_sol_reserves, pool_token_reserves
        FROM pool_observations
        ORDER BY graduation_id, seconds_since_graduation
      `).all();

      const opportunities = db.prepare(`
        SELECT o.graduation_id, o.max_spread_pct,
               o.duration_above_05_pct,
               o.duration_above_1_pct,
               o.duration_above_2_pct,
               o.estimated_profit_sol, o.net_profit_sol,
               o.viability_score, o.classification,
               g.mint, g.final_price_sol
        FROM opportunities o
        JOIN graduations g ON g.id = o.graduation_id
        ORDER BY o.viability_score DESC
      `).all();

      const competitionSignals = db.prepare(`
        SELECT graduation_id, seconds_since_graduation, action, is_likely_bot
        FROM competition_signals
        ORDER BY graduation_id, seconds_since_graduation
        LIMIT 200
      `).all();

      sendJsonOrHtml(req, res, {
        summary: {
          total_graduations: graduations.length,
          with_pool: graduations.filter((g: any) => g.new_pool_address).length,
          observations_complete: graduations.filter((g: any) => g.observation_complete).length,
          total_price_comparisons: priceComparisons.length,
          total_opportunities: opportunities.length,
        },
        graduations,
        priceComparisons,
        poolObservations,
        opportunities,
        competitionSignals,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── FILTER ANALYSIS ──────────────────────────────────────────────────────
  // Read-only sweep of all filter combinations against the labeled DB.
  // Hit this from a browser to get a full breakdown with copy button.
  app.get('/filter-analysis', (req, res) => {
    try {
      const winRate = (pump: number, total: number) =>
        total === 0 ? null : +(pump / total * 100).toFixed(1);

      const runFilter = (label: string, extraWhere: string) => {
        const where = extraWhere ? `label IS NOT NULL AND ${extraWhere}` : 'label IS NOT NULL';
        const row = db.prepare(`
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN label='PUMP'   THEN 1 ELSE 0 END) as pump,
            SUM(CASE WHEN label='DUMP'   THEN 1 ELSE 0 END) as dump,
            SUM(CASE WHEN label='STABLE' THEN 1 ELSE 0 END) as stable,
            ROUND(AVG(total_sol_raised), 1) as avg_sol,
            ROUND(AVG(holder_count), 1)     as avg_holders,
            ROUND(AVG(top5_wallet_pct), 1)  as avg_top5,
            ROUND(AVG(pct_t300), 1)         as avg_t300
          FROM graduation_momentum WHERE ${where}
        `).get() as any;
        return {
          filter: label,
          n: row.total,
          pump: row.pump,
          dump: row.dump,
          stable: row.stable,
          win_rate_pct: winRate(row.pump, row.total),
          avg_sol: row.avg_sol,
          avg_holders: row.avg_holders,
          avg_top5_pct: row.avg_top5,
          avg_t300_pct: row.avg_t300,
        };
      };

      const solBuckets = db.prepare(`
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
        FROM graduation_momentum WHERE label IS NOT NULL
        GROUP BY bucket ORDER BY MIN(COALESCE(total_sol_raised, -1))
      `).all() as any[];

      const ageBuckets = db.prepare(`
        SELECT
          CASE
            WHEN token_age_seconds IS NULL    THEN 'null'
            WHEN token_age_seconds < 3600     THEN '<1h'
            WHEN token_age_seconds < 86400    THEN '1h-24h'
            WHEN token_age_seconds < 604800   THEN '1d-7d'
            ELSE '7d+'
          END as bucket,
          COUNT(*) as total,
          SUM(CASE WHEN label='PUMP' THEN 1 ELSE 0 END) as pump,
          SUM(CASE WHEN label='DUMP' THEN 1 ELSE 0 END) as dump
        FROM graduation_momentum WHERE label IS NOT NULL
        GROUP BY bucket ORDER BY MIN(COALESCE(token_age_seconds, -1))
      `).all() as any[];

      const contRow = db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN pct_t300 > pct_t30 THEN 1 ELSE 0 END) as continued,
          SUM(CASE WHEN pct_t300 > pct_t30 AND total_sol_raised >= 80 THEN 1 ELSE 0 END) as cont_hq,
          COUNT(CASE WHEN total_sol_raised >= 80 THEN 1 END) as total_hq
        FROM graduation_momentum
        WHERE pct_t30 IS NOT NULL AND pct_t300 IS NOT NULL
      `).get() as any;

      const dupes = db.prepare(
        `SELECT mint, COUNT(*) as cnt FROM graduations GROUP BY mint HAVING cnt > 1`
      ).all() as any[];

      // T+30 entry economics helper — runs for any (minPct, maxPct) threshold
      // Formula: ((1 + pct_t300/100) / (1 + pct_t30/100) - 1) * 100
      const ECON_EXPR = `(1.0 + pct_t300 / 100.0) / (1.0 + pct_t30 / 100.0) * 100.0 - 100.0`;
      const PROF_EXPR = `(1.0 + pct_t300 / 100.0) / (1.0 + pct_t30 / 100.0) > 1.0`;

      const runT30Econ = (minPct: number, maxPct: number) => {
        const base = `pct_t30 IS NOT NULL AND pct_t300 IS NOT NULL AND pct_t30 >= ${minPct} AND pct_t30 <= ${maxPct}`;

        const allRow = db.prepare(`
          SELECT COUNT(*) as n,
            ROUND(AVG(${ECON_EXPR}), 1) as avg_return_from_t30,
            SUM(CASE WHEN ${PROF_EXPR} THEN 1 ELSE 0 END) as profitable_from_t30,
            ROUND(AVG(pct_t30),  1) as avg_t30_gain,
            ROUND(AVG(pct_t300), 1) as avg_t300_gain
          FROM graduation_momentum WHERE ${base}
        `).get() as any;

        const hqRow = db.prepare(`
          SELECT COUNT(*) as n,
            ROUND(AVG(${ECON_EXPR}), 1) as avg_return_from_t30,
            SUM(CASE WHEN ${PROF_EXPR} THEN 1 ELSE 0 END) as profitable_from_t30,
            ROUND(AVG(pct_t30),  1) as avg_t30_gain,
            ROUND(AVG(pct_t300), 1) as avg_t300_gain
          FROM graduation_momentum WHERE ${base} AND total_sol_raised >= 80
        `).get() as any;

        const byLabel = db.prepare(`
          SELECT label, COUNT(*) as n,
            ROUND(AVG(${ECON_EXPR}), 1) as avg_return_from_t30,
            SUM(CASE WHEN ${PROF_EXPR} THEN 1 ELSE 0 END) as profitable_from_t30,
            ROUND(AVG(pct_t30),  1) as avg_t30_gain,
            ROUND(AVG(pct_t300), 1) as avg_t300_gain
          FROM graduation_momentum WHERE ${base} GROUP BY label
        `).all() as any[];

        const fmt = (r: any) => ({
          n: r.n,
          avg_t30_gain_pct:        r.avg_t30_gain,
          avg_t300_gain_pct:       r.avg_t300_gain,
          avg_return_from_t30_pct: r.avg_return_from_t30,
          profitable_from_t30:     r.profitable_from_t30,
          profitable_rate_pct:     r.n > 0 ? +(r.profitable_from_t30 / r.n * 100).toFixed(1) : null,
        });

        return {
          threshold: `t30 between +${minPct}% and +${maxPct}%`,
          all_cohort:       fmt(allRow),
          sol_gte_80_cohort: fmt(hqRow),
          by_label: byLabel.map((r: any) => ({ label: r.label, ...fmt(r) })),
        };
      };

      sendJsonOrHtml(req, res, {
        generated_at: new Date().toISOString(),

        sol_raised_filters: [
          runFilter('ALL (no filter)',    ''),
          runFilter('sol >= 30',          'total_sol_raised >= 30'),
          runFilter('sol >= 50',          'total_sol_raised >= 50'),
          runFilter('sol >= 70',          'total_sol_raised >= 70'),
          runFilter('sol >= 80',          'total_sol_raised >= 80'),
          runFilter('sol >= 84',          'total_sol_raised >= 84'),
        ],

        holder_filters: [
          runFilter('holders >= 5',       'holder_count >= 5'),
          runFilter('holders >= 10',      'holder_count >= 10'),
          runFilter('holders >= 12',      'holder_count >= 12'),
          runFilter('holders >= 15',      'holder_count >= 15'),
          runFilter('holders >= 18',      'holder_count >= 18'),
        ],

        top5_filters: [
          runFilter('top5 > 5%',          'top5_wallet_pct > 5'),
          runFilter('top5 > 8%',          'top5_wallet_pct > 8'),
          runFilter('top5 > 10%',         'top5_wallet_pct > 10'),
          runFilter('top5 > 12%',         'top5_wallet_pct > 12'),
          runFilter('top5 > 15%',         'top5_wallet_pct > 15'),
          runFilter('top5 < 20%',         'top5_wallet_pct < 20'),
        ],

        bc_age_filters: [
          runFilter('bc_age > 10min',     'token_age_seconds > 600'),
          runFilter('bc_age > 30min',     'token_age_seconds > 1800'),
          runFilter('bc_age > 1hr',       'token_age_seconds > 3600'),
          runFilter('bc_age > 1day',      'token_age_seconds > 86400'),
          runFilter('bc_age < 1hr',       'token_age_seconds < 3600'),
        ],

        t30_entry_filters: [
          runFilter('t30 between +5% and +50% (modest)',  'pct_t30 >= 5 AND pct_t30 <= 50'),
          runFilter('t30 between +5% and +100%',          'pct_t30 >= 5 AND pct_t30 <= 100'),
          runFilter('t30 > 0%',                           'pct_t30 > 0'),
          runFilter('t30 < 200% (no mega-spikes)',        'pct_t30 < 200'),
          runFilter('t30 < 100%',                         'pct_t30 < 100'),
          runFilter('t30 between -10% and +100%',         'pct_t30 >= -10 AND pct_t30 <= 100'),
        ],

        combination_filters: [
          runFilter('sol>=70 AND holders>=12',                  'total_sol_raised>=70 AND holder_count>=12'),
          runFilter('sol>=70 AND holders>=15',                  'total_sol_raised>=70 AND holder_count>=15'),
          runFilter('sol>=80 AND holders>=12',                  'total_sol_raised>=80 AND holder_count>=12'),
          runFilter('sol>=80 AND holders>=15',                  'total_sol_raised>=80 AND holder_count>=15'),
          runFilter('sol>=70 AND top5>10%',                     'total_sol_raised>=70 AND top5_wallet_pct>10'),
          runFilter('sol>=80 AND top5>10%',                     'total_sol_raised>=80 AND top5_wallet_pct>10'),
          runFilter('holders>=10 AND top5>10%',                 'holder_count>=10 AND top5_wallet_pct>10'),
          runFilter('holders>=12 AND top5>10%',                 'holder_count>=12 AND top5_wallet_pct>10'),
          runFilter('holders>=15 AND top5>10%',                 'holder_count>=15 AND top5_wallet_pct>10'),
          runFilter('sol>=70 AND holders>=10 AND top5>10%',     'total_sol_raised>=70 AND holder_count>=10 AND top5_wallet_pct>10'),
          runFilter('sol>=80 AND holders>=12 AND top5>10%',     'total_sol_raised>=80 AND holder_count>=12 AND top5_wallet_pct>10'),
          runFilter('sol>=80 AND holders>=15 AND top5>10%',     'total_sol_raised>=80 AND holder_count>=15 AND top5_wallet_pct>10'),
          runFilter('sol>=80 AND holders>=10 AND dev<5%',       'total_sol_raised>=80 AND holder_count>=10 AND dev_wallet_pct<5'),
          runFilter('sol>=80 AND holders>=10 AND t30<200%',     'total_sol_raised>=80 AND holder_count>=10 AND pct_t30<200'),
          runFilter('sol>=80 AND t30 between +5% and +100%',    'total_sol_raised>=80 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('holders>=10 AND t30 between +5% and +100%','holder_count>=10 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('sol>=70 AND holders>=10 AND t30<200%',     'total_sol_raised>=70 AND holder_count>=10 AND pct_t30<200'),
          runFilter('sol>=84 AND holders>=15 AND top5>10%',     'total_sol_raised>=84 AND holder_count>=15 AND top5_wallet_pct>10'),
        ],

        momentum_continuation: {
          note: 'Does price at T+300 exceed price at T+30? (delayed entry thesis)',
          all_samples: { continued: contRow.continued, total: contRow.total, rate_pct: winRate(contRow.continued, contRow.total) },
          sol_gte_80:  { continued: contRow.cont_hq,   total: contRow.total_hq, rate_pct: winRate(contRow.cont_hq, contRow.total_hq) },
        },

        t30_entry_economics: {
          note: 'Shows actual return if you ENTER at T+30 price (not T+0 open). Tested at progressively tighter T+30 thresholds to find the optimal entry bar. avg_return_from_t30_pct is what the trade actually makes after entering at T+30.',
          thresholds: [
            runT30Econ(5,  50),
            runT30Econ(10, 50),
            runT30Econ(15, 50),
            runT30Econ(20, 50),
            runT30Econ(25, 50),
            runT30Econ(5,  100),
            runT30Econ(10, 100),
            runT30Econ(15, 100),
          ],
        },

        sol_raised_distribution: solBuckets.map((b: any) => ({
          bucket: b.bucket, total: b.total, pump: b.pump, dump: b.dump,
          win_rate_pct: winRate(b.pump, b.total),
        })),

        bc_age_distribution: ageBuckets.map((b: any) => ({
          bucket: b.bucket, total: b.total, pump: b.pump, dump: b.dump,
          win_rate_pct: winRate(b.pump, b.total),
        })),

        duplicate_mints: dupes.length === 0
          ? 'none'
          : dupes.map((d: any) => ({ mint: d.mint, count: d.cnt })),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── DEX LISTING CHECK ────────────────────────────────────────────────────
  // Checks where graduated tokens actually land using both Raydium API and
  // DexScreener (which indexes all DEXes). Answers "where do pfeeUxB6 tokens go?"
  // ?sample=N (default 20, max 50) — DexScreener supports up to 30 mints per call.
  app.get('/raydium-check', async (req, res) => {
    const sample = Math.min(50, Math.max(1, parseInt((req.query.sample as string) || '20', 10)));
    const quality = (req.query.quality as string) || 'recent';

    // 'pump' = PUMP-labeled tokens (confirmed high quality, price data verified)
    // 'recent' = last N mints regardless of label
    const mints = quality === 'pump'
      ? (db.prepare(`
          SELECT g.mint, g.final_sol_reserves
          FROM graduation_momentum gm
          JOIN graduations g ON g.id = gm.graduation_id
          WHERE gm.label = 'PUMP'
          ORDER BY gm.id DESC
          LIMIT ?
        `).all(sample) as Array<{ mint: string; final_sol_reserves: number | null }>)
      : (db.prepare(`
          SELECT mint, final_sol_reserves
          FROM graduations
          ORDER BY id DESC
          LIMIT ?
        `).all(sample) as Array<{ mint: string; final_sol_reserves: number | null }>);

    const fetchJson = (url: string): Promise<any> =>
      new Promise((resolve) => {
        const https = require('https');
        https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'research-bot/1.0' } }, (r: any) => {
          let d = '';
          r.on('data', (c: any) => d += c);
          r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
        }).on('error', () => resolve(null));
      });

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    // ── Step 1: DexScreener batch lookup (up to 30 per call) ──────────────
    // Returns all DEX pairs for each mint — tells us exactly where tokens land
    const dexByMint: Record<string, { dexes: string[]; pairs: number }> = {};
    const batchSize = 30;
    for (let i = 0; i < mints.length; i += batchSize) {
      const batch = mints.slice(i, i + batchSize).map(m => m.mint);
      const dexRes = await fetchJson(
        `https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`
      );
      if (dexRes?.pairs) {
        for (const pair of dexRes.pairs) {
          const mint = pair.baseToken?.address;
          if (!mint) continue;
          if (!dexByMint[mint]) dexByMint[mint] = { dexes: [], pairs: 0 };
          dexByMint[mint].pairs++;
          if (!dexByMint[mint].dexes.includes(pair.dexId)) {
            dexByMint[mint].dexes.push(pair.dexId);
          }
        }
      }
      if (i + batchSize < mints.length) await sleep(400);
    }

    // ── Step 2: Raydium API check (fixed: poolType=standard-cpmm for CPMM) ─
    const raydiumByMint: Record<string, { hasCpmm: boolean; hasAny: boolean; poolType?: string }> = {};
    for (const { mint } of mints) {
      const allRes = await fetchJson(
        `https://api-v3.raydium.io/pools/info/mint?mint1=${mint}&poolType=all&poolSortField=default&sortType=desc&pageSize=1&page=1`
      );
      if (allRes?.data?.count > 0) {
        const pool = allRes.data.data?.[0];
        const isCpmm = pool?.type === 'Standard' || pool?.type === 'standard-cpmm';
        raydiumByMint[mint] = { hasCpmm: isCpmm, hasAny: true, poolType: pool?.type };
      } else {
        raydiumByMint[mint] = { hasCpmm: false, hasAny: false };
      }
      await sleep(250);
    }

    // ── Aggregate results ─────────────────────────────────────────────────
    const results = mints.map(({ mint, final_sol_reserves }) => ({
      mint,
      sol: final_sol_reserves,
      dex_pairs: dexByMint[mint]?.pairs || 0,
      dexes_found: dexByMint[mint]?.dexes || [],
      raydium_any_pool: raydiumByMint[mint]?.hasAny || false,
      raydium_pool_type: raydiumByMint[mint]?.poolType || null,
    }));

    const total         = results.length;
    const onAnyDex      = results.filter(r => r.dex_pairs > 0).length;
    const onRaydium     = results.filter(r => r.dexes_found.includes('raydium')).length;
    const onPumpswap    = results.filter(r => r.dexes_found.includes('pump_amm') || r.dexes_found.includes('pumpfun') || r.dexes_found.includes('pump')).length;
    const notListed     = results.filter(r => r.dex_pairs === 0).length;
    const raydiumApiHit = results.filter(r => r.raydium_any_pool).length;

    // Count all unique dex names seen
    const dexCounts: Record<string, number> = {};
    for (const r of results) {
      for (const dex of r.dexes_found) {
        dexCounts[dex] = (dexCounts[dex] || 0) + 1;
      }
    }

    sendJsonOrHtml(req, res, {
      generated_at: new Date().toISOString(),
      sample_size: total,
      note: `DexScreener shows all DEX pairs. Raydium API cross-checks CPMM directly. mode=${quality} (?quality=pump for PUMP-labeled only, ?quality=recent for latest mints)`,
      dexscreener_summary: {
        listed_on_any_dex:  { count: onAnyDex,   pct: +(onAnyDex   / total * 100).toFixed(1) },
        listed_on_raydium:  { count: onRaydium,  pct: +(onRaydium  / total * 100).toFixed(1) },
        listed_on_pumpswap: { count: onPumpswap, pct: +(onPumpswap / total * 100).toFixed(1) },
        not_listed_anywhere:{ count: notListed,  pct: +(notListed  / total * 100).toFixed(1) },
        dex_breakdown: dexCounts,
      },
      raydium_api_summary: {
        found_via_raydium_api: { count: raydiumApiHit, pct: +(raydiumApiHit / total * 100).toFixed(1) },
      },
      verdict: onRaydium > 0
        ? `RAYDIUM CONFIRMED — ${onRaydium}/${total} tokens (${(onRaydium/total*100).toFixed(0)}%) found on Raydium via DexScreener`
        : onAnyDex > 0
          ? `NOT RAYDIUM — tokens land on: ${Object.keys(dexCounts).join(', ')}`
          : `UNLISTED — ${notListed}/${total} tokens not found on any indexed DEX (too new, or going to non-indexed venue)`,
      per_mint: results.map(r => ({
        mint: r.mint.slice(0, 12) + '...',
        sol: r.sol,
        dex_pairs: r.dex_pairs,
        dexes: r.dexes_found,
        raydium_api: r.raydium_any_pool,
      })),
    });
  });

  app.get('/health', (req, res) => {
    const uptimeMs = Date.now() - startTime;
    const uptimeSeconds = Math.floor(uptimeMs / 1000);
    const graduationCount = getGraduationCount(db);
    const listenerStats = listener ? listener.getStats() : null;

    sendJsonOrHtml(req, res, {
      status: listenerStatus === 'running' ? 'ok' : 'degraded',
      listener_status: listenerStatus,
      listener_error: listenerError,
      uptime_seconds: uptimeSeconds,
      graduation_count: graduationCount,
      listener_stats: listenerStats,
      timestamp: new Date().toISOString(),
    });
  });

  app.listen(healthPort, () => {
    logger.info({ port: healthPort }, 'Health server listening');
  });

  // Start graduation listener (after Express so health endpoint is available)
  let listener: GraduationListener | null = null;
  try {
    listener = new GraduationListener(db);
    await listener.start();
    listenerStatus = 'running';
    logger.info('Graduation listener started successfully');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    listenerStatus = 'error';
    listenerError = message;
    logger.error('Graduation listener failed to start: %s', message);
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    if (listener) await listener.stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error('Fatal error: %s', message);
  console.error('FATAL:', message);
  process.exit(1);
});
