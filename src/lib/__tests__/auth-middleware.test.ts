import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import { requireApiKey } from "../auth-middleware";

function makeReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

function makeRes(): { res: Response; status: number | undefined; body: unknown } {
  const ctx: { res: Response; status: number | undefined; body: unknown } = {
    res: null as unknown as Response,
    status: undefined,
    body: undefined,
  };
  const res = {
    status(code: number) {
      ctx.status = code;
      return res;
    },
    json(data: unknown) {
      ctx.body = data;
      return res;
    },
  } as unknown as Response;
  ctx.res = res;
  return ctx;
}

describe("requireApiKey", () => {
  const originalKey = process.env.AGENTPAY_API_KEY;
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.AGENTPAY_API_KEY = originalKey;
    process.env.NODE_ENV = originalEnv;
  });

  it("allows all requests in dev mode when no key configured", () => {
    delete process.env.AGENTPAY_API_KEY;
    process.env.NODE_ENV = "development";
    const ctx = makeRes();
    let called = false;
    requireApiKey(makeReq(), ctx.res, () => { called = true; });
    expect(called).toBe(true);
    expect(ctx.status).toBeUndefined();
  });

  it("denies all requests in production mode when no key configured", () => {
    delete process.env.AGENTPAY_API_KEY;
    process.env.NODE_ENV = "production";
    const ctx = makeRes();
    let called = false;
    requireApiKey(makeReq(), ctx.res, () => { called = true; });
    expect(called).toBe(false);
    expect(ctx.status).toBe(503);
  });

  it("accepts valid Bearer token", () => {
    process.env.AGENTPAY_API_KEY = "secret123";
    const ctx = makeRes();
    let called = false;
    requireApiKey(makeReq({ authorization: "Bearer secret123" }), ctx.res, () => { called = true; });
    expect(called).toBe(true);
  });

  it("accepts valid x-api-key header", () => {
    process.env.AGENTPAY_API_KEY = "secret123";
    const ctx = makeRes();
    let called = false;
    requireApiKey(makeReq({ "x-api-key": "secret123" }), ctx.res, () => { called = true; });
    expect(called).toBe(true);
  });

  it("rejects wrong key", () => {
    process.env.AGENTPAY_API_KEY = "secret123";
    const ctx = makeRes();
    let called = false;
    requireApiKey(makeReq({ authorization: "Bearer wrong" }), ctx.res, () => { called = true; });
    expect(called).toBe(false);
    expect(ctx.status).toBe(401);
  });

  it("rejects missing key when key is configured", () => {
    process.env.AGENTPAY_API_KEY = "secret123";
    const ctx = makeRes();
    let called = false;
    requireApiKey(makeReq(), ctx.res, () => { called = true; });
    expect(called).toBe(false);
    expect(ctx.status).toBe(401);
  });
});
