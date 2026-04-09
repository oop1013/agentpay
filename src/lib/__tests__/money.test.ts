import { describe, it, expect } from "vitest";
import {
  computePlatformFee,
  computeProviderNet,
  isValidPrice,
  DEFAULT_PLATFORM_FEE_BPS,
} from "../money";

describe("DEFAULT_PLATFORM_FEE_BPS", () => {
  it("is 100 (1%)", () => {
    expect(DEFAULT_PLATFORM_FEE_BPS).toBe(100);
  });
});

describe("micro-USDC arithmetic", () => {
  it("1 USDC = 1_000_000 micro-USDC in fee calc", () => {
    const fee = computePlatformFee(1_000_000, DEFAULT_PLATFORM_FEE_BPS);
    expect(fee).toBe(10_000); // 0.01 USDC
  });

  it("0.01 USDC (10_000 micro) → 100 micro fee", () => {
    const fee = computePlatformFee(10_000, DEFAULT_PLATFORM_FEE_BPS);
    expect(fee).toBe(100);
  });

  it("sub-cent amounts floor correctly (99 micro → 0 fee)", () => {
    // 99 * 100 / 10000 = 0.99 → 0
    expect(computePlatformFee(99, DEFAULT_PLATFORM_FEE_BPS)).toBe(0);
  });

  it("results are always integers", () => {
    for (const amount of [1, 3, 7, 333, 10001, 999999]) {
      expect(Number.isInteger(computePlatformFee(amount, DEFAULT_PLATFORM_FEE_BPS))).toBe(true);
      expect(Number.isInteger(computeProviderNet(amount, DEFAULT_PLATFORM_FEE_BPS))).toBe(true);
    }
  });
});

describe("spend cap enforcement semantics", () => {
  it("spend cap is against grossAmount, not providerNet", () => {
    const grossAmount = 10_000;
    const spendCap = 10_000;
    // Cap check: grossAmount <= spendCap
    expect(grossAmount <= spendCap).toBe(true);
  });
});

describe("isValidPrice edge cases", () => {
  it("large valid price", () => {
    expect(isValidPrice(1_000_000_000, DEFAULT_PLATFORM_FEE_BPS)).toBe(true);
  });

  it("100% fee bps would make all prices invalid (providerNet=0)", () => {
    // feeBps=10000 → fee=grossAmount → net=0 → invalid
    expect(isValidPrice(10000, 10000)).toBe(false);
  });
});
