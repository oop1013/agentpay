import { Router, Request, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { redis } from "../lib/redis";
import { Service, UsageRecord } from "../lib/types";
import { normalizeAddress } from "../lib/addresses";
import { computeFeeBreakdown } from "../lib/fees";
import { verifyX402Proof } from "../lib/x402";

const router = Router();

const verifyPaymentSchema = z.object({
  serviceId: z.string().min(1),
  callerWallet: z.string().min(1),
  paymentProof: z.string().min(1),
});

// POST /api/pay/verify — verify payment and return fee breakdown
// Phase 1: placeholder verification — will integrate x402 verification
router.post("/verify", async (req: Request, res: Response) => {
  const parsed = verifyPaymentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }

  const { serviceId, paymentProof } = parsed.data;
  const callerWallet = normalizeAddress(parsed.data.callerWallet);

  // Price always comes from the Service record, never from the client
  const serviceData = await redis.hgetall(`service:${serviceId}`);
  if (!serviceData || Object.keys(serviceData).length === 0) {
    res.status(404).json({ error: "Service not found" });
    return;
  }

  const service = serviceData as unknown as Service;

  if (service.status !== "active") {
    res.status(403).json({ error: "Service is not active" });
    return;
  }

  // Check authorization and spend cap
  const authData = await redis.hgetall(`auth:${callerWallet}:${serviceId}`);
  if (!authData || Object.keys(authData).length === 0) {
    res.status(403).json({ error: "No authorization found for this caller and service" });
    return;
  }

  const authStatus = (authData as Record<string, unknown>).status as string;
  if (authStatus !== "active") {
    res.status(403).json({ error: `Authorization is ${authStatus}` });
    return;
  }

  const spendCap = Number((authData as Record<string, unknown>).spendCap);
  const spent = Number((authData as Record<string, unknown>).spent);
  const grossAmount = Number(service.pricePerCall);

  // Spend cap is enforced against grossAmount
  if (spent + grossAmount > spendCap) {
    res.status(403).json({
      error: "Spend cap exceeded",
      spendCap,
      spent,
      required: grossAmount,
    });
    return;
  }

  // x402 cryptographic payment proof verification
  const x402Result = await verifyX402Proof(
    paymentProof,
    grossAmount,
    service.providerWallet
  );

  if (!x402Result.valid) {
    res.status(402).json({ error: "Payment verification failed", detail: x402Result.error });
    return;
  }

  // Confirm the verified payer matches the declared callerWallet
  if (x402Result.from !== callerWallet) {
    res.status(402).json({
      error: "Proof signer does not match caller",
      proofFrom: x402Result.from,
      callerWallet,
    });
    return;
  }

  const breakdown = computeFeeBreakdown(grossAmount, Number(service.platformFeeBps));

  res.json({
    verified: true,
    serviceId,
    callerWallet,
    ...breakdown,
  });
});

const recordUsageSchema = z.object({
  serviceId: z.string().min(1),
  callerWallet: z.string().min(1),
  status: z.enum(["success", "failed", "timeout"]),
  latencyMs: z.number().int().nonnegative(),
});

// POST /api/pay/record — record usage after a verified payment
router.post("/record", async (req: Request, res: Response) => {
  const parsed = recordUsageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }

  const { serviceId, status, latencyMs } = parsed.data;
  const callerWallet = normalizeAddress(parsed.data.callerWallet);

  // Price and provider wallet always come from the Service record
  const serviceData = await redis.hgetall(`service:${serviceId}`);
  if (!serviceData || Object.keys(serviceData).length === 0) {
    res.status(404).json({ error: "Service not found" });
    return;
  }

  const service = serviceData as unknown as Service;
  const grossAmount = Number(service.pricePerCall);
  const providerWallet = service.providerWallet;
  const breakdown = computeFeeBreakdown(grossAmount, Number(service.platformFeeBps));

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
  };

  const pipeline = redis.pipeline();

  // Add to caller usage sorted set (score = unix timestamp ms)
  pipeline.zadd(`wallet:${callerWallet}:usage`, {
    score: now.getTime(),
    member: JSON.stringify(record),
  });

  // Add to provider earnings sorted set
  pipeline.zadd(`wallet:${providerWallet}:earnings`, {
    score: now.getTime(),
    member: JSON.stringify(record),
  });

  // Update service stats
  pipeline.hincrby(`service:${serviceId}`, "totalCalls", 1);
  pipeline.hincrby(`service:${serviceId}`, "grossVolume", breakdown.grossAmount);
  pipeline.hincrby(`service:${serviceId}`, "totalEarned", breakdown.providerNet);
  pipeline.hincrby(`service:${serviceId}`, "totalFees", breakdown.platformFee);

  // Update caller wallet spend
  pipeline.hincrby(`wallet:${callerWallet}`, "totalSpent", breakdown.grossAmount);
  pipeline.hset(`wallet:${callerWallet}`, { lastActiveAt: now.toISOString() } as Record<string, unknown>);

  // Update provider wallet earnings
  pipeline.hincrby(`wallet:${providerWallet}`, "totalEarned", breakdown.providerNet);
  pipeline.hset(`wallet:${providerWallet}`, { lastActiveAt: now.toISOString() } as Record<string, unknown>);

  // Update authorization spent
  pipeline.hincrby(`auth:${callerWallet}:${serviceId}`, "spent", breakdown.grossAmount);

  // Update platform stats
  pipeline.hincrby("platform:stats", "totalVolume", breakdown.grossAmount);
  pipeline.hincrby("platform:stats", "totalFees", breakdown.platformFee);
  pipeline.hincrby("platform:stats", "totalCalls", 1);

  await pipeline.exec();

  res.status(201).json(record);
});

export default router;
