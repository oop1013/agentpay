import { describe, it, expect } from "vitest";
import {
  computePlatformFee,
  computeProviderNet,
  isValidPrice,
  DEFAULT_PLATFORM_FEE_BPS,
} from "../money";
import { computeFeeBreakdown } from "../fees";

describe("computePlatformFee", () => {
  it("computes 1% fee on 10000 micro-USDC", () => {
    expect(computePlatformFee(10000, 100)).toBe(100);
  });

  it("computes zero fee on zero amount", () => {
    expect(computePlatformFee(0, 100)).toBe(0);
  });

  it("floors fractional fee (1 micro-USDC at 1%)", () => {
    // 1 * 100 / 10000 = 0.01 → floor = 0
    expect(computePlatformFee(1, 100)).toBe(0);
  });

  it("computes fee on 1 USDC (1_000_000 micro-USDC)", () => {
    expect(computePlatformFee(1_000_000, 100)).toBe(10_000);
  });

  it("computes fee on max safe integer without overflow", () => {
    const gross = Number.MAX_SAFE_INTEGER;
    const fee = computePlatformFee(gross, 100);
    expect(fee).toBeGreaterThan(0);
    expect(fee).toBeLessThan(gross);
    expect(Number.isInteger(fee)).toBe(true);
  });

  it("uses integer arithmetic (floors result)", () => {
    // 9999 * 100 / 10000 = 99.99 → floor = 99
    expect(computePlatformFee(9999, 100)).toBe(99);
  });
});

describe("computeProviderNet", () => {
  it("provider receives gross minus fee", () => {
    expect(computeProviderNet(10000, 100)).toBe(9900);
  });

  it("provider receives full amount if fee is zero bps", () => {
    expect(computeProviderNet(10000, 0)).toBe(10000);
  });

  it("provider net on 1 micro-USDC (fee floors to 0)", () => {
    expect(computeProviderNet(1, 100)).toBe(1);
  });

  it("provider net on large amount", () => {
    expect(computeProviderNet(1_000_000, 100)).toBe(990_000);
  });
});

describe("isValidPrice", () => {
  it("valid price returns true", () => {
    expect(isValidPrice(10000, DEFAULT_PLATFORM_FEE_BPS)).toBe(true);
  });

  it("zero price is invalid", () => {
    expect(isValidPrice(0, DEFAULT_PLATFORM_FEE_BPS)).toBe(false);
  });

  it("negative price is invalid", () => {
    expect(isValidPrice(-1, DEFAULT_PLATFORM_FEE_BPS)).toBe(false);
  });

  it("non-integer price is invalid", () => {
    expect(isValidPrice(1.5, DEFAULT_PLATFORM_FEE_BPS)).toBe(false);
  });

  it("price of 1 micro-USDC is valid (fee=0, net=1)", () => {
    // fee = floor(1 * 100 / 10000) = 0, net = 1 > 0
    expect(isValidPrice(1, DEFAULT_PLATFORM_FEE_BPS)).toBe(true);
  });
});

describe("computeFeeBreakdown", () => {
  it("returns correct breakdown for standard amount", () => {
    const result = computeFeeBreakdown(10000);
    expect(result.grossAmount).toBe(10000);
    expect(result.platformFee).toBe(100);
    expect(result.providerNet).toBe(9900);
    expect(result.feeBps).toBe(DEFAULT_PLATFORM_FEE_BPS);
  });

  it("accepts custom feeBps", () => {
    const result = computeFeeBreakdown(10000, 200); // 2%
    expect(result.platformFee).toBe(200);
    expect(result.providerNet).toBe(9800);
    expect(result.feeBps).toBe(200);
  });

  it("gross = platformFee + providerNet always", () => {
    for (const amount of [1, 99, 1000, 10000, 1_000_000]) {
      const { grossAmount, platformFee, providerNet } = computeFeeBreakdown(amount);
      expect(platformFee + providerNet).toBe(grossAmount);
    }
  });
});
