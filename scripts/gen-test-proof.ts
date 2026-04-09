#!/usr/bin/env npx tsx
/**
 * Generate a real EIP-712 x402 payment proof for use in test.sh.
 *
 * Usage:
 *   npx tsx scripts/gen-test-proof.ts <privateKey> <providerWallet> <amount>
 *
 * Outputs a base64-encoded JSON proof to stdout, ready to use as the
 * x-402-payment header value.
 */

import { privateKeyToAccount } from "viem/accounts";

const [, , privateKey, providerWallet, amountStr] = process.argv;

if (!privateKey || !providerWallet || !amountStr) {
  console.error("Usage: npx tsx scripts/gen-test-proof.ts <privateKey> <providerWallet> <amount>");
  process.exit(1);
}

const USDC_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: 84532,
  verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const,
} as const;

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

async function main() {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const amount = Number(amountStr);
  const nowSec = Math.floor(Date.now() / 1000);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = `0x${Array.from(nonceBytes).map(b => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;

  const message = {
    from: account.address,
    to: providerWallet as `0x${string}`,
    value: BigInt(amount),
    validAfter: BigInt(0),
    validBefore: BigInt(nowSec + 300),
    nonce,
  };

  const signature = await account.signTypedData({
    domain: USDC_DOMAIN,
    types: RECEIVE_WITH_AUTH_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message,
  });

  const proof = {
    from: account.address,
    to: providerWallet,
    value: String(amount),
    validAfter: "0",
    validBefore: String(nowSec + 300),
    nonce,
    signature,
    chainId: 84532,
  };

  console.log(Buffer.from(JSON.stringify(proof)).toString("base64"));
}

main().catch(err => { console.error(err); process.exit(1); });
