import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import BN from 'bn.js';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { makeLogger } from '../utils/logger';
import type { ExecutionMode } from './config';
import { DEFAULT_JITO_TIP_SOL, MICRO_TRADE_SIZE_SOL, SWAP_SLIPPAGE_BPS } from './config';
import { Wallet, WSOL_MINT, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from './wallet';
import {
  buildBuyInstructions,
  buildSellInstructions,
  computeExpectedBaseOut,
  computeExpectedQuoteOut,
  getSwapState,
} from './pumpswap-swap';
import { buildJitoTipIx, submitBundle } from './jito';
import {
  getMintProfile,
  buildIdempotentAtaCreateIx,
  getTransferFeeForRawAmount,
} from './token-2022';
import { coinCreatorVaultAuthorityPda } from '@pump-fun/pump-swap-sdk';
import { createCloseAccountInstruction } from '@solana/spl-token';

const logger = makeLogger('trading-executor');

// ── Fill-attribution constants ──────────────────────────────
const TX_FEE_LAMPORTS = 5_000;
const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280;

export interface PoolPriceResult {
  priceSol: number;
  solReserves: number;
  tokenReserves: number;
}

export interface PoolContext {
  poolAddress: string;
  baseVault: string;
  quoteVault: string;
}

export interface ExecutionResult {
  success: boolean;
  effectivePrice: number;
  tokensReceived: number;
  txSignature?: string;
  errorMessage?: string;
  dryRun: boolean;
  executionMode?: ExecutionMode;
  measuredSlippagePct?: number;
  jitoTipSol?: number;
  txLandMs?: number;
  /** 'jito' or 'rpc' — which submission path attempted the tx. Only set on
   *  live executions; undefined for paper/shadow. Useful for the post-mortem
   *  diagnostic surface in trading.json. Added 2026-05-21. */
  failurePath?: string;
  /** Comma-joined list of mint extension flags (e.g. "token2022,transfer_fee").
   *  Empty string when the mint is plain SPL. Captured at buy time. */
  mintExtensionFlags?: string;
  /** Full diagnostic snapshot for failed live txs — same fields as the
   *  "Live buy/sell failed to land" log entry. Stored verbatim in
   *  trades_v2.failure_context_json on the failed row. */
  failureContext?: Record<string, unknown>;
  /** SOL paid for ATA rent at buy time (live mode only). Permanent wallet
   *  outflow since the swap doesn't close ATAs at sell. Persisted to
   *  entry_ata_rent_sol so closeTrade can deduct it from net_profit_sol. */
  ataRentCostSol?: number;
}

export function readTokenAccountAmount(data: Buffer): number | null {
  if (data.length < 72) return null;
  try {
    return new BN(data.subarray(64, 72), 'le').toNumber();
  } catch {
    return null;
  }
}

const VAULT_CACHE_TTL_MS = 4_000;

interface CachedVaultPrice {
  result: PoolPriceResult | null;
  fetchedAt: number;
}

const vaultPriceCache = new Map<string, CachedVaultPrice>();
const inflightFetches = new Map<string, Promise<PoolPriceResult | null>>();
export const vaultPriceCacheStats = { hits: 0, misses: 0, coalesced: 0 };

export async function fetchVaultPrice(
  connection: Connection,
  baseVault: string,
  quoteVault: string,
  critical: boolean = false,
): Promise<PoolPriceResult | null> {
  const cacheKey = `${baseVault}:${quoteVault}`;
  const cached = vaultPriceCache.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < VAULT_CACHE_TTL_MS) {
    vaultPriceCacheStats.hits++;
    return cached.result;
  }
  const inflight = inflightFetches.get(cacheKey);
  if (inflight) {
    vaultPriceCacheStats.coalesced++;
    return inflight;
  }
  vaultPriceCacheStats.misses++;
  const fetchPromise = fetchVaultPriceRpc(connection, baseVault, quoteVault, critical);
  inflightFetches.set(cacheKey, fetchPromise);
  try {
    const result = await fetchPromise;
    if (result !== null) {
      vaultPriceCache.set(cacheKey, { result, fetchedAt: Date.now() });
    }
    return result;
  } finally {
    inflightFetches.delete(cacheKey);
  }
}

async function fetchVaultPriceRpcOnce(
  connection: Connection,
  baseVault: string,
  quoteVault: string,
): Promise<PoolPriceResult | null> {
  try {
    const accounts = await connection.getMultipleAccountsInfo([
      new PublicKey(baseVault),
      new PublicKey(quoteVault),
    ]);
    if (!accounts[0]?.data || !accounts[1]?.data) {
      logger.debug(
        { baseVault, quoteVault, hasBase: !!accounts[0]?.data, hasQuote: !!accounts[1]?.data },
        'fetchVaultPrice: vault account data missing'
      );
      return null;
    }
    const baseAmount = readTokenAccountAmount(accounts[0].data as Buffer);
    const quoteAmount = readTokenAccountAmount(accounts[1].data as Buffer);
    if (baseAmount === null || quoteAmount === null) {
      logger.debug({ baseVault, quoteVault }, 'fetchVaultPrice: token amount parse failed');
      return null;
    }
    if (baseAmount === 0 || quoteAmount === 0) {
      logger.debug({ baseVault, quoteVault, baseAmount, quoteAmount }, 'fetchVaultPrice: zero reserves');
      return null;
    }
    const tokenReserves = baseAmount / 1_000_000;
    const solReserves   = quoteAmount / 1_000_000_000;
    if (tokenReserves <= 0 || solReserves <= 0) return null;
    return { priceSol: solReserves / tokenReserves, solReserves, tokenReserves };
  } catch (err) {
    logger.debug('fetchVaultPrice RPC error: %s', err instanceof Error ? err.message : String(err));
    return null;
  }
}

const CRITICAL_READ_RETRIES = 2;
const CRITICAL_READ_RETRY_DELAY_MS = 500;

async function fetchVaultPriceRpc(
  connection: Connection,
  baseVault: string,
  quoteVault: string,
  critical: boolean,
): Promise<PoolPriceResult | null> {
  if (critical) {
    await globalRpcLimiter.throttle();
  } else if (!await globalRpcLimiter.throttleOrDrop(5)) {
    return null;
  }
  const first = await fetchVaultPriceRpcOnce(connection, baseVault, quoteVault);
  if (first !== null || !critical) return first;
  for (let attempt = 1; attempt <= CRITICAL_READ_RETRIES; attempt++) {
    await new Promise(resolve => setTimeout(resolve, CRITICAL_READ_RETRY_DELAY_MS));
    await globalRpcLimiter.throttle();
    const retry = await fetchVaultPriceRpcOnce(connection, baseVault, quoteVault);
    if (retry !== null) return retry;
  }
  return null;
}

export class Executor {
  private readonly globalMode: ExecutionMode;
  private readonly wallet: Wallet | null;
  private readonly connection: Connection | null;

  constructor(
    globalMode: ExecutionMode = 'paper',
    connection: Connection | null = null,
    wallet: Wallet | null = null,
  ) {
    this.globalMode = globalMode;
    this.connection = connection;
    this.wallet = wallet;
  }

  async buy(
    mint: string,
    amountSol: number,
    expectedPriceSol: number,
    slippageEstPct?: number,
    poolCtx?: PoolContext,
    mode?: ExecutionMode,
    /** Per-retry overrides for the live buy path. Drives the 3-attempt retry
     *  schedule in trade-evaluator (2026-05-27): attempts 2-3 bump tip and/or
     *  widen slippage to break out of Custom 6004 / InsufficientFundsForRent
     *  failures. Ignored in paper/shadow. */
    retryOverrides?: { slippageBpsOverride?: number; jitoTipMultiplier?: number; attemptNumber?: number },
  ): Promise<ExecutionResult> {
    const effectiveMode = mode ?? this.globalMode;
    if (effectiveMode === 'paper') {
      const slippagePct = (slippageEstPct != null && slippageEstPct > 0) ? slippageEstPct : 1.75;
      const effectivePrice = expectedPriceSol * (1 + slippagePct / 100);
      const tokensReceived = amountSol / effectivePrice;
      return {
        success: true, effectivePrice, tokensReceived, dryRun: true, executionMode: 'paper',
      };
    }
    if (effectiveMode === 'shadow') {
      return this.shadowBuy(mint, amountSol, expectedPriceSol, poolCtx);
    }
    const actualAmount = effectiveMode === 'live_micro' ? MICRO_TRADE_SIZE_SOL : amountSol;
    return this.liveBuy(mint, actualAmount, expectedPriceSol, poolCtx, effectiveMode, retryOverrides);
  }

  async sell(
    mint: string,
    tokensHeld: number,
    exitPriceSol: number,
    slippageEstPct?: number,
    poolCtx?: PoolContext,
    mode?: ExecutionMode,
    /** Per-retry overrides for the live sell path. Drives the
     *  escalating-slippage + tip-bump retry schedule in
     *  strategy-manager.handleExit (2026-05-27). Ignored in paper/shadow. */
    retryOverrides?: { slippageBpsOverride?: number; jitoTipMultiplier?: number; attemptNumber?: number },
  ): Promise<ExecutionResult> {
    const effectiveMode = mode ?? this.globalMode;
    if (effectiveMode === 'paper') {
      const slippagePct = (slippageEstPct != null && slippageEstPct > 0) ? slippageEstPct : 1.75;
      const effectivePrice = exitPriceSol * (1 - slippagePct / 100);
      return {
        success: true, effectivePrice, tokensReceived: 0, dryRun: true, executionMode: 'paper',
      };
    }
    if (effectiveMode === 'shadow') {
      return this.shadowSell(mint, tokensHeld, exitPriceSol, poolCtx);
    }
    return this.liveSell(mint, tokensHeld, exitPriceSol, poolCtx, effectiveMode, retryOverrides);
  }

  private async shadowBuy(
    mint: string,
    amountSol: number,
    expectedPriceSol: number,
    poolCtx?: PoolContext,
  ): Promise<ExecutionResult> {
    if (!this.connection || !poolCtx?.baseVault || !poolCtx?.quoteVault) {
      return {
        success: false, effectivePrice: expectedPriceSol, tokensReceived: 0,
        dryRun: true, executionMode: 'shadow',
        errorMessage: 'shadow: missing pool context',
      };
    }
    const pool = await fetchVaultPrice(this.connection, poolCtx.baseVault, poolCtx.quoteVault, true);
    if (!pool) {
      return {
        success: false, effectivePrice: expectedPriceSol, tokensReceived: 0,
        dryRun: true, executionMode: 'shadow',
        errorMessage: 'shadow: pool read failed',
      };
    }
    const solInLamports = BigInt(Math.floor(amountSol * 1e9));
    const solRes = BigInt(Math.floor(pool.solReserves * 1e9));
    const tokRes = BigInt(Math.floor(pool.tokenReserves * 1e6));
    const baseOut = computeExpectedBaseOut(solRes, tokRes, solInLamports);
    const tokensReceived = Number(baseOut) / 1e6;
    const effectivePrice = amountSol / tokensReceived;
    const measuredSlippagePct = (effectivePrice / pool.priceSol - 1) * 100;
    logger.info(
      { mint, amountSol, spotPrice: pool.priceSol, measuredSlippagePct: measuredSlippagePct.toFixed(3) },
      'Shadow buy quote'
    );
    return {
      success: true, effectivePrice, tokensReceived,
      dryRun: true, executionMode: 'shadow', measuredSlippagePct,
      jitoTipSol: DEFAULT_JITO_TIP_SOL,
    };
  }

  private async shadowSell(
    mint: string,
    tokensHeld: number,
    exitPriceSol: number,
    poolCtx?: PoolContext,
  ): Promise<ExecutionResult> {
    if (!this.connection || !poolCtx?.baseVault || !poolCtx?.quoteVault) {
      return {
        success: false, effectivePrice: exitPriceSol, tokensReceived: 0,
        dryRun: true, executionMode: 'shadow',
        errorMessage: 'shadow: missing pool context',
      };
    }
    const pool = await fetchVaultPrice(this.connection, poolCtx.baseVault, poolCtx.quoteVault, true);
    if (!pool) {
      return {
        success: false, effectivePrice: exitPriceSol, tokensReceived: 0,
        dryRun: true, executionMode: 'shadow',
        errorMessage: 'shadow: pool read failed',
      };
    }
    const solRes = BigInt(Math.floor(pool.solReserves * 1e9));
    const tokRes = BigInt(Math.floor(pool.tokenReserves * 1e6));
    const baseIn = BigInt(Math.floor(tokensHeld * 1e6));
    const solOut = computeExpectedQuoteOut(solRes, tokRes, baseIn);
    const solReceived = Number(solOut) / 1e9;
    const effectivePrice = solReceived / tokensHeld;
    const measuredSlippagePct = (1 - effectivePrice / pool.priceSol) * 100;
    logger.info(
      { mint, tokensHeld, spotPrice: pool.priceSol, measuredSlippagePct: measuredSlippagePct.toFixed(3) },
      'Shadow sell quote'
    );
    return {
      success: true, effectivePrice, tokensReceived: 0,
      dryRun: true, executionMode: 'shadow', measuredSlippagePct,
      jitoTipSol: DEFAULT_JITO_TIP_SOL,
    };
  }

  private async liveBuy(
    mint: string,
    amountSol: number,
    expectedPriceSol: number,
    poolCtx: PoolContext | undefined,
    mode: ExecutionMode,
    retryOverrides?: { slippageBpsOverride?: number; jitoTipMultiplier?: number; attemptNumber?: number },
  ): Promise<ExecutionResult> {
    if (!this.connection || !this.wallet) {
      return {
        success: false, effectivePrice: expectedPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: 'live: connection or wallet not initialized',
      };
    }
    if (!poolCtx?.baseVault || !poolCtx?.quoteVault || !poolCtx?.poolAddress) {
      return {
        success: false, effectivePrice: expectedPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: 'live: pool context incomplete',
      };
    }

    const mintPk = new PublicKey(mint);
    const poolPk = new PublicKey(poolCtx.poolAddress);
    const walletPk = this.wallet.pubkey;

    // ── 1. Prerequisites that don't depend on fresh pool state ───────────────
    // These reads (mint profile, ATA checks, wallet balances) take ~5-8 RPC
    // calls totalling 500ms-1s. Doing them BEFORE the pool fetch means the
    // pool reserves we use for slippage math are as fresh as possible at
    // swap-build time — reduces Custom 6004 slippage rejections caused by
    // price drift in the quote-to-submit window.
    const mintProfile = await getMintProfile(this.connection, mintPk);
    const baseTokenProgram = mintProfile.tokenProgram;
    const baseAta = getAssociatedTokenAddress(mintPk, walletPk, baseTokenProgram);
    const baseAtaInfoBefore = await this.connection.getAccountInfo(baseAta, 'confirmed').catch(() => null);
    const baseAtaExistsBefore = !!baseAtaInfoBefore;
    // We deliberately do NOT pre-create the WSOL quote ATA. The PumpSwap SDK
    // owns the WSOL ATA lifecycle inline (create → wrap → swap → close — see
    // pumpswap-verify.ts:50 "Number of ixs in the SDK output (ATA, wsol prep,
    // swap, close, etc.)"). When we pre-created it ourselves (2026-05-25
    // experiment, commit 52f65a9), the InsufficientFundsForRent failures
    // INCREASED rather than decreased: post-fix solscan trace on trade 12898
    // showed our pre-create at ix #4, SDK's idempotent no-op at ix #5, then
    // SDK's CloseAccount at ix #10 against our-created account — runtime
    // rent-exempt validation tripped at tx-end on account_index=6. Letting
    // the SDK own the WSOL ATA matches the SDK's expected flow. The base ATA
    // we still pre-create for Token-2022 sizing reasons (per token-2022.ts:5).
    const baseBalBefore = await this.wallet.getTokenBalanceRaw(this.connection, mintPk);
    const walletSolBefore = await this.wallet.getSolBalance(this.connection);

    // Per-attempt overrides from the buy retry schedule (trade-evaluator).
    // Attempt 1: default tip + slippage. Attempt 2: 5× tip, same slippage.
    // Attempt 3: 5× tip, 2× slippage. See BUY_RETRY_* constants there.
    const tipMult = retryOverrides?.jitoTipMultiplier ?? 1;
    const effectiveSlippageBps = retryOverrides?.slippageBpsOverride ?? SWAP_SLIPPAGE_BPS;
    const jitoTipSol = DEFAULT_JITO_TIP_SOL * tipMult;
    const jitoTipLamports = Math.floor(jitoTipSol * 1e9);
    const solInLamports = BigInt(Math.floor(amountSol * 1e9));

    // ── 2. Wallet pre-flight (using upper-bound estimate of outflow) ─────────
    // maxQuoteInLamports = solInLamports * (1 + effectiveSlippageBps/10000).
    // Uses the per-attempt slippage so the wallet check matches what we'll
    // actually submit. Floor is 0.1 SOL post-trade per operator policy
    // (2026-05-24).
    const WALLET_MIN_FLOOR_LAMPORTS = 100_000_000;
    const slipBpsForPreflight = BigInt(effectiveSlippageBps);
    const estimatedMaxQuoteInLamports =
      (solInLamports * (10000n + slipBpsForPreflight)) / 10000n;
    // ATA rent budget: 1 for our base ATA if new, plus 2 for SDK-managed
    // ATAs that PumpSwap creates inline (its WSOL session ATA + any
    // fee-recipient WSOL ATAs that don't exist yet). 2 is a worst-case
    // upper bound — most trades create 0-1 inline ATAs since fee recipients
    // accumulate WSOL ATAs across many buyers.
    const SDK_MAX_INLINE_ATAS = 2;
    const newAtaRentCount = (baseAtaExistsBefore ? 0 : 1) + SDK_MAX_INLINE_ATAS;
    const projectedOutflowLamports =
      Number(estimatedMaxQuoteInLamports) +
      jitoTipLamports +
      TX_FEE_LAMPORTS +
      newAtaRentCount * TOKEN_ACCOUNT_RENT_LAMPORTS;
    if (walletSolBefore < projectedOutflowLamports + WALLET_MIN_FLOOR_LAMPORTS) {
      const balSol = walletSolBefore / 1e9;
      const needSol = (projectedOutflowLamports + WALLET_MIN_FLOOR_LAMPORTS) / 1e9;
      logger.warn(
        {
          mint, mode,
          walletSol: balSol.toFixed(4),
          projectedOutflowSol: (projectedOutflowLamports / 1e9).toFixed(4),
          floorSol: WALLET_MIN_FLOOR_LAMPORTS / 1e9,
          needSol: needSol.toFixed(4),
          assumedAtaCount: newAtaRentCount,
        },
        'Live buy aborted — wallet below safety floor',
      );
      return {
        success: false, effectivePrice: expectedPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: `live: wallet_low (balance=${balSol.toFixed(4)} SOL, need>=${needSol.toFixed(4)} SOL = trade+tip+fee+rent+0.1 floor)`,
      };
    }

    if (mintProfile.hasTransferHook) {
      logger.warn(
        { mint, extensions: mintProfile.extensionTypes },
        'Token-2022 mint declares TransferHook — swap may revert if SDK omits hook extra accounts',
      );
    }

    // ── 3. Fetch pool state LAST, immediately before swap build ──────────────
    // Minimizes the window between our slippage-math quote and the on-chain
    // execution. Combined with the SDK's own swapSolanaState fetch (~50ms
    // later inside buildBuyInstructions), the quote-to-instruction drift
    // window shrinks from ~500ms+ to ~50ms.
    const pool = await fetchVaultPrice(this.connection, poolCtx.baseVault, poolCtx.quoteVault, true);
    if (!pool) {
      return {
        success: false, effectivePrice: expectedPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: 'live: pool reserves read failed',
      };
    }

    const solRes = BigInt(Math.floor(pool.solReserves * 1e9));
    const tokRes = BigInt(Math.floor(pool.tokenReserves * 1e6));
    const expectedBaseOutRaw = computeExpectedBaseOut(solRes, tokRes, solInLamports);
    const transferFeeOnExpected = mintProfile.hasTransferFee
      ? await getTransferFeeForRawAmount(this.connection, mintPk, baseTokenProgram, expectedBaseOutRaw)
      : 0n;
    const feeAdjustedExpectedBaseOut = expectedBaseOutRaw - transferFeeOnExpected;
    // Use effectiveSlippageBps (computed above from retry overrides) instead of
    // raw SWAP_SLIPPAGE_BPS — lets per-attempt schedule widen tolerance.
    const slipBpsBn = BigInt(effectiveSlippageBps);
    const minBaseOutRaw = (feeAdjustedExpectedBaseOut * (10000n - slipBpsBn)) / 10000n;
    const maxQuoteInLamports = (solInLamports * (10000n + slipBpsBn)) / 10000n;

    // ── 4. Fetch SDK swap state ───────────────────────────────────────────────
    // We need pool.coinCreator to derive the coinCreatorVaultAta (the WSOL ATA
    // owned by the per-creator vault authority PDA). The SDK's buy instruction
    // references this ATA as a writable account but does NOT pre-create it —
    // it relies on the on-chain PumpSwap program to create it inline using
    // payer (us) lamports. For brand-new coin creators, this inline-create can
    // fail with InsufficientFundsForRent (the dominant buy failure class in
    // recent data, 12 of 20 failures). Pre-creating it ourselves with an
    // explicit idempotent ix funds the rent properly and bypasses the failure.
    // Caches the swap state for buildBuyInstructions below to avoid a second
    // getMultipleAccountsInfo. 2026-05-28.
    const swapState = await getSwapState(this.connection, poolPk, walletPk);
    const coinCreator: PublicKey = swapState.pool.coinCreator;
    const coinCreatorVaultAuthority = coinCreatorVaultAuthorityPda(coinCreator);
    const coinCreatorVaultAta = getAssociatedTokenAddress(
      WSOL_MINT, coinCreatorVaultAuthority, TOKEN_PROGRAM_ID,
    );
    let coinCreatorVaultAtaExists = false;
    if (!coinCreator.equals(PublicKey.default)) {
      const info = await this.connection.getAccountInfo(coinCreatorVaultAta, 'confirmed').catch(() => null);
      coinCreatorVaultAtaExists = !!info;
    }

    const swapIxs = await buildBuyInstructions(this.connection, {
      pool: poolPk,
      wallet: walletPk,
      baseAmountOut: minBaseOutRaw,
      maxQuoteAmountIn: maxQuoteInLamports,
      swapState,  // reuse the state we just fetched
    });

    const ataPreCreateIxs: TransactionInstruction[] = [];
    if (!baseAtaExistsBefore) {
      ataPreCreateIxs.push(
        buildIdempotentAtaCreateIx(walletPk, baseAta, walletPk, mintPk, baseTokenProgram),
      );
    }
    // Pre-create the coinCreatorVaultAta if missing AND the pool has a non-
    // default coinCreator. Skip when coinCreator is PublicKey.default (some
    // pools have no creator — the SDK skips the creator fee path in that case).
    if (!coinCreator.equals(PublicKey.default) && !coinCreatorVaultAtaExists) {
      ataPreCreateIxs.push(
        buildIdempotentAtaCreateIx(
          walletPk, coinCreatorVaultAta, coinCreatorVaultAuthority, WSOL_MINT, TOKEN_PROGRAM_ID,
        ),
      );
    }

    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }),
      ...ataPreCreateIxs,
      ...swapIxs,
      buildJitoTipIx(walletPk, jitoTipLamports),
    ];

    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: walletPk, recentBlockhash: blockhash }).add(...ixs);
    this.wallet.sign(tx);

    const submission = await submitBundle(this.connection, [tx.serialize()]);
    this.wallet.invalidateSolBalance();

    if (!submission.landed) {
      // Diagnostic snapshot — the next operator session needs the tx sig (when
      // present) plus the mint's extension profile to identify which on-chain
      // account caused the revert. Pre-fix this path returned without the sig
      // even when the RPC fallback successfully captured it (audit gap on
      // trades 10400 / 10424 / 10882). With the sig populated the operator
      // can paste it into Solscan and read the failing account_index directly.
      const extensionFlags: string[] = [];
      if (mintProfile.isToken2022) extensionFlags.push('token2022');
      if (mintProfile.hasTransferFee) extensionFlags.push('transfer_fee');
      if (mintProfile.hasTransferHook) extensionFlags.push('transfer_hook');
      const failureContext: Record<string, unknown> = {
        path: submission.path,
        txSignature: submission.txSignature,
        solscanUrl: submission.txSignature
          ? `https://solscan.io/tx/${submission.txSignature}`
          : null,
        err: submission.errorMessage,
        isToken2022: mintProfile.isToken2022,
        hasTransferFee: mintProfile.hasTransferFee,
        hasTransferHook: mintProfile.hasTransferHook,
        extensionTypes: mintProfile.extensionTypes,
        baseAtaPreCreated: !baseAtaExistsBefore,
        baseTokenProgram: baseTokenProgram.toBase58(),
        expectedBaseOutRaw: expectedBaseOutRaw.toString(),
        minBaseOutRaw: minBaseOutRaw.toString(),
        maxQuoteInLamports: maxQuoteInLamports.toString(),
        latencyMs: submission.latencyMs,
      };
      // Pull on-chain program logs for the failed tx so the actual revert
      // cause (PumpSwap Anchor error name, runtime rent failure account
      // details, etc.) lands in trading.json instead of requiring a manual
      // Solscan inspection on every failure.
      if (submission.txSignature) {
        const logsInfo = await this.fetchFailureLogs(submission.txSignature);
        if (logsInfo) {
          failureContext.programLogs = logsInfo.programLogs;
          failureContext.failingProgram = logsInfo.failingProgram;
          failureContext.failingInstructionIndex = logsInfo.failingInstructionIndex;
        }
      }
      logger.error(
        { mint, mode, ...failureContext },
        'Live buy failed to land — diagnostic snapshot for post-mortem',
      );
      return {
        success: false, effectivePrice: expectedPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: `live: tx did not land (${submission.path}): ${submission.errorMessage ?? 'unknown'}`,
        txSignature: submission.txSignature,
        txLandMs: submission.latencyMs,
        failurePath: submission.path,
        mintExtensionFlags: extensionFlags.join(','),
        failureContext,
      };
    }

    // Tightened from [750, 1000, 1500, 2000, 2500] (7.75s worst case) →
    // [300, 500, 800, 1200] (2.8s) on 2026-05-27. The Jito bundle response
    // already tells us the tx landed (submission.landed=true); this poll
    // is just to MEASURE tokensReceived for the trade row. Most fills show
    // up on the first 300ms read; the extra retries cover RPC propagation
    // lag on rare slow reads. Worst-case saves ~5s per buy attempt.
    const fillDelaysMs = [300, 500, 800, 1200];
    let baseBalAfter = baseBalBefore;
    for (const dly of fillDelaysMs) {
      await this.sleep(dly);
      baseBalAfter = await this.wallet.getTokenBalanceRaw(this.connection, mintPk);
      if (baseBalAfter > baseBalBefore) break;
    }
    const walletSolAfter = await this.wallet.getSolBalance(this.connection);

    // ── Per-strategy fill attribution ──────────────────────────────────────
    // The full-wallet snapshot deltas (baseBalAfter - baseBalBefore for tokens,
    // walletSolBefore - walletSolAfter for SOL) are CORRUPTED when a second
    // live strategy buys the same mint between our two balance reads: both
    // strategies then book the COMBINED token amount and each over-states the
    // SOL it spent. That mis-attribution is exactly the v44 bug (trades
    // 16341/16342, 2026-05-29) — one strategy's sell drained the shared wallet
    // position and the other booked a phantom -104% total loss.
    //
    // The confirmed transaction's own meta is scoped to THIS tx alone:
    // postTokenBalances - preTokenBalances on our base ATA gives precisely the
    // tokens this swap credited us (immune to a concurrent same-mint buy that
    // also moved the wallet balance), and preBalances[0] - postBalances[0]
    // gives the lamports debited from our fee-payer account by this tx only.
    // Prefer it; fall back to the (racy) wallet delta only if RPC can't return
    // the tx meta, logging a warning so the audit trail flags possible drift.
    const txDeltas = submission.txSignature
      ? await this.fetchTxBalanceDeltas(submission.txSignature, walletPk.toBase58(), mint)
      : null;
    const walletTokenDeltaRaw = baseBalAfter - baseBalBefore;
    const walletSolDeltaLamports = walletSolBefore - walletSolAfter;
    if (!txDeltas) {
      logger.warn(
        { mint, mode, txSignature: submission.txSignature },
        'Live buy: tx-meta deltas unavailable — using wallet-balance delta (attribution may be off if a concurrent same-mint buy raced)',
      );
    }
    const tokensReceivedRaw = txDeltas ? txDeltas.tokensReceivedRaw : walletTokenDeltaRaw;
    const tokensReceived = tokensReceivedRaw / 1e6;
    const overheadLamports =
      jitoTipLamports +
      TX_FEE_LAMPORTS +
      (baseAtaExistsBefore ? 0 : TOKEN_ACCOUNT_RENT_LAMPORTS);
    // Note: the SDK's own WSOL session ATA gets closed at tx end (refund
    // to user, net 0). Fee-recipient ATAs the SDK may create inline DO
    // persist with our rent in them — but we can't observe per-trade
    // which were created without parsing inner instructions, so they're
    // captured in the pre-flight buffer (SDK_MAX_INLINE_ATAS) rather than
    // here in the post-trade overhead.
    const solSpentLamports = txDeltas ? -txDeltas.feePayerDeltaLamports : walletSolDeltaLamports;
    const swapCostLamports = solSpentLamports - overheadLamports;
    const swapCostSol = swapCostLamports / 1e9;
    if (tokensReceived <= 0 || swapCostLamports <= 0) {
      const meaningfulSpend = swapCostLamports > Number(solInLamports) * 0.3;
      if (tokensReceived <= 0 && meaningfulSpend) {
        // Final extended re-read before committing a recovery position. The
        // pre-fix path registered a phantom position using expectedBaseOutRaw
        // as a placeholder; if tokens never actually arrived in the wallet,
        // the later sell would fail with "no tokens in wallet to sell" after
        // 5 retries (trade 12266 / 2026-05-24). Wait one more 5s window and
        // re-verify before claiming the tokens.
        await this.sleep(5000);
        const finalBalRaw = await this.wallet.getTokenBalanceRaw(this.connection, mintPk);
        if (finalBalRaw > baseBalBefore) {
          const lateTokensReceivedRaw = finalBalRaw - baseBalBefore;
          const lateTokensReceived = lateTokensReceivedRaw / 1e6;
          const lateEffectivePrice = swapCostSol / lateTokensReceived;
          logger.warn(
            {
              mint, mode, txSignature: submission.txSignature,
              firstReadTokens: tokensReceivedRaw, finalReadTokens: lateTokensReceivedRaw,
              swapCostSol,
            },
            'Live buy: tokens arrived on extended re-read — using actual measurement',
          );
          // entry_ata_rent_sol tracks PERMANENT outflow only — base ATA we
          // own (kept across all trades on this mint). SDK-managed WSOL ATAs
          // close at tx-end (net 0). Any SDK-created fee-recipient ATAs that
          // do persist are captured by the wallet pre-flight buffer.
          const recordedAtaRentLamports = baseAtaExistsBefore
            ? 0
            : TOKEN_ACCOUNT_RENT_LAMPORTS;
          return {
            success: true,
            effectivePrice: lateEffectivePrice,
            tokensReceived: lateTokensReceived,
            txSignature: submission.txSignature,
            dryRun: false, executionMode: mode,
            jitoTipSol,
            txLandMs: submission.latencyMs,
            ataRentCostSol: recordedAtaRentLamports / 1e9,
          };
        }
        logger.error(
          {
            mint, mode, txSignature: submission.txSignature,
            swapCostLamports, expectedBaseOutRaw: expectedBaseOutRaw.toString(),
          },
          'Live buy: SOL spent but no token delta even after extended retry — failing trade',
        );
        return {
          success: false, effectivePrice: expectedPriceSol, tokensReceived: 0,
          dryRun: false, executionMode: mode,
          errorMessage: `live: SOL spent (${swapCostLamports} lamports) but no tokens after extended retry`,
          txSignature: submission.txSignature,
          txLandMs: submission.latencyMs,
          jitoTipSol,
        };
      }
      return {
        success: false, effectivePrice: expectedPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: `live: landed but no balance delta (tokens=${tokensReceivedRaw}, swapΔ=${swapCostLamports})`,
        txSignature: submission.txSignature,
        txLandMs: submission.latencyMs,
        jitoTipSol,
      };
    }
    const effectivePrice = swapCostSol / tokensReceived;
    const measuredSlippagePct = (effectivePrice / pool.priceSol - 1) * 100;

    logger.info(
      {
        mint, mode, path: submission.path, tokensReceived,
        swapCostSol, overheadLamports, effectivePrice,
        measuredSlippagePct: measuredSlippagePct.toFixed(3),
        latencyMs: submission.latencyMs,
        isToken2022: mintProfile.isToken2022,
        hasTransferFee: mintProfile.hasTransferFee,
      },
      'Live buy filled'
    );

    // entry_ata_rent_sol tracks PERMANENT outflow only — base ATA if newly
    // created. SDK's WSOL session ATA closes at tx end (refunded, net 0).
    // Any SDK-created fee-recipient ATAs (creator/protocol-fee WSOL ATAs)
    // also stick around if new, but we can't cheaply observe per-trade
    // which were created; absorbed by the pre-flight buffer.
    const recordedAtaRentLamports = baseAtaExistsBefore
      ? 0
      : TOKEN_ACCOUNT_RENT_LAMPORTS;
    return {
      success: true, effectivePrice, tokensReceived,
      txSignature: submission.txSignature,
      dryRun: false, executionMode: mode,
      measuredSlippagePct, jitoTipSol,
      txLandMs: submission.latencyMs,
      ataRentCostSol: recordedAtaRentLamports / 1e9,
    };
  }

  /** Strict pre-sell wallet balance read. Returns the raw u64 token amount on a
   *  CONFIRMED read, or an ExecutionResult error when the read can't be trusted.
   *  Critically distinguishes a confirmed-empty wallet (0 → caller emits the
   *  terminal "no tokens in wallet to sell") from an RPC FAILURE (returns a
   *  TRANSIENT "balance read failed" result, which is NOT a terminal-close
   *  pattern, so the caller retries instead of orphaning a position that may
   *  still hold tokens). The error-swallowing getTokenBalanceRaw used here before
   *  returned 0 on an RPC error too, so a transient blip during RPC pressure /
   *  a restart could terminal-close a real position and strand its tokens in the
   *  wallet (the 2026-06-23 RDR2-style orphan). */
  private async readSellableBalanceRaw(
    mintPk: PublicKey, exitPriceSol: number, mode: ExecutionMode,
  ): Promise<number | ExecutionResult> {
    try {
      return await this.wallet!.getTokenBalanceRawStrict(this.connection!, mintPk);
    } catch (err) {
      return {
        success: false, effectivePrice: exitPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: `live: balance read failed (transient): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async liveSell(
    mint: string,
    tokensHeld: number,
    exitPriceSol: number,
    poolCtx: PoolContext | undefined,
    mode: ExecutionMode,
    retryOverrides?: { slippageBpsOverride?: number; jitoTipMultiplier?: number; attemptNumber?: number },
  ): Promise<ExecutionResult> {
    if (!this.connection || !this.wallet) {
      return {
        success: false, effectivePrice: exitPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: 'live: connection or wallet not initialized',
      };
    }
    if (!poolCtx?.baseVault || !poolCtx?.quoteVault || !poolCtx?.poolAddress) {
      return {
        success: false, effectivePrice: exitPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: 'live: pool context incomplete',
      };
    }

    const mintPk = new PublicKey(mint);
    const poolPk = new PublicKey(poolCtx.poolAddress);
    const walletPk = this.wallet.pubkey;

    const actualBaseRaw = await this.readSellableBalanceRaw(mintPk, exitPriceSol, mode);
    if (typeof actualBaseRaw !== 'number') return actualBaseRaw; // transient/empty error result
    if (actualBaseRaw <= 0) {
      return {
        success: false, effectivePrice: exitPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: 'live: no tokens in wallet to sell',
      };
    }
    const pool = await fetchVaultPrice(this.connection, poolCtx.baseVault, poolCtx.quoteVault, true);
    if (!pool) {
      return {
        success: false, effectivePrice: exitPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: 'live: pool reserves read failed',
      };
    }
    // Cap sell amount at our strategy's tokensHeld, NOT the full wallet balance.
    // Without this, when two live strategies hold the same mint, whichever sells
    // first drains the entire wallet position — leaving the other(s) with
    // actualBaseRaw=0 on their sell attempt → "no tokens in wallet" failures +
    // mis-attributed proceeds (the seller divides 2x proceeds by 1x tokensHeld).
    // Discovered 2026-05-26 from on-wallet activity showing 2 buys + 1 combined
    // sell. tokensHeld is in human-decimal units (entry_tokens_received), so
    // convert to raw u64 via × 1e6.
    const ourTokensRaw = BigInt(Math.floor(tokensHeld * 1e6));
    const baseInRaw = ourTokensRaw < BigInt(actualBaseRaw) ? ourTokensRaw : BigInt(actualBaseRaw);
    const sellMintProfile = await getMintProfile(this.connection, mintPk);
    const transferFeeOnIn = sellMintProfile.hasTransferFee
      ? await getTransferFeeForRawAmount(this.connection, mintPk, sellMintProfile.tokenProgram, baseInRaw)
      : 0n;
    const effectiveBaseIn = baseInRaw - transferFeeOnIn;
    const solRes = BigInt(Math.floor(pool.solReserves * 1e9));
    const tokRes = BigInt(Math.floor(pool.tokenReserves * 1e6));
    const expectedSolOut = computeExpectedQuoteOut(solRes, tokRes, effectiveBaseIn);
    // Apply per-attempt overrides from the retry schedule (strategy-manager).
    // Slippage override widens the bps cap on later retries so the AMM math
    // actually accepts the fill; tip multiplier bumps the Jito tip to push
    // the bundle up the priority queue on attempts 2-3.
    const effectiveSlippageBps = retryOverrides?.slippageBpsOverride ?? SWAP_SLIPPAGE_BPS;
    const sellSlipBpsBn = BigInt(effectiveSlippageBps);
    const minQuoteOut = (expectedSolOut * (10000n - sellSlipBpsBn)) / 10000n;

    if (sellMintProfile.hasTransferHook) {
      logger.warn(
        { mint, extensions: sellMintProfile.extensionTypes },
        'Token-2022 mint declares TransferHook on sell — swap may revert if SDK omits hook extra accounts',
      );
    }

    const swapIxs = await buildSellInstructions(this.connection, {
      pool: poolPk,
      wallet: walletPk,
      baseAmountIn: baseInRaw,
      minQuoteAmountOut: minQuoteOut,
    });

    const tipMult = retryOverrides?.jitoTipMultiplier ?? 1;
    const jitoTipSol = DEFAULT_JITO_TIP_SOL * tipMult;
    const jitoTipLamports = Math.floor(jitoTipSol * 1e9);

    // Optional close-base-ATA at end of sell (2026-05-28). The SDK closes the
    // user's WSOL session ATA at tx end (refunding rent) but does NOT close
    // the base ATA — so we leave ~0.00204 SOL of rent locked in every closed
    // mint's ATA. Across many trades this adds up (~0.4 SOL across 200 trades
    // historically). Append a CloseAccount ix to our sell tx when:
    //   1. This is the FIRST attempt (attemptNumber === 1 or unset). Skipping
    //      on retries protects against the edge case where the close ix itself
    //      causes a tx revert — without this gate, every retry would re-add
    //      the close ix and the sell would loop forever in the same failure.
    //      Sacrifices the rent refund on retried sells but preserves the
    //      escalating-tip/slippage retry's ability to land cleanly.
    //   2. We're selling 100% of the wallet's tokens for this mint
    //      (baseInRaw === actualBaseRaw — guaranteed by our sell-cap logic
    //      from commit 6158b1a which caps at the lesser of pos.tokensHeld and
    //      actualBaseRaw; if cap fired due to tokensHeld < actualBaseRaw,
    //      there's leftover from another strategy — don't close)
    //   3. NOT a Token-2022 mint — TransferFee on Token-2022 can leave dust
    //      that would make CloseAccount revert (entire tx reverts atomically)
    // CloseAccount is ~3,500 CU and refunds the rent to the user wallet.
    const sellAttempt = retryOverrides?.attemptNumber ?? 1;
    const sellingAll = baseInRaw === BigInt(actualBaseRaw);
    const canCloseBaseAta = sellAttempt === 1 && sellingAll && !sellMintProfile.isToken2022;
    const closeBaseAtaIxs: TransactionInstruction[] = [];
    if (canCloseBaseAta) {
      const baseAta = getAssociatedTokenAddress(mintPk, walletPk, sellMintProfile.tokenProgram);
      closeBaseAtaIxs.push(createCloseAccountInstruction(
        baseAta,    // account to close
        walletPk,   // destination — rent refunded to user wallet
        walletPk,   // owner
        [],         // multisig signers (none)
        sellMintProfile.tokenProgram,
      ));
    }

    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }),
      ...swapIxs,
      buildJitoTipIx(walletPk, jitoTipLamports),
      ...closeBaseAtaIxs,
    ];

    const walletSolBefore = await this.wallet.getSolBalance(this.connection);

    // Wallet pre-flight (sell): sells produce SOL, but still need enough
    // for tip + tx fee up front. No 0.1 SOL floor here — sells recover
    // value, so as long as we can afford the submission cost we're fine.
    const sellOverheadLamports = jitoTipLamports + TX_FEE_LAMPORTS;
    if (walletSolBefore < sellOverheadLamports) {
      const balSol = walletSolBefore / 1e9;
      logger.warn(
        { mint, mode, walletSol: balSol.toFixed(4), needSol: (sellOverheadLamports / 1e9).toFixed(4) },
        'Live sell aborted — wallet cannot cover tip + tx fee',
      );
      return {
        success: false, effectivePrice: exitPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: `live sell: wallet_low (balance=${balSol.toFixed(4)} SOL, need>=${(sellOverheadLamports / 1e9).toFixed(4)} SOL for tip+fee)`,
      };
    }

    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: walletPk, recentBlockhash: blockhash }).add(...ixs);
    this.wallet.sign(tx);

    const submission = await submitBundle(this.connection, [tx.serialize()]);
    this.wallet.invalidateSolBalance();

    if (!submission.landed) {
      const sellExtensionFlags: string[] = [];
      if (sellMintProfile.isToken2022) sellExtensionFlags.push('token2022');
      if (sellMintProfile.hasTransferFee) sellExtensionFlags.push('transfer_fee');
      if (sellMintProfile.hasTransferHook) sellExtensionFlags.push('transfer_hook');
      const sellFailureContext: Record<string, unknown> = {
        path: submission.path,
        txSignature: submission.txSignature,
        solscanUrl: submission.txSignature
          ? `https://solscan.io/tx/${submission.txSignature}`
          : null,
        err: submission.errorMessage,
        isToken2022: sellMintProfile.isToken2022,
        hasTransferFee: sellMintProfile.hasTransferFee,
        hasTransferHook: sellMintProfile.hasTransferHook,
        extensionTypes: sellMintProfile.extensionTypes,
        baseTokenProgram: sellMintProfile.tokenProgram.toBase58(),
        baseInRaw: baseInRaw.toString(),
        minQuoteOut: minQuoteOut.toString(),
        latencyMs: submission.latencyMs,
      };
      if (submission.txSignature) {
        const logsInfo = await this.fetchFailureLogs(submission.txSignature);
        if (logsInfo) {
          sellFailureContext.programLogs = logsInfo.programLogs;
          sellFailureContext.failingProgram = logsInfo.failingProgram;
          sellFailureContext.failingInstructionIndex = logsInfo.failingInstructionIndex;
        }
      }
      logger.error(
        { mint, mode, ...sellFailureContext },
        'Live sell failed to land — diagnostic snapshot for post-mortem',
      );
      return {
        success: false, effectivePrice: exitPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: `live sell: tx did not land: ${submission.errorMessage ?? 'unknown'}`,
        txSignature: submission.txSignature,
        txLandMs: submission.latencyMs,
        failurePath: submission.path,
        mintExtensionFlags: sellExtensionFlags.join(','),
        failureContext: sellFailureContext,
      };
    }

    // See matching tightening on the buy side. 7.75s → 2.8s worst case.
    const fillDelaysMs = [300, 500, 800, 1200];
    let walletSolAfter = walletSolBefore;
    for (const dly of fillDelaysMs) {
      await this.sleep(dly);
      walletSolAfter = await this.wallet.getSolBalance(this.connection);
      if (walletSolAfter > walletSolBefore) break;
    }

    // ── Per-strategy proceeds attribution ──────────────────────────────────
    // Same race as the buy side. The full-wallet delta (walletSolAfter -
    // walletSolBefore) is CORRUPTED when another live strategy buys or sells
    // ANYTHING between our two reads: a concurrent sell credits SOL → our
    // proceeds inflate (live books a phantom gain, e.g. 3SxG +131% vs shadow
    // +18%); a concurrent buy debits SOL → our proceeds shrink (phantom loss).
    // That is exactly what blows up the live-vs-shadow gap on graduations where
    // the v44 cohort runs two live twins on the same mint at the same instant.
    //
    // The confirmed sell tx's own fee-payer delta (postBalances[0] -
    // preBalances[0]) is scoped to THIS tx alone. It is the net SOL credited to
    // our account (gross quote out − tip − fee + any rent refunded); adding back
    // tip + fee reconstructs the gross swap output exactly as the wallet-delta
    // path did, but immune to the race. Fall back to the wallet delta only when
    // RPC can't return the tx meta.
    const txDeltas = submission.txSignature
      ? await this.fetchTxBalanceDeltas(submission.txSignature, walletPk.toBase58(), mint)
      : null;
    if (!txDeltas) {
      logger.warn(
        { mint, mode, txSignature: submission.txSignature },
        'Live sell: tx-meta deltas unavailable — using wallet-balance delta (proceeds may be off if a concurrent trade raced)',
      );
    }
    const netAccountCreditLamports = txDeltas
      ? txDeltas.feePayerDeltaLamports
      : walletSolAfter - walletSolBefore;
    const solReceivedLamports =
      netAccountCreditLamports + jitoTipLamports + TX_FEE_LAMPORTS;
    const solReceived = solReceivedLamports / 1e9;
    // baseInRaw was capped at min(tokensHeld*1e6, actualBaseRaw). Use the cap
    // value (in human units) for effective-price calc, not tokensHeld blindly —
    // otherwise an underfilled wallet (we expected tokensHeld but had less)
    // would compute price against a number we didn't actually sell.
    const tokensSold = Number(baseInRaw) / 1e6;
    const effectivePrice = solReceived > 0 && tokensSold > 0 ? solReceived / tokensSold : exitPriceSol;
    const measuredSlippagePct = (1 - effectivePrice / pool.priceSol) * 100;

    logger.info(
      {
        mint, mode, path: submission.path, solReceived, effectivePrice,
        measuredSlippagePct: measuredSlippagePct.toFixed(3),
        latencyMs: submission.latencyMs,
        isToken2022: sellMintProfile.isToken2022,
        hasTransferFee: sellMintProfile.hasTransferFee,
      },
      'Live sell filled'
    );

    return {
      success: true, effectivePrice, tokensReceived: 0,
      txSignature: submission.txSignature,
      dryRun: false, executionMode: mode,
      measuredSlippagePct, jitoTipSol,
      txLandMs: submission.latencyMs,
    };
  }

  /**
   * Fetch on-chain program logs for a failed tx and pull out the lines
   * around the failure. Used to enrich `failureContext` so the operator
   * doesn't have to open Solscan to see why the swap reverted.
   *
   * Best-effort — if the tx isn't queryable yet (RPC hasn't indexed it),
   * we retry briefly then give up and return null. Never throws.
   */
  private async fetchFailureLogs(txSignature: string): Promise<{
    programLogs: string[];
    failingProgram: string | null;
    failingInstructionIndex: number | null;
  } | null> {
    if (!this.connection) return null;
    const retryDelaysMs = [800, 1500, 2500];
    let tx = null;
    for (const delay of retryDelaysMs) {
      try {
        tx = await this.connection.getTransaction(txSignature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        if (tx) break;
      } catch {
        // Swallow — we retry, then return null
      }
      await this.sleep(delay);
    }
    if (!tx?.meta) return null;
    const logs = tx.meta.logMessages ?? [];
    // Find the program that emitted the failure: look for the last
    // "Program <id> failed" line. Anchor errors usually log `Custom: N`
    // right above; Solana runtime errors (InsufficientFundsForRent) show
    // an `Error processing Instruction <n>:` line.
    let failingProgram: string | null = null;
    let failingInstructionIndex: number | null = null;
    for (let i = logs.length - 1; i >= 0; i--) {
      const line = logs[i];
      const failMatch = line.match(/Program (\S+) failed: /);
      if (failMatch && !failingProgram) failingProgram = failMatch[1];
      const ixMatch = line.match(/Error processing Instruction (\d+)/);
      if (ixMatch && failingInstructionIndex == null) {
        failingInstructionIndex = parseInt(ixMatch[1], 10);
      }
      if (failingProgram && failingInstructionIndex != null) break;
    }
    // Tail the last ~25 lines — enough to capture the failing program's
    // context without bloating the row. If we ever need more we can pull
    // by sig directly from RPC.
    const programLogs = logs.slice(-25);
    return { programLogs, failingProgram, failingInstructionIndex };
  }

  /** Read THIS transaction's own balance deltas from confirmed tx meta —
   *  scoped to a single tx, so it is immune to the full-wallet race that
   *  corrupts snapshot deltas when another strategy buys or sells the same
   *  (or any) mint concurrently (the v44 mis-attribution bug, 2026-05-29).
   *
   *  Returns the raw token amount credited to our base ATA by this swap and
   *  the SIGNED lamport change to our fee-payer account (postBalances[0] -
   *  preBalances[0]): negative on a buy (we paid swap cost + tip + fee +
   *  persisted ATA rent), positive on a sell (we received the quote SOL minus
   *  tip + fee). Null when the tx meta can't be fetched — caller falls back to
   *  the wallet-balance delta. */
  private async fetchTxBalanceDeltas(
    txSignature: string,
    ownerB58: string,
    mintB58: string,
  ): Promise<{ tokensReceivedRaw: number; feePayerDeltaLamports: number } | null> {
    if (!this.connection) return null;
    const retryDelaysMs = [800, 1500, 2500];
    let tx = null;
    for (const delay of retryDelaysMs) {
      try {
        tx = await this.connection.getTransaction(txSignature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        if (tx) break;
      } catch {
        // Swallow — we retry, then return null
      }
      await this.sleep(delay);
    }
    if (!tx?.meta) return null;
    // Fee payer is always account index 0. post - pre = signed lamport change
    // to our account in this tx (negative on a buy = spent, positive on a sell
    // = net proceeds after tip + fee).
    const preSol = tx.meta.preBalances?.[0];
    const postSol = tx.meta.postBalances?.[0];
    if (preSol == null || postSol == null) return null;
    const feePayerDeltaLamports = postSol - preSol;
    // Tokens: post-minus-pre on the token account(s) we own holding the base
    // mint (our base ATA). A pre entry is absent when the ATA was created in
    // this same tx → treat the prior balance as 0.
    const preByIdx = new Map<number, bigint>();
    for (const b of tx.meta.preTokenBalances ?? []) {
      if (b.owner === ownerB58 && b.mint === mintB58) {
        preByIdx.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
      }
    }
    let tokensReceivedRaw = 0n;
    for (const b of tx.meta.postTokenBalances ?? []) {
      if (b.owner === ownerB58 && b.mint === mintB58) {
        const before = preByIdx.get(b.accountIndex) ?? 0n;
        tokensReceivedRaw += BigInt(b.uiTokenAmount.amount) - before;
      }
    }
    return { tokensReceivedRaw: Number(tokensReceivedRaw), feePayerDeltaLamports };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
