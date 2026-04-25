/**
 * PumpSwap byte-equality verifier.
 *
 * Fetches a known-good PumpSwap swap transaction from mainnet, finds its
 * `buy` or `sell` ix, and rebuilds the same ix via the official
 * `@pump-fun/pump-swap-sdk` (the same builder used by the executor). Reports
 * any byte-level diff in the discriminator, args, or account list (addresses
 * + writable/signer flags).
 *
 * This is the regression gate the live-execution rollout plan mandates before
 * flipping any strategy to shadow mode. We previously hand-rolled the ix from
 * the published IDL — that drifted (Token-2022, fee_program CPIs, cashback
 * trailing accounts) and the verifier caught it. Switching the builder to the
 * SDK lets the upstream package track the program; this file just diffs.
 *
 * Usage:
 *   HELIUS_RPC_URL=https://... npx ts-node src/trading/pumpswap-verify.ts <txSig> [--ixIndex=N]
 *
 * Or programmatically:
 *   const report = await verifyPumpswapSwap(connection, '<sig>');
 *   if (!report.matched) console.error(report);
 */

import { Connection, PublicKey } from '@solana/web3.js';
import type Database from 'better-sqlite3';
import BN from 'bn.js';
import {
  PUMPSWAP_PROGRAM_ID,
  buildBuyInstructions,
  buildSellInstructions,
} from './pumpswap-swap';

export interface InstructionSnapshot {
  programId: string;
  discriminator: string; // hex
  dataHex: string;       // full ix data hex
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
}

export interface VerifyReport {
  matched: boolean;
  txSignature: string;
  ixIndex: number;
  direction: 'buy' | 'sell' | 'unknown';
  discriminatorMatch: boolean;
  argsMatch: boolean;
  accountCountMatch: boolean;
  accountMismatches: Array<{
    index: number;
    expectedPubkey: string;
    actualPubkey: string;
    expectedWritable: boolean;
    actualWritable: boolean;
    expectedSigner: boolean;
    actualSigner: boolean;
  }>;
  onChain: InstructionSnapshot;
  rebuilt: InstructionSnapshot;
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

  // Resolve the account list — for v0 txs with address lookup tables, message
  // accountKeys() must be called with loaded addresses.
  const msg = tx.transaction.message;
  const loadedAddrs = tx.meta?.loadedAddresses;
  const accountKeys = msg.getAccountKeys({ accountKeysFromLookups: loadedAddrs });
  const compiledIxs = msg.compiledInstructions;

  // Pick the target ix — default to the first PumpSwap-program ix; caller can
  // override by index.
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

  const onAccounts = onIx.accountKeyIndexes.map((idx) => {
    const pk = accountKeys.get(idx)!;
    return {
      pubkey: pk.toBase58(),
      isSigner: msg.isAccountSigner(idx),
      isWritable: msg.isAccountWritable(idx),
    };
  });

  const onSnapshot: InstructionSnapshot = {
    programId: onProgramId.toBase58(),
    discriminator: onDisc,
    dataHex: onIxData.toString('hex'),
    accounts: onAccounts,
  };

  if (direction === 'unknown') {
    return {
      matched: false,
      txSignature,
      ixIndex: pumpswapIxIndex,
      direction,
      discriminatorMatch: false,
      argsMatch: false,
      accountCountMatch: false,
      accountMismatches: [],
      onChain: onSnapshot,
      rebuilt: onSnapshot,
      notes: `Unknown discriminator ${onDisc} — expected buy=${DISC_BUY_HEX} or sell=${DISC_SELL_HEX}`,
    };
  }

  // Args (u64, u64) live after the 8-byte discriminator. Rebuilding requires
  // only pool + user — the SDK derives every other account from the pool struct.
  const arg1 = new BN(onIxData.subarray(8, 16), 'le');
  const arg2 = new BN(onIxData.subarray(16, 24), 'le');
  const pool = new PublicKey(onAccounts[0].pubkey);
  const wallet = new PublicKey(onAccounts[1].pubkey);

  // SDK returns the full sequence (ATA-create, wSOL prep, swap, close). We
  // only diff the swap ix — the rest are SPL-program ixs that aren't part of
  // PumpSwap's account list.
  const allIxs = direction === 'buy'
    ? await buildBuyInstructions(connection, {
        pool, wallet,
        baseAmountOut: BigInt(arg1.toString()),
        maxQuoteAmountIn: BigInt(arg2.toString()),
      })
    : await buildSellInstructions(connection, {
        pool, wallet,
        baseAmountIn: BigInt(arg1.toString()),
        minQuoteAmountOut: BigInt(arg2.toString()),
      });

  const rebuiltIx = allIxs.find((ix) => ix.programId.equals(PUMPSWAP_PROGRAM_ID));
  if (!rebuiltIx) {
    throw new Error('SDK did not produce a PumpSwap-program ix in its output array');
  }

  const rebuiltData = rebuiltIx.data;
  const rebuiltAccounts = rebuiltIx.keys.map((k) => ({
    pubkey: k.pubkey.toBase58(),
    isSigner: k.isSigner,
    isWritable: k.isWritable,
  }));

  const rebuiltSnapshot: InstructionSnapshot = {
    programId: rebuiltIx.programId.toBase58(),
    discriminator: rebuiltData.subarray(0, 8).toString('hex'),
    dataHex: rebuiltData.toString('hex'),
    accounts: rebuiltAccounts,
  };

  const discriminatorMatch = onSnapshot.discriminator === rebuiltSnapshot.discriminator;
  const argsMatch = onSnapshot.dataHex === rebuiltSnapshot.dataHex;
  const accountCountMatch = onAccounts.length === rebuiltAccounts.length;

  const accountMismatches: VerifyReport['accountMismatches'] = [];
  const maxLen = Math.max(onAccounts.length, rebuiltAccounts.length);
  for (let i = 0; i < maxLen; i++) {
    const on = onAccounts[i];
    const rb = rebuiltAccounts[i];
    if (!on || !rb ||
        on.pubkey !== rb.pubkey ||
        on.isSigner !== rb.isSigner ||
        on.isWritable !== rb.isWritable) {
      accountMismatches.push({
        index: i,
        expectedPubkey: rb?.pubkey ?? '<missing>',
        actualPubkey: on?.pubkey ?? '<missing>',
        expectedWritable: rb?.isWritable ?? false,
        actualWritable: on?.isWritable ?? false,
        expectedSigner: rb?.isSigner ?? false,
        actualSigner: on?.isSigner ?? false,
      });
    }
  }

  const matched = discriminatorMatch && argsMatch && accountCountMatch && accountMismatches.length === 0;
  return {
    matched,
    txSignature,
    ixIndex: pumpswapIxIndex,
    direction,
    discriminatorMatch,
    argsMatch,
    accountCountMatch,
    accountMismatches,
    onChain: onSnapshot,
    rebuilt: rebuiltSnapshot,
    notes: matched
      ? 'OK — SDK-rebuilt ix bytes match on-chain.'
      : `${accountMismatches.length} account mismatch(es); data match=${argsMatch}`,
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
