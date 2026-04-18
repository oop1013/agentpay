# AgentPay

A machine-payments control plane for paid APIs and autonomous agents.

## What it does

AgentPay solves two problems:

1. **API developers** cannot easily charge micro-amounts like $0.01 per call — payment rails are too heavyweight.
2. **Agents** cannot autonomously pay for services and be tracked safely.

## Status

AgentPay is now publicly available as an early-stage open-source SDK and payment rail for paid APIs and autonomous-agent service calls.

Current status:
- local quickstart works
- first-user demo flow works
- known limitations are documented in `KNOWN_ISSUES.md`
  
AgentPay solves both:

- Billing + payment middleware for machine-callable services (`@agentpay88/sdk`)
- Automatic payment and retry for agent callers (`@agentpay88/client`)
- Authorization, spend caps, usage records, and earnings accounting — all server-side
- A web dashboard for humans to manage authorizations and view usage

## Who is this for?

AgentPay is for:
- API developers who want pay-per-call monetization
- builders experimenting with autonomous agent spending
- teams who need spend caps, authorization, and earnings visibility for machine-callable services

## Why AgentPay?

Most payment rails are too heavy for $0.01 service calls.

AgentPay makes small paid service calls practical by combining:
- paywall middleware for APIs
- automatic client payment + retry
- spend caps and authorization
- usage and earnings tracking

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         API Developer                           │
│                                                                 │
│   Express app + paywall({ serviceId }) middleware               │
│   ↳ uses @agentpay88/sdk                                        │
└───────────────────────────────┬─────────────────────────────────┘
                                │ HTTP 402 ↔ 200
┌───────────────────────────────▼─────────────────────────────────┐
│                       AgentPay Server                            │
│                                                                  │
│   POST /api/services   — register a paid service                 │
│   POST /api/wallets    — register a caller wallet                │
│   POST /api/auth       — create authorization + spend cap        │
│   GET  /api/usage      — query usage records                     │
│   GET  /api/platform   — platform fee stats                      │
│                                                                  │
│   Verifies x402 EIP-712 proofs (ERC-3009 ReceiveWithAuth)        │
│   Records usage, fees, and earnings in Upstash Redis             │
└───────────────────────────────▲─────────────────────────────────┘
                                │ x402 payment headers
┌───────────────────────────────┴─────────────────────────────────┐
│                      Agent / Client                              │
│                                                                  │
│   client.fetch(url)                                              │
│   ↳ detects 402, signs EIP-712 proof, retries                   │
│   ↳ uses @agentpay88/client                                      │
└─────────────────────────────────────────────────────────────────┘
```

**Payment token:** USDC on Base Sepolia (testnet) / Base (mainnet)  
**Proof format:** ERC-3009 `ReceiveWithAuthorization` signed via EIP-712  
**Storage:** Upstash Redis  
**Deployment:** Vercel

## Packages

| Package | Description |
|---|---|
| [`@agentpay88/sdk`](./packages/sdk/README.md) | Server-side Express middleware for protecting endpoints |
| [`@agentpay88/client`](./packages/client/README.md) | Client-side fetch wrapper that auto-pays 402 responses |



---

## Quickstart (local dev)

> **Goal:** Run AgentPay locally and complete a paid API call in under 15 minutes.

### Prerequisites

- Node.js 20+
- Git
- A Base Sepolia wallet with USDC (for real payment proofs; skip for mock/dev mode)

### 1. Clone and install

```bash
git clone https://github.com/oop1013/agentpay.git
cd agentpay
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in values. **For local dev, you can skip everything except:**

```bash
# Optional: set to use persistent Upstash Redis instead of in-memory mock
# UPSTASH_REDIS_REST_URL=https://...upstash.io
# UPSTASH_REDIS_REST_TOKEN=...

# Optional: enables on-chain settlement (skip for local testing)
# BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
# PROVIDER_PRIVATE_KEY=0x...

# Optional: protects write endpoints in production (not required for local dev)
# AGENTPAY_API_KEY=your-secret-key
```

> **Note:** Without Upstash credentials, the server runs with an in-memory mock Redis. State resets on restart. This is fine for local development and testing.

### 3. Start the server

```bash
npm run dev
```

You should see:

```
AgentPay server running on port 3000
[agentpay] No Upstash credentials found — using in-memory mock Redis
```

### 4. Verify the server is running

```bash
curl http://localhost:3000/health
# → {"status":"ok"}
```

### 5. Verify the demo service is ready

The demo service (`/api/demo/echo`) auto-initializes on server startup — no manual setup needed. Confirm it is registered:

```bash
curl http://localhost:3000/api/demo/setup
# → {"created":false,"service":{"id":"svc_demo","name":"Demo Echo API",...}}
```

The `"created":false` response means the service already exists (initialized at startup). The endpoint `GET /api/demo/setup` is kept for backwards compatibility and verification only.

### 6. Register a caller wallet

Before paying, register the wallet that will make calls:

```bash
curl -X POST http://localhost:3000/api/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0xYourWalletAddress",
    "type": "agent",
    "name": "My Test Agent"
  }'
```

### 7. Create an authorization and spend cap

Callers must be explicitly authorized for each service before payments are accepted:

```bash
curl -X POST http://localhost:3000/api/auth \
  -H "Content-Type: application/json" \
  -d '{
    "callerWallet": "0xYourWalletAddress",
    "serviceId": "svc_demo",
    "spendCap": 1000000
  }'
```

`spendCap` is in micro-USDC (`1000000` = 1.00 USDC).

### 8. Make a paid request with `@agentpay88/client`

```ts
import { createEIP712Signer, createAgentPayClient } from "@agentpay88/client";

const signPayment = createEIP712Signer("0xYourPrivateKey");

const client = createAgentPayClient({
  callerWallet: "0xYourWalletAddress",
  signPayment,
});

const res = await client.fetch("http://localhost:3000/api/demo/echo");
const data = await res.json();
console.log(data);
// → { message: "Payment verified — welcome to the AgentPay Demo Echo API!", payment: { ... } }
```

> **If you get a `402`** without a client, the response now includes auth guidance:
> ```json
> {
>   "status": 402,
>   "authRequired": true,
>   "authorizationEndpoint": "/api/auth",
>   "authMessage": "Payment proof required. If you haven't authorized this caller wallet for this service, POST to /api/auth first with {callerWallet, serviceId, spendCap}."
> }
> ```
> This tells you to call `POST /api/auth` (Step 7 above) before attempting paid calls.

See [`packages/client/README.md`](./packages/client/README.md) for full API docs.

### 9. Check the dashboard

Run the dashboard locally:

```bash
npm run dev:dashboard
# Open http://localhost:5173
```

Connect your wallet (MetaMask / WalletConnect) and navigate to:

- **Services** — lists registered services
- **History** — shows usage records for your wallet
- **Authorizations** — shows spend caps and authorization status
- **Provider** — shows earnings if your wallet is a provider

---

## Recommended starting point

The [`examples/weather-provider/`](./examples/weather-provider/) directory is a minimal, copy-paste-ready provider template. It wraps a mock weather endpoint with `paywall()` and includes a full step-by-step README from zero to a working paid API.

```bash
cd examples/weather-provider
npm install
npm start
```

See [`examples/weather-provider/README.md`](./examples/weather-provider/README.md) for the full walkthrough.

---

## Example: protect your own endpoint

### Step 1 — Register a service

```bash
curl -X POST http://localhost:3000/api/services \
  -H "Content-Type: application/json" \
  -d '{
    "providerWallet": "0xYourProviderWallet",
    "name": "My AI API",
    "endpoint": "https://your-api.com/api/generate",
    "pricePerCall": 10000,
    "description": "Generates AI responses",
    "category": "ai"
  }'
```

Response:

```json
{
  "id": "svc_abc123",
  "name": "My AI API",
  "pricePerCall": 10000,
  ...
}
```

Note the `id` — you'll use it in the SDK.

> **If `AGENTPAY_API_KEY` is configured:** add `-H "Authorization: Bearer your-key"` to all POST requests.

### Step 2 — Protect your endpoint

```ts
import express from "express";
import { paywall } from "@agentpay88/sdk";

const app = express();
app.use(express.json());

// This middleware checks for a valid x402 payment proof.
// Unpaid requests get a 402 with payment requirements.
// Paid requests proceed to the handler, with req.agentpay populated.
app.post(
  "/api/generate",
  paywall({ serviceId: "svc_abc123" }),
  (req, res) => {
    console.log("Payment:", req.agentpay);
    // → { serviceId, callerWallet, providerWallet, grossAmount, platformFee, providerNet, verified: true }
    // req.agentpay is fully typed via Express module augmentation — no cast needed.
    res.json({ result: "Here is your AI-generated content." });
  }
);

app.listen(3000);
```

### Step 3 — Test with the client

```ts
import { createEIP712Signer, createAgentPayClient } from "@agentpay88/client";

const client = createAgentPayClient({
  callerWallet: "0xCallerAddress",
  signPayment: createEIP712Signer("0xCallerPrivateKey"),
});

// First call without authorization → may return 403 if no auth record exists
// First call without payment → returns 402 automatically handled by client
const res = await client.fetch("http://localhost:3000/api/generate", {
  method: "POST",
  body: JSON.stringify({ prompt: "Hello" }),
  headers: { "Content-Type": "application/json" },
});

console.log(await res.json());
```

### Step 4 — Verify usage was recorded

```bash
curl "http://localhost:3000/api/usage?walletAddress=0xCallerAddress"
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | Prod | Upstash Redis REST URL. Omit to use in-memory mock (local dev only). |
| `UPSTASH_REDIS_REST_TOKEN` | Prod | Upstash Redis REST token |
| `PORT` | No | Server port (default: 3000) |
| `BASE_SEPOLIA_RPC_URL` | No | JSON-RPC for Base Sepolia. Enables on-chain settlement. |
| `PROVIDER_PRIVATE_KEY` | No | Gas wallet private key for `receiveWithAuthorization` transactions |
| `AGENTPAY_API_KEY` | Prod | Protects write endpoints (wallets, services, auth). Not required for local dev. |
| `ADDITIONAL_CORS_ORIGIN` | No | Additional CORS origin for browser-side cross-origin requests (no trailing slash) |

---

## Fee model

AgentPay deducts a 1% platform fee from every successful call.

- **Listed price:** e.g. `10000` micro-USDC = `0.01 USDC`
- **Platform fee (1%):** `100` micro-USDC
- **Provider net:** `9900` micro-USDC

All amounts are integer micro-USDC (`1 USDC = 1_000_000 micro-USDC`).

---

## Known limitations (Phase 1)

See [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) for a full list of Phase 1 limitations and known friction points.

---

## License

ISC
