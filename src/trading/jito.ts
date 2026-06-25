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

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Encode bytes to base58 (standard bigint-accumulator). Inlined to avoid a bs58 dep
 *  (same reason as wallet.ts). Used to derive a tx signature from a signed tx so we can
 *  verify it on-chain after getInflightBundleStatuses reports the bundle Landed. */
function base58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = '';
  while (num > 0n) { out = BASE58_ALPHABET[Number(num % 58n)] + out; num /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

/** First signature of a serialized (signed) tx: a compact-u16 sig count (1 byte for our
 *  single-signer txs) followed by 64-byte signatures. So bytes [1,65) = sig 0. */
function firstSignatureOf(signedTx: Uint8Array): string {
  return base58Encode(signedTx.slice(1, 65));
}

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

/** Process-lifetime Jito bundle diagnostics (reset on redeploy). Surfaced into
 *  live-training.json so the failure mode is visible WITHOUT Railway log access:
 *  a high `poll_429` = rate-limited; high `not_landed` = bundle isn't winning the
 *  auction (tip); high `bundle_failed` = rejected; `send_err` = sendBundle itself failing. */
export const jitoBundleStats = {
  submitted: 0,
  landed_jito: 0,
  fell_back_rpc: 0,
  not_landed: 0,
  bundle_failed: 0,
  poll_429: 0,
  poll_err: 0,
  send_err: 0,
  last_poll_error: '',
};

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
  opts: { timeoutMs?: number; rpcOnly?: boolean } = {},
): Promise<BundleSubmitResult> {
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const t0 = Date.now();

  // Multi-tx bundles aren't supported by the RPC fallback path (line ~111
  // submits only signedTxs[0]). Every current caller passes exactly one tx
  // (swap + tip ix in the same tx) — this assert prevents a future caller
  // from silently dropping the tail of a multi-tx bundle on fallback.
  if (signedTxs.length !== 1) {
    throw new Error(`submitBundle requires exactly 1 signed tx, got ${signedTxs.length} — RPC fallback would silently drop the rest`);
  }

  // ── Try Jito first (unless rpcOnly) ───────────────────────────────
  // rpcOnly skips the Jito bundle attempt entirely and submits via RPC. Used by the
  // copy live path, where bundles never land (validated 0/26 after the poll+region
  // fixes) — so the Jito attempt is pure wasted latency. The tx still carries the
  // compute-unit priority fee, so RPC landing is fast (~0.7s).
  if (!opts.rpcOnly) {
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
    jitoBundleStats.submitted++;

    // Poll getInflightBundleStatuses (NOT getBundleStatuses — that only sees rooted
    // bundles) at a rate-limit-respecting cadence. Free tier is 1 req/s/IP/region, so a
    // tight poll gets 429'd and we never see the land. Window is wide enough for ~4 polls.
    const expectedSig = firstSignatureOf(signedTxs[0]);
    const landed = await pollBundleStatus(connection, bundleId, expectedSig, Math.max(timeoutMs, 5_000));
    if (landed) {
      jitoBundleStats.landed_jito++;
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
    jitoBundleStats.send_err++;
    const msg = err instanceof AxiosError
      ? `${err.code ?? ''} ${err.message}`
      : err instanceof Error ? err.message : String(err);
    jitoBundleStats.last_poll_error = `send: ${msg}`;
    logger.warn({ msg }, 'Jito bundle submission failed — falling back to RPC');
  }
  } // end if(!rpcOnly)

  // ── RPC (fallback for the Jito path; primary for rpcOnly) ─────────
  if (!opts.rpcOnly) jitoBundleStats.fell_back_rpc++;
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

/**
 * Poll Jito getBundleStatuses until the bundle lands or timeout elapses.
 * Returns null on three "looks landed but isn't usable" cases that callers
 * MUST NOT treat as success:
 *   (a) bundle-level err is non-null (Jito reports the bundle failed)
 *   (b) the tx itself reverted on-chain (RPC getSignatureStatuses returns err)
 * Pre-fix, both cases caused phantom landings: bot recorded trades as
 * filled when the swap had actually reverted. The 2026-05-17 strategy-manager
 * phantom-close bug was one path; this is the other.
 */
async function pollBundleStatus(
  connection: Connection,
  bundleId: string,
  expectedSig: string,
  timeoutMs: number,
): Promise<{ txSignature: string; landedSlot: number } | null> {
  const deadline = Date.now() + timeoutMs;
  // Free Jito tier = 1 req/s/IP/region. getBundleStatuses (the old method) only sees
  // ROOTED bundles and returned null for our whole window; getInflightBundleStatuses
  // reports Pending/Landed/Failed/Invalid in real time. Poll at >=1s so we don't get
  // 429'd into a silent miss. sendBundle just consumed the budget, so wait first.
  const pollInterval = 1_100;
  let pollErrors = 0;
  let landedSlot: number | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));
    try {
      const resp = await axios.post(
        `${JITO_BLOCK_ENGINE_URL}/api/v1/bundles`,
        { jsonrpc: '2.0', id: 1, method: 'getInflightBundleStatuses', params: [[bundleId]] },
        { timeout: 2_000, headers: { 'Content-Type': 'application/json' } },
      );
      const v = resp.data?.result?.value?.[0] as
        { bundle_id: string; status: string; landed_slot: number | null } | undefined;
      const status = v?.status;
      if (status === 'Landed') { landedSlot = v?.landed_slot ?? 0; break; }
      if (status === 'Failed') {
        jitoBundleStats.bundle_failed++;
        logger.warn({ bundleId }, 'Jito bundle Failed (all regions rejected) — falling back to RPC');
        return null;
      }
      // 'Pending', 'Invalid' (not yet indexed / 5-min lookback), or no value → keep polling.
    } catch (err) {
      pollErrors++;
      const httpStatus = err instanceof AxiosError ? err.response?.status : undefined;
      if (httpStatus === 429) jitoBundleStats.poll_429++; else jitoBundleStats.poll_err++;
      const msg = err instanceof AxiosError
        ? `HTTP ${httpStatus ?? '?'} ${err.code ?? ''} ${err.message}`
        : err instanceof Error ? err.message : String(err);
      jitoBundleStats.last_poll_error = msg;
      // NOT silent anymore: a recurring 'HTTP 429' here is the rate-limit smoking gun.
      logger.warn({ bundleId, pollErrors, msg }, 'getInflightBundleStatuses poll error');
    }
  }
  if (landedSlot === null) {
    jitoBundleStats.not_landed++;
    logger.warn({ bundleId, pollErrors }, 'Jito bundle did not report Landed in window');
    return null;
  }
  // Bundle landed. Verify the swap tx itself didn't revert on-chain (atomic bundles can
  // still carry a reverted tx). This hits the Helius RPC, not Jito — no rate-limit impact.
  const txStatuses = await connection.getSignatureStatuses([expectedSig]).catch(() => null);
  const txEntry = txStatuses?.value?.[0];
  if (txEntry?.err != null) {
    logger.warn({ bundleId, expectedSig, txErr: txEntry.err }, 'Jito bundle landed but tx reverted');
    return null;
  }
  return { txSignature: expectedSig, landedSlot };
}
