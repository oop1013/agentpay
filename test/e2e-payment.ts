#!/usr/bin/env npx tsx
/**
 * AgentPay E2E Payment Test — Real Base Sepolia USDC
 *
 * This test proves the full payment flow works end-to-end with real on-chain
 * USDC transfers on Base Sepolia. It starts the local server, registers a
 * service, funds a caller wallet (you must bring your own USDC), calls the
 * paywalled endpoint with a real EIP-712 signed proof, and verifies that USDC
 * actually moved on-chain.
 *
 * ── Prerequisites ────────────────────────────────────────────────────────────
 *
 * Required env vars:
 *   BASE_SEPOLIA_RPC_URL      — JSON-RPC endpoint (e.g. https://sepolia.base.org
 *                               or Alchemy/Infura URL)
 *   PROVIDER_PRIVATE_KEY      — 0x-prefixed hex key of the server gas wallet
 *                               (pays gas for receiveWithAuthorization txns)
 *   CALLER_PRIVATE_KEY        — 0x-prefixed hex key of the test caller wallet
 *                               (must hold USDC on Base Sepolia)
 *
 * Optional:
 *   TEST_SERVER_URL           — If set, connects to an existing server instead
 *                               of starting a new one (default: start local)
 *   AGENTPAY_API_KEY          — If set, authenticates write API calls
 *
 * ── Funding test wallets ─────────────────────────────────────────────────────
 *
 * The CALLER wallet needs USDC on Base Sepolia:
 *   - Coinbase faucet: https://faucet.circle.com/  (USDC on Base Sepolia)
 *   - Also needs ETH for gas: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet
 *
 * The PROVIDER wallet (derived from PROVIDER_PRIVATE_KEY) needs ETH for gas:
 *   - https://www.coinbase.com/faucets/base-ethereum-goerli-faucet
 *
 * ── Running ──────────────────────────────────────────────────────────────────
 *
 *   BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
 *   PROVIDER_PRIVATE_KEY=0x... \
 *   CALLER_PRIVATE_KEY=0x... \
 *   npx tsx test/e2e-payment.ts
 *
 * ── Negative test cases ───────────────────────────────────────────────────────
 * See sections: "NEGATIVE 1-3" below.
 */

import { createPublicClient, http, parseSignature } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createEIP712Signer, createAgentPayClient } from "../src/sdk/client";
import { spawn, ChildProcess } from "child_process";
import { promisify } from "util";

const sleep = promisify(setTimeout);

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_SEPOLIA_RPC_URL = process.env.BASE_SEPOLIA_RPC_URL;
const PROVIDER_PRIVATE_KEY = process.env.PROVIDER_PRIVATE_KEY as `0x${string}` | undefined;
const CALLER_PRIVATE_KEY = process.env.CALLER_PRIVATE_KEY as `0x${string}` | undefined;
const AGENTPAY_API_KEY = process.env.AGENTPAY_API_KEY;

if (!BASE_SEPOLIA_RPC_URL || !PROVIDER_PRIVATE_KEY || !CALLER_PRIVATE_KEY) {
  console.error(
    "Missing required env vars: BASE_SEPOLIA_RPC_URL, PROVIDER_PRIVATE_KEY, CALLER_PRIVATE_KEY"
  );
  process.exit(1);
}

const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const USDC_ABI_BALANCE = [
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

const SERVER_URL = process.env.TEST_SERVER_URL ?? "http://localhost:3000";
const SERVICE_PRICE = 1000; // 1000 micro-USDC = 0.001 USDC

// ── Wallets ───────────────────────────────────────────────────────────────────

const callerAccount = privateKeyToAccount(CALLER_PRIVATE_KEY);
const providerAccount = privateKeyToAccount(PROVIDER_PRIVATE_KEY);

const CALLER_WALLET = callerAccount.address;
const PROVIDER_WALLET = providerAccount.address;

// ── Public client for on-chain reads ─────────────────────────────────────────

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(BASE_SEPOLIA_RPC_URL),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

let PASS = 0;
let FAIL = 0;

function green(msg: string) { console.log(`\x1b[32m${msg}\x1b[0m`); }
function red(msg: string) { console.log(`\x1b[31m${msg}\x1b[0m`); }
function bold(msg: string) { console.log(`\x1b[1m${msg}\x1b[0m`); }

function pass(label: string, detail?: string) {
  PASS++;
  green(`  PASS  ${label}${detail ? ` (${detail})` : ""}`);
}

function fail(label: string, detail?: string) {
  FAIL++;
  red(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}

function assertStatus(label: string, expected: number, actual: number) {
  if (actual === expected) {
    pass(label, `HTTP ${actual}`);
  } else {
    fail(label, `expected HTTP ${expected}, got ${actual}`);
  }
}

async function getUSDCBalance(address: string): Promise<bigint> {
  return publicClient.readContract({
    address: USDC_BASE_SEPOLIA,
    abi: USDC_ABI_BALANCE,
    functionName: "balanceOf",
    args: [address as `0x${string}`],
  }) as Promise<bigint>;
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (AGENTPAY_API_KEY) headers["Authorization"] = `Bearer ${AGENTPAY_API_KEY}`;
  return headers;
}

// ── EIP-712 proof builders for negative tests ─────────────────────────────────

async function buildProofWithWrongChain(): Promise<string> {
  const account = privateKeyToAccount(CALLER_PRIVATE_KEY!);
  const nowSec = Math.floor(Date.now() / 1000);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = `0x${Array.from(nonceBytes).map(b => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;

  // Sign with correct domain but embed wrong chainId in the proof JSON
  const signature = await account.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 84532, verifyingContract: USDC_BASE_SEPOLIA },
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: account.address,
      to: PROVIDER_WALLET as `0x${string}`,
      value: BigInt(SERVICE_PRICE),
      validAfter: BigInt(0),
      validBefore: BigInt(nowSec + 300),
      nonce,
    },
  });

  const proof = {
    from: account.address,
    to: PROVIDER_WALLET,
    value: String(SERVICE_PRICE),
    validAfter: "0",
    validBefore: String(nowSec + 300),
    nonce,
    signature,
    chainId: 1, // Wrong: mainnet instead of Base Sepolia
  };

  return Buffer.from(JSON.stringify(proof)).toString("base64");
}

async function buildExpiredProof(providerWallet: string, amount: number): Promise<string> {
  const account = privateKeyToAccount(CALLER_PRIVATE_KEY!);
  const nowSec = Math.floor(Date.now() / 1000);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = `0x${Array.from(nonceBytes).map(b => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
  const expiredBefore = nowSec - 60; // expired 60 seconds ago

  const signature = await account.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 84532, verifyingContract: USDC_BASE_SEPOLIA },
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: account.address,
      to: providerWallet as `0x${string}`,
      value: BigInt(amount),
      validAfter: BigInt(0),
      validBefore: BigInt(expiredBefore),
      nonce,
    },
  });

  const proof = {
    from: account.address,
    to: providerWallet,
    value: String(amount),
    validAfter: "0",
    validBefore: String(expiredBefore),
    nonce,
    signature,
    chainId: 84532,
  };

  return Buffer.from(JSON.stringify(proof)).toString("base64");
}

// ── Server management ─────────────────────────────────────────────────────────

let serverProc: ChildProcess | null = null;

async function startServer(): Promise<void> {
  if (process.env.TEST_SERVER_URL) return; // use existing server

  bold("Starting AgentPay server...");
  serverProc = spawn("npx", ["tsx", "src/index.ts"], {
    env: {
      ...process.env,
      BASE_SEPOLIA_RPC_URL,
      PROVIDER_PRIVATE_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProc.stdout?.on("data", (d) => process.stdout.write(d));
  serverProc.stderr?.on("data", (d) => process.stderr.write(d));

  // Wait for health check
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      if (res.ok) {
        green("Server is up!\n");
        return;
      }
    } catch { /* still starting */ }
    await sleep(300);
  }

  throw new Error("Server failed to start within 15s");
}

function stopServer() {
  if (serverProc) {
    bold("\nStopping server...");
    serverProc.kill();
    serverProc = null;
  }
}

// ── Main test ─────────────────────────────────────────────────────────────────

async function main() {
  await startServer();

  let serviceId = "";

  try {
    // ── Setup ────────────────────────────────────────────────────────────────

    bold("─── Setup ───────────────────────────────────────────────────────────────");

    // Create service
    let res = await fetch(`${SERVER_URL}/api/services`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        providerWallet: PROVIDER_WALLET,
        name: "E2E Test Service",
        endpoint: "https://api.example.com/v1/e2e",
        pricePerCall: SERVICE_PRICE,
        description: "E2E integration test service",
        category: "testing",
      }),
    });
    assertStatus("Create service", 201, res.status);
    const svcBody = await res.json() as { id: string };
    serviceId = svcBody.id;
    green(`  Service: ${serviceId}`);

    // Register wallets
    res = await fetch(`${SERVER_URL}/api/wallets`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ address: CALLER_WALLET, type: "agent", name: "E2E Caller" }),
    });
    assertStatus("Register caller wallet", 201, res.status);

    res = await fetch(`${SERVER_URL}/api/wallets`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ address: PROVIDER_WALLET, type: "provider", name: "E2E Provider" }),
    });
    assertStatus("Register provider wallet", 201, res.status);

    // Authorize caller with a generous spend cap
    res = await fetch(`${SERVER_URL}/api/auth`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        callerWallet: CALLER_WALLET,
        serviceId,
        spendCap: 1_000_000, // 1 USDC cap
      }),
    });
    assertStatus("Create authorization", 201, res.status);
    console.log("");

    // ── NEGATIVE TESTS ───────────────────────────────────────────────────────

    bold("─── Negative Cases ──────────────────────────────────────────────────────");

    // NEGATIVE 1: No payment headers → 402
    res = await fetch(`${SERVER_URL}/api/test/protected?serviceId=${serviceId}`);
    assertStatus("NEGATIVE 1: No payment headers → 402", 402, res.status);

    // NEGATIVE 2: Wrong chain ID → 402
    const wrongChainProof = await buildProofWithWrongChain();
    res = await fetch(`${SERVER_URL}/api/test/protected?serviceId=${serviceId}`, {
      headers: {
        "x-402-payment": wrongChainProof,
        "x-402-caller": CALLER_WALLET,
      },
    });
    assertStatus("NEGATIVE 2: Wrong chain ID → 402", 402, res.status);
    {
      const body = await res.json() as { detail?: string };
      if (body.detail?.includes("Wrong chain")) {
        pass("  NEGATIVE 2: Error message confirms wrong chain rejection");
      } else {
        fail("  NEGATIVE 2: Error message unexpected", JSON.stringify(body));
      }
    }

    // NEGATIVE 3: Expired proof → 402
    const expiredProof = await buildExpiredProof(PROVIDER_WALLET, SERVICE_PRICE);
    res = await fetch(`${SERVER_URL}/api/test/protected?serviceId=${serviceId}`, {
      headers: {
        "x-402-payment": expiredProof,
        "x-402-caller": CALLER_WALLET,
      },
    });
    assertStatus("NEGATIVE 3: Expired proof → 402", 402, res.status);
    {
      const body = await res.json() as { detail?: string };
      if (body.detail?.includes("expired")) {
        pass("  NEGATIVE 3: Error message confirms expiry rejection");
      } else {
        fail("  NEGATIVE 3: Error message unexpected", JSON.stringify(body));
      }
    }

    // NEGATIVE 4: Corrupted signature → 402
    const signer = createEIP712Signer(CALLER_PRIVATE_KEY!);
    const validProofB64 = await signer({ version: "1", description: "", payTo: PROVIDER_WALLET, amount: SERVICE_PRICE, requiredHeaders: [] });
    const validProofObj = JSON.parse(Buffer.from(validProofB64, "base64").toString());
    validProofObj.signature = validProofObj.signature.slice(0, -4) + "0000"; // corrupt last 2 bytes
    const corruptedProof = Buffer.from(JSON.stringify(validProofObj)).toString("base64");
    res = await fetch(`${SERVER_URL}/api/test/protected?serviceId=${serviceId}`, {
      headers: {
        "x-402-payment": corruptedProof,
        "x-402-caller": CALLER_WALLET,
      },
    });
    assertStatus("NEGATIVE 4: Corrupted signature → 402", 402, res.status);
    console.log("");

    // ── POSITIVE TEST: Real on-chain USDC payment ─────────────────────────────

    bold("─── Positive Case: Real on-chain USDC payment ───────────────────────────");

    // Check pre-payment USDC balances
    let callerBalanceBefore: bigint;
    let providerBalanceBefore: bigint;
    try {
      callerBalanceBefore = await getUSDCBalance(CALLER_WALLET);
      providerBalanceBefore = await getUSDCBalance(PROVIDER_WALLET);
      green(`  Caller  USDC before: ${callerBalanceBefore} micro-USDC`);
      green(`  Provider USDC before: ${providerBalanceBefore} micro-USDC`);

      if (callerBalanceBefore < BigInt(SERVICE_PRICE)) {
        red(`  WARN: Caller USDC balance (${callerBalanceBefore}) is below service price (${SERVICE_PRICE}).`);
        red("  On-chain settlement will likely fail — fund the caller wallet and retry.");
        red("  Faucet: https://faucet.circle.com/");
      }
    } catch (err) {
      red(`  Could not read USDC balances (RPC error): ${err}`);
      callerBalanceBefore = BigInt(0);
      providerBalanceBefore = BigInt(0);
    }

    // Use the AgentPay client SDK (the full auto-pay wrapper)
    const client = createAgentPayClient({
      callerWallet: CALLER_WALLET,
      signPayment: createEIP712Signer(CALLER_PRIVATE_KEY!),
    });

    bold("  Making paid request via createAgentPayClient...");
    const paidRes = await client.fetch(`${SERVER_URL}/api/test/protected?serviceId=${serviceId}`);
    assertStatus("Paid request → 200", 200, paidRes.status);

    const paidBody = await paidRes.json() as { message?: string; data?: { txHash?: string } };
    if (paidBody.message?.includes("Access granted")) {
      pass("Response contains expected message");
    } else {
      fail("Response missing expected message", JSON.stringify(paidBody));
    }

    // Give the server a moment to complete on-chain settlement
    await sleep(5000);

    // Verify USDC moved on-chain
    let txHash: string | undefined;
    try {
      const callerBalanceAfter = await getUSDCBalance(CALLER_WALLET);
      const providerBalanceAfter = await getUSDCBalance(PROVIDER_WALLET);

      green(`  Caller  USDC after:  ${callerBalanceAfter} micro-USDC`);
      green(`  Provider USDC after:  ${providerBalanceAfter} micro-USDC`);

      const callerDelta = callerBalanceBefore - callerBalanceAfter;
      const providerDelta = providerBalanceAfter - providerBalanceBefore;

      if (callerDelta === BigInt(SERVICE_PRICE)) {
        pass(`On-chain: caller balance reduced by ${SERVICE_PRICE} micro-USDC`);
      } else if (callerDelta > 0n) {
        pass(`On-chain: caller balance reduced by ${callerDelta} micro-USDC (expected ${SERVICE_PRICE})`);
      } else {
        fail(
          "On-chain: caller USDC did not decrease",
          `before=${callerBalanceBefore} after=${callerBalanceAfter}`
        );
      }

      if (providerDelta > 0n) {
        pass(`On-chain: provider balance increased by ${providerDelta} micro-USDC`);
      } else {
        fail(
          "On-chain: provider USDC did not increase",
          `before=${providerBalanceBefore} after=${providerBalanceAfter}`
        );
      }
    } catch (err) {
      fail("On-chain balance check failed", String(err));
    }

    // Retrieve the tx hash from usage records
    await sleep(500);
    const usageRes = await fetch(`${SERVER_URL}/api/usage?callerWallet=${CALLER_WALLET}`);
    if (usageRes.ok) {
      const usageBody = await usageRes.json() as { records?: Array<{ txHash?: string }> };
      const latest = usageBody.records?.[0];
      if (latest?.txHash) {
        txHash = latest.txHash;
        pass(`Transaction hash: ${txHash}`);
        bold(`\n  TX HASH (Base Sepolia): ${txHash}`);
        bold(`  View: https://sepolia.basescan.org/tx/${txHash}`);
      } else {
        red("  TX hash not found in usage records (settlement may be skipped in dev mode)");
      }
    }

    console.log("");

    // ── Verify platform/service stats ─────────────────────────────────────────

    bold("─── Stats verification ──────────────────────────────────────────────────");

    const statsRes = await fetch(`${SERVER_URL}/api/platform/stats`);
    if (statsRes.ok) {
      const stats = await statsRes.json() as { totalCalls?: number; totalVolume?: number };
      if ((stats.totalCalls ?? 0) >= 1) {
        pass(`Platform stats: totalCalls=${stats.totalCalls}`);
      } else {
        fail("Platform stats: totalCalls not incremented", JSON.stringify(stats));
      }
    }

    const svcRes = await fetch(`${SERVER_URL}/api/services/${serviceId}`);
    if (svcRes.ok) {
      const svc = await svcRes.json() as { totalCalls?: number; grossVolume?: number };
      if ((svc.totalCalls ?? 0) >= 1) {
        pass(`Service stats: totalCalls=${svc.totalCalls}, grossVolume=${svc.grossVolume}`);
      } else {
        fail("Service stats: totalCalls not incremented", JSON.stringify(svc));
      }
    }

    console.log("");

  } finally {
    stopServer();
  }

  // ── Summary ──────────────────────────────────────────────────────────────────

  bold("════════════════════════════════════════");
  if (FAIL === 0) {
    green(`  ALL ${PASS} TESTS PASSED`);
  } else {
    red(`  ${FAIL} FAILED, ${PASS} passed`);
  }
  bold("════════════════════════════════════════\n");

  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((err) => {
  stopServer();
  console.error("Fatal:", err);
  process.exit(1);
});
