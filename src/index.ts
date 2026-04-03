import express from 'express';
import pino from 'pino';
import { Connection, PublicKey } from '@solana/web3.js';
import { initDatabase } from './db/schema';
import { getGraduationCount } from './db/queries';
import { GraduationListener } from './monitor/graduation-listener';
import { renderThesisHtml, renderFilterHtml } from './utils/html-renderer';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'main' });

// Send JSON as a browser-friendly HTML page (with copy button) when Accept: text/html,
// otherwise return plain JSON for API/curl clients.
// Navigation links for the dashboard (excludes reset for safety)
const NAV_LINKS = [
  { path: '/dashboard', label: 'Dashboard' },
  { path: '/thesis', label: 'Thesis' },
  { path: '/filter-analysis', label: 'Filters' },
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

          const tokenAgeSeconds = Math.max(0, row.grad_timestamp - oldestBlockTime);
          if (tokenAgeSeconds <= 0) {
            failed++;
            logger.warn(
              { graduationId: row.graduation_id, grad_timestamp: row.grad_timestamp, oldestBlockTime, diff: row.grad_timestamp - oldestBlockTime, usingBC, totalSigsScanned },
              'Backfill skip: tokenAgeSeconds <= 0 (oldest sig is at or after graduation — hit page cap before reaching creation tx?)'
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

      // Round-trip trading cost: ~1-2% entry slippage (0.5 SOL into ~79 SOL pool),
      // ~0.3% PumpSwap fee, ~0.005-0.01 SOL Jito tip, ~1% exit slippage
      const ROUND_TRIP_COST_PCT = 3.0;
      const COST_SCENARIOS = [
        { label: 'optimistic',  cost: 2.0 },
        { label: 'realistic',   cost: 3.5 },
        { label: 'pessimistic', cost: 5.0 },
      ];

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
          avg_t30_gain_pct:            r.avg_t30_gain,
          avg_t300_gain_pct:           r.avg_t300_gain,
          avg_return_from_t30_pct:     r.avg_return_from_t30,
          profitable_from_t30:         r.profitable_from_t30,
          profitable_rate_pct:         r.n > 0 ? +(r.profitable_from_t30 / r.n * 100).toFixed(1) : null,
          cost_adjusted_return_pct:    r.avg_return_from_t30 != null ? +(r.avg_return_from_t30 - ROUND_TRIP_COST_PCT).toFixed(1) : null,
          cost_adjusted_ev_positive:   r.avg_return_from_t30 != null ? (r.avg_return_from_t30 - ROUND_TRIP_COST_PCT) > 0 : null,
          cost_scenarios:              COST_SCENARIOS.map(s => ({
            label:          s.label,
            cost_pct:       s.cost,
            net_return_pct: r.avg_return_from_t30 != null ? +(r.avg_return_from_t30 - s.cost).toFixed(1) : null,
            ev_positive:    r.avg_return_from_t30 != null ? (r.avg_return_from_t30 - s.cost) > 0 : null,
          })),
        });

        return {
          threshold: `t30 between +${minPct}% and +${maxPct}%`,
          all_cohort:       fmt(allRow),
          sol_gte_80_cohort: fmt(hqRow),
          by_label: byLabel.map((r: any) => ({ label: r.label, ...fmt(r) })),
        };
      };

      const filterData = {
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
          runFilter('sol>=80 AND t30 between +5% and +100%',                  'total_sol_raised>=80 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('holders>=10 AND t30 between +5% and +100%',               'holder_count>=10 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('sol>=70 AND holders>=10 AND t30<200%',                    'total_sol_raised>=70 AND holder_count>=10 AND pct_t30<200'),
          runFilter('sol>=84 AND holders>=15 AND top5>10%',                    'total_sol_raised>=84 AND holder_count>=15 AND top5_wallet_pct>10'),
          // bc_age + t30 combos — testing if older BCs + early momentum is best combo
          runFilter('bc_age>10min AND t30 +5% to +100%',                      'token_age_seconds>600 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('bc_age>10min AND holders>=10 AND t30 +5% to +100%',      'token_age_seconds>600 AND holder_count>=10 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('bc_age>10min AND sol>=80 AND t30 +5% to +100%',          'token_age_seconds>600 AND total_sol_raised>=80 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('bc_age>30min AND t30 +5% to +100%',                      'token_age_seconds>1800 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('bc_age>30min AND holders>=10 AND t30 +5% to +100%',      'token_age_seconds>1800 AND holder_count>=10 AND pct_t30>=5 AND pct_t30<=100'),
          // ── VELOCITY FILTERS ─────────────────────────────────────────
          // Data shows non-linear sweet spot: <5 sol/min = 20.7%, 10-20 = 65%, 50+ = 20%
          runFilter('bc_velocity<10 sol/min AND t30 +5% to +100%',           'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min<10 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('bc_velocity<20 sol/min AND t30 +5% to +100%',           'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min<20 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('bc_velocity<50 sol/min AND t30 +5% to +100%',           'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min<50 AND pct_t30>=5 AND pct_t30<=100'),
          // Sweet spot filters — the 10-20 sol/min range shows 65% win rate
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
          // Hypothesis: deeper pools = better execution + more real interest
          runFilter('liquidity>100 SOL AND t30 +5% to +100%',               'liquidity_sol_t30 IS NOT NULL AND liquidity_sol_t30>100 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('liquidity>150 SOL AND t30 +5% to +100%',               'liquidity_sol_t30 IS NOT NULL AND liquidity_sol_t30>150 AND pct_t30>=5 AND pct_t30<=100'),
          // ── FULL STACK COMBOS ─────────────────────────────────────────
          // These are the "trading bot candidate" filters — stack all proven signals
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
          // The "kitchen sink" — every signal stacked
          runFilter('velocity<20 AND liquidity>100 AND holders>=10 AND bc_age>10m AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min<20 AND liquidity_sol_t30>100 AND holder_count>=10 AND token_age_seconds>600 AND pct_t30>=5 AND pct_t30<=100'),
          // Looser velocity threshold combos
          runFilter('velocity<50 AND holders>=10 AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min<50 AND holder_count>=10 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('velocity<50 AND liquidity>100 AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min<50 AND liquidity_sol_t30>100 AND pct_t30>=5 AND pct_t30<=100'),
          runFilter('velocity<50 AND bc_age>10m AND holders>=10 AND t30 +5% to +100%',
            'bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min<50 AND token_age_seconds>600 AND holder_count>=10 AND pct_t30>=5 AND pct_t30<=100'),
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

        // ── STOP-LOSS SIMULATION ──────────────────────────────────────────────
        // If you enter at T+30 price and apply a stop-loss, does EV turn positive?
        // Uses T+60 and T+120 checkpoints to approximate stop triggers.
        // Limitation: intra-checkpoint dips are invisible → slightly optimistic.
        stop_loss_simulation: (() => {
          // simulate(minPct, maxPct, stopPct, extraWhere?, label?) — enter at T+30, stop out at stopPct loss
          // Uses granular checkpoints T+40/T+50/T+60/T+90/T+120/T+150/T+180/T+240 for accurate stop detection
          const stopCheckpoints = ['pct_t40', 'pct_t50', 'pct_t60', 'pct_t90', 'pct_t120', 'pct_t150', 'pct_t180', 'pct_t240'] as const;
          const simulate = (minPct: number, maxPct: number, stopPct: number, extraWhere?: string, label?: string) => {
            const whereExtra = extraWhere ? ` AND ${extraWhere}` : '';
            const rows = db.prepare(`
              SELECT label, pct_t30, ${stopCheckpoints.join(', ')}, pct_t300
              FROM graduation_momentum
              WHERE pct_t30 >= ${minPct} AND pct_t30 <= ${maxPct}
                AND pct_t30 IS NOT NULL AND pct_t300 IS NOT NULL${whereExtra}
            `).all() as any[];

            if (rows.length === 0) return null;

            let totalReturn = 0, stopped = 0, profitable = 0;
            for (const r of rows) {
              const stopLevelPct = ((1 + r.pct_t30 / 100) * (1 - stopPct / 100) - 1) * 100;
              let exitReturn = ((1 + r.pct_t300 / 100) / (1 + r.pct_t30 / 100) - 1) * 100;
              let wasStoppedOut = false;

              for (const cp of stopCheckpoints) {
                if (r[cp] != null && r[cp] <= stopLevelPct) {
                  exitReturn = -stopPct;
                  stopped++;
                  wasStoppedOut = true;
                  break;
                }
              }

              if (!wasStoppedOut) {
                exitReturn = ((1 + r.pct_t300 / 100) / (1 + r.pct_t30 / 100) - 1) * 100;
              }
              // Subtract round-trip costs from every trade
              exitReturn -= ROUND_TRIP_COST_PCT;
              totalReturn += exitReturn;
              if (exitReturn > 0) profitable++;
            }

            const n = rows.length;
            const avgReturn = totalReturn / n; // already cost-adjusted
            return {
              strategy: label || `t30 +${minPct}% to +${maxPct}%`,
              stop_loss_pct: stopPct,
              n,
              stopped_count: stopped,
              stopped_pct: +(stopped / n * 100).toFixed(1),
              profitable_count: profitable,
              profitable_rate_pct: +(profitable / n * 100).toFixed(1),
              avg_return_pct: +avgReturn.toFixed(1),
              ev_positive: avgReturn > 0,
              cost_per_trade_pct: ROUND_TRIP_COST_PCT,
              costs_included: true,
            };
          };

          return {
            note: 'Enter at T+30, apply stop-loss. Granular checkpoints T+40 through T+240 for stop detection. Combo filters test the top-performing strategies.',
            // Basic t30 range filters
            basic: [
              simulate(5,  100, 10),
              simulate(5,  100, 15),
              simulate(5,  100, 20),
              simulate(5,   50, 15),
              simulate(5,   50, 20),
              simulate(10, 100, 10),
              simulate(10, 100, 15),
              simulate(10, 100, 20),
            ].filter(Boolean),
            // Velocity sweet spot combos — the top performers
            velocity_combos: [
              simulate(5, 100, 10, 'bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<20',  'vel 5-20 + t30 +5-100% @ 10% SL'),
              simulate(5, 100, 15, 'bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<20',  'vel 5-20 + t30 +5-100% @ 15% SL'),
              simulate(5, 100, 20, 'bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<20',  'vel 5-20 + t30 +5-100% @ 20% SL'),
              simulate(5, 100, 25, 'bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<20',  'vel 5-20 + t30 +5-100% @ 25% SL'),
              simulate(5, 100, 10, 'bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<50',  'vel 5-50 + t30 +5-100% @ 10% SL'),
              simulate(5, 100, 15, 'bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<50',  'vel 5-50 + t30 +5-100% @ 15% SL'),
              simulate(5, 100, 20, 'bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<50',  'vel 5-50 + t30 +5-100% @ 20% SL'),
              simulate(5, 100, 10, 'bc_velocity_sol_per_min<20',                                  'vel <20 + t30 +5-100% @ 10% SL'),
              simulate(5, 100, 15, 'bc_velocity_sol_per_min<20',                                  'vel <20 + t30 +5-100% @ 15% SL'),
              simulate(5, 100, 20, 'bc_velocity_sol_per_min<20',                                  'vel <20 + t30 +5-100% @ 20% SL'),
            ].filter(Boolean),
            // Multi-signal stacks
            stacked_combos: [
              simulate(5, 100, 10, 'bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<20 AND holder_count>=10', 'vel 5-20 + holders>=10 + t30 @ 10% SL'),
              simulate(5, 100, 15, 'bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<20 AND holder_count>=10', 'vel 5-20 + holders>=10 + t30 @ 15% SL'),
              simulate(5, 100, 20, 'bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<20 AND holder_count>=10', 'vel 5-20 + holders>=10 + t30 @ 20% SL'),
              simulate(5, 100, 10, 'bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<20 AND liquidity_sol_t30>100', 'vel 5-20 + liq>100 + t30 @ 10% SL'),
              simulate(5, 100, 15, 'bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<20 AND liquidity_sol_t30>100', 'vel 5-20 + liq>100 + t30 @ 15% SL'),
              simulate(5, 100, 10, 'bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<50 AND holder_count>=10', 'vel 5-50 + holders>=10 + t30 @ 10% SL'),
              simulate(5, 100, 15, 'bc_velocity_sol_per_min>=5 AND bc_velocity_sol_per_min<50 AND holder_count>=10', 'vel 5-50 + holders>=10 + t30 @ 15% SL'),
              simulate(5, 100, 10, 'bc_velocity_sol_per_min<20 AND token_age_seconds>600',       'vel <20 + bc_age>10m + t30 @ 10% SL'),
              simulate(5, 100, 15, 'bc_velocity_sol_per_min<20 AND token_age_seconds>600',       'vel <20 + bc_age>10m + t30 @ 15% SL'),
            ].filter(Boolean),
          };
        })(),

        sol_raised_distribution: solBuckets.map((b: any) => ({
          bucket: b.bucket, total: b.total, pump: b.pump, dump: b.dump,
          win_rate_pct: winRate(b.pump, b.total),
        })),

        bc_velocity_distribution: (() => {
          const velBuckets = db.prepare(`
            SELECT
              CASE
                WHEN bc_velocity_sol_per_min IS NULL   THEN 'null'
                WHEN bc_velocity_sol_per_min < 5       THEN '<5 sol/min'
                WHEN bc_velocity_sol_per_min < 10      THEN '5-10 sol/min'
                WHEN bc_velocity_sol_per_min < 20      THEN '10-20 sol/min'
                WHEN bc_velocity_sol_per_min < 50      THEN '20-50 sol/min'
                ELSE '50+ sol/min'
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
                   bc_velocity_sol_per_min, pct_t300
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
              avg_bc_velocity: avg(subset.filter((r: any) => r.bc_velocity_sol_per_min != null).map((r: any) => r.bc_velocity_sol_per_min)),
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
            note: 'Metrics at T+30 decision point. volatility = price range in first 30s. slippage = estimated cost for 0.5 SOL buy. bc_velocity = how fast the bonding curve filled.',
            samples: rows.length,
            by_label: [byLabel('PUMP'), byLabel('DUMP'), byLabel('STABLE')].filter(Boolean),
            win_rate_by_volatility: volBuckets,
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
