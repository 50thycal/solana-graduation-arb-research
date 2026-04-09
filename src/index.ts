import express from 'express';
import pino from 'pino';
import { Connection, PublicKey } from '@solana/web3.js';
import { initDatabase } from './db/schema';
import { getGraduationCount } from './db/queries';
import { GraduationListener } from './monitor/graduation-listener';
import { renderThesisHtml, renderFilterHtml, renderPricePathHtml, renderFilterV2Html } from './utils/html-renderer';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'main' });

// Send JSON as a browser-friendly HTML page (with copy button) when Accept: text/html,
// otherwise return plain JSON for API/curl clients.
// Navigation links for the dashboard (excludes reset for safety)
const NAV_LINKS = [
  { path: '/dashboard', label: 'Dashboard' },
  { path: '/thesis', label: 'Thesis' },
  { path: '/filter-analysis', label: 'Filters' },
  { path: '/filter-analysis-v2', label: 'Filters V2' },
  { path: '/price-path', label: 'Price Path' },
  { path: '/tokens?label=PUMP&min_sol=80', label: 'Tokens' },
  { path: '/health', label: 'Health' },
  { path: '/data', label: 'Raw Data' },
  { path: '/raydium-check', label: 'DEX Check' },
];

function sendJsonOrHtml(req: express.Request, res: express.Response, data: object): void {
  const wantHtml = (req.headers.accept || '').includes('text/html');
  if (!wantHtml) { res.json(data); return; }
  const json = JSON.stringify(data, null, 2);
  const escaped = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const navHtml = NAV_LINKS.map(l =>
    l.path === req.path || (req.path === '/' && l.path === '/dashboard')
      ? `<a class="nav-active">${l.label}</a>`
      : `<a href="${l.path}">${l.label}</a>`
  ).join('');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Graduation Research — ${req.path}</title>
<style>
  body{margin:0;background:#111;color:#e0e0e0;font-family:monospace;font-size:13px}
  nav{position:sticky;top:0;z-index:10;background:#1a1a2e;padding:8px 12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #333}
  nav a{color:#94a3b8;text-decoration:none;padding:5px 12px;border-radius:4px;font-size:12px;cursor:pointer;transition:background .15s}
  nav a:hover{background:#334155;color:#e2e8f0}
  nav .nav-active{background:#2563eb;color:#fff;pointer-events:none}
  nav .title{color:#60a5fa;font-weight:bold;font-size:13px;margin-right:8px}
  #bar{background:#222;padding:8px 12px;display:flex;gap:8px;align-items:center;border-bottom:1px solid #444}
  #bar span{flex:1;color:#aaa;font-size:12px}
  button{background:#2563eb;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:13px}
  button:active{background:#1d4ed8}
  #copied{color:#4ade80;font-size:12px;display:none}
  pre{margin:0;padding:12px;white-space:pre-wrap;word-break:break-all}
  .refresh{background:#334155;font-size:11px;padding:4px 10px}
</style></head><body>
<nav>
  <span class="title">Graduation Arb Research</span>
  ${navHtml}
</nav>
<div id="bar">
  <span>${req.path} — ${new Date().toISOString()}</span>
  <button onclick="copy()">Copy JSON</button>
  <button class="refresh" onclick="location.reload()">Refresh</button>
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

  // Targeted cleanup: remove false positive graduations (low SOL reserves from bundler txs)
  app.get('/cleanup-false-positives', (req, res) => cleanupHandler(req, res));
  app.post('/cleanup-false-positives', (req, res) => cleanupHandler(req, res));

  function cleanupHandler(_req: any, res: any) {
    try {
      // Find graduation IDs where sol_raised < 50 (false positives from bundler txs)
      // Real graduations have ~85 SOL. Anything below 50 is either a false positive
      // or a self-graduated scam token with no real liquidity.
      const threshold = 50;
      const falsePositiveIds = db.prepare(`
        SELECT g.id FROM graduations g
        LEFT JOIN graduation_momentum gm ON g.id = gm.graduation_id
        WHERE COALESCE(gm.total_sol_raised, g.final_sol_reserves, 0) < ?
      `).all(threshold) as Array<{ id: number }>;

      const ids = falsePositiveIds.map((r) => r.id);
      if (ids.length === 0) {
        res.json({ status: 'ok', message: 'No false positives found to clean up', removed: 0 });
        return;
      }

      // Delete in dependency order (children first)
      const placeholders = ids.map(() => '?').join(',');
      const tables = ['competition_signals', 'opportunities', 'price_comparisons', 'pool_observations', 'graduation_momentum'];
      let totalDeleted = 0;
      for (const table of tables) {
        const result = db.prepare(`DELETE FROM ${table} WHERE graduation_id IN (${placeholders})`).run(...ids);
        totalDeleted += result.changes;
      }
      const gradResult = db.prepare(`DELETE FROM graduations WHERE id IN (${placeholders})`).run(...ids);
      totalDeleted += gradResult.changes;

      res.json({
        status: 'ok',
        message: `Removed ${ids.length} false positive graduations (sol_raised < ${threshold}) and ${totalDeleted} related records`,
        graduations_removed: ids.length,
        total_records_removed: totalDeleted,
        threshold_sol: threshold,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

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
  // BACKFILL: Recover null bc_velocity_sol_per_min for historical data
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  let backfillRunning = false;
  app.get('/backfill-velocity', async (req, res) => {
    if (backfillRunning) {
      sendJsonOrHtml(req, res, { status: 'already_running', message: 'Backfill is already in progress. Check logs.' });
      return;
    }

    const rpcUrl = process.env.HELIUS_RPC_URL;
    if (!rpcUrl) {
      res.status(500).json({ error: 'HELIUS_RPC_URL not configured' });
      return;
    }

    // Find all rows that need backfill: velocity is null but total_sol_raised exists.
    // Also pull bonding_curve_address — querying the BC (not the mint) reaches the
    // creation tx faster since the BC has far fewer transactions than the mint.
    const candidates = db.prepare(`
      SELECT gm.graduation_id, g.mint, g.bonding_curve_address,
             g.timestamp as grad_timestamp, gm.total_sol_raised, gm.token_age_seconds
      FROM graduation_momentum gm
      JOIN graduations g ON g.id = gm.graduation_id
      WHERE gm.bc_velocity_sol_per_min IS NULL
        AND gm.total_sol_raised > 0
    `).all() as Array<{
      graduation_id: number; mint: string; bonding_curve_address: string | null;
      grad_timestamp: number; total_sol_raised: number; token_age_seconds: number | null;
    }>;

    // Split: rows that already have token_age_seconds can be fixed immediately
    const needsAgeFetch: typeof candidates = [];
    let fixedImmediately = 0;

    for (const row of candidates) {
      if (row.token_age_seconds && row.token_age_seconds > 0) {
        // token_age exists but velocity was never computed — fix it now
        const velocity = (row.total_sol_raised / row.token_age_seconds) * 60;
        db.prepare('UPDATE graduation_momentum SET bc_velocity_sol_per_min = ? WHERE graduation_id = ?')
          .run(+velocity.toFixed(2), row.graduation_id);
        fixedImmediately++;
      } else {
        needsAgeFetch.push(row);
      }
    }

    // Return immediately with status, do RPC work in background
    const summary = {
      status: 'started',
      total_null_velocity: candidates.length,
      fixed_immediately: fixedImmediately,
      needs_rpc_fetch: needsAgeFetch.length,
      message: `Fixed ${fixedImmediately} rows instantly. Fetching age for ${needsAgeFetch.length} rows via RPC in background...`,
    };

    sendJsonOrHtml(req, res, summary);

    if (needsAgeFetch.length === 0) return;

    // Background RPC work — fetch mint creation times
    backfillRunning = true;
    const conn = new Connection(rpcUrl, { commitment: 'confirmed' });
    let recovered = 0;
    let failed = 0;

    (async () => {
      for (const row of needsAgeFetch) {
        try {
          // Prefer bonding curve address — it has far fewer transactions than the mint.
          // Fall back to mint if BC address is not stored (older records).
          const usingBC = !!row.bonding_curve_address;
          const lookupAddress = row.bonding_curve_address || row.mint;
          const lookupPubkey = new PublicKey(lookupAddress);
          let oldestBlockTime: number | null = null;
          let before: string | undefined = undefined;
          let totalSigsScanned = 0;

          for (let page = 0; page < 5; page++) {
            const sigs: Array<{ signature: string; blockTime?: number | null }> =
              await conn.getSignaturesForAddress(lookupPubkey, { limit: 1000, before });
            totalSigsScanned += sigs.length;
            if (sigs.length === 0) break;
            const last: { signature: string; blockTime?: number | null } = sigs[sigs.length - 1];
            if (last.blockTime) oldestBlockTime = last.blockTime;
            if (sigs.length < 1000) break;
            before = last.signature;

            // Rate limit: 100ms between pages
            await new Promise(r => setTimeout(r, 100));
          }

          if (oldestBlockTime === null) {
            failed++;
            logger.warn(
              { graduationId: row.graduation_id, lookupAddress: lookupAddress.slice(0, 8), usingBC, totalSigsScanned },
              'Backfill skip: getSignaturesForAddress returned no blockTime (0 sigs or all null blockTimes)'
            );
            continue;
          }
          if (!row.grad_timestamp) {
            failed++;
            logger.warn({ graduationId: row.graduation_id }, 'Backfill skip: missing grad_timestamp');
            continue;
          }

          // Use minimum 1 second — tokens sniped in the same block as creation have
          // diff=0 (all txns share the same blockTime). They are genuine instant-graduation
          // tokens and get a very high velocity, correctly placing them in the 50+ bucket.
          const tokenAgeSeconds = Math.max(1, row.grad_timestamp - oldestBlockTime);
          if (row.grad_timestamp - oldestBlockTime < 0) {
            failed++;
            logger.warn(
              { graduationId: row.graduation_id, grad_timestamp: row.grad_timestamp, oldestBlockTime, diff: row.grad_timestamp - oldestBlockTime, usingBC, totalSigsScanned },
              'Backfill skip: oldestBlockTime is after graduation timestamp — BC address may be wrong for this token'
            );
            continue;
          }

          const velocity = (row.total_sol_raised / tokenAgeSeconds) * 60;

          db.prepare(
            'UPDATE graduation_momentum SET token_age_seconds = ?, bc_velocity_sol_per_min = ? WHERE graduation_id = ? AND bc_velocity_sol_per_min IS NULL'
          ).run(tokenAgeSeconds, +velocity.toFixed(2), row.graduation_id);
          db.prepare(
            'UPDATE graduations SET token_age_seconds = ? WHERE id = ? AND token_age_seconds IS NULL'
          ).run(tokenAgeSeconds, row.graduation_id);

          recovered++;

          // Rate limit: 200ms between mints to avoid hammering RPC
          await new Promise(r => setTimeout(r, 200));
        } catch (err) {
          failed++;
          logger.warn('Backfill failed for grad %d: %s', row.graduation_id,
            err instanceof Error ? err.message : String(err));
        }
      }

      backfillRunning = false;
      logger.info({ recovered, failed, total: needsAgeFetch.length }, 'Velocity backfill complete');
    })().catch((err) => {
      backfillRunning = false;
      logger.error('Velocity backfill crashed: %s', err instanceof Error ? err.message : String(err));
    });
  });

  // Check backfill status
  app.get('/backfill-velocity/status', (req, res) => {
    const nullCount = (db.prepare(
      'SELECT COUNT(*) as n FROM graduation_momentum WHERE bc_velocity_sol_per_min IS NULL AND total_sol_raised > 0'
    ).get() as any).n;
    const totalWithVelocity = (db.prepare(
      'SELECT COUNT(*) as n FROM graduation_momentum WHERE bc_velocity_sol_per_min IS NOT NULL'
    ).get() as any).n;
    const total = (db.prepare(
      'SELECT COUNT(*) as n FROM graduation_momentum WHERE label IS NOT NULL'
    ).get() as any).n;

    sendJsonOrHtml(req, res, {
      backfill_running: backfillRunning,
      remaining_null_velocity: nullCount,
      has_velocity: totalWithVelocity,
      total_labeled: total,
      velocity_coverage_pct: total > 0 ? +((totalWithVelocity / total) * 100).toFixed(1) : 0,
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // DASHBOARD LANDING PAGE
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  app.get('/dashboard', (req, res) => {
    try {
      const stats = listener ? listener.getStats() : null;
      const uptimeMs = Date.now() - startTime;
      const uptimeMin = Math.floor(uptimeMs / 60000);

      const pipeline = db.prepare(`
        SELECT COUNT(*) as total, COUNT(new_pool_address) as with_pool,
               SUM(observation_complete) as complete, MAX(timestamp) as last_ts
        FROM graduations
      `).get() as any;

      const labels = db.prepare(`
        SELECT label, COUNT(*) as count FROM graduation_momentum
        WHERE label IS NOT NULL GROUP BY label
      `).all() as any[];

      const totalLabeled = labels.reduce((s: number, l: any) => s + l.count, 0);
      const pumpCount = labels.find((l: any) => l.label === 'PUMP')?.count || 0;
      const winRate = totalLabeled > 0 ? (pumpCount / totalLabeled * 100).toFixed(1) : '—';

      // Dynamic best filter — same candidate list as the thesis page, ranked by T+30 profitable rate
      const dashFilterTests = [
        { name: 'bc_age>30min',                   sql: "token_age_seconds > 1800" },
        { name: 'bc_age>10min',                   sql: "token_age_seconds > 600" },
        { name: 'velocity 5-20 + t30 +5-100%',   sql: "bc_velocity_sol_per_min >= 5 AND bc_velocity_sol_per_min < 20 AND pct_t30 >= 5 AND pct_t30 <= 100" },
        { name: 'holders>=10 + t30 +5-100%',      sql: "holder_count >= 10 AND pct_t30 >= 5 AND pct_t30 <= 100" },
        { name: 'bc_velocity<20 + t30 +5-100%',   sql: "bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min < 20 AND pct_t30 >= 5 AND pct_t30 <= 100" },
        { name: 't30 +5-100%',                    sql: "pct_t30 >= 5 AND pct_t30 <= 100" },
        { name: 'top5 < 20%',                     sql: "top5_wallet_pct < 20" },
        { name: 'dev < 5%',                       sql: "dev_wallet_pct IS NOT NULL AND dev_wallet_pct < 5" },
        { name: 'buy_ratio>0.7 + t30 +5-100%',    sql: "buy_pressure_buy_ratio > 0.7 AND pct_t30 >= 5 AND pct_t30 <= 100" },
        { name: 'buyers>=5 + t30 +5-100%',         sql: "buy_pressure_unique_buyers >= 5 AND pct_t30 >= 5 AND pct_t30 <= 100" },
        { name: 'whale<0.5 + t30 +5-100%',         sql: "buy_pressure_whale_pct < 0.5 AND pct_t30 >= 5 AND pct_t30 <= 100" },
        { name: 'vel 5-20 + buyers>=5',             sql: "bc_velocity_sol_per_min >= 5 AND bc_velocity_sol_per_min < 20 AND buy_pressure_unique_buyers >= 5 AND pct_t30 >= 5 AND pct_t30 <= 100" },
      ];
      let bestFilterName = '—';
      let bestWr = '—';
      let bestWrN = 0;
      for (const ft of dashFilterTests) {
        const r = db.prepare(`
          SELECT
            SUM(CASE WHEN pct_t30 IS NOT NULL AND pct_t300 IS NOT NULL
              AND (1.0 + pct_t300/100.0) / (1.0 + pct_t30/100.0) > 1.0
              THEN 1 ELSE 0 END) as profitable_t30,
            COUNT(CASE WHEN pct_t30 IS NOT NULL AND pct_t300 IS NOT NULL THEN 1 END) as n_with_t30
          FROM graduation_momentum
          WHERE label IS NOT NULL AND ${ft.sql}
        `).get() as any;
        if (r.n_with_t30 >= 3) {
          const rate = +(r.profitable_t30 / r.n_with_t30 * 100).toFixed(1);
          if (bestWr === '—' || rate > +bestWr) {
            bestWr = rate.toFixed(1);
            bestWrN = r.n_with_t30;
            bestFilterName = ft.name;
          }
        }
      }

      const lastGradAgo = pipeline.last_ts ? Math.floor(Date.now() / 1000) - pipeline.last_ts : null;
      const status = listenerStatus === 'running' ? 'RUNNING' : 'ERROR';
      const statusColor = status === 'RUNNING' ? '#4ade80' : '#ef4444';

      const navHtml = NAV_LINKS.map(l =>
        l.path === '/dashboard' ? `<a class="nav-active">${l.label}</a>` : `<a href="${l.path}">${l.label}</a>`
      ).join('');

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Graduation Research Dashboard</title>
<style>
  body{margin:0;background:#111;color:#e0e0e0;font-family:monospace;font-size:13px}
  nav{position:sticky;top:0;z-index:10;background:#1a1a2e;padding:8px 12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #333}
  nav a{color:#94a3b8;text-decoration:none;padding:5px 12px;border-radius:4px;font-size:12px;cursor:pointer;transition:background .15s}
  nav a:hover{background:#334155;color:#e2e8f0}
  nav .nav-active{background:#2563eb;color:#fff;pointer-events:none}
  nav .title{color:#60a5fa;font-weight:bold;font-size:13px;margin-right:8px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;padding:16px}
  .card{background:#1e1e2e;border:1px solid #333;border-radius:8px;padding:16px}
  .card h3{margin:0 0 12px;color:#60a5fa;font-size:14px;font-weight:600}
  .stat{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #222}
  .stat .label{color:#94a3b8}.stat .value{color:#e2e8f0;font-weight:600}
  .stat .value.green{color:#4ade80}.stat .value.red{color:#ef4444}.stat .value.yellow{color:#facc15}
  .links{display:flex;flex-direction:column;gap:8px}
  .links a{display:flex;justify-content:space-between;align-items:center;background:#262640;border:1px solid #333;border-radius:6px;padding:10px 14px;color:#e2e8f0;text-decoration:none;transition:background .15s}
  .links a:hover{background:#334155}
  .links a .desc{color:#94a3b8;font-size:11px}
  .links a .arrow{color:#60a5fa}
  .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
</style></head><body>
<nav><span class="title">Graduation Arb Research</span>${navHtml}</nav>
<div class="grid">
  <div class="card">
    <h3>Bot Status</h3>
    <div class="stat"><span class="label">Status</span><span class="value" style="color:${statusColor}">${status}</span></div>
    <div class="stat"><span class="label">Uptime</span><span class="value">${Math.floor(uptimeMin / 60)}h ${uptimeMin % 60}m</span></div>
    <div class="stat"><span class="label">Last Graduation</span><span class="value">${lastGradAgo ? lastGradAgo + 's ago' : '—'}</span></div>
    <div class="stat"><span class="label">WS Connected</span><span class="value ${stats?.wsConnected ? 'green' : 'red'}">${stats?.wsConnected ? 'YES' : 'NO'}</span></div>
  </div>
  <div class="card">
    <h3>Detection Pipeline</h3>
    <div class="stat"><span class="label">Candidates</span><span class="value">${stats?.totalCandidatesDetected ?? '—'}</span></div>
    <div class="stat"><span class="label">Verified</span><span class="value green">${stats?.totalVerifiedGraduations ?? '—'}</span></div>
    <div class="stat"><span class="label">False Positives</span><span class="value red">${stats?.totalFalsePositives ?? '—'}</span></div>
    <div class="stat"><span class="label">Vault Extractions</span><span class="value">${stats?.totalVaultExtractions ?? '—'} / ${stats?.totalVerifiedGraduations ?? '—'}</span></div>
  </div>
  <div class="card">
    <h3>Thesis Scorecard</h3>
    <div class="stat"><span class="label">Total Labeled</span><span class="value">${totalLabeled}</span></div>
    <div class="stat"><span class="label">PUMP / DUMP</span><span class="value">${pumpCount} / ${labels.find((l: any) => l.label === 'DUMP')?.count || 0}</span></div>
    <div class="stat"><span class="label">Raw Win Rate (T+0)</span><span class="value ${+winRate > 50 ? 'green' : 'yellow'}">${winRate}%</span></div>
    <div class="stat"><span class="label">Best Filter T+30 Profit%</span><span class="value ${+bestWr > 50 ? 'green' : 'yellow'}">${bestWr}% (n=${bestWrN}) [${bestFilterName}]</span></div>
  </div>
  <div class="card">
    <h3>Data Collection</h3>
    <div class="stat"><span class="label">Total Graduations</span><span class="value">${pipeline.total}</span></div>
    <div class="stat"><span class="label">With Pool</span><span class="value">${pipeline.with_pool}</span></div>
    <div class="stat"><span class="label">Observations Done</span><span class="value">${pipeline.complete}</span></div>
    <div class="stat"><span class="label">Unlabeled</span><span class="value">${pipeline.total - totalLabeled - (labels.find((l: any) => l.label === 'STABLE')?.count || 0)}</span></div>
  </div>
  <div class="card" style="grid-column:1/-1">
    <h3>Quick Links</h3>
    <div class="links">
      <a href="/thesis"><div><div>Thesis & Scorecard</div><div class="desc">Win rates, best filters, momentum signals, last 10 graduations</div></div><span class="arrow">&rarr;</span></a>
      <a href="/filter-analysis"><div><div>Filter Analysis</div><div class="desc">All filter combos, stop-loss simulation, drawdown analysis, trading readiness</div></div><span class="arrow">&rarr;</span></a>
      <a href="/tokens?label=PUMP&min_sol=80"><div><div>Token Browser</div><div class="desc">Browse individual tokens with links to Solscan and DexScreener</div></div><span class="arrow">&rarr;</span></a>
      <a href="/health"><div><div>Health & Diagnostics</div><div class="desc">Listener stats, RPC metrics, vault extraction details</div></div><span class="arrow">&rarr;</span></a>
      <a href="/data"><div><div>Raw Research Data</div><div class="desc">All graduations, pool observations, price comparisons, opportunities</div></div><span class="arrow">&rarr;</span></a>
      <a href="/raydium-check"><div><div>DEX Listing Check</div><div class="desc">Where tokens land — PumpSwap, Raydium, Meteora via DexScreener</div></div><span class="arrow">&rarr;</span></a>
      <a href="/cleanup-false-positives"><div><div>Cleanup False Positives</div><div class="desc">Remove legacy low-SOL entries from database (safe, one-time)</div></div><span class="arrow">&rarr;</span></a>
    </div>
  </div>
</div>
</body></html>`);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Redirect root to dashboard
  app.get('/', (_req, res) => res.redirect('/dashboard'));

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

      const botStatus = listenerStatus === 'running' ? 'RUNNING' : 'ERROR';

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

      // ── BEST FILTER (pick highest T+30 profitable rate) ──
      let bestFilter: { name: string; rule: string; win_rate: number; t30_profitable_rate: number | null; t30_avg_return: number | null; sample_size: number } | null = null;
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
          // bc_age filters — data shows bc_age>30min gives 51.7% T+30 profitable at n=143
          { name: 'bc_age > 10min', sql: "token_age_seconds > 600" },
          { name: 'bc_age > 30min', sql: "token_age_seconds > 1800" },
          { name: 'bc_age > 1hr',   sql: "token_age_seconds > 3600" },
          // T+30 momentum signal — the v2 thesis signal
          { name: 't30 +5% to +100%', sql: "pct_t30 IS NOT NULL AND pct_t30 >= 5 AND pct_t30 <= 100" },
          { name: 'holders>=10 AND t30 +5% to +100%', sql: "holder_count >= 10 AND pct_t30 IS NOT NULL AND pct_t30 >= 5 AND pct_t30 <= 100" },
          { name: 'bc_age>10m AND t30 +5% to +100%', sql: "token_age_seconds > 600 AND pct_t30 IS NOT NULL AND pct_t30 >= 5 AND pct_t30 <= 100" },
          { name: 'bc_velocity<20 AND t30 +5% to +100%', sql: "bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min < 20 AND pct_t30 >= 5 AND pct_t30 <= 100" },
          { name: 'velocity 5-20 AND t30 +5% to +100%', sql: "bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min >= 5 AND bc_velocity_sol_per_min < 20 AND pct_t30 >= 5 AND pct_t30 <= 100" },
          { name: 'liquidity>100 AND t30 +5% to +100%', sql: "liquidity_sol_t30 IS NOT NULL AND liquidity_sol_t30 > 100 AND pct_t30 >= 5 AND pct_t30 <= 100" },
        ];
        for (const ft of filterTests) {
          const r = db.prepare(`
            SELECT
              COUNT(*) as total,
              SUM(CASE WHEN label = 'PUMP' THEN 1 ELSE 0 END) as pumps,
              ROUND(AVG(CASE WHEN pct_t30 IS NOT NULL AND pct_t300 IS NOT NULL
                THEN (1.0 + pct_t300/100.0) / (1.0 + pct_t30/100.0) * 100.0 - 100.0
                END), 1) as avg_return_t30,
              SUM(CASE WHEN pct_t30 IS NOT NULL AND pct_t300 IS NOT NULL
                AND (1.0 + pct_t300/100.0) / (1.0 + pct_t30/100.0) > 1.0
                THEN 1 ELSE 0 END) as profitable_t30,
              COUNT(CASE WHEN pct_t30 IS NOT NULL AND pct_t300 IS NOT NULL THEN 1 END) as n_with_t30
            FROM graduation_momentum
            WHERE label IS NOT NULL AND ${ft.sql}
          `).get() as any;
          if (r.total >= 3) {
            const wr = +(r.pumps / r.total * 100).toFixed(1);
            const t30ProfRate = r.n_with_t30 > 0 ? +(r.profitable_t30 / r.n_with_t30 * 100).toFixed(1) : null;
            const t30AvgReturn = r.avg_return_t30;
            // Rank by T+30 profitable rate (the real trading metric); fall back to win_rate
            const rankScore = t30ProfRate ?? wr;
            const bestScore = bestFilter
              ? (bestFilter.t30_profitable_rate ?? bestFilter.win_rate)
              : -Infinity;
            if (rankScore > bestScore) {
              bestFilter = { name: ft.name, rule: ft.sql, win_rate: wr, t30_profitable_rate: t30ProfRate, t30_avg_return: t30AvgReturn, sample_size: r.total };
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
          g.new_pool_address IS NOT NULL as has_pool,
          m.buy_pressure_unique_buyers as buyers,
          ROUND(m.buy_pressure_buy_ratio, 2) as buy_ratio,
          ROUND(m.buy_pressure_whale_pct, 2) as whale_pct,
          m.buy_pressure_trade_count as trades
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

      // ── T+30 MOMENTUM SIGNAL SUMMARY (v2 thesis) ──
      // Reports T+30-entry profitability: "if I enter at T+30, does price exceed my entry by T+300?"
      const t30Signal = db.prepare(`
        SELECT
          COUNT(*) as n,
          SUM(CASE WHEN label='PUMP' THEN 1 ELSE 0 END) as pump,
          SUM(CASE WHEN label='DUMP' THEN 1 ELSE 0 END) as dump,
          ROUND(AVG(pct_t300), 1) as avg_t300,
          ROUND(AVG(CASE WHEN pct_t30 IS NOT NULL AND pct_t300 IS NOT NULL
            THEN (1.0 + pct_t300/100.0) / (1.0 + pct_t30/100.0) * 100.0 - 100.0
            END), 1) as avg_return_from_t30,
          SUM(CASE WHEN pct_t30 IS NOT NULL AND pct_t300 IS NOT NULL
            AND (1.0 + pct_t300/100.0) / (1.0 + pct_t30/100.0) > 1.0
            THEN 1 ELSE 0 END) as profitable_from_t30,
          COUNT(CASE WHEN pct_t30 IS NOT NULL AND pct_t300 IS NOT NULL THEN 1 END) as n_with_t30
        FROM graduation_momentum
        WHERE label IS NOT NULL
          AND pct_t30 IS NOT NULL AND pct_t30 >= 5 AND pct_t30 <= 100
          AND holder_count >= 10
      `).get() as any;
      // t30ProfitableRate: % of trades profitable when entering at T+30 (the real trading question)
      const t30ProfitableRate = t30Signal.n_with_t30 > 0
        ? +(t30Signal.profitable_from_t30 / t30Signal.n_with_t30 * 100).toFixed(1)
        : null;
      // Keep backward-compat label-based win rate for context
      const t30WinRate = t30Signal.n > 0 ? +(t30Signal.pump / t30Signal.n * 100).toFixed(1) : null;

      // ── VERDICT (T+30 entry basis) ──
      const bestT30Rate = bestFilter?.t30_profitable_rate ?? null;
      const verdict = totalLabeled < 10 ? `COLLECTING DATA — ${totalLabeled}/30 labeled (${samplesRemaining} more needed)` :
        totalLabeled < 30 ? `COLLECTING — ${totalLabeled}/30 labeled, raw win rate ${rawWinRate}%, T+30 profitable rate ${t30ProfitableRate ?? '?'}% (n=${t30Signal.n_with_t30})` :
        (t30ProfitableRate !== null && t30ProfitableRate > 60) ? `THESIS VALID — ${t30ProfitableRate}% profitable from T+30 entry (n=${t30Signal.n_with_t30}), avg return ${t30Signal.avg_return_from_t30}%` :
        (bestT30Rate !== null && bestT30Rate > 51) ? `SIGNAL FOUND — best filter [${bestFilter!.name}] shows ${bestT30Rate}% T+30 profitable rate, avg return ${bestFilter!.t30_avg_return}% (n=${bestFilter!.sample_size})` :
        (t30ProfitableRate !== null && t30ProfitableRate >= 40) ? `MOMENTUM EDGE — T+30 profitable rate ${t30ProfitableRate}% (n=${t30Signal.n_with_t30}), avg return ${t30Signal.avg_return_from_t30}% — below 51% target, testing stop-loss to flip EV` :
        (rawWinRate !== null && rawWinRate > 40) ? `MARGINAL — ${rawWinRate}% raw PUMP label rate, T+30 profitable ${t30ProfitableRate ?? '?'}% — filters may help` :
        `WEAK — ${rawWinRate}% raw win rate, T+30 profitable rate ${t30ProfitableRate ?? '?'}% (n=${t30Signal.n_with_t30})`;

      // ── CODE VERSION ──
      const codeVersion = {
        version: 'momentum-v4b-dashboard-fix',
        thesis: 'bc_age>30min shows 51.7% T+30 profitable rate, +6.7% avg return, n=143 — best EV signal so far. velocity 5-20 + t30+5-100% shows 55.9% T+30 profitable rate but avg_return=-0.6% before stop-loss; with 10-20% SL turns to +7-9% avg return.',
        last_change: 'Fixed dashboard Best Filter card: was hardcoded to bc_age>10min (showing misleading 42.4%). Now dynamically selects best filter from ranked candidate list. Added bc_age>30min and bc_age>10min to scorecard filterTests (were missing — bc_age>30min should now win as best filter at 51.7%). Dashboard card now shows filter name alongside rate.',
        watch_for: 'best_filter on scorecard should now show bc_age>30min at ~51.7% (or velocity 5-20+t30 at 55.9% if it wins). Dashboard Best Filter card should show the same filter name. If they still differ, there is a bug in one of the two candidate lists.',
      };

      // Detection pipeline stats (shows how many raw events → real graduations)
      const detectionStats = listenerStats ? {
        raw_log_events: listenerStats.totalLogsReceived,
        candidates_detected: listenerStats.totalCandidatesDetected,
        verified_graduations: listenerStats.totalVerifiedGraduations,
        false_positives: listenerStats.totalFalsePositives,
        bundler_false_positives: listenerStats.totalBundlerFalsePositives,
        false_positive_rate_pct: listenerStats.totalCandidatesDetected > 0
          ? +((listenerStats.totalFalsePositives / listenerStats.totalCandidatesDetected) * 100).toFixed(1)
          : 0,
        mint_extraction_fails: listenerStats.totalMintExtractionFails,
        vault_extractions: listenerStats.totalVaultExtractions,
        vault_extraction_fails: listenerStats.totalVaultExtractionFails,
      } : null;

      const thesisData = {
        // ── HEADER ──
        bot_status: botStatus,
        uptime: `${uptimeHrs}h ${uptimeMin % 60}m`,
        total_graduations: pipeline.total_graduations,
        with_complete_t300: completedWithT300.count,
        last_graduation_seconds_ago: lastGradSecondsAgo,

        // ── DETECTION PIPELINE ──
        detection_pipeline: detectionStats,

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

        // ── V2 MOMENTUM SIGNAL ──
        t30_momentum_signal: {
          filter: 'holders>=10 AND t30 +5% to +100%',
          n: t30Signal.n,
          n_with_t30_data: t30Signal.n_with_t30,
          pump_label_count: t30Signal.pump,
          dump_label_count: t30Signal.dump,
          // T+0 label-based win rate (kept for historical context — NOT the trading metric)
          win_rate_from_t0_pct: t30WinRate,
          // T+30 entry metrics — the real trading question
          t30_profitable_rate_pct: t30ProfitableRate,
          t30_avg_return_pct: t30Signal.avg_return_from_t30,
          avg_t300_pct: t30Signal.avg_t300,
          note: 'Key signal for v2 thesis. t30_profitable_rate_pct = % of entries profitable when buying at T+30 price and holding to T+300.',
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
          last_grad_seconds_ago: lastGradSecondsAgo,
          listener_connected: listenerStats?.wsConnected ?? false,
        },

        // ── PATH DATA SUMMARY ──
        path_data_summary: (() => {
          const complete5s = (db.prepare(
            'SELECT COUNT(*) as n FROM graduation_momentum WHERE pct_t5 IS NOT NULL AND pct_t60 IS NOT NULL'
          ).get() as any)?.n ?? 0;

          // Best entry time: T+N with highest avg return at 10%SL/50%TP (n>=20)
          let bestTime: string | null = null;
          let bestRet: number | null = null;
          const SL_G = 0.20, TP_G = 0.10, DEF_COST = 3.0;
          const entryTimes = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60] as const;
          const checkCols = ['pct_t5','pct_t10','pct_t15','pct_t20','pct_t25','pct_t30',
            'pct_t35','pct_t40','pct_t45','pct_t50','pct_t55','pct_t60',
            'pct_t90','pct_t120','pct_t150','pct_t180','pct_t240'] as const;
          const allSim = db.prepare(`
            SELECT round_trip_slippage_pct,
                   pct_t5, pct_t10, pct_t15, pct_t20, pct_t25, pct_t30,
                   pct_t35, pct_t40, pct_t45, pct_t50, pct_t55, pct_t60,
                   pct_t90, pct_t120, pct_t150, pct_t180, pct_t240, pct_t300
            FROM graduation_momentum
            WHERE label IS NOT NULL AND pct_t5 IS NOT NULL
          `).all() as any[];
          for (const t of entryTimes) {
            const ecol = `pct_t${t}`;
            let total = 0, n = 0;
            for (const r of allSim) {
              const ep: number | null = r[ecol];
              if (ep == null || ep < 5 || ep > 100) continue;
              const openM = 1 + ep / 100;
              const slLvl = (openM * 0.9 - 1) * 100;
              const tpLvl = (openM * 1.5 - 1) * 100;
              const cost: number = r.round_trip_slippage_pct ?? DEF_COST;
              const eIdx = checkCols.indexOf(ecol as any);
              let exit: number | null = null;
              for (let ci = eIdx + 1; ci < checkCols.length; ci++) {
                const cv: number | null = r[checkCols[ci]];
                if (cv == null) continue;
                if (cv <= slLvl) { exit = -(10 * (1 + SL_G)); break; }
                if (cv >= tpLvl) { exit = 50 * (1 - TP_G); break; }
              }
              if (exit == null) exit = r.pct_t300 != null ? ((1 + r.pct_t300 / 100) / (1 + ep / 100) - 1) * 100 : -100;
              total += exit - cost;
              n++;
            }
            if (n >= 20) {
              const avg = +(total / n).toFixed(2);
              if (bestRet === null || avg > bestRet) { bestRet = avg; bestTime = `T+${t}s`; }
            }
          }
          return { complete_5s_count: complete5s, best_entry_time: bestTime, best_entry_avg_return: bestRet };
        })(),

        // ── CODE VERSION ──
        code_version: codeVersion,
      };

      const wantHtml = (req.headers.accept || '').includes('text/html');
      if (wantHtml) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderThesisHtml(thesisData));
      } else {
        res.json(thesisData);
      }
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
            ROUND(AVG(pct_t300), 1)         as avg_t300,
            ROUND(AVG(CASE WHEN pct_t30 IS NOT NULL AND pct_t300 IS NOT NULL
              THEN (1.0 + pct_t300/100.0) / (1.0 + pct_t30/100.0) * 100.0 - 100.0
              END), 1) as avg_return_t30,
            SUM(CASE WHEN pct_t30 IS NOT NULL AND pct_t300 IS NOT NULL
              AND (1.0 + pct_t300/100.0) / (1.0 + pct_t30/100.0) > 1.0
              THEN 1 ELSE 0 END) as profitable_t30,
            COUNT(CASE WHEN pct_t30 IS NOT NULL AND pct_t300 IS NOT NULL
              THEN 1 END) as n_with_t30
          FROM graduation_momentum WHERE ${where}
        `).get() as any;
        const t30ProfRate = row.n_with_t30 > 0 ? +(row.profitable_t30 / row.n_with_t30 * 100).toFixed(1) : null;
        return {
          filter: label,
          n: row.total,
          pump: row.pump,
          dump: row.dump,
          stable: row.stable,
          win_rate_pct: winRate(row.pump, row.total),
          t30_profitable_rate_pct: t30ProfRate,
          t30_avg_return_pct: row.avg_return_t30,
          n_with_t30: row.n_with_t30,
          avg_sol: row.avg_sol,
          avg_holders: row.avg_holders,
          avg_top5_pct: row.avg_top5,
          avg_t300_pct: row.avg_t300,
        };
      };

      // REMOVED: solBuckets query (sol_raised_distribution confirmed no signal — single 80-86 bucket)

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

      // REMOVED: contRow query (momentum_continuation confirmed 47%, not useful)

      const dupes = db.prepare(
        `SELECT mint, COUNT(*) as cnt FROM graduations GROUP BY mint HAVING cnt > 1`
      ).all() as any[];

      // T+30 entry economics helper — runs for any (minPct, maxPct) threshold
      // Formula: ((1 + pct_t300/100) / (1 + pct_t30/100) - 1) * 100
      const ECON_EXPR = `(1.0 + pct_t300 / 100.0) / (1.0 + pct_t30 / 100.0) * 100.0 - 100.0`;
      const PROF_EXPR = `(1.0 + pct_t300 / 100.0) / (1.0 + pct_t30 / 100.0) > 1.0`;

      // Round-trip trading cost fallback (used for rows that pre-date slippage measurement).
      // Per-token round_trip_slippage_pct is used where available (2x entry slippage from actual pool data).
      const ROUND_TRIP_COST_PCT = 3.0;
      const COST_SCENARIOS = [
        { label: 'optimistic',  cost: 2.0 },
        { label: 'realistic',   cost: 3.5 },
        { label: 'pessimistic', cost: 5.0 },
      ];

      const runT30Econ = (minPct: number, maxPct: number) => {
        const base = `pct_t30 IS NOT NULL AND pct_t300 IS NOT NULL AND pct_t30 >= ${minPct} AND pct_t30 <= ${maxPct}`;

        const SLIPPAGE_EXPR = `COALESCE(round_trip_slippage_pct, ${ROUND_TRIP_COST_PCT})`;

        const allRow = db.prepare(`
          SELECT COUNT(*) as n,
            ROUND(AVG(${ECON_EXPR}), 1) as avg_return_from_t30,
            SUM(CASE WHEN ${PROF_EXPR} THEN 1 ELSE 0 END) as profitable_from_t30,
            ROUND(AVG(pct_t30),  1) as avg_t30_gain,
            ROUND(AVG(pct_t300), 1) as avg_t300_gain,
            ROUND(AVG(${SLIPPAGE_EXPR}), 2) as avg_round_trip_cost
          FROM graduation_momentum WHERE ${base}
        `).get() as any;

        const hqRow = db.prepare(`
          SELECT COUNT(*) as n,
            ROUND(AVG(${ECON_EXPR}), 1) as avg_return_from_t30,
            SUM(CASE WHEN ${PROF_EXPR} THEN 1 ELSE 0 END) as profitable_from_t30,
            ROUND(AVG(pct_t30),  1) as avg_t30_gain,
            ROUND(AVG(pct_t300), 1) as avg_t300_gain,
            ROUND(AVG(${SLIPPAGE_EXPR}), 2) as avg_round_trip_cost
          FROM graduation_momentum WHERE ${base} AND total_sol_raised >= 80
        `).get() as any;

        const byLabel = db.prepare(`
          SELECT label, COUNT(*) as n,
            ROUND(AVG(${ECON_EXPR}), 1) as avg_return_from_t30,
            SUM(CASE WHEN ${PROF_EXPR} THEN 1 ELSE 0 END) as profitable_from_t30,
            ROUND(AVG(pct_t30),  1) as avg_t30_gain,
            ROUND(AVG(pct_t300), 1) as avg_t300_gain,
            ROUND(AVG(${SLIPPAGE_EXPR}), 2) as avg_round_trip_cost
          FROM graduation_momentum WHERE ${base} GROUP BY label
        `).all() as any[];

        const fmt = (r: any) => {
          // Use measured avg round-trip cost for this cohort; fall back to constant for old data
          const costPct: number = r.avg_round_trip_cost ?? ROUND_TRIP_COST_PCT;
          return {
            n: r.n,
            avg_t30_gain_pct:            r.avg_t30_gain,
            avg_t300_gain_pct:           r.avg_t300_gain,
            avg_return_from_t30_pct:     r.avg_return_from_t30,
            profitable_from_t30:         r.profitable_from_t30,
            profitable_rate_pct:         r.n > 0 ? +(r.profitable_from_t30 / r.n * 100).toFixed(1) : null,
            avg_round_trip_cost_pct:     +costPct.toFixed(2),
            cost_adjusted_return_pct:    r.avg_return_from_t30 != null ? +(r.avg_return_from_t30 - costPct).toFixed(1) : null,
            cost_adjusted_ev_positive:   r.avg_return_from_t30 != null ? (r.avg_return_from_t30 - costPct) > 0 : null,
            cost_scenarios:              COST_SCENARIOS.map(s => ({
              label:          s.label,
              cost_pct:       s.cost,
              net_return_pct: r.avg_return_from_t30 != null ? +(r.avg_return_from_t30 - s.cost).toFixed(1) : null,
              ev_positive:    r.avg_return_from_t30 != null ? (r.avg_return_from_t30 - s.cost) > 0 : null,
            })),
          };
        };

        return {
          threshold: `t30 between +${minPct}% and +${maxPct}%`,
          all_cohort:       fmt(allRow),
          sol_gte_80_cohort: fmt(hqRow),
          by_label: byLabel.map((r: any) => ({ label: r.label, ...fmt(r) })),
        };
      };

      const filterData = {
        generated_at: new Date().toISOString(),

        // ── REMOVED: sol_raised_filters, holder_filters, top5_filters ───
        // All confirmed no-signal at n=630+. Data still in DB for future queries.

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
          runFilter('t30 between -10% and +100%',         'pct_t30 >= -10 AND pct_t30 <= 100'),
        ],

        // Only velocity, liquidity, and bc_age combo filters (non-velocity combos confirmed dead)
        combination_filters: [
          // bc_age + t30 combos
          runFilter('bc_age>10min AND t30 +5% to +100%',                      'token_age_seconds>600 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('bc_age>10min AND holders>=10 AND t30 +5% to +100%',      'token_age_seconds>600 AND holder_count>=10 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('bc_age>30min AND t30 +5% to +100%',                      'token_age_seconds>1800 AND pct_t30>=5 AND pct_t30<=100'),
          // ── VELOCITY FILTERS ─────────────────────────────────────────
          runFilter('bc_velocity<10 sol/min AND t30 +5% to +100%',           'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min<10 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('bc_velocity<20 sol/min AND t30 +5% to +100%',           'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min<20 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('bc_velocity<50 sol/min AND t30 +5% to +100%',           'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min<50 AND pct_t30>=5 AND pct_t30<=100'),
          // Sweet spot filters
          runFilter('velocity 5-20 sol/min AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<20 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('velocity 5-50 sol/min AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<50 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('velocity 10-50 sol/min AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min>=10 AND bc_velocity_sol_per_min<50 AND pct_t30>=5 AND pct_t30<=100'),
          // Sweet spot + other signals
          runFilter('velocity 5-20 AND holders>=10 AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<20 AND holder_count>=10 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('velocity 5-20 AND bc_age>10m AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<20 AND token_age_seconds>600 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('velocity 5-20 AND liquidity>100 AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<20 AND liquidity_sol_t30>100 AND pct_t30>=5 AND pct_t30<=100'),
          // ── LIQUIDITY FILTERS ─────────────────────────────────────────
          runFilter('liquidity>100 SOL AND t30 +5% to +100%',               'liquidity_sol_t30 IS NOT NULL AND liquidity_sol_t30>100 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('liquidity>150 SOL AND t30 +5% to +100%',               'liquidity_sol_t30 IS NOT NULL AND liquidity_sol_t30>150 AND pct_t30>=5 AND pct_t30<=100'),
          // ── FULL STACK COMBOS ─────────────────────────────────────────
          runFilter('velocity<20 AND holders>=10 AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min<20 AND holder_count>=10 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('velocity<20 AND bc_age>10m AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min<20 AND token_age_seconds>600 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('velocity<20 AND liquidity>100 AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min<20 AND liquidity_sol_t30>100 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('velocity<20 AND holders>=10 AND bc_age>10m AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min<20 AND holder_count>=10 AND token_age_seconds>600 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('velocity<20 AND liquidity>100 AND bc_age>10m AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min<20 AND liquidity_sol_t30>100 AND token_age_seconds>600 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('velocity<20 AND liquidity>100 AND holders>=10 AND bc_age>10m AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min<20 AND liquidity_sol_t30>100 AND holder_count>=10 AND token_age_seconds>600 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('velocity<50 AND holders>=10 AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min<50 AND holder_count>=10 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('velocity<50 AND liquidity>100 AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min<50 AND liquidity_sol_t30>100 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('velocity<50 AND bc_age>10m AND holders>=10 AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min<50 AND token_age_seconds>600 AND holder_count>=10 AND pct_t30>=5 AND pct_t30<=100'),
          // ── BUY PRESSURE QUALITY FILTERS ─────────────────────────────
          runFilter('buyers>=5 AND t30 +5% to +100%',
            'buy_pressure_unique_buyers>=5 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('buyers>=10 AND t30 +5% to +100%',
            'buy_pressure_unique_buyers>=10 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('buy_ratio>0.6 AND t30 +5% to +100%',
            'buy_pressure_buy_ratio>0.6 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('buy_ratio>0.7 AND t30 +5% to +100%',
            'buy_pressure_buy_ratio>0.7 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('whale_pct<0.5 AND t30 +5% to +100%',
            'buy_pressure_whale_pct<0.5 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('whale_pct<0.3 AND t30 +5% to +100%',
            'buy_pressure_whale_pct<0.3 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('trades>=10 AND t30 +5% to +100%',
            'buy_pressure_trade_count>=10 AND pct_t30>=5 AND pct_t30<=100'),
          // Buy pressure + velocity combos
          runFilter('vel 5-20 AND buyers>=5 AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<20 AND buy_pressure_unique_buyers>=5 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('vel 5-20 AND buy_ratio>0.6 AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<20 AND buy_pressure_buy_ratio>0.6 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('vel 5-20 AND whale<0.5 AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<20 AND buy_pressure_whale_pct<0.5 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('vel 5-20 AND buyers>=5 AND whale<0.5 AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<20 AND buy_pressure_unique_buyers>=5 AND buy_pressure_whale_pct<0.5 AND pct_t30>=5 AND pct_t30<=100'),
        ],

        // REMOVED: momentum_continuation (47%, not useful)

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

        // ── STOP-LOSS SIMULATION ──────────────────────────────────────────────
        // If you enter at T+30 price and apply a stop-loss, does EV turn positive?
        // Uses T+60 and T+120 checkpoints to approximate stop triggers.
        // Limitation: intra-checkpoint dips are invisible → slightly optimistic.
        stop_loss_simulation: (() => {
          // simulate(minPct, maxPct, stopPct, extraWhere?, label?) — enter at T+30, stop out at stopPct loss
          // Uses granular checkpoints T+40/T+50/T+60/T+90/T+120/T+150/T+180/T+240 for accurate stop detection
          const stopCheckpoints = ['pct_t40', 'pct_t50', 'pct_t60', 'pct_t90', 'pct_t120', 'pct_t150', 'pct_t180', 'pct_t240'] as const;
          // Gap penalties for thin-pool execution reality
          const SL_GAP_PENALTY_PCT = 0.20; // SL fills 20% worse than target (adverse gap-through)
          const TP_GAP_PENALTY_PCT = 0.10; // TP fills 10% worse than target (fast spike, partial fill)
          const simulate = (minPct: number, maxPct: number, stopPct: number, extraWhere?: string, label?: string) => {
            const whereExtra = extraWhere ? ` AND ${extraWhere}` : '';
            const rows = db.prepare(`
              SELECT label, pct_t30, ${stopCheckpoints.join(', ')}, pct_t300,
                     COALESCE(round_trip_slippage_pct, ${ROUND_TRIP_COST_PCT}) as cost_pct
              FROM graduation_momentum
              WHERE pct_t30 >= ${minPct} AND pct_t30 <= ${maxPct}
                AND pct_t30 IS NOT NULL${whereExtra}
            `).all() as any[];

            if (rows.length === 0) return null;

            let totalReturn = 0, stopped = 0, profitable = 0, rugged = 0, totalCost = 0;
            for (const r of rows) {
              const stopLevelPct = ((1 + r.pct_t30 / 100) * (1 - stopPct / 100) - 1) * 100;
              let exitReturn: number;
              let wasStoppedOut = false;

              for (const cp of stopCheckpoints) {
                if (r[cp] != null && r[cp] <= stopLevelPct) {
                  exitReturn = -(stopPct * (1 + SL_GAP_PENALTY_PCT)); // adverse gap on stop
                  stopped++;
                  wasStoppedOut = true;
                  break;
                }
              }

              if (!wasStoppedOut) {
                // null pct_t300 = pool drained / token rugged before T+300 — worst case -100%
                if (r.pct_t300 != null) {
                  exitReturn = ((1 + r.pct_t300 / 100) / (1 + r.pct_t30 / 100) - 1) * 100;
                } else {
                  exitReturn = -100;
                  rugged++;
                }
              }
              // Subtract per-token measured round-trip slippage (falls back to constant for old rows)
              exitReturn! -= r.cost_pct;
              totalCost += r.cost_pct;
              totalReturn += exitReturn!;
              if (exitReturn! > 0) profitable++;
            }

            const n = rows.length;
            const avgReturn = totalReturn / n; // already cost-adjusted
            const avgCostUsed = totalCost / n;
            return {
              strategy: label || `t30 +${minPct}% to +${maxPct}%`,
              stop_loss_pct: stopPct,
              n,
              stopped_count: stopped,
              stopped_pct: +(stopped / n * 100).toFixed(1),
              rugged_count: rugged,
              rugged_pct: +(rugged / n * 100).toFixed(1),
              profitable_count: profitable,
              profitable_rate_pct: +(profitable / n * 100).toFixed(1),
              avg_return_pct: +avgReturn.toFixed(1),
              ev_positive: avgReturn > 0,
              avg_cost_per_trade_pct: +avgCostUsed.toFixed(2),
              costs_included: true,
              stop_gap_penalty: '20% (modeled gap-through on stop execution)',
              null_t300_treatment: 'worst-case -100% (pool drained / rug)',
            };
          };

          // simulateWithTP: same as simulate but exits early when price hits take-profit level.
          // At each checkpoint, stop-loss is checked first (conservative), then take-profit.
          // simulateWithTP: same SL/TP gap constants defined above (SL_GAP_PENALTY_PCT, TP_GAP_PENALTY_PCT)
          const simulateWithTP = (minPct: number, maxPct: number, stopPct: number, tpPct: number, extraWhere?: string, label?: string) => {
            const whereExtra = extraWhere ? ` AND ${extraWhere}` : '';
            const rows = db.prepare(`
              SELECT label, pct_t30, ${stopCheckpoints.join(', ')}, pct_t300,
                     COALESCE(round_trip_slippage_pct, ${ROUND_TRIP_COST_PCT}) as cost_pct
              FROM graduation_momentum
              WHERE pct_t30 >= ${minPct} AND pct_t30 <= ${maxPct}
                AND pct_t30 IS NOT NULL${whereExtra}
            `).all() as any[];

            if (rows.length === 0) return null;

            let totalReturn = 0, stopped = 0, tpHit = 0, profitable = 0, rugged = 0, totalCost = 0;
            for (const r of rows) {
              // Absolute price levels from open (same basis as checkpoint values)
              const stopLevelPct = ((1 + r.pct_t30 / 100) * (1 - stopPct / 100) - 1) * 100;
              const tpLevelPct   = ((1 + r.pct_t30 / 100) * (1 + tpPct  / 100) - 1) * 100;
              let exitReturn: number | undefined;
              let wasStoppedOut = false;
              let wasTpHit = false;

              for (const cp of stopCheckpoints) {
                if (r[cp] == null) continue;
                if (r[cp] <= stopLevelPct) {
                  exitReturn = -(stopPct * (1 + SL_GAP_PENALTY_PCT)); // adverse gap on stop
                  stopped++;
                  wasStoppedOut = true;
                  break;
                }
                if (r[cp] >= tpLevelPct) {
                  exitReturn = tpPct * (1 - TP_GAP_PENALTY_PCT); // adverse gap on TP fill
                  tpHit++;
                  wasTpHit = true;
                  break;
                }
              }

              if (!wasStoppedOut && !wasTpHit) {
                if (r.pct_t300 != null) {
                  exitReturn = ((1 + r.pct_t300 / 100) / (1 + r.pct_t30 / 100) - 1) * 100;
                } else {
                  exitReturn = -100;
                  rugged++;
                }
              }

              exitReturn! -= r.cost_pct;
              totalCost += r.cost_pct;
              totalReturn += exitReturn!;
              if (exitReturn! > 0) profitable++;
            }

            const n = rows.length;
            const avgReturn = totalReturn / n;
            const avgCostUsed = totalCost / n;
            return {
              strategy: label || `t30 +${minPct}% to +${maxPct}%`,
              stop_loss_pct: stopPct,
              take_profit_pct: tpPct,
              n,
              stopped_count: stopped,
              stopped_pct: +(stopped / n * 100).toFixed(1),
              tp_hit_count: tpHit,
              tp_hit_pct: +(tpHit / n * 100).toFixed(1),
              rugged_count: rugged,
              rugged_pct: +(rugged / n * 100).toFixed(1),
              profitable_count: profitable,
              profitable_rate_pct: +(profitable / n * 100).toFixed(1),
              avg_return_pct: +avgReturn.toFixed(1),
              ev_positive: avgReturn > 0,
              avg_cost_per_trade_pct: +avgCostUsed.toFixed(2),
              costs_included: true,
              sl_gap_penalty: `${(SL_GAP_PENALTY_PCT * 100).toFixed(0)}% adverse gap on stop`,
              tp_gap_penalty: `${(TP_GAP_PENALTY_PCT * 100).toFixed(0)}% adverse gap on TP fill`,
              null_t300_treatment: 'worst-case -100% (pool drained / rug)',
            };
          };

          return {
            note: 'TP+SL combos only (SL-only strategies confirmed negative EV at n=630+). SL: 20% adverse gap. TP: 10% adverse gap. Round-trip slippage applied to all exits.',
            // REMOVED: basic, velocity_combos, stacked_combos — all SL-only strategies are negative EV.
            // Data still accessible via DB queries if needed.
            tp_sl_combos: (() => {
              const tpLevels = [20, 30, 50, 75, 100];
              const results: any[] = [];
              // Basic: no velocity filter
              for (const sl of [10, 15, 20]) {
                for (const tp of tpLevels) {
                  results.push(simulateWithTP(5, 100, sl, tp, undefined, `t30 +5-100% @ ${sl}% SL / ${tp}% TP`));
                }
              }
              // Velocity sweet spot: vel 5-20
              const velWhere = 'bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<20';
              for (const sl of [10, 15]) {
                for (const tp of tpLevels) {
                  results.push(simulateWithTP(5, 100, sl, tp, velWhere, `vel 5-20 + t30 @ ${sl}% SL / ${tp}% TP`));
                }
              }
              return results.filter(Boolean);
            })(),
          };
        })(),

        // ── PATH SHAPE FILTERS ───────────────────────────────────────────────
        // Monotonicity-based entry filters. Only tokens with 5s snapshots have this field.
        // n is smaller than the main cohort — flag clearly in the UI.
        path_shape_filters: (() => {
          const stopCheckpoints = ['pct_t40', 'pct_t50', 'pct_t60', 'pct_t90', 'pct_t120', 'pct_t150', 'pct_t180', 'pct_t240'] as const;
          const SL_GAP_PENALTY_PCT = 0.20;
          const TP_GAP_PENALTY_PCT = 0.10;

          // Total tokens with monotonicity data (used to show effective sample size)
          const monoTotal = (db.prepare(`
            SELECT COUNT(*) as n FROM graduation_momentum
            WHERE monotonicity_0_30 IS NOT NULL AND label IS NOT NULL
          `).get() as any)?.n ?? 0;

          const winRateForFilter = (extraWhere: string) => {
            const row = db.prepare(`
              SELECT COUNT(*) as total,
                     SUM(CASE WHEN label='PUMP' THEN 1 ELSE 0 END) as pump,
                     SUM(CASE WHEN label='DUMP' THEN 1 ELSE 0 END) as dump
              FROM graduation_momentum
              WHERE label IS NOT NULL AND monotonicity_0_30 IS NOT NULL AND ${extraWhere}
            `).get() as any;
            return {
              n: row.total,
              pump: row.pump,
              dump: row.dump,
              win_rate_pct: row.total > 0 ? +(row.pump / row.total * 100).toFixed(1) : null,
            };
          };

          const simulateWithTP = (extraWhere: string, label: string) => {
            const tpLevels = [20, 30, 50, 75];
            const sl = 10;
            const results: any[] = [];
            for (const tp of tpLevels) {
              const rows = db.prepare(`
                SELECT pct_t30, ${stopCheckpoints.join(', ')}, pct_t300,
                       COALESCE(round_trip_slippage_pct, ${ROUND_TRIP_COST_PCT}) as cost_pct
                FROM graduation_momentum
                WHERE pct_t30 >= 5 AND pct_t30 <= 100
                  AND pct_t30 IS NOT NULL
                  AND monotonicity_0_30 IS NOT NULL
                  AND ${extraWhere}
              `).all() as any[];

              if (rows.length === 0) continue;

              let totalReturn = 0, stopped = 0, tpHit = 0, profitable = 0, rugged = 0, totalCost = 0;
              for (const r of rows) {
                const stopLevelPct = ((1 + r.pct_t30 / 100) * (1 - sl / 100) - 1) * 100;
                const tpLevelPct   = ((1 + r.pct_t30 / 100) * (1 + tp / 100) - 1) * 100;
                let exitReturn: number | undefined;
                let wasStoppedOut = false;
                let wasTpHit = false;

                for (const cp of stopCheckpoints) {
                  if (r[cp] == null) continue;
                  if (r[cp] <= stopLevelPct) {
                    exitReturn = -(sl * (1 + SL_GAP_PENALTY_PCT));
                    stopped++;
                    wasStoppedOut = true;
                    break;
                  }
                  if (r[cp] >= tpLevelPct) {
                    exitReturn = tp * (1 - TP_GAP_PENALTY_PCT);
                    tpHit++;
                    wasTpHit = true;
                    break;
                  }
                }

                if (!wasStoppedOut && !wasTpHit) {
                  if (r.pct_t300 != null) {
                    exitReturn = ((1 + r.pct_t300 / 100) / (1 + r.pct_t30 / 100) - 1) * 100;
                  } else {
                    exitReturn = -100;
                    rugged++;
                  }
                }

                exitReturn! -= r.cost_pct;
                totalCost += r.cost_pct;
                totalReturn += exitReturn!;
                if (exitReturn! > 0) profitable++;
              }

              const n = rows.length;
              const avgReturn = totalReturn / n;
              results.push({
                strategy: `${label} @ ${sl}% SL / ${tp}% TP`,
                stop_loss_pct: sl,
                take_profit_pct: tp,
                n,
                stopped_pct: +(stopped / n * 100).toFixed(1),
                tp_hit_pct: +(tpHit / n * 100).toFixed(1),
                profitable_rate_pct: +(profitable / n * 100).toFixed(1),
                avg_return_pct: +avgReturn.toFixed(1),
                ev_positive: avgReturn > 0,
              });
            }
            return results;
          };

          const filters = [
            {
              label: 'mono > 0.5 + t30 +5-100%',
              where: 'monotonicity_0_30 > 0.5 AND pct_t30 BETWEEN 5 AND 100',
            },
            {
              label: 'mono > 0.33 + t30 +5-100%',
              where: 'monotonicity_0_30 > 0.33 AND pct_t30 BETWEEN 5 AND 100',
            },
            {
              label: 'mono > 0.5 + vel 5-20 + t30 +5-100%',
              where: 'monotonicity_0_30 > 0.5 AND bc_velocity_sol_per_min >= 5 AND bc_velocity_sol_per_min < 20 AND pct_t30 BETWEEN 5 AND 100',
            },
          ];

          return {
            note: `Monotonicity data only exists for tokens with 5s snapshots. Total with mono data: n=${monoTotal}. TP+SL results are noisy until n≥150.`,
            mono_total_n: monoTotal,
            filter_stats: filters.map(f => ({ filter: f.label, ...winRateForFilter(f.where) })),
            tp_sl_combos_mono_05: simulateWithTP(filters[0].where, 'mono>0.5'),
            tp_sl_combos_mono_05_vel: simulateWithTP(filters[2].where, 'mono>0.5+vel5-20'),
          };
        })(),

        // ── SIGNAL FREQUENCY ─────────────────────────────────────────────────
        // How often does each filter fire? Derived from actual data timestamps.
        // Useful for sizing position frequency and daily trade volume estimates.
        signal_frequency: (() => {
          const span = db.prepare(`
            SELECT MIN(created_at) as first_ts, MAX(created_at) as last_ts, COUNT(*) as total
            FROM graduation_momentum WHERE pct_t30 IS NOT NULL
          `).get() as any;

          if (!span || !span.first_ts || span.last_ts === span.first_ts || span.total < 2) {
            return { note: 'Insufficient data for frequency calculation', samples: span?.total ?? 0 };
          }

          const spanHours = (span.last_ts - span.first_ts) / 3600;
          if (spanHours < 0.1) return { note: 'Data span too short for reliable frequency estimate', samples: span.total };

          const graduationsPerHour = +(span.total / spanHours).toFixed(2);

          const velRow = db.prepare(`
            SELECT COUNT(*) as with_vel FROM graduation_momentum
            WHERE pct_t30 IS NOT NULL AND bc_velocity_sol_per_min IS NOT NULL
          `).get() as any;
          const velocityDataAvailPct = span.total > 0 ? +((velRow.with_vel / span.total) * 100).toFixed(1) : 0;

          const keyFilters = [
            { name: 't30 +5-100% (baseline)',              where: `pct_t30 >= 5  AND pct_t30 <= 100` },
            { name: 't30 +10-100%',                        where: `pct_t30 >= 10 AND pct_t30 <= 100` },
            { name: 'vel 5-20 + t30 +5-100%',             where: `pct_t30 >= 5 AND pct_t30 <= 100 AND bc_velocity_sol_per_min >= 5 AND bc_velocity_sol_per_min < 20` },
            { name: 'vel 5-50 + t30 +5-100%',             where: `pct_t30 >= 5 AND pct_t30 <= 100 AND bc_velocity_sol_per_min >= 5 AND bc_velocity_sol_per_min < 50` },
            { name: 'vel 5-20 + holders>=10 + t30 +5-100%', where: `pct_t30 >= 5 AND pct_t30 <= 100 AND bc_velocity_sol_per_min >= 5 AND bc_velocity_sol_per_min < 20 AND holder_count >= 10` },
            { name: 'vel 5-20 + liq>100 + t30 +5-100%',  where: `pct_t30 >= 5 AND pct_t30 <= 100 AND bc_velocity_sol_per_min >= 5 AND bc_velocity_sol_per_min < 20 AND liquidity_sol_t30 > 100` },
          ];

          const signalsPerDay = keyFilters.map(f => {
            const hitRow = db.prepare(`SELECT COUNT(*) as hits FROM graduation_momentum WHERE ${f.where}`).get() as any;
            const hitRatePct = span.total > 0 ? +((hitRow.hits / span.total) * 100).toFixed(1) : 0;
            const estSignalsPerDay = +(hitRatePct / 100 * graduationsPerHour * 24).toFixed(1);
            return { filter: f.name, hits: hitRow.hits, hit_rate_pct: hitRatePct, est_signals_per_day: estSignalsPerDay };
          });

          return {
            note: `Based on ${span.total} graduations with T+30 data over ${spanHours.toFixed(1)}h of collection`,
            data_span_hours: +spanHours.toFixed(1),
            total_with_t30_data: span.total,
            graduations_per_hour: graduationsPerHour,
            graduations_per_day_est: +(graduationsPerHour * 24).toFixed(0),
            velocity_data_available_pct: velocityDataAvailPct,
            signals_per_day_by_filter: signalsPerDay,
          };
        })(),

        // REMOVED: sol_raised_distribution — single bucket (80-86 SOL), no signal

        bc_velocity_distribution: (() => {
          const velBuckets = db.prepare(`
            SELECT
              CASE
                WHEN bc_velocity_sol_per_min IS NULL    THEN 'null'
                WHEN bc_velocity_sol_per_min < 5        THEN '<5 sol/min'
                WHEN bc_velocity_sol_per_min < 10       THEN '5-10 sol/min'
                WHEN bc_velocity_sol_per_min < 20       THEN '10-20 sol/min'
                WHEN bc_velocity_sol_per_min < 50       THEN '20-50 sol/min'
                WHEN bc_velocity_sol_per_min < 200      THEN '50-200 sol/min'
                WHEN bc_velocity_sol_per_min < 500      THEN '200-500 sol/min'
                ELSE '500 sol/min (capped)'
              END as bucket,
              COUNT(*) as total,
              SUM(CASE WHEN label='PUMP' THEN 1 ELSE 0 END) as pump,
              SUM(CASE WHEN label='DUMP' THEN 1 ELSE 0 END) as dump
            FROM graduation_momentum WHERE label IS NOT NULL
            GROUP BY bucket ORDER BY MIN(COALESCE(bc_velocity_sol_per_min, -1))
          `).all() as any[];
          return velBuckets.map((b: any) => ({
            bucket: b.bucket, total: b.total, pump: b.pump, dump: b.dump,
            win_rate_pct: b.total > 0 ? +((b.pump / b.total) * 100).toFixed(1) : null,
          }));
        })(),

        bc_age_distribution: ageBuckets.map((b: any) => ({
          bucket: b.bucket, total: b.total, pump: b.pump, dump: b.dump,
          win_rate_pct: winRate(b.pump, b.total),
        })),

        // Max drawdown analysis — how deep do tokens dip before recovering?
        drawdown_analysis: (() => {
          const rows = db.prepare(`
            SELECT label, max_peak_pct, max_peak_sec, max_drawdown_pct, max_drawdown_sec,
                   pct_t300, pct_t30
            FROM graduation_momentum
            WHERE label IS NOT NULL AND max_drawdown_pct IS NOT NULL
          `).all() as any[];

          if (rows.length === 0) return { note: 'No drawdown data yet — waiting for new graduations with granular snapshots', samples: 0 };

          const byLabel = (lbl: string) => {
            const subset = rows.filter((r: any) => r.label === lbl);
            if (subset.length === 0) return null;
            return {
              label: lbl,
              n: subset.length,
              avg_max_peak_pct: +(subset.reduce((s: number, r: any) => s + r.max_peak_pct, 0) / subset.length).toFixed(1),
              avg_max_drawdown_pct: +(subset.reduce((s: number, r: any) => s + r.max_drawdown_pct, 0) / subset.length).toFixed(1),
              avg_drawdown_sec: +(subset.reduce((s: number, r: any) => s + r.max_drawdown_sec, 0) / subset.length).toFixed(0),
              avg_peak_sec: +(subset.reduce((s: number, r: any) => s + r.max_peak_sec, 0) / subset.length).toFixed(0),
            };
          };

          // Optimal stop-loss: find the stop level that maximizes separation
          // between PUMPs that survive and DUMPs that get stopped out
          const pumps = rows.filter((r: any) => r.label === 'PUMP');
          const dumps = rows.filter((r: any) => r.label === 'DUMP');
          const stopLevels = [5, 10, 15, 20, 25, 30, 40, 50];
          const stopAnalysis = stopLevels.map((stopPct) => {
            const pumpsStopped = pumps.filter((r: any) => r.max_drawdown_pct <= -stopPct).length;
            const dumpsStopped = dumps.filter((r: any) => r.max_drawdown_pct <= -stopPct).length;
            return {
              stop_level_pct: stopPct,
              pumps_stopped: pumpsStopped,
              pumps_total: pumps.length,
              pumps_survived_pct: pumps.length > 0 ? +((1 - pumpsStopped / pumps.length) * 100).toFixed(1) : null,
              dumps_stopped: dumpsStopped,
              dumps_total: dumps.length,
              dumps_caught_pct: dumps.length > 0 ? +((dumpsStopped / dumps.length) * 100).toFixed(1) : null,
            };
          });

          return {
            note: 'Max drawdown = worst peak-to-trough drop during the observation window. Optimal stop avoids stopping PUMPs while catching DUMPs.',
            samples: rows.length,
            by_label: [byLabel('PUMP'), byLabel('DUMP'), byLabel('STABLE')].filter(Boolean),
            optimal_stop_loss: stopAnalysis,
          };
        })(),

        // Trading readiness metrics — volatility, liquidity, slippage at T+30 decision point
        trading_readiness: (() => {
          const rows = db.prepare(`
            SELECT label, volatility_0_30, liquidity_sol_t30, slippage_est_05sol,
                   round_trip_slippage_pct, bc_velocity_sol_per_min, pct_t300
            FROM graduation_momentum
            WHERE label IS NOT NULL AND volatility_0_30 IS NOT NULL
          `).all() as any[];

          if (rows.length === 0) return { note: 'No trading readiness data yet — waiting for new graduations', samples: 0 };

          const byLabel = (lbl: string) => {
            const subset = rows.filter((r: any) => r.label === lbl);
            if (subset.length === 0) return null;
            const avg = (arr: number[]) => arr.length > 0 ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null;
            return {
              label: lbl,
              n: subset.length,
              avg_volatility_0_30: avg(subset.map((r: any) => r.volatility_0_30)),
              avg_liquidity_sol_t30: avg(subset.map((r: any) => r.liquidity_sol_t30)),
              avg_slippage_05sol: avg(subset.map((r: any) => r.slippage_est_05sol)),
              avg_round_trip_slippage_pct: avg(subset.filter((r: any) => r.round_trip_slippage_pct != null).map((r: any) => r.round_trip_slippage_pct)),
              // Cap at 500 sol/min when averaging so pre-migration outliers don't skew the mean.
              // New rows are already capped at storage time.
              avg_bc_velocity: avg(subset.filter((r: any) => r.bc_velocity_sol_per_min != null).map((r: any) => Math.min(r.bc_velocity_sol_per_min, 500))),
            };
          };

          // Test if low volatility tokens perform better
          const volBuckets = [
            { label: 'vol < 10%', filter: (r: any) => r.volatility_0_30 < 10 },
            { label: 'vol 10-30%', filter: (r: any) => r.volatility_0_30 >= 10 && r.volatility_0_30 < 30 },
            { label: 'vol 30-60%', filter: (r: any) => r.volatility_0_30 >= 30 && r.volatility_0_30 < 60 },
            { label: 'vol 60%+', filter: (r: any) => r.volatility_0_30 >= 60 },
          ].map(({ label: bucketLabel, filter }) => {
            const subset = rows.filter(filter);
            const pumps = subset.filter((r: any) => r.label === 'PUMP').length;
            return {
              bucket: bucketLabel,
              n: subset.length,
              pump: pumps,
              dump: subset.filter((r: any) => r.label === 'DUMP').length,
              win_rate_pct: subset.length > 0 ? +(pumps / subset.length * 100).toFixed(1) : null,
            };
          });

          return {
            note: 'Metrics at T+30 decision point. volatility = price range in first 30s. slippage = estimated cost for 0.5 SOL buy. round_trip_slippage = entry + exit (conservative: 2x entry). bc_velocity = how fast the bonding curve filled.',
            samples: rows.length,
            by_label: [byLabel('PUMP'), byLabel('DUMP'), byLabel('STABLE')].filter(Boolean),
            win_rate_by_volatility: volBuckets,
          };
        })(),

        // ── RETURN DISTRIBUTION (PERCENTILES) ──────────────────────────────
        // Shows the shape of returns, not just averages. Critical for understanding tail risk.
        // If the 10th percentile is -80%, one bad cluster wipes out months of gains.
        return_distribution: (() => {
          const rows = db.prepare(`
            SELECT label, pct_t30, pct_t300, bc_velocity_sol_per_min,
                   COALESCE(round_trip_slippage_pct, ${ROUND_TRIP_COST_PCT}) as cost_pct
            FROM graduation_momentum
            WHERE pct_t30 IS NOT NULL AND pct_t300 IS NOT NULL
          `).all() as any[];

          if (rows.length < 5) return { note: 'Insufficient data for distribution analysis', samples: rows.length };

          const percentile = (arr: number[], p: number) => {
            const sorted = [...arr].sort((a, b) => a - b);
            const idx = Math.floor(sorted.length * p / 100);
            return +sorted[Math.min(idx, sorted.length - 1)].toFixed(1);
          };

          const analyzeReturns = (subset: any[], label: string) => {
            if (subset.length < 3) return null;
            // Return from T+30 entry to T+300 exit, cost-adjusted
            const returns = subset.map((r: any) => {
              const rawReturn = ((1 + r.pct_t300 / 100) / (1 + r.pct_t30 / 100) - 1) * 100;
              return rawReturn - r.cost_pct;
            });
            const avg = +(returns.reduce((a: number, b: number) => a + b, 0) / returns.length).toFixed(1);
            return {
              cohort: label,
              n: subset.length,
              avg_return_pct: avg,
              p10: percentile(returns, 10),
              p25: percentile(returns, 25),
              median: percentile(returns, 50),
              p75: percentile(returns, 75),
              p90: percentile(returns, 90),
              min: percentile(returns, 0),
              max: percentile(returns, 100),
              pct_worse_than_neg50: +(returns.filter(r => r < -50).length / returns.length * 100).toFixed(1),
              pct_better_than_pos30: +(returns.filter(r => r > 30).length / returns.length * 100).toFixed(1),
            };
          };

          const allRows = rows.filter((r: any) => r.pct_t30 >= 5 && r.pct_t30 <= 100);
          const vel520 = allRows.filter((r: any) => r.bc_velocity_sol_per_min >= 5 && r.bc_velocity_sol_per_min < 20);

          return {
            note: 'Percentile returns from T+30 entry to T+300 exit, cost-adjusted. Tail risk is what kills you — check p10 and min.',
            all_t30_5_100: analyzeReturns(allRows, 'all t30 +5-100%'),
            vel_5_20: analyzeReturns(vel520, 'vel 5-20 + t30 +5-100%'),
            by_label: {
              pump: analyzeReturns(allRows.filter((r: any) => r.label === 'PUMP'), 'PUMP only'),
              dump: analyzeReturns(allRows.filter((r: any) => r.label === 'DUMP'), 'DUMP only'),
              stable: analyzeReturns(allRows.filter((r: any) => r.label === 'STABLE'), 'STABLE only'),
            },
          };
        })(),

        // ── REGIME DETECTION ─────────────────────────────────────────────────
        // Is the edge stable over time or clustered in specific windows?
        // Splits data into time buckets and shows win rate + avg return per bucket.
        regime_analysis: (() => {
          const rows = db.prepare(`
            SELECT created_at, label, pct_t30, pct_t300, bc_velocity_sol_per_min,
                   COALESCE(round_trip_slippage_pct, ${ROUND_TRIP_COST_PCT}) as cost_pct
            FROM graduation_momentum
            WHERE pct_t30 IS NOT NULL AND label IS NOT NULL
            ORDER BY created_at ASC
          `).all() as any[];

          if (rows.length < 10) return { note: 'Insufficient data for regime analysis', samples: rows.length };

          // Split into ~equal-sized time buckets (aim for 6-8 buckets)
          const bucketSize = Math.max(10, Math.ceil(rows.length / 8));
          const buckets: any[] = [];
          for (let i = 0; i < rows.length; i += bucketSize) {
            const chunk = rows.slice(i, i + bucketSize);
            const pumps = chunk.filter((r: any) => r.label === 'PUMP').length;
            const dumps = chunk.filter((r: any) => r.label === 'DUMP').length;
            // Vel 5-20 subset
            const velChunk = chunk.filter((r: any) =>
              r.bc_velocity_sol_per_min >= 5 && r.bc_velocity_sol_per_min < 20 &&
              r.pct_t30 >= 5 && r.pct_t30 <= 100
            );
            const velPumps = velChunk.filter((r: any) => r.label === 'PUMP').length;
            // Avg return for vel 5-20 from T+30 entry
            const velReturns = velChunk
              .filter((r: any) => r.pct_t300 != null)
              .map((r: any) => ((1 + r.pct_t300 / 100) / (1 + r.pct_t30 / 100) - 1) * 100 - r.cost_pct);
            const velAvgReturn = velReturns.length > 0
              ? +(velReturns.reduce((a: number, b: number) => a + b, 0) / velReturns.length).toFixed(1)
              : null;

            const startTime = new Date(chunk[0].created_at * 1000).toISOString().replace('T', ' ').slice(0, 16);
            const endTime = new Date(chunk[chunk.length - 1].created_at * 1000).toISOString().replace('T', ' ').slice(0, 16);

            buckets.push({
              window: `${startTime} → ${endTime}`,
              n_total: chunk.length,
              pump: pumps,
              dump: dumps,
              raw_win_rate_pct: +(pumps / chunk.length * 100).toFixed(1),
              vel_5_20_n: velChunk.length,
              vel_5_20_pump: velPumps,
              vel_5_20_win_rate_pct: velChunk.length > 0 ? +(velPumps / velChunk.length * 100).toFixed(1) : null,
              vel_5_20_avg_return_pct: velAvgReturn,
            });
          }

          // Edge stability: std dev of win rates across buckets
          const winRates = buckets.map(b => b.raw_win_rate_pct);
          const avgWR = winRates.reduce((a, b) => a + b, 0) / winRates.length;
          const wrStdDev = Math.sqrt(winRates.reduce((s, w) => s + (w - avgWR) ** 2, 0) / winRates.length);

          const velWinRates = buckets.filter(b => b.vel_5_20_win_rate_pct != null).map(b => b.vel_5_20_win_rate_pct);
          const velAvgWR = velWinRates.length > 0 ? velWinRates.reduce((a: number, b: number) => a + b, 0) / velWinRates.length : null;
          const velWrStdDev = velWinRates.length > 1
            ? Math.sqrt(velWinRates.reduce((s: number, w: number) => s + (w - velAvgWR!) ** 2, 0) / velWinRates.length)
            : null;

          return {
            note: 'Data split into time-ordered buckets. Stable edge = low std dev across buckets. Clustered edge = high std dev (wins bunched in certain periods).',
            total_samples: rows.length,
            bucket_count: buckets.length,
            samples_per_bucket: bucketSize,
            overall_win_rate_std_dev: +wrStdDev.toFixed(1),
            vel_5_20_win_rate_std_dev: velWrStdDev != null ? +velWrStdDev.toFixed(1) : null,
            stability_verdict: wrStdDev < 8 ? 'STABLE (std dev < 8%)' : wrStdDev < 15 ? 'MODERATE (std dev 8-15%)' : 'CLUSTERED (std dev > 15% — edge may be regime-dependent)',
            time_buckets: buckets,
          };
        })(),

        duplicate_mints: dupes.length === 0
          ? 'none'
          : dupes.map((d: any) => ({ mint: d.mint, count: d.cnt })),
      };

      const wantHtml = (req.headers.accept || '').includes('text/html');
      if (wantHtml) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderFilterHtml(filterData));
      } else {
        res.json(filterData);
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── FILTER ANALYSIS V2 ───────────────────────────────────────────────────
  // Panel 1: Single-feature filter comparison. Each row shows how many tokens
  // (PUMP/DUMP/STABLE) remain after applying that one filter, normalized for
  // null data (n_applicable = tokens with non-null feature value AND label).
  app.get('/filter-analysis-v2', (req, res) => {
    try {
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
        buy_pressure_buy_ratio: number | null;
        buy_pressure_unique_buyers: number | null;
        buy_pressure_whale_pct: number | null;
      };

      // ── Panel 4 row type: RegimeRow + TP/SL checkpoints and fall-through column ──
      type Panel4Row = RegimeRow & {
        pct_t40: number | null;
        pct_t50: number | null;
        pct_t60: number | null;
        pct_t90: number | null;
        pct_t120: number | null;
        pct_t150: number | null;
        pct_t180: number | null;
        pct_t240: number | null;
        // pct_t300 already on RegimeRow (number, non-null for eligible rows)
      };

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

      // Helper: run a single filter query and return normalized stats
      const runFilterStats = (column: string, whereCond: string) => {
        const baseWhere = 'label IS NOT NULL';
        const colCheck = column ? `${column} IS NOT NULL` : '';
        const cond = whereCond || '';
        const fullWhere = [baseWhere, colCheck, cond].filter(Boolean).join(' AND ');
        const row = db.prepare(`
          SELECT
            COUNT(*) as n,
            SUM(CASE WHEN label='PUMP'   THEN 1 ELSE 0 END) as pump,
            SUM(CASE WHEN label='DUMP'   THEN 1 ELSE 0 END) as dump,
            SUM(CASE WHEN label='STABLE' THEN 1 ELSE 0 END) as stable
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

      // Snapshot columns scanned for MAE/MFE (T+30 through T+300 inclusive)
      const SNAPSHOT_COLS = [
        'price_t30', 'price_t35', 'price_t40', 'price_t45', 'price_t50', 'price_t55', 'price_t60',
        'price_t90', 'price_t120', 'price_t150', 'price_t180', 'price_t240', 'price_t300',
      ];

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
               buy_pressure_whale_pct
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

      // ── Panel 4: dynamic TP/SL EV simulator ──
      // Constants MUST mirror simulateWithTP at src/index.ts:1283-1359 exactly.
      const PANEL_4_SL_GAP_PENALTY = 0.20;
      const PANEL_4_TP_GAP_PENALTY = 0.10;
      const PANEL_4_CHECKPOINTS = ['pct_t40', 'pct_t50', 'pct_t60', 'pct_t90', 'pct_t120', 'pct_t150', 'pct_t180', 'pct_t240'] as const;
      const PANEL_4_TP_GRID = [10, 15, 20, 25, 30, 35, 40, 50, 60, 75, 100, 150] as const;
      const PANEL_4_SL_GRID = [3, 4, 5, 7.5, 10, 12.5, 15, 20, 25, 30] as const;
      const PANEL_4_DEFAULT_TP = 30;
      const PANEL_4_DEFAULT_SL = 10;
      const PANEL_4_MIN_N_FOR_OPTIMUM = 30;
      const PANEL_4_MIN_TP_HITS_FOR_OPTIMUM = 3;

      // Single load: all eligible rows for Panel 4.
      // Stricter than regimeRows: also guards against pct_t30 <= -99 (division pathology).
      const panel4Rows = db.prepare(`
        SELECT
          created_at, label,
          pct_t30, pct_t40, pct_t50, pct_t60, pct_t90, pct_t120, pct_t150, pct_t180, pct_t240, pct_t300,
          COALESCE(round_trip_slippage_pct, ${ROUND_TRIP_COST_PCT_V2}) as cost_pct,
          bc_velocity_sol_per_min, token_age_seconds, holder_count, top5_wallet_pct,
          dev_wallet_pct, total_sol_raised, liquidity_sol_t30, volatility_0_30,
          monotonicity_0_30, max_drawdown_0_30, dip_and_recover_flag, acceleration_t30,
          early_vs_late_0_30, buy_pressure_buy_ratio, buy_pressure_unique_buyers,
          buy_pressure_whale_pct
        FROM graduation_momentum
        WHERE label IS NOT NULL
          AND pct_t30 IS NOT NULL
          AND pct_t30 > -99
          AND pct_t300 IS NOT NULL
      `).all() as Panel4Row[];

      // Simulate one token at one (tp, sl). Byte-for-byte mirror of simulateWithTP.
      // Returns { ret, tpHit } — ret is already cost-adjusted.
      const simulateInMemory = (r: Panel4Row, tp: number, sl: number): { ret: number; tpHit: boolean } => {
        const stopLevelPct = ((1 + r.pct_t30 / 100) * (1 - sl / 100) - 1) * 100;
        const tpLevelPct   = ((1 + r.pct_t30 / 100) * (1 + tp / 100) - 1) * 100;
        for (const cp of PANEL_4_CHECKPOINTS) {
          const v = r[cp];
          if (v == null) continue;
          if (v <= stopLevelPct) return { ret: -(sl * (1 + PANEL_4_SL_GAP_PENALTY)) - r.cost_pct, tpHit: false };
          if (v >= tpLevelPct)   return { ret:  (tp * (1 - PANEL_4_TP_GAP_PENALTY)) - r.cost_pct, tpHit: true };
        }
        // Fall-through: exit at T+300 (non-null by eligibility predicate)
        const fallRet = ((1 + r.pct_t300 / 100) / (1 + r.pct_t30 / 100) - 1) * 100 - r.cost_pct;
        return { ret: fallRet, tpHit: false };
      };

      const runFilterPanel4 = (predicate: (r: Panel4Row) => boolean) => {
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
              const out = simulateInMemory(filtered[k], tp, sl);
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

      // Shared type alias for Panel 4 optimum — mirrors the shape returned
      // by runFilterPanel4 (src/index.ts:2342). Used by Panels 5 & 6.
      type Panel4Optimal = { tp: number; sl: number; avg_ret: number; win_rate: number } | null;

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

      const panel6Selected = parsePanel6Selection(req.query.p6);
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

      const filterV2Data = {
        generated_at: new Date().toISOString(),
        panel1: {
          title: 'Single-Feature Filter Comparison',
          description:
            'Each row applies ONE filter to the labeled dataset. n is normalized — only tokens where the feature has a non-null value are counted, so monotonicity rows have smaller n than velocity rows. PUMP:DUMP ratio shows asymmetry: >1.0 = more winners than losers, >2.0 = strong asymmetry.',
          baseline,
          filters,
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
            'Entry at T+30. Each row precomputes EV across a 12×10 (TP × SL) grid. Dropdowns above the table pick the active cell — all Sel* columns update in place. Opt* columns show the per-filter optimum (max avg return with ≥3 TP hits among combos, requires filter n ≥ 30). Mirrors simulateWithTP (src/index.ts:1283) exactly: SL 20% adverse gap, TP 10% adverse gap, per-token round_trip_slippage_pct with 3% fallback, null pct_t300 excluded via eligibility.',
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
      };

      const wantHtml = (req.headers.accept || '').includes('text/html');
      if (wantHtml) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderFilterV2Html(filterV2Data));
      } else {
        res.json(filterV2Data);
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── PRICE PATH ANALYSIS ──────────────────────────────────────────────────
  app.get('/price-path', (_req, res) => {
    try {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderPricePathHtml(db));
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
    const onPumpswap    = results.filter(r => r.dexes_found.some(d => d === 'pumpswap' || d === 'pump_amm' || d === 'pumpfun' || d === 'pump')).length;
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

  // ── TOKEN BROWSER ────────────────────────────────────────────────────────
  // Browse graduated token addresses with filters. Useful for manual spot-checks
  // on DexScreener/Solscan.
  //
  // Filters (all optional, combinable):
  //   ?label=PUMP|DUMP|STABLE|unlabeled   — filter by momentum label
  //   ?min_sol=N                           — minimum final_sol_reserves
  //   ?max_sol=N                           — maximum final_sol_reserves
  //   ?min_holders=N                       — minimum holder count at graduation
  //   ?limit=N                             — rows to return (default 50, max 200)
  //   ?sort=sol|holders|pct_t300|recent    — sort order (default: recent)
  app.get('/tokens', (req, res) => {
    const label    = (req.query.label    as string) || '';
    const minSol   = parseFloat((req.query.min_sol   as string) || '0')  || 0;
    const maxSol   = parseFloat((req.query.max_sol   as string) || '0')  || 0;
    const minHold  = parseInt  ((req.query.min_holders as string) || '0', 10) || 0;
    const limit    = Math.min(200, Math.max(1, parseInt((req.query.limit as string) || '50', 10)));
    const sort     = (req.query.sort as string) || 'recent';

    const sortCol: Record<string, string> = {
      sol:      'g.final_sol_reserves DESC',
      holders:  'gm.holder_count DESC',
      pct_t300: 'ABS(gm.pct_t300) DESC',
      recent:   'g.id DESC',
    };
    const orderBy = sortCol[sort] || 'g.id DESC';

    const conditions: string[] = [];
    if (label === 'unlabeled') {
      conditions.push('gm.label IS NULL');
    } else if (label) {
      conditions.push(`gm.label = '${label.toUpperCase()}'`);
    }
    if (minSol > 0) conditions.push(`g.final_sol_reserves >= ${minSol}`);
    if (maxSol > 0) conditions.push(`g.final_sol_reserves <= ${maxSol}`);
    if (minHold > 0) conditions.push(`gm.holder_count >= ${minHold}`);

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const rows = db.prepare(`
      SELECT
        g.mint,
        g.timestamp,
        g.final_sol_reserves           AS sol,
        gm.label,
        gm.holder_count,
        gm.top5_wallet_pct,
        gm.dev_wallet_pct,
        gm.token_age_seconds,
        gm.open_price_sol,
        gm.pct_t30,
        gm.pct_t60,
        gm.pct_t300,
        gm.total_sol_raised
      FROM graduations g
      LEFT JOIN graduation_momentum gm ON gm.graduation_id = g.id
      ${where}
      ORDER BY ${orderBy}
      LIMIT ${limit}
    `).all() as Array<{
      mint: string; timestamp: number; sol: number | null; label: string | null;
      holder_count: number | null; top5_wallet_pct: number | null; dev_wallet_pct: number | null;
      token_age_seconds: number | null; open_price_sol: number | null;
      pct_t30: number | null; pct_t60: number | null; pct_t300: number | null;
      total_sol_raised: number | null;
    }>;

    const fmt = (n: number | null, dec = 1) => n == null ? '—' : n.toFixed(dec);
    const fmtPct = (n: number | null) => n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
    const fmtAge = (s: number | null) => {
      if (s == null) return '—';
      if (s < 3600) return Math.round(s / 60) + 'm';
      if (s < 86400) return (s / 3600).toFixed(1) + 'h';
      return (s / 86400).toFixed(1) + 'd';
    };
    const labelBadge = (l: string | null) => {
      if (!l) return '<span style="color:#888">—</span>';
      const c = l === 'PUMP' ? '#00cc66' : l === 'DUMP' ? '#ff4444' : '#aaa';
      return `<span style="color:${c};font-weight:bold">${l}</span>`;
    };

    // Build active filter description
    const filterDesc = [
      label ? `label=${label.toUpperCase()}` : '',
      minSol  ? `sol≥${minSol}` : '',
      maxSol  ? `sol≤${maxSol}` : '',
      minHold ? `holders≥${minHold}` : '',
      `sort=${sort}`,
      `limit=${limit}`,
    ].filter(Boolean).join('  ·  ');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Token Browser</title>
<style>
  body { font-family: monospace; background: #0d0d0d; color: #e0e0e0; padding: 16px; font-size: 13px; }
  h2 { color: #fff; margin: 0 0 4px; }
  .filters { color: #888; margin-bottom: 12px; font-size: 12px; }
  .filters a { color: #4af; text-decoration: none; margin-right: 12px; }
  .filters a:hover { text-decoration: underline; }
  table { border-collapse: collapse; width: 100%; }
  th { background: #1a1a1a; color: #aaa; padding: 6px 10px; text-align: left; font-weight: normal; border-bottom: 1px solid #333; }
  td { padding: 5px 10px; border-bottom: 1px solid #1e1e1e; vertical-align: middle; }
  tr:hover td { background: #161616; }
  .mint { font-size: 11px; color: #ccc; }
  .mint a { color: #4af; text-decoration: none; }
  .mint a:hover { text-decoration: underline; }
  .copy-btn { cursor: pointer; background: #222; border: 1px solid #444; color: #aaa; padding: 2px 6px; border-radius: 3px; font-size: 10px; margin-left: 4px; }
  .copy-btn:hover { background: #333; color: #fff; }
  .pos { color: #0f0; } .neg { color: #f44; }
  .filter-links { margin-bottom: 14px; }
  .filter-links span { color: #666; margin-right: 6px; font-size: 11px; }
</style>
<script>
function copyMint(mint) {
  navigator.clipboard.writeText(mint).then(() => {
    event.target.textContent = 'copied!';
    setTimeout(() => event.target.textContent = 'copy', 1200);
  });
}
</script>
</head><body>
<h2>Token Browser</h2>
<div class="filters">Active filters: ${filterDesc || 'none (showing all)'} &nbsp;&nbsp; ${rows.length} rows</div>

<div class="filter-links">
  <span>Quick filters:</span>
  <a href="/tokens?label=PUMP&sort=recent">PUMP only</a>
  <a href="/tokens?label=DUMP&sort=recent">DUMP only</a>
  <a href="/tokens?label=PUMP&min_sol=80">PUMP + sol≥80</a>
  <a href="/tokens?sort=sol">Top SOL</a>
  <a href="/tokens?sort=pct_t300">Biggest movers</a>
  <a href="/tokens?label=unlabeled">Unlabeled</a>
  <a href="/tokens">All recent</a>
</div>

<table>
<tr>
  <th>Mint</th>
  <th>Label</th>
  <th>SOL raised</th>
  <th>Holders</th>
  <th>Top5%</th>
  <th>Dev%</th>
  <th>BC Age</th>
  <th>T+30</th>
  <th>T+60</th>
  <th>T+300</th>
  <th>Graduated</th>
</tr>
${rows.map(r => {
  const ts = r.timestamp ? new Date(r.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '—';
  const dsLink = `https://dexscreener.com/solana/${r.mint}`;
  const solLink = `https://solscan.io/token/${r.mint}`;
  const pctClass = (n: number | null) => n == null ? '' : n > 0 ? 'pos' : n < 0 ? 'neg' : '';
  return `<tr>
    <td class="mint">
      <a href="${dsLink}" target="_blank">${r.mint.slice(0, 16)}…</a>
      <button class="copy-btn" onclick="copyMint('${r.mint}')">copy</button>
      <a href="${solLink}" target="_blank" style="font-size:10px;color:#888;margin-left:4px">solscan</a>
    </td>
    <td>${labelBadge(r.label)}</td>
    <td>${fmt(r.sol, 1)}</td>
    <td>${r.holder_count ?? '—'}</td>
    <td>${fmt(r.top5_wallet_pct, 1)}${r.top5_wallet_pct != null ? '%' : ''}</td>
    <td>${fmt(r.dev_wallet_pct, 1)}${r.dev_wallet_pct != null ? '%' : ''}</td>
    <td>${fmtAge(r.token_age_seconds)}</td>
    <td class="${pctClass(r.pct_t30)}">${fmtPct(r.pct_t30)}</td>
    <td class="${pctClass(r.pct_t60)}">${fmtPct(r.pct_t60)}</td>
    <td class="${pctClass(r.pct_t300)}">${fmtPct(r.pct_t300)}</td>
    <td style="color:#666;font-size:11px">${ts}</td>
  </tr>`;
}).join('\n')}
</table>
</body></html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
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
