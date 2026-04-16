import { Router, Request, Response } from "express";
import { redis } from "../lib/redis";
import { UsageRecord } from "../lib/types";
import { normalizeAddress } from "../lib/addresses";
import logger from "../lib/logger";

const router = Router();

// GET /api/usage/:address — get usage records for a wallet
router.get("/:address", async (req: Request, res: Response) => {
  const address = normalizeAddress(req.params.address as string);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const type = req.query.type === "earnings" ? "earnings" : "usage";

  const key = `wallet:${address}:${type}`;

  const records = await redis.zrange<UsageRecord[]>(
    key,
    "+inf",
    "-inf",
    { byScore: true, rev: true, offset, count: limit }
  );

  logger.info("usage.query", { address, type, limit, offset, count: records.length });
  res.json({ records, limit, offset, type });
});

// GET /api/usage/:address/service/:serviceId — get usage for a specific service
router.get("/:address/service/:serviceId", async (req: Request, res: Response) => {
  const address = normalizeAddress(req.params.address as string);
  const serviceId = req.params.serviceId as string;
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  const allRecords = await redis.zrange<UsageRecord[]>(
    `wallet:${address}:usage`,
    "+inf",
    "-inf",
    { byScore: true, rev: true, offset: 0, count: 500 }
  );

  const filtered = allRecords
    .filter((r) => r.serviceId === serviceId)
    .slice(0, limit);

  res.json({ records: filtered, serviceId });
});

export default router;
