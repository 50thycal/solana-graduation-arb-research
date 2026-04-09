import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('trading-executor');

export interface PoolPriceResult {
  priceSol: number;
  solReserves: number;
  tokenReserves: number;
}

export interface ExecutionResult {
  success: boolean;
  effectivePrice: number;
  tokensReceived: number;
  txSignature?: string;
  errorMessage?: string;
  dryRun: boolean;
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

/**
 * Fetch the current pool price by reading both vault token accounts in a single RPC call.
 * Uses the globalRpcLimiter — drops the call if the queue is full (returns null).
 *
 * This is extracted from PriceCollector.fetchPoolPrice and used by both the price
 * collector and the position manager for SL/TP monitoring.
 */
export async function fetchVaultPrice(
  connection: Connection,
  baseVault: string,
  quoteVault: string,
): Promise<PoolPriceResult | null> {
  if (!await globalRpcLimiter.throttleOrDrop(5)) {
    // Lower priority (5) than graduation detection — yield under load
    return null;
  }

  try {
    const accounts = await connection.getMultipleAccountsInfo([
      new PublicKey(baseVault),
      new PublicKey(quoteVault),
    ]);

    if (!accounts[0]?.data || !accounts[1]?.data) return null;

    const baseAmount = readTokenAccountAmount(accounts[0].data as Buffer);
    const quoteAmount = readTokenAccountAmount(accounts[1].data as Buffer);

    if (baseAmount === null || quoteAmount === null || baseAmount === 0 || quoteAmount === 0) {
      return null;
    }

    // base = graduated token (6 decimals), quote = wSOL (9 decimals)
    const tokenReserves = baseAmount / 1_000_000;
    const solReserves   = quoteAmount / 1_000_000_000;

    if (tokenReserves <= 0 || solReserves <= 0) return null;

    return { priceSol: solReserves / tokenReserves, solReserves, tokenReserves };
  } catch (err) {
    logger.debug('fetchVaultPrice failed: %s', err instanceof Error ? err.message : String(err));
    return null;
  }
}

export class Executor {
  private readonly mode: 'paper' | 'live';

  constructor(mode: 'paper' | 'live') {
    this.mode = mode;
  }

  /**
   * Simulate or execute a buy.
   *
   * Paper mode: return an immediate result with a 1.75% simulated slippage overhead.
   * Live mode: execute via Jupiter aggregator (Phase 3).
   */
  async buy(
    mint: string,
    amountSol: number,
    expectedPriceSol: number,
  ): Promise<ExecutionResult> {
    if (this.mode === 'paper') {
      // Simulate entry slippage: 1.75% overhead matching average observed slippage_est_05sol
      const effectivePrice = expectedPriceSol * 1.0175;
      const tokensReceived = amountSol / effectivePrice;
      return { success: true, effectivePrice, tokensReceived, dryRun: true };
    }

    // Live mode — Phase 3
    return this.jupiterBuy(mint, amountSol, expectedPriceSol);
  }

  /**
   * Simulate or execute a sell.
   *
   * Paper mode: return an immediate result at the given exit price (no tx needed).
   * Live mode: sell all held tokens via Jupiter (Phase 3).
   */
  async sell(
    mint: string,
    tokensHeld: number,
    exitPriceSol: number,
  ): Promise<ExecutionResult> {
    if (this.mode === 'paper') {
      const solReceived = tokensHeld * exitPriceSol;
      return { success: true, effectivePrice: exitPriceSol, tokensReceived: 0, dryRun: true };
    }

    // Live mode — Phase 3
    return this.jupiterSell(mint, tokensHeld, exitPriceSol);
  }

  // ── Phase 3: Jupiter execution ────────────────────────────────────────────

  private async jupiterBuy(
    mint: string,
    amountSol: number,
    expectedPriceSol: number,
  ): Promise<ExecutionResult> {
    // TODO Phase 3: implement Jupiter Quote+Swap
    // 1. GET https://quote-api.jup.ag/v6/quote
    //    inputMint=So111...  outputMint={mint}  amount={lamports}  slippageBps={config}
    // 2. POST https://quote-api.jup.ag/v6/swap  with quoteResponse + wallet pubkey
    // 3. Deserialize → sign with wallet → sendRawTransaction → confirmTransaction
    // 4. Compute effectivePrice from post-tx token balance delta
    //
    // NOTE: use mint (not poolAddress) — Jupiter discovers PumpSwap route by mint.
    // If Jupiter returns "no routes", log and return success:false — do not throw.
    logger.warn({ mint }, 'Jupiter buy not yet implemented (Phase 3)');
    return {
      success: false,
      effectivePrice: expectedPriceSol,
      tokensReceived: 0,
      errorMessage: 'Jupiter execution not yet implemented',
      dryRun: false,
    };
  }

  private async jupiterSell(
    mint: string,
    tokensHeld: number,
    expectedPriceSol: number,
  ): Promise<ExecutionResult> {
    // TODO Phase 3: implement Jupiter sell
    logger.warn({ mint }, 'Jupiter sell not yet implemented (Phase 3)');
    return {
      success: false,
      effectivePrice: expectedPriceSol,
      tokensReceived: 0,
      errorMessage: 'Jupiter execution not yet implemented',
      dryRun: false,
    };
  }
}
