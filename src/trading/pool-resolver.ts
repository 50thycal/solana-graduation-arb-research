/**
 * On-demand PumpSwap pool PDA resolver for live entries.
 *
 * Background — when the graduation-listener parses a migrate tx but can't
 * extract the real PumpSwap pool PDA (e.g. accounts list shape we don't yet
 * decode), it stores a synthetic placeholder of the form `vaults:<base8>` in
 * `graduations.new_pool_address`. The vault accounts are still saved
 * separately on the row, so vault-based price reads (shadow / paper)
 * continue to work. But the live executor needs a real base58 pool address
 * to build the swap instruction, and `new PublicKey("vaults:abc")` throws.
 *
 * Pre-resolver, the trade-evaluator skipped these rows with
 * `safety:invalid_pool_address`. That was a correct guard against the
 * crash, but on the current bot it rejects ~100% of live entries because
 * every recent migrate tx falls into the synthetic-placeholder path.
 *
 * Resolution strategy — read the SPL Token account at `baseVault` and pull
 * its `owner` field. SPL Token accounts are always owned by the program
 * that holds them; for a PumpSwap pool, that's the pool PDA itself. One
 * RPC call gets us the real pool address. We cache per-mint in-process and
 * patch the graduations table so subsequent evaluations skip the RPC.
 *
 * Diagnostics live on `getPoolResolverMetrics()` for trading.json /
 * diagnose.json surfaces.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import type Database from 'better-sqlite3';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('pool-resolver');

// SPL Token account layout: mint (32) | owner (32) | amount (8) | ...
const SPL_TOKEN_OWNER_OFFSET = 32;

const PUMPSWAP_PROGRAM_ID_STR =
  process.env.PUMPSWAP_PROGRAM_ID || 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

export interface PoolResolverMetrics {
  attempts: number;
  hits_cache: number;
  hits_rpc: number;
  fail_synthetic_no_vault: number;
  fail_rpc: number;
  fail_account_too_short: number;
  fail_zero_owner: number;
  cache_size: number;
  last_resolved_pool: string | null;
  last_resolved_at: number | null;
  last_failure_reason: string | null;
  last_failure_at: number | null;
}

const metrics: PoolResolverMetrics = {
  attempts: 0,
  hits_cache: 0,
  hits_rpc: 0,
  fail_synthetic_no_vault: 0,
  fail_rpc: 0,
  fail_account_too_short: 0,
  fail_zero_owner: 0,
  cache_size: 0,
  last_resolved_pool: null,
  last_resolved_at: null,
  last_failure_reason: null,
  last_failure_at: null,
};

export function getPoolResolverMetrics(): PoolResolverMetrics {
  return { ...metrics, cache_size: cache.size };
}

const cache = new Map<string, string>();

export function clearPoolResolverCache(): void {
  cache.clear();
}

function recordFailure(reason: string): void {
  metrics.last_failure_reason = reason;
  metrics.last_failure_at = Math.floor(Date.now() / 1000);
}

/**
 * Resolve the real PumpSwap pool PDA when the stored pool address is a
 * synthetic `vaults:xxx` placeholder. Returns null if resolution fails.
 *
 * Caller is expected to have already validated that `baseVault` is a real
 * base58 address. One RPC call per cache miss; subsequent calls for the
 * same mint hit the in-process cache.
 *
 * When `db` + `graduationId` are provided, the resolved address is written
 * back to `graduations.new_pool_address` so this resolver doesn't have to
 * run again on the next evaluation for the same row. Write-back only
 * replaces synthetic placeholders to avoid clobbering a future fix that
 * might write the real PDA in the listener path.
 */
export async function resolvePoolFromVault(args: {
  connection: Connection;
  mint: string;
  baseVault: string;
  graduationId?: number;
  db?: Database.Database;
}): Promise<string | null> {
  metrics.attempts++;

  const cached = cache.get(args.mint);
  if (cached) {
    metrics.hits_cache++;
    return cached;
  }

  if (!args.baseVault) {
    metrics.fail_synthetic_no_vault++;
    recordFailure('no_baseVault');
    logger.warn(
      { mint: args.mint, graduationId: args.graduationId },
      'Pool resolve failed — no baseVault on observation context (cannot derive pool owner)'
    );
    return null;
  }

  let info;
  try {
    info = await args.connection.getAccountInfo(new PublicKey(args.baseVault), 'confirmed');
  } catch (err) {
    metrics.fail_rpc++;
    const msg = err instanceof Error ? err.message : String(err);
    recordFailure(`rpc_error:${msg.slice(0, 80)}`);
    logger.warn(
      { mint: args.mint, baseVault: args.baseVault, graduationId: args.graduationId, err: msg },
      'Pool resolve failed — RPC error fetching baseVault'
    );
    return null;
  }

  if (!info) {
    metrics.fail_rpc++;
    recordFailure('vault_account_not_found');
    logger.warn(
      { mint: args.mint, baseVault: args.baseVault, graduationId: args.graduationId },
      'Pool resolve failed — baseVault account not found on RPC'
    );
    return null;
  }

  if (info.data.length < SPL_TOKEN_OWNER_OFFSET + 32) {
    metrics.fail_account_too_short++;
    recordFailure(`account_too_short:${info.data.length}`);
    logger.warn(
      { mint: args.mint, baseVault: args.baseVault, dataLen: info.data.length, graduationId: args.graduationId },
      'Pool resolve failed — baseVault account data is shorter than SPL Token layout (corrupt or not a token account)'
    );
    return null;
  }

  const ownerBytes = info.data.subarray(SPL_TOKEN_OWNER_OFFSET, SPL_TOKEN_OWNER_OFFSET + 32);
  const ownerPk = new PublicKey(ownerBytes);
  if (ownerPk.equals(PublicKey.default)) {
    metrics.fail_zero_owner++;
    recordFailure('zero_owner');
    logger.warn(
      { mint: args.mint, baseVault: args.baseVault, graduationId: args.graduationId },
      'Pool resolve failed — baseVault owner is the zero key (account uninitialized?)'
    );
    return null;
  }
  const poolPda = ownerPk.toBase58();

  cache.set(args.mint, poolPda);
  metrics.hits_rpc++;
  metrics.last_resolved_pool = poolPda;
  metrics.last_resolved_at = Math.floor(Date.now() / 1000);

  if (args.db && args.graduationId != null) {
    try {
      const result = args.db
        .prepare(
          `UPDATE graduations
             SET new_pool_address = ?
           WHERE id = ?
             AND (new_pool_address IS NULL OR new_pool_address LIKE 'vaults:%')`
        )
        .run(poolPda, args.graduationId);
      if (result.changes > 0) {
        logger.info(
          {
            graduationId: args.graduationId,
            mint: args.mint,
            poolPda,
            baseVault: args.baseVault,
            pumpswapProgram: PUMPSWAP_PROGRAM_ID_STR,
          },
          'Pool address resolved from baseVault.owner and patched into graduations table'
        );
      } else {
        logger.info(
          { graduationId: args.graduationId, mint: args.mint, poolPda },
          'Pool address resolved (cache populated); graduations row already has a non-synthetic address — no write-back'
        );
      }
    } catch (err) {
      logger.warn(
        {
          graduationId: args.graduationId,
          mint: args.mint,
          err: err instanceof Error ? err.message : String(err),
        },
        'Pool resolve write-back to graduations table failed (cache still populated)'
      );
    }
  } else {
    logger.info(
      { mint: args.mint, poolPda, baseVault: args.baseVault },
      'Pool address resolved from baseVault.owner (no DB write-back requested)'
    );
  }

  return poolPda;
}
