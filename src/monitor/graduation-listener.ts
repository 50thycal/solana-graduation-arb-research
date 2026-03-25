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

// CompleteEvent discriminator (first 8 bytes of sha256("event:CompleteEvent"))
const COMPLETE_EVENT_DISCRIMINATOR = Buffer.from([
  0x5f, 0x8d, 0xa1, 0x2e, 0x6d, 0x01, 0xf3, 0x7a,
]);

// Bonding curve account data layout offsets
const BONDING_CURVE_LAYOUT = {
  VIRTUAL_TOKEN_RESERVES: 8,   // u64 at offset 8
  VIRTUAL_SOL_RESERVES: 16,    // u64 at offset 16
  REAL_TOKEN_RESERVES: 24,     // u64 at offset 24
  REAL_SOL_RESERVES: 32,       // u64 at offset 32
  TOKEN_TOTAL_SUPPLY: 40,      // u64 at offset 40
  COMPLETE: 48,                // bool at offset 48
};

const LAMPORTS_PER_SOL = 1_000_000_000;
const TOKEN_DECIMALS = 6;
const TOKEN_DECIMAL_FACTOR = 10 ** TOKEN_DECIMALS;

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
  private wsConnection: Connection;

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
    this.wsConnection = this.connection;
    this.db = db;
    this.poolTracker = new PoolTracker(db, this.connection);
  }

  async start(): Promise<void> {
    logger.info(
      { programId: PUMP_FUN_PROGRAM_ID.toBase58() },
      'Starting graduation listener'
    );

    this.subscriptionId = this.connection.onLogs(
      PUMP_FUN_PROGRAM_ID,
      async (logs: Logs, ctx: Context) => {
        try {
          await this.handleLogs(logs, ctx);
        } catch (err) {
          logger.error({ err, signature: logs.signature }, 'Error handling logs');
        }
      },
      'confirmed'
    );

    logger.info({ subscriptionId: this.subscriptionId }, 'Subscribed to pump.fun logs');
  }

  async stop(): Promise<void> {
    if (this.subscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.subscriptionId);
      this.subscriptionId = null;
      logger.info('Graduation listener stopped');
    }
    this.poolTracker.stop();
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

    try {
      const event = await this.processGraduation(logs.signature, ctx.slot);
      if (event) {
        const graduationId = this.saveGraduation(event);
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
    } catch (err) {
      logger.error({ err, signature: logs.signature }, 'Failed to process graduation');
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

    // Check inner instructions and account keys for the graduation
    const accountKeys = tx.transaction.message.accountKeys.map((k) =>
      typeof k === 'string' ? k : k.pubkey.toBase58()
    );

    // The pump.fun Complete instruction typically has specific account ordering:
    // The mint is usually one of the first few accounts after the program
    // Look through log messages for more specific data
    for (const log of tx.meta.logMessages || []) {
      // Try to extract mint from log messages
      const mintMatch = log.match(/mint[:\s]+([A-Za-z0-9]{32,44})/i);
      if (mintMatch) {
        mint = mintMatch[1];
      }
    }

    // If we couldn't find mint from logs, try to find it from inner instructions
    if (!mint && tx.meta.innerInstructions) {
      for (const inner of tx.meta.innerInstructions) {
        for (const ix of inner.instructions) {
          if ('parsed' in ix && ix.parsed?.type === 'transfer') {
            // Token transfers can help identify the mint
          }
        }
      }
    }

    // Fallback: scan account keys for token mint patterns
    // In pump.fun transactions, the mint is typically the 3rd account
    if (!mint && accountKeys.length > 2) {
      // Heuristic: look for accounts that could be mints
      // The pump.fun Complete instruction account layout:
      // [0] = user, [1] = mint, [2] = bonding curve, ...
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

    return {
      virtualTokenReserves:
        virtualTokenReserves.toNumber() / TOKEN_DECIMAL_FACTOR,
      virtualSolReserves: virtualSolReserves.toNumber() / LAMPORTS_PER_SOL,
      realTokenReserves: realTokenReserves.toNumber() / TOKEN_DECIMAL_FACTOR,
      realSolReserves: realSolReserves.toNumber() / LAMPORTS_PER_SOL,
    };
  }

  private saveGraduation(event: GraduationEvent): number {
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
