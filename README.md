# AgentPay

A machine-payments control plane for paid APIs and autonomous agents.

## What it does

AgentPay solves two problems:

1. **API developers** cannot easily charge micro-amounts like $0.01 per call — payment rails are too heavyweight.
2. **Agents** cannot autonomously pay for services and be tracked safely.

AgentPay solves both:

- Billing + payment middleware for machine-callable services (`@agentpay88/sdk`)
- Automatic payment and retry for agent callers (`@agentpay88/client`)
- Authorization, spend caps, usage records, and earnings accounting — all server-side
- A web dashboard for humans to manage authorizations and view usage

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

## Quickstart

### 1. Deploy the AgentPay server

Set environment variables:

```bash
UPSTASH_REDIS_REST_URL=https://...upstash.io
UPSTASH_REDIS_REST_TOKEN=...
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org  # optional: enables on-chain settlement
PROVIDER_PRIVATE_KEY=0x...                      # optional: gas wallet for settlement
```

### 2. Protect an API endpoint

See [`packages/sdk/README.md`](./packages/sdk/README.md).

### 3. Build a paying agent client

See [`packages/client/README.md`](./packages/client/README.md).

## Fee model

AgentPay deducts a 1% platform fee from every successful call.

- **Listed price:** e.g. `10000` micro-USDC = `0.01 USDC`
- **Platform fee (1%):** `100` micro-USDC
- **Provider net:** `9900` micro-USDC

All amounts are integer micro-USDC (`1 USDC = 1_000_000 micro-USDC`).

## License

ISC
