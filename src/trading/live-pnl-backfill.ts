/**
 * One-shot backfill: re-derive live trade P&L from on-chain transaction meta.
 *
 * Why this exists
 * ---------------
 * Live entry/exit fills were historically measured from full-wallet balance
 * snapshots (baseBalAfter - baseBalBefore for tokens, walletSolAfter -
 * walletSolBefore for SOL). When two live strategies traded the same mint
 * concurrently — exactly what the v44 cohort does, running two live twins on
 * the same entry decision — each trade's snapshot captured the OTHER trade's
 * wallet movement, producing wildly wrong effective prices and net P&L (e.g.
 * a 0.05 SOL buy showing 44-60% "slippage", or live returns ±100% off the
 * shadow twin that rode the identical price path). The executor was fixed to
 * read each fill from its OWN confirmed tx meta (executor.fetchTxBalanceDeltas,
 * 2026-05-29), but the already-recorded rows stay corrupted.
 *
 * What it does
 * ------------
 * For every closed live round-trip that has both an entry and exit tx that
 * landed, it re-fetches each transaction's meta and recomputes the economic
 * fields from ground truth:
 *   - entrySolSpent     = preBalances[0] - postBalances[0] of the entry tx
 *                         (lamports that left our fee-payer account: swap cost
 *                         + tip + fee + any new ATA rent)
 *   - exitSolReceived   = postBalances[0] - preBalances[0] of the exit tx
 *                         (net lamports credited: gross quote - tip - fee +
 *                         any rent refunded)
 *   - tokens in/out     = post-minus-pre on our base ATA in each tx
 *   net_profit_sol      = exitSolReceived - entrySolSpent  (exact realized
 *                         wallet cash flow — verifiable against the wallet)
 *   net_return_pct      = net_profit_sol / effective trade size * 100
 *   entry/exit eff price = all-in SOL per token for each leg
 *
 * Each transaction's meta is scoped to that single tx, so the recompute is
 * immune to the concurrency race that corrupted the originals, and it is fully
 * idempotent (same chain data → same result).
 *
 * Drainer guard
 * -------------
 * The mis-paired-sell case (one strategy's sell drained the shared wallet
 * position, e.g. 4Xbd 16341/16342) is handled separately by the
 * live_mispaired_sell_correction_v1 migration. Here we SKIP any trade whose
 * exit tx sold substantially more tokens than its entry tx bought (> 1.5x):
 * recomputing those would credit one strategy with both strategies' proceeds.
 *
 * Scheduling
 * ----------
 * Runs once (guarded by a bot_settings marker), fired in the background after
 * startup — it does network I/O and must never block the boot path.
 */

import Database from 'better-sqlite3';
import { Connection } from '@solana/web3.js';
import { makeLogger } from '../utils/logger';
import { MICRO_TRADE_SIZE_SOL } from './config';

const logger = makeLogger('live-pnl-backfill');

const MARKER = 'live_pnl_chain_backfill_v1';
const TX_FETCH_RETRY_MS = [800, 1500, 2500];
/** Sold-more-than-bought ratio above which a trade is treated as a "drainer"
 *  (it liquidated a sibling's commingled position) and left to the
 *  live_mispaired_sell_correction_v1 migration instead. */
const DRAINER_RATIO_NUM = 3n;
const DRAINER_RATIO_DEN = 2n;

interface TxDeltas {
  /** post - pre lamports on the fee-payer account (signed: <0 buy, >0 sell). */
  feePayerDeltaLamports: number;
  /** post - pre raw token balance on our base ATA (signed: >0 buy, <0 sell). */
  tokenDeltaRaw: bigint;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fetch a confirmed tx and extract our fee-payer SOL delta + base-mint token
 *  delta, both scoped to that single tx. The fee payer is account index 0 and
 *  is our wallet, so we identify our token account by owner === fee payer. */
async function fetchTxDeltas(
  conn: Connection,
  txSignature: string,
  mintB58: string,
): Promise<TxDeltas | null> {
  let tx = null;
  for (const delay of TX_FETCH_RETRY_MS) {
    try {
      tx = await conn.getTransaction(txSignature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (tx) break;
    } catch {
      // retry, then return null
    }
    await sleep(delay);
  }
  if (!tx?.meta) return null;

  const pre = tx.meta.preBalances?.[0];
  const post = tx.meta.postBalances?.[0];
  if (pre == null || post == null) return null;
  const feePayerDeltaLamports = post - pre;

  const msg = tx.transaction.message;
  const keys = 'staticAccountKeys' in msg
    ? msg.staticAccountKeys
    : (msg as { accountKeys: { toBase58(): string }[] }).accountKeys;
  const feePayer = keys?.[0]?.toBase58();
  if (!feePayer) return null;

  let preSum = 0n;
  for (const b of tx.meta.preTokenBalances ?? []) {
    if (b.owner === feePayer && b.mint === mintB58) {
      preSum += BigInt(b.uiTokenAmount.amount);
    }
  }
  let postSum = 0n;
  for (const b of tx.meta.postTokenBalances ?? []) {
    if (b.owner === feePayer && b.mint === mintB58) {
      postSum += BigInt(b.uiTokenAmount.amount);
    }
  }
  return { feePayerDeltaLamports, tokenDeltaRaw: postSum - preSum };
}

interface LiveRow {
  id: number;
  mint: string;
  execution_mode: string;
  trade_size_sol: number | null;
  entry_tx_signature: string;
  exit_tx_signature: string;
}

export async function backfillLivePnlFromChain(
  db: Database.Database,
  conn: Connection,
): Promise<void> {
  const alreadyDone = db.prepare(`SELECT 1 FROM bot_settings WHERE key = ?`).get(MARKER) != null;
  if (alreadyDone) return;

  const rows = db.prepare(`
    SELECT id, mint, execution_mode, trade_size_sol, entry_tx_signature, exit_tx_signature
    FROM trades_v2
    WHERE status = 'closed'
      AND execution_mode IN ('live_micro', 'live_full')
      AND entry_tx_signature IS NOT NULL
      AND exit_tx_signature IS NOT NULL
      AND exit_reason <> 'sell_failed_terminal'
  `).all() as LiveRow[];

  if (rows.length === 0) {
    db.prepare(`INSERT OR REPLACE INTO bot_settings (key, value, updated_at) VALUES (?, ?, unixepoch())`)
      .run(MARKER, '0');
    return;
  }

  logger.info({ candidates: rows.length }, 'Live P&L chain backfill: starting (background)');

  const update = db.prepare(`
    UPDATE trades_v2
    SET entry_effective_price = ?,
        exit_effective_price = ?,
        net_profit_sol = ?,
        net_return_pct = ?,
        gross_return_pct = ?,
        gap_adjusted_return_pct = ?
    WHERE id = ?
  `);

  let updated = 0;
  let skippedDrainer = 0;
  let failed = 0;

  for (const r of rows) {
    const entry = await fetchTxDeltas(conn, r.entry_tx_signature, r.mint);
    const exit = await fetchTxDeltas(conn, r.exit_tx_signature, r.mint);
    if (!entry || !exit) {
      failed++;
      continue;
    }

    const entryTokensRaw = entry.tokenDeltaRaw;        // > 0 (bought)
    const exitTokensSoldRaw = -exit.tokenDeltaRaw;     // > 0 (sold)
    const entrySolSpentLamports = -entry.feePayerDeltaLamports; // > 0 (paid)
    const exitSolReceivedLamports = exit.feePayerDeltaLamports; // net credit

    if (entryTokensRaw <= 0n || entrySolSpentLamports <= 0) {
      failed++;
      continue;
    }
    // Drainer: sold far more than bought → liquidated a sibling's commingled
    // position. Recomputing would over-credit; leave to the mis-paired-sell
    // migration.
    if (exitTokensSoldRaw * DRAINER_RATIO_DEN > entryTokensRaw * DRAINER_RATIO_NUM) {
      skippedDrainer++;
      continue;
    }

    const tradeSize = r.execution_mode === 'live_micro'
      ? MICRO_TRADE_SIZE_SOL
      : (r.trade_size_sol ?? 0);

    const entrySolSpent = entrySolSpentLamports / 1e9;
    const exitSolReceived = exitSolReceivedLamports / 1e9;
    const entryEffPrice = entrySolSpent / (Number(entryTokensRaw) / 1e6);
    const exitEffPrice = exitTokensSoldRaw > 0n
      ? exitSolReceived / (Number(exitTokensSoldRaw) / 1e6)
      : 0;
    const netProfitSol = exitSolReceived - entrySolSpent;
    const netReturnPct = tradeSize > 0 ? (netProfitSol / tradeSize) * 100 : 0;
    // All-in entry & exit prices already fold in tip/fee/rent, so the
    // token-price ratio equals the post-cost return — gross and gap-adjusted
    // collapse to net for a live fill recomputed this way.
    const grossReturnPct = entryEffPrice > 0
      ? (exitEffPrice / entryEffPrice - 1) * 100
      : netReturnPct;

    const round = (n: number, dp: number) => {
      const f = 10 ** dp;
      return Math.round(n * f) / f;
    };
    update.run(
      round(entryEffPrice, 12),
      round(exitEffPrice, 12),
      round(netProfitSol, 8),
      round(netReturnPct, 6),
      round(grossReturnPct, 6),
      round(grossReturnPct, 6),
      r.id,
    );
    updated++;
  }

  // Only mark done if we actually reached the chain. If EVERY candidate failed
  // to fetch, treat it as a transient RPC outage at boot and leave the marker
  // unset so the next startup retries — otherwise a momentary network blip
  // would permanently skip the backfill.
  if (failed === rows.length) {
    logger.warn(
      { candidates: rows.length },
      'Live P&L chain backfill: all tx fetches failed (transient RPC?) — leaving unmarked to retry next boot',
    );
    return;
  }

  db.prepare(`INSERT OR REPLACE INTO bot_settings (key, value, updated_at) VALUES (?, ?, unixepoch())`)
    .run(MARKER, String(updated));
  logger.info(
    { updated, skippedDrainer, failed, candidates: rows.length },
    'Live P&L chain backfill: done',
  );
}
