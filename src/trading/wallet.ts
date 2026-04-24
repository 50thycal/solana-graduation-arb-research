import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import { makeLogger } from '../utils/logger';
import { globalRpcLimiter } from '../utils/rpc-limiter';

const logger = makeLogger('trading-wallet');

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Decode a base58 string to bytes. Only used to load a Solana secret key from
 * env. We inline this to avoid adding bs58 as a dependency — implementation is
 * the standard bigint-accumulator algorithm.
 */
function base58Decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);
  let num = 0n;
  const base = 58n;
  for (const ch of s) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base58 char: ${ch}`);
    num = num * base + BigInt(idx);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.push(Number(num & 0xffn));
    num >>= 8n;
  }
  // Preserve leading '1' → leading 0x00 bytes
  for (const ch of s) {
    if (ch === '1') bytes.push(0);
    else break;
  }
  return new Uint8Array(bytes.reverse());
}

/**
 * Parse a Solana secret key from env. Accepts:
 *   - JSON array of 64 bytes: `[1,2,3,...]`
 *   - base58 string (Phantom export format)
 * Returns a Keypair. Throws with a non-leaking message on invalid input.
 */
function parseSecretKey(raw: string): Keypair {
  const trimmed = raw.trim();
  try {
    if (trimmed.startsWith('[')) {
      const arr = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(arr) || arr.length !== 64) {
        throw new Error('JSON array must have exactly 64 bytes');
      }
      return Keypair.fromSecretKey(Uint8Array.from(arr as number[]));
    }
    const decoded = base58Decode(trimmed);
    if (decoded.length !== 64) {
      throw new Error(`base58 secret key must decode to 64 bytes, got ${decoded.length}`);
    }
    return Keypair.fromSecretKey(decoded);
  } catch (err) {
    throw new Error(
      `Failed to parse WALLET_PRIVATE_KEY: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── SPL token constants (inlined to avoid @solana/spl-token dependency) ──────
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/**
 * Derive the associated token account address for (owner, mint).
 * Mirrors @solana/spl-token's getAssociatedTokenAddressSync.
 */
export function getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

// Balance cache (shared across calls) — avoids hammering RPC when preflight
// checks fire on every T+30. 2-second TTL keeps the signal fresh.
const BALANCE_CACHE_TTL_MS = 2_000;
let solBalanceCache: { lamports: number; fetchedAt: number } | null = null;

export class Wallet {
  readonly keypair: Keypair;
  readonly pubkey: PublicKey;

  constructor(keypair: Keypair) {
    this.keypair = keypair;
    this.pubkey = keypair.publicKey;
  }

  /** Load from env (WALLET_PRIVATE_KEY). Returns null if env not set. */
  static fromEnv(): Wallet | null {
    const raw = process.env.WALLET_PRIVATE_KEY;
    if (!raw) return null;
    const kp = parseSecretKey(raw);
    // Defensive: never log the key or the pubkey at info level on load;
    // trace pubkey only at debug.
    logger.debug({ pubkey: kp.publicKey.toBase58() }, 'Wallet loaded from env');
    return new Wallet(kp);
  }

  /** Lamports balance, cached 2s. */
  async getSolBalance(connection: Connection): Promise<number> {
    if (solBalanceCache && Date.now() - solBalanceCache.fetchedAt < BALANCE_CACHE_TTL_MS) {
      return solBalanceCache.lamports;
    }
    await globalRpcLimiter.throttle();
    const lamports = await connection.getBalance(this.pubkey, 'confirmed');
    solBalanceCache = { lamports, fetchedAt: Date.now() };
    return lamports;
  }

  /** Invalidate balance cache — call after a tx that moves SOL. */
  invalidateSolBalance(): void {
    solBalanceCache = null;
  }

  /**
   * Return raw token amount held in the wallet's ATA for `mint`, or 0 if the
   * ATA does not exist. Used pre/post-swap to measure actual fill size.
   * Raw amount = on-chain u64 (caller divides by 10^decimals).
   */
  async getTokenBalanceRaw(connection: Connection, mint: PublicKey): Promise<number> {
    const ata = getAssociatedTokenAddress(mint, this.pubkey);
    await globalRpcLimiter.throttle();
    try {
      const info = await connection.getAccountInfo(ata, 'confirmed');
      if (!info || !info.data) return 0;
      // SPL token account: amount is u64 LE at offset 64
      const data = info.data as Buffer;
      if (data.length < 72) return 0;
      // Read as BigInt to avoid precision loss, then coerce to number for
      // downstream arithmetic (6-decimal tokens fit comfortably in Number
      // up to ~9 trillion whole tokens).
      const lo = data.readUInt32LE(64);
      const hi = data.readUInt32LE(68);
      return hi * 2 ** 32 + lo;
    } catch (err) {
      logger.debug(
        'getTokenBalanceRaw failed for %s: %s',
        mint.toBase58(),
        err instanceof Error ? err.message : String(err),
      );
      return 0;
    }
  }

  /** Sign a legacy or versioned transaction in-place. */
  sign(tx: Transaction | VersionedTransaction): void {
    if (tx instanceof VersionedTransaction) {
      tx.sign([this.keypair]);
    } else {
      tx.partialSign(this.keypair);
    }
  }
}
