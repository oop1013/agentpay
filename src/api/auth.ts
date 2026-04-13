import { Router, Request, Response } from "express";
import { z } from "zod";
import { redis } from "../lib/redis";
import { Authorization } from "../lib/types";
import { normalizeAddress, isValidAddress } from "../lib/addresses";
import logger from "../lib/logger";

const router = Router();

const createAuthSchema = z.object({
  callerWallet: z.string().min(1),
  serviceId: z.string().min(1),
  spendCap: z.number().int().positive(),
});

// POST /api/auth — authorize a caller for a service with a spend cap
router.post("/", async (req: Request, res: Response) => {
  const parsed = createAuthSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }

  if (!isValidAddress(parsed.data.callerWallet)) {
    res.status(400).json({ error: "Invalid callerWallet address format" });
    return;
  }
  const callerWallet = normalizeAddress(parsed.data.callerWallet);
  const { serviceId, spendCap } = parsed.data;

  // Verify service exists
  const service = await redis.hgetall(`service:${serviceId}`);
  if (!service || Object.keys(service).length === 0) {
    res.status(404).json({ error: "Service not found" });
    return;
  }

  const key = `auth:${callerWallet}:${serviceId}`;
  const now = new Date().toISOString();

  const existing = await redis.hgetall(key);
  if (existing && Object.keys(existing).length > 0) {
    // Update existing authorization
    await redis.hset(key, { spendCap, status: "active" } as Record<string, unknown>);
    const updated = await redis.hgetall(key);
    logger.info("auth.create", { callerWallet, serviceId, spendCap, updated: true });
    res.json(updated);
    return;
  }

  const authorization: Authorization = {
    callerWallet,
    serviceId,
    spendCap,
    spent: 0,
    status: "active",
    createdAt: now,
  };

  await redis.hset(key, authorization as unknown as Record<string, unknown>);
  logger.info("auth.create", { callerWallet, serviceId, spendCap, updated: false });

  res.status(201).json(authorization);
});

// GET /api/auth/:callerWallet — list all authorizations for a caller
router.get("/:callerWallet", async (req: Request, res: Response) => {
  const callerWallet = normalizeAddress(req.params.callerWallet as string);

  // Scan for all auth keys for this wallet
  const authorizations: Record<string, unknown>[] = [];
  let cursor = 0;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, {
      match: `auth:${callerWallet}:*`,
      count: 100,
    });
    cursor = typeof nextCursor === "string" ? parseInt(nextCursor, 10) : nextCursor;
    for (const key of keys) {
      const data = await redis.hgetall(key as string);
      if (data && Object.keys(data).length > 0) {
        authorizations.push(data);
      }
    }
  } while (cursor !== 0);

  res.json({ authorizations });
});

// DELETE /api/auth/:callerWallet/:serviceId — revoke an authorization
router.delete("/:callerWallet/:serviceId", async (req: Request, res: Response) => {
  const callerWallet = normalizeAddress(req.params.callerWallet as string);
  const serviceId = req.params.serviceId as string;

  const key = `auth:${callerWallet}:${serviceId}`;
  const existing = await redis.hgetall(key);

  if (!existing || Object.keys(existing).length === 0) {
    res.status(404).json({ error: "Authorization not found" });
    return;
  }

  await redis.hset(key, { status: "revoked" } as Record<string, unknown>);

  logger.info("auth.revoke", { callerWallet, serviceId });
  const updated = await redis.hgetall(key);
  res.json(updated);
});

export default router;
