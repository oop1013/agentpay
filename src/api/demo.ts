import { Router, Request, Response } from "express";
import { redis } from "../lib/redis";
import { Service } from "../lib/types";
import { DEFAULT_PLATFORM_FEE_BPS } from "../lib/money";
import { paywall } from "../sdk/paywall";

const router = Router();

// Fixed demo service ID — stable across deploys, seeded once
const DEMO_SERVICE_ID = process.env.DEMO_SERVICE_ID || "svc_demo";

// Seed provider wallet — a well-known test address
const DEMO_PROVIDER_WALLET =
  process.env.DEMO_PROVIDER_WALLET ||
  "0x000000000000000000000000000000000000dead";

/**
 * GET /api/demo/setup
 *
 * Idempotent — creates the demo service if it doesn't already exist.
 * Returns the service record so callers know the serviceId and pricePerCall.
 * Safe to call multiple times.
 */
router.get("/setup", async (_req: Request, res: Response) => {
  const key = `service:${DEMO_SERVICE_ID}`;
  const existing = await redis.hgetall(key);

  if (existing && Object.keys(existing).length > 0) {
    res.json({ created: false, service: existing });
    return;
  }

  const baseUrl =
    process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : `http://localhost:${process.env.PORT || 3000}`;

  const now = new Date().toISOString();
  const service: Service = {
    id: DEMO_SERVICE_ID,
    providerWallet: DEMO_PROVIDER_WALLET.toLowerCase(),
    name: "Demo Echo API",
    endpoint: `${baseUrl}/api/demo/echo`,
    pricePerCall: 10000, // 0.01 USDC in micro-USDC
    platformFeeBps: DEFAULT_PLATFORM_FEE_BPS,
    description: "A demonstration endpoint protected by the AgentPay paywall.",
    category: "demo",
    status: "active",
    totalCalls: 0,
    grossVolume: 0,
    totalEarned: 0,
    totalFees: 0,
    createdAt: now,
  };

  await redis.hset(key, service as unknown as Record<string, unknown>);
  await redis.hincrby("platform:stats", "totalServices", 1);

  res.status(201).json({ created: true, service });
});

/**
 * GET /api/demo/echo
 *
 * A simple paid endpoint protected by the AgentPay paywall.
 * - No payment headers → 402 with x402 payment requirements
 * - Valid payment proof → 200 with echoed request info and usage recorded
 *
 * Callers can use @agentpay88/client to pay automatically.
 */
router.get(
  "/echo",
  paywall({ serviceId: DEMO_SERVICE_ID }),
  (req: Request, res: Response) => {
    const agentpayCtx = (req as any).agentpay;
    res.json({
      message: "Payment verified — welcome to the AgentPay Demo Echo API!",
      echo: {
        method: req.method,
        path: req.path,
        query: req.query,
        headers: {
          "user-agent": req.headers["user-agent"],
          "content-type": req.headers["content-type"],
        },
      },
      payment: agentpayCtx
        ? {
            serviceId: agentpayCtx.serviceId,
            callerWallet: agentpayCtx.callerWallet,
            grossAmount: agentpayCtx.grossAmount,
            platformFee: agentpayCtx.platformFee,
            providerNet: agentpayCtx.providerNet,
          }
        : null,
    });
  }
);

export default router;
