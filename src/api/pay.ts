import { Router, Request, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { redis } from "../lib/redis";
import { Service, UsageRecord } from "../lib/types";
import { normalizeAddress, isValidAddress } from "../lib/addresses";
import { computeFeeBreakdown } from "../lib/fees";
import { verifyX402Proof, parseX402Proof, consumeX402Nonce } from "../lib/x402";
import { atomicSpendCapReserve, atomicSpendCapRelease } from "../lib/redis-scripts";
import logger from "../lib/logger";

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
  if (!isValidAddress(parsed.data.callerWallet)) {
    res.status(400).json({ error: "Invalid callerWallet address format" });
    return;
  }
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

  logger.info("payment.verify", {
    serviceId,
    callerWallet,
    providerWallet: service.providerWallet,
    grossAmount: breakdown.grossAmount,
    providerNet: breakdown.providerNet,
    platformFee: breakdown.platformFee,
  });

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
  /** x402 payment proof — server derives nonce and validBefore from this; never trust client-supplied nonce fields */
  paymentProof: z.string().min(1),
});

// POST /api/pay/record — record usage after a verified payment
router.post("/record", async (req: Request, res: Response) => {
  const parsed = recordUsageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }

  const { serviceId, status, latencyMs, paymentProof } = parsed.data;
  if (!isValidAddress(parsed.data.callerWallet)) {
    res.status(400).json({ error: "Invalid callerWallet address format" });
    return;
  }
  const callerWallet = normalizeAddress(parsed.data.callerWallet);

  // Server-derive nonce and validBefore from the payment proof — never trust client-supplied nonce fields.
  const parsedProof = parseX402Proof(paymentProof);
  if (!parsedProof) {
    res.status(400).json({ error: "Invalid paymentProof — cannot derive nonce for replay protection" });
    return;
  }
  const paymentNonce = parsedProof.nonce;
  const paymentValidBefore = Number(parsedProof.validBefore);

  // Idempotency: atomic claim/finalize flow to prevent parallel duplicate processing.
  // Key is scoped to caller+service to prevent cross-caller key collisions.
  const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
  let idempotencyCacheKey: string | undefined;
  if (idempotencyKey) {
    idempotencyCacheKey = `idempotency:record:${callerWallet}:${serviceId}:${idempotencyKey}`;
    // Atomically try to claim the slot (SET NX "pending").
    const claimed = await redis.set(idempotencyCacheKey, "pending", { nx: true, ex: 86400 });
    if (claimed === null) {
      // Already claimed — check whether it's finalized or still in-flight.
      const existing = await redis.get(idempotencyCacheKey) as string | null;
      if (existing && existing !== "pending") {
        res.status(201).json(JSON.parse(existing));
        return;
      }
      // Parallel duplicate still in flight — tell caller to retry.
      res.status(409).json({ error: "Duplicate request in progress. Retry after a moment." });
      return;
    }
    // claimed !== null: we own the slot, proceed to record.
  }

  // Release the idempotency slot on any non-success exit so retries are not wedged for 24h.
  const releaseSlot = async () => {
    if (idempotencyCacheKey) {
      await redis.del(idempotencyCacheKey);
    }
  };

  // Price and provider wallet always come from the Service record
  const serviceData = await redis.hgetall(`service:${serviceId}`);
  if (!serviceData || Object.keys(serviceData).length === 0) {
    await releaseSlot();
    res.status(404).json({ error: "Service not found" });
    return;
  }

  const service = serviceData as unknown as Service;

  // Verify authorization exists and is still active before recording spend.
  const authData = await redis.hgetall(`auth:${callerWallet}:${serviceId}`);
  if (!authData || Object.keys(authData).length === 0) {
    await releaseSlot();
    res.status(403).json({ error: "No authorization found for this caller and service" });
    return;
  }
  const authStatus = (authData as Record<string, unknown>).status as string;
  if (authStatus !== "active") {
    await releaseSlot();
    res.status(403).json({ error: `Authorization is ${authStatus}` });
    return;
  }

  const grossAmount = Number(service.pricePerCall);
  const providerWallet = service.providerWallet;
  const authKey = `auth:${callerWallet}:${serviceId}`;

  // Cryptographic proof verification — same invariants as /api/pay/verify.
  // Must be called BEFORE consuming the nonce so that forged proofs fail closed
  // without burning a legitimate nonce.
  const x402Result = await verifyX402Proof(paymentProof, grossAmount, providerWallet);
  if (!x402Result.valid) {
    await releaseSlot();
    res.status(402).json({ error: "Payment proof verification failed", detail: x402Result.error });
    return;
  }
  // Confirm the verified signer matches the declared callerWallet.
  if (x402Result.from !== callerWallet) {
    await releaseSlot();
    res.status(402).json({
      error: "Proof signer does not match callerWallet",
      proofFrom: x402Result.from,
      callerWallet,
    });
    return;
  }

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

  // Consume the payment nonce BEFORE reserving spend cap — ensures a replayed proof
  // fails closed without burning the caller's spend cap headroom.
  const nonceAccepted = await consumeX402Nonce(callerWallet, paymentNonce, paymentValidBefore);
  if (!nonceAccepted) {
    await releaseSlot();
    res.status(409).json({ error: "Payment proof already used: nonce has been consumed" });
    return;
  }

  // Atomically reserve spend cap AFTER proof verification and nonce consumption.
  // Placing the reservation here means only a pipeline write failure can leave
  // the cap incremented without a committed record — handled below with a release.
  const withinCap = await atomicSpendCapReserve(authKey, grossAmount);
  if (!withinCap) {
    await releaseSlot();
    res.status(403).json({ error: "Spend cap exceeded", required: grossAmount });
    return;
  }

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

  // Update platform stats
  pipeline.hincrby("platform:stats", "totalVolume", breakdown.grossAmount);
  pipeline.hincrby("platform:stats", "totalFees", breakdown.platformFee);
  pipeline.hincrby("platform:stats", "totalCalls", 1);

  // Finalize idempotency slot in the same pipeline batch as the writes.
  // This makes finalization crash-safe: if the pipeline fails, both the writes
  // and the finalization fail together, so retries are not wedged with a stale "pending" slot.
  if (idempotencyCacheKey) {
    (pipeline as any).set(idempotencyCacheKey, JSON.stringify(record), { ex: 86400 });
  }

  const pipelineResults = await pipeline.exec();

  // Verify pipeline succeeded — all operations must return a non-null result.
  if (!pipelineResults || pipelineResults.some((r) => r === null || r === undefined)) {
    // Pipeline failed after spend cap was reserved — release the reservation so the
    // caller's headroom is restored and they can retry successfully.
    await atomicSpendCapRelease(authKey, grossAmount);
    await releaseSlot();
    res.status(500).json({ error: "Usage recording failed: storage write error" });
    return;
  }

  logger.info("payment.record", {
    recordId: record.id,
    serviceId: record.serviceId,
    callerWallet: record.callerWallet,
    providerWallet: record.providerWallet,
    grossAmount: record.grossAmount,
    providerNet: record.providerNet,
    platformFee: record.platformFee,
    status: record.status,
    latencyMs: record.latencyMs,
  });

  res.status(201).json(record);
});

export default router;
