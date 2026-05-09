/**
 * Jito bundle submission with RPC fallback.
 *
 * A Jito bundle atomically lands a set of transactions in the same leader
 * slot — crucial on thin PumpSwap pools where a sandwich between buy and
 * the pool is a real risk. We send a single-tx bundle: [our swap tx] and
 * include a tip transfer to a Jito tip account as the last instruction in
 * that same tx (not a separate tx) so the whole thing is one atomic unit.
 *
 * If Jito rejects / times out, we fall back to standard sendRawTransaction
 * via the Helius RPC connection. That path is unprotected from sandwiching
 * but is better than no-submit.
 */

import { Connection, PublicKey, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import axios, { AxiosError } from 'axios';
import { JITO_BLOCK_ENGINE_URL } from './config';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('trading-jito');

/** Jito public tip accounts. We pick one at random per bundle — Jito rotates
 *  validator tip routing across these, so spreading load reduces collisions. */
export const JITO_TIP_ACCOUNTS: PublicKey[] = [
  new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'),
  new PublicKey('HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe'),
  new PublicKey('Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY'),
  new PublicKey('ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49'),
  new PublicKey('DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh'),
  new PublicKey('ADuUkR4vqLUMWXxW9gh6D6L8pivKeVQ7eh2yahFuFd6U'),
  new PublicKey('DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL'),
  new PublicKey('3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'),
];

/** Build a SystemProgram transfer to a random Jito tip account.
 *  Include this as the LAST instruction in the swap tx (not a separate tx)
 *  so Jito treats the bundle as atomic. */
export function buildJitoTipIx(from: PublicKey, lamports: number): TransactionInstruction {
  const to = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });
}

export interface BundleSubmitResult {
  landed: boolean;
  bundleId?: string;
  txSignature?: string;
  landedSlot?: number;
  path: 'jito' | 'rpc';
  latencyMs: number;
  errorMessage?: string;
}

/**
 * Submit a single signed transaction as a Jito bundle. If Jito rejects or
 * does not confirm within `timeoutMs`, fall back to RPC sendRawTransaction.
 *
 * The swap tx must already include a tip transfer ix to a Jito tip account —
 * this function does NOT add one. Separate tip tx in a multi-tx bundle is
 * fine too; pass an array.
 */
export async function submitBundle(
  connection: Connection,
  signedTxs: Uint8Array[],
  opts: { timeoutMs?: number } = {},
): Promise<BundleSubmitResult> {
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const t0 = Date.now();

  // ── Try Jito first ────────────────────────────────────────────────
  const base64Txs = signedTxs.map((tx) => Buffer.from(tx).toString('base64'));
  try {
    const resp = await axios.post(
      `${JITO_BLOCK_ENGINE_URL}/api/v1/bundles`,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [base64Txs, { encoding: 'base64' }],
      },
      { timeout: timeoutMs, headers: { 'Content-Type': 'application/json' } },
    );

    const bundleId = resp.data?.result as string | undefined;
    if (!bundleId) {
      throw new Error(`Jito sendBundle returned no bundleId: ${JSON.stringify(resp.data)}`);
    }

    // Poll for bundle status up to timeoutMs. Jito typically lands in <1s.
    const landed = await pollBundleStatus(bundleId, timeoutMs);
    if (landed) {
      return {
        landed: true,
        bundleId,
        txSignature: landed.txSignature,
        landedSlot: landed.landedSlot,
        path: 'jito',
        latencyMs: Date.now() - t0,
      };
    }

    logger.warn({ bundleId }, 'Jito bundle did not land in window — falling back to RPC');
  } catch (err) {
    const msg = err instanceof AxiosError
      ? `${err.code ?? ''} ${err.message}`
      : err instanceof Error ? err.message : String(err);
    logger.warn({ msg }, 'Jito bundle submission failed — falling back to RPC');
  }

  // ── RPC fallback ──────────────────────────────────────────────────
  try {
    const txSignature = await connection.sendRawTransaction(signedTxs[0], {
      skipPreflight: true,
      maxRetries: 3,
    });
    // Poll getSignatureStatuses until confirmed or timeout elapses. We avoid
    // connection.confirmTransaction here — it requires a BlockhashWithExpiryBlockHeight
    // object we don't track, and the deprecated (signature, commitment) form
    // can hang under load.
    const deadline = Date.now() + Math.max(1_500, timeoutMs * 2);
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      const statuses = await connection.getSignatureStatuses([txSignature]).catch(() => null);
      const status = statuses?.value?.[0];
      if (status?.err != null) {
        lastErr = status.err;
        break;
      }
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        return { landed: true, txSignature, path: 'rpc', latencyMs: Date.now() - t0 };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return {
      landed: false, txSignature, path: 'rpc', latencyMs: Date.now() - t0,
      errorMessage: lastErr != null ? JSON.stringify(lastErr) : 'confirmation timeout',
    };
  } catch (err) {
    return {
      landed: false,
      path: 'rpc',
      latencyMs: Date.now() - t0,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Poll Jito getBundleStatuses until the bundle lands or timeout elapses. */
async function pollBundleStatus(
  bundleId: string,
  timeoutMs: number,
): Promise<{ txSignature: string; landedSlot: number } | null> {
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 150;
  while (Date.now() < deadline) {
    try {
      const resp = await axios.post(
        `${JITO_BLOCK_ENGINE_URL}/api/v1/getBundleStatuses`,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'getBundleStatuses',
          params: [[bundleId]],
        },
        { timeout: 1_000, headers: { 'Content-Type': 'application/json' } },
      );
      const statuses = resp.data?.result?.value as Array<{
        bundle_id: string;
        transactions: string[];
        slot: number;
        confirmation_status: string;
      }> | undefined;
      const s = statuses?.[0];
      if (s && (s.confirmation_status === 'confirmed' || s.confirmation_status === 'finalized')) {
        return { txSignature: s.transactions[0], landedSlot: s.slot };
      }
    } catch {
      // transient poll failure — retry
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  return null;
}
