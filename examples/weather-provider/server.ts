/**
 * Weather Provider Example — AgentPay SDK integration
 *
 * Demonstrates how to wrap an API endpoint with AgentPay's paywall() middleware
 * so that callers must pay per request using the x402 protocol.
 *
 * Usage: npm start
 * Endpoint: GET /weather?city=London
 */
import "dotenv/config";
import express from "express";
import { paywall } from "@agentpay88/sdk";

const app = express();
app.use(express.json());

const PORT = process.env.PORT ?? 4000;
const SERVICE_ID = process.env.SERVICE_ID;

if (!SERVICE_ID) {
  console.error(
    "\n[weather-provider] ERROR: SERVICE_ID is not set.\n" +
    "  1. Copy .env.example to .env\n" +
    "  2. Register your service with the AgentPay server (see README Step 3)\n" +
    "  3. Paste the returned service ID into .env as SERVICE_ID\n"
  );
  process.exit(1);
}

/**
 * GET /weather?city=<name>
 *
 * Protected by AgentPay paywall. Callers must supply valid x402 payment
 * headers (x-402-payment + x-402-caller) obtained from the AgentPay server.
 *
 * Without payment headers → 402 Payment Required (with pricing details)
 * With valid payment       → 200 with mock weather data
 */
app.get(
  "/weather",
  paywall({ serviceId: SERVICE_ID }),
  (req, res) => {
    const city = (req.query.city as string) ?? "Unknown";

    // Mock weather data — replace with a real weather API call in production
    const mockWeather = {
      city,
      temperature: `${Math.floor(Math.random() * 30 + 5)}°C`,
      condition: ["Sunny", "Cloudy", "Partly cloudy", "Rainy"][Math.floor(Math.random() * 4)],
      humidity: `${Math.floor(Math.random() * 40 + 40)}%`,
      wind: `${Math.floor(Math.random() * 30 + 5)} km/h`,
      timestamp: new Date().toISOString(),
    };

    res.json({
      success: true,
      data: mockWeather,
    });
  }
);

// Health check — no payment required
app.get("/health", (_req, res) => {
  res.json({ status: "ok", serviceId: SERVICE_ID });
});

app.listen(PORT, () => {
  console.log(`\n[weather-provider] Server running on http://localhost:${PORT}`);
  console.log(`  Service ID : ${SERVICE_ID}`);
  console.log(`  AgentPay   : ${process.env.AGENTPAY_URL ?? "http://localhost:3000"}`);
  console.log(`\n  Try: curl http://localhost:${PORT}/weather?city=London`);
  console.log(`       (you will receive a 402 with payment requirements)\n`);
});
