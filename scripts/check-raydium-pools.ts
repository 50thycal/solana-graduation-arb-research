/**
 * check-raydium-pools.ts
 *
 * Reads the last N mints from the graduations table and checks Raydium's API
 * to see if a CPMM pool exists for each token.
 *
 * Answers: "Do pump.fun graduated tokens co-list on Raydium CPMM?"
 *
 * Run: DATA_DIR=./data npx ts-node scripts/check-raydium-pools.ts
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as https from 'https';

const DATA_DIR = process.env.DATA_DIR || './data';
const DB_PATH  = path.join(DATA_DIR, 'graduation-arb.db');
const SAMPLE   = parseInt(process.env.SAMPLE || '100', 10);
const DELAY_MS = 300; // be polite to Raydium API

// ── DB read ───────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH, { readonly: true });

const rows = db.prepare(`
  SELECT mint, timestamp, final_sol_reserves
  FROM graduations
  ORDER BY id DESC
  LIMIT ?
`).all(SAMPLE) as Array<{ mint: string; timestamp: number; final_sol_reserves: number | null }>;

db.close();

console.log(`\nChecking ${rows.length} mints against Raydium CPMM API...\n`);

// ── Raydium API ───────────────────────────────────────────────────────────────

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error for ${url}: ${data.slice(0, 100)}`)); }
      });
    }).on('error', reject);
  });
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkRaydiumCpmm(mint: string): Promise<{
  hasCpmm: boolean;
  hasAnyPool: boolean;
  poolType?: string;
  poolId?: string;
}> {
  try {
    // Check CPMM pools first
    const cpmmUrl = `https://api-v3.raydium.io/pools/info/mint?mint1=${mint}&poolType=cpmm&poolSortField=default&sortType=desc&pageSize=1&page=1`;
    const cpmmRes = await fetchJson(cpmmUrl);
    if (cpmmRes?.data?.count > 0) {
      const pool = cpmmRes.data.data?.[0];
      return { hasCpmm: true, hasAnyPool: true, poolType: 'cpmm', poolId: pool?.id };
    }

    // Check all pool types (covers AMM v4, CLMM, etc.)
    const allUrl = `https://api-v3.raydium.io/pools/info/mint?mint1=${mint}&poolType=all&poolSortField=default&sortType=desc&pageSize=1&page=1`;
    const allRes = await fetchJson(allUrl);
    if (allRes?.data?.count > 0) {
      const pool = allRes.data.data?.[0];
      return { hasCpmm: false, hasAnyPool: true, poolType: pool?.type, poolId: pool?.id };
    }

    return { hasCpmm: false, hasAnyPool: false };
  } catch (err) {
    return { hasCpmm: false, hasAnyPool: false };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let cpmmCount    = 0;
  let anyPoolCount = 0;
  let noPoolCount  = 0;
  const poolTypes: Record<string, number> = {};

  const results: Array<{
    mint: string;
    sol: number | null;
    hasCpmm: boolean;
    hasAnyPool: boolean;
    poolType?: string;
  }> = [];

  for (let i = 0; i < rows.length; i++) {
    const { mint, final_sol_reserves } = rows[i];
    process.stdout.write(`  [${i + 1}/${rows.length}] ${mint.slice(0, 12)}... `);

    const result = await checkRaydiumCpmm(mint);

    if (result.hasCpmm) {
      cpmmCount++;
      anyPoolCount++;
      process.stdout.write(`CPMM pool found ✓ (${result.poolId?.slice(0, 12)})\n`);
    } else if (result.hasAnyPool) {
      anyPoolCount++;
      process.stdout.write(`${result.poolType} pool found (not CPMM)\n`);
    } else {
      noPoolCount++;
      process.stdout.write(`no Raydium pool\n`);
    }

    if (result.poolType) {
      poolTypes[result.poolType] = (poolTypes[result.poolType] || 0) + 1;
    }

    results.push({ mint, sol: final_sol_reserves, hasCpmm: result.hasCpmm, hasAnyPool: result.hasAnyPool, poolType: result.poolType });

    if (i < rows.length - 1) await sleep(DELAY_MS);
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  const total = rows.length;
  console.log('\n' + '='.repeat(60));
  console.log('RAYDIUM CO-LISTING SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total mints checked:       ${total}`);
  console.log(`Has CPMM pool:             ${cpmmCount}  (${(cpmmCount / total * 100).toFixed(1)}%)`);
  console.log(`Has any Raydium pool:      ${anyPoolCount}  (${(anyPoolCount / total * 100).toFixed(1)}%)`);
  console.log(`No Raydium pool found:     ${noPoolCount}  (${(noPoolCount / total * 100).toFixed(1)}%)`);
  console.log('\nPool type breakdown:');
  for (const [type, count] of Object.entries(poolTypes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(12)} ${count}  (${(count / total * 100).toFixed(1)}%)`);
  }

  // Check if high-quality tokens (sol >= 80) have better co-listing rate
  const hqResults = results.filter(r => r.sol !== null && r.sol >= 80);
  const hqCpmm    = hqResults.filter(r => r.hasCpmm).length;
  const hqAny     = hqResults.filter(r => r.hasAnyPool).length;
  if (hqResults.length > 0) {
    console.log(`\nHigh-quality only (sol >= 80 SOL, n=${hqResults.length}):`);
    console.log(`  CPMM:     ${hqCpmm}  (${(hqCpmm / hqResults.length * 100).toFixed(1)}%)`);
    console.log(`  Any pool: ${hqAny}  (${(hqAny / hqResults.length * 100).toFixed(1)}%)`);
  }

  console.log('\nVERDICT:');
  if (cpmmCount / total >= 0.1) {
    console.log(`  ✓ CPMM co-listing rate ${(cpmmCount / total * 100).toFixed(1)}% — sufficient to explore Raydium arb thesis`);
  } else {
    console.log(`  ✗ CPMM co-listing rate ${(cpmmCount / total * 100).toFixed(1)}% — too low, thesis likely dead on arrival`);
  }
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
