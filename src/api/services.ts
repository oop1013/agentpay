import { Router, Request, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { redis } from "../lib/redis";
import { Service } from "../lib/types";
import { DEFAULT_PLATFORM_FEE_BPS, isValidPrice } from "../lib/money";
import { normalizeAddress, isValidAddress } from "../lib/addresses";
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

  if (!isValidAddress(providerWallet)) {
    res.status(400).json({ error: "Invalid providerWallet address" });
    return;
  }

  const normalizedWallet = normalizeAddress(providerWallet);

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

// GET /api/services — list services with optional filter/search/sort
router.get("/", async (req: Request, res: Response) => {
  const rawWallet = req.query.providerWallet as string | undefined;
  const categoryFilter = req.query.category as string | undefined;
  const searchTerm = req.query.search as string | undefined;
  const statusFilter = (req.query.status as string | undefined) ?? "active";
  const sortBy = (req.query.sortBy as string | undefined) ?? "newest";

  if (sortBy !== "newest" && sortBy !== "popular") {
    res.status(400).json({ error: "Invalid sortBy: must be 'newest' or 'popular'" });
    return;
  }

  let filterWallet: string | null = null;
  if (rawWallet !== undefined) {
    if (!isValidAddress(rawWallet)) {
      res.status(400).json({ error: "Invalid providerWallet address" });
      return;
    }
    filterWallet = normalizeAddress(rawWallet);
  }

  const searchLower = searchTerm ? searchTerm.toLowerCase() : null;

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
      if (!data || Object.keys(data).length === 0) continue;

      if (filterWallet !== null && (data.providerWallet as string) !== filterWallet) continue;
      if ((data.status as string) !== statusFilter) continue;
      if (categoryFilter !== undefined && (data.category as string) !== categoryFilter) continue;
      if (searchLower !== null) {
        const nameMatch = (data.name as string ?? "").toLowerCase().includes(searchLower);
        const descMatch = (data.description as string ?? "").toLowerCase().includes(searchLower);
        if (!nameMatch && !descMatch) continue;
      }

      services.push(data);
    }
  } while (cursor !== 0);

  if (sortBy === "popular") {
    services.sort((a, b) => Number(b.totalCalls ?? 0) - Number(a.totalCalls ?? 0));
  } else {
    services.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt as string).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt as string).getTime() : 0;
      return bTime - aTime;
    });
  }

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

// GET /api/services/:id/manifest — return capability manifest v0 (public, no auth)
router.get("/:id/manifest", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const data = await redis.hgetall(`service:${id}`);
  if (!data || Object.keys(data).length === 0) {
    res.status(404).json({ error: "Service not found" });
    return;
  }

  if (data.status === "paused") {
    res.status(410).end();
    return;
  }

  const manifest = {
    manifestVersion: "0.1.0",
    serviceId: data.id as string,
    name: data.name as string,
    description: (data.description as string) ?? "",
    provider: {
      wallet: data.providerWallet as string,
    },
    endpoint: data.endpoint as string,
    pricing: {
      model: "per_call",
      amount: Number(data.pricePerCall),
      currency: "USDC",
      unit: "micro-USDC",
      platformFeeBps: Number(data.platformFeeBps),
    },
    capabilities: [],
    auth: {
      required: true,
      endpoint: "/api/auth",
      description: "Caller must create an authorization with spend cap before making paid requests",
    },
    status: data.status as string,
    createdAt: data.createdAt as string,
  };

  res.json(manifest);
});

const patchServiceSchema = z.object({
  providerWallet: z.string().min(1),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  category: z.string().max(50).optional(),
  endpoint: z.string().url().optional(),
  status: z.enum(["active", "paused"]).optional(),
});

// PATCH /api/services/:id — update a service (owner only)
router.patch("/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;

  const parsed = patchServiceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }

  const { providerWallet, ...updates } = parsed.data;

  if (!isValidAddress(providerWallet)) {
    res.status(400).json({ error: "Invalid providerWallet address" });
    return;
  }

  const normalizedWallet = normalizeAddress(providerWallet);

  const existing = await redis.hgetall(`service:${id}`);
  if (!existing || Object.keys(existing).length === 0) {
    res.status(404).json({ error: "Service not found" });
    return;
  }

  // Ownership check: providerWallet in body must match stored record
  if ((existing.providerWallet as string) !== normalizedWallet) {
    res.status(403).json({ error: "Forbidden: wallet does not own this service" });
    return;
  }

  const allowedUpdates: Partial<Pick<Service, "name" | "description" | "category" | "endpoint" | "status">> = {};
  if (updates.name !== undefined) allowedUpdates.name = updates.name;
  if (updates.description !== undefined) allowedUpdates.description = updates.description;
  if (updates.category !== undefined) allowedUpdates.category = updates.category;
  if (updates.endpoint !== undefined) allowedUpdates.endpoint = updates.endpoint;
  if (updates.status !== undefined) allowedUpdates.status = updates.status;

  if (Object.keys(allowedUpdates).length === 0) {
    res.status(400).json({ error: "No updatable fields provided" });
    return;
  }

  await redis.hset(`service:${id}`, allowedUpdates as Record<string, unknown>);

  const updated = await redis.hgetall(`service:${id}`);

  logger.info("service.update", {
    serviceId: id,
    providerWallet: normalizedWallet,
    updates: allowedUpdates,
  });

  res.json(updated);
});

export default router;
