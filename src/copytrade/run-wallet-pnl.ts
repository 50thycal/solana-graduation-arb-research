/**
 * Phase 1 batch runner for the copy-trade wallet-PnL engine.
 *
 *   npm run wallet-pnl -- --selftest        # FIFO correctness, no RPC/DB
 *   npm run wallet-pnl -- --seed-only        # just seed candidates from DB
 *   npm run wallet-pnl -- --limit 50         # fetch+score up to 50 stale candidates
 *   npm run wallet-pnl -- --limit 50 --write-follow   # also write promotable -> follow_list (DISABLED)
 *
 * Fetch path requires HELIUS_RPC_URL. Seeding + selftest do not.
 */
import { Connection } from '@solana/web3.js';
import { initDatabase } from '../db/schema';
import { seedCandidatesFromDb, recomputeCandidatePriorities } from './discovery';
import { getCandidates, cacheWalletSwaps, replaceRoundTrips, upsertWalletScore, getTopWalletScores, upsertFollow } from './queries';
import { fetchWalletSwaps, scoreWallet, reconstructRoundTrips, WalletSwap } from './wallet-pnl';
import { rankWallets, evaluateWallet } from './ranker';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? '') : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Synthetic FIFO correctness check — runs without RPC or a real DB. */
function selftest(): void {
  const mk = (sig: string, t: number, action: 'buy' | 'sell', sol: number, tok: number): WalletSwap => ({
    signature: sig, blockTime: t, mint: 'MINT', action,
    solDelta: action === 'buy' ? -Math.abs(sol) : Math.abs(sol),
    tokenDelta: action === 'buy' ? Math.abs(tok) : -Math.abs(tok),
    venue: 'pumpswap',
  });

  let fails = 0;
  const ok = (cond: boolean, msg: string) => { if (!cond) { console.error('  FAIL:', msg); fails++; } else console.log('  ok:', msg); };

  // Case 1: single clean round trip, 1 SOL -> 2 SOL, 0% cost. Realized = +1.
  {
    const rts = reconstructRoundTrips([mk('a', 100, 'buy', 1, 1000), mk('b', 200, 'sell', 2, 1000)], 0);
    ok(rts.length === 1, 'case1: one round trip');
    ok(Math.abs(rts[0].realizedSol - 1) < 1e-9, `case1: realized=+1 (got ${rts[0].realizedSol})`);
    ok(rts[0].holdSec === 100, 'case1: hold=100s');
  }
  // Case 2: 3% cost haircut on 1 SOL entry => realized = 1 - 0.03 = 0.97.
  {
    const rts = reconstructRoundTrips([mk('a', 0, 'buy', 1, 1000), mk('b', 1, 'sell', 2, 1000)], 3);
    ok(Math.abs(rts[0].realizedSol - 0.97) < 1e-9, `case2: cost-haircut realized=0.97 (got ${rts[0].realizedSol})`);
  }
  // Case 3: partial fills — two buys (1+1 SOL, 1000+1000 tok) then one sell of 1500 tok @ 3 SOL total.
  // proceedsPerToken=0.002. Lot1 fully matched (1000 tok, solIn 1), lot2 partial (500 tok, solIn 0.5).
  // realized = (1000*0.002-1) + (500*0.002-0.5) = (2-1)+(1-0.5)=1.5, cost 0.
  {
    const rts = reconstructRoundTrips([
      mk('a', 0, 'buy', 1, 1000), mk('b', 1, 'buy', 1, 1000), mk('c', 2, 'sell', 3, 1500),
    ], 0);
    const total = rts.reduce((s, r) => s + r.realizedSol, 0);
    ok(rts.length === 2, `case3: two partial round trips (got ${rts.length})`);
    ok(Math.abs(total - 1.5) < 1e-9, `case3: total realized=1.5 (got ${total})`);
  }
  // Case 4: sell with no prior buy => no round trip, no crash.
  {
    const rts = reconstructRoundTrips([mk('z', 0, 'sell', 1, 1000)], 0);
    ok(rts.length === 0, 'case4: unmatched sell ignored');
  }
  // Case 5: scoring — drop_top3 strips the single big winner.
  {
    const swaps: WalletSwap[] = [];
    let t = 0;
    // 4 small winners (+0.1 each) and 1 huge winner (+10).
    for (let i = 0; i < 4; i++) { swaps.push(mk(`b${i}`, t++, 'buy', 1, 1000)); swaps.push(mk(`s${i}`, t++, 'sell', 1.1, 1000)); }
    swaps.push(mk('bigb', t++, 'buy', 1, 1000)); swaps.push(mk('bigs', t++, 'sell', 11, 1000));
    const sc = scoreWallet('WALLET', swaps, 0);
    ok(sc.nRoundTrips === 5, 'case5: 5 round trips');
    ok(Math.abs(sc.totalRealizedSol - (0.4 + 10)) < 1e-9, `case5: total=10.4 (got ${sc.totalRealizedSol})`);
    // drop top 3 => removes the +10 and two +0.1 => 0.4-0.2 = 0.2 remains.
    ok(Math.abs(sc.totalRealizedSolDropTop3 - 0.2) < 1e-9, `case5: drop_top3=0.2 (got ${sc.totalRealizedSolDropTop3})`);
    ok(sc.winRate === 1, 'case5: win_rate=1');
  }
  // Case 6: gate evaluation — clears all but n.
  {
    const sc = scoreWallet('W', [mk('a', 0, 'buy', 1, 1000), mk('b', 86_400 * 2, 'sell', 5, 1000)], 0);
    const ev = evaluateWallet(sc, 86_400 * 3, { minRoundTrips: 100, minTotalSol: 0.5, minDropTop3Sol: 0, minMonthlyRunRate: 3.75, maxDaysSinceActive: 14 });
    ok(!ev.passed && ev.failedGates.includes('n_round_trips'), 'case6: fails on n');
  }

  console.log(fails === 0 ? '\nSELFTEST PASSED' : `\nSELFTEST FAILED (${fails})`);
  process.exit(fails === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  if (flag('selftest')) return selftest();

  const dataDir = process.env.DATA_DIR || './data';
  const db = initDatabase(dataDir);

  const added = seedCandidatesFromDb(db);
  const prioritized = recomputeCandidatePriorities(db);
  console.log(`Seeded candidates (+${added} new); priority set on ${prioritized} wallets with signal.`);
  if (flag('seed-only')) return;

  const rpcUrl = process.env.HELIUS_RPC_URL;
  if (!rpcUrl) {
    console.error('HELIUS_RPC_URL required for the fetch+score path. Use --seed-only or --selftest without it.');
    process.exit(1);
  }
  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });

  const limit = parseInt(arg('limit') ?? '25', 10);
  const maxSignatures = parseInt(arg('max-sigs') ?? '1000', 10);
  // Re-score candidates not refreshed in the last 24h.
  const staleBefore = Math.floor(Date.now() / 1000) - 24 * 3600;
  const candidates = getCandidates(db, { staleBeforeTs: staleBefore, limit });
  console.log(`Scoring ${candidates.length} candidates (maxSignatures=${maxSignatures})...`);

  const now = Math.floor(Date.now() / 1000);
  for (const c of candidates) {
    try {
      const swaps = await fetchWalletSwaps(connection, c.address, { maxSignatures });
      cacheWalletSwaps(db, c.address, swaps);
      const score = scoreWallet(c.address, swaps);
      replaceRoundTrips(db, c.address, reconstructRoundTrips(swaps));
      upsertWalletScore(db, score, now);
    } catch (err) {
      console.error(`  ${c.address.slice(0, 8)} failed:`, err instanceof Error ? err.message : err);
    }
  }

  // Leaderboard.
  const top = getTopWalletScores(db, 25);
  console.log('\n=== WALLET LEADERBOARD (by monthly run rate) ===');
  console.log('address       n     total    drop3    monthly   win%   lastActiveDaysAgo');
  for (const r of top) {
    const days = r.last_active ? ((now - r.last_active) / 86_400).toFixed(1) : 'n/a';
    console.log(
      `${r.address.slice(0, 8)}  ${String(r.n_round_trips).padStart(4)}  ` +
      `${(r.total_realized_sol).toFixed(2).padStart(7)}  ${(r.total_realized_sol_drop_top3).toFixed(2).padStart(7)}  ` +
      `${(r.monthly_run_rate_sol ?? 0).toFixed(2).padStart(7)}  ${((r.win_rate ?? 0) * 100).toFixed(0).padStart(4)}  ${days}`
    );
  }

  if (flag('write-follow')) {
    const scores = top.map((r) => ({
      address: r.address,
      nRoundTrips: r.n_round_trips,
      totalRealizedSol: r.total_realized_sol,
      totalRealizedSolDropTop3: r.total_realized_sol_drop_top3,
      medianRtPct: r.median_rt_pct,
      monthlyRunRateSol: r.monthly_run_rate_sol,
      winRate: r.win_rate,
      avgHoldSec: r.avg_hold_sec,
      lastActive: r.last_active,
      venues: r.venues_json ? JSON.parse(r.venues_json) : {},
    }));
    const ranked = rankWallets(scores, now);
    let written = 0;
    for (const rw of ranked) {
      if (!rw.passed) break;
      written++;
      upsertFollow(db, {
        address: rw.score.address,
        rank: written,
        copySizeSol: 0.05,
        maxConcurrent: 1,
        enabled: false, // Phase 1 writes DISABLED — shadow validation gates enable.
        killCriterion: 'n>=50 and net_sol<-1',
        addedAt: now,
      });
    }
    console.log(`\nWrote ${written} promotable wallets to follow_list (DISABLED — enable after shadow).`);
  }

  db.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
