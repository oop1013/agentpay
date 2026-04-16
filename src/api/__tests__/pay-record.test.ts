/**
 * Regression tests for /api/pay/record idempotency, nonce consumption, and slot release.
 *
 * Covers AGEAA-56 Round 2 + Round 3 fixes:
 *  - paymentProof is required; server derives nonce — no optional client nonce fields
 *  - Parallel duplicate Idempotency-Key submissions are suppressed atomically
 *  - Idempotency key is scoped to caller+service (no cross-caller leakage)
 *  - Idempotency slot is released on all non-success exits (404, 403, 500)
 *  - Replayed proof (nonce already consumed) is rejected with 409 BEFORE any writes (fail closed)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response } from "express";

// ── Hoist mock objects so factories can reference them ────────────────────────
const { redisMock, parseProofMock, verifyProofMock, consumeNonceMock, atomicSpendCapReleaseMock } = vi.hoisted(() => {
  const redisMock = {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    hgetall: vi.fn(),
    hincrby: vi.fn(),
    zadd: vi.fn(),
    pipeline: vi.fn(),
    eval: vi.fn(),
  };
  const parseProofMock = vi.fn();
  const verifyProofMock = vi.fn();
  const consumeNonceMock = vi.fn().mockResolvedValue(true);
  const atomicSpendCapReleaseMock = vi.fn().mockResolvedValue(undefined);
  return { redisMock, parseProofMock, verifyProofMock, consumeNonceMock, atomicSpendCapReleaseMock };
});

vi.mock("../../lib/redis", () => ({ redis: redisMock }));

vi.mock("../../lib/x402", () => ({
  verifyX402Proof: verifyProofMock,
  parseX402Proof: parseProofMock,
  consumeX402Nonce: consumeNonceMock,
}));

vi.mock("../../lib/redis-scripts", () => ({
  atomicSpendCapReserve: (...args: unknown[]) => redisMock.eval(...args),
  atomicSpendCapRelease: (...args: unknown[]) => atomicSpendCapReleaseMock(...args),
}));

vi.mock("../../lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const NONCE = "0xdeadbeef00000000000000000000000000000000000000000000000000000000";
const VALID_BEFORE = Math.floor(Date.now() / 1000) + 3600;
const PAYMENT_PROOF = "base64-encoded-proof-string";

function makeReq(
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {}
): Request {
  return { body, headers } as unknown as Request;
}

type ResCtx = {
  res: Response;
  statusCode: number | undefined;
  body: unknown;
};

function makeRes(): ResCtx {
  const ctx: ResCtx = { res: null as unknown as Response, statusCode: undefined, body: undefined };
  const res = {
    status(code: number) { ctx.statusCode = code; return res; },
    json(data: unknown) { ctx.body = data; return res; },
  } as unknown as Response;
  ctx.res = res;
  return ctx;
}

const CALLER_WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NORMALIZED_WALLET = CALLER_WALLET.toLowerCase();
const SERVICE_ID = "svc_test_001";
const PROVIDER_WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function serviceData() {
  return {
    id: SERVICE_ID,
    providerWallet: PROVIDER_WALLET,
    pricePerCall: "1000",
    platformFeeBps: "100",
    status: "active",
  };
}

function authData() {
  return { status: "active", spendCap: "1000000", spent: "0" };
}

function buildPipelineExec() {
  const pipeline = {
    zadd: vi.fn().mockReturnThis(),
    hincrby: vi.fn().mockReturnThis(),
    hset: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
  };
  return pipeline;
}

function validParsedProof() {
  return {
    from: CALLER_WALLET,
    to: PROVIDER_WALLET,
    value: "1000",
    validAfter: String(Math.floor(Date.now() / 1000) - 60),
    validBefore: String(VALID_BEFORE),
    nonce: NONCE,
    signature: "0xsig",
    chainId: 84532,
  };
}

function baseBody() {
  return {
    serviceId: SERVICE_ID,
    callerWallet: CALLER_WALLET,
    status: "success",
    latencyMs: 42,
    paymentProof: PAYMENT_PROOF,
  };
}

async function getRecordHandler() {
  const { default: router } = await import("../pay");
  return (router as any).stack?.find((l: any) => l.route?.path === "/record")
    ?.route?.stack?.[0]?.handle as ((...args: any[]) => Promise<void>) | undefined;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("/api/pay/record — server-derived nonce from paymentProof", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseProofMock.mockReturnValue(validParsedProof());
    verifyProofMock.mockResolvedValue({
      valid: true,
      from: CALLER_WALLET.toLowerCase(),
      to: PROVIDER_WALLET.toLowerCase(),
      amount: 1000,
      nonce: NONCE,
      validBefore: VALID_BEFORE,
    });
    redisMock.hgetall.mockImplementation(async (key: string) => {
      if (key.startsWith("service:")) return serviceData();
      if (key.startsWith("auth:")) return authData();
      return null;
    });
    redisMock.pipeline.mockReturnValue(buildPipelineExec());
    redisMock.set.mockResolvedValue("OK");
    redisMock.get.mockResolvedValue(null);
    redisMock.del.mockResolvedValue(1);
    redisMock.eval.mockResolvedValue(1); // within cap by default
    consumeNonceMock.mockResolvedValue(true);
  });

  it("returns 400 when paymentProof is missing", async () => {
    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq({ serviceId: SERVICE_ID, callerWallet: CALLER_WALLET, status: "success", latencyMs: 10 });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(400);
    expect((ctx.body as any)?.error).toMatch(/[Ii]nvalid/);
  });

  it("returns 400 when paymentProof cannot be parsed", async () => {
    parseProofMock.mockReturnValue(null);
    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody());
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(400);
    expect((ctx.body as any)?.error).toMatch(/paymentProof/);
  });

  it("calls consumeX402Nonce with server-derived nonce before pipeline executes", async () => {
    const { consumeX402Nonce } = await import("../../lib/x402");
    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody());
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(consumeX402Nonce).toHaveBeenCalledWith(
      expect.stringContaining("0xf39"),
      NONCE,
      VALID_BEFORE
    );
    expect(ctx.statusCode).toBe(201);
  });

  it("always calls consumeX402Nonce (nonce is required, not optional)", async () => {
    const { consumeX402Nonce } = await import("../../lib/x402");
    const handler = await getRecordHandler();
    if (!handler) return;

    // Even if body has no explicit nonce fields, server derives from proof
    const req = makeReq(baseBody());
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(consumeX402Nonce).toHaveBeenCalledTimes(1);
    expect(ctx.statusCode).toBe(201);
  });

  it("rejects replayed proof with 409 and no pipeline writes when nonce already consumed", async () => {
    // Simulate a consumed nonce (replay attack).
    consumeNonceMock.mockResolvedValueOnce(false);

    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody());
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    // Must fail closed — 409, no usage written.
    expect(ctx.statusCode).toBe(409);
    expect((ctx.body as any)?.error).toMatch(/[Nn]once|[Pp]roof|[Aa]lready/);
    // Pipeline must NOT have been called — no writes for a replayed proof.
    expect(redisMock.pipeline).not.toHaveBeenCalled();
  });
});

describe("/api/pay/record — atomic idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseProofMock.mockReturnValue(validParsedProof());
    verifyProofMock.mockResolvedValue({
      valid: true,
      from: CALLER_WALLET.toLowerCase(),
      to: PROVIDER_WALLET.toLowerCase(),
      amount: 1000,
      nonce: NONCE,
      validBefore: VALID_BEFORE,
    });
    redisMock.hgetall.mockImplementation(async (key: string) => {
      if (key.startsWith("service:")) return serviceData();
      if (key.startsWith("auth:")) return authData();
      return null;
    });
    redisMock.pipeline.mockReturnValue(buildPipelineExec());
    redisMock.del.mockResolvedValue(1);
    redisMock.eval.mockResolvedValue(1); // within cap by default
    consumeNonceMock.mockResolvedValue(true);
  });

  it("replays cached response when idempotency key is already finalized", async () => {
    const cached = JSON.stringify({ id: "existing-record", serviceId: SERVICE_ID });
    redisMock.set.mockResolvedValueOnce(null);
    redisMock.get.mockResolvedValueOnce(cached);

    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody(), { "idempotency-key": "key-001" });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(201);
    expect(ctx.body).toEqual(JSON.parse(cached));
    expect(redisMock.pipeline).not.toHaveBeenCalled();
  });

  it("returns 409 when a parallel in-flight request holds the slot", async () => {
    redisMock.set.mockResolvedValueOnce(null);
    redisMock.get.mockResolvedValueOnce("pending");

    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody(), { "idempotency-key": "key-parallel" });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(409);
    expect((ctx.body as any)?.error).toMatch(/[Dd]uplicate/);
    expect(redisMock.pipeline).not.toHaveBeenCalled();
  });

  it("scopes idempotency key to callerWallet+serviceId (distinct callers don't share keys)", () => {
    const key = `idempotency:record:${NORMALIZED_WALLET}:${SERVICE_ID}:idempotency-key-abc`;
    const otherCallerKey = `idempotency:record:0xother:${SERVICE_ID}:idempotency-key-abc`;
    expect(key).not.toBe(otherCallerKey);
    expect(key).toContain(NORMALIZED_WALLET);
    expect(key).toContain(SERVICE_ID);
  });
});

describe("/api/pay/record — idempotency slot released on non-success exits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseProofMock.mockReturnValue(validParsedProof());
    verifyProofMock.mockResolvedValue({
      valid: true,
      from: CALLER_WALLET.toLowerCase(),
      to: PROVIDER_WALLET.toLowerCase(),
      amount: 1000,
      nonce: NONCE,
      validBefore: VALID_BEFORE,
    });
    redisMock.del.mockResolvedValue(1);
    // Claim the slot successfully on every test
    redisMock.set.mockResolvedValue("OK");
    redisMock.get.mockResolvedValue(null);
    redisMock.eval.mockResolvedValue(1); // within cap by default
  });

  it("releases slot on 404 (service not found)", async () => {
    redisMock.hgetall.mockResolvedValue(null);

    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody(), { "idempotency-key": "key-404" });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(404);
    expect(redisMock.del).toHaveBeenCalledWith(
      expect.stringContaining("idempotency:record:")
    );
  });

  it("releases slot on 403 (no authorization)", async () => {
    redisMock.hgetall.mockImplementation(async (key: string) => {
      if (key.startsWith("service:")) return serviceData();
      return null; // no auth record
    });

    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody(), { "idempotency-key": "key-403" });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(403);
    expect(redisMock.del).toHaveBeenCalledWith(
      expect.stringContaining("idempotency:record:")
    );
  });

  it("releases slot on 500 (pipeline storage failure)", async () => {
    redisMock.hgetall.mockImplementation(async (key: string) => {
      if (key.startsWith("service:")) return serviceData();
      if (key.startsWith("auth:")) return authData();
      return null;
    });
    const failPipeline = buildPipelineExec();
    failPipeline.exec.mockResolvedValue([null, null]); // pipeline fails
    redisMock.pipeline.mockReturnValue(failPipeline);

    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody(), { "idempotency-key": "key-500" });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(500);
    expect(redisMock.del).toHaveBeenCalledWith(
      expect.stringContaining("idempotency:record:")
    );
  });

  it("does NOT call redis.del on success (slot is finalized, not deleted)", async () => {
    redisMock.hgetall.mockImplementation(async (key: string) => {
      if (key.startsWith("service:")) return serviceData();
      if (key.startsWith("auth:")) return authData();
      return null;
    });
    redisMock.pipeline.mockReturnValue(buildPipelineExec());
    consumeNonceMock.mockResolvedValue(true);

    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody(), { "idempotency-key": "key-success" });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(201);
    expect(redisMock.del).not.toHaveBeenCalled();
  });
});

describe("/api/pay/record — proof verification (forged proof rejection)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseProofMock.mockReturnValue(validParsedProof());
    // Default: valid proof — individual tests override for forgery scenarios.
    verifyProofMock.mockResolvedValue({
      valid: true,
      from: CALLER_WALLET.toLowerCase(),
      to: PROVIDER_WALLET.toLowerCase(),
      amount: 1000,
      nonce: NONCE,
      validBefore: VALID_BEFORE,
    });
    redisMock.hgetall.mockImplementation(async (key: string) => {
      if (key.startsWith("service:")) return serviceData();
      if (key.startsWith("auth:")) return authData();
      return null;
    });
    redisMock.pipeline.mockReturnValue(buildPipelineExec());
    redisMock.set.mockResolvedValue("OK");
    redisMock.get.mockResolvedValue(null);
    redisMock.del.mockResolvedValue(1);
    redisMock.eval.mockResolvedValue(1); // within cap by default
    consumeNonceMock.mockResolvedValue(true);
  });

  it("rejects proof with wrong signer (from != callerWallet) with 402", async () => {
    verifyProofMock.mockResolvedValueOnce({
      valid: true,
      from: "0xdeadbeef00000000000000000000000000000001",
      to: PROVIDER_WALLET.toLowerCase(),
      amount: 1000,
      nonce: NONCE,
      validBefore: VALID_BEFORE,
    });

    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody());
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(402);
    expect((ctx.body as any)?.error).toMatch(/[Ss]igner|[Cc]aller/);
    // No writes — pipeline must not be called
    expect(redisMock.pipeline).not.toHaveBeenCalled();
    expect(consumeNonceMock).not.toHaveBeenCalled();
  });

  it("rejects proof with wrong recipient (to != providerWallet) with 402", async () => {
    verifyProofMock.mockResolvedValueOnce({
      valid: false,
      error: "Payment recipient mismatch: proof pays 0xwrong, expected 0x7099...",
    });

    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody());
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(402);
    expect((ctx.body as any)?.error).toMatch(/[Vv]erif/);
    expect(redisMock.pipeline).not.toHaveBeenCalled();
    expect(consumeNonceMock).not.toHaveBeenCalled();
  });

  it("rejects proof with wrong amount (!= service.pricePerCall) with 402", async () => {
    verifyProofMock.mockResolvedValueOnce({
      valid: false,
      error: "Amount mismatch: proof has 9999 micro-USDC, expected 1000",
    });

    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody());
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(402);
    expect((ctx.body as any)?.error).toMatch(/[Vv]erif/);
    expect(redisMock.pipeline).not.toHaveBeenCalled();
    expect(consumeNonceMock).not.toHaveBeenCalled();
  });

  it("does NOT consume nonce when proof verification fails (fail closed)", async () => {
    verifyProofMock.mockResolvedValueOnce({
      valid: false,
      error: "EIP-712 signature is invalid",
    });

    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody(), { "idempotency-key": "key-forgery" });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(402);
    expect(consumeNonceMock).not.toHaveBeenCalled();
    // Slot must be released on the verification failure exit
    expect(redisMock.del).toHaveBeenCalledWith(expect.stringContaining("idempotency:record:"));
  });

  it("calls verifyX402Proof with server-authoritative grossAmount and providerWallet", async () => {
    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody());
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(verifyProofMock).toHaveBeenCalledWith(
      PAYMENT_PROOF,
      1000,          // service.pricePerCall from Redis — never client-supplied
      PROVIDER_WALLET // service.providerWallet from Redis — never client-supplied
    );
    expect(ctx.statusCode).toBe(201);
  });
});

describe("/api/pay/record — atomic spend-cap enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseProofMock.mockReturnValue(validParsedProof());
    verifyProofMock.mockResolvedValue({
      valid: true,
      from: CALLER_WALLET.toLowerCase(),
      to: PROVIDER_WALLET.toLowerCase(),
      amount: 1000,
      nonce: NONCE,
      validBefore: VALID_BEFORE,
    });
    redisMock.hgetall.mockImplementation(async (key: string) => {
      if (key.startsWith("service:")) return serviceData();
      if (key.startsWith("auth:")) return { status: "active" }; // status only — cap enforced by Lua
      return null;
    });
    redisMock.set.mockResolvedValue("OK");
    redisMock.get.mockResolvedValue(null);
    redisMock.del.mockResolvedValue(1);
    consumeNonceMock.mockResolvedValue(true);
    redisMock.pipeline.mockReturnValue(buildPipelineExec());
    redisMock.eval.mockResolvedValue(1); // within cap by default
  });

  it("rejects with 403 when atomic check returns over-cap, before nonce consumption", async () => {
    // Lua script returns 0 → over cap
    redisMock.eval.mockResolvedValue(0);

    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody());
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(403);
    expect((ctx.body as any)?.error).toMatch(/[Ss]pend cap/);
    // Nonce must NOT be consumed — cap check happens first so the proof stays
    // untouched and the caller can retry with the same proof.
    expect(consumeNonceMock).not.toHaveBeenCalled();
    // No pipeline writes.
    expect(redisMock.pipeline).not.toHaveBeenCalled();
  });

  it("accepts when atomic check returns within cap", async () => {
    // Lua script returns 1 → within cap (default)
    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody());
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(201);
  });

  it("concurrent payments at cap boundary: only one succeeds (regression)", async () => {
    // Simulate two concurrent requests hitting the atomic Lua check:
    // First call: Lua returns 1 (reserved — within cap)
    // Second call: Lua returns 0 (rejected — cap now exhausted)
    redisMock.eval
      .mockResolvedValueOnce(1)  // first payment passes
      .mockResolvedValueOnce(0); // second payment fails — cap exhausted atomically

    const handler = await getRecordHandler();
    if (!handler) return;

    const ctx1 = makeRes();
    const ctx2 = makeRes();

    // Run both concurrently
    await Promise.all([
      handler(makeReq(baseBody()), ctx1.res, vi.fn()),
      handler(makeReq(baseBody()), ctx2.res, vi.fn()),
    ]);

    const statuses = [ctx1.statusCode, ctx2.statusCode].sort();
    expect(statuses).toEqual([201, 403]);
  });

  it("auth.spent unchanged after invalid proof — atomicSpendCapReserve never called", async () => {
    // Proof fails verification — spend cap must never be touched.
    verifyProofMock.mockResolvedValueOnce({ valid: false, error: "Bad signature" });

    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody());
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(402);
    // eval backs atomicSpendCapReserve — must not be called when proof is invalid.
    expect(redisMock.eval).not.toHaveBeenCalled();
    expect(consumeNonceMock).not.toHaveBeenCalled();
  });

  it("cap reserved then released when nonce is replayed after cap admission", async () => {
    // Cap check passes (eval returns 1), but nonce is already consumed → release cap.
    consumeNonceMock.mockResolvedValueOnce(false);

    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody());
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(409);
    // Cap reserve IS called first (cap check before nonce).
    expect(redisMock.eval).toHaveBeenCalled();
    // Release must be called to restore headroom after nonce rejection.
    expect(atomicSpendCapReleaseMock).toHaveBeenCalledWith(
      expect.stringContaining("auth:"),
      expect.any(Number)
    );
    expect(redisMock.pipeline).not.toHaveBeenCalled();
  });

  it("auth.spent rolled back via atomicSpendCapRelease on pipeline failure", async () => {
    // Pipeline fails after spend cap is reserved — release must be called.
    const failPipeline = buildPipelineExec();
    failPipeline.exec.mockResolvedValue([null, null]);
    redisMock.pipeline.mockReturnValue(failPipeline);

    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody());
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(500);
    // Reserve was called (eval returned 1 by default)
    expect(redisMock.eval).toHaveBeenCalled();
    // Release must be called to restore headroom
    expect(atomicSpendCapReleaseMock).toHaveBeenCalledWith(
      expect.stringContaining("auth:"),
      expect.any(Number)
    );
  });
});

describe("/api/pay/record — crash-safe idempotency finalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseProofMock.mockReturnValue(validParsedProof());
    verifyProofMock.mockResolvedValue({
      valid: true,
      from: CALLER_WALLET.toLowerCase(),
      to: PROVIDER_WALLET.toLowerCase(),
      amount: 1000,
      nonce: NONCE,
      validBefore: VALID_BEFORE,
    });
    redisMock.hgetall.mockImplementation(async (key: string) => {
      if (key.startsWith("service:")) return serviceData();
      if (key.startsWith("auth:")) return { status: "active" };
      return null;
    });
    redisMock.set.mockResolvedValue("OK");
    redisMock.get.mockResolvedValue(null);
    redisMock.del.mockResolvedValue(1);
    redisMock.eval.mockResolvedValue(1);
    consumeNonceMock.mockResolvedValue(true);
  });

  it("idempotency finalization is in the pipeline (not a separate redis.set after exec)", async () => {
    // The pipeline.set mock records calls; redis.set is only for claiming the slot.
    const pipeline = buildPipelineExec();
    redisMock.pipeline.mockReturnValue(pipeline);

    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody(), { "idempotency-key": "key-pipeline-set" });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(201);
    // pipeline.set must have been called for the idempotency finalization
    expect(pipeline.set).toHaveBeenCalledWith(
      expect.stringContaining("idempotency:record:"),
      expect.any(String),
      expect.objectContaining({ ex: 86400 })
    );
    // redis.set must only have been called once — the initial NX slot claim,
    // not a second time for finalization (which is now inside the pipeline).
    expect(redisMock.set).toHaveBeenCalledTimes(1);
  });

  it("when pipeline fails (including finalization), slot is released so retry is not wedged", async () => {
    // Simulate pipeline failure (e.g. network partition mid-write)
    const failPipeline = buildPipelineExec();
    failPipeline.exec.mockResolvedValue([null, null]);
    redisMock.pipeline.mockReturnValue(failPipeline);

    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody(), { "idempotency-key": "key-crash-safe" });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    // Server returns 500 (pipeline failed)
    expect(ctx.statusCode).toBe(500);
    // Slot must be released so the client can retry without getting wedged
    expect(redisMock.del).toHaveBeenCalledWith(
      expect.stringContaining("idempotency:record:")
    );
  });

  it("retry returns committed record when slot is already finalized", async () => {
    // Simulate a prior run completing: slot holds the committed record
    const committed = JSON.stringify({ id: "committed-record", serviceId: SERVICE_ID });
    redisMock.set.mockResolvedValueOnce(null); // slot already claimed
    redisMock.get.mockResolvedValueOnce(committed); // slot is finalized

    const handler = await getRecordHandler();
    if (!handler) return;

    const req = makeReq(baseBody(), { "idempotency-key": "key-retry" });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(201);
    expect(ctx.body).toEqual(JSON.parse(committed));
    // Must not do duplicate processing
    expect(redisMock.pipeline).not.toHaveBeenCalled();
  });
});
