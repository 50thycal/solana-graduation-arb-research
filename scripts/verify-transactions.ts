/**
 * Verify specific transaction signatures to confirm:
 * 1. Whether they are real pump.fun migration/graduation transactions
 * 2. What the REAL token mint is
 * 3. Whether the bot's extracted mint matches
 * 4. Whether a PumpSwap pool exists for the token
 *
 * Usage: npx ts-node scripts/verify-transactions.ts
 * Requires: HELIUS_RPC_URL environment variable
 */

import { Connection, PublicKey } from '@solana/web3.js';

const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const TRANSACTIONS = [
  {
    label: 'TX #1',
    signature: '41f2FemEvyGq7bbg6JTP5wB73DZrmJTmaZBdp2u1XrLg5B8kvnEhGahT9sNDcWYkzycyBALC3QaPzLrdpG1L9K4h',
    botExtractedMint: '5cAiwaNA', // or 5cV5m86m
    botDerivedPool: '6i5KgFDe6maivJVDNCiPCMhLpG79MeRgNQT96Z1zokMc',
    holderNote: '"not a Token mint"',
  },
  {
    label: 'TX #2',
    signature: '1VLmCVjkfhazF2yZKGJqir3mvkEK3egEJfewGVdNaYH9mNS76NESR1rjEPmECfzeHjysxJMrEiPut5uuuZv4jiG',
    botExtractedMint: 'HE7jX5hh',
    botDerivedPool: '8P381ve4NFzd9xKMdc7ggvVsuCqBVnxZDEZLMFqmZaFS',
    holderNote: '',
  },
];

function buildFullAccountKeys(tx: any): string[] {
  const toStr = (k: any): string => {
    if (typeof k === 'string') return k;
    if (k?.pubkey) return typeof k.pubkey === 'string' ? k.pubkey : k.pubkey.toBase58?.() ?? '';
    return k?.toBase58?.() ?? '';
  };
  const static_ = (tx.transaction.message.accountKeys as any[]).map(toStr);
  const loaded = tx.meta?.loadedAddresses;
  if (!loaded) return static_;
  const writable = (loaded.writable as any[] ?? []).map(toStr);
  const readonly = (loaded.readonly as any[] ?? []).map(toStr);
  return [...static_, ...writable, ...readonly];
}

async function main() {
  const rpcUrl = process.env.HELIUS_RPC_URL;
  if (!rpcUrl) {
    console.error('ERROR: HELIUS_RPC_URL environment variable is required');
    process.exit(1);
  }

  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });

  for (const txInfo of TRANSACTIONS) {
    console.log('\n' + '='.repeat(80));
    console.log(`${txInfo.label}: ${txInfo.signature.slice(0, 30)}...`);
    console.log('='.repeat(80));

    try {
      const tx = await connection.getParsedTransaction(txInfo.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (!tx) {
        console.log('  RESULT: Transaction NOT FOUND on-chain');
        console.log('  This could mean: invalid signature, too old (pruned), or wrong cluster');
        continue;
      }

      if (tx.meta?.err) {
        console.log('  RESULT: Transaction FAILED (has error)');
        console.log('  Error:', JSON.stringify(tx.meta.err));
        continue;
      }

      const accountKeys = buildFullAccountKeys(tx);

      // Check which programs are involved
      const programIds = new Set<string>();
      for (const ix of tx.transaction.message.instructions) {
        const pid = typeof (ix as any).programId === 'string'
          ? (ix as any).programId
          : (ix as any).programId?.toBase58?.() ?? '';
        if (pid) programIds.add(pid);
      }
      if (tx.meta?.innerInstructions) {
        for (const inner of tx.meta.innerInstructions) {
          for (const ix of inner.instructions) {
            const pid = typeof (ix as any).programId === 'string'
              ? (ix as any).programId
              : (ix as any).programId?.toBase58?.() ?? '';
            if (pid) programIds.add(pid);
          }
        }
      }

      const hasPumpFun = programIds.has(PUMP_FUN_PROGRAM);
      const hasPumpSwap = programIds.has(PUMPSWAP_PROGRAM);

      console.log(`  Block time: ${tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : 'unknown'}`);
      console.log(`  Slot: ${tx.slot}`);
      console.log(`  Has pump.fun program: ${hasPumpFun}`);
      console.log(`  Has PumpSwap program: ${hasPumpSwap}`);

      // Check for "Instruction: Migrate" in logs
      const logs = tx.meta?.logMessages || [];
      const hasMigrateLog = logs.some((l: string) => l.includes('Instruction: Migrate'));
      const hasCreatePoolLog = logs.some((l: string) => l.includes('create_pool'));
      console.log(`  Has "Instruction: Migrate" log: ${hasMigrateLog}`);
      console.log(`  Has "create_pool" log: ${hasCreatePoolLog}`);
      console.log(`  IS GRADUATION: ${hasPumpFun && hasMigrateLog ? 'YES' : 'NO / UNCERTAIN'}`);

      // Extract mints from token balances (most reliable)
      const mintFromBalances = new Set<string>();
      for (const tb of (tx.meta?.preTokenBalances || [])) {
        if (tb.mint && tb.mint !== WSOL_MINT) mintFromBalances.add(tb.mint);
      }
      for (const tb of (tx.meta?.postTokenBalances || [])) {
        if (tb.mint && tb.mint !== WSOL_MINT) mintFromBalances.add(tb.mint);
      }

      console.log(`\n  TOKEN MINTS IN TRANSACTION (from token balances):`);
      for (const m of mintFromBalances) {
        console.log(`    - ${m}`);
      }

      // Extract mint from pump.fun instruction accounts[2]
      let mintFromIx: string | null = null;
      const toStr = (a: any): string | null => typeof a === 'string' ? a : a?.toBase58?.() ?? null;

      for (const ix of tx.transaction.message.instructions) {
        const pid = typeof (ix as any).programId === 'string'
          ? (ix as any).programId : (ix as any).programId?.toBase58?.() ?? '';
        if (pid !== PUMP_FUN_PROGRAM) continue;
        const accts = (ix as any).accounts;
        if (Array.isArray(accts) && accts.length >= 3) {
          mintFromIx = toStr(accts[2]);
        }
      }

      console.log(`\n  MINT FROM INSTRUCTION accounts[2]: ${mintFromIx || 'NOT FOUND (ParsedInstruction or no accounts array)'}`);

      // Compare with bot's extraction
      const realMints = [...mintFromBalances];
      const botMintPrefix = txInfo.botExtractedMint;
      const botMintMatches = realMints.some(m => m.startsWith(botMintPrefix));
      const ixMintMatches = mintFromIx ? mintFromIx.startsWith(botMintPrefix) : false;

      console.log(`\n  BOT COMPARISON:`);
      console.log(`    Bot extracted mint starts with: ${botMintPrefix}`);
      console.log(`    Match in token balances: ${botMintMatches}`);
      console.log(`    Match in instruction accts[2]: ${ixMintMatches}`);

      if (!botMintMatches && !ixMintMatches) {
        console.log(`    *** MISMATCH: Bot's mint does NOT match any mint in this transaction! ***`);
        if (mintFromIx) {
          console.log(`    Real mint from instruction: ${mintFromIx} (starts with: ${mintFromIx.slice(0, 8)})`);
        }
        if (realMints.length > 0) {
          console.log(`    Real mint(s) from balances: ${realMints.join(', ')}`);
        }
      }

      // Try to derive PumpSwap pool PDA for each real mint
      console.log(`\n  PUMPSWAP POOL PDA DERIVATION:`);
      const PUMP_FUN_KEY = new PublicKey(PUMP_FUN_PROGRAM);
      const PUMPSWAP_KEY = new PublicKey(PUMPSWAP_PROGRAM);
      const WSOL_KEY = new PublicKey(WSOL_MINT);

      for (const realMint of realMints) {
        try {
          const baseMintKey = new PublicKey(realMint);
          const [poolAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from('pool-authority'), baseMintKey.toBuffer()],
            PUMP_FUN_KEY
          );
          const indexBuffer = Buffer.alloc(2);
          indexBuffer.writeUInt16LE(0);
          const [derivedPool] = PublicKey.findProgramAddressSync(
            [
              Buffer.from('pool'),
              indexBuffer,
              poolAuthority.toBuffer(),
              baseMintKey.toBuffer(),
              WSOL_KEY.toBuffer(),
            ],
            PUMPSWAP_KEY
          );

          const derivedPoolAddr = derivedPool.toBase58();
          const matchesBot = derivedPoolAddr === txInfo.botDerivedPool;

          // Check if pool account exists on-chain
          const poolAccount = await connection.getAccountInfo(derivedPool);
          const poolExists = poolAccount !== null && poolAccount.data.length > 0;
          const poolOwner = poolAccount?.owner?.toBase58?.() ?? 'N/A';

          console.log(`    Mint: ${realMint}`);
          console.log(`      Derived pool PDA: ${derivedPoolAddr}`);
          console.log(`      Bot's derived pool: ${txInfo.botDerivedPool}`);
          console.log(`      Pool PDA matches bot: ${matchesBot}`);
          console.log(`      Pool exists on-chain: ${poolExists}`);
          if (poolExists) {
            console.log(`      Pool owner: ${poolOwner}`);
            console.log(`      Pool data length: ${poolAccount!.data.length} bytes`);
          }
        } catch (err) {
          console.log(`    Mint ${realMint}: PDA derivation error - ${(err as Error).message}`);
        }
      }

      // Also try the bot's extracted mint prefix — derive pool and check
      if (!botMintMatches) {
        console.log(`\n  BOT MINT POOL CHECK (using bot's extracted mint prefix):`);
        console.log(`    Cannot derive pool from prefix only — need full mint address`);
        console.log(`    Bot's derived pool: ${txInfo.botDerivedPool}`);

        // Check if bot's pool exists anyway
        try {
          const botPoolKey = new PublicKey(txInfo.botDerivedPool);
          const poolAccount = await connection.getAccountInfo(botPoolKey);
          const exists = poolAccount !== null;
          console.log(`    Bot's pool account exists: ${exists}`);
          if (exists) {
            console.log(`    Pool owner: ${poolAccount!.owner.toBase58()}`);
          }
        } catch (err) {
          console.log(`    Could not check bot's pool: ${(err as Error).message}`);
        }
      }

      // Print all account keys for manual inspection
      console.log(`\n  ALL ACCOUNT KEYS IN TX (${accountKeys.length} total):`);
      accountKeys.forEach((key, idx) => {
        const note = key === PUMP_FUN_PROGRAM ? ' [PUMP.FUN]'
          : key === PUMPSWAP_PROGRAM ? ' [PUMPSWAP]'
          : key === WSOL_MINT ? ' [WSOL]'
          : mintFromBalances.has(key) ? ' [TOKEN MINT]'
          : key === '11111111111111111111111111111111' ? ' [SYSTEM]'
          : key === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ? ' [TOKEN PROG]'
          : '';
        console.log(`    [${idx.toString().padStart(2)}] ${key}${note}`);
      });

      // Print relevant logs
      console.log(`\n  TRANSACTION LOGS (first 20):`);
      logs.slice(0, 20).forEach((log: string, idx: number) => {
        console.log(`    ${idx}: ${log}`);
      });

    } catch (err) {
      console.error(`  ERROR fetching transaction: ${(err as Error).message}`);
    }
  }
}

main().catch(console.error);
