import Database from 'better-sqlite3';
import { COPYABILITY } from './ranker';
import { getFollowListAddresses, getSmartSetAddresses } from './queries';
import { getCopyNetSelectedAddresses } from './leaderboard-v2';

function numEnv(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] || '');
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Discovery-source framework (2026-07-02) — makes "test a new way of finding wallets to
 * copy" a ONE-ROW change instead of a five-file edit.
 *
 * BEFORE: each discovery thesis (live-tape, external leaderboard, …) hand-wired its own
 * queries.ts getter, its own Set + refresh line in copy-trader, its own leadSource enum
 * value, its own probe strategy, and its own bespoke status panel. Iterating a new thesis
 * meant touching all of them.
 *
 * NOW: a discovery pipeline INSERTs candidates into `wallet_candidates` with a distinct
 * `source` tag (that part is unchanged — it's already how live_tape/external work), and
 * registers ONE row in DISCOVERY_SOURCES below. Everything else is derived:
 *   • the quarantined smart-set for the source (generic SQL on wc.source),
 *   • a standardized REALISTIC probe strategy (`copy-src-<id>`, lag5+drift10, TP100/SL30,
 *     auto-emitted into COPY_STRATEGIES via makeSourceProbes()),
 *   • a per-source row in the `discovery_scorecard` block of copy-trades.json
 *     (funnel + probe P&L vs the shared OG control + an explicit verdict).
 *
 * MEASUREMENT CONTRACT (why every probe shares one ruleset): a source probe copies EVERY
 * smart wallet its pipeline surfaced, with NO lead-quality gate (hotlead etc. would
 * confound source quality with lead selection) and realistic execution (5s + drift10 —
 * the idealized probes were killed 2026-07-02; a source that only works at 1.1s is not a
 * real source). The control is `copy-tp100-sl30-lag`: the identical ruleset on
 * OG-discovered wallets. Verdict: at n>=MIN_N, a source must beat the OG control on BOTH
 * net/trade AND drop3/trade or it FAILS. Quarantine (leadSource routing in copy-trader)
 * guarantees each wallet's trades land in exactly one source's series.
 */
export interface DiscoverySource {
  /** wallet_candidates.source tag. Also derives the probe id: copy-src-<id, _ → ->. */
  id: string;
  label: string;
  /** The thesis this source tests — shows up verbatim in the scorecard. */
  hypothesis: string;
  added: string; // YYYY-MM-DD, for age/maturity context in the scorecard
  /**
   * OPTIONAL signal-set override (2026-07-04): when set, the source's smart set is DEFINED
   * BY THE SOURCE'S OWN FUNNEL instead of the plain source-tag SQL below. First user:
   * winner_sniper, whose funnel is profit-credited tally → forward PRE-FILTER
   * (winner-prefilter.ts) → FIFO scorer + the relaxed gate (getPrefilterGatedWallets).
   * Signal-set wallets are NOT provenance-quarantined by wallet_candidates.source, so
   * refreshSourceSets subtracts the OG universe (follow_list ∪ global smart set ∪ copy-net)
   * and earlier sources' sets — a signal set can never steal a wallet another book is
   * already trading.
   */
  signalSet?: (db: Database.Database) => string[];
}

export const DISCOVERY_SOURCES: DiscoverySource[] = [
  {
    id: 'live_tape',
    label: 'Live-tape harvester (Idea 1)',
    hypothesis: 'Wallets seen trading well on the live PumpSwap tape (zero-RPC harvest) copy better than graduation-seeded (OG) wallets.',
    added: '2026-06-30',
  },
  {
    id: 'external',
    label: 'External top-trader seed (Idea 3, Solana Tracker)',
    hypothesis: 'Public top-trader leaderboard wallets copy better than OG — honest prior: crowded/alpha-decayed.',
    added: '2026-06-30',
  },
  {
    id: 'winner_sniper',
    label: 'Winner-sniper precision (operator thesis, S2+S3)',
    hypothesis: 'Wallets that repeatedly early-buy (0-30s) the graduations that go on to win at T+30m — ranked by winner-hit precision with a 36h-half-life decay — copy better than OG. Entry edge with runway should survive the 5s lag.',
    added: '2026-07-02',
    // 3-stage funnel (operator 2026-07-04): profit-credited tally → forward pre-filter
    // (winner-prefilter.ts) → FIFO scorer. Tradable = pre-filter PASSED ∩ the relaxed
    // scored gate — "the scoring decides if it is ready to be tradable".
    signalSet: (db) => getPrefilterGatedWallets(db),
  },
  // ── To test a new discovery thesis ──
  // 1. Write the harvester: INSERT INTO wallet_candidates (address, source, …) VALUES (?, '<id>', …)
  //    (see worker.ts / live-tape for examples). The shared scorer picks candidates up automatically.
  // 2. Add one row here. That's it: the probe strategy, quarantine routing, and scorecard row
  //    all derive from the registry. See docs/discovery-playbook.md.
];

/**
 * RELAXED money-edge gate for DISCOVERY sources (operator 2026-07-03). Just outlier-robust
 * PROFITABLE — NO monthly run-rate bar. Rationale: the 3.75 SOL/mo target is the AGGREGATE goal
 * across the whole set of copied wallets (a strategy trading many small-but-profitable wallets
 * sums to the bar), not a per-wallet filter that would exclude good leads for being small.
 * The global getSmartSetAddresses / cohort gates (the CORE book's universe) are UNCHANGED — this
 * relaxation is scoped to the quarantined discovery-source watchlists only. Env-tunable.
 */
const SOURCE_MIN_DROP3 = numEnv('COPYSRC_MIN_DROP3', 0);
const SOURCE_MIN_HOLD_SEC = numEnv('COPYSRC_MIN_HOLD_SEC', 30);
/** Max wallets per source set — the sets now feed the follower WATCHLIST (2026-07-04), and
 *  Helius bills WS per delivered message, so each set is capped (best-first) to bound spend. */
const SOURCE_WATCH_CAP = numEnv('COPYSRC_WATCH_CAP', 25);
const SOURCE_GATE = `ws.total_realized_sol_drop_top3 > ${SOURCE_MIN_DROP3}`;
/**
 * RELAXED copyability for sources: hold >= 30s (was 300s — we don't want to drop fast-but-
 * mirrorable wallets) while KEEPING the ~95% win-rate cap (the bot filter — a wallet that
 * "never loses" has a structural edge we can't copy) and the PumpSwap-venue share. Global
 * COPYABLE_SQL is unchanged.
 */
const SOURCE_COPYABLE_SQL = `
  COALESCE(ws.avg_hold_sec, 0) >= ${SOURCE_MIN_HOLD_SEC}
  AND COALESCE(ws.win_rate, 1) <= ${COPYABILITY.maxWinRate}
  AND COALESCE(json_extract(ws.venues_json, '$.pumpswap'), 0) * 1.0
      / NULLIF((SELECT SUM(value) FROM json_each(ws.venues_json)), 0) >= ${COPYABILITY.minPumpswapShare}`;

/**
 * winner_sniper tradable set — the end of its 3-stage funnel: wallets that PASSED the
 * forward pre-filter (proved profit on OTHER PumpSwap tokens after triggering) AND clear
 * the same relaxed scored gate as every other source. Scoring stays the final arbiter of
 * tradability; the pre-filter is what earns a wallet the (expensive) score in the first
 * place. Table absent → empty (no wallet has cleared stage 1 yet).
 */
function getPrefilterGatedWallets(db: Database.Database): string[] {
  try {
    return (db.prepare(`
      SELECT ws.address FROM wallet_scores ws
      JOIN winner_prefilter pf ON pf.address = ws.address AND pf.status = 'passed'
      WHERE ${SOURCE_GATE}
        AND ${SOURCE_COPYABLE_SQL}
      ORDER BY ws.total_realized_sol_drop_top3 DESC NULLS LAST
      LIMIT ${SOURCE_WATCH_CAP}
    `).all() as Array<{ address: string }>).map((r) => r.address);
  } catch {
    return [];
  }
}

/**
 * Generic quarantined smart set for one discovery source: PROFITABLE + copyable wallets whose
 * candidate row carries this source tag (relaxed gate above). Replaces the per-source getters.
 * Sources with a `signalSet` override (entry-timing theses) use their own bar instead.
 */
export function getSourceSmartSetAddresses(db: Database.Database, sourceId: string): string[] {
  const src = DISCOVERY_SOURCES.find((s) => s.id === sourceId);
  if (src?.signalSet) {
    try { return src.signalSet(db); } catch { return []; }
  }
  try {
    return (db.prepare(`
      SELECT ws.address FROM wallet_scores ws
      JOIN wallet_candidates wc ON wc.address = ws.address
      WHERE ${SOURCE_GATE} AND wc.source = @src
        AND ${SOURCE_COPYABLE_SQL}
      ORDER BY ws.total_realized_sol_drop_top3 DESC NULLS LAST
      LIMIT ${SOURCE_WATCH_CAP}
    `).all({ src: sourceId }) as Array<{ address: string }>).map((r) => r.address);
  } catch {
    return [];
  }
}

/** Probe strategy id for a source (underscores → hyphens to match roster naming). */
export function sourceProbeId(sourceId: string): string {
  return `copy-src-${sourceId.replace(/_/g, '-')}`;
}

/** The shared OG control: identical ruleset on OG-discovered wallets. */
export const SOURCE_PROBE_CONTROL = 'copy-tp100-sl30-lag';
/** Per-probe sample at which the scorecard calls a verdict. */
export const SOURCE_PROBE_MIN_N = 100;

/**
 * Refresh all source sets in one call. Two consumers, same sets by construction:
 *   - copy-trader routes each lead-buy to the matching source's strategies
 *     (undefined/og = OG-only, as before);
 *   - the follower probe SUBSCRIBES these wallets (2026-07-04 fix: the relaxed source gate
 *     admits wallets the global smart set doesn't, and un-subscribed wallets can never fire
 *     a lead event — the copy-src-* probes sat at n=0 for exactly this reason).
 *
 * Tag-gated sources are disjoint by construction (one source tag per wallet) and their
 * global-smart overlap is the INTENDED provenance quarantine. Signal-set sources are not
 * tag-scoped, so they subtract the OG universe (follow_list ∪ global smart ∪ copy-net) and
 * earlier sources' sets — they may only claim wallets no other book is trading.
 */
export function refreshSourceSets(db: Database.Database): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  let ogUniverse: Set<string> | null = null; // computed lazily, only if a signalSet source exists
  const ogSet = (): Set<string> => {
    if (!ogUniverse) {
      ogUniverse = new Set<string>();
      try { for (const a of getFollowListAddresses(db)) ogUniverse.add(a); } catch { /* empty */ }
      try { for (const a of getSmartSetAddresses(db)) ogUniverse.add(a); } catch { /* empty */ }
      try { for (const a of getCopyNetSelectedAddresses(db)) ogUniverse.add(a); } catch { /* empty */ }
    }
    return ogUniverse;
  };
  for (const src of DISCOVERY_SOURCES) {
    const wallets = getSourceSmartSetAddresses(db, src.id);
    if (!src.signalSet) {
      m.set(src.id, new Set(wallets));
      continue;
    }
    const set = new Set<string>();
    for (const w of wallets) {
      if (ogSet().has(w)) continue;
      let taken = false;
      for (const other of m.values()) { if (other.has(w)) { taken = true; break; } }
      if (!taken) set.add(w);
    }
    m.set(src.id, set);
  }
  return m;
}

interface ProbeStats {
  n: number;
  net_sol: number;
  drop3_sol: number;
  net_per_trade: number | null;
  drop3_per_trade: number | null;
}

function probeStats(db: Database.Database, strategyId: string): ProbeStats {
  let nets: number[] = [];
  try {
    nets = (db.prepare(
      `SELECT net_sol FROM copy_trades
        WHERE strategy_id = ? AND status = 'closed' AND net_sol IS NOT NULL`,
    ).all(strategyId) as Array<{ net_sol: number }>).map((r) => r.net_sol);
  } catch { /* table absent */ }
  const n = nets.length;
  const net = nets.reduce((a, b) => a + b, 0);
  const drop3 = [...nets].sort((a, b) => b - a).slice(3).reduce((a, b) => a + b, 0);
  return {
    n,
    net_sol: +net.toFixed(4),
    drop3_sol: +drop3.toFixed(4),
    net_per_trade: n ? +(net / n).toFixed(5) : null,
    drop3_per_trade: n ? +(drop3 / n).toFixed(5) : null,
  };
}

/**
 * The generic per-source scorecard for copy-trades.json — funnel (candidates → scored →
 * smart/copyable) + probe P&L vs the OG control + verdict. Adding a source to the registry
 * adds a row here with zero reporting code.
 */
export function computeDiscoveryScorecard(db: Database.Database): unknown {
  const control = probeStats(db, SOURCE_PROBE_CONTROL);
  const funnel = (src: string) => {
    try {
      const row = db.prepare(`
        SELECT COUNT(*) AS candidates,
               SUM(CASE WHEN ws.address IS NOT NULL THEN 1 ELSE 0 END) AS scored
        FROM wallet_candidates wc
        LEFT JOIN wallet_scores ws ON ws.address = wc.address
        WHERE wc.source = ?
      `).get(src) as { candidates: number; scored: number };
      return { candidates: row.candidates ?? 0, scored: row.scored ?? 0 };
    } catch {
      return { candidates: 0, scored: 0 };
    }
  };

  // Same sets the copy-trader routes on and the follower probe subscribes — so
  // smart_copyable is exactly "wallets whose lead-buys can reach this probe".
  const sourceSets = refreshSourceSets(db);
  const rows = DISCOVERY_SOURCES.map((src) => {
    const probe = probeStats(db, sourceProbeId(src.id));
    const smart = sourceSets.get(src.id)?.size ?? 0;
    let verdict = 'COLLECTING';
    let verdict_detail = `n=${probe.n}/${SOURCE_PROBE_MIN_N}`;
    if (smart === 0 && probe.n === 0) {
      verdict = 'NO_WALLETS';
      verdict_detail = 'pipeline has not yet produced a smart+copyable wallet — check the funnel, not the P&L';
    } else if (probe.n >= SOURCE_PROBE_MIN_N && control.n >= SOURCE_PROBE_MIN_N) {
      const beatsNet = (probe.net_per_trade ?? -Infinity) > (control.net_per_trade ?? -Infinity);
      const beatsDrop3 = (probe.drop3_per_trade ?? -Infinity) > (control.drop3_per_trade ?? -Infinity);
      verdict = beatsNet && beatsDrop3 ? 'BEATS_OG' : 'FAILS';
      verdict_detail = `vs OG control per-trade: net ${probe.net_per_trade} vs ${control.net_per_trade}, drop3 ${probe.drop3_per_trade} vs ${control.drop3_per_trade}`;
    }
    return {
      source: src.id,
      label: src.label,
      hypothesis: src.hypothesis,
      added: src.added,
      probe_strategy: sourceProbeId(src.id),
      funnel: { ...funnel(src.id), smart_copyable: smart },
      probe,
      verdict,
      verdict_detail,
    };
  });

  return {
    note:
      'Generic discovery-source scorecard. Each source pipeline tags wallet_candidates.source; ' +
      `its quarantined smart set trades ONLY its standardized realistic probe (lag5+drift10 TP100/SL30). ` +
      `Control = ${SOURCE_PROBE_CONTROL} (same ruleset, OG wallets). Verdict at n>=${SOURCE_PROBE_MIN_N}: ` +
      'must beat the control on BOTH net/trade AND drop3/trade. To add a source see docs/discovery-playbook.md.',
    control: { strategy: SOURCE_PROBE_CONTROL, ...control },
    rows,
  };
}
