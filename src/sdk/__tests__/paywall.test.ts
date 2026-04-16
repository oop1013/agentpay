/**
 * Tests for paywall middleware nonce consumption and replay protection.
 *
 * Covers AGEAA-56 Round 2 Fix 2:
 *  - consumeX402Nonce is called after all checks pass, before next()
 *  - A replayed proof (nonce already consumed) is rejected with 402
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response, NextFunction } from "express";

// ── Hoist mock objects ────────────────────────────────────────────────────────
const { redisMock, verifyProofMock, parseProofMock, consumeNonceMock, settlePaymentMock, atomicSpendCapReleaseMock } = vi.hoisted(() => {
  const redisMock = {
    hgetall: vi.fn(),
    pipeline: vi.fn(),
    hincrby: vi.fn(),
    zadd: vi.fn(),
    hset: vi.fn(),
    eval: vi.fn(),
  };
  const verifyProofMock = vi.fn();
  const parseProofMock = vi.fn();
  const consumeNonceMock = vi.fn();
  const settlePaymentMock = vi.fn();
  const atomicSpendCapReleaseMock = vi.fn().mockResolvedValue(undefined);
  return { redisMock, verifyProofMock, parseProofMock, consumeNonceMock, settlePaymentMock, atomicSpendCapReleaseMock };
});

vi.mock("../../lib/redis", () => ({ redis: redisMock }));
vi.mock("../../lib/x402", () => ({
  verifyX402Proof: verifyProofMock,
  parseX402Proof: parseProofMock,
  consumeX402Nonce: consumeNonceMock,
}));
vi.mock("../../lib/settlement", () => ({
  settlePayment: settlePaymentMock,
}));
vi.mock("../../lib/redis-scripts", () => ({
  atomicSpendCapReserve: (...args: unknown[]) => redisMock.eval(...args),
  atomicSpendCapRelease: (...args: unknown[]) => atomicSpendCapReleaseMock(...args),
}));

import { paywall } from "../paywall";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SERVICE_ID = "svc_paywall_test";
const CALLER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const PROVIDER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const NONCE = "0xbeef000000000000000000000000000000000000000000000000000000000001";
const VALID_BEFORE = Math.floor(Date.now() / 1000) + 3600;
const PROOF_STR = "base64-encoded-proof";

function makeService() {
  return {
    status: "active",
    name: "Test Service",
    pricePerCall: "1000",
    providerWallet: PROVIDER,
    platformFeeBps: "100",
  };
}

function makeAuth() {
  return { status: "active", spendCap: "1000000", spent: "0" };
}

function makeReq(paymentProof?: string, callerHeader?: string): Request {
  return {
    headers: {
      "x-402-payment": paymentProof ?? PROOF_STR,
      "x-402-caller": callerHeader ?? CALLER,
    },
    on: vi.fn(),
  } as unknown as Request;
}

type ResCtx = { statusCode?: number; body?: unknown };
function makeRes(): { res: Response; ctx: ResCtx } {
  const ctx: ResCtx = {};
  const res = {
    status(code: number) { ctx.statusCode = code; return res; },
    json(data: unknown) { ctx.body = data; return res; },
    statusCode: 200,
    on: vi.fn(),
  } as unknown as Response;
  return { res, ctx };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("paywall — nonce consumption on successful payment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settlePaymentMock.mockResolvedValue({
      success: false,
      error: "BASE_SEPOLIA_RPC_URL or PROVIDER_PRIVATE_KEY not set",
    });
    redisMock.hgetall.mockImplementation(async (key: string) => {
      if (key === `service:${SERVICE_ID}`) return makeService();
      if (key.startsWith("auth:")) return makeAuth();
      return null;
    });
    verifyProofMock.mockResolvedValue({
      valid: true,
      from: CALLER,
      to: PROVIDER,
      amount: 1000,
      nonce: NONCE,
      validBefore: VALID_BEFORE,
    });
    parseProofMock.mockReturnValue({
      from: CALLER,
      to: PROVIDER,
      value: "1000",
      validAfter: "0",
      validBefore: String(VALID_BEFORE),
      nonce: NONCE,
      signature: "0xsig",
      chainId: 84532,
    });
    consumeNonceMock.mockResolvedValue(true);
    redisMock.eval.mockResolvedValue(1); // within cap by default
  });

  it("calls consumeX402Nonce with nonce from verified proof before calling next()", async () => {
    const next = vi.fn();
    const { res, ctx } = makeRes();
    const req = makeReq();

    const middleware = paywall({ serviceId: SERVICE_ID });
    await middleware(req, res, next as NextFunction);

    expect(consumeNonceMock).toHaveBeenCalledWith(CALLER, NONCE, VALID_BEFORE);
    expect(next).toHaveBeenCalled();
    expect(ctx.statusCode).toBeUndefined(); // no error response set
  });

  it("calls consumeX402Nonce before calling next() — ordering guarantee", async () => {
    const callOrder: string[] = [];
    consumeNonceMock.mockImplementation(async () => {
      callOrder.push("consumeNonce");
      return true;
    });
    const next = vi.fn().mockImplementation(() => {
      callOrder.push("next");
    });

    const middleware = paywall({ serviceId: SERVICE_ID });
    await middleware(makeReq(), makeRes().res, next as NextFunction);

    expect(callOrder).toEqual(["consumeNonce", "next"]);
  });
});

describe("paywall — replay rejection (nonce already consumed)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settlePaymentMock.mockResolvedValue({
      success: false,
      error: "BASE_SEPOLIA_RPC_URL or PROVIDER_PRIVATE_KEY not set",
    });
    redisMock.hgetall.mockImplementation(async (key: string) => {
      if (key === `service:${SERVICE_ID}`) return makeService();
      if (key.startsWith("auth:")) return makeAuth();
      return null;
    });
    verifyProofMock.mockResolvedValue({
      valid: true,
      from: CALLER,
      to: PROVIDER,
      amount: 1000,
      nonce: NONCE,
      validBefore: VALID_BEFORE,
    });
    parseProofMock.mockReturnValue({
      from: CALLER,
      to: PROVIDER,
      value: "1000",
      validAfter: "0",
      validBefore: String(VALID_BEFORE),
      nonce: NONCE,
      signature: "0xsig",
      chainId: 84532,
    });
    redisMock.eval.mockResolvedValue(1); // within cap by default
  });

  it("returns 402 and does NOT call next() when nonce is already consumed", async () => {
    // Simulate replay: consumeX402Nonce returns false (nonce already spent)
    consumeNonceMock.mockResolvedValue(false);

    const next = vi.fn();
    const { res, ctx } = makeRes();

    const middleware = paywall({ serviceId: SERVICE_ID });
    await middleware(makeReq(), res, next as NextFunction);

    expect(ctx.statusCode).toBe(402);
    expect((ctx.body as any)?.error).toMatch(/replay/i);
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts the first request and rejects the replay", async () => {
    // First call: nonce fresh
    consumeNonceMock.mockResolvedValueOnce(true);
    const next1 = vi.fn();
    const { res: res1 } = makeRes();
    const middleware = paywall({ serviceId: SERVICE_ID });
    await middleware(makeReq(), res1, next1 as NextFunction);
    expect(next1).toHaveBeenCalled();

    // Second call (replay): nonce already consumed
    consumeNonceMock.mockResolvedValueOnce(false);
    const next2 = vi.fn();
    const { res: res2, ctx: ctx2 } = makeRes();
    await middleware(makeReq(), res2, next2 as NextFunction);
    expect(ctx2.statusCode).toBe(402);
    expect(next2).not.toHaveBeenCalled();
  });
});

describe("paywall — settlement NOT called when auth/cap checks fail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settlePaymentMock.mockResolvedValue({
      success: false,
      error: "BASE_SEPOLIA_RPC_URL or PROVIDER_PRIVATE_KEY not set",
    });
    verifyProofMock.mockResolvedValue({
      valid: true,
      from: CALLER,
      to: PROVIDER,
      amount: 1000,
      nonce: NONCE,
      validBefore: VALID_BEFORE,
    });
    parseProofMock.mockReturnValue({
      from: CALLER,
      to: PROVIDER,
      value: "1000",
      validAfter: "0",
      validBefore: String(VALID_BEFORE),
      nonce: NONCE,
      signature: "0xsig",
      chainId: 84532,
    });
    // Service always active
    redisMock.hgetall.mockImplementation(async (key: string) => {
      if (key === `service:${SERVICE_ID}`) return makeService();
      return null; // no auth by default — overridden per test
    });
    redisMock.eval.mockResolvedValue(1); // within cap by default
    consumeNonceMock.mockResolvedValue(true);
  });

  it("does NOT call settlePayment when auth record is missing", async () => {
    // hgetall returns null for auth key (no auth found)
    redisMock.hgetall.mockImplementation(async (key: string) => {
      if (key === `service:${SERVICE_ID}`) return makeService();
      return null;
    });

    const next = vi.fn();
    const { res, ctx } = makeRes();
    const middleware = paywall({ serviceId: SERVICE_ID });
    await middleware(makeReq(), res, next as NextFunction);

    expect(ctx.statusCode).toBe(403);
    expect(settlePaymentMock).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("does NOT call settlePayment when auth status is inactive", async () => {
    redisMock.hgetall.mockImplementation(async (key: string) => {
      if (key === `service:${SERVICE_ID}`) return makeService();
      if (key.startsWith("auth:")) return { status: "revoked", spendCap: "1000000", spent: "0" };
      return null;
    });

    const next = vi.fn();
    const { res, ctx } = makeRes();
    const middleware = paywall({ serviceId: SERVICE_ID });
    await middleware(makeReq(), res, next as NextFunction);

    expect(ctx.statusCode).toBe(403);
    expect(settlePaymentMock).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("does NOT call settlePayment when atomic spend-cap check is over cap", async () => {
    // Atomic Lua check returns 0 → over cap; auth status still checked via hgetall
    redisMock.hgetall.mockImplementation(async (key: string) => {
      if (key === `service:${SERVICE_ID}`) return makeService();
      if (key.startsWith("auth:")) return { status: "active" }; // status only
      return null;
    });
    redisMock.eval.mockResolvedValue(0); // Lua: over cap

    const next = vi.fn();
    const { res, ctx } = makeRes();
    const middleware = paywall({ serviceId: SERVICE_ID });
    await middleware(makeReq(), res, next as NextFunction);

    expect(ctx.statusCode).toBe(403);
    expect((ctx.body as any)?.error).toMatch(/spend cap/i);
    expect(settlePaymentMock).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("concurrent payments at cap boundary: only one proceeds to settlement (regression)", async () => {
    // Simulate two concurrent requests: Lua returns 1 for first, 0 for second
    redisMock.hgetall.mockImplementation(async (key: string) => {
      if (key === `service:${SERVICE_ID}`) return makeService();
      if (key.startsWith("auth:")) return { status: "active" };
      return null;
    });
    redisMock.eval
      .mockResolvedValueOnce(1)  // first payment reserved
      .mockResolvedValueOnce(0); // second payment rejected — cap exhausted atomically

    const next1 = vi.fn();
    const next2 = vi.fn();
    const { res: res1, ctx: ctx1 } = makeRes();
    const { res: res2, ctx: ctx2 } = makeRes();
    const middleware = paywall({ serviceId: SERVICE_ID });

    await Promise.all([
      middleware(makeReq(), res1, next1 as NextFunction),
      middleware(makeReq(), res2, next2 as NextFunction),
    ]);

    const nextCalls = [next1.mock.calls.length, next2.mock.calls.length];
    // Exactly one should have proceeded past the cap check
    expect(nextCalls.filter((c) => c > 0)).toHaveLength(1);
    expect(nextCalls.filter((c) => c === 0)).toHaveLength(1);

    const statuses = [ctx1.statusCode, ctx2.statusCode].filter(Boolean);
    expect(statuses).toContain(403);
  });
});

describe("paywall — spend-cap rollback on post-reservation failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.hgetall.mockImplementation(async (key: string) => {
      if (key === `service:${SERVICE_ID}`) return makeService();
      if (key.startsWith("auth:")) return makeAuth();
      return null;
    });
    verifyProofMock.mockResolvedValue({
      valid: true,
      from: CALLER,
      to: PROVIDER,
      amount: 1000,
      nonce: NONCE,
      validBefore: VALID_BEFORE,
    });
    parseProofMock.mockReturnValue({
      from: CALLER,
      to: PROVIDER,
      value: "1000",
      validAfter: "0",
      validBefore: String(VALID_BEFORE),
      nonce: NONCE,
      signature: "0xsig",
      chainId: 84532,
    });
    consumeNonceMock.mockResolvedValue(true);
    redisMock.eval.mockResolvedValue(1); // within cap by default
  });

  it("releases spend cap when on-chain settlement fails", async () => {
    // Settlement is configured but fails — must release the reserved cap.
    settlePaymentMock.mockResolvedValue({
      success: false,
      error: "Transaction reverted: insufficient balance",
    });

    const next = vi.fn();
    const { res, ctx } = makeRes();
    const middleware = paywall({ serviceId: SERVICE_ID });
    await middleware(makeReq(), res, next as NextFunction);

    expect(ctx.statusCode).toBe(402);
    expect((ctx.body as any)?.error).toMatch(/settlement/i);
    expect(next).not.toHaveBeenCalled();
    // Spend cap must be released so the caller can retry.
    expect(atomicSpendCapReleaseMock).toHaveBeenCalledWith(
      expect.stringContaining("auth:"),
      expect.any(Number)
    );
  });

  it("does NOT release spend cap when settlement is skipped (dev/test mode)", async () => {
    // Settlement not configured — skipped, not failed. Cap stays reserved.
    settlePaymentMock.mockResolvedValue({
      success: false,
      error: "BASE_SEPOLIA_RPC_URL or PROVIDER_PRIVATE_KEY not set",
    });

    const next = vi.fn();
    const { res } = makeRes();
    const middleware = paywall({ serviceId: SERVICE_ID });
    await middleware(makeReq(), res, next as NextFunction);

    expect(next).toHaveBeenCalled();
    // No rollback — settlement was intentionally skipped.
    expect(atomicSpendCapReleaseMock).not.toHaveBeenCalled();
  });

  it("auth.spent unchanged when nonce replay is detected before cap reservation", async () => {
    // Nonce already consumed — must reject before reserving spend cap.
    consumeNonceMock.mockResolvedValue(false);
    settlePaymentMock.mockResolvedValue({ success: false, error: "not configured" });

    const next = vi.fn();
    const { res, ctx } = makeRes();
    const middleware = paywall({ serviceId: SERVICE_ID });
    await middleware(makeReq(), res, next as NextFunction);

    expect(ctx.statusCode).toBe(402);
    expect((ctx.body as any)?.error).toMatch(/replay/i);
    // Cap was never reserved — no release needed.
    expect(redisMock.eval).not.toHaveBeenCalled();
    expect(atomicSpendCapReleaseMock).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
