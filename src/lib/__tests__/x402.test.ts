/**
 * Tests for verifyX402Proof (side-effect free) and consumeX402Nonce.
 *
 * Regression coverage for AGEAA-56 fix 2:
 *  - verifyX402Proof must NOT consume the nonce (no Redis write on verify)
 *  - consumeX402Nonce must atomically mark a nonce spent; returns false on replay
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoist mock definitions so they are available when vi.mock factories run ───
const { redisMock, verifyTypedDataMock } = vi.hoisted(() => {
  const redisMock = {
    set: vi.fn(),
    get: vi.fn(),
    hgetall: vi.fn(),
    pipeline: vi.fn(),
  };
  const verifyTypedDataMock = vi.fn();
  return { redisMock, verifyTypedDataMock };
});

vi.mock("../redis", () => ({ redis: redisMock }));
vi.mock("viem", () => ({ verifyTypedData: verifyTypedDataMock }));

import { verifyX402Proof, consumeX402Nonce } from "../x402";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProof(overrides: Record<string, unknown> = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    value: "1000000",
    validAfter: String(nowSec - 60),
    validBefore: String(nowSec + 3600),
    nonce: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    signature: "0xsig",
    chainId: 84532,
    ...overrides,
  };
}

function encodeProof(proof: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(proof)).toString("base64");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("verifyX402Proof — side-effect free (no nonce consumption)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyTypedDataMock.mockResolvedValue(true);
  });

  it("does NOT call redis.set when proof is valid", async () => {
    const proof = makeProof();
    const result = await verifyX402Proof(encodeProof(proof), 1_000_000, proof.to as string);
    expect(result.valid).toBe(true);
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it("returns nonce and validBefore on valid proof", async () => {
    const proof = makeProof();
    const nowSec = Math.floor(Date.now() / 1000);
    const result = await verifyX402Proof(encodeProof(proof), 1_000_000, proof.to as string);
    expect(result.valid).toBe(true);
    expect(result.nonce).toBe(proof.nonce);
    expect(result.validBefore).toBeGreaterThan(nowSec);
  });

  it("does NOT call redis.set when proof amount is wrong", async () => {
    const proof = makeProof();
    const result = await verifyX402Proof(encodeProof(proof), 999, proof.to as string);
    expect(result.valid).toBe(false);
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it("does NOT call redis.set when EIP-712 signature is invalid", async () => {
    verifyTypedDataMock.mockResolvedValue(false);
    const proof = makeProof();
    const result = await verifyX402Proof(encodeProof(proof), 1_000_000, proof.to as string);
    expect(result.valid).toBe(false);
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it("can be called multiple times with the same proof without any side effects", async () => {
    const proof = makeProof();
    const encoded = encodeProof(proof);
    const r1 = await verifyX402Proof(encoded, 1_000_000, proof.to as string);
    const r2 = await verifyX402Proof(encoded, 1_000_000, proof.to as string);
    expect(r1.valid).toBe(true);
    expect(r2.valid).toBe(true);
    expect(redisMock.set).not.toHaveBeenCalled();
  });
});

describe("consumeX402Nonce — replay protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const from = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
  const nonce = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
  const validBefore = Math.floor(Date.now() / 1000) + 3600;

  it("returns true when nonce is freshly claimed", async () => {
    redisMock.set.mockResolvedValueOnce("OK");
    const result = await consumeX402Nonce(from, nonce, validBefore);
    expect(result).toBe(true);
    expect(redisMock.set).toHaveBeenCalledWith(
      `used_nonce:${from}:${nonce}`,
      "1",
      expect.objectContaining({ nx: true })
    );
  });

  it("returns false when nonce already consumed (replay)", async () => {
    redisMock.set.mockResolvedValueOnce(null);
    const result = await consumeX402Nonce(from, nonce, validBefore);
    expect(result).toBe(false);
  });

  it("uses a positive TTL in the SET call", async () => {
    redisMock.set.mockResolvedValueOnce("OK");
    await consumeX402Nonce(from, nonce, validBefore);
    const callArgs = redisMock.set.mock.calls[0];
    const opts = callArgs[2] as { nx: boolean; ex: number };
    expect(opts.ex).toBeGreaterThanOrEqual(60);
  });
});
