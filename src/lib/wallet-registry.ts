import { redis } from "./redis";
import { Wallet, WalletType, SharedWalletIdentity } from "./types";
import { normalizeAddress } from "./addresses";

/**
 * Register a wallet if it doesn't exist, or return the existing one.
 */
export async function registerOrGetWallet(params: {
  address: string;
  type: WalletType;
  name: string;
}): Promise<{ wallet: Wallet; created: boolean }> {
  const address = normalizeAddress(params.address);
  const existing = await redis.hgetall(`wallet:${address}`);

  if (existing && Object.keys(existing).length > 0) {
    return { wallet: existing as unknown as Wallet, created: false };
  }

  const now = new Date().toISOString();
  const wallet: Wallet = {
    address,
    type: params.type,
    name: params.name,
    totalSpent: 0,
    totalEarned: 0,
    createdAt: now,
    lastActiveAt: now,
  };

  await redis.hset(`wallet:${address}`, wallet as unknown as Record<string, unknown>);
  await redis.hincrby("platform:stats", "totalWallets", 1);

  return { wallet, created: true };
}

/**
 * Look up a wallet by address. Returns null if not found.
 */
export async function getWallet(address: string): Promise<Wallet | null> {
  const normalized = normalizeAddress(address);
  const data = await redis.hgetall(`wallet:${normalized}`);
  if (!data || Object.keys(data).length === 0) return null;
  return data as unknown as Wallet;
}

/**
 * Convert a Wallet to the shared cross-system identity shape.
 */
export function toSharedIdentity(wallet: Wallet): SharedWalletIdentity {
  return {
    address: wallet.address,
    type: wallet.type,
    displayName: wallet.name,
    registeredAt: wallet.createdAt,
  };
}
