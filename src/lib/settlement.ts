/**
 * On-chain USDC settlement via ERC-3009 receiveWithAuthorization on Base Sepolia.
 *
 * After a payment proof is verified off-chain (x402.ts), this module submits
 * the pre-signed authorization to the USDC contract so tokens actually move.
 *
 * Required env vars:
 *   BASE_SEPOLIA_RPC_URL   — JSON-RPC endpoint for Base Sepolia
 *   PROVIDER_PRIVATE_KEY   — server wallet private key (hex, 0x-prefixed) used to pay gas
 */

import { createPublicClient, createWalletClient, http, parseSignature } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import type { X402PaymentProof } from "./x402";

// USDC contract on Base Sepolia
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

// Minimal ABI for receiveWithAuthorization (ERC-3009)
const RECEIVE_WITH_AUTHORIZATION_ABI = [
  {
    name: "receiveWithAuthorization",
    type: "function",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export interface SettlementResult {
  success: boolean;
  txHash?: `0x${string}`;
  error?: string;
}

/**
 * Submit an ERC-3009 receiveWithAuthorization transaction to the USDC contract.
 *
 * Uses the server wallet (PROVIDER_PRIVATE_KEY) to pay gas fees.
 * Waits for transaction receipt before returning.
 *
 * Returns { success: false } if env vars are missing — allows the middleware
 * to treat settlement as optional when not configured (dev/test mode).
 * Returns { success: false, error } on on-chain failure.
 */
export async function settlePayment(proof: X402PaymentProof): Promise<SettlementResult> {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;
  const rawPrivateKey = process.env.PROVIDER_PRIVATE_KEY;

  if (!rpcUrl || !rawPrivateKey) {
    // Settlement not configured — skip silently (no on-chain submission)
    return {
      success: false,
      error: "Settlement skipped: BASE_SEPOLIA_RPC_URL or PROVIDER_PRIVATE_KEY not set",
    };
  }

  try {
    const privateKey = rawPrivateKey.startsWith("0x")
      ? (rawPrivateKey as `0x${string}`)
      : (`0x${rawPrivateKey}` as `0x${string}`);

    const account = privateKeyToAccount(privateKey);

    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(rpcUrl),
    });

    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl),
    });

    const { v, r, s } = parseSignature(proof.signature as `0x${string}`);

    const txHash = await walletClient.writeContract({
      address: USDC_ADDRESS,
      abi: RECEIVE_WITH_AUTHORIZATION_ABI,
      functionName: "receiveWithAuthorization",
      args: [
        proof.from as `0x${string}`,
        proof.to as `0x${string}`,
        BigInt(proof.value),
        BigInt(proof.validAfter),
        BigInt(proof.validBefore),
        proof.nonce as `0x${string}`,
        Number(v),
        r,
        s,
      ],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status === "reverted") {
      return { success: false, error: `Transaction reverted (txHash: ${txHash})` };
    }

    return { success: true, txHash };
  } catch (err) {
    return { success: false, error: `Settlement error: ${(err as Error).message}` };
  }
}
