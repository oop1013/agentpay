import { Router, Request, Response } from "express";
import { z } from "zod";
import { UsageRecord } from "../lib/types";
import { redis } from "../lib/redis";
import { registerOrGetWallet, getWallet, toSharedIdentity } from "../lib/wallet-registry";
import { normalizeAddress } from "../lib/addresses";
import logger from "../lib/logger";

const router = Router();

const createWalletSchema = z.object({
  address: z.string().min(1),
  type: z.enum(["human", "agent", "provider"]),
  name: z.string().max(100).default(""),
});

// POST /api/wallets — register a wallet (idempotent: returns existing wallet if already registered)
router.post("/", async (req: Request, res: Response) => {
  const parsed = createWalletSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }

  const { wallet, created } = await registerOrGetWallet(parsed.data);
  logger.info("wallet.register", {
    address: wallet.address,
    type: wallet.type,
    created,
  });
  const status = created ? 201 : 200;
  res.status(status).json({ ...toSharedIdentity(wallet), _wallet: wallet });
});

// GET /api/wallets/:address — get wallet by address
router.get("/:address", async (req: Request, res: Response) => {
  const address = normalizeAddress(req.params.address as string);
  const wallet = await getWallet(address);

  if (!wallet) {
    res.status(404).json({ error: "Wallet not found" });
    return;
  }

  res.json({ ...toSharedIdentity(wallet), _wallet: wallet });
});

// GET /api/wallets/:address/usage — get usage history for a wallet
router.get("/:address/usage", async (req: Request, res: Response) => {
  const address = normalizeAddress(req.params.address as string);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  const records = await redis.zrange<UsageRecord[]>(
    `wallet:${address}:usage`,
    "+inf",
    "-inf",
    { byScore: true, rev: true, offset, count: limit }
  );

  res.json({ records, limit, offset });
});

export default router;
