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

const logger = pino({ name: 'graduation-listener' });

// pump.fun program ID
const PUMP_FUN_PROGRAM_ID = new PublicKey(
  process.env.PUMP_FUN_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
);

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

// Reconnection settings
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const RECONNECT_BACKOFF_MULTIPLIER = 2;

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

  async start(): Promise<void> {
    logger.info(
      { programId: PUMP_FUN_PROGRAM_ID.toBase58() },
      'Starting graduation listener'
    );

    await this.subscribe();

    // Periodically check if the WebSocket is still alive
    // If no events received in 5 minutes, force reconnect
    this.healthCheckInterval = setInterval(() => {
      const silentMs = Date.now() - this.lastEventTime;
      if (silentMs > 5 * 60 * 1000) {
        logger.warn(
          { silentSeconds: Math.floor(silentMs / 1000) },
          'No events received recently, forcing reconnect'
        );
        this.reconnect();
      }
    }, 60_000);
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
          this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS; // Reset backoff on success
          try {
            await this.handleLogs(logs, ctx);
          } catch (err) {
            logger.error({ err, signature: logs.signature }, 'Error handling logs');
          }
        },
        'confirmed'
      );

      logger.info({ subscriptionId: this.subscriptionId }, 'Subscribed to pump.fun logs');
    } catch (err) {
      logger.error({ err }, 'Failed to subscribe to logs');
      this.scheduleReconnect();
    }
  }

  private async unsubscribe(): Promise<void> {
    if (this.subscriptionId !== null) {
      try {
        await this.connection.removeOnLogsListener(this.subscriptionId);
      } catch (err) {
        logger.warn({ err }, 'Error removing logs listener');
      }
      this.subscriptionId = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;

    logger.info(
      { delayMs: this.reconnectDelay },
      'Scheduling WebSocket reconnect'
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(
      this.reconnectDelay * RECONNECT_BACKOFF_MULTIPLIER,
      MAX_RECONNECT_DELAY_MS
    );
  }

  private async reconnect(): Promise<void> {
    if (this.stopped) return;

    logger.info('Reconnecting WebSocket...');
    await this.unsubscribe();

    // Create a fresh connection to get a new WebSocket
    const rpcUrl = process.env.HELIUS_RPC_URL!;
    const wsUrl = process.env.HELIUS_WS_URL!;
    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: wsUrl,
    });

    await this.subscribe();
  }

  private async handleLogs(logs: Logs, ctx: Context): Promise<void> {
    if (logs.err) return;

    // Look for graduation-related log messages
    const isGraduation = logs.logs.some(
      (log) =>
        log.includes('CompleteEvent') ||
        log.includes('Program log: complete') ||
        log.includes('Program log: Instruction: Complete')
    );

    if (!isGraduation) return;

    logger.info(
      { signature: logs.signature, slot: ctx.slot },
      'Potential graduation event detected'
    );

    const event = await this.processGraduation(logs.signature, ctx.slot);
    if (event) {
      const graduationId = this.saveGraduation(event);
      if (graduationId === null) {
        // Duplicate — already recorded
        logger.debug({ signature: event.signature }, 'Duplicate graduation event, skipping');
        return;
      }

      logger.info(
        {
          graduationId,
          mint: event.mint,
          signature: event.signature,
          finalPriceSol: event.finalPriceSol,
        },
        'Graduation recorded'
      );

      // Start tracking for the new pool
      this.poolTracker.trackGraduation(graduationId, event.mint, event.timestamp);
    }
  }

  private async processGraduation(
    signature: string,
    slot: number
  ): Promise<GraduationEvent | null> {
    // Fetch the full transaction to decode accounts
    const tx = await this.connection.getParsedTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || !tx.meta || tx.meta.err) return null;

    const timestamp = tx.blockTime || Math.floor(Date.now() / 1000);

    // Find the pump.fun instruction to extract mint and bonding curve
    let mint: string | null = null;
    let bondingCurveAddress: string | null = null;

    // Try to extract from log messages first
    for (const log of tx.meta.logMessages || []) {
      const mintMatch = log.match(/mint[:\s]+([A-Za-z0-9]{32,44})/i);
      if (mintMatch) {
        mint = mintMatch[1];
      }
    }

    // Fallback: extract from pump.fun instruction accounts
    // pump.fun Complete instruction account layout: [0] = user, [1] = mint, [2] = bonding curve, ...
    if (!mint) {
      for (const instruction of tx.transaction.message.instructions) {
        if ('programId' in instruction) {
          const progId =
            typeof instruction.programId === 'string'
              ? instruction.programId
              : instruction.programId.toBase58();
          if (progId === PUMP_FUN_PROGRAM_ID.toBase58() && 'accounts' in instruction) {
            const accounts = (instruction as any).accounts as PublicKey[];
            if (accounts && accounts.length >= 3) {
              mint = accounts[1]?.toBase58() || null;
              bondingCurveAddress = accounts[2]?.toBase58() || null;
            }
          }
        }
      }
    }

    if (!mint) {
      logger.warn({ signature }, 'Could not extract mint from graduation tx');
      return null;
    }

    // Fetch bonding curve state if we have the address
    let finalPriceSol: number | undefined;
    let finalSolReserves: number | undefined;
    let finalTokenReserves: number | undefined;
    let virtualSolReserves: number | undefined;
    let virtualTokenReserves: number | undefined;

    if (bondingCurveAddress) {
      try {
        const curveState = await this.fetchBondingCurveState(bondingCurveAddress);
        if (curveState) {
          virtualSolReserves = curveState.virtualSolReserves;
          virtualTokenReserves = curveState.virtualTokenReserves;
          finalSolReserves = curveState.realSolReserves;
          finalTokenReserves = curveState.realTokenReserves;
          // Price = virtualSolReserves / virtualTokenReserves
          if (curveState.virtualTokenReserves > 0) {
            finalPriceSol =
              curveState.virtualSolReserves / curveState.virtualTokenReserves;
          }
        }
      } catch (err) {
        logger.warn(
          { err, bondingCurveAddress },
          'Failed to fetch bonding curve state'
        );
      }
    }

    return {
      mint,
      bondingCurveAddress: bondingCurveAddress || '',
      signature,
      slot,
      timestamp,
      finalPriceSol,
      finalSolReserves,
      finalTokenReserves,
      virtualSolReserves,
      virtualTokenReserves,
    };
  }

  private async fetchBondingCurveState(
    address: string
  ): Promise<{
    virtualTokenReserves: number;
    virtualSolReserves: number;
    realTokenReserves: number;
    realSolReserves: number;
  } | null> {
    const pubkey = new PublicKey(address);
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

    // Use BN division to avoid overflow, then convert the quotient to Number
    // For SOL values: divide by 1e9 (lamports). For token values: divide by 1e6 (decimals).
    // Remainder is converted to fractional part for precision.
    return {
      virtualTokenReserves: bnToNumber(virtualTokenReserves, TOKEN_DECIMAL_FACTOR),
      virtualSolReserves: bnToNumber(virtualSolReserves, LAMPORTS_PER_SOL),
      realTokenReserves: bnToNumber(realTokenReserves, TOKEN_DECIMAL_FACTOR),
      realSolReserves: bnToNumber(realSolReserves, LAMPORTS_PER_SOL),
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

/** Safely convert a large BN to a JS number by dividing by a BN divisor.
 *  Returns whole + fractional parts to avoid BN.toNumber() overflow on raw u64 values. */
function bnToNumber(value: BN, divisor: BN): number {
  const whole = value.div(divisor);
  const remainder = value.mod(divisor);
  // whole part is safe (SOL reserves < 2^53 / 1e9, token reserves < 2^53 / 1e6)
  return whole.toNumber() + remainder.toNumber() / divisor.toNumber();
}
