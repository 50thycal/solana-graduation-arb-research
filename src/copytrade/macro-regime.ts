import type Database from 'better-sqlite3';

/**
 * Macro market score, 1 (worst) – 10 (best).
 *
 * "Is the broad crypto market a tailwind or a headwind right now." Memecoin
 * risk appetite tracks the majors — when BTC/SOL are trending up and sentiment
 * is greedy, post-graduation tokens pump more and copy-trading works better;
 * when the market bleeds, even good entries get dragged down. This is the macro
 * analogue of the copy-internal regime score (copy-regime.ts).
 *
 * Built from `market_daily` (daily SOL/USD + BTC/USD closes + Fear & Greed),
 * already populated hourly by MarketDataFetcher from CoinGecko + alternative.me.
 * Pure SQL read — no new RPC, no new external dependency.
 *
 * Components (each → ±1, blended):
 *   - BTC 7-day return — the broad-crypto-direction proxy (total mcap tracks BTC)
 *   - SOL 7-day return — the actual quote asset; memecoin beta
 *   - Fear & Greed (0-100) — risk appetite; greed = risk-on
 * score = clamp(round(5 + 5 * (0.7*trend + 0.3*sentiment)), 1, 10). 5 = neutral.
 */

export const BTC_TREND_SCALE = 0.10; // a 7d BTC move of ±10% is a strong macro signal
export const SOL_TREND_SCALE = 0.15; // SOL is more volatile, so a wider scale

function clampScore(raw: number): number {
  return Math.max(1, Math.min(10, Math.round(raw)));
}

/** Pure scorer — exported for testability. Returns 1-10. */
export function macroScoreFrom(btc7Ret: number | null, sol7Ret: number | null, fng: number | null): number {
  const btc = btc7Ret == null ? 0 : Math.tanh(btc7Ret / BTC_TREND_SCALE);
  const sol = sol7Ret == null ? 0 : Math.tanh(sol7Ret / SOL_TREND_SCALE);
  // average whichever trends we have; if neither, trend is neutral (0)
  const have = (btc7Ret == null ? 0 : 1) + (sol7Ret == null ? 0 : 1);
  const trend = have === 0 ? 0 : (btc + sol) / have;
  const sentiment = fng == null ? 0 : Math.max(-1, Math.min(1, (fng - 50) / 50));
  const composite = 0.7 * trend + 0.3 * sentiment; // -1..1
  return clampScore(5 + 5 * composite);
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
  const ago7 = rows[Math.min(7, rows.length - 1)];
  const btc7 = pctReturn(latest.btc, ago7.btc);
  const sol7 = pctReturn(latest.sol, ago7.sol);
  return macroScoreFrom(btc7, sol7, latest.fng);
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
  const score = macroScoreFrom(btc7, sol7, latest.fng);

  // Per-day score history (oldest→newest), each from its OWN trailing 7d window,
  // so the dashboard can sparkline the macro trend.
  const asc = [...rows].reverse(); // oldest first
  const history = asc.map((r, i) => {
    const back = asc[Math.max(0, i - 7)];
    return {
      date: r.date,
      btc_close: r.btc,
      sol_close: r.sol,
      score: macroScoreFrom(pctReturn(r.btc, back.btc), pctReturn(r.sol, back.sol), r.fng),
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
      btc_7d_pct: pct(btc7), sol_7d_pct: pct(sol7),
      btc_1d_pct: pct(btc1), sol_1d_pct: pct(sol1),
      fear_greed: latest.fng,
    },
    scale: {
      btc_trend_scale_pct: BTC_TREND_SCALE * 100, sol_trend_scale_pct: SOL_TREND_SCALE * 100,
      note: '1-10 macro score (10 best). 0.7*trend(BTC+SOL 7d) + 0.3*sentiment(F&G); 5 = neutral.',
    },
    history,
  };
}
