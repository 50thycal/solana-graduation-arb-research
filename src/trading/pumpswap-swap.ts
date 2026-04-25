/**
 * PumpSwap AMM swap instruction builder — thin wrapper over `@pump-fun/pump-swap-sdk`.
 *
 * Program: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
 *
 * We previously hand-rolled the buy/sell ix from the published IDL, but
 * PumpSwap evolves quickly (Token-2022 base mints, dynamic protocol fee
 * recipient rotation, fee_program CPIs, cashback-coin trailing accounts).
 * Maintaining a private IDL snapshot was a losing battle — `/api/verify-pumpswap`
 * caught real drift. Switching to the official SDK lets the upstream package
 * track changes; we keep the verifier endpoint as a regression gate over
 * whatever the SDK produces.
 *
 * Public surface:
 *   - buildBuyInstructions(connection, params)  → TransactionInstruction[]
 *   - buildSellInstructions(connection, params) → TransactionInstruction[]
 *
 * The arrays come pre-composed with ATA-create-idempotent for the base mint,
 * wSOL wrap+sync (buy side) / unwrap (sell side), the swap itself with all
 * IDL accounts + remaining_accounts, and the close instruction. Splice them
 * into a tx between compute-budget and Jito-tip ixs.
 *
 * AMM math helpers (computeExpectedBaseOut / computeExpectedQuoteOut) are
 * kept locally — the safety preflight reaches for them and they're trivial
 * constant-product formulas that don't need the SDK.
 */

import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import {
  OnlinePumpAmmSdk,
  PumpAmmSdk,
  PUMP_AMM_PROGRAM_ID,
} from '@pump-fun/pump-swap-sdk';
import { WSOL_MINT } from './wallet';

export const PUMPSWAP_PROGRAM_ID = PUMP_AMM_PROGRAM_ID;
export { WSOL_MINT };

// `OnlinePumpAmmSdk` wraps a Connection — keep one per Connection instance so
// repeated buys/sells don't reconstruct the underlying Anchor Program.
let onlineSdkCache: { connection: Connection; sdk: OnlinePumpAmmSdk } | null = null;
const offlineSdk = new PumpAmmSdk();

function getOnlineSdk(connection: Connection): OnlinePumpAmmSdk {
  if (!onlineSdkCache || onlineSdkCache.connection !== connection) {
    onlineSdkCache = { connection, sdk: new OnlinePumpAmmSdk(connection) };
  }
  return onlineSdkCache.sdk;
}

export interface BuildBuyParams {
  pool: PublicKey;
  wallet: PublicKey;
  /** Exact base (token) amount we want out, in raw u64. */
  baseAmountOut: bigint;
  /** Max quote (lamports) we'll spend — slippage guardrail. */
  maxQuoteAmountIn: bigint;
}

export interface BuildSellParams {
  pool: PublicKey;
  wallet: PublicKey;
  /** Exact base (token) amount we're selling, raw u64. */
  baseAmountIn: bigint;
  /** Min quote (lamports) we'll accept — slippage guardrail. */
  minQuoteAmountOut: bigint;
}

/**
 * Build the full ix sequence for a PumpSwap buy. Returns the SDK's instruction
 * array verbatim — caller is responsible for prepending compute-budget ixs and
 * appending a Jito tip.
 */
export async function buildBuyInstructions(
  connection: Connection,
  p: BuildBuyParams,
): Promise<TransactionInstruction[]> {
  const online = getOnlineSdk(connection);
  const swapState = await online.swapSolanaState(p.pool, p.wallet);
  return offlineSdk.buyInstructions(
    swapState,
    new BN(p.baseAmountOut.toString()),
    new BN(p.maxQuoteAmountIn.toString()),
  );
}

/** Build the full ix sequence for a PumpSwap sell. Mirrors buildBuyInstructions. */
export async function buildSellInstructions(
  connection: Connection,
  p: BuildSellParams,
): Promise<TransactionInstruction[]> {
  const online = getOnlineSdk(connection);
  const swapState = await online.swapSolanaState(p.pool, p.wallet);
  return offlineSdk.sellInstructions(
    swapState,
    new BN(p.baseAmountIn.toString()),
    new BN(p.minQuoteAmountOut.toString()),
  );
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
