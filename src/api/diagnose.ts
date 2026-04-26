/**
 * src/api/diagnose.ts
 *
 * Encodes the CLAUDE.md Bug Triage Protocol (Levels 1-4) as executable checks.
 * One call returns a structured verdict so Claude can self-diagnose without
 * pinging the human.
 *
 * Level 1: Is the bot running and detecting graduations?
 * Level 2: Is price data being captured correctly (PumpSwap pool, no nulls)?
 * Level 3: Are timestamps correct (checkpoint grid not skewed)?
 * Level 4: Is label logic correct (PUMP = >+10% at T+300, DUMP = <-10%)?
 *
 * Levels are checked in order. Failure at any level short-circuits the
 * verdict. "next_action" is always set to the most useful thing Claude
 * can do next.
 */

import Database from 'better-sqlite3';
import type { LogBuffer } from '../utils/log-buffer';
import { isKillswitchTripped, getDailyLiveNetProfitSol } from '../trading/safety';
import { DAILY_MAX_LOSS_SOL } from '../trading/config';

export interface LevelResult {
  pass: boolean;
  evidence: Record<string, unknown>;
  notes?: string;
}

export interface PipelineHealth {
  ws_connected: boolean | null;
  last_graduation_sec_ago: number | null;
  last_t30_callback_sec_ago: number | null;
  last_paper_trade_sec_ago: number | null;
  last_shadow_trade_sec_ago: number | null;
  enabled_strategies: number;
  verdict:
    | 'HEALTHY'
    | 'WS_DOWN'
    | 'NO_GRADS'
    | 'T30_STALLED'
    | 'TRADES_STALLED'
    | 'NO_STRATEGIES'
    | 'NOT_APPLICABLE';
  notes: string;
}

export interface DiagnosisReport {
  generated_at: string;
  verdict:
    | 'HEALTHY'
    | 'LEVEL1_FAIL'
    | 'LEVEL2_FAIL'
    | 'LEVEL3_FAIL'
    | 'LEVEL4_FAIL'
    | 'LEVEL5_FAIL'
    | 'PIPELINE_STALLED'
    | 'NO_DATA';
  next_action: string;
  level1_bot_running: LevelResult;
  level2_price_capture: LevelResult;
  level3_timestamps: LevelResult;
  level4_label_logic: LevelResult;
  level5_live_ready: LevelResult;
  pipeline_health: PipelineHealth;
  recent_errors: Array<{ ts: string; level: string; name: string; msg: string }>;
}

export interface PipelineSignals {
  wsConnected?: boolean | null;
  lastT30CallbackAt?: number | null;
  enabledStrategies?: number;
}

// Stall thresholds. Conservative defaults — tune via env if needed.
const T30_STALL_SEC = 10 * 60;        // 10 min without a T+30 callback while WS up = pipeline broken
const TRADES_STALL_SEC = 30 * 60;     // 30 min without a paper/shadow entry (with strategies enabled) = entry pipeline broken

const NULL_RATE_FAIL = 0.5; // >50% of critical fields null on recent rows = fail
const SAMPLE_SIZE_FOR_LEVEL4 = 20;

export function runDiagnosis(
  db: Database.Database,
  logBuffer?: LogBuffer,
  pipelineSignals?: PipelineSignals,
): DiagnosisReport {
  const generated_at = new Date().toISOString();

  // ── LEVEL 1: Bot running and detecting graduations ──
  const pipelineRow = db.prepare(`
    SELECT
      COUNT(*) as total,
      MAX(timestamp) as last_ts
    FROM graduations
  `).get() as { total: number; last_ts: number | null };

  const nowSec = Math.floor(Date.now() / 1000);
  const secondsSinceLast = pipelineRow.last_ts !== null
    ? nowSec - pipelineRow.last_ts
    : null;

  const level1: LevelResult = {
    pass: pipelineRow.total > 0,
    evidence: {
      total_graduations: pipelineRow.total,
      last_graduation_seconds_ago: secondsSinceLast,
    },
    notes: pipelineRow.total === 0
      ? 'No graduations in DB. Check WebSocket connection and program subscription.'
      : 'Bot is receiving graduations.',
  };

  // ── LEVEL 2: Price data captured correctly ──
  // Check last 50 momentum rows: null rate on open_price_sol and pct_t300,
  // and confirm all have a linked PumpSwap pool (new_pool_address non-null).
  const recent50 = db.prepare(`
    SELECT
      m.graduation_id as id,
      m.open_price_sol,
      m.pct_t30,
      m.pct_t300,
      g.new_pool_address
    FROM graduation_momentum m
    JOIN graduations g ON g.id = m.graduation_id
    ORDER BY m.graduation_id DESC
    LIMIT 50
  `).all() as Array<{
    id: number;
    open_price_sol: number | null;
    pct_t30: number | null;
    pct_t300: number | null;
    new_pool_address: string | null;
  }>;

  const n50 = recent50.length;
  const nullOpen = recent50.filter((r) => r.open_price_sol === null).length;
  const nullT300 = recent50.filter((r) => r.pct_t300 === null).length;
  const noPool = recent50.filter((r) => r.new_pool_address === null).length;
  const nullOpenRate = n50 > 0 ? nullOpen / n50 : 0;
  const noPoolRate = n50 > 0 ? noPool / n50 : 0;
  const firstBadRow = recent50.find((r) => r.open_price_sol === null || r.new_pool_address === null);

  const level2: LevelResult = {
    pass: n50 >= 5 && nullOpenRate < NULL_RATE_FAIL && noPoolRate < NULL_RATE_FAIL,
    evidence: {
      sample_size: n50,
      null_open_price_count: nullOpen,
      null_open_price_rate: +nullOpenRate.toFixed(3),
      null_pct_t300_count: nullT300,
      no_pumpswap_pool_count: noPool,
      no_pumpswap_pool_rate: +noPoolRate.toFixed(3),
      first_bad_row_id: firstBadRow?.id ?? null,
    },
    notes: n50 < 5
      ? 'Not enough rows to assess price capture health.'
      : nullOpenRate >= NULL_RATE_FAIL
        ? `High null rate on open_price_sol (${(nullOpenRate * 100).toFixed(1)}%). Check PumpSwap pool observation ingest.`
        : noPoolRate >= NULL_RATE_FAIL
          ? 'Many recent graduations have no linked PumpSwap pool. Migration listener may be broken.'
          : 'Price capture looks clean — PumpSwap pool linked and prices populated on recent rows.',
  };

  // ── LEVEL 3: Timestamp / checkpoint grid sanity ──
  // Pick a row with complete 5s->300s grid and confirm checkpoints monotonically
  // follow time. We can't easily prove "T+300 is really 300s after T+0" without
  // the raw observation timestamps, but we can assert that checkpoint fields
  // exist in the expected ordering for rows that claim completeness.
  const grid = db.prepare(`
    SELECT
      graduation_id as id,
      price_t30, price_t60, price_t120, price_t300,
      pct_t30, pct_t60, pct_t120, pct_t300
    FROM graduation_momentum
    WHERE pct_t30 IS NOT NULL
      AND pct_t60 IS NOT NULL
      AND pct_t120 IS NOT NULL
      AND pct_t300 IS NOT NULL
    ORDER BY graduation_id DESC
    LIMIT 20
  `).all() as Array<{
    id: number;
    price_t30: number | null;
    price_t60: number | null;
    price_t120: number | null;
    price_t300: number | null;
    pct_t30: number | null;
    pct_t60: number | null;
    pct_t120: number | null;
    pct_t300: number | null;
  }>;

  const gridBad = grid.filter((r) =>
    r.price_t30 === null || r.price_t60 === null || r.price_t120 === null || r.price_t300 === null,
  );

  const level3: LevelResult = {
    pass: grid.length >= 5 && gridBad.length === 0,
    evidence: {
      sample_size: grid.length,
      missing_price_checkpoints: gridBad.length,
      first_bad_row_id: gridBad[0]?.id ?? null,
    },
    notes: grid.length < 5
      ? 'Not enough complete checkpoint rows to verify grid.'
      : gridBad.length > 0
        ? 'Some rows report pct_t* non-null but price_t* is missing — writer bug likely.'
        : 'Checkpoint grid is consistent on recent rows.',
  };

  // ── LEVEL 4: Label logic correctness ──
  // Re-derive the label on a sample of 20 rows and confirm it matches.
  // CLAUDE.md: PUMP = >+10% at T+300 from open, DUMP = <-10% at T+300 from open.
  const sample = db.prepare(`
    SELECT graduation_id as id, pct_t300, label
    FROM graduation_momentum
    WHERE label IS NOT NULL AND pct_t300 IS NOT NULL
    ORDER BY graduation_id DESC
    LIMIT ?
  `).all(SAMPLE_SIZE_FOR_LEVEL4) as Array<{
    id: number;
    pct_t300: number;
    label: 'PUMP' | 'DUMP' | 'STABLE';
  }>;

  const mismatches: Array<{ id: number; pct_t300: number; label: string; expected: string }> = [];
  for (const r of sample) {
    const expected = r.pct_t300 > 10 ? 'PUMP' : r.pct_t300 < -10 ? 'DUMP' : 'STABLE';
    if (expected !== r.label) {
      mismatches.push({ id: r.id, pct_t300: r.pct_t300, label: r.label, expected });
    }
  }

  const level4: LevelResult = {
    pass: sample.length >= 5 && mismatches.length === 0,
    evidence: {
      sample_size: sample.length,
      mismatches: mismatches.slice(0, 5),
      mismatch_count: mismatches.length,
    },
    notes: sample.length < 5
      ? 'Not enough labeled rows to verify label logic.'
      : mismatches.length > 0
        ? `${mismatches.length}/${sample.length} labels disagree with the re-derived PUMP/DUMP/STABLE rule.`
        : 'Label logic matches expected rule on recent rows.',
  };

  // ── LEVEL 5: Live-mode readiness (circuit breaker, killswitch, balance) ──
  // Only checked for strategies actually configured for live modes. For
  // paper-only deployments this always passes.
  const liveStrategies = db.prepare(`
    SELECT id, config_json FROM strategy_configs WHERE enabled = 1
  `).all() as Array<{ id: string; config_json: string }>;
  const liveIds: string[] = [];
  for (const s of liveStrategies) {
    try {
      const cfg = JSON.parse(s.config_json);
      if (cfg.executionMode === 'live_micro' || cfg.executionMode === 'live_full') {
        liveIds.push(s.id);
      }
    } catch { /* ignore parse errors */ }
  }

  let level5: LevelResult;
  if (liveIds.length === 0) {
    level5 = {
      pass: true,
      evidence: { live_strategy_count: 0 },
      notes: 'No strategies in live mode — live-readiness not applicable.',
    };
  } else {
    const killswitch = isKillswitchTripped();
    const dailyPnl = getDailyLiveNetProfitSol(db);
    const walletEnvSet = !!process.env.WALLET_PRIVATE_KEY;
    const circuitTripped = dailyPnl <= -DAILY_MAX_LOSS_SOL;
    const allOk = !killswitch && !circuitTripped && walletEnvSet;
    level5 = {
      pass: allOk,
      evidence: {
        live_strategy_count: liveIds.length,
        live_strategies: liveIds,
        killswitch_tripped: killswitch,
        daily_live_net_profit_sol: +dailyPnl.toFixed(4),
        daily_max_loss_sol: DAILY_MAX_LOSS_SOL,
        circuit_breaker_tripped: circuitTripped,
        wallet_env_set: walletEnvSet,
      },
      notes: !walletEnvSet
        ? 'Live strategies configured but WALLET_PRIVATE_KEY not set — entries will fail.'
        : killswitch
          ? 'Killswitch tripped — new live entries blocked and open positions force-closed.'
          : circuitTripped
            ? `Daily circuit breaker tripped — live entries blocked for the rest of UTC day (P&L ${dailyPnl.toFixed(4)} SOL ≤ -${DAILY_MAX_LOSS_SOL}).`
            : 'Live-mode prerequisites satisfied.',
    };
  }

  // ── Pipeline health (paper + shadow flow watchdog) ──
  // Distinct from Levels 1-5: those check that data + labels are correct.
  // This checks that the LIVE trade-entry pipeline (WS → graduation →
  // T+30 callback → strategy fan-out → trade open) is actively flowing.
  // Without it, the user can't tell from the dashboard whether trades have
  // stopped because of a code bug, an enabled-strategies-of-zero state, or
  // simply a quiet period on pump.fun.
  const enabledStrategies = pipelineSignals?.enabledStrategies ?? 0;
  const wsConnected = pipelineSignals?.wsConnected ?? null;
  const lastT30Ms = pipelineSignals?.lastT30CallbackAt ?? null;
  const lastT30SecAgo = lastT30Ms !== null
    ? Math.floor((Date.now() - lastT30Ms) / 1000)
    : null;

  // Last paper/shadow entry from trades_v2 — table may not exist on first
  // boot before any strategy ever fired, hence the try/catch.
  let lastPaperSecAgo: number | null = null;
  let lastShadowSecAgo: number | null = null;
  try {
    const tradeRows = db.prepare(`
      SELECT execution_mode, MAX(opened_at) AS last_open
      FROM trades_v2
      WHERE execution_mode IN ('paper', 'shadow')
      GROUP BY execution_mode
    `).all() as Array<{ execution_mode: string; last_open: number | null }>;
    for (const r of tradeRows) {
      if (r.last_open === null) continue;
      const ageSec = Math.floor((Date.now() - r.last_open) / 1000);
      if (r.execution_mode === 'paper') lastPaperSecAgo = ageSec;
      if (r.execution_mode === 'shadow') lastShadowSecAgo = ageSec;
    }
  } catch { /* table missing or migration in progress — leave as null */ }

  let pipelineVerdict: PipelineHealth['verdict'] = 'NOT_APPLICABLE';
  let pipelineNotes = 'Trading not enabled or no strategies configured.';

  if (enabledStrategies === 0) {
    pipelineVerdict = 'NO_STRATEGIES';
    pipelineNotes = 'No enabled strategies — trade pipeline intentionally idle.';
  } else if (wsConnected === false) {
    pipelineVerdict = 'WS_DOWN';
    pipelineNotes = 'WebSocket reports disconnected. Reconnect loop should be running — check graduation-listener logs.';
  } else if (secondsSinceLast !== null && secondsSinceLast > T30_STALL_SEC) {
    // Use Level 1's existing graduation-recency check as a proxy.
    pipelineVerdict = 'NO_GRADS';
    pipelineNotes = `No graduations in ${secondsSinceLast}s. Either pump.fun is quiet (rare) or the WS subscription is broken.`;
  } else if (lastT30SecAgo !== null && lastT30SecAgo > T30_STALL_SEC) {
    pipelineVerdict = 'T30_STALLED';
    pipelineNotes = `Last T+30 callback was ${lastT30SecAgo}s ago. Graduations arriving but PriceCollector → StrategyManager wiring is silent.`;
  } else if (
    lastPaperSecAgo !== null && lastPaperSecAgo > TRADES_STALL_SEC
    && lastShadowSecAgo !== null && lastShadowSecAgo > TRADES_STALL_SEC
  ) {
    pipelineVerdict = 'TRADES_STALLED';
    pipelineNotes = `No paper or shadow entries in ${TRADES_STALL_SEC}s — every recent T+30 candidate is being filtered/rejected. Check entry gates and skips.`;
  } else if (lastT30SecAgo === null && enabledStrategies > 0) {
    // Strategies enabled but T+30 callback never fired since boot. Could be
    // legitimate (early uptime) — only flag if we've been up long enough to
    // have heard from at least one graduation.
    if (secondsSinceLast !== null && secondsSinceLast < 600) {
      pipelineVerdict = 'HEALTHY'; // recent grad — wait for next one
      pipelineNotes = 'Recent graduation present; awaiting next T+30 callback.';
    } else {
      pipelineVerdict = 'T30_STALLED';
      pipelineNotes = 'StrategyManager has never received a T+30 callback. Verify attachToPriceCollector() ran at boot.';
    }
  } else {
    pipelineVerdict = 'HEALTHY';
    pipelineNotes = 'Pipeline active — graduations, T+30 callbacks, and entries within thresholds.';
  }

  const pipeline_health: PipelineHealth = {
    ws_connected: wsConnected,
    last_graduation_sec_ago: secondsSinceLast,
    last_t30_callback_sec_ago: lastT30SecAgo,
    last_paper_trade_sec_ago: lastPaperSecAgo,
    last_shadow_trade_sec_ago: lastShadowSecAgo,
    enabled_strategies: enabledStrategies,
    verdict: pipelineVerdict,
    notes: pipelineNotes,
  };

  // ── Recent errors from the log ring buffer ──
  const recent_errors: DiagnosisReport['recent_errors'] = [];
  if (logBuffer) {
    const errs = logBuffer.query({ level: 'error', limit: 5 });
    for (const e of errs) {
      recent_errors.push({
        ts: new Date(e.ts).toISOString(),
        level: e.level,
        name: e.name,
        msg: e.msg,
      });
    }
  }

  // ── Verdict ──
  let verdict: DiagnosisReport['verdict'] = 'HEALTHY';
  let next_action = 'All checks pass. Safe to interpret /api/snapshot and /api/best-combos as real signal.';

  if (pipelineRow.total === 0) {
    verdict = 'NO_DATA';
    next_action = 'Bot has never detected a graduation. Verify WebSocket URL, program subscription, and that the listener is running.';
  } else if (!level1.pass) {
    verdict = 'LEVEL1_FAIL';
    next_action = level1.notes ?? 'Fix bot connection before looking at signals.';
  } else if (!level2.pass) {
    verdict = 'LEVEL2_FAIL';
    next_action = level2.notes ?? 'Fix price capture before looking at signals.';
  } else if (!level3.pass) {
    verdict = 'LEVEL3_FAIL';
    next_action = level3.notes ?? 'Fix checkpoint grid before looking at signals.';
  } else if (!level4.pass) {
    verdict = 'LEVEL4_FAIL';
    next_action = level4.notes ?? 'Fix label logic before looking at signals.';
  } else if (!level5.pass) {
    verdict = 'LEVEL5_FAIL';
    next_action = level5.notes ?? 'Fix live-mode prerequisites before enabling live strategies.';
  } else if (
    pipeline_health.verdict === 'WS_DOWN'
    || pipeline_health.verdict === 'T30_STALLED'
    || pipeline_health.verdict === 'TRADES_STALLED'
  ) {
    // NO_GRADS and NO_STRATEGIES are not actionable bot bugs (quiet market /
    // intentional state) — only flip the top-level verdict for real stalls.
    verdict = 'PIPELINE_STALLED';
    next_action = pipeline_health.notes;
  }

  return {
    generated_at,
    verdict,
    next_action,
    level1_bot_running: level1,
    level2_price_capture: level2,
    level3_timestamps: level3,
    level4_label_logic: level4,
    level5_live_ready: level5,
    pipeline_health,
    recent_errors,
  };
}
