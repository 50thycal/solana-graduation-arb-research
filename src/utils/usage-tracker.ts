/**
 * Helius usage attribution (2026-07-03, operator request). Answers "where are my credits
 * going, by category?" — split across the two billing surfaces Helius charges on:
 *   • LaserStream / Enhanced WebSocket — billed PER DELIVERED MESSAGE (the dominant cost;
 *     the operator's console shows ~78% of credits here). Driven by the standing subscriptions:
 *     the copy follower-probe (transactionSubscribe on the watchlist) + the graduation listener
 *     (onLogs) + the live-tape harvester. This module counts messages per subscription.
 *   • RPC — billed per call. Already attributed by label inside the RpcLimiter (servedByLabel).
 *
 * Neither surface knew the OTHER existed, so the old rpc_limiter panel (RPC-only) missed 78% of
 * the bill. computeUsageBreakdown() joins both, maps each source to a spend CATEGORY (scoring /
 * copy_trading / discovery / detection / enrichment), and reports estimated credits/day + share.
 *
 * IMPORTANT: this is a LIVE ESTIMATE for attribution, not a billing oracle — the Helius console
 * is ground truth. Credit-per-unit weights are env-tunable (HELIUS_WS_CREDIT / HELIUS_RPC_CREDIT)
 * so the estimate can be calibrated against the console; the category/source SHARES are useful
 * regardless of the absolute weights. WS message counting is O(1) per message (negligible even on
 * the follower firehose) and starts at boot, so rates are rolling-window, not cycle-to-date.
 */

const WINDOW_SEC = 300;

/** Per-second ring buffer → rolling messages/sec over up to WINDOW_SEC, plus a lifetime count. */
class RateCounter {
  private slots = new Array<number>(WINDOW_SEC).fill(0);
  private slotSec = new Array<number>(WINDOW_SEC).fill(0);
  cumulative = 0;

  add(): void {
    const now = Math.floor(Date.now() / 1000);
    const i = now % WINDOW_SEC;
    if (this.slotSec[i] !== now) { this.slots[i] = 0; this.slotSec[i] = now; }
    this.slots[i] += 1;
    this.cumulative += 1;
  }

  perSec(windowSec = WINDOW_SEC): number {
    const now = Math.floor(Date.now() / 1000);
    let sum = 0;
    for (let k = 0; k < WINDOW_SEC; k++) {
      if (now - this.slotSec[k] < windowSec) sum += this.slots[k];
    }
    return sum / windowSec;
  }
}

class UsageTracker {
  private ws = new Map<string, RateCounter>();
  private bootMs = Date.now();

  /** Seconds since the tracker (≈ the process) started. */
  uptimeSec(): number { return Math.max(1, Math.floor((Date.now() - this.bootMs) / 1000)); }

  /** Call once per delivered WebSocket message, tagged by its subscription source. */
  recordWs(source: string): void {
    let c = this.ws.get(source);
    if (!c) { c = new RateCounter(); this.ws.set(source, c); }
    c.add();
  }

  wsRates(): Record<string, { per_sec_recent: number; cumulative: number }> {
    const out: Record<string, { per_sec_recent: number; cumulative: number }> = {};
    for (const [src, c] of this.ws) {
      out[src] = { per_sec_recent: +c.perSec().toFixed(3), cumulative: c.cumulative };
    }
    return out;
  }
}

export const usageTracker = new UsageTracker();

function numEnv(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] || '');
  return Number.isFinite(v) ? v : fallback;
}

// Credit weight per unit (env-tunable to calibrate against the Helius console).
const WS_CREDIT = numEnv('HELIUS_WS_CREDIT', 1);
const RPC_CREDIT = numEnv('HELIUS_RPC_CREDIT', 1);

// source/label → spend category. Unmapped → 'other'.
const WS_CATEGORY: Record<string, string> = {
  copy_follower_ws: 'copy_trading',      // transactionSubscribe on the smart watchlist (grows with the watchlist)
  detection_grad_ws: 'detection',        // graduation onLogs (migrations-only by default)
  discovery_livetape_ws: 'discovery',    // live-tape harvester (opt-in, duty-cycled)
};
const RPC_CATEGORY: Record<string, string> = {
  wallet_pnl: 'scoring',
  winner_label: 'discovery', winner_buyers: 'discovery', competition: 'detection',
  grad_listener: 'detection', metadata: 'enrichment', holder_enrich: 'enrichment',
  copy_poll: 'copy_trading', copy_trade: 'copy_trading', exec: 'copy_trading', probe_blocktime: 'copy_trading',
};

interface RpcStats {
  servedByLabel?: Record<string, number>;
  projCallsPerDay?: number;
  totalServed?: number;
  uptimeSec?: number;
}

// One full wallet-scoring cycle (COPYTRADE_INTERVAL_MS) ~ 8h; below this the daily estimate
// under-represents scoring because its periodic burst may not have fired yet.
const SCORING_CYCLE_SEC = 8 * 3600;

/**
 * Combined per-category + per-source credit attribution across WS + RPC. `rpcStats` =
 * globalRpcLimiter.getStats(). Returns estimated credits/day and shares — the answer to
 * "which strategy / scorer / discovery system is spending my Helius budget?".
 */
export function computeUsageBreakdown(rpcStats: RpcStats): unknown {
  const wsRates = usageTracker.wsRates();
  // Average over uptime, NOT a 5-min window. Scoring (wallet_pnl) fires in bursts every ~8h, so a
  // short window misses it and undercounts the biggest RPC line; cumulative/uptime captures periodic
  // bursts correctly (converges once the process has been up past one scoring cycle).
  const uptime = Math.max(rpcStats.uptimeSec ?? 0, usageTracker.uptimeSec());
  const perDayFromCumulative = (cumulative: number) => Math.round((cumulative / uptime) * 86_400);

  interface Driver { source: string; transport: 'ws' | 'rpc'; category: string; per_day: number; est_credits_day: number; }
  const drivers: Driver[] = [];

  // WS: cumulative messages / uptime → messages/day × WS credit.
  for (const [src, r] of Object.entries(wsRates)) {
    const perDay = perDayFromCumulative(r.cumulative);
    drivers.push({
      source: src, transport: 'ws', category: WS_CATEGORY[src] ?? 'other',
      per_day: perDay, est_credits_day: Math.round(perDay * WS_CREDIT),
    });
  }

  // RPC: cumulative calls per label / uptime → calls/day × RPC credit.
  const byLabel = rpcStats.servedByLabel ?? {};
  for (const [label, count] of Object.entries(byLabel)) {
    const callsDay = perDayFromCumulative(count);
    drivers.push({
      source: label, transport: 'rpc', category: RPC_CATEGORY[label] ?? 'other',
      per_day: callsDay, est_credits_day: Math.round(callsDay * RPC_CREDIT),
    });
  }

  const totalCredits = drivers.reduce((a, d) => a + d.est_credits_day, 0);
  const pct = (n: number) => totalCredits > 0 ? +((n / totalCredits) * 100).toFixed(1) : 0;

  // Aggregate by category.
  const catMap = new Map<string, { est_credits_day: number; ws_msgs_day: number; rpc_calls_day: number }>();
  for (const d of drivers) {
    const c = catMap.get(d.category) ?? { est_credits_day: 0, ws_msgs_day: 0, rpc_calls_day: 0 };
    c.est_credits_day += d.est_credits_day;
    if (d.transport === 'ws') c.ws_msgs_day += d.per_day; else c.rpc_calls_day += d.per_day;
    catMap.set(d.category, c);
  }
  const by_category = [...catMap.entries()]
    .map(([category, v]) => ({ category, ...v, share_pct: pct(v.est_credits_day) }))
    .sort((a, b) => b.est_credits_day - a.est_credits_day);

  const wsCredits = drivers.filter((d) => d.transport === 'ws').reduce((a, d) => a + d.est_credits_day, 0);
  const rpcCredits = totalCredits - wsCredits;

  return {
    note:
      'LIVE estimate for ATTRIBUTION (the Helius console is ground truth). Joins the two billing ' +
      'surfaces: LaserStream/Enhanced WS (per delivered message — the standing subscriptions) + RPC ' +
      '(per call, from the limiter). Credit weights are env-tunable (HELIUS_WS_CREDIT/HELIUS_RPC_CREDIT); ' +
      'category/source SHARES hold regardless of absolute weights. WS is the dominant lever — a bigger ' +
      'watchlist means more copy_follower_ws messages.',
    weights: { ws_credit: WS_CREDIT, rpc_credit: RPC_CREDIT },
    uptime_sec: uptime,
    warming_up: uptime < SCORING_CYCLE_SEC,
    warmup_note: uptime < SCORING_CYCLE_SEC
      ? `process up ${Math.round(uptime / 3600 * 10) / 10}h — under one ${SCORING_CYCLE_SEC / 3600}h scoring cycle, so wallet_pnl (scoring) is UNDER-counted until the first scoring pass completes.`
      : 'past one scoring cycle — daily estimate is representative.',
    reference_cycle_from_console: { laserstream_ws_pct: 78, rpc_pct: 21, das_pct: 1, note: 'operator CSV 2026-07-03 — historical; WS was the firehose before the migrations-only narrowing. Calibrate weights to match the console daily total.' },
    est_credits_per_day: totalCredits,
    est_credits_per_30d: totalCredits * 30,
    by_transport: {
      ws: { est_credits_day: wsCredits, share_pct: pct(wsCredits) },
      rpc: { est_credits_day: rpcCredits, share_pct: pct(rpcCredits) },
    },
    by_category,
    top_drivers: drivers
      .map((d) => ({ ...d, share_pct: pct(d.est_credits_day) }))
      .sort((a, b) => b.est_credits_day - a.est_credits_day)
      .slice(0, 15),
  };
}
