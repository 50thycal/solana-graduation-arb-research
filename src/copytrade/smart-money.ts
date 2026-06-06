import Database from 'better-sqlite3';
import { PREDICTOR_WHITELIST } from '../api/price-path-v2-predictors';
import { getSmartSet, setSmartMoneyCache, getSmartMoneyCacheRaw, WalletScoreRow } from './queries';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('smart-money');

/**
 * Smart-money token-selection analysis (copy-trade Option B).
 *
 * Given we'll lose the copy-EXECUTION latency race on the Helius Developer plan,
 * the valuable question is whether the profitable wallets ("smart set") share a
 * detectable pattern in WHICH tokens they buy — a pattern we could replicate at
 * our own T+30 entry with no latency race. This links the scored wallets to the
 * graduation universe and measures 5 things. All from data we already collect.
 *
 * Two membership surfaces (kept strictly separate):
 *   - ACTIONABLE  = a smart wallet bought in the 0-30s post-graduation window
 *     (competition_signals). The ONLY membership knowable at our T+30 entry, so
 *     it anchors the headline measurements (M2 feature signature, M3 outcome
 *     lift, M4 consensus).
 *   - CACHE/any-phase = wallet_tx_cache ⋈ graduations.mint. Includes pre-grad
 *     (bonding curve) and post-T+30 buys, so it's associational, NOT a live
 *     signal. Used for M1 timing (needs full history) and M5 hold time.
 *
 * Heavy (bulk momentum read + joins) → computed in CopytradeWorker every ~3h and
 * cached in bot_settings; gist-sync + the /smart-money route read the cache.
 */

const EARLY_WINDOW_SEC = 30;
const MIN_SMART_WALLETS = 5;
const MIN_SMART_PRESENT_GRADS = 30;
const SMART_SET_DEFINITION =
  'wallet_scores: drop_top3>0 AND monthly_run_rate>=3.75 SOL AND total>=0.5 SOL (n/recency relaxed vs follow-list gate)';

// ── local pure stat helpers (mirror price-path-stats.ts:50 / filter-v2-data.ts:1110;
//    copied to avoid exporting from those hot ~100s panels) ──
function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
function cohensD(a: number[], b: number[]): number | null {
  if (a.length < 3 || b.length < 3) return null;
  const sA = std(a), sB = std(b);
  const pooled = Math.sqrt((sA * sA + sB * sB) / 2);
  if (pooled === 0) return null;
  return +(((mean(a) - mean(b)) / pooled).toFixed(3));
}
function wilsonCI(s: number, n: number): { low: number; high: number } | null {
  if (n === 0) return null;
  const z = 1.96, p = s / n, denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const hw = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: +(Math.max(0, center - hw) * 100).toFixed(1), high: +(Math.min(1, center + hw) * 100).toFixed(1) };
}
function twoPropZP(s1: number, n1: number, s2: number, n2: number): number | null {
  if (n1 === 0 || n2 === 0) return null;
  const p1 = s1 / n1, p2 = s2 / n2, pp = (s1 + s2) / (n1 + n2);
  const se = Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2));
  if (se === 0) return 1.0;
  const z = Math.abs(p1 - p2) / se;
  // 2-sided p-value via erf approximation (Abramowitz & Stegun 7.1.26)
  const x = z / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return +(2 * (1 - 0.5 * (1 + erf))).toFixed(4);
}

function retPct(pct_t30: number | null, pct_t300: number | null): number | null {
  if (pct_t30 == null || pct_t300 == null) return null;
  const denom = 1 + pct_t30 / 100;
  if (denom <= 0) return null;
  return ((1 + pct_t300 / 100) / denom - 1) * 100;
}

export interface SmartMoneyData {
  generated_at: string;
  phase: 'phase1-smart-money';
  low_confidence: boolean;
  smart_set: {
    definition: string;
    n_wallets: number;
    wallets: Array<{
      address: string; n_round_trips: number; total_realized_sol: number;
      total_realized_sol_drop_top3: number; monthly_run_rate_sol: number | null; win_rate: number | null;
    }>;
  };
  coverage: {
    tracked_graduations: number;
    actionable_present_grads: number;
    cache_present_grads: number;
    smart_buy_events_actionable: number;
    notes: string[];
  };
  outcome_lift: {
    smart_present: { n: number; pump_rate: number | null; pump_rate_ci: { low: number; high: number } | null; avg_return_pct: number | null };
    baseline_absent: { n: number; pump_rate: number | null; pump_rate_ci: { low: number; high: number } | null; avg_return_pct: number | null };
    pump_rate_lift_pp: number | null;
    p_value: number | null;
    by_smart_count: Array<{ smart_buyers: string; n: number; pump_rate: number | null; avg_return_pct: number | null }>;
  };
  feature_signature: Array<{
    col: string; display: string; units: string; coverage: string; direction_hint: string;
    mean_smart: number | null; mean_rest: number | null; cohens_d: number | null; n_smart: number; n_rest: number;
  }>;
  timing: {
    by_phase: { pre_graduation: { events: number; pct: number | null }; post_graduation: { events: number; pct: number | null } };
    by_venue: Record<string, number>;
    per_wallet: Array<{ address: string; grad_buys: number; pre_pct: number; archetype: string }>;
  };
  consensus: {
    distribution: Record<string, number>;
    top_pairs: Array<{ a: string; b: string; count: number }>;
  };
  behavior: {
    buy_size_sol: { on_pump: number | null; on_dump: number | null; n_pump: number; n_dump: number };
    hold_sec: { on_pump: number | null; on_dump: number | null; n_pump: number; n_dump: number };
  };
}

type MomRow = Record<string, number | string | null>;

export function computeSmartMoney(db: Database.Database): SmartMoneyData {
  const generated_at = new Date().toISOString();
  const smartSet: WalletScoreRow[] = getSmartSet(db);
  const smartList = smartSet.map((r) => r.address);
  const smartAddrs = new Set(smartList);

  const emptyVenue: Record<string, number> = {};
  const base: SmartMoneyData = {
    generated_at,
    phase: 'phase1-smart-money',
    low_confidence: true,
    smart_set: {
      definition: SMART_SET_DEFINITION,
      n_wallets: smartSet.length,
      wallets: smartSet.slice(0, 100).map((r) => ({
        address: r.address,
        n_round_trips: r.n_round_trips,
        total_realized_sol: +r.total_realized_sol.toFixed(3),
        total_realized_sol_drop_top3: +r.total_realized_sol_drop_top3.toFixed(3),
        monthly_run_rate_sol: r.monthly_run_rate_sol != null ? +r.monthly_run_rate_sol.toFixed(2) : null,
        win_rate: r.win_rate,
      })),
    },
    coverage: {
      tracked_graduations: 0,
      actionable_present_grads: 0,
      cache_present_grads: 0,
      smart_buy_events_actionable: 0,
      notes: [
        'M2/M3/M4 use the look-ahead-clean 0-30s actionable membership (knowable at T+30); M1/M5 use any-phase wallet history.',
        'competition_signals captures only ~20-40 tx/grad, so actionable membership undercounts (false negatives).',
        'wallet_tx_cache covers only scored wallets’ last ~400 sigs, recent-token biased — cache-present is a lower bound.',
      ],
    },
    outcome_lift: {
      smart_present: { n: 0, pump_rate: null, pump_rate_ci: null, avg_return_pct: null },
      baseline_absent: { n: 0, pump_rate: null, pump_rate_ci: null, avg_return_pct: null },
      pump_rate_lift_pp: null,
      p_value: null,
      by_smart_count: [],
    },
    feature_signature: [],
    timing: {
      by_phase: { pre_graduation: { events: 0, pct: null }, post_graduation: { events: 0, pct: null } },
      by_venue: emptyVenue,
      per_wallet: [],
    },
    consensus: { distribution: {}, top_pairs: [] },
    behavior: {
      buy_size_sol: { on_pump: null, on_dump: null, n_pump: 0, n_dump: 0 },
      hold_sec: { on_pump: null, on_dump: null, n_pump: 0, n_dump: 0 },
    },
  };

  if (smartList.length === 0) {
    base.coverage.notes.unshift('No wallets in the smart set yet — scorer needs to surface money-edge wallets.');
    return base;
  }

  const inClause = smartList.map(() => '?').join(',');

  // ── bulk momentum read (labeled grads only) — the analyzed universe ──
  const predictorCols = PREDICTOR_WHITELIST.map((p) => `gm.${p.col} AS ${p.col}`).join(', ');
  const momRows = db.prepare(`
    SELECT gm.graduation_id AS gid, g.mint AS mint, g.timestamp AS grad_ts,
           gm.label AS label, gm.pct_t300 AS pct_t300, ${predictorCols}
    FROM graduation_momentum gm
    JOIN graduations g ON g.id = gm.graduation_id
    WHERE gm.label IS NOT NULL
  `).all() as MomRow[];

  const labelByGid = new Map<number, string>();
  for (const r of momRows) labelByGid.set(r.gid as number, r.label as string);

  // ── actionable membership: smart wallet bought 0-30s post-grad ──
  const actAddr = new Map<number, Set<string>>();
  const actBuyEvents: Array<{ gid: number; w: string; amt: number | null }> = [];
  for (const row of db.prepare(`
    SELECT cs.graduation_id AS gid, cs.wallet_address AS w, cs.amount_sol AS amt
    FROM competition_signals cs
    WHERE cs.action = 'buy'
      AND cs.seconds_since_graduation >= 0 AND cs.seconds_since_graduation <= ${EARLY_WINDOW_SEC}
      AND cs.wallet_address IN (${inClause})
  `).all(...smartList) as Array<{ gid: number; w: string; amt: number | null }>) {
    if (!actAddr.has(row.gid)) actAddr.set(row.gid, new Set());
    actAddr.get(row.gid)!.add(row.w);
    actBuyEvents.push(row);
  }

  // ── cache membership + timing (any phase) ──
  const cacheGids = new Set<number>();
  const cacheRows = db.prepare(`
    SELECT w.address AS w, w.block_time AS bt, w.venue AS venue, g.id AS gid, g.timestamp AS grad_ts
    FROM wallet_tx_cache w
    JOIN graduations g ON g.mint = w.mint
    WHERE w.action = 'buy' AND w.address IN (${inClause})
  `).all(...smartList) as Array<{ w: string; bt: number; venue: string | null; gid: number; grad_ts: number }>;

  // ── round trips on tracked grads (hold time, M5) ──
  const rtRows = db.prepare(`
    SELECT rt.address AS w, rt.hold_sec AS hold, g.id AS gid
    FROM wallet_round_trips rt
    JOIN graduations g ON g.mint = rt.mint
    WHERE rt.address IN (${inClause})
  `).all(...smartList) as Array<{ w: string; hold: number; gid: number }>;

  // ── M3 outcome lift + M2 feature signature (actionable membership) ──
  const featAccum = PREDICTOR_WHITELIST.map((p) => ({ p, smart: [] as number[], rest: [] as number[] }));
  const byCount = new Map<string, { n: number; pumps: number; rets: number[] }>();
  const bucketKey = (c: number) => (c === 0 ? '0' : c === 1 ? '1' : c === 2 ? '2' : '3+');
  let presentN = 0, presentPumps = 0; const presentRets: number[] = [];
  let absentN = 0, absentPumps = 0; const absentRets: number[] = [];

  for (const row of momRows) {
    const gid = row.gid as number;
    const count = actAddr.get(gid)?.size ?? 0;
    const present = count > 0;
    const isPump = row.label === 'PUMP' ? 1 : 0;
    const ret = retPct(row.pct_t30 as number | null, row.pct_t300 as number | null);

    if (present) { presentN++; presentPumps += isPump; if (ret != null) presentRets.push(ret); }
    else { absentN++; absentPumps += isPump; if (ret != null) absentRets.push(ret); }

    const bk = bucketKey(count);
    if (!byCount.has(bk)) byCount.set(bk, { n: 0, pumps: 0, rets: [] });
    const b = byCount.get(bk)!;
    b.n++; b.pumps += isPump; if (ret != null) b.rets.push(ret);

    for (const fa of featAccum) {
      const v = row[fa.p.col];
      if (typeof v === 'number' && Number.isFinite(v)) (present ? fa.smart : fa.rest).push(v);
    }
  }

  const feature_signature = featAccum.map((fa) => ({
    col: fa.p.col,
    display: fa.p.display,
    units: fa.p.units,
    coverage: fa.p.coverage,
    direction_hint: fa.p.direction_hint ?? 'unknown',
    mean_smart: fa.smart.length ? +mean(fa.smart).toFixed(4) : null,
    mean_rest: fa.rest.length ? +mean(fa.rest).toFixed(4) : null,
    cohens_d: cohensD(fa.smart, fa.rest),
    n_smart: fa.smart.length,
    n_rest: fa.rest.length,
  })).sort((a, b) => Math.abs(b.cohens_d ?? 0) - Math.abs(a.cohens_d ?? 0));

  const by_smart_count = ['0', '1', '2', '3+'].filter((k) => byCount.has(k)).map((k) => {
    const b = byCount.get(k)!;
    return {
      smart_buyers: k,
      n: b.n,
      pump_rate: b.n ? +(b.pumps / b.n).toFixed(3) : null,
      avg_return_pct: b.rets.length ? +mean(b.rets).toFixed(2) : null,
    };
  });

  // ── M1 timing/venue (cache rows) ──
  let preEvents = 0, postEvents = 0;
  const byVenue: Record<string, number> = {};
  const perWallet = new Map<string, { total: number; pre: number }>();
  for (const r of cacheRows) {
    cacheGids.add(r.gid);
    const venue = r.venue ?? 'unknown';
    byVenue[venue] = (byVenue[venue] ?? 0) + 1;
    const isPre = venue === 'pumpfun_bc' || (r.bt != null && r.grad_ts != null && r.bt < r.grad_ts);
    if (isPre) preEvents++; else postEvents++;
    if (!perWallet.has(r.w)) perWallet.set(r.w, { total: 0, pre: 0 });
    const pw = perWallet.get(r.w)!;
    pw.total++; if (isPre) pw.pre++;
  }
  const totalPhase = preEvents + postEvents;
  const per_wallet = [...perWallet.entries()]
    .map(([address, v]) => {
      const pre_pct = v.total ? +(v.pre / v.total).toFixed(3) : 0;
      return { address, grad_buys: v.total, pre_pct, archetype: pre_pct >= 0.5 ? 'bonding_curve_sniper' : 'post_grad_amm' };
    })
    .sort((a, b) => b.grad_buys - a.grad_buys)
    .slice(0, 50);

  // ── M4 consensus (actionable) ──
  // distribution over labeled grads by smart-buyer count bucket
  const distribution: Record<string, number> = {};
  for (const b of by_smart_count) distribution[b.smart_buyers] = b.n;
  // co-occurrence pairs among grads with >=2 smart buyers
  const pairCount = new Map<string, number>();
  for (const [gid, set] of actAddr) {
    if (!labelByGid.has(gid) || set.size < 2) continue;
    const arr = [...set].sort();
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = `${arr[i]}|${arr[j]}`;
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
  }
  const top_pairs = [...pairCount.entries()]
    .map(([key, count]) => { const [a, b] = key.split('|'); return { a, b, count }; })
    .sort((x, y) => y.count - x.count)
    .slice(0, 15);

  // ── M5 behavior ──
  const buyPump: number[] = [], buyDump: number[] = [];
  for (const e of actBuyEvents) {
    if (e.amt == null) continue;
    const lbl = labelByGid.get(e.gid);
    if (lbl === 'PUMP') buyPump.push(e.amt);
    else if (lbl === 'DUMP') buyDump.push(e.amt);
  }
  const holdPump: number[] = [], holdDump: number[] = [];
  for (const r of rtRows) {
    const lbl = labelByGid.get(r.gid);
    if (lbl === 'PUMP') holdPump.push(r.hold);
    else if (lbl === 'DUMP') holdDump.push(r.hold);
  }

  const actionablePresentGrads = momRows.filter((r) => (actAddr.get(r.gid as number)?.size ?? 0) > 0).length;
  const cachePresentGrads = [...cacheGids].filter((gid) => labelByGid.has(gid)).length;

  const result: SmartMoneyData = {
    ...base,
    low_confidence: smartList.length < MIN_SMART_WALLETS || actionablePresentGrads < MIN_SMART_PRESENT_GRADS,
    coverage: {
      tracked_graduations: momRows.length,
      actionable_present_grads: actionablePresentGrads,
      cache_present_grads: cachePresentGrads,
      smart_buy_events_actionable: actBuyEvents.length,
      notes: base.coverage.notes,
    },
    outcome_lift: {
      smart_present: {
        n: presentN,
        pump_rate: presentN ? +(presentPumps / presentN).toFixed(3) : null,
        pump_rate_ci: wilsonCI(presentPumps, presentN),
        avg_return_pct: presentRets.length ? +mean(presentRets).toFixed(2) : null,
      },
      baseline_absent: {
        n: absentN,
        pump_rate: absentN ? +(absentPumps / absentN).toFixed(3) : null,
        pump_rate_ci: wilsonCI(absentPumps, absentN),
        avg_return_pct: absentRets.length ? +mean(absentRets).toFixed(2) : null,
      },
      pump_rate_lift_pp: presentN && absentN ? +((presentPumps / presentN - absentPumps / absentN) * 100).toFixed(2) : null,
      p_value: twoPropZP(presentPumps, presentN, absentPumps, absentN),
      by_smart_count,
    },
    feature_signature,
    timing: {
      by_phase: {
        pre_graduation: { events: preEvents, pct: totalPhase ? +(preEvents / totalPhase).toFixed(3) : null },
        post_graduation: { events: postEvents, pct: totalPhase ? +(postEvents / totalPhase).toFixed(3) : null },
      },
      by_venue: byVenue,
      per_wallet,
    },
    consensus: { distribution, top_pairs },
    behavior: {
      buy_size_sol: {
        on_pump: buyPump.length ? +mean(buyPump).toFixed(4) : null,
        on_dump: buyDump.length ? +mean(buyDump).toFixed(4) : null,
        n_pump: buyPump.length, n_dump: buyDump.length,
      },
      hold_sec: {
        on_pump: holdPump.length ? Math.round(mean(holdPump)) : null,
        on_dump: holdDump.length ? Math.round(mean(holdDump)) : null,
        n_pump: holdPump.length, n_dump: holdDump.length,
      },
    },
  };

  return result;
}

/** Compute the analysis and stash it in bot_settings (called by CopytradeWorker). */
export function computeAndCacheSmartMoney(db: Database.Database): void {
  try {
    const data = computeSmartMoney(db);
    setSmartMoneyCache(db, JSON.stringify(data));
    logger.info(
      'Smart-money analysis cached: smart_wallets=%d, present_grads=%d, low_confidence=%s',
      data.smart_set.n_wallets, data.coverage.actionable_present_grads, data.low_confidence,
    );
  } catch (err) {
    logger.warn('computeAndCacheSmartMoney failed: %s', err instanceof Error ? err.message : String(err));
  }
}

/** Read the cached analysis (for gist-sync + the /smart-money route). */
export function getSmartMoneyAnalysis(db: Database.Database): SmartMoneyData | { generated_at: string; phase: string; pending: true } {
  const raw = getSmartMoneyCacheRaw(db);
  if (!raw) return { generated_at: new Date().toISOString(), phase: 'phase1-smart-money', pending: true };
  try {
    return JSON.parse(raw) as SmartMoneyData;
  } catch {
    return { generated_at: new Date().toISOString(), phase: 'phase1-smart-money', pending: true };
  }
}
