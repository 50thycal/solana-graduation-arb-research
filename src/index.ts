import express from 'express';
import { initDatabase } from './db/schema';
import { getGraduationCount, insertBotError } from './db/queries';
import { GraduationListener } from './monitor/graduation-listener';
import {
  renderLiveTrainingHtml,
  renderSmartMoneyHtml,
  renderCopyTradesHtml,
  renderCopyV2Html,
} from './utils/html-renderer';
import { computeLiveTrainingData } from './api/live-training-data';
import { APP_ICON_PNG_BUFFER, ICON_HEAD_TAGS } from './utils/app-icon';
import { makeLogger, logBuffer } from './utils/logger';
import { installStderrThrottle } from './utils/stderr-throttle';
import { startEventLoopLagMonitor } from './utils/event-loop-lag-monitor';
import { registerApiRoutes } from './api/routes';
import { GistSync } from './api/gist-sync';
import { MarketDataFetcher } from './collector/market-data-fetcher';
import { CopytradeWorker } from './copytrade/worker';
import { TokenMetadataFetcher } from './copytrade/metadata-fetcher';
import { CopyFollowerProbe } from './copytrade/follower-probe';
import { LiveTapeHarvester } from './copytrade/live-tape-harvester';
import { CopyTrader, computeCopyTrades } from './copytrade/copy-trader';
import { computeWalletLeaderboardV2 } from './copytrade/leaderboard-v2';
import { getSmartMoneyAnalysis } from './copytrade/smart-money';

const logger = makeLogger('main');

// Dashboard nav — copy-trading-only build. The graduation-research dashboards
// (thesis, filter-analysis, price-path, exit-sim, regime, trading, report, …)
// were removed in the refactor; their findings are archived in
// docs/research-archive/.
const NAV_LINKS = [
  { path: '/copy-trades', label: 'Copy Trades' },
  { path: '/copy-v2', label: 'Copy V2' },
  { path: '/live-training', label: 'Live Training' },
  { path: '/smart-money', label: 'Smart Money' },
  { path: '/health', label: 'Health' },
];

// ── Response memoization ────────────────────────────────────────────────
// Tiny per-key TTL cache for HTML pages whose underlying data tolerates
// sub-minute staleness (/live-training). Keep this cache small and explicit —
// never auto-cache JSON API responses, which Claude polls for fresh data.
interface MemoEntry { value: string; contentType: string; expiresAt: number; }
const responseMemo = new Map<string, MemoEntry>();
function memoGet(key: string): MemoEntry | null {
  const e = responseMemo.get(key);
  if (!e) return null;
  if (Date.now() >= e.expiresAt) { responseMemo.delete(key); return null; }
  return e;
}
function memoSet(key: string, value: string, contentType: string, ttlMs: number): void {
  responseMemo.set(key, { value, contentType, expiresAt: Date.now() + ttlMs });
  if (responseMemo.size > 64) {
    const oldest = responseMemo.keys().next().value;
    if (oldest !== undefined) responseMemo.delete(oldest);
  }
}

function sendJsonOrHtml(req: express.Request, res: express.Response, data: object): void {
  const wantHtml = (req.headers.accept || '').includes('text/html');
  if (!wantHtml) { res.json(data); return; }
  const json = JSON.stringify(data, null, 2);
  const escaped = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const navHtml = NAV_LINKS.map(l =>
    l.path === req.path
      ? `<a class="nav-active">${l.label}</a>`
      : `<a href="${l.path}">${l.label}</a>`
  ).join('');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Copy Trading — ${req.path}</title>
${ICON_HEAD_TAGS}
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
  <span class="title">Copy Trading Bot</span>
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
  // Install stderr throttle BEFORE creating any Connection — rpc-websockets
  // writes "ws error:" lines straight to stderr, bypassing pino. Throttler keeps
  // one per 30s + a periodic summary.
  installStderrThrottle();

  // Event-loop lag sampler (1 Hz, 10-min ring buffer) — feeds snapshot.json.
  startEventLoopLagMonitor();

  logger.info('Starting solana-graduation-arb-research (copy-trading build)');
  logger.info({
    hasHeliusRpc: !!process.env.HELIUS_RPC_URL,
    hasHeliusWs: !!process.env.HELIUS_WS_URL,
    dataDir: process.env.DATA_DIR || './data',
    healthPort: process.env.HEALTH_PORT || '8080',
  }, 'Environment check');

  const dataDir = process.env.DATA_DIR || './data';
  const db = initDatabase(dataDir);

  const healthPort = parseInt(process.env.PORT || process.env.HEALTH_PORT || '8080', 10);
  const app = express();
  app.use(express.json());

  // Graduation listener (declared early so routes can capture it by closure;
  // assigned later in main()).
  let listener: GraduationListener | null = null;

  // Self-service JSON API — /api/diagnose, /api/snapshot, /api/skips, etc.
  // Registered before the HTML routes so they take precedence on /api/*.
  registerApiRoutes({
    app,
    db,
    logBuffer,
    startTime,
    getListenerStats: () => listener?.getStats() ?? null,
  });

  // Crash capture — record uncaught exceptions + unhandled rejections to the
  // bot_errors table so /api/snapshot.last_error surfaces them after a restart.
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

  // App icon for browsers + iOS "Add to Home Screen". Linked from every page
  // head via ICON_HEAD_TAGS (which cache-busts via ?v=N). Cache for a day but
  // allow revalidation — NOT `immutable`: an earlier deploy pinned a corrupt
  // PNG on devices for days because immutable is never revalidated.
  app.get(['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/favicon.png', '/favicon.ico'], (_req, res) => {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate');
    res.send(APP_ICON_PNG_BUFFER);
  });

  // Root → copy-trades (the primary page).
  app.get('/', (_req, res) => res.redirect('/copy-trades'));

  // ── /copy-trades ── shadow + live copy-trader positions (cheap SQL read).
  app.get('/copy-trades', (req, res) => {
    try {
      const wantHtml = (req.headers.accept || '').includes('text/html');
      const data = computeCopyTrades(db);
      if (wantHtml) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderCopyTradesHtml(data));
      } else {
        res.json(data);
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── /copy-v2 ── wallet leaderboard V2: ranks leads by REALIZED COPY NET
  // (copy_trades) instead of their own on-chain P&L, with a V1-vs-V2 head-to-head
  // (Option A from the 2026-06-29 audit). Read-only; V1 stays the live selector.
  // sendJsonOrHtml → browsers get the nav page, JSON pollers get raw data.
  app.get('/copy-v2', (req, res) => {
    try {
      const wantHtml = (req.headers.accept || '').includes('text/html');
      const data = computeWalletLeaderboardV2(db);
      if (wantHtml) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderCopyV2Html(data));
      } else {
        res.json(data);
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── /live-training ── live-money execution monitoring.
  app.get('/live-training', (req, res) => {
    try {
      const wantHtml = (req.headers.accept || '').includes('text/html')
        && (req.query.format as string) !== 'json';
      const memoKey = 'live-training:html';
      if (wantHtml) {
        const cached = memoGet(memoKey);
        if (cached) {
          res.setHeader('Content-Type', cached.contentType);
          res.send(cached.value);
          return;
        }
      }
      const data = computeLiveTrainingData(db);
      if (wantHtml) {
        const html = renderLiveTrainingHtml(data);
        memoSet(memoKey, html, 'text/html; charset=utf-8', 30_000);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
      } else {
        res.json(data);
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── /smart-money ── copy-trade Option B token-selection edge (cached read).
  app.get('/smart-money', (req, res) => {
    try {
      const wantHtml = (req.headers.accept || '').includes('text/html');
      const data = getSmartMoneyAnalysis(db);
      if (wantHtml) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderSmartMoneyHtml(data));
      } else {
        res.json(data);
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── /health ── fast health check with a 5s count cache + 250ms SQL timeout.
  let healthCountCache: { value: number; expiresAt: number } | null = null;
  function fastGraduationCount(): { count: number | null; degraded: boolean } {
    if (healthCountCache && Date.now() < healthCountCache.expiresAt) {
      return { count: healthCountCache.value, degraded: false };
    }
    try {
      const start = Date.now();
      const c = getGraduationCount(db);
      const elapsed = Date.now() - start;
      healthCountCache = { value: c, expiresAt: Date.now() + 5000 };
      return { count: c, degraded: elapsed > 250 };
    } catch {
      return { count: healthCountCache?.value ?? null, degraded: true };
    }
  }

  app.get('/health', (req, res) => {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const { count: graduationCount, degraded: countDegraded } = fastGraduationCount();
    const listenerStats = listener ? listener.getStats() : null;
    const status = countDegraded || listenerStatus !== 'running' ? 'degraded' : 'ok';

    sendJsonOrHtml(req, res, {
      status,
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

  // Gist sync — push diagnose/snapshot + copy/live JSON views to the bot-status
  // branch every 2 min so Claude can self-serve via WebFetch / GitHub MCP tools.
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
      logger.info('GIST_COPY_TRADES_URL=' + urls.copy_trades);
      logger.info('GIST_HTML_URL=' + urls.branch_html);
    }).catch((err) => logger.error({ err }, 'Gist sync failed to start'));
  } else {
    logger.warn('GITHUB_TOKEN not set — Gist sync disabled. Add it to Railway env vars to enable self-service for Claude.');
  }

  // Market data fetcher — daily SOL/USD + BTC/USD OHLC + Fear & Greed. Feeds the
  // copy-trade macro-regime gate. Standalone hourly cadence; free-tier endpoints.
  const marketDataFetcher = new MarketDataFetcher(db);
  marketDataFetcher.start().catch((err) =>
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'MarketDataFetcher initial start failed'),
  );

  // Start graduation listener (after Express so health endpoint is available).
  // Detection + wallet-discovery enrichment feed copy-trade discovery + the
  // copyable token universe. Price-path collection is OFF by default (see
  // GRADUATION_PRICE_PATH_ENABLED in price-collector.ts).
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

  // Copy-trade (Option B) wallet-intelligence worker. Default-ON (set
  // COPYTRADE_DISABLED=true to turn off). Seeds candidate wallets from existing
  // DB data and scores a small, credit-budgeted batch on a slow interval,
  // yielding to graduation detection via the shared RPC limiter.
  if (listener) {
    try {
      const copytradeWorker = new CopytradeWorker({
        db,
        getConnection: () => listener?.getConnection() ?? null,
      });
      copytradeWorker.start();
    } catch (err) {
      logger.warn('CopytradeWorker failed to start: %s', err instanceof Error ? err.message : String(err));
    }

    // Out-of-band token metadata capture (name/symbol/image/socials) for copied mints — feeds the
    // rug-signal dataset the on-chain chart-features miss. RPC-budgeted, never on the hot copy path.
    try {
      const metadataFetcher = new TokenMetadataFetcher({ db });
      metadataFetcher.start();
    } catch (err) {
      logger.warn('TokenMetadataFetcher failed to start: %s', err instanceof Error ? err.message : String(err));
    }

    // Copy-follower (Phase 2). The probe subscribes to the smart watchlist via
    // Helius transactionSubscribe (own WS); the CopyTrader turns those swaps
    // into shadow (and opt-in live_micro) copy positions and tracks them to
    // exit. Both default-on (COPY_FOLLOWER_DISABLED / COPY_TRADER_DISABLED).
    try {
      const copyTrader = new CopyTrader({
        db,
        getConnection: () => listener?.getConnection() ?? null,
      });
      copyTrader.start();
      const copyFollowerProbe = new CopyFollowerProbe({
        db,
        getConnection: () => listener?.getConnection() ?? null,
        copyTrader,
      });
      copyFollowerProbe.start();

      // Live-tape harvester (Idea 1) — discovery off the PumpSwap program tape.
      // OPT-IN (LIVE_TAPE_ENABLED=true): Helius bills LaserStream WS per delivered
      // message and the tape is a firehose, so it's off by default and, when on,
      // duty-cycles under a hard per-cycle message budget. Promotes screen-passing
      // wallets into the scorer (source='live_tape').
      const liveTapeHarvester = new LiveTapeHarvester({ db });
      liveTapeHarvester.start();
    } catch (err) {
      logger.warn('CopyFollower/CopyTrader failed to start: %s', err instanceof Error ? err.message : String(err));
    }
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    if (listener) await listener.stop();
    marketDataFetcher.stop();
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
