/**
 * PumpSwap simulation gate.
 *
 * Builds a buy or sell tx with the official `@pump-fun/pump-swap-sdk` (the
 * same builder the executor uses), wraps it in a v0 transaction against the
 * current chain state, and runs `simulateTransaction(sigVerify=false,
 * replaceRecentBlockhash=true)` to confirm it would land. This replaces the
 * earlier byte-equality check — once we adopted the SDK, byte-diffing against
 * a random on-chain tx caught only legitimate variation (rotated protocol
 * fee recipients, IDL-stale writability flags, optional remaining accounts).
 * Simulation answers the question we actually care about: does the SDK
 * produce an ix that the on-chain program accepts?
 *
 * The simulation reuses the user wallet + amounts from a recent on-chain
 * swap. Sourcing the user means the wallet has the required SOL and ATAs at
 * sim time, so the only thing being tested is the SDK's ix construction
 * against the current program state.
 *
 * Usage:
 *   HELIUS_RPC_URL=https://... npx ts-node src/trading/pumpswap-verify.ts <txSig> [--ixIndex=N]
 *
 * Or programmatically:
 *   const report = await verifyPumpswapSwap(connection, '<sig>');
 *   if (!report.matched) console.error(report);
 */

import {
  Connection,
  PublicKey,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type Database from 'better-sqlite3';
import BN from 'bn.js';
import {
  PUMPSWAP_PROGRAM_ID,
  buildBuyInstructions,
  buildSellInstructions,
} from './pumpswap-swap';

export interface VerifyReport {
  matched: boolean;
  txSignature: string;
  direction: 'buy' | 'sell' | 'unknown';
  /** Pool the source tx targeted — also the pool the SDK rebuild uses. */
  pool: string;
  /** Wallet from the source tx — sim runs as this wallet (sigVerify=false). */
  user: string;
  /** Number of ixs in the SDK output (ATA, wsol prep, swap, close, etc.). */
  ixCount: number;
  /** simulateTransaction result. err=null is the matched case. */
  err: unknown;
  logs: string[] | null;
  unitsConsumed: number | null;
  notes: string;
}

const DISC_BUY_HEX = '66063d1201daebea';
const DISC_SELL_HEX = '33e685a4017f83ad';

/**
 * Walk recent graduations in the DB and collect every PumpSwap swap we find
 * across the search window. Returns up to {limit} candidates ordered with
 * BUYs first (most reliable for sim — buyers retain SOL longer than sellers
 * retain a specific SPL balance), then sells as fallback.
 *
 * The route hits each in turn until a simulation succeeds — historical user
 * wallets can drift (drained SOL, closed ATAs), so a single try is too noisy
 * to be useful. Five tries is enough that flakiness drops below 1% in
 * practice while still bounding the RPC cost (≤5 × getSignaturesForAddress +
 * ≤50 × getTransaction).
 */
export async function findRecentPumpSwapCandidates(
  connection: Connection,
  db: Database.Database,
  limit = 5,
): Promise<Array<{ sig: string; poolAddress: string; ixIndex: number; direction: 'buy' | 'sell' }>> {
  const pools = db.prepare(`
    SELECT new_pool_address FROM graduations
    WHERE new_pool_address IS NOT NULL
      AND new_pool_dex = 'pumpswap'
    ORDER BY timestamp DESC
    LIMIT 5
  `).all() as Array<{ new_pool_address: string }>;

  const buys: Array<{ sig: string; poolAddress: string; ixIndex: number; direction: 'buy' }> = [];
  const sells: Array<{ sig: string; poolAddress: string; ixIndex: number; direction: 'sell' }> = [];

  for (const { new_pool_address: poolAddr } of pools) {
    if (buys.length >= limit) break;
    let sigs;
    try {
      sigs = await connection.getSignaturesForAddress(
        new PublicKey(poolAddr),
        { limit: 10 },
        'confirmed',
      );
    } catch {
      continue;
    }
    for (const { signature } of sigs) {
      if (buys.length >= limit) break;
      let tx;
      try {
        tx = await connection.getTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
      } catch {
        continue;
      }
      if (!tx) continue;
      const msg = tx.transaction.message;
      const loadedAddrs = tx.meta?.loadedAddresses;
      const accountKeys = msg.getAccountKeys({ accountKeysFromLookups: loadedAddrs });
      for (let i = 0; i < msg.compiledInstructions.length; i++) {
        const ix = msg.compiledInstructions[i];
        const pid = accountKeys.get(ix.programIdIndex);
        if (!pid || !pid.equals(PUMPSWAP_PROGRAM_ID)) continue;
        const disc = Buffer.from(ix.data).subarray(0, 8).toString('hex');
        if (disc === DISC_BUY_HEX) {
          buys.push({ sig: signature, poolAddress: poolAddr, ixIndex: i, direction: 'buy' });
        } else if (disc === DISC_SELL_HEX) {
          sells.push({ sig: signature, poolAddress: poolAddr, ixIndex: i, direction: 'sell' });
        }
      }
    }
  }

  return [...buys.slice(0, limit), ...sells.slice(0, Math.max(1, limit - buys.length))];
}

export async function verifyPumpswapSwap(
  connection: Connection,
  txSignature: string,
  opts: { ixIndex?: number } = {},
): Promise<VerifyReport> {
  const tx = await connection.getTransaction(txSignature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });
  if (!tx) {
    throw new Error(`Transaction ${txSignature} not found`);
  }

  const msg = tx.transaction.message;
  const loadedAddrs = tx.meta?.loadedAddresses;
  const accountKeys = msg.getAccountKeys({ accountKeysFromLookups: loadedAddrs });
  const compiledIxs = msg.compiledInstructions;

  const pumpswapIxIndex = opts.ixIndex ?? compiledIxs.findIndex(
    (ix) => accountKeys.get(ix.programIdIndex)?.equals(PUMPSWAP_PROGRAM_ID),
  );
  if (pumpswapIxIndex == null || pumpswapIxIndex < 0) {
    throw new Error(`No PumpSwap instruction found in tx ${txSignature}`);
  }
  const onIx = compiledIxs[pumpswapIxIndex];
  const onProgramId = accountKeys.get(onIx.programIdIndex);
  if (!onProgramId || !onProgramId.equals(PUMPSWAP_PROGRAM_ID)) {
    throw new Error(`ix[${pumpswapIxIndex}] is not a PumpSwap instruction`);
  }
  const onIxData = Buffer.from(onIx.data);
  const onDisc = onIxData.subarray(0, 8).toString('hex');
  const direction: 'buy' | 'sell' | 'unknown' =
    onDisc === DISC_BUY_HEX ? 'buy' : onDisc === DISC_SELL_HEX ? 'sell' : 'unknown';

  const onAccounts = onIx.accountKeyIndexes.map((idx) => accountKeys.get(idx)!);
  const pool = onAccounts[0];
  const user = onAccounts[1];

  if (direction === 'unknown') {
    return {
      matched: false,
      txSignature,
      direction,
      pool: pool.toBase58(),
      user: user.toBase58(),
      ixCount: 0,
      err: null,
      logs: null,
      unitsConsumed: null,
      notes: `Unknown discriminator ${onDisc} — expected buy=${DISC_BUY_HEX} or sell=${DISC_SELL_HEX}`,
    };
  }

  // Args (u64, u64) live after the 8-byte discriminator. Reuse the on-chain
  // amounts so the user's wallet definitely has the funds at sim time.
  const arg1 = new BN(onIxData.subarray(8, 16), 'le');
  const arg2 = new BN(onIxData.subarray(16, 24), 'le');

  const sdkIxs = direction === 'buy'
    ? await buildBuyInstructions(connection, {
        pool, wallet: user,
        baseAmountOut: BigInt(arg1.toString()),
        maxQuoteAmountIn: BigInt(arg2.toString()),
      })
    : await buildSellInstructions(connection, {
        pool, wallet: user,
        baseAmountIn: BigInt(arg1.toString()),
        minQuoteAmountOut: BigInt(arg2.toString()),
      });

  // Frame the SDK output the same way the executor does — compute-budget on
  // the front, no Jito tip (the simulator doesn't need it). replaceRecentBlockhash
  // means we don't need a fresh getLatestBlockhash, but we still need a placeholder.
  const placeholderBlockhash = '11111111111111111111111111111111';
  const message = new TransactionMessage({
    payerKey: user,
    recentBlockhash: placeholderBlockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ...sdkIxs,
    ],
  }).compileToV0Message();
  const versioned = new VersionedTransaction(message);

  const sim = await connection.simulateTransaction(versioned, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'confirmed',
  });

  const matched = sim.value.err == null;
  return {
    matched,
    txSignature,
    direction,
    pool: pool.toBase58(),
    user: user.toBase58(),
    ixCount: sdkIxs.length,
    err: sim.value.err,
    logs: sim.value.logs ?? null,
    unitsConsumed: sim.value.unitsConsumed ?? null,
    notes: matched
      ? `OK — SDK-built ${direction} ix simulated successfully (${sim.value.unitsConsumed ?? '?'} CU).`
      : explainSimFailure(direction, sim.value.err, sim.value.logs ?? []),
  };
}

/** Human-readable notes for common simulation failures. Falls back to raw JSON. */
function explainSimFailure(
  direction: 'buy' | 'sell',
  err: unknown,
  logs: readonly string[],
): string {
  const joined = logs.join('\n');
  // Anchor error 3012 = AccountNotInitialized. On a sell, it's almost always
  // the source wallet having closed the base ATA after exiting — not an SDK
  // bug. Re-run to auto-pick a newer swap (or a buy instead of a sell).
  if (joined.includes('Error Code: AccountNotInitialized') &&
      joined.includes('user_base_token_account') &&
      direction === 'sell') {
    return 'simulation failed: source wallet closed its base ATA after the source sell — not an SDK issue. '
      + 'Re-run the endpoint (auto-pick prefers buys; this means no recent buys were available). '
      + `Raw err: ${JSON.stringify(err)}`;
  }
  // SystemProgram error 1 = insufficient lamports. The source wallet has
  // drained SOL since the source tx — not an SDK bug. Same as above: env, not code.
  if (joined.includes('insufficient lamports')) {
    const m = joined.match(/insufficient lamports (\d+), need (\d+)/);
    const detail = m ? ` (had ${m[1]}, needed ${m[2]} lamports)` : '';
    return `simulation failed: source wallet has drained SOL since the source ${direction}${detail} — `
      + `not an SDK issue. Re-run the endpoint to try a different recent buyer. Raw err: ${JSON.stringify(err)}`;
  }
  if (joined.includes('Error Code: AccountNotInitialized')) {
    return `simulation failed: AccountNotInitialized — source wallet state has drifted since the source tx. Raw err: ${JSON.stringify(err)}`;
  }
  return `simulation failed: ${JSON.stringify(err)}`;
}

// ── CLI entry point ─────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const sig = process.argv[2];
    if (!sig) {
      console.error('usage: npx ts-node src/trading/pumpswap-verify.ts <txSignature> [--ixIndex=N]');
      process.exit(2);
    }
    const ixIdxArg = process.argv.find((a) => a.startsWith('--ixIndex='));
    const ixIndex = ixIdxArg ? parseInt(ixIdxArg.split('=')[1], 10) : undefined;

    const rpcUrl = process.env.HELIUS_RPC_URL;
    if (!rpcUrl) {
      console.error('HELIUS_RPC_URL must be set');
      process.exit(2);
    }
    const connection = new Connection(rpcUrl, 'confirmed');
    try {
      const report = await verifyPumpswapSwap(connection, sig, { ixIndex });
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.matched ? 0 : 1);
    } catch (err) {
      console.error('verify failed:', err instanceof Error ? err.message : err);
      process.exit(3);
    }
  })();
}
