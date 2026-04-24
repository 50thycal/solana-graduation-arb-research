/**
 * PumpSwap IDL byte-equality verifier.
 *
 * Fetches a known-good PumpSwap swap transaction from mainnet, extracts its
 * `buy` or `sell` instruction, and rebuilds the same instruction with our
 * builder in pumpswap-swap.ts. Reports any byte-level diff in the
 * discriminator, args, or account list (addresses + writable/signer flags).
 *
 * This is the verification step the rollout plan mandates before flipping
 * the first strategy to shadow mode: our builder ships with an IDL layout
 * that matches public documentation, but we can't compile-time-check it
 * against the live program.
 *
 * Usage:
 *   HELIUS_RPC_URL=https://... npx ts-node src/trading/pumpswap-verify.ts <txSignature> [--ixIndex=N]
 *
 * Or programmatically:
 *   import { verifyPumpswapSwap } from './pumpswap-verify';
 *   const report = await verifyPumpswapSwap(connection, '<sig>');
 *   if (!report.matched) console.error(report);
 */

import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import {
  PUMPSWAP_PROGRAM_ID,
  buildBuyIx,
  buildSellIx,
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
  // accountKeys() must be called with loaded addresses. getAccountKeys returns
  // static + loaded in order.
  const msg = tx.transaction.message;
  const loadedAddrs = tx.meta?.loadedAddresses;
  const accountKeys = msg.getAccountKeys({ accountKeysFromLookups: loadedAddrs });

  // Each compiled instruction has: programIdIndex, accountKeyIndexes[], data.
  const compiledIxs = msg.compiledInstructions;

  // Pick the target ix — default to first PumpSwap-program ix; user can
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

  const onAccounts = onIx.accountKeyIndexes.map((idx, i) => {
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

  // Extract swap args from ix data. Both buy and sell are (u64, u64) after
  // the 8-byte discriminator.
  const arg1 = new BN(onIxData.subarray(8, 16), 'le');
  const arg2 = new BN(onIxData.subarray(16, 24), 'le');

  // Extract the accounts we need to rebuild from the on-chain ix. Index
  // positions below mirror the layout in pumpswap-swap.ts commonSwapKeys().
  const IDX = {
    pool: 0,
    wallet: 1,
    baseMint: 3,
    quoteMint: 4,
    baseVault: 7,
    quoteVault: 8,
    creatorVaultAuthority: 18,
  };

  // Rebuild with our builder.
  const rebuiltParams = {
    pool: new PublicKey(onAccounts[IDX.pool].pubkey),
    baseMint: new PublicKey(onAccounts[IDX.baseMint].pubkey),
    quoteMint: new PublicKey(onAccounts[IDX.quoteMint].pubkey),
    baseVault: new PublicKey(onAccounts[IDX.baseVault].pubkey),
    quoteVault: new PublicKey(onAccounts[IDX.quoteVault].pubkey),
    // Creator isn't directly on the ix — the creator_vault_authority PDA is.
    // Read creator from the pool account data (offset 11-43).
    creator: await readPoolCreator(connection, new PublicKey(onAccounts[IDX.pool].pubkey)),
    wallet: new PublicKey(onAccounts[IDX.wallet].pubkey),
  };

  let rebuiltIx: TransactionInstruction;
  if (direction === 'buy') {
    rebuiltIx = buildBuyIx({
      ...rebuiltParams,
      baseAmountOut: BigInt(arg1.toString()),
      maxQuoteAmountIn: BigInt(arg2.toString()),
    });
  } else {
    rebuiltIx = buildSellIx({
      ...rebuiltParams,
      baseAmountIn: BigInt(arg1.toString()),
      minQuoteAmountOut: BigInt(arg2.toString()),
    });
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
      ? 'OK — on-chain ix bytes match our builder.'
      : `${accountMismatches.length} account mismatch(es); data match=${argsMatch}`,
  };
}

async function readPoolCreator(connection: Connection, pool: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(pool, 'confirmed');
  if (!info?.data) throw new Error('Pool account not found');
  const data = info.data as Buffer;
  if (data.length < 43) throw new Error(`Pool account too small: ${data.length} bytes`);
  return new PublicKey(data.subarray(11, 43));
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
