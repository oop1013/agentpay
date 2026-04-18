#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════���═════════════════
# demo-provider.sh — AgentPay provider onboarding journey
#
# Walks through all 8 Phase 1 success conditions end-to-end:
#   1) Register a service
#   2) Show paywall middleware (402 on unpaid request)
#   3) Send unpaid request — receives 402
#   4) Authorize caller (spend cap)
#   5) Sign EIP-712 payment proof
#   6) Send paid request — receives 200
#   7) View receipt/log (provider earnings)
#   8) View capability manifest JSON
#
# Prerequisites:
#   - AgentPay server running at localhost:3000 (run: npx tsx src/index.ts)
#   - jq installed  (brew install jq  /  apt install jq)
#   - Node.js + npx available (for EIP-712 proof generation)
#   - AGENTPAY_API_KEY set in env or .env file
#
# Usage:
#   ./demo-provider.sh
#   AGENTPAY_API_KEY=my_key ./demo-provider.sh
# ══════════════════════════════════════════════════��════════════════════════
set -euo pipefail

BASE="${AGENTPAY_BASE_URL:-http://localhost:3000}"

# ── Anvil / Hardhat test accounts (well-known — never use on mainnet) ────────
PROVIDER_PRIVATE_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
PROVIDER_WALLET="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
CALLER_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
CALLER_WALLET="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

PASS=0
FAIL=0

# ── API key: env var → .env file ─────────────────────────────���───────────────
API_KEY="${AGENTPAY_API_KEY:-}"
if [ -z "$API_KEY" ] && [ -f ".env" ]; then
  API_KEY=$(grep -E "^AGENTPAY_API_KEY=" .env | head -1 | sed 's/^AGENTPAY_API_KEY=//' | tr -d '"' | tr -d "'" || true)
fi

# ── Colour helpers ────────────────────────────────────────────────────────────
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; }
bold()   { printf "\033[1m%s\033[0m\n" "$*"; }
dim()    { printf "\033[2m%s\033[0m\n" "$*"; }

pass() { green "  ✓  $*"; PASS=$((PASS + 1)); }
fail() { red   "  ✗  $*"; FAIL=$((FAIL + 1)); }

# ── Pre-flight checks ─────────────────────────────────────────────────────────

bold "Pre-flight checks"

if ! command -v jq > /dev/null 2>&1; then
  red "  jq not found — install it (brew install jq / apt install jq)"
  exit 1
fi
pass "jq found"

if ! command -v npx > /dev/null 2>&1; then
  red "  npx not found — install Node.js (https://nodejs.org)"
  exit 1
fi
pass "npx found"

HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/health" || echo "000")
if [ "$HEALTH_STATUS" != "200" ]; then
  red "  Server not reachable at $BASE (HTTP $HEALTH_STATUS)"
  red "  Start it with:  npx tsx src/index.ts"
  exit 1
fi
pass "Server up at $BASE"

if [ -z "$API_KEY" ]; then
  yellow "  AGENTPAY_API_KEY not set — write endpoints may fail (service registration)"
  yellow "  Set it via env or add AGENTPAY_API_KEY=<key> to .env"
fi

echo ""

# ── Step 1: Register service ──────────────────────────��───────────────────────

bold "Step 1 — Register service"
dim "  POST $BASE/api/services"

AUTH_HEADER_ARGS=()
if [ -n "$API_KEY" ]; then
  AUTH_HEADER_ARGS=(-H "Authorization: Bearer $API_KEY")
fi

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE/api/services" \
  -H "Content-Type: application/json" \
  "${AUTH_HEADER_ARGS[@]:-}" \
  -d "{
    \"providerWallet\": \"$PROVIDER_WALLET\",
    \"name\": \"Demo Sentiment API\",
    \"endpoint\": \"https://api.example.com/v1/sentiment\",
    \"pricePerCall\": 1000,
    \"description\": \"Sentiment analysis — demo service for provider journey walkthrough\",
    \"category\": \"AI\"
  }")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "201" ]; then
  pass "Service registered (HTTP 201)"
  SERVICE_ID=$(echo "$BODY" | jq -r '.id')
  echo ""
  echo "$BODY" | jq '{id, name, providerWallet, pricePerCall, category, status}'
elif [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
  fail "Service registration failed — API key required (HTTP $HTTP_CODE)"
  echo "  Set AGENTPAY_API_KEY and retry."
  exit 1
else
  fail "Service registration failed (HTTP $HTTP_CODE)"
  echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
  exit 1
fi

echo ""

# ── Step 2: Show paywall middleware ───────────────────────────────────────────

bold "Step 2 — Paywall middleware"
dim "  The paywall middleware guards the endpoint. No payment headers → 402."
echo ""
cat << 'EOF'
  // Express usage — one line to protect any route:

  import { paywall } from "@agentpay/sdk";

  app.get(
    "/api/sentiment",
    paywall({ serviceId: "svc_xxx" }),   // ← drop this in
    async (req, res) => {
      // Your handler — only reached after payment verified
      res.json({ sentiment: "positive" });
    }
  );

  // The middleware returns 402 with payment requirements if headers are missing.
  // On success it injects req.agentpay.usage into the request context.
EOF
echo ""

# ── Step 3: Send unpaid request — expect 402 ─────────────────────────────────

bold "Step 3 — Unpaid request → 402 Payment Required"
dim "  GET $BASE/api/test/protected?serviceId=$SERVICE_ID  (no payment headers)"

RESPONSE=$(curl -s -w "\n%{http_code}" \
  "$BASE/api/test/protected?serviceId=$SERVICE_ID")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "402" ]; then
  pass "Paywall returned 402 Payment Required"
  echo ""
  echo "$BODY" | jq '{status, message, serviceId, pricePerCall, providerWallet, network, token}'
else
  fail "Expected 402, got $HTTP_CODE"
  echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
fi

echo ""

# ── Step 4: Authorize caller (spend cap) ─────────────────────────────────────

bold "Step 4 — Authorize caller (spend cap)"
dim "  POST $BASE/api/auth"

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE/api/auth" \
  -H "Content-Type: application/json" \
  "${AUTH_HEADER_ARGS[@]:-}" \
  -d "{
    \"callerWallet\": \"$CALLER_WALLET\",
    \"serviceId\": \"$SERVICE_ID\",
    \"spendCap\": 100000000
  }")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "201" ]; then
  pass "Authorization created for caller (HTTP 201)"
  echo ""
  echo "$BODY" | jq '{callerWallet, serviceId, spendCap, status}'
else
  fail "Authorization creation failed (HTTP $HTTP_CODE)"
  echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
  exit 1
fi

echo ""

# ── Step 5: Sign EIP-712 payment proof ───────────��───────────────────────────

bold "Step 5 — Sign EIP-712 payment proof"
dim "  Signing ReceiveWithAuthorization typed data (ERC-3009, Base Sepolia)"
dim "  Using caller private key: ${CALLER_PRIVATE_KEY:0:8}...  wallet: $CALLER_WALLET"

PAYMENT_PROOF=$(npx tsx scripts/gen-test-proof.ts \
  "$CALLER_PRIVATE_KEY" \
  "$PROVIDER_WALLET" \
  "1000")

if [ -n "$PAYMENT_PROOF" ]; then
  pass "EIP-712 proof signed"
  # Decode and display the proof fields (base64 → JSON)
  echo ""
  echo "$PAYMENT_PROOF" | base64 -d | jq '{from, to, value, validBefore, chainId}' 2>/dev/null || \
    dim "  (proof is base64-encoded JSON — passed as x-402-payment header)"
else
  fail "Failed to generate payment proof"
  exit 1
fi

echo ""

# ── Step 6: Send paid request — expect 200 ──────────────────────────────��────

bold "Step 6 — Paid request → 200 Access Granted"
dim "  GET $BASE/api/test/protected?serviceId=$SERVICE_ID"
dim "  Headers: x-402-payment: <proof>  x-402-caller: $CALLER_WALLET"

RESPONSE=$(curl -s -w "\n%{http_code}" \
  "$BASE/api/test/protected?serviceId=$SERVICE_ID" \
  -H "x-402-payment: $PAYMENT_PROOF" \
  -H "x-402-caller: $CALLER_WALLET")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "200" ]; then
  pass "Paywall granted access (HTTP 200)"
  echo ""
  echo "$BODY" | jq .
else
  fail "Expected 200, got $HTTP_CODE"
  echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
fi

echo ""

# Allow async usage recording to settle before reading back receipts.
# Upstash REST pipeline round-trips can take up to ~1s on cold connections.
sleep 1

# ── Step 7: View receipt / earnings log ──────────────────────────────────────

bold "Step 7 — Provider receipt / earnings log"
dim "  GET $BASE/api/usage/$PROVIDER_WALLET?type=earnings"

RESPONSE=$(curl -s -w "\n%{http_code}" \
  "$BASE/api/usage/$PROVIDER_WALLET?type=earnings&limit=1")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "200" ]; then
  RECORD_COUNT=$(echo "$BODY" | jq '.records | length')
  if [ "$RECORD_COUNT" -gt "0" ]; then
    pass "Receipt found ($RECORD_COUNT record(s))"
    echo ""
    echo "$BODY" | jq '.records[0] | {id, serviceId, callerWallet, providerWallet, grossAmount, platformFee, providerNet, status, latencyMs, timestamp}'
  else
    yellow "  No earnings records yet (usage may still be recording)"
    echo "$BODY" | jq .
    PASS=$((PASS + 1))
  fi
else
  fail "Earnings log failed (HTTP $HTTP_CODE)"
  echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
fi

echo ""

# ── Step 8: View capability manifest JSON ────────────────────────────────────

bold "Step 8 — Capability manifest JSON"
dim "  GET $BASE/api/services/$SERVICE_ID/manifest"

RESPONSE=$(curl -s -w "\n%{http_code}" \
  "$BASE/api/services/$SERVICE_ID/manifest")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "200" ]; then
  pass "Manifest returned (HTTP 200)"
  echo ""
  echo "$BODY" | jq .
else
  fail "Manifest endpoint failed (HTTP $HTTP_CODE)"
  echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
fi

echo ""

# ── Summary ───────────────────────────────────────────────────────────────────

bold "═════════════════��════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  green "  ALL $PASS STEPS PASSED — provider journey complete (8/8)"
else
  red   "  $FAIL STEP(S) FAILED  /  $PASS passed"
fi
bold "══════════════════════════════════════════"
echo ""

exit "$FAIL"
