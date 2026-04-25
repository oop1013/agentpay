# Weather Provider Example

A minimal, copy-paste-ready AgentPay provider — wraps a mock weather endpoint with the `paywall()` middleware so callers pay per request.

## Steps

**1. Clone / enter the directory**

```bash
cd examples/weather-provider
```

**2. Install dependencies**

```bash
npm install
```

**3. Register your service with the AgentPay server**

Make sure the AgentPay server is running (`npm run dev` from the project root), then:

```bash
curl -X POST http://localhost:3000/api/services \
  -H "Content-Type: application/json" \
  -d '{
    "providerWallet": "0xYourWalletAddress",
    "name": "Weather API",
    "endpoint": "http://localhost:4000/weather",
    "pricePerCall": 1000,
    "description": "Current weather for any city — 1000 micro-USDC per call"
  }'
```

Copy the `id` field from the response (e.g. `svc_abc123...`).

**4. Configure environment**

```bash
cp .env.example .env
# Edit .env: set PROVIDER_WALLET and SERVICE_ID (from Step 3)
```

**5. Start the provider server**

```bash
npm start
```

**6. Test the paywall (expect 402)**

```bash
curl http://localhost:4000/weather?city=London
```

You'll receive a `402 Payment Required` response with pricing details — this is correct; no payment headers were supplied.

**7. Create an authorization on AgentPay (caller side)**

```bash
curl -X POST http://localhost:3000/api/auth \
  -H "Content-Type: application/json" \
  -d '{
    "callerWallet": "0xCallerWalletAddress",
    "serviceId": "svc_abc123",
    "spendCap": 50000
  }'
```

**8. Make a paid request**

Use the AgentPay client SDK or the demo helper to obtain `x-402-payment` and `x-402-caller` headers, then:

```bash
curl http://localhost:4000/weather?city=Paris \
  -H "x-402-caller: 0xCallerWalletAddress" \
  -H "x-402-payment: <payment-proof>"
```

**9. Verify usage was recorded**

```bash
curl http://localhost:3000/api/usage/wallet/0xCallerWalletAddress
```

## How it works

- `paywall({ serviceId })` intercepts every request.
- Without payment headers → **402** with pricing (service name, micro-USDC amount, providerWallet).
- With valid headers → proof is verified cryptographically, spend cap checked atomically, usage recorded — then the handler runs.
- Price is always read from Redis (set at registration time) — callers cannot fake a lower price.

## Files

| File | Purpose |
|------|---------|
| `server.ts` | Express server with one paywalled GET `/weather` endpoint |
| `package.json` | Dependencies: `@agentpay88/sdk`, `express`, `tsx` |
| `.env.example` | Required environment variables |
