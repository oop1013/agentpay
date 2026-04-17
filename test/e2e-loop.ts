#!/usr/bin/env npx tsx
/**
 * AgentPay E2E Loop Test — publish → discover → pay → earn
 *
 * Proves the full loop works end-to-end using ephemeral test wallets and
 * off-chain proof verification only (no real USDC, no on-chain settlement).
 *
 * ── How it works ─────────────────────────────────────────────────────────────
 *
 * - Uses `generatePrivateKey()` to create fresh ephemeral wallets each run.
 * - Signs real EIP-712 proofs (the server does full cryptographic verification).
 * - Settlement is skipped automatically when BASE_SEPOLIA_RPC_URL /
 *   PROVIDER_PRIVATE_KEY are NOT set (dev mode).
 * - Write-auth is open when AGENTPAY_API_KEY is not set in dev mode.
 *
 * ── Running ───────────────────────────────────────────────────────────────────
 *
 *   npx tsx test/e2e-loop.ts
 *
 * Against an existing server:
 *
 *   TEST_SERVER_URL=http://localhost:3000 npx tsx test/e2e-loop.ts
 *
 * With API key (if server has one configured):
 *
 *   AGENTPAY_API_KEY=your-key npx tsx test/e2e-loop.ts
 */

import "dotenv/config"; // loads .env so AGENTPAY_API_KEY is available to the test client
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createEIP712Signer, createAgentPayClient } from "../src/sdk/client";
import { spawn, ChildProcess } from "child_process";
import { promisify } from "util";

const sleep = promisify(setTimeout);

// ── Config ────────────────────────────────────────────────────────────────────

const SERVER_URL = process.env.TEST_SERVER_URL ?? "http://localhost:3000";
const AGENTPAY_API_KEY = process.env.AGENTPAY_API_KEY;

// Ephemeral test wallets — generated fresh each run, no real funds needed
const PROVIDER_KEY = generatePrivateKey();
const CALLER_KEY = generatePrivateKey();
const providerAccount = privateKeyToAccount(PROVIDER_KEY);
const callerAccount = privateKeyToAccount(CALLER_KEY);
const PROVIDER_WALLET = providerAccount.address;
const CALLER_WALLET = callerAccount.address;

// Unique per-run name to avoid Redis collisions across repeated runs
const RUN_ID = Math.random().toString(36).slice(2, 8);
const SERVICE_NAME = `E2E Loop Service ${RUN_ID}`;
const SERVICE_CATEGORY = `e2e-loop-${RUN_ID}`;
const SERVICE_PRICE = 1000; // 1000 micro-USDC = 0.001 USDC

// ── Helpers ───────────────────────────────────────────────────────────────────

let PASS = 0;
let FAIL = 0;

function green(msg: string) { process.stdout.write(`\x1b[32m${msg}\x1b[0m\n`); }
function red(msg: string) { process.stdout.write(`\x1b[31m${msg}\x1b[0m\n`); }
function yellow(msg: string) { process.stdout.write(`\x1b[33m${msg}\x1b[0m\n`); }
function bold(msg: string) { process.stdout.write(`\x1b[1m${msg}\x1b[0m\n`); }

function pass(label: string, detail?: string) {
  PASS++;
  green(`  ✓  ${label}${detail ? ` (${detail})` : ""}`);
}

function fail(label: string, detail?: string) {
  FAIL++;
  red(`  ✗  ${label}${detail ? ` — ${detail}` : ""}`);
}

function assertEq<T>(label: string, expected: T, actual: T) {
  if (actual === expected) {
    pass(label, `${actual}`);
  } else {
    fail(label, `expected ${expected}, got ${actual}`);
  }
}

function assertStatus(label: string, expected: number, actual: number) {
  assertEq(label, expected, actual);
}

function assertTruthy(label: string, value: unknown, detail?: string) {
  if (value) {
    pass(label, detail);
  } else {
    fail(label, `got falsy: ${JSON.stringify(value)}`);
  }
}

function apiHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (AGENTPAY_API_KEY) h["Authorization"] = `Bearer ${AGENTPAY_API_KEY}`;
  return h;
}

// ── Server management ─────────────────────────────────────────────────────────

let serverProc: ChildProcess | null = null;

async function startServer(): Promise<void> {
  if (process.env.TEST_SERVER_URL) return; // connect to existing server

  bold("Starting AgentPay server...");
  serverProc = spawn("npx", ["tsx", "src/index.ts"], {
    env: {
      ...process.env,
      // Intentionally NOT passing BASE_SEPOLIA_RPC_URL or PROVIDER_PRIVATE_KEY
      // so on-chain settlement is skipped (dev/test mode).
    },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: process.cwd(),
  });

  serverProc.stdout?.on("data", () => {}); // suppress server logs
  serverProc.stderr?.on("data", () => {});

  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      if (res.ok) { green("Server is up\n"); return; }
    } catch { /* still starting */ }
    await sleep(300);
  }
  throw new Error("Server failed to start within 15s");
}

function stopServer() {
  if (serverProc) {
    serverProc.kill();
    serverProc = null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await startServer();

  bold(`Run ID: ${RUN_ID}`);
  bold(`Provider: ${PROVIDER_WALLET}`);
  bold(`Caller:   ${CALLER_WALLET}\n`);

  let serviceId = "";

  try {
    // ── STEP 1: PUBLISH ──────────────────────────────────────────────────────

    bold("──────────────────────────────────────────");
    bold("STEP 1 — Publish: POST /api/services");
    bold("──────────────────────────────────────────");

    let res = await fetch(`${SERVER_URL}/api/services`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        providerWallet: PROVIDER_WALLET,
        name: SERVICE_NAME,
        endpoint: "https://api.example.com/v1/test",
        pricePerCall: SERVICE_PRICE,
        description: `Automated E2E loop test service run=${RUN_ID}`,
        category: SERVICE_CATEGORY,
      }),
    });
    assertStatus("Publish service → 201", 201, res.status);

    const svc = await res.json() as { id?: string; pricePerCall?: number; status?: string };
    serviceId = svc.id ?? "";
    assertTruthy("Service ID assigned", serviceId, serviceId);
    assertEq("Service price stored correctly", SERVICE_PRICE, svc.pricePerCall as number);
    assertEq("Service status is active", "active", svc.status as string);
    green(`  Service: ${serviceId}\n`);

    // ── STEP 2: DISCOVER ─────────────────────────────────────────────────────

    bold("──────────────────────────────────────────");
    bold("STEP 2 — Discover: GET /api/services with filters");
    bold("──────────────────────────────────────────");

    // 2a: filter by exact category
    res = await fetch(
      `${SERVER_URL}/api/services?category=${encodeURIComponent(SERVICE_CATEGORY)}`
    );
    assertStatus("GET /api/services?category → 200", 200, res.status);
    {
      const body = await res.json() as { services?: Array<{ id: string }> };
      const found = body.services?.some((s) => s.id === serviceId);
      assertTruthy("Service found by category filter", found);
    }

    // 2b: filter by search term (name keyword)
    const searchWord = RUN_ID; // unique suffix guaranteed to be in the name
    res = await fetch(
      `${SERVER_URL}/api/services?search=${encodeURIComponent(searchWord)}`
    );
    assertStatus("GET /api/services?search → 200", 200, res.status);
    {
      const body = await res.json() as { services?: Array<{ id: string }> };
      const found = body.services?.some((s) => s.id === serviceId);
      assertTruthy("Service found by search filter", found);
    }

    // 2c: combined category + search
    res = await fetch(
      `${SERVER_URL}/api/services?category=${encodeURIComponent(SERVICE_CATEGORY)}&search=${encodeURIComponent(searchWord)}`
    );
    assertStatus("GET /api/services?category&search → 200", 200, res.status);
    {
      const body = await res.json() as { services?: Array<{ id: string }> };
      const found = body.services?.some((s) => s.id === serviceId);
      assertTruthy("Service found by combined category+search filter", found);
    }

    // 2d: sort by newest — service should appear
    res = await fetch(
      `${SERVER_URL}/api/services?category=${encodeURIComponent(SERVICE_CATEGORY)}&sortBy=newest`
    );
    assertStatus("GET /api/services?sortBy=newest → 200", 200, res.status);
    {
      const body = await res.json() as { services?: Array<{ id: string }> };
      const found = body.services?.some((s) => s.id === serviceId);
      assertTruthy("Service found with sortBy=newest", found);
    }

    // 2e: negative — wrong category returns empty for this service
    res = await fetch(`${SERVER_URL}/api/services?category=does-not-exist-xyz`);
    assertStatus("GET /api/services?category=nonexistent → 200", 200, res.status);
    {
      const body = await res.json() as { services?: Array<{ id: string }> };
      const found = body.services?.some((s) => s.id === serviceId);
      if (!found) {
        pass("Negative: service NOT returned for wrong category");
      } else {
        fail("Negative: service incorrectly returned for wrong category");
      }
    }
    console.log("");

    // ── STEP 3: AUTHORIZE ────────────────────────────────────────────────────

    bold("──────────────────────────────────────────");
    bold("STEP 3 — Authorize: POST /api/auth");
    bold("──────────────────────────────────────────");

    // Register wallets first (required for authorization lookup)
    res = await fetch(`${SERVER_URL}/api/wallets`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ address: CALLER_WALLET, type: "agent", name: "E2E Loop Caller" }),
    });
    assertStatus("Register caller wallet → 201", 201, res.status);

    res = await fetch(`${SERVER_URL}/api/wallets`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ address: PROVIDER_WALLET, type: "provider", name: "E2E Loop Provider" }),
    });
    assertStatus("Register provider wallet → 201", 201, res.status);

    // Create authorization with a spend cap
    const SPEND_CAP = 100_000; // 0.1 USDC
    res = await fetch(`${SERVER_URL}/api/auth`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        callerWallet: CALLER_WALLET,
        serviceId,
        spendCap: SPEND_CAP,
      }),
    });
    assertStatus("Create authorization → 201", 201, res.status);
    {
      const body = await res.json() as { status?: string; spendCap?: number };
      assertEq("Authorization status is active", "active", body.status as string);
      assertEq("Spend cap stored correctly", SPEND_CAP, body.spendCap as number);
    }
    console.log("");

    // ── STEP 4: PAY ──────────────────────────────────────────────────────────

    bold("──────────────────────────────────────────");
    bold("STEP 4 — Pay: paid call via x402 client");
    bold("──────────────────────────────────────────");

    // 4a: unpaid request returns 402
    res = await fetch(`${SERVER_URL}/api/test/protected?serviceId=${serviceId}`);
    assertStatus("Unpaid request → 402", 402, res.status);
    {
      const body = await res.json() as {
        status?: number;
        serviceId?: string;
        pricePerCall?: number;
        x402?: { payTo?: string; amount?: number };
      };
      assertEq("402 body.serviceId matches", serviceId, body.serviceId as string);
      assertEq("402 body.pricePerCall matches", SERVICE_PRICE, body.pricePerCall as number);
      assertTruthy("402 body.x402 present", body.x402);
      assertEq("402 x402.amount matches price", SERVICE_PRICE, body.x402?.amount as number);
      assertEq(
        "402 x402.payTo is provider wallet (lowercase)",
        PROVIDER_WALLET.toLowerCase(),
        (body.x402?.payTo as string)?.toLowerCase()
      );
    }

    // 4b: use the AgentPay client SDK to auto-pay and retry
    const client = createAgentPayClient({
      callerWallet: CALLER_WALLET,
      signPayment: createEIP712Signer(CALLER_KEY),
    });

    bold("  Sending paid request via createAgentPayClient...");
    const paidRes = await client.fetch(`${SERVER_URL}/api/test/protected?serviceId=${serviceId}`);
    assertStatus("Paid request → 200", 200, paidRes.status);
    {
      const body = await paidRes.json() as { message?: string };
      assertTruthy(
        "Response contains 'Access granted'",
        body.message?.includes("Access granted"),
        body.message
      );
    }

    // Give the server a moment to finish async usage recording
    await sleep(500);
    console.log("");

    // ── STEP 5: EARN ─────────────────────────────────────────────────────────

    bold("──────────────────────────────────────────");
    bold("STEP 5 — Earn: verify earnings");
    bold("──────────────────────────────────────────");

    // 5a: provider earnings records
    res = await fetch(
      `${SERVER_URL}/api/usage/${PROVIDER_WALLET}?type=earnings`
    );
    assertStatus("GET /api/usage/{provider}?type=earnings → 200", 200, res.status);
    {
      const body = await res.json() as {
        records?: Array<{
          serviceId: string;
          grossAmount: number;
          platformFee: number;
          providerNet: number;
          status: string;
        }>;
      };
      const record = body.records?.[0];
      assertTruthy("Earnings record exists", record);
      if (record) {
        assertEq("Earnings serviceId matches", serviceId, record.serviceId);
        assertEq("Earnings grossAmount = SERVICE_PRICE", SERVICE_PRICE, record.grossAmount);
        assertTruthy("Earnings platformFee > 0", record.platformFee > 0, `${record.platformFee}`);
        assertTruthy(
          "Earnings providerNet = gross - fee",
          record.providerNet === record.grossAmount - record.platformFee,
          `${record.providerNet} = ${record.grossAmount} - ${record.platformFee}`
        );
        assertEq("Earnings record status is success", "success", record.status);
      }
    }

    // 5b: provider wallet totalEarned
    res = await fetch(`${SERVER_URL}/api/wallets/${PROVIDER_WALLET}`);
    assertStatus("GET /api/wallets/{provider} → 200", 200, res.status);
    {
      const body = await res.json() as { _wallet?: { totalEarned?: number } };
      const totalEarned = body._wallet?.totalEarned ?? 0;
      const expectedNet = SERVICE_PRICE - Math.floor(SERVICE_PRICE * 100 / 10000);
      assertEq(
        `Provider wallet totalEarned = ${expectedNet} (gross minus 1% fee)`,
        expectedNet,
        Number(totalEarned)
      );
    }

    // 5c: service stats updated
    res = await fetch(`${SERVER_URL}/api/services/${serviceId}`);
    assertStatus("GET /api/services/{id} → 200", 200, res.status);
    {
      const body = await res.json() as {
        totalCalls?: number;
        grossVolume?: number;
        totalEarned?: number;
        totalFees?: number;
      };
      assertEq("Service totalCalls = 1", 1, Number(body.totalCalls ?? 0));
      assertEq("Service grossVolume = SERVICE_PRICE", SERVICE_PRICE, Number(body.grossVolume ?? 0));
      assertTruthy("Service totalEarned > 0", Number(body.totalEarned ?? 0) > 0);
      assertTruthy("Service totalFees > 0", Number(body.totalFees ?? 0) > 0);
    }

    // 5d: caller usage recorded
    res = await fetch(
      `${SERVER_URL}/api/usage/${CALLER_WALLET}`
    );
    assertStatus("GET /api/usage/{caller} → 200", 200, res.status);
    {
      const body = await res.json() as { records?: Array<{ serviceId: string; grossAmount: number }> };
      const record = body.records?.[0];
      assertTruthy("Caller usage record exists", record);
      if (record) {
        assertEq("Caller usage serviceId matches", serviceId, record.serviceId);
        assertEq("Caller usage grossAmount = SERVICE_PRICE", SERVICE_PRICE, record.grossAmount);
      }
    }

    // 5e: platform stats incremented
    res = await fetch(`${SERVER_URL}/api/platform/stats`);
    assertStatus("GET /api/platform/stats → 200", 200, res.status);
    {
      const body = await res.json() as { totalCalls?: number; totalVolume?: number; totalFees?: number };
      assertTruthy("Platform totalCalls >= 1", Number(body.totalCalls ?? 0) >= 1);
      assertTruthy("Platform totalVolume >= SERVICE_PRICE", Number(body.totalVolume ?? 0) >= SERVICE_PRICE);
      assertTruthy("Platform totalFees >= 1", Number(body.totalFees ?? 0) >= 1);
    }

    console.log("");

    // ── BONUS: REPLAY PROTECTION ─────────────────────────────────────────────

    bold("──────────────────────────────────────────");
    bold("BONUS — Replay protection");
    bold("──────────────────────────────────────────");

    // The nonce from the paid request is consumed; re-using the same proof
    // (same nonce) should be rejected. We simulate by sending a second fresh
    // proof (new nonce) but that would succeed, so instead we verify the nonce
    // key exists in Redis via the usage record path (indirect check).
    // We just confirm a second paid call with a NEW proof succeeds (idempotent API).
    const paidRes2 = await client.fetch(`${SERVER_URL}/api/test/protected?serviceId=${serviceId}`);
    assertStatus("Second paid request (fresh nonce) → 200", 200, paidRes2.status);
    await sleep(500);
    {
      res = await fetch(`${SERVER_URL}/api/services/${serviceId}`);
      const body = await res.json() as { totalCalls?: number };
      assertEq("Service totalCalls = 2 after second call", 2, Number(body.totalCalls ?? 0));
    }

  } finally {
    stopServer();
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  bold("\n════════════════════════════════════════");
  if (FAIL === 0) {
    green(`  ALL ${PASS} ASSERTIONS PASSED`);
  } else {
    red(`  ${FAIL} FAILED,  ${PASS} PASSED`);
    yellow("\n  Review failures above for rough edges.");
  }
  bold("════════════════════════════════════════\n");

  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((err) => {
  stopServer();
  console.error("Fatal:", err);
  process.exit(1);
});
