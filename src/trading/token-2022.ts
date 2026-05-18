/**
 * Token-2022 helpers for the live execution path.
 *
 * Two things the PumpSwap SDK does not handle on its own:
 *
 *   1. ATA sizing for mints with holder-side extensions.
 *      The SDK's idempotent ATA-create funds rent for a 165-byte standard
 *      SPL token account. Mints with TransferHookAccount or MemoTransfer
 *      need more bytes — when the swap ix then tries to write that
 *      extension data, the runtime rejects with InsufficientFundsForRent
 *      on the receiver ATA. Pre-creating the ATA ourselves with the SPL
 *      ATA program and the correct token program ID lets the on-chain
 *      ATA program inspect the mint and allocate the matching size,
 *      funded from our wallet at the right rent.
 *
 *   2. TransferFee discounting in the slippage bound.
 *      For Token-2022 mints with TransferFeeConfig the program withholds
 *      a fee during transfer. The PumpSwap on-chain slippage check (error
 *      code 6004) compares post-fee delivery against min_base_out — so we
 *      must pre-discount expected_base_out by the fee or fills that
 *      satisfied the AMM math revert anyway. Same direction on sells:
 *      only (baseIn - fee) reaches the pool.
 *
 * Both problems surfaced in the 2026-05-16/18 audit on the live_micro
 * rollout (graduation-arb-research, trades 10024 / 10261 / 10424 / 10213).
 * The pump.fun bot in solana-trading-bot (helpers/pumpfun.ts) handles them
 * via @solana/spl-token's getMint + getTransferFeeConfig + calculateEpochFee;
 * we mirror that approach here.
 */

import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getMint,
  getTransferFeeConfig,
  calculateEpochFee,
  ExtensionType,
  getExtensionTypes,
} from '@solana/spl-token';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('trading-token-2022');

export interface MintProfile {
  tokenProgram: PublicKey;
  isToken2022: boolean;
  hasTransferFee: boolean;
  hasTransferHook: boolean;
  /** Raw extension-type discriminants declared on the mint's TLV data. */
  extensionTypes: ExtensionType[];
}

// Mint extensions are immutable after init (with the exception of mutable
// metadata fields that don't affect swap semantics), so the profile can be
// cached for the lifetime of the process. 60s TTL refreshes on long-lived
// positions without hammering RPC on the entry hot path.
const profileCache = new Map<string, { profile: MintProfile; fetchedAt: number }>();
const PROFILE_CACHE_TTL_MS = 60_000;

/**
 * Inspect a mint to determine its token program and which Token-2022
 * extensions it declares. Defaults to standard SPL on any read failure so the
 * trade path doesn't crash on a transient RPC error — downstream code paths
 * are safe to take a stale TOKEN_PROGRAM_ID answer (they'll just see no
 * tokens delivered on a Token-2022 fill, surfacing as the usual recovery
 * position flow).
 */
export async function getMintProfile(
  connection: Connection,
  mint: PublicKey,
): Promise<MintProfile> {
  const key = mint.toBase58();
  const cached = profileCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < PROFILE_CACHE_TTL_MS) {
    return cached.profile;
  }
  const info = await connection.getAccountInfo(mint, 'confirmed').catch(() => null);
  if (!info) {
    return {
      tokenProgram: TOKEN_PROGRAM_ID,
      isToken2022: false,
      hasTransferFee: false,
      hasTransferHook: false,
      extensionTypes: [],
    };
  }
  const isToken2022 = info.owner.equals(TOKEN_2022_PROGRAM_ID);
  const tokenProgram = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  let extensionTypes: ExtensionType[] = [];
  let hasTransferFee = false;
  let hasTransferHook = false;
  if (isToken2022) {
    try {
      const mintInfo = await getMint(connection, mint, 'confirmed', tokenProgram);
      extensionTypes = getExtensionTypes(mintInfo.tlvData);
      hasTransferFee = extensionTypes.includes(ExtensionType.TransferFeeConfig);
      hasTransferHook = extensionTypes.includes(ExtensionType.TransferHook);
    } catch (err) {
      logger.debug(
        'getMint failed for %s: %s',
        key,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  const profile: MintProfile = {
    tokenProgram,
    isToken2022,
    hasTransferFee,
    hasTransferHook,
    extensionTypes,
  };
  profileCache.set(key, { profile, fetchedAt: Date.now() });
  return profile;
}

/**
 * Build an ATA create-idempotent ix targeting the right token program for
 * `mint`. The SPL Associated Token Account program inspects the mint and
 * allocates the holder account at the correct size — for Token-2022 with
 * holder-side extensions this is more than the 165 bytes a standard SPL ATA
 * needs, and the matching rent comes from `payer` here.
 *
 * Use this in front of the PumpSwap SDK's swap ixs on any buy where the
 * receiver ATA doesn't already exist. The SDK's own idempotent ATA-create
 * later in the bundle becomes a no-op, so this is purely additive.
 */
export function buildIdempotentAtaCreateIx(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey,
): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    ata,
    owner,
    mint,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

/**
 * Return the transfer-fee amount (raw u64) that would be withheld on a
 * transfer of `rawAmount` base units, at the current epoch. Returns 0 for
 * standard SPL mints, for Token-2022 mints without TransferFeeConfig, and
 * on any read failure (safe default — caller falls back to no adjustment).
 */
export async function getTransferFeeForRawAmount(
  connection: Connection,
  mint: PublicKey,
  tokenProgramId: PublicKey,
  rawAmount: bigint,
): Promise<bigint> {
  if (!tokenProgramId.equals(TOKEN_2022_PROGRAM_ID) || rawAmount === 0n) {
    return 0n;
  }
  try {
    const mintInfo = await getMint(connection, mint, 'confirmed', tokenProgramId);
    const feeConfig = getTransferFeeConfig(mintInfo);
    if (!feeConfig) return 0n;
    const epochInfo = await connection.getEpochInfo('confirmed');
    const fee = calculateEpochFee(feeConfig, BigInt(epochInfo.epoch), rawAmount);
    return BigInt(fee.toString());
  } catch (err) {
    logger.debug(
      'getTransferFeeForRawAmount failed for %s: %s',
      mint.toBase58(),
      err instanceof Error ? err.message : String(err),
    );
    return 0n;
  }
}
