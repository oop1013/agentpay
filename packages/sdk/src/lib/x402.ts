/**
 * x402 payment proof verification using EIP-712 typed data signatures.
 *
 * The x402 protocol uses ERC-3009 `receiveWithAuthorization` signatures:
 * the payer signs a typed authorization allowing the provider to pull payment
 * from their USDC balance. Verification is cryptographic and off-chain.
 *
 * Proof format: base64-encoded JSON (or raw JSON) containing the authorization
 * fields and the EIP-712 signature.
 *
 * Chain: Base Sepolia (chainId 84532)
 * Token: USDC at 0x036CbD53842c5426634e7929541eC2318f3dCF7e
 */

import { verifyTypedData } from "viem";
import { baseSepolia } from "viem/chains";
import { isValidAddress, normalizeAddress } from "./addresses";

// USDC contract on Base Sepolia
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

// EIP-712 domain separator for USDC on Base Sepolia
const USDC_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: baseSepolia.id, // 84532
  verifyingContract: USDC_BASE_SEPOLIA,
} as const;

// ERC-3009 ReceiveWithAuthorization typed data types
const RECEIVE_WITH_AUTH_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * x402 payment proof — base64-encoded JSON or raw JSON.
 *
 * Represents a signed ERC-3009 receiveWithAuthorization authorization.
 * The signature is an EIP-712 typed data signature by `from`.
 */
export interface X402PaymentProof {
  /** Payer wallet address (hex) */
  from: string;
  /** Recipient wallet address — must match service providerWallet */
  to: string;
  /** Amount in micro-USDC as a decimal string */
  value: string;
  /** Unix timestamp after which authorization is valid (seconds, as string) */
  validAfter: string;
  /** Unix timestamp before which authorization is valid (seconds, as string) */
  validBefore: string;
  /** Unique nonce (hex bytes32) to prevent replay */
  nonce: string;
  /** EIP-712 signature over the above fields (hex) */
  signature: string;
  /** Must equal 84532 (Base Sepolia) */
  chainId: number;
}

export interface X402VerifyResult {
  valid: boolean;
  error?: string;
  from?: string;
  to?: string;
  amount?: number;
  /** Populated on valid: true — the proof nonce for replay protection via consumeX402Nonce */
  nonce?: string;
  /** Populated on valid: true — validBefore seconds (unix) for TTL computation in consumeX402Nonce */
  validBefore?: number;
}

/**
 * Parse a proof string — accepts base64-encoded JSON or raw JSON.
 */
export function parseX402Proof(proof: string): X402PaymentProof | null {
  // Try base64-decode first
  try {
    const decoded = Buffer.from(proof, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed === "object" && "from" in parsed) {
      return parsed as X402PaymentProof;
    }
  } catch {
    // fall through to raw JSON
  }

  // Try raw JSON
  try {
    const parsed = JSON.parse(proof);
    if (parsed && typeof parsed === "object" && "from" in parsed) {
      return parsed as X402PaymentProof;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Verify an x402 payment proof cryptographically.
 *
 * Checks:
 *  1. Proof parses correctly
 *  2. Chain is Base Sepolia (84532)
 *  3. Addresses are valid
 *  4. Recipient matches expected provider wallet
 *  5. Amount matches expected service price (integer micro-USDC)
 *  6. Validity window covers current time
 *  7. EIP-712 signature is valid and recovers to `from`
 *
 * @param proof        Raw proof string (base64 or JSON)
 * @param expectedAmount  Expected amount in micro-USDC (integer)
 * @param expectedRecipient  Service providerWallet from Redis (authoritative)
 */
export async function verifyX402Proof(
  proof: string,
  expectedAmount: number,
  expectedRecipient: string
): Promise<X402VerifyResult> {
  const parsed = parseX402Proof(proof);
  if (!parsed) {
    return { valid: false, error: "Invalid proof format — expected base64 or JSON" };
  }

  // 1. Chain check
  if (parsed.chainId !== baseSepolia.id) {
    return {
      valid: false,
      error: `Wrong chain: expected Base Sepolia (${baseSepolia.id}), got ${parsed.chainId}`,
    };
  }

  // 2. Validate address format
  if (!isValidAddress(parsed.from)) {
    return { valid: false, error: "Invalid 'from' address in proof" };
  }
  if (!isValidAddress(parsed.to)) {
    return { valid: false, error: "Invalid 'to' address in proof" };
  }

  const from = normalizeAddress(parsed.from) as `0x${string}`;
  const to = normalizeAddress(parsed.to) as `0x${string}`;
  const recipient = normalizeAddress(expectedRecipient) as `0x${string}`;

  // 3. Recipient must match service provider wallet (from Redis, never client)
  if (to !== recipient) {
    return {
      valid: false,
      error: `Payment recipient mismatch: proof pays ${to}, expected ${recipient}`,
    };
  }

  // 4. Amount check (integer micro-USDC)
  let proofAmount: number;
  try {
    proofAmount = Number(BigInt(parsed.value));
  } catch {
    return { valid: false, error: "Invalid 'value' in proof" };
  }

  if (proofAmount !== expectedAmount) {
    return {
      valid: false,
      error: `Amount mismatch: proof has ${proofAmount} micro-USDC, expected ${expectedAmount}`,
    };
  }

  // 5. Validity window
  const nowSec = Math.floor(Date.now() / 1000);
  const validAfter = Number(parsed.validAfter);
  const validBefore = Number(parsed.validBefore);

  if (isNaN(validAfter) || isNaN(validBefore)) {
    return { valid: false, error: "Invalid validity window in proof" };
  }

  if (nowSec < validAfter) {
    return { valid: false, error: "Payment authorization is not yet valid" };
  }
  if (nowSec >= validBefore) {
    return { valid: false, error: "Payment authorization has expired" };
  }

  // 6. EIP-712 signature verification
  try {
    const isValid = await verifyTypedData({
      address: from,
      domain: USDC_DOMAIN,
      types: RECEIVE_WITH_AUTH_TYPES,
      primaryType: "ReceiveWithAuthorization",
      message: {
        from,
        to,
        value: BigInt(parsed.value),
        validAfter: BigInt(parsed.validAfter),
        validBefore: BigInt(parsed.validBefore),
        nonce: parsed.nonce as `0x${string}`,
      },
      signature: parsed.signature as `0x${string}`,
    });

    if (!isValid) {
      return { valid: false, error: "EIP-712 signature is invalid" };
    }
  } catch (err) {
    return {
      valid: false,
      error: `Signature verification error: ${(err as Error).message}`,
    };
  }

  return {
    valid: true,
    from,
    to,
    amount: proofAmount,
    nonce: parsed.nonce,
    validBefore,
  };
}

/**
 * Atomically mark an x402 payment nonce as consumed (replay protection).
 *
 * Call this ONLY after a payment has been definitively accepted — never during
 * a preflight verify. Returns true if the nonce was freshly claimed, false if it
 * was already consumed (indicating a duplicate/replay).
 *
 * @param from         Payer wallet address (normalised hex)
 * @param nonce        Proof nonce (hex bytes32) from X402VerifyResult
 * @param validBefore  Proof validBefore timestamp (seconds) from X402VerifyResult
 */
export async function consumeX402Nonce(
  from: string,
  nonce: string,
  validBefore: number
): Promise<boolean> {
  const nonceKey = `used_nonce:${from}:${nonce}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const ttl = Math.max(validBefore - nowSec + 60, 60); // at least 60s TTL
  const claimed = await redis.set(nonceKey, "1", { nx: true, ex: ttl });
  return claimed !== null;
}
