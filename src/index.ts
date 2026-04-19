import express from 'express';
import { Connection, PublicKey } from '@solana/web3.js';
import { initDatabase } from './db/schema';
import { getGraduationCount, getTradeStats, getTradeStatsByStrategy, getRecentTrades, getRecentSkips, getSkipReasonCounts, insertBotError, updateMomentumEnrichment, updateGraduationEnrichment, computeCreatorReputation, updateMomentumReputation } from './db/queries';
import { GraduationListener } from './monitor/graduation-listener';
import { renderThesisHtml, renderFilterHtml, renderPricePathHtml, renderFilterV2Html, renderTradingHtml, renderPeakAnalysisHtml, renderExitSimHtml } from './utils/html-renderer';
import { computePeakAnalysis } from './api/peak-analysis';
import { computeExitSim } from './api/exit-sim';
import { computeFilterV2Data } from './api/filter-v2-data';
import { computeTradingData } from './api/trading-data';
import { getHeavyData } from './api/heavy-cache';
import { StrategyManager } from './trading';
import { StrategyParams } from './trading/config';
import { makeLogger, logBuffer } from './utils/logger';
import { registerApiRoutes } from './api/routes';
import { GistSync } from './api/gist-sync';
import { FILTER_CATALOG, computeBestCombos } from './api/aggregates';
import { computePanel11 } from './api/panel11';
import { HolderEnrichment } from './collector/holder-enrichment';

const logger = makeLogger('main');

// Send JSON as a browser-friendly HTML page (with copy button) when Accept: text/html,
// otherwise return plain JSON for API/curl clients.
// Navigation links for the dashboard (excludes reset for safety)
const NAV_LINKS = [
  { path: '/dashboard', label: 'Dashboard' },
  { path: '/thesis', label: 'Thesis' },
  { path: '/filter-analysis', label: 'Filters' },
  { path: '/filter-analysis-v2', label: 'Filters V2' },
  { path: '/peak-analysis', label: 'Peak Analysis' },
  { path: '/price-path', label: 'Price Path' },
  { path: '/tokens?label=PUMP&min_sol=80', label: 'Tokens' },
  { path: '/trading', label: 'Trading' },
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
let cachedTopPairs: any[] | null = null;

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
  const healthPort = parseInt(process.env.PORT || process.env.HEALTH_PORT || '8080', 10);
  const app = express();
  app.use(express.json());

  // Graduation listener (declared early so both /api routes and legacy
  // HTML routes can capture it by closure; assigned later in main()).
  let listener: GraduationListener | null = null;

  // Self-service JSON API — /api/diagnose, /api/snapshot, /api/best-combos,
  // etc. Registered before the legacy HTML routes so they take precedence
  // on the /api/* prefix. See src/api/routes.ts.
  registerApiRoutes({
    app,
    db,
    logBuffer,
    startTime,
    getListenerStats: () => listener?.getStats() ?? null,
    getStrategyManager: () => strategyManager,
  });

  // Crash capture — record uncaught exceptions and unhandled rejections to
  // the bot_errors table so /api/snapshot.last_error can surface them even
  // after a restart. Do this once at boot, not per-route.
  const recordCrash = (level: string, name: string, err: unknown): void => {
    try {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      insertBotError(db, {
        ts: Date.now(),
        level,
        name,
        message,
        stack,
        git_sha: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_SHA ?? undefined,
      });
    } catch {
      // Never let the crash handler itself throw.
    }
  };
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception');
    recordCrash('fatal', 'uncaughtException', err);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
    recordCrash('error', 'unhandledRejection', reason);
  });

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
  // WALLET ADDRESS BACKFILL
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  let walletBackfillRunning = false;

  app.get('/backfill-wallets', async (req, res) => {
    if (walletBackfillRunning) {
      sendJsonOrHtml(req, res, { status: 'already_running', message: 'Wallet backfill is already in progress.' });
      return;
    }

    const rpcUrl = process.env.HELIUS_RPC_URL;
    if (!rpcUrl) {
      res.status(500).json({ error: 'HELIUS_RPC_URL not configured' });
      return;
    }

    // Find all rows missing creator_wallet_address (the primary target).
    // Also backfill dev_wallet_address where missing.
    const candidates = db.prepare(`
      SELECT gm.graduation_id, g.mint, g.bonding_curve_address,
             g.timestamp as grad_timestamp,
             gm.dev_wallet_address, gm.creator_wallet_address
      FROM graduation_momentum gm
      JOIN graduations g ON g.id = gm.graduation_id
      WHERE gm.creator_wallet_address IS NULL
         OR gm.dev_wallet_address IS NULL
    `).all() as Array<{
      graduation_id: number; mint: string; bonding_curve_address: string | null;
      grad_timestamp: number; dev_wallet_address: string | null; creator_wallet_address: string | null;
    }>;

    if (candidates.length === 0) {
      sendJsonOrHtml(req, res, { status: 'done', message: 'All rows already have wallet addresses.' });
      return;
    }

    sendJsonOrHtml(req, res, {
      status: 'started',
      total_to_backfill: candidates.length,
      message: `Backfilling wallet addresses for ${candidates.length} rows in background (~3 RPC calls/row, throttled)...`,
    });

    walletBackfillRunning = true;
    const conn = new Connection(rpcUrl, { commitment: 'confirmed' });
    const enricher = new HolderEnrichment(conn);

    let devResolved = 0;
    let creatorResolved = 0;
    let reputationComputed = 0;
    let failed = 0;

    (async () => {
      for (const row of candidates) {
        try {
          // ── Dev wallet address (if missing) ──
          if (!row.dev_wallet_address && row.mint) {
            try {
              const largestAccounts = await conn.getTokenLargestAccounts(
                new PublicKey(row.mint), 'confirmed'
              );
              if (largestAccounts.value && largestAccounts.value.length > 0) {
                const sorted = [...largestAccounts.value].sort((a, b) =>
                  (parseInt(b.amount, 10) || 0) - (parseInt(a.amount, 10) || 0)
                );
                const PUMP_TOTAL_SUPPLY_RAW = 1_000_000_000_000_000;
                const INFRA_THRESHOLD = PUMP_TOTAL_SUPPLY_RAW * 0.15;
                const realHolders = sorted.filter(acc => {
                  const amt = parseInt(acc.amount, 10) || 0;
                  return amt > 0 && amt < INFRA_THRESHOLD;
                });
                if (realHolders.length > 0) {
                  const parsedAcct = await conn.getParsedAccountInfo(realHolders[0].address);
                  const parsed = parsedAcct?.value?.data;
                  if (parsed && typeof parsed === 'object' && 'parsed' in parsed) {
                    const devAddr = (parsed as any).parsed?.info?.owner;
                    if (devAddr) {
                      updateMomentumEnrichment(db, row.graduation_id, { dev_wallet_address: devAddr });
                      updateGraduationEnrichment(db, row.graduation_id, { dev_wallet_address: devAddr });
                      devResolved++;
                    }
                  }
                }
              }
            } catch (devErr) {
              logger.debug('Wallet backfill: dev wallet failed for grad %d: %s',
                row.graduation_id, devErr instanceof Error ? devErr.message : String(devErr));
            }
            await new Promise(r => setTimeout(r, 200));
          }

          // ── Creator wallet address (if missing) ──
          if (!row.creator_wallet_address && row.bonding_curve_address) {
            try {
              const bcResult = await enricher.getBondingCurveCreationTime(
                new PublicKey(row.bonding_curve_address)
              );
              if (bcResult) {
                const creator = await enricher.getCreatorWallet(bcResult.oldestSignature);
                if (creator) {
                  updateMomentumEnrichment(db, row.graduation_id, { creator_wallet_address: creator });
                  updateGraduationEnrichment(db, row.graduation_id, { creator_wallet_address: creator });
                  creatorResolved++;

                  // Compute reputation now that we have the creator wallet
                  if (row.grad_timestamp) {
                    const rep = computeCreatorReputation(db, creator, row.grad_timestamp);
                    updateMomentumReputation(db, row.graduation_id, rep);
                    if (rep.priorCount > 0) reputationComputed++;
                  }
                }
              }
            } catch (creatorErr) {
              logger.debug('Wallet backfill: creator wallet failed for grad %d: %s',
                row.graduation_id, creatorErr instanceof Error ? creatorErr.message : String(creatorErr));
            }
            await new Promise(r => setTimeout(r, 300));
          }
        } catch (err) {
          failed++;
          logger.warn('Wallet backfill failed for grad %d: %s', row.graduation_id,
            err instanceof Error ? err.message : String(err));
        }
      }

      // Second pass: recompute reputation for ALL rows that have creator_wallet_address
      // now that more addresses are filled in. Earlier rows may now have priors.
      try {
        const allWithCreator = db.prepare(`
          SELECT gm.graduation_id, gm.creator_wallet_address, g.timestamp as grad_timestamp
          FROM graduation_momentum gm
          JOIN graduations g ON g.id = gm.graduation_id
          WHERE gm.creator_wallet_address IS NOT NULL
          ORDER BY g.timestamp ASC
        `).all() as Array<{ graduation_id: number; creator_wallet_address: string; grad_timestamp: number }>;

        let repUpdated = 0;
        for (const row of allWithCreator) {
          const rep = computeCreatorReputation(db, row.creator_wallet_address, row.grad_timestamp);
          updateMomentumReputation(db, row.graduation_id, rep);
          repUpdated++;
        }
        logger.info({ repUpdated }, 'Wallet backfill: reputation recomputed for all rows');
      } catch (repErr) {
        logger.warn('Wallet backfill: reputation recompute failed: %s',
          repErr instanceof Error ? repErr.message : String(repErr));
      }

      walletBackfillRunning = false;
      logger.info(
        { devResolved, creatorResolved, reputationComputed, failed, total: candidates.length },
        'Wallet backfill complete'
      );
    })().catch((err) => {
      walletBackfillRunning = false;
      logger.error('Wallet backfill crashed: %s', err instanceof Error ? err.message : String(err));
    });
  });

  app.get('/backfill-wallets/status', (req, res) => {
    const nullCreator = (db.prepare(
      'SELECT COUNT(*) as n FROM graduation_momentum WHERE creator_wallet_address IS NULL'
    ).get() as any).n;
    const nullDev = (db.prepare(
      'SELECT COUNT(*) as n FROM graduation_momentum WHERE dev_wallet_address IS NULL'
    ).get() as any).n;
    const hasCreator = (db.prepare(
      'SELECT COUNT(*) as n FROM graduation_momentum WHERE creator_wallet_address IS NOT NULL'
    ).get() as any).n;
    const hasDev = (db.prepare(
      'SELECT COUNT(*) as n FROM graduation_momentum WHERE dev_wallet_address IS NOT NULL'
    ).get() as any).n;
    const hasReputation = (db.prepare(
      'SELECT COUNT(*) as n FROM graduation_momentum WHERE creator_prior_token_count IS NOT NULL'
    ).get() as any).n;
    const total = (db.prepare('SELECT COUNT(*) as n FROM graduation_momentum').get() as any).n;

    sendJsonOrHtml(req, res, {
      backfill_running: walletBackfillRunning,
      dev_wallet: { has: hasDev, missing: nullDev, coverage_pct: total > 0 ? +((hasDev / total) * 100).toFixed(1) : 0 },
      creator_wallet: { has: hasCreator, missing: nullCreator, coverage_pct: total > 0 ? +((hasCreator / total) * 100).toFixed(1) : 0 },
      reputation: { has: hasReputation, coverage_pct: total > 0 ? +((hasReputation / total) * 100).toFixed(1) : 0 },
      total_rows: total,
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

      // Multi-horizon counts (PUMP rate at T+60 and T+120). label is T+300.
      const horizonCounts = db.prepare(`
        SELECT
          SUM(CASE WHEN label_t60  = 'PUMP' THEN 1 ELSE 0 END) AS pump_t60,
          SUM(CASE WHEN label_t60  IS NOT NULL THEN 1 ELSE 0 END) AS total_t60,
          SUM(CASE WHEN label_t120 = 'PUMP' THEN 1 ELSE 0 END) AS pump_t120,
          SUM(CASE WHEN label_t120 IS NOT NULL THEN 1 ELSE 0 END) AS total_t120
        FROM graduation_momentum
      `).get() as { pump_t60: number; total_t60: number; pump_t120: number; total_t120: number };
      const winRateT60 = horizonCounts.total_t60 > 0
        ? (horizonCounts.pump_t60 / horizonCounts.total_t60 * 100).toFixed(1)
        : '—';
      const winRateT120 = horizonCounts.total_t120 > 0
        ? (horizonCounts.pump_t120 / horizonCounts.total_t120 * 100).toFixed(1)
        : '—';

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
    <div class="stat"><span class="label">Raw Win Rate T+60</span><span class="value ${typeof winRateT60 === 'string' && winRateT60 !== '—' && +winRateT60 > 50 ? 'green' : 'yellow'}">${winRateT60}% (n=${horizonCounts.total_t60 ?? 0})</span></div>
    <div class="stat"><span class="label">Raw Win Rate T+120</span><span class="value ${typeof winRateT120 === 'string' && winRateT120 !== '—' && +winRateT120 > 50 ? 'green' : 'yellow'}">${winRateT120}% (n=${horizonCounts.total_t120 ?? 0})</span></div>
    <div class="stat"><span class="label">Raw Win Rate T+300</span><span class="value ${+winRate > 50 ? 'green' : 'yellow'}">${winRate}% (n=${totalLabeled})</span></div>
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

      // Multi-horizon PUMP rates for the scorecard (T+60 and T+120). label is T+300.
      const snapshotHorizonCounts = db.prepare(`
        SELECT
          SUM(CASE WHEN label_t60  = 'PUMP' THEN 1 ELSE 0 END) AS pump_t60,
          SUM(CASE WHEN label_t60  IS NOT NULL THEN 1 ELSE 0 END) AS total_t60,
          SUM(CASE WHEN label_t120 = 'PUMP' THEN 1 ELSE 0 END) AS pump_t120,
          SUM(CASE WHEN label_t120 IS NOT NULL THEN 1 ELSE 0 END) AS total_t120
        FROM graduation_momentum
        WHERE total_sol_raised >= 50
      `).get() as { pump_t60: number; total_t60: number; pump_t120: number; total_t120: number };
      const rawWinRateT60 = snapshotHorizonCounts.total_t60 > 0
        ? +(snapshotHorizonCounts.pump_t60 / snapshotHorizonCounts.total_t60 * 100).toFixed(1)
        : null;
      const rawWinRateT120 = snapshotHorizonCounts.total_t120 > 0
        ? +(snapshotHorizonCounts.pump_t120 / snapshotHorizonCounts.total_t120 * 100).toFixed(1)
        : null;

      const totalLabeledFiltered = labelsFiltered.reduce((s: number, l: any) => s + l.count, 0);
      const pumpFiltered = labelsFiltered.find((l: any) => l.label === 'PUMP')?.count || 0;
      const filteredWinRate = totalLabeledFiltered > 0 ? +(pumpFiltered / totalLabeledFiltered * 100).toFixed(1) : null;

      // ── BEST FILTER (ranked by sim return: 10%SL/50%TP from T+30 entry gate) ──
      // Same cost model as /api/best-combos: enter at T+30 (+5%→+100% gate), 10%SL/50%TP,
      // 30% SL gap penalty (recalibrated 2026-04-15), 10% TP gap penalty, per-token round-trip slippage (fallback 3%).
      let bestFilter: { name: string; rule: string; win_rate: number; sim_avg_return: number | null; sample_size: number } | null = null;
      if (totalLabeled >= 5) {
        const SL_G = 0.30, TP_G = 0.10, DEF_COST = 3.0;  // SL gap recalibrated 2026-04-15
        // Every 5s from T+60 through T+295 (then pct_t300 fall-through). Pre-rollout
        // rows have NULLs past the old sparse set; the walk skips NULLs at line 880.
        const simCols: readonly `pct_t${number}`[] = (() => {
          const cps: `pct_t${number}`[] = [];
          for (let sec = 60; sec <= 295; sec += 5) cps.push(`pct_t${sec}` as const);
          return cps;
        })();
        const filterTests = [
          // Current baseline + top candidates (per CLAUDE.md research state)
          { name: 'vel<20 + top5<10%',        sql: "bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min < 20 AND top5_wallet_pct IS NOT NULL AND top5_wallet_pct < 10" },
          { name: 'vel 10-20 + top5<10%',     sql: "bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min >= 10 AND bc_velocity_sol_per_min < 20 AND top5_wallet_pct IS NOT NULL AND top5_wallet_pct < 10" },
          { name: 'holders>=18 + top5<10%',   sql: "holder_count IS NOT NULL AND holder_count >= 18 AND top5_wallet_pct IS NOT NULL AND top5_wallet_pct < 10" },
          { name: 'vel 10-20 + buy_ratio>0.6', sql: "bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min >= 10 AND bc_velocity_sol_per_min < 20 AND buy_pressure_buy_ratio IS NOT NULL AND buy_pressure_buy_ratio > 0.6" },
          // Single filters and legacy candidates
          { name: 'top5<10%',                 sql: "top5_wallet_pct IS NOT NULL AND top5_wallet_pct < 10" },
          { name: 'top5<20%',                 sql: "top5_wallet_pct IS NOT NULL AND top5_wallet_pct < 20" },
          { name: 'vel 5-20',                 sql: "bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min >= 5 AND bc_velocity_sol_per_min < 20" },
          { name: 'vel<20',                   sql: "bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min < 20" },
          { name: 'holders>=18',              sql: "holder_count IS NOT NULL AND holder_count >= 18" },
          { name: 'bc_age>30min',             sql: "token_age_seconds > 1800" },
          { name: 'dev_wallet_pct<5%',        sql: "dev_wallet_pct IS NOT NULL AND dev_wallet_pct < 5" },
        ];
        for (const ft of filterTests) {
          // Fetch tokens matching filter + T+30 entry gate with price checkpoints
          const rows = db.prepare(`
            SELECT pct_t30, ${simCols.join(', ')}, pct_t300,
                   round_trip_slippage_pct, label
            FROM graduation_momentum
            WHERE label IS NOT NULL
              AND pct_t30 IS NOT NULL AND pct_t30 >= 5 AND pct_t30 <= 100
              AND ${ft.sql}
          `).all() as any[];
          if (rows.length < 3) continue;
          let simTotal = 0, simN = 0, pumps = 0;
          for (const r of rows) {
            if (r.label === 'PUMP') pumps++;
            const ep: number = r.pct_t30;
            const cost: number = r.round_trip_slippage_pct ?? DEF_COST;
            const openM = 1 + ep / 100;
            const slLvl = (openM * 0.9 - 1) * 100;
            const tpLvl = (openM * 1.5 - 1) * 100;
            let exit: number | null = null;
            for (const col of simCols) {
              const cv: number | null = r[col];
              if (cv == null) continue;
              if (cv <= slLvl) {
                // Price-multiplier SL (mirrors trade-logger.ts:112)
                const exitRatio = (1 + cv / 100) * (1 - SL_G);
                exit = (exitRatio / openM - 1) * 100;
                break;
              }
              if (cv >= tpLvl) { exit = 50 * (1 - TP_G); break; }
            }
            if (exit == null) {
              exit = r.pct_t300 != null
                ? ((1 + r.pct_t300 / 100) / (1 + ep / 100) - 1) * 100
                : -100;
            }
            simTotal += exit - cost;
            simN++;
          }
          if (simN < 3) continue;
          const wr = +(pumps / rows.length * 100).toFixed(1);
          const simAvgReturn = +(simTotal / simN).toFixed(2);
          if (!bestFilter || simAvgReturn > (bestFilter.sim_avg_return ?? -Infinity)) {
            bestFilter = { name: ft.name, rule: ft.sql, win_rate: wr, sim_avg_return: simAvgReturn, sample_size: simN };
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

      // ── BASELINE SIGNAL SUMMARY: vel<20 + top5<10% + T+30 entry gate ──
      // Shows live stats for the current promoted baseline filter.
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
          AND bc_velocity_sol_per_min IS NOT NULL AND bc_velocity_sol_per_min < 20
          AND top5_wallet_pct IS NOT NULL AND top5_wallet_pct < 10
      `).get() as any;
      // t30ProfitableRate: % of trades profitable when entering at T+30 (raw, pre-SL/TP)
      const t30ProfitableRate = t30Signal.n_with_t30 > 0
        ? +(t30Signal.profitable_from_t30 / t30Signal.n_with_t30 * 100).toFixed(1)
        : null;
      const t30WinRate = t30Signal.n > 0 ? +(t30Signal.pump / t30Signal.n * 100).toFixed(1) : null;

      // ── VERDICT ──
      // Current baseline: vel<20 + top5<10%, sim +6.44%, n=111, win rate 72.1%, STABLE (promoted 2026-04-12)
      const BASELINE_SIM_RETURN = 6.44;
      const BASELINE_FILTER = 'vel<20 + top5<10%';
      const bestSimReturn = bestFilter?.sim_avg_return ?? null;
      const verdict = totalLabeled < 10
        ? `COLLECTING DATA — ${totalLabeled}/30 labeled (${samplesRemaining} more needed)`
        : totalLabeled < 30
        ? `COLLECTING — ${totalLabeled}/30 labeled, raw win rate ${rawWinRate}%`
        : (bestSimReturn !== null && (bestFilter?.sample_size ?? 0) >= 100 && bestSimReturn > BASELINE_SIM_RETURN + 0.3)
        ? `NEW LEADER — ${bestFilter!.name} sim ${bestSimReturn > 0 ? '+' : ''}${bestSimReturn}% (n=${bestFilter!.sample_size}, win rate ${bestFilter!.win_rate}%) beats baseline +${BASELINE_SIM_RETURN}% by +${(bestSimReturn - BASELINE_SIM_RETURN).toFixed(2)}pp. Run regime check (/filter-analysis-v2 Panel 11).`
        : `BASELINE ESTABLISHED — ${BASELINE_FILTER} sim +${BASELINE_SIM_RETURN}%, n=111, win rate 72.1%, STABLE regime (promoted 2026-04-12). Promotion bar: beat +${(BASELINE_SIM_RETURN + 0.3).toFixed(2)}% on n≥100 with regime std-dev < 15%.${bestSimReturn !== null ? ` Live best: ${bestFilter!.name} sim ${bestSimReturn > 0 ? '+' : ''}${bestSimReturn}% (n=${bestFilter!.sample_size})` : ''}`;

      // ── CODE VERSION ──
      const codeVersion = {
        version: 'thesis-page-v2-baseline-reflect',
        thesis: 'Baseline established: vel<20 + top5<10% sim +6.44%, n=111, win rate 72.1%, STABLE regime (promoted 2026-04-12). Next candidates: vel 10-20 + top5<10% (n=51, sim +8.08%), vel 10-20 + buy_ratio>0.6 (n=33, sim +8.90%). Need n≥100 + sim>+6.74% + STABLE regime to promote.',
        last_change: 'Thesis page now reflects actual research state: (1) Best Filter ranked by sim return (10%SL/50%TP + costs) instead of raw T+30 profitable rate. (2) filterTests updated with current baseline combo (vel<20+top5<10%) and top candidates. (3) T+30 signal card now shows live stats for baseline filter instead of holders>=10. (4) Verdict logic reflects BASELINE ESTABLISHED vs searching for improvement.',
        watch_for: 'Best Filter on scorecard should show vel<20+top5<10% with sim return near +6.44% (or higher if a candidate is now beating it). Baseline Signal card should show n growing as more data is collected. If sim return deviates significantly from +6.44%, check /api/best-combos for the authoritative leaderboard.',
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
          raw_win_rate_t60_pct: rawWinRateT60,
          raw_win_rate_t120_pct: rawWinRateT120,
          raw_win_rate_t300_pct: rawWinRate,
          horizon_labeled_counts: {
            t60: snapshotHorizonCounts.total_t60 ?? 0,
            t120: snapshotHorizonCounts.total_t120 ?? 0,
            t300: totalLabeled,
          },
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

        // ── BASELINE SIGNAL (live stats for current promoted baseline) ──
        t30_momentum_signal: {
          filter: 'vel<20 + top5<10% + t30 +5%→+100%',
          n: t30Signal.n,
          n_with_t30_data: t30Signal.n_with_t30,
          pump_label_count: t30Signal.pump,
          dump_label_count: t30Signal.dump,
          win_rate_from_t0_pct: t30WinRate,
          t30_profitable_rate_pct: t30ProfitableRate,
          t30_avg_return_pct: t30Signal.avg_return_from_t30,
          avg_t300_pct: t30Signal.avg_t300,
          note: 'Live stats for current baseline filter (vel<20 + top5<10% + T+30 entry gate). t30_profitable_rate_pct = raw % profitable at T+300 (pre-SL/TP). Sim return (+6.44% on n=111) is in Best Filter card above.',
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
        data_quality: (() => {
          // Full 5s grid coverage — what share of complete observations have every
          // pct_tN from t5..t300 populated? Pre-rollout rows miss t65..t295.
          const gridNotNull = (() => {
            const parts: string[] = [];
            for (let sec = 5; sec <= 300; sec += 5) parts.push(`pct_t${sec} IS NOT NULL`);
            return parts.join(' AND ');
          })();
          const fullGrid = (db.prepare(
            `SELECT COUNT(*) AS n FROM graduation_momentum WHERE ${gridNotNull}`,
          ).get() as { n: number }).n;
          const completeObs = (db.prepare(
            'SELECT COUNT(*) AS n FROM graduation_momentum WHERE pct_t300 IS NOT NULL',
          ).get() as { n: number }).n;
          const fullGridPct = completeObs > 0 ? +(fullGrid / completeObs * 100).toFixed(1) : null;
          return {
            price_source_pumpswap: allHavePumpswapPool,
            null_fields_in_last_10: nullsInLast10.length > 0 ? nullsInLast10 : 'CLEAN',
            last_grad_seconds_ago: lastGradSecondsAgo,
            listener_connected: listenerStats?.wsConnected ?? false,
            full_5s_grid_count: fullGrid,
            complete_observations_count: completeObs,
            full_5s_grid_pct: fullGridPct,
          };
        })(),

        // ── PATH DATA SUMMARY ──
        path_data_summary: (() => {
          const complete5s = (db.prepare(
            'SELECT COUNT(*) as n FROM graduation_momentum WHERE pct_t5 IS NOT NULL AND pct_t60 IS NOT NULL'
          ).get() as any)?.n ?? 0;

          // Best entry time: T+N with highest avg return at 10%SL/50%TP (n>=20)
          let bestTime: string | null = null;
          let bestRet: number | null = null;
          const SL_G = 0.30, TP_G = 0.10, DEF_COST = 3.0;  // SL gap recalibrated 2026-04-15
          const entryTimes = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60] as const;
          // Entry points: T+5..T+60. Exit walk: every 5s through T+295 so post-entry
          // simulation uses the full grid on new-schema rows (pre-rollout rows skip NULLs).
          const checkCols: readonly `pct_t${number}`[] = (() => {
            const cps: `pct_t${number}`[] = [];
            for (let sec = 5; sec <= 295; sec += 5) cps.push(`pct_t${sec}` as const);
            return cps;
          })();
          const allSim = db.prepare(`
            SELECT round_trip_slippage_pct,
                   ${checkCols.join(', ')}, pct_t300
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
                if (cv <= slLvl) {
                  // Price-multiplier SL (mirrors trade-logger.ts:112)
                  const exitRatio = (1 + cv / 100) * (1 - SL_G);
                  exit = (exitRatio / openM - 1) * 100;
                  break;
                }
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
          // Every 5s from T+40 to T+295. Pre-rollout rows have NULL past the old sparse set; walk skips NULLs.
          const stopCheckpoints: readonly `pct_t${number}`[] = (() => {
            const cps: `pct_t${number}`[] = [];
            for (let sec = 40; sec <= 295; sec += 5) cps.push(`pct_t${sec}` as const);
            return cps;
          })();
          // Gap penalties for thin-pool execution reality
          // Recalibrated 2026-04-15: live SL fills realize at -34% to -40% vs -28% (10*1.2) sim estimate
          const SL_GAP_PENALTY_PCT = 0.30; // SL fills 30% worse than target (adverse gap-through)
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
                  // Price-multiplier SL (mirrors trade-logger.ts:112)
                  const entryRatio = 1 + r.pct_t30 / 100;
                  const exitRatio = (1 + r[cp] / 100) * (1 - SL_GAP_PENALTY_PCT);
                  exitReturn = (exitRatio / entryRatio - 1) * 100;
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
              stop_gap_penalty: `${(SL_GAP_PENALTY_PCT * 100).toFixed(0)}% price-multiplier (mirrors trade-logger)`,
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
                  // Price-multiplier SL (mirrors trade-logger.ts:112)
                  const entryRatio = 1 + r.pct_t30 / 100;
                  const exitRatio = (1 + r[cp] / 100) * (1 - SL_GAP_PENALTY_PCT);
                  exitReturn = (exitRatio / entryRatio - 1) * 100;
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
            note: 'TP+SL combos only (SL-only strategies confirmed negative EV at n=630+). SL: 30% adverse gap (recalibrated 2026-04-15). TP: 10% adverse gap. Round-trip slippage applied to all exits.',
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
          // Every 5s from T+40 to T+295 (pre-rollout rows skipped via null-check).
          const stopCheckpoints: readonly `pct_t${number}`[] = (() => {
            const cps: `pct_t${number}`[] = [];
            for (let sec = 40; sec <= 295; sec += 5) cps.push(`pct_t${sec}` as const);
            return cps;
          })();
          const SL_GAP_PENALTY_PCT = 0.30; // recalibrated 2026-04-15
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
                    // Price-multiplier SL (mirrors trade-logger.ts:112)
                    const entryRatio = 1 + r.pct_t30 / 100;
                    const exitRatio = (1 + r[cp] / 100) * (1 - SL_GAP_PENALTY_PCT);
                    exitReturn = (exitRatio / entryRatio - 1) * 100;
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
  // All panel data is computed by computeFilterV2Data (src/api/filter-v2-data.ts)
  // so the same payload is served here, from /api/filter-v2 / /api/panelN, and
  // from the bot-status sync. The route just branches on Accept header.
  app.get('/filter-analysis-v2', (req, res) => {
    try {
      // Default path hits the 24h heavy cache (see src/api/heavy-cache.ts) so
      // a dashboard load costs ~50ms instead of ~100s. The `?p6=` power-user
      // slice still computes fresh since its input comes from the URL.
      const p6Raw = req.query.p6;
      const data = p6Raw !== undefined
        ? computeFilterV2Data(db, { p6Raw })
        : getHeavyData(db, strategyManager).v2;
      cachedTopPairs = data.panel6.top_pairs;
      const wantHtml = (req.headers.accept || '').includes('text/html');
      if (wantHtml) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderFilterV2Html(data));
      } else {
        res.json(data);
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── PRICE PATH ANALYSIS ──────────────────────────────────────────────────
  // renderPricePathHtml does its own DB scan (~40s at current data volume),
  // so the HTML output is cached alongside the other heavy payloads.
  app.get('/price-path', (_req, res) => {
    try {
      const { pricePathHtml } = getHeavyData(db, strategyManager);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(pricePathHtml);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── PEAK ANALYSIS (diagnostic, NOT a trading filter) ─────────────────────
  // Isolated page for max_relret_0_300 — TP calibration, exit timing, filter
  // quality scoring. Look-ahead metric, so kept out of all filter leaderboards.
  app.get('/peak-analysis', (req, res) => {
    try {
      const data = computePeakAnalysis(db);
      const wantHtml = (req.headers.accept || '').includes('text/html');
      if (wantHtml) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderPeakAnalysisHtml(data));
      } else {
        res.json(data);
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── EXIT-SIM (dynamic exit strategy dashboard) ───────────────────────────
  // Replays alternative exit logic (momentum reversal today; scale-out,
  // vol-trail, time-decayed TP in follow-ups) vs static 10%SL/50%TP on the
  // vel<20 + top5<10% universe.
  app.get('/exit-sim', (req, res) => {
    try {
      const data = computeExitSim(db);
      const wantHtml = (req.headers.accept || '').includes('text/html');
      if (wantHtml) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderExitSimHtml(data));
      } else {
        res.json(data);
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── TRADING DASHBOARD ────────────────────────────────────────────────────
  // Always computed fresh so the header strategy count + "DISABLED/PAPER"
  // mode reflect the live strategyManager. The heavy-cache pathway baked in
  // empty strategies/config at boot time, which left the dashboard stuck at
  // "DISABLED 0 strategies" even after strategies were upserted via
  // strategy-commands.json. computeTradingData's queries are all fast (<100ms
  // total); only top_pairs comes from the cached filter-v2 pass.
  app.get('/trading', (req, res) => {
    try {
      const strategyFilter = (req.query.strategy as string) || '';
      const data = computeTradingData(db, strategyManager, {
        strategyFilter,
        topPairs: cachedTopPairs || [],
      });
      const wantHtml = (req.headers.accept || '').includes('text/html');
      if (wantHtml) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderTradingHtml(data));
      } else {
        res.json(data);
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── STRATEGY API ENDPOINTS ──────────────────────────────────────────────
  app.get('/api/strategies', (_req, res) => {
    if (!strategyManager) return res.json({ strategies: [] });
    res.json({ strategies: strategyManager.getStrategies(), stats: strategyManager.getPerStrategyStats() });
  });

  app.post('/api/strategies', (req, res) => {
    if (!strategyManager) return res.status(400).json({ error: 'Trading not enabled' });
    try {
      const { id, label, params, enabled } = req.body;
      if (!id || !label || !params) return res.status(400).json({ error: 'id, label, and params are required' });
      strategyManager.upsertStrategy(id, label, params as StrategyParams, enabled !== false);
      res.json({ ok: true, strategy: strategyManager.getStrategy(id) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put('/api/strategies/:id', (req, res) => {
    if (!strategyManager) return res.status(400).json({ error: 'Trading not enabled' });
    try {
      const { id } = req.params;
      const { label, params, enabled } = req.body;
      const existing = strategyManager.getStrategy(id);
      if (!existing) return res.status(404).json({ error: `Strategy "${id}" not found` });
      strategyManager.upsertStrategy(
        id,
        label ?? existing.label,
        params ?? existing.params,
        enabled !== undefined ? enabled : existing.enabled,
      );
      res.json({ ok: true, strategy: strategyManager.getStrategy(id) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/strategies/:id', (req, res) => {
    if (!strategyManager) return res.status(400).json({ error: 'Trading not enabled' });
    const result = strategyManager.deleteStrategy(req.params.id);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
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

  // Gist sync — push diagnose/snapshot/best-combos to bot-status branch
  // every 2 min so Claude can self-serve via WebFetch / GitHub MCP tools.
  // Also polls for strategy-commands.json on main branch (inbound commands from Claude).
  let gistSync: GistSync | null = null;
  const githubToken = process.env.GITHUB_TOKEN;
  if (githubToken) {
    gistSync = new GistSync({
      db,
      logBuffer,
      startTime,
      getListenerStats: () => listener?.getStats() ?? null,
      token: githubToken,
    });
    gistSync.start().then(() => {
      const urls = gistSync!.getUrls();
      logger.info({ urls }, 'Status sync active — Claude can self-serve from these URLs');
      logger.info('GIST_DIAGNOSE_URL=' + urls.diagnose);
      logger.info('GIST_SNAPSHOT_URL=' + urls.snapshot);
      logger.info('GIST_BEST_COMBOS_URL=' + urls.best_combos);
      logger.info('GIST_HTML_URL=' + urls.branch_html);
    }).catch((err) => logger.error({ err }, 'Gist sync failed to start'));
  } else {
    logger.warn('GITHUB_TOKEN not set — Gist sync disabled. Add it to Railway env vars to enable self-service for Claude.');
  }

  // Start graduation listener (after Express so health endpoint is available)
  // Note: `listener` is declared earlier in main() so /api routes can reference it.
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

  // Initialize strategy manager (opt-in via TRADING_ENABLED=true)
  let strategyManager: StrategyManager | null = null;
  if (listener) {
    try {
      strategyManager = new StrategyManager(db, listener.getConnection());
      strategyManager.initialize();
      strategyManager.attachToPriceCollector(listener.getPriceCollector());
      // Refresh the PositionManager's Connection reference on every WS reconnect
      // so we never poll a dead RPC handle after a network blip.
      const sm = strategyManager;
      listener.onReconnect((conn) => {
        sm.updateConnection(conn);
        logger.info('StrategyManager Connection refreshed after listener reconnect');
      });
      // Wire up GistSync so inbound strategy commands are applied live
      if (gistSync) gistSync.setStrategyManager(strategyManager);
    } catch (err) {
      logger.error('StrategyManager failed to initialize: %s', err instanceof Error ? err.message : String(err));
    }
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    if (strategyManager) strategyManager.stop();
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
