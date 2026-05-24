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
import { DEFAULT_JITO_TIP_SOL, MICRO_TRADE_SIZE_SOL } from './config';
import { Wallet, WSOL_MINT, getAssociatedTokenAddress } from './wallet';
import {
  buildBuyInstructions,
  buildSellInstructions,
  computeExpectedBaseOut,
  computeExpectedQuoteOut,
} from './pumpswap-swap';
import { buildJitoTipIx, submitBundle } from './jito';
import {
  getMintProfile,
  buildIdempotentAtaCreateIx,
  getTransferFeeForRawAmount,
} from './token-2022';

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
    return this.liveBuy(mint, actualAmount, expectedPriceSol, poolCtx, effectiveMode);
  }

  async sell(
    mint: string,
    tokensHeld: number,
    exitPriceSol: number,
    slippageEstPct?: number,
    poolCtx?: PoolContext,
    mode?: ExecutionMode,
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
    return this.liveSell(mint, tokensHeld, exitPriceSol, poolCtx, effectiveMode);
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

    const pool = await fetchVaultPrice(this.connection, poolCtx.baseVault, poolCtx.quoteVault, true);
    if (!pool) {
      return {
        success: false, effectivePrice: expectedPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: 'live: pool reserves read failed',
      };
    }

    const walletPk = this.wallet.pubkey;
    const mintProfile = await getMintProfile(this.connection, mintPk);
    const baseTokenProgram = mintProfile.tokenProgram;
    const baseAta = getAssociatedTokenAddress(mintPk, walletPk, baseTokenProgram);
    const baseAtaInfoBefore = await this.connection.getAccountInfo(baseAta, 'confirmed').catch(() => null);
    const baseAtaExistsBefore = !!baseAtaInfoBefore;
    const baseBalBefore = await this.wallet.getTokenBalanceRaw(this.connection, mintPk);
    const walletSolBefore = await this.wallet.getSolBalance(this.connection);

    const solInLamports = BigInt(Math.floor(amountSol * 1e9));
    const solRes = BigInt(Math.floor(pool.solReserves * 1e9));
    const tokRes = BigInt(Math.floor(pool.tokenReserves * 1e6));
    const expectedBaseOutRaw = computeExpectedBaseOut(solRes, tokRes, solInLamports);
    const transferFeeOnExpected = mintProfile.hasTransferFee
      ? await getTransferFeeForRawAmount(this.connection, mintPk, baseTokenProgram, expectedBaseOutRaw)
      : 0n;
    const feeAdjustedExpectedBaseOut = expectedBaseOutRaw - transferFeeOnExpected;
    const minBaseOutRaw = (feeAdjustedExpectedBaseOut * 95n) / 100n;
    const maxQuoteInLamports = (solInLamports * 105n) / 100n;

    const swapIxs = await buildBuyInstructions(this.connection, {
      pool: poolPk,
      wallet: walletPk,
      baseAmountOut: minBaseOutRaw,
      maxQuoteAmountIn: maxQuoteInLamports,
    });

    const jitoTipSol = DEFAULT_JITO_TIP_SOL;
    const jitoTipLamports = Math.floor(jitoTipSol * 1e9);

    const ataPreCreateIxs: TransactionInstruction[] = baseAtaExistsBefore
      ? []
      : [buildIdempotentAtaCreateIx(walletPk, baseAta, walletPk, mintPk, baseTokenProgram)];

    if (mintProfile.hasTransferHook) {
      logger.warn(
        { mint, extensions: mintProfile.extensionTypes },
        'Token-2022 mint declares TransferHook — swap may revert if SDK omits hook extra accounts',
      );
    }

    // Wallet pre-flight: refuse to submit if the wallet can't cover the worst-
    // case outflow PLUS a 0.1 SOL safety floor. Catches the InsufficientFunds-
    // ForRent class of buy failures before they burn an RPC roundtrip + tip.
    // Per-operator policy (2026-05-24): floor=0.1 SOL — wallet typically sits
    // at 0.2-0.5 SOL with 0.05 SOL trade size, so 0.1 leaves comfortable margin.
    const WALLET_MIN_FLOOR_LAMPORTS = 100_000_000;
    const projectedOutflowLamports =
      Number(maxQuoteInLamports) +
      jitoTipLamports +
      TX_FEE_LAMPORTS +
      (baseAtaExistsBefore ? 0 : TOKEN_ACCOUNT_RENT_LAMPORTS);
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
        },
        'Live buy aborted — wallet below safety floor',
      );
      return {
        success: false, effectivePrice: expectedPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: `live: wallet_low (balance=${balSol.toFixed(4)} SOL, need>=${needSol.toFixed(4)} SOL = trade+tip+fee+rent+0.1 floor)`,
      };
    }

    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
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
      logger.error(
        {
          mint, mode,
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
          ataPreCreated: !baseAtaExistsBefore,
          baseTokenProgram: baseTokenProgram.toBase58(),
          expectedBaseOutRaw: expectedBaseOutRaw.toString(),
          minBaseOutRaw: minBaseOutRaw.toString(),
          maxQuoteInLamports: maxQuoteInLamports.toString(),
          latencyMs: submission.latencyMs,
        },
        'Live buy failed to land — diagnostic snapshot for post-mortem',
      );
      return {
        success: false, effectivePrice: expectedPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: `live: tx did not land (${submission.path}): ${submission.errorMessage ?? 'unknown'}`,
        txSignature: submission.txSignature,
        txLandMs: submission.latencyMs,
      };
    }

    const fillDelaysMs = [750, 1000, 1500, 2000, 2500];
    let baseBalAfter = baseBalBefore;
    for (const dly of fillDelaysMs) {
      await this.sleep(dly);
      baseBalAfter = await this.wallet.getTokenBalanceRaw(this.connection, mintPk);
      if (baseBalAfter > baseBalBefore) break;
    }
    const walletSolAfter = await this.wallet.getSolBalance(this.connection);
    const tokensReceivedRaw = baseBalAfter - baseBalBefore;
    const tokensReceived = tokensReceivedRaw / 1e6;
    const overheadLamports =
      jitoTipLamports + TX_FEE_LAMPORTS + (baseAtaExistsBefore ? 0 : TOKEN_ACCOUNT_RENT_LAMPORTS);
    const solSpentLamports = walletSolBefore - walletSolAfter;
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
          return {
            success: true,
            effectivePrice: lateEffectivePrice,
            tokensReceived: lateTokensReceived,
            txSignature: submission.txSignature,
            dryRun: false, executionMode: mode,
            jitoTipSol,
            txLandMs: submission.latencyMs,
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

    return {
      success: true, effectivePrice, tokensReceived,
      txSignature: submission.txSignature,
      dryRun: false, executionMode: mode,
      measuredSlippagePct, jitoTipSol,
      txLandMs: submission.latencyMs,
    };
  }

  private async liveSell(
    mint: string,
    tokensHeld: number,
    exitPriceSol: number,
    poolCtx: PoolContext | undefined,
    mode: ExecutionMode,
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

    const actualBaseRaw = await this.wallet.getTokenBalanceRaw(this.connection, mintPk);
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
    const baseInRaw = BigInt(actualBaseRaw);
    const sellMintProfile = await getMintProfile(this.connection, mintPk);
    const transferFeeOnIn = sellMintProfile.hasTransferFee
      ? await getTransferFeeForRawAmount(this.connection, mintPk, sellMintProfile.tokenProgram, baseInRaw)
      : 0n;
    const effectiveBaseIn = baseInRaw - transferFeeOnIn;
    const solRes = BigInt(Math.floor(pool.solReserves * 1e9));
    const tokRes = BigInt(Math.floor(pool.tokenReserves * 1e6));
    const expectedSolOut = computeExpectedQuoteOut(solRes, tokRes, effectiveBaseIn);
    const minQuoteOut = (expectedSolOut * 95n) / 100n;

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

    const jitoTipSol = DEFAULT_JITO_TIP_SOL;
    const jitoTipLamports = Math.floor(jitoTipSol * 1e9);

    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ...swapIxs,
      buildJitoTipIx(walletPk, jitoTipLamports),
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
      logger.error(
        {
          mint, mode,
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
        },
        'Live sell failed to land — diagnostic snapshot for post-mortem',
      );
      return {
        success: false, effectivePrice: exitPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: `live sell: tx did not land: ${submission.errorMessage ?? 'unknown'}`,
        txSignature: submission.txSignature,
        txLandMs: submission.latencyMs,
      };
    }

    const fillDelaysMs = [750, 1000, 1500, 2000, 2500];
    let walletSolAfter = walletSolBefore;
    for (const dly of fillDelaysMs) {
      await this.sleep(dly);
      walletSolAfter = await this.wallet.getSolBalance(this.connection);
      if (walletSolAfter > walletSolBefore) break;
    }
    const solReceivedLamports =
      walletSolAfter - walletSolBefore + jitoTipLamports + TX_FEE_LAMPORTS;
    const solReceived = solReceivedLamports / 1e9;
    const effectivePrice = solReceived > 0 ? solReceived / tokensHeld : exitPriceSol;
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

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
