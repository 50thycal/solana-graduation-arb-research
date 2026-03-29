import {
  Connection,
  PublicKey,
  Logs,
  Context,
  AccountInfo,
} from '@solana/web3.js';
import BN from 'bn.js';
import Database from 'better-sqlite3';
import pino from 'pino';
import { insertGraduation, insertMomentum, updateGraduationEnrichment, updateGraduationPool } from '../db/queries';
import { PoolTracker } from './pool-tracker';
import { HolderEnrichment } from '../collector/holder-enrichment';
import { globalRpcLimiter } from '../utils/rpc-limiter';
import { PriceCollector } from '../collector/price-collector';

const logger = pino({ name: 'graduation-listener' });

// pump.fun program ID
const PUMP_FUN_PROGRAM_ID = new PublicKey(
  process.env.PUMP_FUN_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
);
const PUMP_FUN_PROGRAM_STR = PUMP_FUN_PROGRAM_ID.toBase58();

// Bonding curve account data layout offsets
const BONDING_CURVE_LAYOUT = {
  VIRTUAL_TOKEN_RESERVES: 8,   // u64 at offset 8
  VIRTUAL_SOL_RESERVES: 16,    // u64 at offset 16
  REAL_TOKEN_RESERVES: 24,     // u64 at offset 24
  REAL_SOL_RESERVES: 32,       // u64 at offset 32
  TOKEN_TOTAL_SUPPLY: 40,      // u64 at offset 40
  COMPLETE: 48,                // bool at offset 48
};

const LAMPORTS_PER_SOL = new BN(1_000_000_000);
const TOKEN_DECIMAL_FACTOR = new BN(10 ** 6);

// pump.fun virtual reserve constants (used in tx-based price extraction)
// virtualSol = realSol + 30 SOL;  virtualToken = realToken + 279_900_191 tokens (6 dec)
const PUMP_VIRTUAL_SOL_OFFSET_LAMPORTS = 30_000_000_000; // 30 SOL in lamports
const PUMP_VIRTUAL_TOKEN_OFFSET_RAW = 279_900_191_000_000; // raw token units (6 dec)

// Graduation verification thresholds
// A completed bonding curve typically has ~79-85 SOL in real reserves
// and near-zero real token reserves
const MIN_SOL_RESERVES_FOR_GRADUATION = 70; // SOL — curve is complete around 79-85
const MAX_TOKEN_RESERVES_FOR_GRADUATION = 1_000_000; // tokens — should be near 0 when complete

// Reconnection settings
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const RECONNECT_BACKOFF_MULTIPLIER = 2;

// How long silence before we consider the WS dead
const WS_SILENCE_TIMEOUT_MS = 2 * 60 * 1000;
const WS_HEALTH_CHECK_INTERVAL_MS = 30_000;

export interface GraduationEvent {
  mint: string;
  bondingCurveAddress: string;
  signature: string;
  slot: number;
  timestamp: number;
  finalPriceSol?: number;
  finalSolReserves?: number;
  finalTokenReserves?: number;
  virtualSolReserves?: number;
  virtualTokenReserves?: number;
  poolAddress?: string;
  poolBaseVault?: string;
  poolQuoteVault?: string;
  migrationTimestamp?: number;
}

interface BondingCurveState {
  virtualTokenReserves: number;
  virtualSolReserves: number;
  realTokenReserves: number;
  realSolReserves: number;
  isComplete: boolean;
}

export class GraduationListener {
  private connection: Connection;
  private db: Database.Database;
  private poolTracker: PoolTracker;
  private priceCollector: PriceCollector;
  private holderEnrichment: HolderEnrichment;
  private subscriptionId: number | null = null;
  private stopped = false;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastEventTime = Date.now();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private totalLogsReceived = 0;
  private totalCandidatesDetected = 0;
  private totalVerifiedGraduations = 0;
  private totalGraduationsRecorded = 0;
  private totalFalsePositives = 0;
  private totalMintExtractionFails = 0;
  private totalVaultExtractions = 0;
  private totalVaultExtractionFails = 0;
  private lastVaultFailReasons: string[] = [];
  private totalStrategy3Extractions = 0;
  private lastMintFailReasons: string[] = [];
  private reconnecting = false;

  constructor(db: Database.Database) {
    const rpcUrl = process.env.HELIUS_RPC_URL;
    const wsUrl = process.env.HELIUS_WS_URL;

    if (!rpcUrl) {
      throw new Error('HELIUS_RPC_URL is required');
    }
    if (!wsUrl) {
      throw new Error('HELIUS_WS_URL is required');
    }

    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: wsUrl,
    });
    this.db = db;
    this.poolTracker = new PoolTracker(db, this.connection);
    this.priceCollector = new PriceCollector(db, this.connection);
    this.holderEnrichment = new HolderEnrichment(this.connection);
  }

  getStats() {
    return {
      totalLogsReceived: this.totalLogsReceived,
      totalCandidatesDetected: this.totalCandidatesDetected,
      totalVerifiedGraduations: this.totalVerifiedGraduations,
      totalGraduationsRecorded: this.totalGraduationsRecorded,
      totalFalsePositives: this.totalFalsePositives,
      totalMintExtractionFails: this.totalMintExtractionFails,
      totalStrategy3Extractions: this.totalStrategy3Extractions,
      totalVaultExtractions: this.totalVaultExtractions,
      totalVaultExtractionFails: this.totalVaultExtractionFails,
      lastVaultFailReasons: this.lastVaultFailReasons.slice(-5),
      lastMintFailReasons: this.lastMintFailReasons.slice(-5),
      lastEventSecondsAgo: Math.floor((Date.now() - this.lastEventTime) / 1000),
      wsConnected: this.subscriptionId !== null,
      reconnecting: this.reconnecting,
      poolTracker: this.poolTracker.getStats(),
      directPriceCollector: this.priceCollector.getStats(),
    };
  }

  async start(): Promise<void> {
    logger.info(
      { programId: PUMP_FUN_PROGRAM_STR },
      'Starting graduation listener'
    );

    await this.subscribe();
    await this.poolTracker.start();

    this.healthCheckInterval = setInterval(() => {
      const silentMs = Date.now() - this.lastEventTime;
      const silentSec = Math.floor(silentMs / 1000);

      logger.info(
        {
          silentSeconds: silentSec,
          totalLogs: this.totalLogsReceived,
          candidates: this.totalCandidatesDetected,
          verified: this.totalVerifiedGraduations,
          recorded: this.totalGraduationsRecorded,
          falsePositives: this.totalFalsePositives,
          mintFails: this.totalMintExtractionFails,
          subscriptionId: this.subscriptionId,
        },
        'WS health check'
      );

      if (silentMs > WS_SILENCE_TIMEOUT_MS) {
        logger.warn(
          { silentSeconds: silentSec },
          'WS appears dead (no events received), forcing reconnect'
        );
        this.reconnect();
      }
    }, WS_HEALTH_CHECK_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    await this.unsubscribe();
    this.poolTracker.stop();
    this.priceCollector.stop();
    logger.info('Graduation listener stopped');
  }

  private async subscribe(): Promise<void> {
    try {
      this.subscriptionId = this.connection.onLogs(
        PUMP_FUN_PROGRAM_ID,
        async (logs: Logs, ctx: Context) => {
          this.lastEventTime = Date.now();
          this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
          this.totalLogsReceived++;

          // Log first 10 events and then every 200th
          if (this.totalLogsReceived <= 10 || this.totalLogsReceived % 200 === 0) {
            logger.info(
              {
                signature: logs.signature,
                slot: ctx.slot,
                logCount: logs.logs.length,
                logs: logs.logs,
                totalReceived: this.totalLogsReceived,
              },
              'Raw pump.fun log event'
            );
          }

          try {
            await this.handleLogs(logs, ctx);
          } catch (err) {
            logger.error(
              'Error handling logs for %s: %s',
              logs.signature,
              err instanceof Error ? err.message : String(err)
            );
          }
        },
        'confirmed'
      );

      this.lastEventTime = Date.now();
      logger.info({ subscriptionId: this.subscriptionId }, 'Subscribed to pump.fun logs');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to subscribe to logs: %s', message);
      this.scheduleReconnect();
    }
  }

  private async unsubscribe(): Promise<void> {
    if (this.subscriptionId !== null) {
      try {
        await this.connection.removeOnLogsListener(this.subscriptionId);
      } catch (err) {
        logger.warn(
          'Error removing logs listener: %s',
          err instanceof Error ? err.message : String(err)
        );
      }
      this.subscriptionId = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnecting) return;

    logger.info(
      { delayMs: this.reconnectDelay },
      'Scheduling WebSocket reconnect'
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(
      this.reconnectDelay * RECONNECT_BACKOFF_MULTIPLIER,
      MAX_RECONNECT_DELAY_MS
    );
  }

  private async reconnect(): Promise<void> {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;

    try {
      logger.info('Reconnecting WebSocket...');
      await this.unsubscribe();

      const rpcUrl = process.env.HELIUS_RPC_URL!;
      const wsUrl = process.env.HELIUS_WS_URL!;
      this.connection = new Connection(rpcUrl, {
        commitment: 'confirmed',
        wsEndpoint: wsUrl,
      });

      this.poolTracker.updateConnection(this.connection);
      this.priceCollector.updateConnection(this.connection);
      this.holderEnrichment.updateConnection(this.connection);

      await this.subscribe();
      logger.info('WebSocket reconnected successfully');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Reconnection failed: %s', message);
      this.scheduleReconnect();
    } finally {
      this.reconnecting = false;
    }
  }

  private async handleLogs(logs: Logs, ctx: Context): Promise<void> {
    if (logs.err) return;

    // Anchor programs emit "Program log: Instruction: <Name>" for every instruction.
    // Only the pump.fun migrate instruction signals a real graduation — it atomically
    // drains the bonding curve and creates the PumpSwap pool in one tx.
    // The final buy that sets complete=true has no special log and fires separately;
    // we detect it via the migration tx instead, which is the authoritative event.
    const graduationLog = logs.logs.find(
      (log) => log.includes('Instruction: Migrate')
    );

    if (!graduationLog) return;

    this.totalCandidatesDetected++;

    // Process: extract mint + bonding curve, then VERIFY before recording
    const event = await this.processAndVerifyGraduation(logs.signature, ctx.slot, graduationLog);
    if (!event) return;

    const graduationId = this.saveGraduation(event);
    if (graduationId === null) {
      logger.debug({ signature: event.signature }, 'Duplicate graduation, skipping');
      return;
    }

    this.totalGraduationsRecorded++;

    logger.info(
      {
        graduationId,
        mint: event.mint,
        signature: event.signature,
        finalPriceSol: event.finalPriceSol,
        finalSolReserves: event.finalSolReserves,
        bondingCurve: event.bondingCurveAddress,
        poolAddress: event.poolAddress || 'NOT_FOUND',
      },
      'Graduation verified and recorded'
    );

    // Holder enrichment (fire-and-forget — don't block pool tracking)
    this.holderEnrichment.enrich(event.mint, event.bondingCurveAddress).then((enrichment) => {
      updateGraduationEnrichment(this.db, graduationId, {
        holder_count: enrichment.holderCount,
        top5_wallet_pct: enrichment.top5WalletPct,
        dev_wallet_pct: enrichment.devWalletPct,
        token_age_seconds: enrichment.tokenAgeSeconds,
      });

      insertMomentum(this.db, {
        graduation_id: graduationId,
        open_price_sol: event.finalPriceSol,
        holder_count: enrichment.holderCount,
        top5_wallet_pct: enrichment.top5WalletPct,
        dev_wallet_pct: enrichment.devWalletPct,
        token_age_seconds: enrichment.tokenAgeSeconds,
        total_sol_raised: event.finalSolReserves,
      });
    }).catch((err) => {
      logger.warn(
        'Holder enrichment failed for grad %d: %s',
        graduationId,
        err instanceof Error ? err.message : String(err)
      );
      insertMomentum(this.db, {
        graduation_id: graduationId,
        open_price_sol: event.finalPriceSol,
        total_sol_raised: event.finalSolReserves,
      });
    });

    // Start price observation if we have pool info from the graduation tx.
    // Path 1: Vaults extracted from postTokenBalances → skip pool decode entirely
    // Path 2: Pool address only (vaults empty due to Helius postTokenBalances bug)
    //         → price-collector will decode vaults from pool account on first snapshot
    // Path 3: Nothing found → fallback to pool tracker subscription
    if (event.poolBaseVault && event.poolQuoteVault) {
      const poolAddr = event.poolAddress || `vaults:${event.poolBaseVault.slice(0, 8)}`;
      updateGraduationPool(
        this.db, graduationId, poolAddr, 'pumpswap',
        event.signature, 0, event.migrationTimestamp || event.timestamp
      );

      this.priceCollector.startObservation({
        graduationId,
        mint: event.mint,
        poolAddress: poolAddr,
        poolDex: 'pumpswap',
        bondingCurvePrice: event.finalPriceSol || 0,
        graduationTimestamp: event.timestamp,
        migrationTimestamp: event.migrationTimestamp || event.timestamp,
        baseVault: event.poolBaseVault,
        quoteVault: event.poolQuoteVault,
      });

      logger.info(
        { graduationId, mint: event.mint, pool: poolAddr, baseVault: event.poolBaseVault, quoteVault: event.poolQuoteVault },
        'Direct pool observation started with pre-extracted vaults'
      );
    } else if (event.poolAddress) {
      // Pool address found but no vaults — price-collector will decode from pool account
      updateGraduationPool(
        this.db, graduationId, event.poolAddress, 'pumpswap',
        event.signature, 0, event.migrationTimestamp || event.timestamp
      );

      this.priceCollector.startObservation({
        graduationId,
        mint: event.mint,
        poolAddress: event.poolAddress,
        poolDex: 'pumpswap',
        bondingCurvePrice: event.finalPriceSol || 0,
        graduationTimestamp: event.timestamp,
        migrationTimestamp: event.migrationTimestamp || event.timestamp,
      });

      logger.info(
        { graduationId, mint: event.mint, pool: event.poolAddress },
        'Pool observation started — vaults will be decoded from pool account'
      );
    } else {
      // Fallback: use pool tracker subscription matching
      this.poolTracker.trackGraduation(
        graduationId,
        event.mint,
        event.bondingCurveAddress,
        event.finalPriceSol || 0,
        event.timestamp
      );
    }
  }

  private async processAndVerifyGraduation(
    signature: string,
    slot: number,
    matchedLog: string
  ): Promise<GraduationEvent | null> {
    await globalRpcLimiter.throttlePriority();
    const tx = await this.connection.getParsedTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || !tx.meta || tx.meta.err) return null;

    const timestamp = tx.blockTime || Math.floor(Date.now() / 1000);

    let mint: string | null = null;
    let bondingCurveAddress: string | null = null;

    // Helper: convert account ref to string
    const toStr = (acct: any): string | null => {
      if (typeof acct === 'string') return acct;
      return acct?.toBase58?.() ?? null;
    };

    const WSOL_MINT = 'So11111111111111111111111111111111111111112';

    // Well-known addresses that should NEVER be a mint
    const isWellKnown = (addr: string | null): boolean =>
      !addr ||
      addr === '11111111111111111111111111111111' ||
      addr === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ||
      addr === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ||
      addr === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv' ||
      addr === WSOL_MINT ||
      addr === PUMP_FUN_PROGRAM_STR ||
      addr === (process.env.PUMPSWAP_PROGRAM_ID || 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

    // Strategy 1: Top-level pump.fun instruction accounts
    // migrate layout: [2]=mint. Validate the result isn't a system address.
    for (const instruction of tx.transaction.message.instructions) {
      if (!('programId' in instruction)) continue;
      const progId = typeof instruction.programId === 'string'
        ? instruction.programId : instruction.programId.toBase58();
      if (progId !== PUMP_FUN_PROGRAM_STR) continue;

      if ('accounts' in instruction && Array.isArray(instruction.accounts)) {
        const accts = instruction.accounts;
        if (accts.length < 3) continue;
        const candidate = toStr(accts[2]);
        if (candidate && !isWellKnown(candidate)) {
          mint = candidate;
          break;
        }
      }
    }

    // Strategy 2: Inner instructions (same approach)
    if (!mint && tx.meta.innerInstructions) {
      for (const inner of tx.meta.innerInstructions) {
        for (const ix of inner.instructions) {
          if (!('programId' in ix)) continue;
          const progId = typeof ix.programId === 'string'
            ? ix.programId : ix.programId.toBase58();
          if (progId !== PUMP_FUN_PROGRAM_STR) continue;
          if ('accounts' in ix && Array.isArray(ix.accounts) && ix.accounts.length >= 3) {
            const candidate = toStr(ix.accounts[2]);
            if (candidate && !isWellKnown(candidate)) {
              mint = candidate;
              break;
            }
          }
        }
        if (mint) break;
      }
    }

    // Strategy 3: Extract mint from token balances — most robust fallback.
    if (!mint) {
      const uniqueMints = new Set<string>();
      for (const tb of (tx.meta.preTokenBalances || [])) {
        if (tb.mint && !isWellKnown(tb.mint)) uniqueMints.add(tb.mint);
      }
      for (const tb of (tx.meta.postTokenBalances || [])) {
        if (tb.mint && !isWellKnown(tb.mint)) uniqueMints.add(tb.mint);
      }
      if (uniqueMints.size >= 1) {
        mint = [...uniqueMints][0];
        this.totalStrategy3Extractions++;
        logger.info({ signature, mint, totalMints: uniqueMints.size }, 'Mint extracted via token balance fallback (Strategy 3)');
      } else {
        const reason = `s3_no_mints preTokenBal=${tx.meta.preTokenBalances?.length ?? 0} postTokenBal=${tx.meta.postTokenBalances?.length ?? 0}`;
        this.lastMintFailReasons.push(reason);
        if (this.lastMintFailReasons.length > 20) this.lastMintFailReasons = this.lastMintFailReasons.slice(-20);
      }
    }

    if (!mint) {
      this.totalMintExtractionFails++;

      // Capture diagnostic info about WHY all 3 strategies failed
      const ixSummary = tx.transaction.message.instructions.map((ix: any) => {
        const pid = typeof ix.programId === 'string' ? ix.programId : ix.programId?.toBase58?.() ?? '?';
        const acctLen = Array.isArray(ix.accounts) ? ix.accounts.length : (ix.data ? 'parsed' : 'no-accts');
        return `${pid.slice(0, 8)}:${acctLen}`;
      });
      const reason = `s1s2_no_match(${ixSummary.join(',')})`;
      this.lastMintFailReasons.push(reason);
      if (this.lastMintFailReasons.length > 20) this.lastMintFailReasons = this.lastMintFailReasons.slice(-20);

      if (this.totalMintExtractionFails <= 5 || this.totalMintExtractionFails % 20 === 0) {
        logger.warn(
          {
            signature,
            totalMintFails: this.totalMintExtractionFails,
            matchedLog,
            ixSummary,
            preTokenBalances: tx.meta.preTokenBalances?.length ?? 0,
            logs: tx.meta.logMessages?.slice(0, 10),
          },
          'Could not extract mint from candidate tx (all 3 strategies failed)'
        );
      }
      return null;
    }

    // Derive bonding curve PDA from mint — more reliable than reading accounts[2]
    // from the tx, which gives the system program for some migration wrapper txs.
    bondingCurveAddress = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
      PUMP_FUN_PROGRAM_ID
    )[0].toBase58();

    // Register mint with pool-tracker NOW — before the bonding curve RPC call.
    // This eliminates the race where PumpSwap pool creation fires while we're
    // still waiting for getAccountInfo to complete.
    this.poolTracker.speculativeTrack(mint, bondingCurveAddress ?? '');

    // VERIFICATION: Fetch bonding curve state and confirm this is actually a graduation
    if (!bondingCurveAddress) {
      this.totalFalsePositives++;
      this.poolTracker.cancelSpeculative(mint);
      logger.debug({ signature, mint }, 'No bonding curve address — cannot verify, skipping');
      return null;
    }

    // PRIMARY: Extract bonding curve reserves from tx pre-balances.
    // By the time we fetch the account live, migration has already closed it.
    // The tx pre-balances capture the state just BEFORE migration ran.
    const txCurveState = this.extractBondingCurveFromTx(tx, mint, bondingCurveAddress);

    let curveState: BondingCurveState | null = txCurveState;

    // FALLBACK: Live fetch (only if tx extraction failed — e.g. very old tx re-processed)
    if (!curveState) {
      try {
        curveState = await this.fetchBondingCurveState(bondingCurveAddress);
      } catch (err) {
        logger.warn(
          'Failed to fetch bonding curve %s: %s',
          bondingCurveAddress,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    if (!curveState) {
      // Curve account might already be closed after graduation — treat as likely valid
      logger.info(
        { signature, mint, bondingCurve: bondingCurveAddress },
        'Bonding curve account not found (likely closed post-graduation), accepting'
      );
    } else if (!curveState.isComplete) {
      // Check reserve thresholds as additional verification
      const reservesLookGraduated =
        curveState.realSolReserves >= MIN_SOL_RESERVES_FOR_GRADUATION ||
        curveState.realTokenReserves <= MAX_TOKEN_RESERVES_FOR_GRADUATION;

      if (!reservesLookGraduated) {
        this.totalFalsePositives++;
        this.poolTracker.cancelSpeculative(mint);
        logger.info(
          {
            signature,
            mint,
            isComplete: curveState.isComplete,
            realSolReserves: curveState.realSolReserves,
            realTokenReserves: curveState.realTokenReserves,
            matchedLog,
          },
          'False positive: bonding curve not graduated'
        );
        return null;
      }
    }

    this.totalVerifiedGraduations++;

    // Compute final price from virtual reserves
    let finalPriceSol: number | undefined;
    if (curveState && curveState.virtualTokenReserves > 0) {
      finalPriceSol = curveState.virtualSolReserves / curveState.virtualTokenReserves;
    }

    if (txCurveState) {
      logger.info(
        { mint, realSolReserves: txCurveState.realSolReserves, virtualSolReserves: txCurveState.virtualSolReserves, finalPriceSol },
        'Bonding curve price extracted from tx pre-balances'
      );
    }

    // Extract pool address and vault addresses from the graduation tx.
    const accountKeys = GraduationListener.buildFullAccountKeys(tx);
    let poolAddress: string | undefined;
    let poolBaseVault: string | undefined;
    let poolQuoteVault: string | undefined;

    const PUMPSWAP_PROGRAM = process.env.PUMPSWAP_PROGRAM_ID || 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

    // --- POOL ADDRESS DETECTION ---
    // Strategy A: Find PumpSwap CPI in inner instructions.
    // The migration tx CPIs into PumpSwap create_pool. The pool PDA is the first account.
    // PumpSwap create_pool layout:
    //   [0] pool, [1] creator, [2] base_mint, [3] quote_mint, [4] lp_mint,
    //   [5] pool_base_token_account (base vault), [6] pool_quote_token_account (quote vault), ...
    if (tx.meta.innerInstructions) {
      for (const inner of tx.meta.innerInstructions) {
        for (const ix of inner.instructions) {
          if (!('programId' in ix)) continue;
          const progId = typeof ix.programId === 'string'
            ? ix.programId : ix.programId.toBase58();
          if (progId !== PUMPSWAP_PROGRAM) continue;

          if ('accounts' in ix && Array.isArray(ix.accounts) && ix.accounts.length >= 7) {
            const toStr = (acct: any): string | null => {
              if (typeof acct === 'string') return acct;
              return acct?.toBase58?.() ?? null;
            };
            poolAddress = toStr(ix.accounts[0]) || undefined;
            poolBaseVault = toStr(ix.accounts[5]) || undefined;
            poolQuoteVault = toStr(ix.accounts[6]) || undefined;

            logger.info(
              { mint: mint.slice(0, 8), poolAddress, baseVault: poolBaseVault, quoteVault: poolQuoteVault,
                pumpswapAcctCount: ix.accounts.length, signature },
              'Pool + vaults extracted from PumpSwap CPI inner instruction'
            );
            break;
          }
        }
        if (poolAddress) break;
      }
    }

    // Strategy B (fallback): Find pool from newly-created accounts if CPI extraction failed
    if (!poolAddress && tx.meta.preBalances && tx.meta.postBalances) {
      const knownNonPoolAddrs = new Set([
        mint, bondingCurveAddress, WSOL_MINT,
        '11111111111111111111111111111111',
        PUMP_FUN_PROGRAM_STR,
        PUMPSWAP_PROGRAM,
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv',
        'SysvarRent111111111111111111111111111111111',
        'ComputeBudget111111111111111111111111111111',
      ]);

      // Pick the newly-created account with the LARGEST lamport balance (pool > token accts)
      let bestLamports = 0;
      const newlyCreated: Array<{ addr: string; lamports: number }> = [];

      for (let i = 0; i < accountKeys.length; i++) {
        const pre = tx.meta.preBalances[i] || 0;
        const post = tx.meta.postBalances[i] || 0;
        if (pre === 0 && post > 0 && !knownNonPoolAddrs.has(accountKeys[i])) {
          newlyCreated.push({ addr: accountKeys[i].slice(0, 12), lamports: post });
          if (post > bestLamports) {
            bestLamports = post;
            poolAddress = accountKeys[i];
          }
        }
      }

      if (poolAddress) {
        logger.info(
          { mint: mint.slice(0, 8), poolAddress, lamports: bestLamports, candidates: newlyCreated, signature },
          'Pool address from newly-created accounts (fallback B)'
        );
      }
    }

    // --- VAULT EXTRACTION FROM postTokenBalances (works when Helius provides them) ---
    if (!poolBaseVault && !poolQuoteVault && mint && tx.meta.postTokenBalances && tx.meta.postTokenBalances.length > 0) {
      let bestBaseBal = 0;
      let bestQuoteBal = 0;

      for (const tb of tx.meta.postTokenBalances) {
        const addr = accountKeys[tb.accountIndex];
        if (!addr) continue;
        const amt = parseInt(tb.uiTokenAmount?.amount || '0', 10);

        if (tb.mint === mint && amt > 0 && amt > bestBaseBal) {
          bestBaseBal = amt;
          poolBaseVault = addr;
        } else if (tb.mint === WSOL_MINT && amt > 0 && amt > bestQuoteBal) {
          bestQuoteBal = amt;
          poolQuoteVault = addr;
        }
      }
    }

    // Log extraction results
    if (poolAddress || (poolBaseVault && poolQuoteVault)) {
      this.totalVaultExtractions++;
    } else {
      this.totalVaultExtractionFails++;
      const innerIxSummary = (tx.meta.innerInstructions || []).flatMap((inner: any) =>
        inner.instructions.map((ix: any) => {
          const pid = typeof ix.programId === 'string' ? ix.programId : ix.programId?.toBase58?.() ?? '?';
          const acctLen = Array.isArray(ix.accounts) ? ix.accounts.length : ('parsed' in ix ? 'parsed' : 0);
          return `${pid.slice(0, 8)}:${acctLen}`;
        })
      ).slice(0, 15);
      const reason = `no_pool mint=${mint.slice(0, 8)} innerIx=[${innerIxSummary.join(',')}]`;
      this.lastVaultFailReasons.push(reason);
      if (this.lastVaultFailReasons.length > 20) this.lastVaultFailReasons = this.lastVaultFailReasons.slice(-20);
      logger.info({ mint, signature, reason }, 'Pool extraction failed');
    }

    return {
      mint,
      bondingCurveAddress,
      signature,
      slot,
      timestamp,
      finalPriceSol,
      finalSolReserves: curveState?.realSolReserves,
      finalTokenReserves: curveState?.realTokenReserves,
      virtualSolReserves: curveState?.virtualSolReserves,
      virtualTokenReserves: curveState?.virtualTokenReserves,
      poolAddress,
      poolBaseVault,
      poolQuoteVault,
      migrationTimestamp: timestamp,
    };
  }

  /**
   * Build the full account key array for a tx including ALT-resolved accounts.
   * For v0 transactions, compiled instruction indices span:
   *   [...static keys, ...ALT writable, ...ALT readonly]
   * This is also the array that tx.meta.preBalances is parallel to.
   */
  private static buildFullAccountKeys(tx: any): string[] {
    const toStr = (k: any): string => {
      if (typeof k === 'string') return k;
      if (k?.pubkey) return typeof k.pubkey === 'string' ? k.pubkey : k.pubkey.toBase58?.() ?? '';
      return k?.toBase58?.() ?? '';
    };
    const static_ = (tx.transaction.message.accountKeys as any[]).map(toStr);
    const loaded = tx.meta?.loadedAddresses;
    if (!loaded) return static_;
    const writable = (loaded.writable as any[] | undefined ?? []).map(toStr);
    const readonly = (loaded.readonly as any[] | undefined ?? []).map(toStr);
    return [...static_, ...writable, ...readonly];
  }

  /**
   * Extract bonding curve state from the graduation transaction's pre-balances.
   * By the time we call getAccountInfo the migration has already closed the account,
   * so we read the reserves from what they were just before the tx ran.
   *
   * - realSolReserves  → tx.meta.preBalances[bondingCurveIndex] (in lamports)
   * - realTokenReserves → tx.meta.preTokenBalances entry for the bonding curve + token mint
   * - virtualSolReserves = realSol + 30 SOL
   * - virtualTokenReserves = realToken + 279_900_191 tokens
   * - isComplete = true (we wouldn't be here otherwise)
   */
  private extractBondingCurveFromTx(
    tx: Awaited<ReturnType<Connection['getParsedTransaction']>>,
    mint: string,
    bondingCurveAddress: string
  ): BondingCurveState | null {
    if (!tx || !tx.meta) return null;

    // Build full account key list including ALT-resolved accounts.
    // tx.meta.preBalances is parallel to this full list.
    const accountKeys = GraduationListener.buildFullAccountKeys(tx);

    const bcIndex = accountKeys.findIndex((k) => k === bondingCurveAddress);
    if (bcIndex === -1) {
      logger.info(
        { mint, bondingCurveAddress, staticKeys: tx.transaction.message.accountKeys.length, fullKeys: accountKeys.length },
        'Bonding curve not in tx account keys (after ALT expansion) — cannot extract from pre-balances'
      );
      return null;
    }

    // realSolReserves: lamports held by the bonding curve before migration
    const preBalanceLamports: number | undefined = tx.meta.preBalances?.[bcIndex];
    if (preBalanceLamports === undefined || preBalanceLamports === 0) {
      logger.info({ mint, bcIndex, preBalanceLamports, fullKeys: accountKeys.length }, 'Pre-balance missing or zero for bonding curve');
      return null;
    }

    // realTokenReserves: token balance held by the bonding curve's associated token account
    // preTokenBalances entries: { accountIndex, mint, uiTokenAmount }
    const preTokenEntry = tx.meta.preTokenBalances?.find(
      (tb: any) => tb.mint === mint && accountKeys[tb.accountIndex] !== undefined
    );

    let realTokenRaw = 0;
    if (preTokenEntry?.uiTokenAmount?.amount) {
      realTokenRaw = parseInt(preTokenEntry.uiTokenAmount.amount, 10) || 0;
    }

    const realSolLamports = preBalanceLamports;
    const virtualSolLamports = realSolLamports + PUMP_VIRTUAL_SOL_OFFSET_LAMPORTS;
    const virtualTokenRaw = realTokenRaw + PUMP_VIRTUAL_TOKEN_OFFSET_RAW;

    const realSolReserves = realSolLamports / 1_000_000_000;
    const virtualSolReserves = virtualSolLamports / 1_000_000_000;
    const realTokenReserves = realTokenRaw / 1_000_000;
    const virtualTokenReserves = virtualTokenRaw / 1_000_000;

    return {
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves,
      isComplete: true,
    };
  }

  private async fetchBondingCurveState(address: string): Promise<BondingCurveState | null> {
    const pubkey = new PublicKey(address);
    await globalRpcLimiter.throttlePriority();
    const accountInfo: AccountInfo<Buffer> | null =
      await this.connection.getAccountInfo(pubkey);

    if (!accountInfo || !accountInfo.data) return null;

    const data = accountInfo.data;
    if (data.length < 49) return null;

    const virtualTokenReserves = new BN(
      data.subarray(
        BONDING_CURVE_LAYOUT.VIRTUAL_TOKEN_RESERVES,
        BONDING_CURVE_LAYOUT.VIRTUAL_TOKEN_RESERVES + 8
      ),
      'le'
    );
    const virtualSolReserves = new BN(
      data.subarray(
        BONDING_CURVE_LAYOUT.VIRTUAL_SOL_RESERVES,
        BONDING_CURVE_LAYOUT.VIRTUAL_SOL_RESERVES + 8
      ),
      'le'
    );
    const realTokenReserves = new BN(
      data.subarray(
        BONDING_CURVE_LAYOUT.REAL_TOKEN_RESERVES,
        BONDING_CURVE_LAYOUT.REAL_TOKEN_RESERVES + 8
      ),
      'le'
    );
    const realSolReserves = new BN(
      data.subarray(
        BONDING_CURVE_LAYOUT.REAL_SOL_RESERVES,
        BONDING_CURVE_LAYOUT.REAL_SOL_RESERVES + 8
      ),
      'le'
    );

    // The `complete` field is a bool at offset 48
    const isComplete = data[BONDING_CURVE_LAYOUT.COMPLETE] === 1;

    return {
      virtualTokenReserves: bnToNumber(virtualTokenReserves, TOKEN_DECIMAL_FACTOR),
      virtualSolReserves: bnToNumber(virtualSolReserves, LAMPORTS_PER_SOL),
      realTokenReserves: bnToNumber(realTokenReserves, TOKEN_DECIMAL_FACTOR),
      realSolReserves: bnToNumber(realSolReserves, LAMPORTS_PER_SOL),
      isComplete,
    };
  }

  private saveGraduation(event: GraduationEvent): number | null {
    return insertGraduation(this.db, {
      mint: event.mint,
      signature: event.signature,
      slot: event.slot,
      timestamp: event.timestamp,
      bonding_curve_address: event.bondingCurveAddress,
      final_price_sol: event.finalPriceSol,
      final_sol_reserves: event.finalSolReserves,
      final_token_reserves: event.finalTokenReserves,
      virtual_sol_reserves: event.virtualSolReserves,
      virtual_token_reserves: event.virtualTokenReserves,
    });
  }
}

/** Safely convert a large BN to a JS number by dividing by a BN divisor. */
function bnToNumber(value: BN, divisor: BN): number {
  const whole = value.div(divisor);
  const remainder = value.mod(divisor);
  return whole.toNumber() + remainder.toNumber() / divisor.toNumber();
}
