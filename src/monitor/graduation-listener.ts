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

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'graduation-listener' });

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

// PumpSwap AMM program ID (for PDA derivation)
const PUMPSWAP_AMM_PROGRAM_ID = new PublicKey(
  process.env.PUMPSWAP_PROGRAM_ID || 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
);
const WSOL_MINT_PUBKEY = new PublicKey('So11111111111111111111111111111111111111112');

// Pool account layout offsets for vault extraction (matches PriceCollector)
const POOL_BASE_VAULT_OFFSET = 8 + 1 + 2 + 32 + 32 + 32 + 32; // 139
const POOL_QUOTE_VAULT_OFFSET = POOL_BASE_VAULT_OFFSET + 32;   // 171

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
  isPumpSwapMigration?: boolean;
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
  private totalBundlerFalsePositives = 0;
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
      totalBundlerFalsePositives: this.totalBundlerFalsePositives,
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
    this.holderEnrichment.enrich(event.mint, event.bondingCurveAddress, event.timestamp).then((enrichment) => {
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
      // Fetch token_age_seconds independently — it's required for velocity calculation
      // and doesn't depend on holder data. Use a nested promise chain to keep this
      // fire-and-forget without blocking pool tracking.
      this.holderEnrichment.getMintCreationTime(new PublicKey(event.mint))
        .then((creationTime) => {
          const tokenAgeSeconds = (creationTime !== null && event.timestamp)
            ? Math.max(0, event.timestamp - creationTime)
            : undefined;
          insertMomentum(this.db, {
            graduation_id: graduationId,
            open_price_sol: event.finalPriceSol,
            total_sol_raised: event.finalSolReserves,
            token_age_seconds: tokenAgeSeconds,
          });
          if (tokenAgeSeconds !== undefined) {
            logger.info(
              { graduationId, tokenAgeSeconds },
              'token_age_seconds recovered after holder enrichment failure'
            );
          }
        })
        .catch(() => {
          // Age fetch also failed — insert without it
          insertMomentum(this.db, {
            graduation_id: graduationId,
            open_price_sol: event.finalPriceSol,
            total_sol_raised: event.finalSolReserves,
          });
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
      // No pool info extracted inline — fall back to pool tracker subscription.
      // We do NOT call cancelSpeculative here: we cannot reliably distinguish a
      // Raydium migration from a failed extraction (Helius may return pump.fun
      // migrate as ParsedInstruction with no accounts array, or as PartiallyDecoded
      // with fewer accounts than expected for v0 ALT transactions).
      // Pool tracker will time out naturally after 5 min if no PumpSwap pool appears.
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

    // STRATEGY 1 (PRIMARY): Extract mint from token balances.
    // preTokenBalances/postTokenBalances contain RPC-guaranteed accurate mint addresses.
    // Prefer mints in preTokenBalances — the LP mint only appears in postTokenBalances
    // (created during migration), so preTokenBalances isolates the real token mint.
    {
      const preMints = new Set<string>();
      const postOnlyMints = new Set<string>();
      for (const tb of (tx.meta.preTokenBalances || [])) {
        if (tb.mint && !isWellKnown(tb.mint)) preMints.add(tb.mint);
      }
      for (const tb of (tx.meta.postTokenBalances || [])) {
        if (tb.mint && !isWellKnown(tb.mint) && !preMints.has(tb.mint)) {
          postOnlyMints.add(tb.mint);
        }
      }

      // Prefer pre-balance mints (real token), fall back to post-only mints (LP mint edge case)
      if (preMints.size >= 1) {
        mint = [...preMints][0];
        logger.info(
          { signature, mint, preMintCount: preMints.size, postOnlyCount: postOnlyMints.size },
          'Mint extracted from preTokenBalances (Strategy 1 — token balances)'
        );
      } else if (postOnlyMints.size >= 1) {
        mint = [...postOnlyMints][0];
        logger.info(
          { signature, mint, postOnlyCount: postOnlyMints.size },
          'Mint extracted from postTokenBalances only (Strategy 1 — token balances, post-only)'
        );
      } else {
        // DIAGNOSTIC: Log why token balances yielded no mint
        const preCount = tx.meta.preTokenBalances?.length ?? -1;
        const postCount = tx.meta.postTokenBalances?.length ?? -1;
        const allPreMints = (tx.meta.preTokenBalances || []).map((tb: any) => tb.mint?.slice(0, 8) || '?');
        const allPostMints = (tx.meta.postTokenBalances || []).map((tb: any) => tb.mint?.slice(0, 8) || '?');
        logger.info(
          { signature, preCount, postCount,
            preMints: allPreMints.join(',') || 'empty',
            postMints: allPostMints.join(',') || 'empty' },
          'Strategy 1 MISS: no non-well-known mints in token balances'
        );
      }
    }

    // STRATEGY 2 (FALLBACK): Top-level pump.fun instruction accounts
    // migrate layout: [2]=mint. Only used if token balances were empty.
    if (!mint) {
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
            logger.info({ signature, mint }, 'Mint extracted from instruction accounts[2] (Strategy 2 — ix fallback)');
            break;
          }
        }
      }
    }

    // STRATEGY 3 (MINT): Bonding curve correlation — derive mint from account keys.
    // For bundled/MEV txs where token balances are empty, we find the mint by checking
    // which account in the transaction has a matching bonding curve PDA also present.
    // Both mint and its bonding curve PDA (["bonding-curve", mint], PUMP_PROGRAM)
    // are always in a migration transaction's account keys. Pure math, no RPC calls.
    if (!mint) {
      const fullAccountKeys = GraduationListener.buildFullAccountKeys(tx);
      const accountKeySet = new Set(fullAccountKeys);

      for (const key of fullAccountKeys) {
        if (!key || isWellKnown(key)) continue;
        try {
          const candidateMint = new PublicKey(key);
          const [derivedBC] = PublicKey.findProgramAddressSync(
            [Buffer.from('bonding-curve'), candidateMint.toBuffer()],
            PUMP_FUN_PROGRAM_ID
          );
          if (accountKeySet.has(derivedBC.toBase58())) {
            mint = key;
            logger.info(
              { signature, mint, bondingCurve: derivedBC.toBase58(), totalKeys: fullAccountKeys.length },
              'Mint found via bonding curve correlation (Strategy 3 — account key scan)'
            );
            break;
          }
        } catch {
          // Invalid public key, skip
        }
      }
    }

    // STRATEGY 4 (MINT LAST RESORT): Inner instructions — find the largest pump.fun ix.
    // Only used if bonding curve correlation found nothing.
    if (!mint && tx.meta.innerInstructions) {
      const fullAccountKeys = GraduationListener.buildFullAccountKeys(tx);
      let bestCandidate: string | null = null;
      let bestAcctCount = 0;
      let totalPumpIxFound = 0;

      for (const inner of tx.meta.innerInstructions) {
        for (const ix of inner.instructions) {
          let progId: string | null = null;
          let resolvedAccounts: string[] = [];

          if ('programId' in ix) {
            progId = typeof (ix as any).programId === 'string'
              ? (ix as any).programId : (ix as any).programId?.toBase58?.() ?? null;
            if ('accounts' in ix && Array.isArray((ix as any).accounts)) {
              resolvedAccounts = ((ix as any).accounts as any[]).map((a: any) =>
                typeof a === 'string' ? a : a?.toBase58?.() ?? ''
              );
            }
          } else if ('programIdIndex' in ix) {
            const pidIdx = (ix as any).programIdIndex as number;
            progId = fullAccountKeys[pidIdx] ?? null;
            const acctIdxs: number[] = (ix as any).accounts ?? (ix as any).accountKeyIndexes ?? [];
            resolvedAccounts = acctIdxs.map((idx: number) => fullAccountKeys[idx] ?? '');
          }

          if (!progId || progId !== PUMP_FUN_PROGRAM_STR) continue;
          if (resolvedAccounts.length < 3) continue;

          totalPumpIxFound++;
          const candidate = resolvedAccounts[2];

          if (candidate && !isWellKnown(candidate) && resolvedAccounts.length > bestAcctCount) {
            bestCandidate = candidate;
            bestAcctCount = resolvedAccounts.length;
          }
        }
      }

      if (bestCandidate) {
        mint = bestCandidate;
        logger.info(
          { signature, mint, acctCount: bestAcctCount, totalPumpIxFound },
          'Mint extracted from inner instruction (Strategy 4 — inner ix fallback)'
        );
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
      const reason = `all_strategies_failed(${ixSummary.join(',')})`;
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
      // curveState is null when: (a) bonding curve not in tx account keys, or
      // (b) preBalance is 0 (account created in this same tx — bundler/MEV pattern).
      // Real graduations always have ~85 SOL in preBalances — if we can't verify
      // reserves, this is likely a false positive. Reject it.
      this.totalFalsePositives++;
      this.totalBundlerFalsePositives++;
      this.poolTracker.cancelSpeculative(mint);
      logger.info(
        { signature, mint, bondingCurve: bondingCurveAddress },
        'False positive rejected: could not verify bonding curve reserves (likely bundler/MEV tx)'
      );
      return null;
    } else {
      // Always check SOL reserves regardless of isComplete flag.
      // Bundler/MEV txs log "Instruction: Migrate" from wrapper programs but the
      // bonding curve has only 1-13 SOL (real graduations have ~79-85 SOL).
      // extractBondingCurveFromTx sets isComplete=true optimistically, so we
      // can't rely on isComplete alone to filter these out.
      if (curveState.realSolReserves < MIN_SOL_RESERVES_FOR_GRADUATION) {
        this.totalFalsePositives++;
        this.totalBundlerFalsePositives++;
        this.poolTracker.cancelSpeculative(mint);
        logger.info(
          {
            signature,
            mint,
            realSolReserves: curveState.realSolReserves,
            realTokenReserves: curveState.realTokenReserves,
          },
          'False positive rejected: SOL reserves too low for graduation (likely bundler/MEV tx)'
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
    // PRIMARY STRATEGY: Read from the top-level pump.fun migrate instruction.
    // The migrate instruction is always a PartiallyDecodedInstruction with a full accounts array.
    // This is more reliable than parsing the inner PumpSwap CPI, which Helius returns as
    // ParsedInstruction (no accounts array visible).
    //
    // pump.fun migrate instruction account layout (official IDL):
    //   [0]=global  [1]=withdraw_authority  [2]=mint  [3]=bonding_curve
    //   [4]=associated_bonding_curve  [5]=user  [6]=system_program  [7]=token_program
    //   [8]=pump_amm (PumpSwap program ID — detects migration target)
    //   [9]=pool  [10]=pool_authority  [11]=pool_authority_mint_account
    //   [12]=pool_authority_wsol_account  [13]=amm_global_config  [14]=wsol_mint
    //   [15]=lp_mint  [16]=user_pool_token_account
    //   [17]=pool_base_token_account (base vault)
    //   [18]=pool_quote_token_account (quote vault)
    let poolAddress: string | undefined;
    let poolBaseVault: string | undefined;
    let poolQuoteVault: string | undefined;
    let isPumpSwapMigration = false;

    const PUMPSWAP_PROGRAM = process.env.PUMPSWAP_PROGRAM_ID || 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
    const toStrAcct = (a: any): string => typeof a === 'string' ? a : a?.toBase58?.() ?? '';

    for (const ix of tx.transaction.message.instructions) {
      const progId = toStrAcct((ix as any).programId ?? '');
      if (progId !== PUMP_FUN_PROGRAM_STR) continue;

      // Diagnostic: log the format of every top-level pump.fun instruction.
      // This tells us whether Helius returns it as ParsedInstruction (no accounts array)
      // or PartiallyDecodedInstruction (with accounts array).
      const hasParsed = 'parsed' in (ix as any);
      const ixAccounts = (ix as any).accounts;
      const acctArrayLen = Array.isArray(ixAccounts) ? ixAccounts.length : -1;
      logger.info(
        { mint: mint.slice(0, 8), hasParsed, acctArrayLen, signature },
        'DEBUG pump.fun top-level instruction format'
      );

      // Need at least 9 accounts to check accounts[8] (pump_amm program).
      // Use 9 as threshold (not 15) to handle v0 transactions where some accounts
      // may not be present in ix.accounts due to ALT resolution behavior.
      if (acctArrayLen < 9) continue;

      const accts = (ixAccounts as any[]).map(toStrAcct);

      // accounts[8] is pump_amm — equals PumpSwap program ID for PumpSwap migrations.
      // Only skip if it's a KNOWN non-PumpSwap program (not just missing/truncated).
      if (accts[8] !== PUMPSWAP_PROGRAM) {
        logger.info(
          { mint: mint.slice(0, 8), accounts8: accts[8]?.slice(0, 8), acctCount: accts.length, signature },
          'accounts[8] is not PumpSwap — Raydium or other DEX migration, or accounts truncated'
        );
        // Do NOT break — let it fall through to pool-tracker.
        // We can't reliably confirm Raydium vs truncated account list.
        continue;
      }

      isPumpSwapMigration = true;
      poolAddress = accts[9];  // pool PDA (may be undefined if accts.length == 9)

      if (accts.length >= 19) {
        poolBaseVault = accts[17];   // pool_base_token_account
        poolQuoteVault = accts[18];  // pool_quote_token_account
      }

      logger.info(
        { mint: mint.slice(0, 8), poolAddress, baseVault: poolBaseVault, quoteVault: poolQuoteVault,
          acctCount: accts.length, signature },
        'Pool + vaults extracted from pump.fun migrate instruction'
      );
      break;
    }

    // Validate: reject well-known program addresses that are never valid pool addresses
    const isInvalidAddr = (addr: string | undefined): boolean =>
      !addr ||
      addr === '11111111111111111111111111111111' ||
      addr === PUMP_FUN_PROGRAM_STR ||
      addr === PUMPSWAP_PROGRAM ||
      addr === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ||
      addr === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ||
      addr === WSOL_MINT;

    if (isInvalidAddr(poolAddress)) poolAddress = undefined;
    if (isInvalidAddr(poolBaseVault)) poolBaseVault = undefined;
    if (isInvalidAddr(poolQuoteVault)) poolQuoteVault = undefined;

    // FALLBACK: New pump.fun migration format has PumpSwap create_pool as a separate top-level
    // instruction (not a CPI). Extract pool from accounts[0] of the PumpSwap instruction.
    // PumpSwap create_pool layout: [0]=pool, [1]=global_config, [2]=creator, [3]=base_mint,
    //   [4]=quote_mint, [5]=lp_mint, [6]=user_base_token_account, [7]=user_quote_token_account,
    //   [8]=user_pool_token_account, [9]=pool_base_token_account, [10]=pool_quote_token_account
    if (!poolAddress && !isPumpSwapMigration) {
      for (const ix of tx.transaction.message.instructions) {
        const progId = toStrAcct((ix as any).programId ?? '');
        if (progId !== PUMPSWAP_PROGRAM) continue;
        const ixAccounts = (ix as any).accounts;
        if (!Array.isArray(ixAccounts) || ixAccounts.length < 1) continue;
        const accts = (ixAccounts as any[]).map(toStrAcct);
        const candidate = accts[0];  // pool PDA
        if (!isInvalidAddr(candidate)) {
          poolAddress = candidate;
          isPumpSwapMigration = true;
          // Vaults at [9] and [10] if visible
          if (accts.length >= 11) {
            const bv = accts[9];
            const qv = accts[10];
            if (!isInvalidAddr(bv) && !isInvalidAddr(qv)) {
              poolBaseVault = bv;
              poolQuoteVault = qv;
            }
          }
          logger.info(
            { mint: mint.slice(0, 8), poolAddress, acctCount: accts.length, signature },
            'Pool extracted from top-level PumpSwap create_pool instruction (new migration format)'
          );
          break;
        }
      }
    }

    // SUPPLEMENTAL: Fill in missing vaults from postTokenBalances when Helius provides them.
    // NOT gated on isPumpSwapMigration — postTokenBalances always contains vault balances for any
    // PumpSwap pool creation, and buildFullAccountKeys resolves ALT accounts so vault addresses
    // are always available here even when instruction parsing fails due to ALT ordering.
    if ((!poolBaseVault || !poolQuoteVault) && mint &&
        tx.meta.postTokenBalances && tx.meta.postTokenBalances.length > 0) {
      const accountKeys = GraduationListener.buildFullAccountKeys(tx);
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

      // If we found vaults here and hadn't already confirmed PumpSwap, mark it now
      if (poolBaseVault && poolQuoteVault && !isPumpSwapMigration) {
        isPumpSwapMigration = true;
        logger.info(
          { mint: mint.slice(0, 8), baseVault: poolBaseVault, quoteVault: poolQuoteVault, signature },
          'Vault addresses resolved from postTokenBalances (ALT-safe) — PumpSwap migration confirmed'
        );
      }
    }

    // STRATEGY 4: PDA Derivation — deterministically derive pool address from mint.
    // This completely bypasses ALT parsing issues. For canonical pump.fun graduated
    // tokens, the pool PDA is derived from:
    //   Step 1: creator = PDA(["pool-authority", baseMint], PUMP_PROGRAM)
    //   Step 2: pool = PDA(["pool", u16(0), creator, baseMint, WSOL], PUMPSWAP_AMM)
    // Then fetch pool account to decode vault addresses at known offsets.
    if (!poolAddress && !poolBaseVault && !poolQuoteVault && mint) {
      try {
        const baseMintKey = new PublicKey(mint);

        // Step 1: Derive the canonical pool creator (pool-authority under Pump program)
        const [poolAuthority] = PublicKey.findProgramAddressSync(
          [Buffer.from('pool-authority'), baseMintKey.toBuffer()],
          PUMP_FUN_PROGRAM_ID
        );

        // Step 2: Derive pool PDA under PumpSwap AMM (index=0 for canonical graduated pools)
        const indexBuffer = Buffer.alloc(2);
        indexBuffer.writeUInt16LE(0);

        const [derivedPoolKey] = PublicKey.findProgramAddressSync(
          [
            Buffer.from('pool'),
            indexBuffer,
            poolAuthority.toBuffer(),
            baseMintKey.toBuffer(),
            WSOL_MINT_PUBKEY.toBuffer(),
          ],
          PUMPSWAP_AMM_PROGRAM_ID
        );

        const derivedPoolAddr = derivedPoolKey.toBase58();

        // Wait briefly for pool account to be indexed by RPC — the pool is created
        // in the same transaction we're processing, so it may not be queryable yet.
        await new Promise(r => setTimeout(r, 2000));

        // Fetch pool account to verify it exists and decode vault addresses
        await globalRpcLimiter.throttlePriority();
        let poolAccountInfo = await this.connection.getAccountInfo(derivedPoolKey);

        // Retry once after another 2s if not found — RPC indexing can lag
        if (!poolAccountInfo?.data) {
          await new Promise(r => setTimeout(r, 2000));
          await globalRpcLimiter.throttlePriority();
          poolAccountInfo = await this.connection.getAccountInfo(derivedPoolKey);
        }

        if (poolAccountInfo?.data) {
          const rawData = Buffer.isBuffer(poolAccountInfo.data)
            ? poolAccountInfo.data
            : Buffer.from(poolAccountInfo.data as unknown as Uint8Array);

          if (rawData.length >= POOL_QUOTE_VAULT_OFFSET + 32) {
            const baseVaultKey = new PublicKey(rawData.subarray(POOL_BASE_VAULT_OFFSET, POOL_BASE_VAULT_OFFSET + 32));
            const quoteVaultKey = new PublicKey(rawData.subarray(POOL_QUOTE_VAULT_OFFSET, POOL_QUOTE_VAULT_OFFSET + 32));

            if (!baseVaultKey.equals(PublicKey.default) && !quoteVaultKey.equals(PublicKey.default)) {
              poolAddress = derivedPoolAddr;
              poolBaseVault = baseVaultKey.toBase58();
              poolQuoteVault = quoteVaultKey.toBase58();
              isPumpSwapMigration = true;

              logger.info(
                { mint: mint.slice(0, 8), poolAddress, baseVault: poolBaseVault, quoteVault: poolQuoteVault, signature },
                'Pool + vaults resolved via PDA derivation (Strategy 4) — ALT parsing bypassed'
              );
            }
          }
        } else {
          logger.info(
            { mint: mint.slice(0, 8), derivedPool: derivedPoolAddr, signature },
            'Strategy 4: PDA-derived pool account not found on-chain after 2 retries'
          );
        }
      } catch (err) {
        logger.warn(
          { mint: mint.slice(0, 8), err: (err as Error).message, signature },
          'Strategy 4 PDA derivation failed'
        );
      }
    }

    // Track extraction metrics
    if (poolAddress || (poolBaseVault && poolQuoteVault)) {
      this.totalVaultExtractions++;
    } else {
      this.totalVaultExtractionFails++;
      // Log top-level instruction summary to help diagnose format issues
      const topIxSummary = tx.transaction.message.instructions.map((ix: any) => {
        const pid = toStrAcct((ix as any).programId ?? '');
        const hasParsed = 'parsed' in ix ? 'parsed' : '';
        const acctLen = Array.isArray((ix as any).accounts) ? (ix as any).accounts.length : hasParsed || '?';
        return `${pid.slice(0, 16)}:${acctLen}`;  // 16 chars to identify unknown programs
      }).join(',');
      const reason = `no_pool mint=${mint.slice(0, 8)} isPumpSwap=${isPumpSwapMigration} topIx=[${topIxSummary}]`;
      this.lastVaultFailReasons.push(reason);
      if (this.lastVaultFailReasons.length > 20) this.lastVaultFailReasons = this.lastVaultFailReasons.slice(-20);

      // DIAGNOSTIC: Log inner instructions + postTokenBalances to identify pfeeUxB6 structure.
      // Only log first 5 failures to avoid noise — remove once format is understood.
      if (this.totalVaultExtractionFails <= 5) {
        // Inner instructions summary
        const innerSummary = (tx.meta.innerInstructions || []).flatMap((ii: any) =>
          (ii.instructions || []).map((ix: any) => {
            const keys = GraduationListener.buildFullAccountKeys(tx);
            const pid = 'programId' in ix
              ? toStrAcct((ix as any).programId ?? '')
              : (keys['programIdIndex' in ix ? (ix as any).programIdIndex : -1] ?? '?');
            const acctLen = 'programId' in ix
              ? (Array.isArray((ix as any).accounts) ? (ix as any).accounts.length : '?')
              : ((ix as any).accountKeyIndexes?.length ?? '?');
            return `${pid.slice(0, 16)}:${acctLen}`;
          })
        ).join(',');

        // postTokenBalances summary — show ALL mints + amounts
        const ptbSummary = (tx.meta.postTokenBalances || []).map((tb: any) => {
          const keys = GraduationListener.buildFullAccountKeys(tx);
          const addr = keys[tb.accountIndex]?.slice(0, 8) ?? `idx${tb.accountIndex}`;
          const mintShort = (tb.mint as string)?.slice(0, 8) ?? '?';
          const amt = tb.uiTokenAmount?.uiAmountString ?? '0';
          return `${addr}:${mintShort}=${amt}`;
        }).join(', ');

        const loadedAddressCount = (tx.meta?.loadedAddresses?.writable?.length ?? 0)
          + (tx.meta?.loadedAddresses?.readonly?.length ?? 0);

        logger.info(
          { mint: mint.slice(0, 8), signature, loadedAddressCount,
            innerIx: innerSummary || 'none',
            ptb: ptbSummary || 'none' },
          'DIAG vault-fail: inner instructions + postTokenBalances'
        );
      }
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
      isPumpSwapMigration,
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
