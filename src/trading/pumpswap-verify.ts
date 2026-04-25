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
 * Walk recent graduations in the DB and fetch signatures on each pool until
 * we find one whose tx contains a PumpSwap buy/sell ix. Returns {sig, pool,
 * ixIndex} for the first match, or null if nothing in the search window.
 */
export async function findRecentPumpSwapSwap(
  connection: Connection,
  db: Database.Database,
): Promise<{ sig: string; poolAddress: string; ixIndex: number; direction: 'buy' | 'sell' } | null> {
  const pools = db.prepare(`
    SELECT new_pool_address FROM graduations
    WHERE new_pool_address IS NOT NULL
      AND new_pool_dex = 'pumpswap'
    ORDER BY timestamp DESC
    LIMIT 5
  `).all() as Array<{ new_pool_address: string }>;

  for (const { new_pool_address: poolAddr } of pools) {
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
          return { sig: signature, poolAddress: poolAddr, ixIndex: i, direction: 'buy' };
        }
        if (disc === DISC_SELL_HEX) {
          return { sig: signature, poolAddress: poolAddr, ixIndex: i, direction: 'sell' };
        }
      }
    }
  }
  return null;
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
      : `simulation failed: ${JSON.stringify(sim.value.err)}`,
  };
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
