import {
  Connection,
  PublicKey,
  Transaction,
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

const logger = makeLogger('trading-executor');

// ── Fill-attribution constants ──────────────────────────────────────────────
// Tx signatures cost 5000 lamports per signer. Our buy/sell txs have one signer.
const TX_FEE_LAMPORTS = 5_000;
// SPL token account rent-exempt minimum (165-byte account). This is what the
// idempotent create-ATA ix pays when the ATA doesn't already exist — and it
// stays locked up in the account until we close it. To keep per-trade slippage
// measurement honest we subtract this from solSpent on any fresh-ATA buy.
const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280;

export interface PoolPriceResult {
  priceSol: number;
  solReserves: number;
  tokenReserves: number;
}

/** Pool + creator context needed to build a PumpSwap swap. Resolved by the
 *  evaluator (buy) / position manager (sell) from existing ObservationContext
 *  / ActivePosition state. Creator is looked up lazily from the pool account. */
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
  /** Execution phase this fill came from — drives downstream accounting. */
  executionMode?: ExecutionMode;
  /** Measured slippage at fill vs spot price at submission (%). Live + shadow only. */
  measuredSlippagePct?: number;
  /** Jito tip actually paid (SOL). Undefined in paper/shadow. */
  jitoTipSol?: number;
  /** Submit → confirm latency in ms. Undefined in paper/shadow. */
  txLandMs?: number;
}

/**
 * Read the u64 amount from an SPL token account.
 * Layout: [32] mint, [32] owner, [8] amount (little-endian u64) at offset 64.
 * Replicates the logic in PriceCollector.readTokenAccountAmount.
 */
export function readTokenAccountAmount(data: Buffer): number | null {
  if (data.length < 72) return null;
  try {
    return new BN(data.subarray(64, 72), 'le').toNumber();
  } catch {
    return null;
  }
}

// ── Vault price deduplication cache ────────────────────────────────────────
//
// Multiple strategies may have positions on the same pool. Without dedup,
// 6 strategies = 6 identical RPC calls per 5-second tick. This cache ensures
// only 1 RPC call per unique vault pair per TTL window. In-flight requests
// are coalesced — concurrent callers share the same promise.
//
const VAULT_CACHE_TTL_MS = 4_000; // 4 seconds (shorter than the 5s poll interval)

interface CachedVaultPrice {
  result: PoolPriceResult | null;
  fetchedAt: number;
}

/** Settled results cache: key = `${baseVault}:${quoteVault}` */
const vaultPriceCache = new Map<string, CachedVaultPrice>();

/** In-flight promises: callers arriving while a fetch is in progress share the same promise */
const inflightFetches = new Map<string, Promise<PoolPriceResult | null>>();

/** Stats for monitoring dedup effectiveness */
export const vaultPriceCacheStats = { hits: 0, misses: 0, coalesced: 0 };

/**
 * Fetch the current pool price by reading both vault token accounts in a single RPC call.
 * Deduplicates concurrent requests for the same vault pair — multiple strategies monitoring
 * the same pool share a single RPC call per tick.
 *
 * @param critical  When true, uses throttle() (always waits) instead of throttleOrDrop().
 *                  Use critical=true for active position SL/TP monitoring — a missed check
 *                  could mean a late SL exit and much larger losses than expected.
 */
export async function fetchVaultPrice(
  connection: Connection,
  baseVault: string,
  quoteVault: string,
  critical: boolean = false,
): Promise<PoolPriceResult | null> {
  const cacheKey = `${baseVault}:${quoteVault}`;

  // 1. Check settled cache (recent result within TTL)
  const cached = vaultPriceCache.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < VAULT_CACHE_TTL_MS) {
    vaultPriceCacheStats.hits++;
    return cached.result;
  }

  // 2. Check in-flight: if another caller is already fetching this pair, wait for it
  const inflight = inflightFetches.get(cacheKey);
  if (inflight) {
    vaultPriceCacheStats.coalesced++;
    return inflight;
  }

  // 3. No cache, no in-flight — make the actual RPC call
  vaultPriceCacheStats.misses++;
  const fetchPromise = fetchVaultPriceRpc(connection, baseVault, quoteVault, critical);

  // Register in-flight so concurrent callers share this promise
  inflightFetches.set(cacheKey, fetchPromise);

  try {
    const result = await fetchPromise;
    // Only cache successful reads. Caching null poisons subsequent buys/sells
    // for the full TTL window — multiple shadow strategies firing on the same
    // graduation would all see a transient null until the cache expired.
    // Coalescing via inflightFetches still dedupes truly-concurrent calls.
    if (result !== null) {
      vaultPriceCache.set(cacheKey, { result, fetchedAt: Date.now() });
    }
    return result;
  } finally {
    inflightFetches.delete(cacheKey);
  }
}

/** Single-pass RPC fetch. Returns null on any failure mode and logs the cause. */
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

    // base = graduated token (6 decimals), quote = wSOL (9 decimals)
    const tokenReserves = baseAmount / 1_000_000;
    const solReserves   = quoteAmount / 1_000_000_000;

    if (tokenReserves <= 0 || solReserves <= 0) return null;

    return { priceSol: solReserves / tokenReserves, solReserves, tokenReserves };
  } catch (err) {
    logger.debug('fetchVaultPrice RPC error: %s', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Raw RPC fetch — called only when cache misses and no in-flight request exists.
 *  Retries once on `critical=true` paths to absorb transient RPC errors and the
 *  short window right after graduation when vault accounts may not yet be visible
 *  on the connected RPC node. */
async function fetchVaultPriceRpc(
  connection: Connection,
  baseVault: string,
  quoteVault: string,
  critical: boolean,
): Promise<PoolPriceResult | null> {
  if (critical) {
    // Position monitoring + buys/sells: always wait for a slot — never silently skip
    await globalRpcLimiter.throttle();
  } else if (!await globalRpcLimiter.throttleOrDrop(5)) {
    // Non-critical callers: yield under load
    return null;
  }

  const first = await fetchVaultPriceRpcOnce(connection, baseVault, quoteVault);
  if (first !== null || !critical) return first;

  // One retry for critical reads. 250ms is short enough to keep buy latency
  // under the 5s poll budget but long enough for vault-account propagation
  // and most transient RPC errors to clear.
  await new Promise(resolve => setTimeout(resolve, 250));
  await globalRpcLimiter.throttle();
  return fetchVaultPriceRpcOnce(connection, baseVault, quoteVault);
}

export class Executor {
  private readonly globalMode: ExecutionMode;
  private readonly wallet: Wallet | null;
  private readonly connection: Connection | null;

  /**
   * @param globalMode  Global fallback mode (from env). Per-call `mode` overrides it.
   * @param connection  Solana RPC connection (null → live/shadow unavailable)
   * @param wallet      Signer keypair (null → live unavailable; shadow still works)
   */
  constructor(
    globalMode: ExecutionMode = 'paper',
    connection: Connection | null = null,
    wallet: Wallet | null = null,
  ) {
    this.globalMode = globalMode;
    this.connection = connection;
    this.wallet = wallet;
  }

  /** Simulate or execute a buy. Dispatch by execution mode:
   *   paper      — compute effective price from slippage estimate, no chain read
   *   shadow     — read live pool reserves, compute measured slippage, no tx
   *   live_micro — override amount to MICRO_TRADE_SIZE_SOL, then live path
   *   live_full  — live path at provided amount
   */
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

    // Hard override to micro size on live_micro, regardless of strategy config.
    const actualAmount = effectiveMode === 'live_micro' ? MICRO_TRADE_SIZE_SOL : amountSol;
    return this.liveBuy(mint, actualAmount, expectedPriceSol, poolCtx, effectiveMode);
  }

  /** Simulate or execute a sell — same mode dispatch as buy. */
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

  // ── Shadow: quote on-chain, don't submit ─────────────────────────────────

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
      // Simulate the Jito tip cost a live fill would have paid. Not a real
      // expense in shadow, but recorded so net_return_pct reflects what live
      // would actually net out.
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
        success: true, effectivePrice: exitPriceSol, tokensReceived: 0,
        dryRun: true, executionMode: 'shadow',
      };
    }
    const pool = await fetchVaultPrice(this.connection, poolCtx.baseVault, poolCtx.quoteVault, true);
    if (!pool) {
      return {
        success: true, effectivePrice: exitPriceSol, tokensReceived: 0,
        dryRun: true, executionMode: 'shadow',
      };
    }
    const solRes = BigInt(Math.floor(pool.solReserves * 1e9));
    const tokRes = BigInt(Math.floor(pool.tokenReserves * 1e6));
    const baseIn = BigInt(Math.floor(tokensHeld * 1e6));
    const solOut = computeExpectedQuoteOut(solRes, tokRes, baseIn);
    const solReceived = Number(solOut) / 1e9;
    const effectivePrice = solReceived / tokensHeld;
    // Exit slippage is measured the same way — how much worse our fill is vs spot.
    const measuredSlippagePct = (1 - effectivePrice / pool.priceSol) * 100;
    logger.info(
      { mint, tokensHeld, spotPrice: pool.priceSol, measuredSlippagePct: measuredSlippagePct.toFixed(3) },
      'Shadow sell quote'
    );
    return {
      success: true, effectivePrice, tokensReceived: 0,
      dryRun: true, executionMode: 'shadow', measuredSlippagePct,
      // Simulate the exit-side Jito tip — same rationale as shadowBuy.
      jitoTipSol: DEFAULT_JITO_TIP_SOL,
    };
  }

  // ── Live: build, sign, submit, measure ────────────────────────────────────

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

    // Measure spot + quote expected output for slippage attribution post-fill.
    const pool = await fetchVaultPrice(this.connection, poolCtx.baseVault, poolCtx.quoteVault, true);
    if (!pool) {
      return {
        success: false, effectivePrice: expectedPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: 'live: pool reserves read failed',
      };
    }
    const solInLamports = BigInt(Math.floor(amountSol * 1e9));
    const solRes = BigInt(Math.floor(pool.solReserves * 1e9));
    const tokRes = BigInt(Math.floor(pool.tokenReserves * 1e6));
    const expectedBaseOutRaw = computeExpectedBaseOut(solRes, tokRes, solInLamports);
    // 5% slippage tolerance on the on-chain guardrail — our safety preflight
    // has already enforced a tighter bound, this is the last-resort backstop.
    const minBaseOutRaw = (expectedBaseOutRaw * 95n) / 100n;
    const maxQuoteInLamports = (solInLamports * 105n) / 100n;

    // Pre-fill snapshot for fill attribution:
    //   baseBalBefore       — raw u64 tokens already in wallet (0 if fresh)
    //   baseAtaExistsBefore — was the ATA already paid-for? drives rent subtraction
    //   walletSolBefore     — lamports before tx
    const walletPk = this.wallet.pubkey;
    const baseAta = getAssociatedTokenAddress(mintPk, walletPk);
    const baseAtaInfoBefore = await this.connection.getAccountInfo(baseAta, 'confirmed').catch(() => null);
    const baseAtaExistsBefore = !!baseAtaInfoBefore;
    const baseBalBefore = await this.wallet.getTokenBalanceRaw(this.connection, mintPk);
    const walletSolBefore = await this.wallet.getSolBalance(this.connection);

    // SDK returns the full swap sequence: ATA-create-idempotent (base + wSOL),
    // wSOL wrap+sync to maxQuoteIn, the swap with all IDL accounts + cashback /
    // poolV2 / buyback remaining accounts, and wSOL close. We frame it with
    // compute-budget on the front and a Jito tip at the back.
    const swapIxs = await buildBuyInstructions(this.connection, {
      pool: poolPk,
      wallet: walletPk,
      baseAmountOut: minBaseOutRaw,
      maxQuoteAmountIn: maxQuoteInLamports,
    });

    const jitoTipSol = DEFAULT_JITO_TIP_SOL;
    const jitoTipLamports = Math.floor(jitoTipSol * 1e9);

    const ixs = [
      // 200k CU limit covers the ~123k buy / ~111k sell measured via
      // /api/verify-pumpswap simulation against live chain (2026-04-25),
      // with ~80k headroom for the Jito tip ix + live-blockhash variance.
      // Was 400k — cut for priority-fee savings before shadow rollout.
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ...swapIxs,
      buildJitoTipIx(walletPk, jitoTipLamports),
    ];

    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: walletPk, recentBlockhash: blockhash }).add(...ixs);
    this.wallet.sign(tx);

    const submission = await submitBundle(this.connection, [tx.serialize()]);
    this.wallet.invalidateSolBalance();

    if (!submission.landed) {
      return {
        success: false, effectivePrice: expectedPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: `live: tx did not land (${submission.path}): ${submission.errorMessage ?? 'unknown'}`,
        txLandMs: submission.latencyMs,
      };
    }

    // Measure fill: token balance delta in → tokens received; SOL delta out → actual cost.
    // Poll briefly — balance updates can lag confirmation by a few hundred ms.
    await this.sleep(800);
    const baseBalAfter = await this.wallet.getTokenBalanceRaw(this.connection, mintPk);
    const walletSolAfter = await this.wallet.getSolBalance(this.connection);
    const tokensReceivedRaw = baseBalAfter - baseBalBefore;
    const tokensReceived = tokensReceivedRaw / 1e6;
    // walletSolBefore - walletSolAfter includes everything that left the wallet:
    //   (a) actual swap payment into quote_vault  ← what we want
    //   (b) Jito tip (separate ix, same tx)
    //   (c) 5000 lamports tx fee
    //   (d) token-account rent if the baseMint ATA was freshly created
    // wSOL ATA is created AND closed in the same tx, so its rent nets to 0.
    // Subtracting (b–d) gives us the isolated swap cost for slippage attribution.
    const overheadLamports =
      jitoTipLamports + TX_FEE_LAMPORTS + (baseAtaExistsBefore ? 0 : TOKEN_ACCOUNT_RENT_LAMPORTS);
    const solSpentLamports = walletSolBefore - walletSolAfter;
    const swapCostLamports = solSpentLamports - overheadLamports;
    const swapCostSol = swapCostLamports / 1e9;
    if (tokensReceived <= 0 || swapCostLamports <= 0) {
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

    // Re-read actual token balance — tokensHeld may drift from DB (should be tight)
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
    const solRes = BigInt(Math.floor(pool.solReserves * 1e9));
    const tokRes = BigInt(Math.floor(pool.tokenReserves * 1e6));
    const expectedSolOut = computeExpectedQuoteOut(solRes, tokRes, baseInRaw);
    const minQuoteOut = (expectedSolOut * 95n) / 100n;

    // SDK builds the full sell sequence: ATA-create-idempotent for wSOL, the
    // sell ix (with cashback / poolV2 / buyback remaining accounts), and the
    // wSOL close to reclaim rent + receive proceeds.
    const swapIxs = await buildSellInstructions(this.connection, {
      pool: poolPk,
      wallet: walletPk,
      baseAmountIn: baseInRaw,
      minQuoteAmountOut: minQuoteOut,
    });

    const jitoTipSol = DEFAULT_JITO_TIP_SOL;
    const jitoTipLamports = Math.floor(jitoTipSol * 1e9);

    const ixs = [
      // Same 200k limit as buy — measured ~111k via verify-pumpswap sim,
      // ~80k headroom for tip + variance. Was 300k.
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ...swapIxs,
      buildJitoTipIx(walletPk, jitoTipLamports),
    ];

    const walletSolBefore = await this.wallet.getSolBalance(this.connection);
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: walletPk, recentBlockhash: blockhash }).add(...ixs);
    this.wallet.sign(tx);

    const submission = await submitBundle(this.connection, [tx.serialize()]);
    this.wallet.invalidateSolBalance();

    if (!submission.landed) {
      return {
        success: false, effectivePrice: exitPriceSol, tokensReceived: 0,
        dryRun: false, executionMode: mode,
        errorMessage: `live sell: tx did not land: ${submission.errorMessage ?? 'unknown'}`,
        txLandMs: submission.latencyMs,
      };
    }

    await this.sleep(800);
    const walletSolAfter = await this.wallet.getSolBalance(this.connection);
    // (walletSolAfter - walletSolBefore) is net SOL into the wallet (swap gain
    // minus tip, tx fee; plus any wSOL ATA rent refund — we create+close it
    // in the same tx so it nets to 0). Add back the tip + fee to isolate the
    // swap proceeds for slippage attribution.
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
