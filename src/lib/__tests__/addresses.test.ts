import { describe, it, expect } from "vitest";
import { normalizeAddress, isValidAddress } from "../addresses";

describe("normalizeAddress", () => {
  it("lowercases uppercase address", () => {
    expect(normalizeAddress("0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266")).toBe(
      "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
    );
  });

  it("trims whitespace", () => {
    expect(normalizeAddress("  0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266  ")).toBe(
      "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
    );
  });

  it("is idempotent on already-normalized address", () => {
    const addr = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
    expect(normalizeAddress(addr)).toBe(addr);
  });

  it("normalizes mixed case (checksummed address)", () => {
    expect(normalizeAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toBe(
      "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
    );
  });
});

describe("isValidAddress", () => {
  it("accepts valid lowercase address", () => {
    expect(isValidAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266")).toBe(true);
  });

  it("accepts valid checksummed address", () => {
    expect(isValidAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toBe(true);
  });

  it("rejects address without 0x prefix", () => {
    expect(isValidAddress("f39fd6e51aad88f6f4ce6ab8827279cfffb92266")).toBe(false);
  });

  it("rejects too-short address", () => {
    expect(isValidAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfff")).toBe(false);
  });

  it("rejects too-long address", () => {
    expect(isValidAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb922660000")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidAddress("")).toBe(false);
  });

  it("rejects address with invalid hex characters", () => {
    expect(isValidAddress("0xz39fd6e51aad88f6f4ce6ab8827279cfffb92266")).toBe(false);
  });

  it("handles leading/trailing whitespace (isValid checks trimmed)", () => {
    // isValidAddress does its own trim check internally
    expect(isValidAddress("  0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266  ")).toBe(true);
  });
});
