# Known Issues and Phase 1 Limitations

This document lists known limitations and friction points for Phase 1 of AgentPay. These are intentional scope decisions, not bugs, unless noted otherwise.

---

## Onboarding friction

### Redis credentials required for persistence
**Friction:** The server starts without Upstash credentials but uses an in-memory mock Redis. State is lost on restart. The `.env.example` mentions this but doesn't make it obvious enough that new developers need to sign up for Upstash before state persists across restarts.

**Workaround:** Use the in-memory mock for quick local testing. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` before going to production or multi-session testing.

### API key required for write endpoints in production
**Friction:** `POST /api/services`, `POST /api/wallets`, and `POST /api/auth` require an `Authorization: Bearer <key>` or `X-Api-Key` header when `AGENTPAY_API_KEY` is set in the environment. This is not enforced in local dev but will silently cause 401s if `AGENTPAY_API_KEY` is set without the client knowing to send it.

**Workaround:** Leave `AGENTPAY_API_KEY` unset for local development. Document the key clearly for production deployments.

### Demo service must be explicitly initialized
**Friction:** The demo endpoint (`GET /api/demo/echo`) returns `{"error":"Service not configured"}` (HTTP 500) if `GET /api/demo/setup` has not been called first. The error message is clear but the required setup step is not immediately obvious. The in-memory mock doesn't persist across restarts, so `GET /api/demo/setup` must be called again each time the server restarts without Upstash credentials.

**Workaround:** Always call `GET /api/demo/setup` before testing the demo endpoint. The quickstart guide covers this step.

### Authorization must be created before payment
**Friction:** A caller wallet must have an active authorization record for each service before any payment can succeed. The 402 response does not explain this requirement — callers see a generic 402 and may not know to call `POST /api/auth` first.

**Workaround:** Register both wallet and authorization as part of onboarding. The quickstart covers this step.

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

### `paywall()` requires a pre-registered service
The SDK does not implicitly create services. If `serviceId` does not exist in Redis, the middleware returns a `500` error rather than a meaningful `400/404` response. Always create the service via `POST /api/services` before deploying the middleware.

### No TypeScript types exported for `req.agentpay`
`req.agentpay` is added to the Express Request object by the paywall middleware but is typed as `any` in downstream handlers. TypeScript consumers need to cast or add module augmentation themselves.

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

---

## Not in Phase 1

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
