# AgentPay v0.1.0 Release Notes

## Repository

- **Source:** https://github.com/oop1013/agentpay
- **Deployed:** https://agentpay-phi.vercel.app

---

## What Works

### Core payment infrastructure
- **SDK paywall middleware** (`@agentpay88/sdk`): `paywall({ serviceId })` Express middleware verifies EIP-712 signed payment proofs, enforces spend caps, and records usage server-side. Requests without a valid proof receive `402 Payment Required`.
- **402 auth flow**: The `402` response body includes `authRequired: true`, `authorizationEndpoint`, and `authMessage` to guide callers through the authorization step before payment.
- **Wallet authorization**: Callers must be explicitly authorized per service via `POST /api/auth`. The authorization record stores the spend cap and enforces it atomically on each call.
- **Spend caps**: `spendCap` (in micro-USDC) is checked against the gross call price on every request. Calls that would exceed the cap are rejected.
- **Manifest schema**: `GET /api/services/:id/manifest` returns the service manifest including pricing, endpoint, and `auth.required`/`auth.endpoint`/`auth.description` fields.
- **Provider registration**: `POST /api/services` registers a paid service with `providerWallet`, `pricePerCall`, `endpoint`, and optional `description`/`category`.
- **Weather provider example**: `examples/weather-provider/` is a minimal, copy-paste-ready provider template wrapping a mock weather endpoint with `paywall()`.

### Client SDK (`@agentpay88/client`)
- `createAgentPayClient` fetch wrapper auto-detects `402` responses, signs an ERC-3009 `ReceiveWithAuthorization` proof via EIP-712, and retries the request automatically.
- `createEIP712Signer` builds a `signPayment` function from a raw private key.

### Server API
- `POST /api/services` — register a paid service
- `POST /api/wallets` — register a caller or provider wallet
- `POST /api/auth` — create an authorization + spend cap
- `GET /api/usage` — query usage records
- `GET /api/platform` — platform fee stats
- `GET /api/services/:id/manifest` — service manifest (pricing, auth)

### Dashboard
- React/Vite dashboard with wallet connection (MetaMask / WalletConnect)
- Views: Services, History, Authorizations, Provider earnings

### Demo
- Demo service (`svc_demo`) auto-initializes at server startup — no manual setup needed.
- `GET /api/demo/setup` remains for verification and backwards compatibility.

---

## Known Rough Edges

### TODOs / missing tests
- No TODO or FIXME comments remain in the source as of v0.1.0.
- Unit test coverage focuses on the core payment flow and fee math. Dashboard components and edge-case error paths have no automated tests.
- `npm run test:regression` covers: provider journey, manifest contract, paused-service 410, auth/payment flow. The `test.sh` e2e script covers the full server lifecycle.

### Hardcoded values
- **Platform fee**: hardcoded at `100 bps` (1%) in `src/lib/money.ts:1`. There is no per-service or per-provider fee override in v0.1.
- **Demo service ID**: the auto-initialized demo service always uses `svc_demo` as its ID. If a service with that ID already exists in Redis, initialization is skipped without error.
- **USDC contract address / chain**: the EIP-712 domain is hardcoded to USDC on Base Sepolia (testnet). Mainnet Base requires a config change.

### Environment assumptions
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` must be set for persistence. Without them the server falls back to an in-memory mock Redis — **state is lost on restart**.
- `PROVIDER_PRIVATE_KEY` + `BASE_SEPOLIA_RPC_URL` are required for on-chain `receiveWithAuthorization` submission. Without them, proofs are verified cryptographically but no USDC moves on-chain.
- `AGENTPAY_API_KEY` must be set in production to protect `POST /api/services`, `POST /api/wallets`, and `POST /api/auth`. In local dev, omit it to keep write endpoints open.

### Other limitations
- No refunds or disputes — payments are final per call.
- Spend cap is enforced against the **gross** price (before platform fee), so the 1% platform fee counts against the caller's cap.
- Nonce replay protection depends on Redis state — in-memory mock loses nonce records on restart, allowing proof replay in dev.
- Dashboard is desktop-only (1024px+); no mobile layout.
- No real-time dashboard updates — data is fetched on load only.
- Wallet earnings are nested under `_wallet` in `GET /api/wallets/:address` (not flat at top level).

---

## How to Run the Demo

### Prerequisites
- Node.js 20+
- A Base Sepolia wallet with USDC (for real proofs; skip for local dev with in-memory mock)

### 1. Clone and install

```bash
git clone https://github.com/oop1013/agentpay.git
cd agentpay
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# For local dev, everything is optional — in-memory Redis is used automatically.
# For production, set UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, and AGENTPAY_API_KEY.
```

### 3. Start the server

```bash
npm run dev
```

Expected output:
```
AgentPay server running on port 3000
[agentpay] No Upstash credentials found — using in-memory mock Redis
[agentpay] Demo service already exists, skipping init
```

### 4. Register a caller wallet

```bash
curl -X POST http://localhost:3000/api/wallets \
  -H "Content-Type: application/json" \
  -d '{"address": "0xYourWalletAddress", "type": "agent", "name": "My Test Agent"}'
```

### 5. Create an authorization and spend cap

```bash
curl -X POST http://localhost:3000/api/auth \
  -H "Content-Type: application/json" \
  -d '{"callerWallet": "0xYourWalletAddress", "serviceId": "svc_demo", "spendCap": 1000000}'
```

`spendCap` is in micro-USDC (`1000000` = 1.00 USDC).

### 6. Make a paid request

```ts
import { createEIP712Signer, createAgentPayClient } from "@agentpay88/client";

const client = createAgentPayClient({
  callerWallet: "0xYourWalletAddress",
  signPayment: createEIP712Signer("0xYourPrivateKey"),
});

const res = await client.fetch("http://localhost:3000/api/demo/echo");
console.log(await res.json());
// → { message: "Payment verified — welcome to the AgentPay Demo Echo API!", payment: { ... } }
```

### 7. Verify usage was recorded

```bash
curl "http://localhost:3000/api/usage?walletAddress=0xYourWalletAddress"
```

---

## How to Verify Payment Authorization + Usage Sync (AgentMart CTA Flow)

This confirms the end-to-end authorization and payment flow works with AgentMart.

### Step 1 — Confirm the service manifest is reachable

```bash
curl https://agentpay-phi.vercel.app/api/services/svc_demo/manifest
```

Expected: JSON with `auth.required: true`, `auth.endpoint: "/api/auth"`, and `pricePerCall`.

### Step 2 — Register a wallet on the deployed server

```bash
curl -X POST https://agentpay-phi.vercel.app/api/wallets \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENTPAY_API_KEY" \
  -d '{"address": "0xYourWalletAddress", "type": "agent", "name": "AgentMart test"}'
```

### Step 3 — Create an authorization (simulates AgentMart CTA)

```bash
curl -X POST https://agentpay-phi.vercel.app/api/auth \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENTPAY_API_KEY" \
  -d '{"callerWallet": "0xYourWalletAddress", "serviceId": "svc_demo", "spendCap": 500000}'
```

### Step 4 — Make a paid request to the deployed endpoint

Use the `@agentpay88/client` SDK pointed at `https://agentpay-phi.vercel.app/api/demo/echo`.

### Step 5 — Confirm usage sync

```bash
curl "https://agentpay-phi.vercel.app/api/usage?walletAddress=0xYourWalletAddress"
```

A usage record with `status: "success"` and a non-zero `grossAmount` confirms the payment was authorized, verified, and recorded. The `platformFee` and `providerNet` fields confirm fee accounting ran correctly.

---

## Fee Model

- **Platform fee:** 1% (100 bps) deducted from every successful call
- **Example:** 10,000 micro-USDC call → 100 micro-USDC platform fee → 9,900 micro-USDC provider net
- All amounts are integer micro-USDC (`1 USDC = 1,000,000 micro-USDC`)

## License

ISC
