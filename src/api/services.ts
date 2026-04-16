import { Router, Request, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { redis } from "../lib/redis";
import { Service } from "../lib/types";
import { DEFAULT_PLATFORM_FEE_BPS, isValidPrice } from "../lib/money";
import logger from "../lib/logger";

const router = Router();

const createServiceSchema = z.object({
  providerWallet: z.string().min(1),
  name: z.string().min(1).max(100),
  endpoint: z.string().url(),
  pricePerCall: z.number().int().positive(),
  description: z.string().max(500).default(""),
  category: z.string().max(50).default("general"),
});

// POST /api/services — register a new service
router.post("/", async (req: Request, res: Response) => {
  const parsed = createServiceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }

  const { providerWallet, name, endpoint, pricePerCall, description, category } = parsed.data;

  const normalizedWallet = providerWallet.toLowerCase();

  if (!isValidPrice(pricePerCall, DEFAULT_PLATFORM_FEE_BPS)) {
    res.status(400).json({ error: "Price too low: provider net must be positive after fees" });
    return;
  }

  const id = `svc_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const service: Service = {
    id,
    providerWallet: normalizedWallet,
    name,
    endpoint,
    pricePerCall,
    platformFeeBps: DEFAULT_PLATFORM_FEE_BPS,
    description,
    category,
    status: "active",
    totalCalls: 0,
    grossVolume: 0,
    totalEarned: 0,
    totalFees: 0,
    createdAt: now,
  };

  await redis.hset(`service:${id}`, service as unknown as Record<string, unknown>);
  await redis.hincrby("platform:stats", "totalServices", 1);

  logger.info("service.register", {
    serviceId: id,
    providerWallet: normalizedWallet,
    name,
    category,
    pricePerCall,
  });

  res.status(201).json(service);
});

// GET /api/services — list all services
router.get("/", async (_req: Request, res: Response) => {
  const services: Record<string, unknown>[] = [];
  let cursor = 0;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, {
      match: "service:svc_*",
      count: 100,
    });
    cursor = typeof nextCursor === "string" ? parseInt(nextCursor, 10) : nextCursor;
    for (const key of keys) {
      const data = await redis.hgetall(key as string);
      if (data && Object.keys(data).length > 0) {
        services.push(data);
      }
    }
  } while (cursor !== 0);

  res.json({ services });
});

// GET /api/services/:id — get a single service
router.get("/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const data = await redis.hgetall(`service:${id}`);
  if (!data || Object.keys(data).length === 0) {
    res.status(404).json({ error: "Service not found" });
    return;
  }
  res.json(data);
});

export default router;
