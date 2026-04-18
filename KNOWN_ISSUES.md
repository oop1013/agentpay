# Known Issues and Limitations

This document lists known limitations and friction points for AgentPay. Resolved items are marked **[FIXED in Phase 2]**. Intentional scope decisions are noted as such.

---

## Onboarding friction

### Redis credentials required for persistence
**Friction:** The server starts without Upstash credentials but uses an in-memory mock Redis. State is lost on restart. The `.env.example` mentions this but doesn't make it obvious enough that new developers need to sign up for Upstash before state persists across restarts.

**Workaround:** Use the in-memory mock for quick local testing. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` before going to production or multi-session testing.

### API key required for write endpoints in production — **[IMPROVED in Phase 2]**
**Friction:** `POST /api/services`, `POST /api/wallets`, and `POST /api/auth` require an `Authorization: Bearer <key>` or `X-Api-Key` header when `AGENTPAY_API_KEY` is set in the environment. This is not enforced in local dev (omit the env var).

**Improvement:** The `401` response now includes a `hint` field with the exact required header format (`Authorization: Bearer <key>` or `X-Api-Key: <key>`), so callers no longer have to guess the format.

**Workaround:** Leave `AGENTPAY_API_KEY` unset for local development. Set it in production and include the header in all write requests.

### ~~Demo service must be explicitly initialized~~ **[FIXED in Phase 2]**
**Previously:** The demo endpoint returned a 500 if `GET /api/demo/setup` had not been called first.

**Fix:** `initDemoService()` is now called automatically at server startup (non-blocking). The demo service (`svc_demo`) is registered before the server accepts its first requests. `GET /api/demo/setup` is kept for verification and backwards compatibility but is no longer required.

### Authorization must be created before payment — **[IMPROVED in Phase 2]**
**Friction:** A caller wallet must have an active authorization record for each service before any payment can succeed.

**Improvement:** The `402` response now includes `authRequired: true`, `authorizationEndpoint: "/api/auth"`, and a plain-English `authMessage` that tells callers to `POST /api/auth` first with `{callerWallet, serviceId, spendCap}`. The hidden step is now surfaced in the error response.

**Remaining:** Callers still need to create an authorization explicitly — this requirement has not been removed, only made visible via the improved 402 body.

### USDC on Base Sepolia required for real payment proofs
**Friction:** Making a real paid request requires the caller wallet to hold USDC on Base Sepolia. Getting testnet USDC requires using the Coinbase Base Sepolia faucet or a bridge. This is a meaningful barrier for new developers who want to quickly test the end-to-end flow.

**Workaround:** Use the Coinbase Base Sepolia faucet. For automated testing, the `scripts/gen-test-proof.ts` helper can generate proofs with Anvil test accounts (which are pre-funded in test environments).

---

## Dashboard limitations

### Desktop-only
The dashboard is built for desktop (1024px+). Mobile and tablet layouts are not optimized.

### Wallet connection required to view data
All dashboard pages require connecting a wallet (MetaMask or WalletConnect). There is no read-only view without a connected wallet.

### No real-time updates
Dashboard data is fetched on load and on navigation. There is no polling or WebSocket-based real-time update for usage records, earnings, or authorizations.

### Provider earnings page shows wallet-level totals only
The Provider page shows `totalEarned` and `totalFees` for the connected wallet. It does not break earnings down by service or time period in Phase 1.

---

## Payment / accounting limitations

### No refunds or disputes
Payments are final. A successful payment proof authorizes one request attempt. If the upstream handler returns an error or times out, the payment is still consumed and a `failed` or `timeout` usage record is created. No refunds are issued in Phase 1.

### Spend cap is checked against gross amount
Spend cap enforcement uses the gross (full) call price, not the provider net. This means the platform fee counts against the caller's spend cap.

### No on-chain settlement in dev mode
If `BASE_SEPOLIA_RPC_URL` and `PROVIDER_PRIVATE_KEY` are not set, payment proofs are cryptographically verified but the `receiveWithAuthorization` transaction is never submitted on-chain. The provider does not actually receive USDC on-chain in this mode. This is by design for local dev.

### Nonce replay is not enforced on-chain (off-chain mode)
In off-chain-only mode (no `PROVIDER_PRIVATE_KEY` set), the server checks proof signatures and tracks nonces in Redis, but does not submit transactions. A nonce that was verified server-side is marked as used in Redis; however, if Redis state is lost (e.g. in-memory mock restart), the same proof could be replayed against a fresh Redis instance.

---

## SDK limitations

### `@agentpay88/sdk` requires environment variables at startup
The SDK reads `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` when it imports. If these are missing, it falls back to the in-memory mock. There is no way to pass Redis config programmatically at paywall construction time.

### ~~`paywall()` requires a pre-registered service returns 500~~ **[FIXED in Phase 2]**
**Previously:** If `serviceId` did not exist in Redis, the middleware returned a `500` error.

**Fix:** Unknown `serviceId` now returns `404 Not Found` with `{ "error": "Service not found", "serviceId": "..." }`. Always register the service via `POST /api/services` before deploying the middleware.

### ~~No TypeScript types exported for `req.agentpay`~~ **[FIXED in Phase 2]**
**Previously:** `req.agentpay` was typed as `any` and required manual module augmentation.

**Fix:** `packages/sdk/src/types.ts` now exports an Express module augmentation that types `req.agentpay` as `{ serviceId, callerWallet, providerWallet, grossAmount, platformFee, providerNet, feeBps, verified }`. No cast needed in downstream handlers.

---

## Test isolation

### `test.sh` uses well-known wallet addresses (not unique per run)
**Friction:** The e2e test script uses fixed Anvil test wallet addresses (`0xf39Fd6...`, `0x70997970...`). When Upstash Redis is configured (persistent), wallets registered from previous runs already exist. The wallet `POST /api/wallets` endpoint is idempotent and returns `200` for existing wallets — but the test previously asserted `201` only.

**Status:** Fixed in test.sh — wallet registration now accepts `200` or `201`.

### `test.sh` platform stats assertions don't hold with persistent Redis
**Friction:** The test previously asserted absolute platform counter values (`totalServices=1`, `totalCalls=1`, etc.). With Upstash configured, these counters accumulate across all test runs and can never match hardcoded values.

**Status:** Fixed in test.sh — platform stats checks now assert field presence rather than absolute values. Service-level stats (per-service counters) remain exact since each run creates a fresh service with a unique UUID.

### `test.sh` server startup fails when run via `bash /path/to/test.sh`
**Friction:** The test script uses `npx tsx src/index.ts` (relative path), which requires the working directory to be the project root. Running `bash /mnt/e/agentpay/test.sh` from a different directory causes the tsx process to fail silently.

**Workaround:** Always run as `bash test.sh` from the project root (`/mnt/e/agentpay`).

### `test.sh` service-stat assertions can fail with fast Upstash connections
**Friction:** After a successful paid call, usage recording runs asynchronously (via `res.on("finish", ...)`). With Upstash REST API, the Redis pipeline round-trip takes 300–700ms. The original 0.5s sleep before the stat-check step was insufficient on slower connections, causing `totalCalls` and `grossVolume` to read as `0` even though the call succeeded.

**Status:** Fixed in test.sh — sleep increased to 2s before service-stat assertions.

---

## API shape rough edges

### Wallet earnings nested under `_wallet` in GET /api/wallets/:address
**Friction:** `GET /api/wallets/:address` and `POST /api/wallets` return a merged shape where the top-level object is the shared identity (`address`, `type`, `displayName`, `registeredAt`) and the full wallet record (including `totalEarned`, `totalSpent`, `lastActiveAt`) is nested under the `_wallet` key. Consumers expecting flat `totalEarned` at the top level will get `undefined`.

**Workaround:** Access earnings via `response._wallet.totalEarned` and `response._wallet.totalSpent`. This shape is intentional for Phase 1 — the top-level fields are the cross-system shared identity; the `_wallet` sub-object is the AgentPay-internal accounting view.

### Write endpoints require API key when AGENTPAY_API_KEY is set
**Friction:** `POST /api/services`, `POST /api/wallets`, and `POST /api/auth` return `401 Unauthorized` if `AGENTPAY_API_KEY` is configured in the environment but the caller does not include `Authorization: Bearer <key>` or `X-Api-Key: <key>`. In local dev without the env var, these endpoints are open. The switch in behaviour between configured and unconfigured deployments can cause 401s that are surprising if the key is set but the client doesn't know to send it.

**Workaround:** Always include the API key header in automated scripts and integrations. Check `.env` for `AGENTPAY_API_KEY` value. `test.sh` reads it automatically from `.env`.

---

## Phase 2 additions (not limitations)

The following were rough edges in Phase 1 and were improved in Phase 2:

- **Demo service auto-init** — no manual `GET /api/demo/setup` call needed on startup
- **402 auth guidance** — response body now includes `authRequired`, `authorizationEndpoint`, and `authMessage`
- **401 hint field** — 401 responses on write endpoints include exact header format
- **404 for unknown service** — `paywall()` returns `404` with `serviceId` instead of `500`
- **`req.agentpay` TypeScript types** — full Express module augmentation in `packages/sdk/src/types.ts`
- **Manifest auth field** — `GET /api/services/:id/manifest` includes `auth.required`, `auth.endpoint`, `auth.description`
- **SDK programmatic Redis config** — `paywall({ serviceId, redis: { url, token } })` accepts explicit Redis credentials instead of env-only
- **Weather provider example** — `examples/weather-provider/` is a minimal, copy-paste-ready provider template
- **Regression test pack** — `npm run test:regression` covers provider journey, manifest contract, paused-service 410, and auth/payment flow

---

## Not in scope (intentionally deferred)

These are out of scope by design:

- Refunds, disputes, or chargebacks
- Subscription or recurring billing
- Smart contract fee splitting (fees are handled in server-side accounting only)
- Internal credits or stored-value ledger
- Agent reputation scoring or passport system
- Multi-chain routing (Base Sepolia / Base only)
- Agent-to-agent outsourcing
- Marketplace / discovery features beyond basic service listing
- Mobile-optimized dashboard
- Full analytics or time-series reporting
