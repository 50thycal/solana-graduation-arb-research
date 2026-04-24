/**
 * PumpSwap AMM swap instruction builder.
 *
 * Program: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
 *
 * The two instructions we care about are `buy` (quote → base) and `sell`
 * (base → quote). This file encodes both as raw TransactionInstructions so we
 * can compose them with compute-budget + Jito tip transfers in a single tx.
 *
 * Account ordering and Anchor discriminator below follow the pump.fun AMM
 * IDL as publicly documented. Because we can't verify the IDL against a
 * live devnet (PumpSwap is mainnet-only), the live-execution rollout plan
 * mandates a byte-equality test against a known on-chain swap before flipping
 * from paper → shadow. See the plan file's Verification step 1.
 *
 * Discriminators (Anchor = sha256("global:<name>")[:8]):
 *   buy  → 66 06 3d 12 01 da eb ea
 *   sell → 33 e6 85 a4 01 7f 83 ad
 */

import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import BN from 'bn.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  WSOL_MINT,
  getAssociatedTokenAddress,
} from './wallet';

export const PUMPSWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

// Anchor discriminators, precomputed via `sha256("global:<name>")[:8]`.
const DISC_BUY = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);
const DISC_SELL = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);

/** Derive global config PDA (seed = "global_config"). */
function getGlobalConfigPda(): PublicKey {
  const [addr] = PublicKey.findProgramAddressSync(
    [Buffer.from('global_config')],
    PUMPSWAP_PROGRAM_ID,
  );
  return addr;
}

/** Derive the program's self-referential event authority PDA. */
function getEventAuthorityPda(): PublicKey {
  const [addr] = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    PUMPSWAP_PROGRAM_ID,
  );
  return addr;
}

/** Derive the creator vault authority PDA (seed "creator_vault" + creator). */
function getCreatorVaultAuthorityPda(creator: PublicKey): PublicKey {
  const [addr] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator_vault'), creator.toBuffer()],
    PUMPSWAP_PROGRAM_ID,
  );
  return addr;
}

/** Encode a u64 little-endian. */
function u64LE(n: number | bigint | BN): Buffer {
  return new BN(typeof n === 'bigint' ? n.toString() : n).toArrayLike(Buffer, 'le', 8);
}

/**
 * Derive the protocol fee recipient. This is a fixed set of accounts maintained
 * by PumpSwap — the live protocol rotates between them. We ship a known-good
 * recipient pulled from a recent PumpSwap swap tx and accept that this may
 * need refreshing if PumpSwap rotates the set. The recipient is selected at
 * swap-build time from the global_config account's `protocol_fee_recipients`
 * array; for now we hardcode the first entry.
 *
 * If the IDL structure changes, the verification step (byte-compare to a
 * known tx) will catch it.
 */
export const PROTOCOL_FEE_RECIPIENT = new PublicKey(
  '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV',
);

export interface BuildSwapParams {
  pool: PublicKey;
  baseMint: PublicKey;
  /** quoteMint is wSOL for graduated pump.fun tokens — pass WSOL_MINT */
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  /** Token creator (needed for creator_vault PDA). Read from pool metadata. */
  creator: PublicKey;
  wallet: PublicKey;
}

export interface BuildBuyParams extends BuildSwapParams {
  /** Exact base (token) amount we want out, in raw u64 (not decimal-adjusted). */
  baseAmountOut: bigint;
  /** Max quote (lamports) we're willing to pay — slippage guardrail. */
  maxQuoteAmountIn: bigint;
}

export interface BuildSellParams extends BuildSwapParams {
  /** Exact base (token) amount we're selling, raw u64. */
  baseAmountIn: bigint;
  /** Min quote (lamports) we'll accept — slippage guardrail. */
  minQuoteAmountOut: bigint;
}

/**
 * Build the PumpSwap `buy` instruction. The caller is responsible for:
 *   - pre-creating/idempotent-creating the user's base ATA (see `buildAtaCreateIx`)
 *   - pre-creating/funding the user's quote (wSOL) ATA and calling `syncNative`
 *     so the pool can pull exactly `maxQuoteAmountIn` lamports
 *   - closing the wSOL ATA post-swap to recover rent + leftover lamports
 */
export function buildBuyIx(p: BuildBuyParams): TransactionInstruction {
  const data = Buffer.concat([
    DISC_BUY,
    u64LE(p.baseAmountOut),
    u64LE(p.maxQuoteAmountIn),
  ]);

  return new TransactionInstruction({
    programId: PUMPSWAP_PROGRAM_ID,
    keys: commonSwapKeys(p, /* isBuy */ true),
    data,
  });
}

/** Build the PumpSwap `sell` instruction. Quote (wSOL) lands in the user's wSOL ATA. */
export function buildSellIx(p: BuildSellParams): TransactionInstruction {
  const data = Buffer.concat([
    DISC_SELL,
    u64LE(p.baseAmountIn),
    u64LE(p.minQuoteAmountOut),
  ]);

  return new TransactionInstruction({
    programId: PUMPSWAP_PROGRAM_ID,
    keys: commonSwapKeys(p, /* isBuy */ false),
    data,
  });
}

/**
 * Account ordering for PumpSwap buy/sell. Pulled from the pump.fun AMM IDL.
 * Writable/signer flags below match the expected layout; the verification step
 * will byte-compare this against a real on-chain swap.
 */
function commonSwapKeys(p: BuildSwapParams, isBuy: boolean) {
  const userBaseAta = getAssociatedTokenAddress(p.baseMint, p.wallet);
  const userQuoteAta = getAssociatedTokenAddress(p.quoteMint, p.wallet);
  const protocolFeeRecipientAta = getAssociatedTokenAddress(p.quoteMint, PROTOCOL_FEE_RECIPIENT);
  const creatorVaultAuth = getCreatorVaultAuthorityPda(p.creator);
  const creatorVaultAta = getAssociatedTokenAddress(p.quoteMint, creatorVaultAuth);

  return [
    { pubkey: p.pool, isSigner: false, isWritable: false },
    { pubkey: p.wallet, isSigner: true, isWritable: true },
    { pubkey: getGlobalConfigPda(), isSigner: false, isWritable: false },
    { pubkey: p.baseMint, isSigner: false, isWritable: false },
    { pubkey: p.quoteMint, isSigner: false, isWritable: false },
    { pubkey: userBaseAta, isSigner: false, isWritable: true },
    { pubkey: userQuoteAta, isSigner: false, isWritable: true },
    { pubkey: p.baseVault, isSigner: false, isWritable: true },
    { pubkey: p.quoteVault, isSigner: false, isWritable: true },
    { pubkey: PROTOCOL_FEE_RECIPIENT, isSigner: false, isWritable: false },
    { pubkey: protocolFeeRecipientAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // base token program
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // quote token program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: getEventAuthorityPda(), isSigner: false, isWritable: false },
    { pubkey: PUMPSWAP_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: creatorVaultAta, isSigner: false, isWritable: true },
    { pubkey: creatorVaultAuth, isSigner: false, isWritable: false },
    // `isBuy` not used in the account list — buy and sell share the same 19-key
    // layout. We keep the parameter for symmetry with any future divergence.
    ...(isBuy ? [] : []),
  ];
}

// ── Token-program helper instructions (inlined to avoid @solana/spl-token) ──

/** Build a createAssociatedTokenAccountIdempotent instruction (byte 0x01). */
export function buildAtaCreateIdempotentIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  const ata = getAssociatedTokenAddress(mint, owner);
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([0x01]),
  });
}

/** SPL token instruction 0x11 = SyncNative (updates wSOL amount after SOL transfer). */
export function buildSyncNativeIx(wsolAta: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }],
    data: Buffer.from([0x11]),
  });
}

/** SPL token instruction 0x09 = CloseAccount (returns rent + drains lamports to dest). */
export function buildCloseAccountIx(
  account: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([0x09]),
  });
}

/**
 * Compute expected tokens out for a quote→base swap, using constant-product
 * AMM math (x*y=k) on current pool reserves, with a 1% protocol fee approximation.
 *
 * Returns the raw u64 token amount we expect to receive. Multiply by (1 - slippageBps/10000)
 * to get the minimum acceptable output.
 */
export function computeExpectedBaseOut(
  solReservesLamports: bigint,
  tokenReservesRaw: bigint,
  solInLamports: bigint,
  feeBps = 100,
): bigint {
  const feeNumerator = BigInt(10_000 - feeBps);
  const solInAfterFee = (solInLamports * feeNumerator) / 10_000n;
  // x*y = k → tokensOut = y - (k / (x + dx)) = y*dx / (x + dx)
  const numerator = tokenReservesRaw * solInAfterFee;
  const denominator = solReservesLamports + solInAfterFee;
  if (denominator === 0n) return 0n;
  return numerator / denominator;
}

/** Reverse direction: estimate SOL out for selling `baseIn` tokens. */
export function computeExpectedQuoteOut(
  solReservesLamports: bigint,
  tokenReservesRaw: bigint,
  baseInRaw: bigint,
  feeBps = 100,
): bigint {
  const feeNumerator = BigInt(10_000 - feeBps);
  const baseInAfterFee = (baseInRaw * feeNumerator) / 10_000n;
  const numerator = solReservesLamports * baseInAfterFee;
  const denominator = tokenReservesRaw + baseInAfterFee;
  if (denominator === 0n) return 0n;
  return numerator / denominator;
}

export { WSOL_MINT };
