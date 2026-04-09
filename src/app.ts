import express from "express";
import servicesRouter from "./api/services";
import walletsRouter from "./api/wallets";
import authRouter from "./api/auth";
import payRouter from "./api/pay";
import usageRouter from "./api/usage";
import platformRouter from "./api/platform";
import demoRouter from "./api/demo";
import { paywall } from "./sdk/paywall";
import { requireApiKey } from "./lib/auth-middleware";

const app = express();
app.use(express.json());

// Write endpoints — require API key auth
app.post("/api/services", requireApiKey, servicesRouter);
app.post("/api/wallets", requireApiKey, walletsRouter);
app.post("/api/auth", requireApiKey, authRouter);
app.delete("/api/auth/:callerWallet/:serviceId", requireApiKey, authRouter);

// All methods (includes the public GETs above and any remaining routes)
app.use("/api/services", servicesRouter);
app.use("/api/wallets", walletsRouter);
app.use("/api/auth", authRouter);
app.use("/api/pay", payRouter);
app.use("/api/usage", usageRouter);
app.use("/api/platform", platformRouter);
app.use("/api/demo", demoRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Test endpoint protected by paywall middleware
// serviceId is set dynamically via query param for testing
app.get("/api/test/protected", (req, res, next) => {
  const serviceId = req.query.serviceId as string;
  if (!serviceId) {
    res.status(400).json({ error: "serviceId query param required" });
    return;
  }
  paywall({ serviceId })(req, res, next);
}, (_req, res) => {
  res.json({ message: "Access granted — you paid for this!", data: { result: 42 } });
});

// Global error handler — must be last middleware, after all routes
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[agentpay] Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

export default app;
