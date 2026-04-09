import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
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

// CORS
const allowedOrigins = [
  "https://agentpay.xyz",
  "https://agentpay-phi.vercel.app",
];
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (
        process.env.NODE_ENV !== "production" &&
        /^http:\/\/localhost(:\d+)?$/.test(origin)
      ) {
        return callback(null, true);
      }
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  })
);

// Rate limiting — write: 100 req/min, read: 300 req/min
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded" },
});

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded" },
});

app.use(express.json());

app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") {
    return readLimiter(req, res, next);
  }
  return writeLimiter(req, res, next);
});

// Write endpoints require API key; read endpoints are public
app.use("/api/services", (req, res, next) => {
  if (req.method === "POST") return requireApiKey(req, res, next);
  next();
}, servicesRouter);
app.use("/api/wallets", (req, res, next) => {
  if (req.method === "POST") return requireApiKey(req, res, next);
  next();
}, walletsRouter);
app.use("/api/auth", (req, res, next) => {
  if (req.method === "POST" || req.method === "DELETE") return requireApiKey(req, res, next);
  next();
}, authRouter);
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
