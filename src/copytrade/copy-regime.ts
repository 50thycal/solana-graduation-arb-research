import Database from 'better-sqlite3';

/**
 * Copy-trade regime tracker.
 *
 * Answers ONE question: is this a good or bad window to copy smart wallets?
 * The copy book swings hard day to day (-31, +44, -35, +14 SOL); lifetime
 * totals hide that completely. This computes an hourly time series of book
 * P&L + lead-wallet activity and classifies a rolling window GREEN/YELLOW/RED.
 *
 * Two P&L series per hour bucket:
 *   - book   : every closed copy trade (what the whole roster realized)
 *   - baseline: closed trades of the paired baseline only (copy-tp100-sl30) —
 *     a deduplicated one-row-per-lead-event series, immune to roster changes
 *     (adding/killing exit variants moves book numbers but not baseline ones).
 *
 * Classification (rolling 6h, baseline series):
 *   GREEN  : net > +GREEN_MIN_SOL and at least MIN_TRADES_6H closed trades
 *   RED    : net < -RED_MAX_SOL
 *   YELLOW : everything else (including low-activity windows — no data ≠ good)
 *
 * Pure SQL over copy_trades + copy_probe_events — zero RPC. Cheap enough to
 * run on every /copy-trades render and gist-sync cycle. The CopyTrader's
 * regime-gated strategy reads the same rolling number through bookNet via
 * regimeBaselineNetSince().
 */

export const COPY_REGIME_BASELINE = 'copy-tp100-sl30';
export const REGIME_WINDOW_HOURS = 6;
export const GREEN_MIN_SOL = 0.5;   // rolling 6h baseline net above this = GREEN
export const RED_MAX_SOL = 0.5;     // rolling 6h baseline net below -this = RED
export const MIN_TRADES_6H = 5;     // fewer closed trades than this can't be GREEN

export interface CopyRegimeHour {
  hour: string;            // ISO, truncated to the hour
  book_n: number;
  book_net_sol: number;
  baseline_n: number;
  baseline_net_sol: number;
  wins: number;            // baseline wins
  lead_buys: number;       // probe buy events in the hour
  active_leads: number;    // distinct lead wallets that bought
  regime: 'GREEN' | 'YELLOW' | 'RED'; // rolling classification AT this hour
}

export function classifyWindow(netSol: number, nTrades: number): 'GREEN' | 'YELLOW' | 'RED' {
  if (netSol < -RED_MAX_SOL) return 'RED';
  if (netSol > GREEN_MIN_SOL && nTrades >= MIN_TRADES_6H) return 'GREEN';
  return 'YELLOW';
}

/** Rolling baseline net over the trailing window — the number the regime-gated
 *  strategy keys off. Exported separately so CopyTrader can call it without
 *  computing the whole hourly series on every lead buy. */
export function regimeBaselineNetSince(db: Database.Database, sinceTs: number): { net: number; n: number } {
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(net_sol), 0) AS net, COUNT(*) AS n
      FROM copy_trades
      WHERE status = 'closed' AND strategy_id = ? AND exit_ts >= ?
    `).get(COPY_REGIME_BASELINE, sinceTs) as { net: number; n: number };
    return { net: row.net, n: row.n };
  } catch {
    return { net: 0, n: 0 };
  }
}

export function computeCopyRegime(db: Database.Database, hoursBack = 72): unknown {
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = nowSec - hoursBack * 3600;

  // Hour-bucketed closed P&L (book + baseline) and probe activity.
  let closed: Array<{ h: number; sid: string; net: number; win: number }> = [];
  let probes: Array<{ h: number; wallet: string }> = [];
  try {
    closed = db.prepare(`
      SELECT (exit_ts / 3600) * 3600 AS h, strategy_id AS sid, net_sol AS net,
             CASE WHEN net_sol > 0 THEN 1 ELSE 0 END AS win
      FROM copy_trades
      WHERE status = 'closed' AND exit_ts >= ? AND net_sol IS NOT NULL
    `).all(startSec) as typeof closed;
    probes = db.prepare(`
      SELECT (detected_at / 1000 / 3600) * 3600 AS h, wallet_address AS wallet
      FROM copy_probe_events
      WHERE action = 'buy' AND detected_at >= ?
    `).all(startSec * 1000) as typeof probes;
  } catch {
    return { pending: true };
  }

  const buckets = new Map<number, {
    bookN: number; bookNet: number; baseN: number; baseNet: number; wins: number;
    leadBuys: number; leads: Set<string>;
  }>();
  const bucket = (h: number) => {
    let b = buckets.get(h);
    if (!b) { b = { bookN: 0, bookNet: 0, baseN: 0, baseNet: 0, wins: 0, leadBuys: 0, leads: new Set() }; buckets.set(h, b); }
    return b;
  };
  for (const r of closed) {
    const b = bucket(r.h);
    b.bookN += 1; b.bookNet += r.net;
    if (r.sid === COPY_REGIME_BASELINE) { b.baseN += 1; b.baseNet += r.net; b.wins += r.win; }
  }
  for (const p of probes) {
    const b = bucket(p.h);
    b.leadBuys += 1; b.leads.add(p.wallet);
  }

  // Dense hourly series (empty hours matter — silence is signal).
  const firstHour = Math.floor(startSec / 3600) * 3600;
  const lastHour = Math.floor(nowSec / 3600) * 3600;
  const hourly: CopyRegimeHour[] = [];
  const baseNetSeries: number[] = [];
  const baseNSeries: number[] = [];
  for (let h = firstHour; h <= lastHour; h += 3600) {
    const b = buckets.get(h);
    baseNetSeries.push(b?.baseNet ?? 0);
    baseNSeries.push(b?.baseN ?? 0);
    // rolling window ending at this hour
    const from = Math.max(0, baseNetSeries.length - REGIME_WINDOW_HOURS);
    const winNet = baseNetSeries.slice(from).reduce((a, v) => a + v, 0);
    const winN = baseNSeries.slice(from).reduce((a, v) => a + v, 0);
    hourly.push({
      hour: new Date(h * 1000).toISOString().slice(0, 13) + ':00Z',
      book_n: b?.bookN ?? 0,
      book_net_sol: +(b?.bookNet ?? 0).toFixed(4),
      baseline_n: b?.baseN ?? 0,
      baseline_net_sol: +(b?.baseNet ?? 0).toFixed(4),
      wins: b?.wins ?? 0,
      lead_buys: b?.leadBuys ?? 0,
      active_leads: b?.leads.size ?? 0,
      regime: classifyWindow(winNet, winN),
    });
  }

  // Current snapshot (rolling windows ending NOW, not at the hour boundary).
  const cur6 = regimeBaselineNetSince(db, nowSec - REGIME_WINDOW_HOURS * 3600);
  const cur24 = regimeBaselineNetSince(db, nowSec - 24 * 3600);
  let book6 = { net: 0, n: 0 };
  let buys6 = 0; let leads6 = 0;
  try {
    const b = db.prepare(`
      SELECT COALESCE(SUM(net_sol), 0) AS net, COUNT(*) AS n FROM copy_trades
      WHERE status = 'closed' AND exit_ts >= ? AND net_sol IS NOT NULL
    `).get(nowSec - REGIME_WINDOW_HOURS * 3600) as { net: number; n: number };
    book6 = b;
    const p = db.prepare(`
      SELECT COUNT(*) AS buys, COUNT(DISTINCT wallet_address) AS leads FROM copy_probe_events
      WHERE action = 'buy' AND detected_at >= ?
    `).get((nowSec - REGIME_WINDOW_HOURS * 3600) * 1000) as { buys: number; leads: number };
    buys6 = p.buys; leads6 = p.leads;
  } catch { /* tables may be empty */ }

  // Swing diagnostics: per-UTC-day book net, and the magnitude of day-to-day swings.
  const dayMap = new Map<string, number>();
  for (const r of closed) {
    const d = new Date(r.h * 1000).toISOString().slice(0, 10);
    dayMap.set(d, (dayMap.get(d) ?? 0) + r.net);
  }
  const days = [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([date, net]) => ({ date, book_net_sol: +net.toFixed(2) }));
  const nets = days.map((d) => d.book_net_sol);
  const meanNet = nets.length ? nets.reduce((a, b) => a + b, 0) / nets.length : 0;
  const stdNet = nets.length > 1
    ? Math.sqrt(nets.reduce((a, v) => a + (v - meanNet) ** 2, 0) / (nets.length - 1)) : 0;

  return {
    generated_at: new Date().toISOString(),
    baseline_strategy: COPY_REGIME_BASELINE,
    thresholds: {
      window_hours: REGIME_WINDOW_HOURS, green_min_sol: GREEN_MIN_SOL,
      red_max_sol: RED_MAX_SOL, min_trades_6h: MIN_TRADES_6H,
    },
    current: {
      regime: classifyWindow(cur6.net, cur6.n),
      baseline_net_6h: +cur6.net.toFixed(4),
      baseline_n_6h: cur6.n,
      baseline_net_24h: +cur24.net.toFixed(4),
      baseline_n_24h: cur24.n,
      book_net_6h: +book6.net.toFixed(4),
      book_n_6h: book6.n,
      lead_buys_6h: buys6,
      active_leads_6h: leads6,
    },
    swing: {
      daily: days,
      daily_mean_sol: +meanNet.toFixed(2),
      daily_std_sol: +stdNet.toFixed(2),
    },
    hourly,
  };
}
