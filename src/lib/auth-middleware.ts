import { Request, Response, NextFunction } from "express";

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const configuredKey = process.env.AGENTPAY_API_KEY;

  // Dev mode: no key configured, allow all requests
  if (!configuredKey) {
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
    res.status(401).json({ error: "Missing or invalid API key" });
    return;
  }

  next();
}
