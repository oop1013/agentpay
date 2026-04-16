import { Router, Request, Response } from "express";
import { redis } from "../lib/redis";
import { PlatformStats } from "../lib/types";

const router = Router();

// GET /api/platform/stats — get platform-wide statistics
router.get("/stats", async (_req: Request, res: Response) => {
  const data = await redis.hgetall("platform:stats");

  const stats: PlatformStats = {
    totalVolume: Number((data as Record<string, unknown>)?.totalVolume ?? 0),
    totalFees: Number((data as Record<string, unknown>)?.totalFees ?? 0),
    totalCalls: Number((data as Record<string, unknown>)?.totalCalls ?? 0),
    totalServices: Number((data as Record<string, unknown>)?.totalServices ?? 0),
    totalWallets: Number((data as Record<string, unknown>)?.totalWallets ?? 0),
  };

  res.json(stats);
});

export default router;
