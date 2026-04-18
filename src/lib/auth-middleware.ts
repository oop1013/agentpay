import { Request, Response, NextFunction } from "express";

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const configuredKey = process.env.AGENTPAY_API_KEY;

  // If no key is configured: allow in dev/test, deny in production.
  // This prevents accidental open write access on misconfigured production deployments.
  if (!configuredKey) {
    if (process.env.NODE_ENV === "production") {
      res.status(503).json({ error: "Service misconfigured: AGENTPAY_API_KEY is not set. Write access is disabled." });
      return;
    }
    next();
    return;
  }

  const authHeader = req.headers["authorization"];
  const apiKeyHeader = req.headers["x-api-key"] as string | undefined;

  let providedKey: string | undefined;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    providedKey = authHeader.slice(7);
  } else if (apiKeyHeader) {
    providedKey = apiKeyHeader;
  }

  if (!providedKey || providedKey !== configuredKey) {
    res.status(401).json({ error: "API key required", hint: "Include Authorization: Bearer <key> or X-Api-Key: <key> header" });
    return;
  }

  next();
}
