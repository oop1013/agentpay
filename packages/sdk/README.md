# @agentpay88/sdk

Express middleware for protecting API endpoints with x402 micropayments.

Callers that lack a valid payment proof receive a `402 Payment Required` response. The middleware verifies EIP-712 signed payment proofs, enforces spend caps, and records usage — all server-side.

## Install

```bash
npm install @agentpay88/sdk express
```

## Quickstart

### Step 1 — Set environment variables

```bash
UPSTASH_REDIS_REST_URL=https://...upstash.io
UPSTASH_REDIS_REST_TOKEN=AXxx...
AGENTPAY_API_KEY=your-secret-api-key
```

If `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are not set, the middleware falls back to an in-memory store. This is useful for local development and testing but **does not persist across restarts** and is not suitable for production.

### Step 2 — Register a service

```bash
curl -X POST https://your-agentpay-server.com/api/services \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-api-key" \
  -d '{
    "providerWallet": "0xYourWalletAddress",
    "name": "My AI API",
    "endpoint": "https://your-api.com/api/generate",
    "pricePerCall": 10000,
    "description": "Generates AI responses",
    "category": "ai"
  }'
```

The response includes the `serviceId` (e.g. `svc_abc123`).

- `pricePerCall` is in **micro-USDC** (`10000` = `0.01 USDC`)
- `providerWallet` is where earnings are tracked

### Step 3 — Protect your endpoint

```ts
import express from "express";
import { paywall } from "@agentpay88/sdk";

const app = express();
app.use(express.json());

app.post(
  "/api/generate",
  paywall({ serviceId: "svc_abc123" }),
  (req, res) => {
    // Only reached after payment is verified
    res.json({ result: "Here is your AI-generated content." });
  }
);

app.listen(3000);
```

That's it. Unpaid requests receive a `402 Payment Required` with the payment requirements embedded in the response body.

## 402 Response format

When no valid payment proof is present, the middleware returns:

```json
{
  "status": 402,
  "message": "Payment Required",
  "serviceId": "svc_abc123",
  "serviceName": "My AI API",
  "pricePerCall": 10000,
  "providerWallet": "0xYourWalletAddress",
  "network": "base",
  "token": "USDC",
  "x402": {
    "version": "1",
    "description": "Pay 10000 micro-USDC to access My AI API",
    "payTo": "0xYourWalletAddress",
    "amount": 10000,
    "requiredHeaders": ["x-402-payment", "x-402-caller"]
  }
}
```

The `@agentpay88/client` package parses this automatically and retries with a signed proof.

## Request headers (paid requests)

Paying clients must include:

| Header | Description |
|---|---|
| `x-402-payment` | Base64-encoded EIP-712 signed proof (ERC-3009 `ReceiveWithAuthorization`) |
| `x-402-caller` | Caller wallet address |

## Authorization and spend caps

Callers must have an active authorization record before paying. Create one via the API:

```bash
curl -X POST https://your-agentpay-server.com/api/auth \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-api-key" \
  -d '{
    "callerWallet": "0xCallerAddress",
    "serviceId": "svc_abc123",
    "spendCap": 1000000
  }'
```

`spendCap` is in micro-USDC (`1000000` = `1.00 USDC`). Requests that would exceed the cap are rejected with `403 Forbidden`.

## Payment context

After a successful payment, the middleware attaches a context object to `req.agentpay`:

```ts
req.agentpay = {
  serviceId: "svc_abc123",
  callerWallet: "0x...",
  providerWallet: "0x...",
  grossAmount: 10000,
  platformFee: 100,
  providerNet: 9900,
  verified: true,
}
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | Prod | Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Prod | Upstash Redis REST token |
| `AGENTPAY_API_KEY` | Prod | Secret key required to call write endpoints (`POST /api/services`, `POST /api/auth`, etc.) |
| `BASE_SEPOLIA_RPC_URL` | No | JSON-RPC for Base Sepolia (enables on-chain settlement) |
| `PROVIDER_PRIVATE_KEY` | No | Gas wallet private key for settlement transactions |

If `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` are not set, an in-memory mock is used (local dev only — no persistence).

If `BASE_SEPOLIA_RPC_URL` and `PROVIDER_PRIVATE_KEY` are not set, payment proofs are verified cryptographically but not settled on-chain. Suitable for local dev.

## License

ISC
