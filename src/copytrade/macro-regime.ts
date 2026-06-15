import type Database from 'better-sqlite3';

/**
 * Macro market score, 1 (worst) – 10 (best).
 *
 * "Is the broad crypto market a tailwind or a headwind right now." Memecoin
 * risk appetite tracks BTC — when BTC trends up, post-graduation tokens pump
 * more and copy-trading works better; when BTC bleeds, even good entries get
 * dragged down. This is the macro analogue of the copy-internal regime score
 * (copy-regime.ts).
 *
 * BTC-ONLY (2026-06-15): the score is purely BTC trend. Fear & Greed was
 * dropped — it stays pinned low for a long time after a drawdown and would hold
 * the score down even as BTC turns up (exactly the recovery we want to trade).
 * SOL is still surfaced on the dashboard for context but is NOT in the score.
 *
 * Built from `market_daily` (daily BTC/USD close), already populated hourly by
 * MarketDataFetcher from CoinGecko. The "today" row is refreshed each hour, so
 * the 1-day return reflects intraday BTC moves as the day progresses. Pure SQL
 * read — no new RPC, no new external dependency.
 *
 *   score = clamp(round(5 + 5 * (0.4*tanh(btc1d/0.04) + 0.6*tanh(btc7d/0.10))), 1, 10)
 * 5 = neutral; the 1-day term gives responsiveness, the 7-day term the trend.
 */

export const BTC_1D_SCALE = 0.04;  // a 1-day BTC move of ±4% is a strong daily signal
export const BTC_7D_SCALE = 0.10;  // a 7-day BTC move of ±10% is a strong weekly signal

function clampScore(raw: number): number {
  return Math.max(1, Math.min(10, Math.round(raw)));
}

/** Pure scorer — BTC trend only. Exported for testability. Returns 1-10. */
export function macroScoreFrom(btc1dRet: number | null, btc7dRet: number | null): number {
  const d1 = btc1dRet == null ? null : Math.tanh(btc1dRet / BTC_1D_SCALE);
  const d7 = btc7dRet == null ? null : Math.tanh(btc7dRet / BTC_7D_SCALE);
  if (d1 == null && d7 == null) return 5; // no data → neutral (don't block on missing macro)
  // weight 7d trend 0.6, 1d responsiveness 0.4; renormalize if one is missing
  let trend: number;
  if (d1 != null && d7 != null) trend = 0.4 * d1 + 0.6 * d7;
  else trend = (d1 ?? d7) as number;
  return clampScore(5 + 5 * trend);
}

export function macroBand(score: number): { label: string; color: string } {
  if (score >= 8) return { label: 'strong tailwind', color: '#16a34a' };
  if (score >= 6) return { label: 'tailwind', color: '#65a30d' };
  if (score >= 5) return { label: 'neutral', color: '#ca8a04' };
  if (score >= 3) return { label: 'headwind', color: '#ea580c' };
  return { label: 'strong headwind', color: '#dc2626' };
}

interface MarketRow { date: string; sol: number | null; btc: number | null; fng: number | null; }

/** Most recent `n` daily rows, newest first. */
function recentRows(db: Database.Database, n: number): MarketRow[] {
  try {
    const rows = db.prepare(`
      SELECT date, sol_usd_close AS sol, btc_usd_close AS btc, fear_greed_value AS fng
      FROM market_daily ORDER BY date DESC LIMIT ?
    `).all(n) as MarketRow[];
    return rows;
  } catch {
    return [];
  }
}

function pctReturn(newest: number | null | undefined, older: number | null | undefined): number | null {
  if (typeof newest !== 'number' || typeof older !== 'number' || older <= 0) return null;
  return newest / older - 1;
}

/** Current macro score for the gate. Cheap; CopyTrader caches it ~5min. */
export function currentMacroScore(db: Database.Database): number {
  const rows = recentRows(db, 8);
  if (rows.length === 0) return 5; // no data → neutral (don't block on missing macro)
  const latest = rows[0];
  const ago1 = rows[Math.min(1, rows.length - 1)];
  const ago7 = rows[Math.min(7, rows.length - 1)];
  return macroScoreFrom(pctReturn(latest.btc, ago1.btc), pctReturn(latest.btc, ago7.btc));
}

export function computeMacroRegime(db: Database.Database): unknown {
  const rows = recentRows(db, 21); // newest first; enough for a 14-day score history
  if (rows.length === 0) {
    return { pending: true, note: 'No market_daily rows yet — MarketDataFetcher backfills on boot.' };
  }
  const latest = rows[0];
  const ago1 = rows[Math.min(1, rows.length - 1)];
  const ago7 = rows[Math.min(7, rows.length - 1)];
  const btc7 = pctReturn(latest.btc, ago7.btc);
  const sol7 = pctReturn(latest.sol, ago7.sol);
  const btc1 = pctReturn(latest.btc, ago1.btc);
  const sol1 = pctReturn(latest.sol, ago1.sol);
  const score = macroScoreFrom(btc1, btc7);

  // Per-day score history (oldest→newest), each from its OWN trailing windows,
  // so the dashboard can sparkline the macro trend. BTC-only, matching the score.
  const asc = [...rows].reverse(); // oldest first
  const history = asc.map((r, i) => {
    const back1 = asc[Math.max(0, i - 1)];
    const back7 = asc[Math.max(0, i - 7)];
    return {
      date: r.date,
      btc_close: r.btc,
      sol_close: r.sol,
      score: macroScoreFrom(pctReturn(r.btc, back1.btc), pctReturn(r.btc, back7.btc)),
    };
  }).slice(-14);

  const pct = (v: number | null) => (v == null ? null : +(v * 100).toFixed(2));
  return {
    generated_at: new Date().toISOString(),
    score,
    band: macroBand(score).label,
    latest_date: latest.date,
    sol_usd: latest.sol,
    btc_usd: latest.btc,
    fear_greed: latest.fng,
    components: {
      btc_7d_pct: pct(btc7), btc_1d_pct: pct(btc1),
      // context only — NOT in the score (BTC-only as of 2026-06-15)
      sol_7d_pct: pct(sol7), sol_1d_pct: pct(sol1), fear_greed: latest.fng,
    },
    scale: {
      btc_1d_scale_pct: BTC_1D_SCALE * 100, btc_7d_scale_pct: BTC_7D_SCALE * 100,
      note: '1-10 macro score (10 best), BTC trend only: 0.4*tanh(btc1d/4%) + 0.6*tanh(btc7d/10%); 5 = neutral. SOL/F&G shown for context, not scored.',
    },
    history,
  };
}
