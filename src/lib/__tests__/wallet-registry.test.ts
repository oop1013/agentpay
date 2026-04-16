import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock redis before importing the module under test ──────────────
vi.mock("../redis", () => {
  const store: Record<string, Record<string, unknown>> = {};
  const counters: Record<string, number> = {};

  return {
    redis: {
      hgetall: vi.fn(async (key: string) => store[key] ?? {}),
      hset: vi.fn(async (key: string, data: Record<string, unknown>) => {
        store[key] = { ...data };
      }),
      hincrby: vi.fn(async (key: string, field: string, delta: number) => {
        if (!counters[`${key}:${field}`]) counters[`${key}:${field}`] = 0;
        counters[`${key}:${field}`] += delta;
        return counters[`${key}:${field}`];
      }),
      _store: store,
      _counters: counters,
      _reset: () => {
        Object.keys(store).forEach((k) => delete store[k]);
        Object.keys(counters).forEach((k) => delete counters[k]);
      },
    },
  };
});

import { redis } from "../redis";
import { registerOrGetWallet, getWallet, toSharedIdentity } from "../wallet-registry";

const mockRedis = redis as typeof redis & { _reset: () => void };

const TEST_ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

beforeEach(() => {
  mockRedis._reset();
  vi.clearAllMocks();
});

describe("registerOrGetWallet", () => {
  it("creates a new wallet and returns created=true", async () => {
    const { wallet, created } = await registerOrGetWallet({
      address: TEST_ADDRESS,
      type: "provider",
      name: "Alice",
    });

    expect(created).toBe(true);
    expect(wallet.address).toBe(TEST_ADDRESS);
    expect(wallet.type).toBe("provider");
    expect(wallet.name).toBe("Alice");
    expect(wallet.totalSpent).toBe(0);
    expect(wallet.totalEarned).toBe(0);
    expect(wallet.createdAt).toBeTruthy();
    expect(wallet.lastActiveAt).toBeTruthy();
  });

  it("normalizes address to lowercase before storing", async () => {
    const mixed = "0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266";
    const { wallet } = await registerOrGetWallet({ address: mixed, type: "human", name: "" });
    expect(wallet.address).toBe(TEST_ADDRESS);
  });

  it("increments platform totalWallets counter on creation", async () => {
    await registerOrGetWallet({ address: TEST_ADDRESS, type: "agent", name: "Bot" });
    expect(redis.hincrby).toHaveBeenCalledWith("platform:stats", "totalWallets", 1);
  });

  it("returns existing wallet with created=false on duplicate registration", async () => {
    await registerOrGetWallet({ address: TEST_ADDRESS, type: "provider", name: "Alice" });
    vi.clearAllMocks();

    const { wallet, created } = await registerOrGetWallet({
      address: TEST_ADDRESS,
      type: "human", // different type — ignored, returns existing
      name: "Bob",
    });

    expect(created).toBe(false);
    expect(wallet.type).toBe("provider"); // original type preserved
    expect(wallet.name).toBe("Alice");    // original name preserved
    expect(redis.hset).not.toHaveBeenCalled();
    expect(redis.hincrby).not.toHaveBeenCalled();
  });

  it("is idempotent for checksummed addresses", async () => {
    const checksummed = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    await registerOrGetWallet({ address: checksummed, type: "provider", name: "A" });
    const { created } = await registerOrGetWallet({ address: TEST_ADDRESS, type: "provider", name: "A" });
    expect(created).toBe(false);
  });
});

describe("getWallet", () => {
  it("returns null when wallet does not exist", async () => {
    const result = await getWallet(TEST_ADDRESS);
    expect(result).toBeNull();
  });

  it("returns wallet after registration", async () => {
    await registerOrGetWallet({ address: TEST_ADDRESS, type: "provider", name: "Carol" });
    const wallet = await getWallet(TEST_ADDRESS);
    expect(wallet).not.toBeNull();
    expect(wallet!.address).toBe(TEST_ADDRESS);
    expect(wallet!.name).toBe("Carol");
  });

  it("normalizes address for lookup", async () => {
    await registerOrGetWallet({ address: TEST_ADDRESS, type: "human", name: "Dave" });
    const wallet = await getWallet("0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266");
    expect(wallet).not.toBeNull();
    expect(wallet!.address).toBe(TEST_ADDRESS);
  });
});

describe("toSharedIdentity", () => {
  it("maps Wallet fields to SharedWalletIdentity", () => {
    const wallet = {
      address: TEST_ADDRESS,
      type: "provider" as const,
      name: "Eve",
      totalSpent: 100,
      totalEarned: 50,
      createdAt: "2024-01-01T00:00:00.000Z",
      lastActiveAt: "2024-06-01T00:00:00.000Z",
    };

    const identity = toSharedIdentity(wallet);

    expect(identity.address).toBe(TEST_ADDRESS);
    expect(identity.type).toBe("provider");
    expect(identity.displayName).toBe("Eve");
    expect(identity.registeredAt).toBe("2024-01-01T00:00:00.000Z");
  });
});
