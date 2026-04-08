import express from "express";
import servicesRouter from "./api/services";
import walletsRouter from "./api/wallets";
import authRouter from "./api/auth";
import payRouter from "./api/pay";
import usageRouter from "./api/usage";
import platformRouter from "./api/platform";
import { paywall } from "./sdk/paywall";

const app = express();
app.use(express.json());

app.use("/api/services", servicesRouter);
app.use("/api/wallets", walletsRouter);
app.use("/api/auth", authRouter);
app.use("/api/pay", payRouter);
app.use("/api/usage", usageRouter);
app.use("/api/platform", platformRouter);

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

export default app;
