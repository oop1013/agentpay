# AgentPay (working name)

AgentPay is a machine-payments control plane.

It solves two problems:
1. API developers cannot easily charge tiny amounts like $0.01 per call.
2. Agents cannot autonomously pay for services and be tracked safely.

We solve both with one product:
- billing + payment middleware for machine-callable services
- authorization + spend controls for humans and agents
- usage, earnings, and fee accounting
- a lightweight discovery surface later

---

## Phase 1 goal

Build the smallest usable product that lets:

- a developer register a paid API service
- a developer protect an endpoint with `@agentpay/sdk`
- a human or agent client pay via x402
- the server verify payment and allow the request
- the system log usage, earnings, and fees
- the dashboard show services, usage, authorizations, and provider earnings

Phase 1 is **not**:
- a marketplace
- a reputation system
- a credit ledger
- agent-to-agent outsourcing
- a smart contract fee router
- an L2 / chain product

---

## Product surfaces

### 1. For API developers
SDK package: `@agentpay/sdk`

Purpose:
- protect endpoints with paid access
- verify x402 payment proofs
- report usage
- track earnings and fees

Phase 1 feature:
- `paywall({ serviceId: "svc_xxx" })`

### 2. For humans
Web dashboard at `agentpay.xyz`

Purpose:
- connect wallet
- browse services
- authorize usage
- set spend caps
- view usage history
- view provider earnings if they are a service provider

### 3. For agents
Client package: `@agentpay/client`

Purpose:
- wrap `fetch()`
- detect `402 Payment Required`
- pay automatically via x402
- retry request after payment
- let owner monitor spending in dashboard

---

## Tech stack

- TypeScript
- Express or Hono
- Upstash Redis
- Vercel
- x402 / USDC on Base
- React
- wagmi
- viem
- Tailwind CSS
- zod
- uuid

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | Prod | Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Prod | Upstash Redis REST token |
| `PORT` | No | Server port (default 3000) |
| `BASE_SEPOLIA_RPC_URL` | Settlement | JSON-RPC endpoint for Base Sepolia (e.g. `https://sepolia.base.org`) |
| `PROVIDER_PRIVATE_KEY` | Settlement | 0x-prefixed private key of the server wallet used to pay gas for `receiveWithAuthorization` txns |

If `BASE_SEPOLIA_RPC_URL` and `PROVIDER_PRIVATE_KEY` are not set, on-chain settlement is skipped (off-chain proof verification only — useful for local dev).

---

## Source of truth

Phase 1 rules:

- x402 verification is the source of truth for whether a payment succeeded.
- Redis stores application state, service metadata, authorization state, usage records, and derived earnings.
- Redis wallet balances are informational / derived views only, not authoritative stored-value balances.
- Do not implement an internal credits system in Phase 1.

---

## Pricing and fee model

AgentPay charges a platform fee automatically on every successful paid call.

Phase 1 fee model:
- default platform fee = `100` bps = `1%`
- caller pays the listed service price
- provider receives net amount after fee
- platform fee is recorded separately
- fee split is handled in server-side accounting, not onchain

Phase 1 pricing semantics:
- use provider-side fee deduction
- do not add extra user-visible markup
- do not implement hidden user-side spread pricing
- do not implement refunds or disputes in Phase 1

Example:
- listed price = `10000` micro-USDC = `0.01 USDC`
- platform fee = `100` micro-USDC = `0.0001 USDC`
- provider net = `9900` micro-USDC = `0.0099 USDC`

---

## Money representation

**Never use floating point for stored money values.**

All amounts are stored as integer micro-USDC.

- `1 USDC = 1_000_000 micro-USDC`
- `0.01 USDC = 10_000 micro-USDC`

All fee calculations use integer arithmetic and basis points.

Config example:
- `DEFAULT_PLATFORM_FEE_BPS = 100`

Formula:
- `platformFee = floor(grossAmount * feeBps / 10000)`
- `providerNet = grossAmount - platformFee`

Validation rule:
- if `providerNet <= 0`, reject the service price as invalid

Spend cap rule:
- spend caps are enforced against `grossAmount`, not `providerNet`

---

## Security rules

- Never trust client-provided price, provider wallet, or payment amount.
- Price always comes from the `Service` record in Redis.
- Provider wallet always comes from the `Service` record in Redis.
- Usage records are created server-side only.
- Spend cap checks are enforced server-side before allowing the paid request.
- Normalize wallet addresses before storing or comparing.
- Do not implement admin bypasses or hidden mock shortcuts in production code paths.
- Do not trust request body fields for service ownership.
- Do not use frontend state as a source of truth for payment or authorization.

---

## Phase 1 success criteria

Phase 1 is done when:

1. A developer can create a service via API.
2. A developer can protect an endpoint with `paywall({ serviceId })`.
3. An unpaid request returns a valid `402 Payment Required` response.
4. `@agentpay/client` can detect `402`, pay, and retry.
5. Verified payments create usage records and update earnings/fees.
6. A human can connect wallet and view:
   - services
   - usage history
   - authorizations
   - provider earnings
7. Spend cap enforcement works.
8. Provider fee deduction is applied automatically in accounting.

---

## What NOT to build yet

Do not build these in Phase 1:

- smart contract payment router
- onchain fee splitting
- agent passport / reputation scoring
- agent-to-agent outsourcing
- AgentMart marketplace integration
- LLM token routing
- internal credits / stored-value ledger
- multi-chain routing
- subscription billing
- refunds / disputes / chargebacks
- social feed
- advanced analytics
- full mobile optimization
- design-heavy UI polish

---

## UI scope rules

Phase 1 UI should be:
- functional
- minimal
- plain
- desktop-first
- card/table/form based

Do not build:
- animations
- fancy transitions
- deep theming system
- complex mobile layouts

---

## Service registration model

Phase 1 uses **explicit service registration**.

Services are created through:
- `POST /api/services`

The SDK middleware does **not** create services implicitly.

The middleware requires:
- `serviceId`

Price is read from the existing Service record.

This avoids ambiguity and keeps pricing authoritative.

---

## Payment flow

1. Provider creates a Service with:
   - providerWallet
   - name
   - endpoint
   - pricePerCall
   - description
   - category

2. Developer wraps endpoint with:
   - `paywall({ serviceId: "svc_xxx" })`

3. Caller requests protected endpoint.

4. If unpaid:
   - middleware returns `402 Payment Required`
   - response includes `serviceId`, service price, and x402 payment requirements

5. Client library or human client pays and retries with payment proof.

6. Middleware verifies payment proof.

7. If proof is valid:
   - read price from Redis
   - compute `platformFee` and `providerNet`
   - enforce authorization and spend cap
   - allow request to proceed

8. After upstream handler returns:
   - create UsageRecord
   - increment service stats
   - increment caller spend
   - increment provider earnings
   - increment platform fee totals

9. Return upstream result.

---

## Failure policy

Phase 1 rule:
- a successful payment authorizes one request attempt
- if upstream request fails or times out, the usage record should still be created with failure status
- payment is still considered consumed
- do not implement refunds in Phase 1

Allowed statuses:
- `success`
- `failed`
- `timeout`

---

## Core Redis objects

### Service

Key:
- `service:{id}` → Hash

Fields:
- `id` string (uuid)
- `providerWallet` string
- `name` string
- `endpoint` string
- `pricePerCall` number (integer micro-USDC)
- `platformFeeBps` number
- `description` string
- `category` string
- `status` `"active" | "paused"`
- `totalCalls` number
- `grossVolume` number
- `totalEarned` number   # provider net earnings
- `totalFees` number     # platform fees generated by this service
- `createdAt` string (ISO)

### Wallet

Key:
- `wallet:{address}` → Hash

Fields:
- `address` string
- `type` `"human" | "agent" | "provider"`
- `name` string
- `totalSpent` number
- `totalEarned` number
- `createdAt` string (ISO)
- `lastActiveAt` string (ISO)

Notes:
- totals are derived accounting views
- not an authoritative custodial balance

### UsageRecord

Sorted set:
- `wallet:{address}:usage` (score = unix timestamp ms)

Each entry JSON:
- `id` string (uuid)
- `serviceId` string
- `callerWallet` string
- `providerWallet` string
- `grossAmount` number
- `platformFee` number
- `providerNet` number
- `status` `"success" | "failed" | "timeout"`
- `latencyMs` number
- `timestamp` string (ISO)

Optional mirrored provider set later:
- `wallet:{providerAddress}:earnings`

### Authorization

Key:
- `auth:{callerWallet}:{serviceId}` → Hash

Fields:
- `callerWallet` string
- `serviceId` string
- `spendCap` number
- `spent` number
- `status` `"active" | "paused" | "revoked"`
- `createdAt` string (ISO)

### Platform stats

Key:
- `platform:stats` → Hash

Fields:
- `totalVolume` number
- `totalFees` number
- `totalCalls` number
- `totalServices` number
- `totalWallets` number

---

## File structure

```text
agentpay/
├── CLAUDE.md
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── lib/
│   │   ├── redis.ts
│   │   ├── x402.ts
│   │   ├── money.ts
│   │   ├── fees.ts
│   │   ├── addresses.ts
│   │   └── types.ts
│   ├── api/
│   │   ├── services.ts
│   │   ├── wallets.ts
│   │   ├── usage.ts
│   │   ├── auth.ts
│   │   ├── pay.ts
│   │   └── platform.ts
│   ├── sdk/
│   │   ├── paywall.ts
│   │   ├── client.ts
│   │   └── index.ts
│   └── dashboard/
│       ├── index.html
│       ├── App.tsx
│       └── pages/
│           ├── Home.tsx
│           ├── Services.tsx
│           ├── Provider.tsx
│           ├── History.tsx
│           └── Authorizations.tsx
├── contracts/
│   └── PaymentRouter.sol
└── vercel.json