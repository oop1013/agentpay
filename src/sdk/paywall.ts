import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { redis } from "../lib/redis";
import { Service, UsageRecord, UsageStatus } from "../lib/types";
import { normalizeAddress } from "../lib/addresses";
import { computeFeeBreakdown } from "../lib/fees";
import { verifyX402Proof, parseX402Proof, consumeX402Nonce } from "../lib/x402";
import { settlePayment } from "../lib/settlement";
import { atomicSpendCapReserve, atomicSpendCapRelease } from "../lib/redis-scripts";

const X402_PAYMENT_HEADER = "x-402-payment";
const X402_CALLER_HEADER = "x-402-caller";

export interface PaywallConfig {
  serviceId: string;
}

/**
 * Express middleware that protects an endpoint with paid access via x402.
 *
 * Usage:
 *   app.post("/api/my-endpoint", paywall({ serviceId: "svc_xxx" }), handler);
 *
 * Flow:
 *   1. Load service from Redis (price is authoritative, never from client)
 *   2. Check for x402 payment proof in request headers
 *   3. If missing → 402 Payment Required with payment requirements
 *   4. If present → verify proof, check authorization + spend cap
 *   5. If valid → call next(), then record usage after response completes
 */
export function paywall(config: PaywallConfig) {
  const { serviceId } = config;

  return async (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();

    // ── Step 1: Load service from Redis ──
    const serviceData = await redis.hgetall(`service:${serviceId}`);
    if (!serviceData || Object.keys(serviceData).length === 0) {
      res.status(404).json({ error: "Service not found", serviceId });
      return;
    }

    const service = serviceData as unknown as Service;

    if (service.status !== "active") {
      res.status(503).json({ error: "Service is currently paused" });
      return;
    }

    // ── Step 2: Check for payment proof ──
    const paymentProof = req.headers[X402_PAYMENT_HEADER] as string | undefined;
    const callerHeader = req.headers[X402_CALLER_HEADER] as string | undefined;

    if (!paymentProof || !callerHeader) {
      // Return 402 with payment requirements
      res.status(402).json({
        status: 402,
        message: "Payment Required",
        authRequired: true,
        authorizationEndpoint: "/api/auth",
        authMessage: "Payment proof required. If you haven't authorized this caller wallet for this service, POST to /api/auth first with {callerWallet, serviceId, spendCap}.",
        serviceId,
        serviceName: service.name,
        pricePerCall: Number(service.pricePerCall),
        providerWallet: service.providerWallet,
        network: "base",
        token: "USDC",
        x402: {
          version: "1",
          description: `Pay ${Number(service.pricePerCall)} micro-USDC to access ${service.name}`,
          payTo: service.providerWallet,
          amount: Number(service.pricePerCall),
          requiredHeaders: [X402_PAYMENT_HEADER, X402_CALLER_HEADER],
        },
      });
      return;
    }

    const callerWallet = normalizeAddress(callerHeader);
    const grossAmount = Number(service.pricePerCall);

    // ── Step 3: Verify payment proof via x402 cryptographic verification ──
    const x402Result = await verifyX402Proof(
      paymentProof,
      grossAmount,
      service.providerWallet
    );

    if (!x402Result.valid) {
      res.status(402).json({ error: "Payment verification failed", detail: x402Result.error });
      return;
    }

    // Confirm the verified payer matches the caller header
    if (x402Result.from !== callerWallet) {
      res.status(402).json({
        error: "Proof signer does not match caller",
        proofFrom: x402Result.from,
        callerWallet,
      });
      return;
    }

    // Parse proof (needed for settlement later)
    const parsedProof = parseX402Proof(paymentProof);
    if (!parsedProof) {
      res.status(402).json({ error: "Failed to re-parse payment proof for settlement" });
      return;
    }

    // ── Step 4: Check authorization ──
    const authData = await redis.hgetall(`auth:${callerWallet}:${serviceId}`);
    if (!authData || Object.keys(authData).length === 0) {
      res.status(403).json({ error: "No authorization found for this caller and service" });
      return;
    }

    const authRecord = authData as unknown as Record<string, unknown>;
    const authKey = `auth:${callerWallet}:${serviceId}`;

    if (authRecord.status !== "active") {
      res.status(403).json({ error: `Authorization is ${authRecord.status}` });
      return;
    }

    // ── Step 5: Atomically reserve spend cap BEFORE nonce consumption ──
    // Over-cap rejection leaves the proof/nonce untouched — caller can retry with the same proof.
    const withinCap = await atomicSpendCapReserve(authKey, grossAmount);
    if (!withinCap) {
      res.status(403).json({ error: "Spend cap exceeded", required: grossAmount });
      return;
    }

    // ── Step 6: Consume nonce AFTER spend cap admission succeeds ──
    // If the nonce is already consumed → release the reserved cap so headroom is restored.
    const nonceConsumed = await consumeX402Nonce(
      callerWallet,
      x402Result.nonce!,
      x402Result.validBefore!
    );
    if (!nonceConsumed) {
      await atomicSpendCapRelease(authKey, grossAmount);
      res.status(402).json({ error: "Payment proof already used — replay rejected" });
      return;
    }

    // ── Step 7: Submit on-chain settlement via receiveWithAuthorization ──
    const settlementResult = await settlePayment(parsedProof);

    if (!settlementResult.success) {
      // If settlement env vars are not set, we skip on-chain settlement (dev/test mode).
      // If env vars ARE set but settlement failed, release the reserved spend cap so the
      // caller's headroom is restored and they can retry with a fresh proof.
      const isNotConfigured =
        settlementResult.error?.includes("BASE_SEPOLIA_RPC_URL or PROVIDER_PRIVATE_KEY not set");

      if (!isNotConfigured) {
        await atomicSpendCapRelease(authKey, grossAmount);
        res.status(402).json({
          error: "On-chain payment settlement failed",
          detail: settlementResult.error,
        });
        return;
      }

      console.warn("[agentpay] Settlement skipped:", settlementResult.error);
    }

    // ── Step 8: Payment verified — allow request through ──
    const breakdown = computeFeeBreakdown(grossAmount, Number(service.platformFeeBps));

    // Attach payment context for downstream handlers if needed
    (req as any).agentpay = {
      serviceId,
      callerWallet,
      providerWallet: service.providerWallet,
      ...breakdown,
      verified: true,
      txHash: settlementResult.txHash,
    };

    // Hook into response finish to record usage
    const txHash = settlementResult.txHash;
    res.on("finish", () => {
      const latencyMs = Date.now() - startTime;
      let status: UsageStatus = "success";
      if (res.statusCode >= 500) {
        status = "failed";
      }

      recordUsage({
        serviceId,
        callerWallet,
        providerWallet: service.providerWallet,
        breakdown,
        status,
        latencyMs,
        txHash,
      }).catch((err) => {
        console.error("[agentpay] Failed to record usage:", err);
      });
    });

    next();
  };
}

interface RecordUsageParams {
  serviceId: string;
  callerWallet: string;
  providerWallet: string;
  breakdown: ReturnType<typeof computeFeeBreakdown>;
  status: UsageStatus;
  latencyMs: number;
  txHash?: `0x${string}`;
}

async function recordUsage(params: RecordUsageParams): Promise<void> {
  const { serviceId, callerWallet, providerWallet, breakdown, status, latencyMs, txHash } = params;
  const now = new Date();

  const record: UsageRecord = {
    id: crypto.randomUUID(),
    serviceId,
    callerWallet,
    providerWallet,
    grossAmount: breakdown.grossAmount,
    platformFee: breakdown.platformFee,
    providerNet: breakdown.providerNet,
    status,
    latencyMs,
    timestamp: now.toISOString(),
    ...(txHash ? { txHash } : {}),
  };

  const pipeline = redis.pipeline();

  // Caller usage sorted set
  pipeline.zadd(`wallet:${callerWallet}:usage`, {
    score: now.getTime(),
    member: JSON.stringify(record),
  });

  // Provider earnings sorted set
  pipeline.zadd(`wallet:${providerWallet}:earnings`, {
    score: now.getTime(),
    member: JSON.stringify(record),
  });

  // Service stats
  pipeline.hincrby(`service:${serviceId}`, "totalCalls", 1);
  pipeline.hincrby(`service:${serviceId}`, "grossVolume", breakdown.grossAmount);
  pipeline.hincrby(`service:${serviceId}`, "totalEarned", breakdown.providerNet);
  pipeline.hincrby(`service:${serviceId}`, "totalFees", breakdown.platformFee);

  // Caller wallet spend
  pipeline.hincrby(`wallet:${callerWallet}`, "totalSpent", breakdown.grossAmount);
  pipeline.hset(`wallet:${callerWallet}`, { lastActiveAt: now.toISOString() } as Record<string, unknown>);

  // Provider wallet earnings
  pipeline.hincrby(`wallet:${providerWallet}`, "totalEarned", breakdown.providerNet);
  pipeline.hset(`wallet:${providerWallet}`, { lastActiveAt: now.toISOString() } as Record<string, unknown>);

  // Platform stats
  pipeline.hincrby("platform:stats", "totalVolume", breakdown.grossAmount);
  pipeline.hincrby("platform:stats", "totalFees", breakdown.platformFee);
  pipeline.hincrby("platform:stats", "totalCalls", 1);

  await pipeline.exec();
}
