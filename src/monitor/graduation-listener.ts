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
import { insertGraduation } from '../db/queries';
import { PoolTracker } from './pool-tracker';
import { globalRpcLimiter } from '../utils/rpc-limiter';

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
  }

  getStats() {
    return {
      totalLogsReceived: this.totalLogsReceived,
      totalCandidatesDetected: this.totalCandidatesDetected,
      totalVerifiedGraduations: this.totalVerifiedGraduations,
      totalGraduationsRecorded: this.totalGraduationsRecorded,
      totalFalsePositives: this.totalFalsePositives,
      totalMintExtractionFails: this.totalMintExtractionFails,
      lastEventSecondsAgo: Math.floor((Date.now() - this.lastEventTime) / 1000),
      wsConnected: this.subscriptionId !== null,
      reconnecting: this.reconnecting,
      poolTracker: this.poolTracker.getStats(),
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

    // Broad match for graduation/completion candidates
    const graduationLog = logs.logs.find(
      (log) =>
        log.includes('Complete') ||
        log.includes('complete') ||
        log.includes('Migrate') ||
        log.includes('migrate') ||
        log.includes('graduation')
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
        finalTokenReserves: event.finalTokenReserves,
        bondingCurve: event.bondingCurveAddress,
      },
      'Graduation verified and recorded'
    );

    this.poolTracker.trackGraduation(
      graduationId,
      event.mint,
      event.bondingCurveAddress,
      event.finalPriceSol || 0,
      event.timestamp
    );
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

    // Strategy 1: Top-level pump.fun instruction accounts
    for (const instruction of tx.transaction.message.instructions) {
      if (!('programId' in instruction)) continue;

      const progId = typeof instruction.programId === 'string'
        ? instruction.programId
        : instruction.programId.toBase58();

      if (progId !== PUMP_FUN_PROGRAM_STR) continue;

      if ('accounts' in instruction && Array.isArray(instruction.accounts)) {
        const accts = instruction.accounts;
        if (accts.length >= 3) {
          const acct1 = accts[1];
          const acct2 = accts[2];
          mint = typeof acct1 === 'string' ? acct1 : acct1?.toBase58?.() ?? null;
          bondingCurveAddress = typeof acct2 === 'string' ? acct2 : acct2?.toBase58?.() ?? null;
        }
        break;
      }
    }

    // Strategy 2: CPI inner instructions
    if (!mint && tx.meta.innerInstructions) {
      for (const inner of tx.meta.innerInstructions) {
        for (const ix of inner.instructions) {
          if (!('programId' in ix)) continue;
          const progId = typeof ix.programId === 'string'
            ? ix.programId
            : ix.programId.toBase58();
          if (progId !== PUMP_FUN_PROGRAM_STR) continue;

          if ('accounts' in ix && Array.isArray(ix.accounts)) {
            const accts = ix.accounts;
            if (accts.length >= 3) {
              const acct1 = accts[1];
              const acct2 = accts[2];
              mint = typeof acct1 === 'string' ? acct1 : acct1?.toBase58?.() ?? null;
              bondingCurveAddress = typeof acct2 === 'string' ? acct2 : acct2?.toBase58?.() ?? null;
            }
            break;
          }
        }
        if (mint) break;
      }
    }

    if (!mint) {
      this.totalMintExtractionFails++;
      // Only log occasionally to avoid spam
      if (this.totalMintExtractionFails <= 5 || this.totalMintExtractionFails % 20 === 0) {
        logger.warn(
          {
            signature,
            totalMintFails: this.totalMintExtractionFails,
            matchedLog,
            logs: tx.meta.logMessages?.slice(0, 10),
          },
          'Could not extract mint from candidate tx'
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
      logger.debug(
        { mint, realSolReserves: txCurveState.realSolReserves, finalPriceSol },
        'Bonding curve price extracted from tx pre-balances'
      );
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
    };
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

    // Build an account-key index. getParsedTransaction returns account keys as
    // ParsedMessageAccount objects with a .pubkey property.
    const accountKeys: string[] = tx.transaction.message.accountKeys.map((k: any) => {
      if (typeof k === 'string') return k;
      if (k?.pubkey) return typeof k.pubkey === 'string' ? k.pubkey : k.pubkey.toBase58();
      return k?.toBase58?.() ?? '';
    });

    const bcIndex = accountKeys.findIndex((k) => k === bondingCurveAddress);
    if (bcIndex === -1) {
      logger.debug({ mint, bondingCurveAddress }, 'Bonding curve not in tx account keys — cannot extract from pre-balances');
      return null;
    }

    // realSolReserves: lamports held by the bonding curve before migration
    const preBalanceLamports: number | undefined = tx.meta.preBalances?.[bcIndex];
    if (preBalanceLamports === undefined || preBalanceLamports === 0) {
      logger.debug({ mint, bcIndex, preBalanceLamports }, 'Pre-balance missing or zero for bonding curve');
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
