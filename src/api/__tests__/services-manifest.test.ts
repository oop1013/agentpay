/**
 * Unit tests for GET /api/services/:id/manifest
 *
 * Covers AGEAA-90 manifest v0 endpoint:
 *  - Returns valid manifest JSON matching schema for an active service
 *  - Returns 404 when service is not found in Redis
 *  - Manifest fields map correctly from stored service record
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response } from "express";

const { redisMock } = vi.hoisted(() => {
  const redisMock = {
    hgetall: vi.fn(),
    hset: vi.fn(),
    hincrby: vi.fn(),
    scan: vi.fn(),
  };
  return { redisMock };
});

vi.mock("../../lib/redis", () => ({ redis: redisMock }));
vi.mock("../../lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(params: Record<string, string> = {}): Request {
  return { params, body: {}, headers: {} } as unknown as Request;
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

const SERVICE_ID = "svc_test_manifest_001";
const PROVIDER_WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const CREATED_AT = "2026-04-18T00:00:00.000Z";

function fullServiceData() {
  return {
    id: SERVICE_ID,
    providerWallet: PROVIDER_WALLET,
    name: "Token Price API",
    endpoint: "https://example.com/api/price",
    pricePerCall: "10000",
    platformFeeBps: "100",
    description: "Real-time token prices",
    category: "general",
    status: "active",
    totalCalls: "5",
    grossVolume: "50000",
    totalEarned: "49500",
    totalFees: "500",
    createdAt: CREATED_AT,
  };
}

async function getManifestHandler() {
  const { default: router } = await import("../services");
  const stack = (router as any).stack as any[];
  return stack.find(
    (l) => l.route?.path === "/:id/manifest" && l.route?.methods?.get
  )?.route?.stack?.[0]?.handle as ((...args: any[]) => Promise<void>) | undefined;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/services/:id/manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when service is not found in Redis", async () => {
    redisMock.hgetall.mockResolvedValue(null);

    const handler = await getManifestHandler();
    if (!handler) throw new Error("manifest handler not found on router");

    const req = makeReq({ id: "svc_missing" });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(404);
    expect((ctx.body as any)?.error).toMatch(/[Nn]ot [Ff]ound/);
  });

  it("returns 404 when Redis returns an empty object", async () => {
    redisMock.hgetall.mockResolvedValue({});

    const handler = await getManifestHandler();
    if (!handler) throw new Error("manifest handler not found on router");

    const req = makeReq({ id: "svc_empty" });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(404);
  });

  it("returns manifest JSON with correct manifestVersion", async () => {
    redisMock.hgetall.mockResolvedValue(fullServiceData());

    const handler = await getManifestHandler();
    if (!handler) throw new Error("manifest handler not found on router");

    const req = makeReq({ id: SERVICE_ID });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBeUndefined(); // no explicit status → 200
    expect((ctx.body as any)?.manifestVersion).toBe("0.1.0");
  });

  it("maps service fields to manifest schema correctly", async () => {
    redisMock.hgetall.mockResolvedValue(fullServiceData());

    const handler = await getManifestHandler();
    if (!handler) throw new Error("manifest handler not found on router");

    const req = makeReq({ id: SERVICE_ID });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    const manifest = ctx.body as any;
    expect(manifest.serviceId).toBe(SERVICE_ID);
    expect(manifest.name).toBe("Token Price API");
    expect(manifest.description).toBe("Real-time token prices");
    expect(manifest.provider.wallet).toBe(PROVIDER_WALLET);
    expect(manifest.endpoint).toBe("https://example.com/api/price");
    expect(manifest.status).toBe("active");
    expect(manifest.createdAt).toBe(CREATED_AT);
  });

  it("maps pricing fields correctly with numeric coercion", async () => {
    redisMock.hgetall.mockResolvedValue(fullServiceData());

    const handler = await getManifestHandler();
    if (!handler) throw new Error("manifest handler not found on router");

    const req = makeReq({ id: SERVICE_ID });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    const pricing = (ctx.body as any)?.pricing;
    expect(pricing.model).toBe("per_call");
    expect(pricing.amount).toBe(10000);
    expect(pricing.currency).toBe("USDC");
    expect(pricing.unit).toBe("micro-USDC");
    expect(pricing.platformFeeBps).toBe(100);
  });

  it("capabilities is always an empty array in v0", async () => {
    redisMock.hgetall.mockResolvedValue(fullServiceData());

    const handler = await getManifestHandler();
    if (!handler) throw new Error("manifest handler not found on router");

    const req = makeReq({ id: SERVICE_ID });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect((ctx.body as any)?.capabilities).toEqual([]);
  });

  it("reads from Redis key service:<id>", async () => {
    redisMock.hgetall.mockResolvedValue(fullServiceData());

    const handler = await getManifestHandler();
    if (!handler) throw new Error("manifest handler not found on router");

    const req = makeReq({ id: SERVICE_ID });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(redisMock.hgetall).toHaveBeenCalledWith(`service:${SERVICE_ID}`);
  });

  it("returns 410 Gone for a paused service with no manifest body", async () => {
    const paused = { ...fullServiceData(), status: "paused" };
    redisMock.hgetall.mockResolvedValue(paused);

    const handler = await getManifestHandler();
    if (!handler) throw new Error("manifest handler not found on router");

    const req = makeReq({ id: SERVICE_ID });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect(ctx.statusCode).toBe(410);
    expect(ctx.body).toBeUndefined();
    expect(ctx.ended).toBe(true);
  });

  it("handles missing description gracefully (defaults to empty string)", async () => {
    const data = { ...fullServiceData(), description: "" };
    redisMock.hgetall.mockResolvedValue(data);

    const handler = await getManifestHandler();
    if (!handler) throw new Error("manifest handler not found on router");

    const req = makeReq({ id: SERVICE_ID });
    const ctx = makeRes();
    await handler(req, ctx.res, vi.fn());

    expect((ctx.body as any)?.description).toBe("");
  });
});
