/**
 * Regression test pack — Phase 2 mandatory scenarios
 *
 * Covers the 4 scenarios required by AGEAA-105:
 *   1. Provider journey smoke flow
 *      register service → create auth → make paid request → verify usage recorded
 *   2. Manifest contract behavior
 *      GET manifest returns correct schema with all required fields
 *   3. Paused-service 410 empty-body
 *      paused service manifest returns 410 with empty body (no JSON)
 *   4. Authorization/payment flow
 *      full auth → payment proof → verification → spend cap enforcement
 *
 * All tests use the in-memory Redis mock (no Upstash / external dependencies).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response } from "express";

// ── Shared in-memory Redis mock ───────────────────────────────────────────────
// Hoisted so it is available before vi.mock factory calls run.
// Mirrors src/lib/redis-mock.ts but is a fresh, resettable instance.

const { redisMock, verifyProofMock, parseProofMock, consumeNonceMock } = vi.hoisted(() => {
  type HashData = Record<string, string | number>;
  interface ZSetEntry { score: number; member: string; }
  interface StringEntry { value: string; expiresAt?: number; }

  class MockPipeline {
    // ops return non-null values so pay.ts pipeline check passes
    private ops: Array<() => unknown> = [];
    constructor(private store: InMemoryRedis) {}
    zadd(key: string, entry: { score: number; member: string }) {
      this.ops.push(() => { this.store._zadd(key, entry); return 1; });
      return this;
    }
    hincrby(key: string, field: string, increment: number) {
      this.ops.push(() => this.store._hincrby(key, field, increment));
      return this;
    }
    hset(key: string, data: Record<string, unknown>) {
      this.ops.push(() => { this.store._hset(key, data); return Object.keys(data).length; });
      return this;
    }
    set(key: string, value: string, _opts?: { ex?: number }) {
      this.ops.push(() => { this.store._set(key, value, _opts); return "OK"; });
      return this;
    }
    async exec(): Promise<unknown[]> {
      const results: unknown[] = [];
      for (const op of this.ops) results.push(op());
      return results;
    }
  }

  class InMemoryRedis {
    private hashes = new Map<string, HashData>();
    private zsets = new Map<string, ZSetEntry[]>();
    private strings = new Map<string, StringEntry>();

    reset() {
      this.hashes.clear();
      this.zsets.clear();
      this.strings.clear();
    }

    _hset(key: string, data: Record<string, unknown>): void {
      const existing = this.hashes.get(key) ?? {};
      for (const [k, v] of Object.entries(data)) existing[k] = v as string | number;
      this.hashes.set(key, existing);
    }
    _hincrby(key: string, field: string, increment: number): number {
      const existing = this.hashes.get(key) ?? {};
      const current = Number(existing[field] ?? 0);
      existing[field] = current + increment;
      this.hashes.set(key, existing);
      return current + increment;
    }
    _zadd(key: string, entry: ZSetEntry): void {
      const existing = this.zsets.get(key) ?? [];
      existing.push(entry);
      this.zsets.set(key, existing);
    }
    _set(key: string, value: string, opts?: { ex?: number }): void {
      const expiresAt = opts?.ex ? Date.now() + opts.ex * 1000 : undefined;
      this.strings.set(key, { value, expiresAt });
    }

    async hset(key: string, data: Record<string, unknown>): Promise<number> {
      this._hset(key, data);
      return Object.keys(data).length;
    }
    async hgetall(key: string): Promise<Record<string, unknown> | null> {
      const data = this.hashes.get(key);
      return data ? { ...data } : null;
    }
    async hincrby(key: string, field: string, increment: number): Promise<number> {
      return this._hincrby(key, field, increment);
    }
    async zadd(key: string, entry: ZSetEntry): Promise<number> {
      this._zadd(key, entry);
      return 1;
    }
    async zrange<T = unknown>(
      key: string,
      _max: string | number,
      _min: string | number,
      opts?: { byScore?: boolean; rev?: boolean; offset?: number; count?: number }
    ): Promise<T[]> {
      const entries = this.zsets.get(key) ?? [];
      const sorted = [...entries].sort((a, b) => opts?.rev ? b.score - a.score : a.score - b.score);
      return sorted.map((e) => {
        try { return JSON.parse(e.member); } catch { return e.member; }
      }) as T[];
    }
    async set(key: string, value: string, opts?: { ex?: number; nx?: boolean }): Promise<"OK" | null> {
      const existing = this.strings.get(key);
      if (opts?.nx && existing && (!existing.expiresAt || existing.expiresAt > Date.now())) {
        return null;
      }
      this._set(key, value, opts);
      return "OK";
    }
    async get(key: string): Promise<string | null> {
      const entry = this.strings.get(key);
      if (!entry) return null;
      if (entry.expiresAt && Date.now() > entry.expiresAt) { this.strings.delete(key); return null; }
      return entry.value;
    }
    async del(key: string): Promise<number> {
      const hadHash = this.hashes.delete(key);
      const hadZSet = this.zsets.delete(key);
      const hadString = this.strings.delete(key);
      return hadHash || hadZSet || hadString ? 1 : 0;
    }
    async scan(cursor: number, opts: { match: string; count?: number }): Promise<[number, string[]]> {
      const pattern = opts.match.replace(/\*/g, ".*");
      const regex = new RegExp(`^${pattern}$`);
      const keys = Array.from(this.hashes.keys()).filter((k) => regex.test(k));
      return [0, keys];
    }
    /** Simulates EVAL for the spend-cap Lua scripts. Uses sign of amount to distinguish reserve vs release. */
    async eval(_script: string, keys: string[], args: string[]): Promise<number> {
      const authKey = keys[0];
      const amount = Number(args[0]);
      const existing = this.hashes.get(authKey) ?? {};
      const spent = Number(existing["spent"] ?? 0);
      const cap = Number(existing["spendCap"] ?? 0);
      if (spent + amount > cap) return 0;
      existing["spent"] = spent + amount;
      this.hashes.set(authKey, existing);
      return 1;
    }
    pipeline(): MockPipeline { return new MockPipeline(this); }
  }

  return {
    redisMock: new InMemoryRedis(),
    verifyProofMock: vi.fn(),
    parseProofMock: vi.fn(),
    consumeNonceMock: vi.fn(),
  };
});

vi.mock("../../lib/redis", () => ({ redis: redisMock }));
vi.mock("../../lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../lib/x402", () => ({
  verifyX402Proof: verifyProofMock,
  parseX402Proof: parseProofMock,
  consumeX402Nonce: consumeNonceMock,
}));
vi.mock("../../lib/redis-scripts", () => ({
  atomicSpendCapReserve: async (authKey: string, amount: number) =>
    redisMock.eval("", [authKey], [String(amount)]).then((r) => r === 1),
  atomicSpendCapRelease: async (authKey: string, amount: number) => {
    // Release: decrement spent (clamped to 0)
    const data = await redisMock.hgetall(authKey);
    if (data) {
      const current = Number(data["spent"] ?? 0);
      await redisMock.hset(authKey, { spent: Math.max(0, current - amount) });
    }
  },
}));

// ── Test helpers ──────────────────────────────────────────────────────────────

const PROVIDER_WALLET = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const CALLER_WALLET   = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const SERVICE_ID      = "svc_regression_001";
const PRICE_PER_CALL  = 1000; // micro-USDC
const SPEND_CAP       = 10000;
const PAYMENT_PROOF   = "base64encodedproof";
const NONCE           = "0xdeadbeef00000000000000000000000000000000000000000000000000000001";
const VALID_BEFORE    = Math.floor(Date.now() / 1000) + 3600;

function makeServiceRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: SERVICE_ID,
    providerWallet: PROVIDER_WALLET,
    name: "Regression Test API",
    endpoint: "https://example.com/api/data",
    pricePerCall: String(PRICE_PER_CALL),
    platformFeeBps: "100",
    description: "Regression test service",
    category: "general",
    status: "active",
    totalCalls: "0",
    grossVolume: "0",
    totalEarned: "0",
    totalFees: "0",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeAuthRecord(overrides: Record<string, unknown> = {}) {
  return {
    callerWallet: CALLER_WALLET,
    serviceId: SERVICE_ID,
    spendCap: String(SPEND_CAP),
    spent: "0",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeReq(body: Record<string, unknown> = {}, params: Record<string, string> = {}): Request {
  return { body, params, headers: {}, query: {} } as unknown as Request;
}

type ResCtx = { res: Response; statusCode: number | undefined; body: unknown; ended: boolean };

function makeRes(): ResCtx {
  const ctx: ResCtx = { res: null as unknown as Response, statusCode: undefined, body: undefined, ended: false };
  const res = {
    status(code: number) { ctx.statusCode = code; return res; },
    json(data: unknown) { ctx.body = data; return res; },
    end() { ctx.ended = true; return res; },
  } as unknown as Response;
  ctx.res = res;
  return ctx;
}

async function getPayRecordHandler() {
  const { default: router } = await import("../../api/pay");
  const stack = (router as any).stack as any[];
  const route = stack.find((l: any) => l.route?.path === "/record" && l.route?.methods?.post);
  return route?.route?.stack?.[0]?.handle as ((...args: any[]) => Promise<void>) | undefined;
}

async function getManifestHandler() {
  const { default: router } = await import("../../api/services");
  const stack = (router as any).stack as any[];
  const route = stack.find(
    (l: any) => l.route?.path === "/:id/manifest" && l.route?.methods?.get
  );
  return route?.route?.stack?.[0]?.handle as ((...args: any[]) => Promise<void>) | undefined;
}

async function getPayVerifyHandler() {
  const { default: router } = await import("../../api/pay");
  const stack = (router as any).stack as any[];
  const route = stack.find((l: any) => l.route?.path === "/verify" && l.route?.methods?.post);
  return route?.route?.stack?.[0]?.handle as ((...args: any[]) => Promise<void>) | undefined;
}

// ── Scenario 1: Provider journey smoke flow ───────────────────────────────────

describe("Scenario 1 — Provider journey smoke flow", () => {
  beforeEach(() => {
    redisMock.reset();
    vi.clearAllMocks();
    verifyProofMock.mockResolvedValue({
      valid: true,
      from: CALLER_WALLET,
      to: PROVIDER_WALLET,
      amount: PRICE_PER_CALL,
      nonce: NONCE,
      validBefore: VALID_BEFORE,
    });
    parseProofMock.mockReturnValue({
      from: CALLER_WALLET,
      to: PROVIDER_WALLET,
      value: String(PRICE_PER_CALL),
      nonce: NONCE,
      validBefore: String(VALID_BEFORE),
      signature: "0xsig",
      chainId: 84532,
    });
    consumeNonceMock.mockResolvedValue(true);
  });

  it("registers a service, creates auth, makes a paid request, and records usage", async () => {
    // Step 1: Register service (seed Redis directly — matches what POST /api/services does)
    await redisMock.hset(`service:${SERVICE_ID}`, makeServiceRecord());

    // Step 2: Create authorization (seed Redis directly — matches what POST /api/auth does)
    await redisMock.hset(`auth:${CALLER_WALLET}:${SERVICE_ID}`, makeAuthRecord());

    // Step 3: Make a paid request via POST /api/pay/record
    const handler = await getPayRecordHandler();
    if (!handler) throw new Error("pay/record handler not found");

    const req = makeReq({
      serviceId: SERVICE_ID,
      callerWallet: CALLER_WALLET,
      status: "success",
      latencyMs: 42,
      paymentProof: PAYMENT_PROOF,
    });
    const ctx = makeRes();

    await handler(req, ctx.res, vi.fn());

    // Payment should be accepted
    expect(ctx.statusCode).toBe(201);
    const record = ctx.body as Record<string, unknown>;
    expect(record.serviceId).toBe(SERVICE_ID);
    expect(record.callerWallet).toBe(CALLER_WALLET);
    expect(record.providerWallet).toBe(PROVIDER_WALLET);
    expect(record.grossAmount).toBe(PRICE_PER_CALL);
    expect(record.status).toBe("success");

    // Step 4: Verify usage was recorded in caller's usage sorted set
    const usageEntries = await redisMock.zrange(`wallet:${CALLER_WALLET}:usage`, 0, -1);
    expect(usageEntries.length).toBe(1);
    const usageRecord = usageEntries[0] as Record<string, unknown>;
    expect(usageRecord.serviceId).toBe(SERVICE_ID);
    expect(usageRecord.grossAmount).toBe(PRICE_PER_CALL);

    // Provider earnings should also be recorded
    const earningsEntries = await redisMock.zrange(`wallet:${PROVIDER_WALLET}:earnings`, 0, -1);
    expect(earningsEntries.length).toBe(1);

    // Service call counter should be incremented
    const serviceData = await redisMock.hgetall(`service:${SERVICE_ID}`);
    expect(Number(serviceData!["totalCalls"])).toBe(1);
    expect(Number(serviceData!["grossVolume"])).toBe(PRICE_PER_CALL);
  });
});

// ── Scenario 2: Manifest contract behavior ────────────────────────────────────

describe("Scenario 2 — Manifest contract behavior", () => {
  beforeEach(() => {
    redisMock.reset();
    vi.clearAllMocks();
  });

  it("returns manifest JSON with all required fields for an active service", async () => {
    await redisMock.hset(`service:${SERVICE_ID}`, makeServiceRecord());

    const handler = await getManifestHandler();
    if (!handler) throw new Error("manifest handler not found");

    const req = makeReq({}, { id: SERVICE_ID });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    // Should return 200 (no explicit status set = undefined, body present)
    expect(ctx.statusCode).toBeUndefined();
    const manifest = ctx.body as Record<string, unknown>;

    // Required top-level fields
    expect(manifest).toHaveProperty("manifestVersion");
    expect(manifest).toHaveProperty("serviceId", SERVICE_ID);
    expect(manifest).toHaveProperty("name");
    expect(manifest).toHaveProperty("description");
    expect(manifest).toHaveProperty("endpoint");
    expect(manifest).toHaveProperty("status", "active");
    expect(manifest).toHaveProperty("createdAt");

    // Provider sub-object
    expect(manifest.provider).toBeDefined();
    const provider = manifest.provider as Record<string, unknown>;
    expect(provider).toHaveProperty("wallet", PROVIDER_WALLET);

    // Pricing sub-object
    expect(manifest.pricing).toBeDefined();
    const pricing = manifest.pricing as Record<string, unknown>;
    expect(pricing).toHaveProperty("model", "per_call");
    expect(pricing).toHaveProperty("amount", PRICE_PER_CALL);
    expect(pricing).toHaveProperty("currency", "USDC");
    expect(pricing).toHaveProperty("unit", "micro-USDC");
    expect(pricing).toHaveProperty("platformFeeBps");

    // Schema version is semver-like
    expect(typeof manifest.manifestVersion).toBe("string");
    expect(manifest.manifestVersion as string).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("returns 404 when service does not exist", async () => {
    const handler = await getManifestHandler();
    if (!handler) throw new Error("manifest handler not found");

    const req = makeReq({}, { id: "svc_nonexistent" });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(404);
    expect((ctx.body as Record<string, unknown>)?.error).toMatch(/[Nn]ot [Ff]ound/);
  });
});

// ── Scenario 3: Paused-service 410 empty-body ────────────────────────────────

describe("Scenario 3 — Paused-service 410 empty-body", () => {
  beforeEach(() => {
    redisMock.reset();
    vi.clearAllMocks();
  });

  it("returns 410 with empty body when service is paused", async () => {
    await redisMock.hset(`service:${SERVICE_ID}`, makeServiceRecord({ status: "paused" }));

    const handler = await getManifestHandler();
    if (!handler) throw new Error("manifest handler not found");

    const req = makeReq({}, { id: SERVICE_ID });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(410);
    // Body must be empty — res.end() called, not res.json()
    expect(ctx.ended).toBe(true);
    expect(ctx.body).toBeUndefined();
  });
});

// ── Scenario 4: Authorization/payment flow ────────────────────────────────────

describe("Scenario 4 — Authorization/payment flow", () => {
  beforeEach(() => {
    redisMock.reset();
    vi.clearAllMocks();
    verifyProofMock.mockResolvedValue({
      valid: true,
      from: CALLER_WALLET,
      to: PROVIDER_WALLET,
      amount: PRICE_PER_CALL,
      nonce: NONCE,
      validBefore: VALID_BEFORE,
    });
    consumeNonceMock.mockResolvedValue(true);
  });

  it("verifies a valid payment proof and returns fee breakdown", async () => {
    await redisMock.hset(`service:${SERVICE_ID}`, makeServiceRecord());
    await redisMock.hset(`auth:${CALLER_WALLET}:${SERVICE_ID}`, makeAuthRecord());

    const handler = await getPayVerifyHandler();
    if (!handler) throw new Error("pay/verify handler not found");

    const req = makeReq({
      serviceId: SERVICE_ID,
      callerWallet: CALLER_WALLET,
      paymentProof: PAYMENT_PROOF,
    });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBeUndefined(); // 200 implicit
    const body = ctx.body as Record<string, unknown>;
    expect(body.verified).toBe(true);
    expect(body.serviceId).toBe(SERVICE_ID);
    expect(body.callerWallet).toBe(CALLER_WALLET);
    expect(body).toHaveProperty("grossAmount");
    expect(body).toHaveProperty("platformFee");
    expect(body).toHaveProperty("providerNet");
  });

  it("rejects payment when no authorization exists", async () => {
    await redisMock.hset(`service:${SERVICE_ID}`, makeServiceRecord());
    // No auth record seeded

    const handler = await getPayVerifyHandler();
    if (!handler) throw new Error("pay/verify handler not found");

    const req = makeReq({
      serviceId: SERVICE_ID,
      callerWallet: CALLER_WALLET,
      paymentProof: PAYMENT_PROOF,
    });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(403);
    expect((ctx.body as Record<string, unknown>)?.error).toMatch(/[Aa]uthorization/);
  });

  it("enforces spend cap — rejects when spend would exceed cap", async () => {
    await redisMock.hset(`service:${SERVICE_ID}`, makeServiceRecord());
    // Auth with a spend cap equal to exactly one call — second call will exceed it
    await redisMock.hset(`auth:${CALLER_WALLET}:${SERVICE_ID}`, makeAuthRecord({
      spendCap: String(PRICE_PER_CALL),
      spent: String(PRICE_PER_CALL), // already at cap
    }));

    const handler = await getPayVerifyHandler();
    if (!handler) throw new Error("pay/verify handler not found");

    const req = makeReq({
      serviceId: SERVICE_ID,
      callerWallet: CALLER_WALLET,
      paymentProof: PAYMENT_PROOF,
    });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(403);
    expect((ctx.body as Record<string, unknown>)?.error).toMatch(/[Ss]pend cap/);
  });

  it("rejects when payment proof verification fails", async () => {
    await redisMock.hset(`service:${SERVICE_ID}`, makeServiceRecord());
    await redisMock.hset(`auth:${CALLER_WALLET}:${SERVICE_ID}`, makeAuthRecord());

    verifyProofMock.mockResolvedValue({ valid: false, error: "Invalid signature" });

    const handler = await getPayVerifyHandler();
    if (!handler) throw new Error("pay/verify handler not found");

    const req = makeReq({
      serviceId: SERVICE_ID,
      callerWallet: CALLER_WALLET,
      paymentProof: PAYMENT_PROOF,
    });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(402);
    expect((ctx.body as Record<string, unknown>)?.error).toMatch(/[Vv]erif/);
  });
});
