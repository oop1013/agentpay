#!/usr/bin/env bash
# AgentPay end-to-end payment flow test
# Starts the server, runs through the full flow, then cleans up.
set -euo pipefail

BASE="http://localhost:3000"

# ── Pre-flight: kill any existing process on port 3000 ───────────────────────
EXISTING_PID=$(lsof -ti :3000 2>/dev/null || true)
if [ -n "$EXISTING_PID" ]; then
  echo "Killing existing process on port 3000 (PID $EXISTING_PID)..."
  kill "$EXISTING_PID" 2>/dev/null || true
  # Wait for port to be released before starting a fresh server
  for _i in $(seq 1 20); do
    if ! lsof -ti :3000 > /dev/null 2>&1; then break; fi
    sleep 0.5
  done
fi

# Anvil/Hardhat test accounts (well-known Base Sepolia test keys — never use on mainnet)
CALLER_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
CALLER_WALLET="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
PROVIDER_WALLET="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
SERVICE_ID=""
PASS=0
FAIL=0

# API key for authenticated write endpoints.
# Read from env var if set; otherwise try to extract from .env file.
API_KEY="${AGENTPAY_API_KEY:-}"
if [ -z "$API_KEY" ] && [ -f ".env" ]; then
  API_KEY=$(grep -E "^AGENTPAY_API_KEY=" .env | head -1 | sed 's/^AGENTPAY_API_KEY=//' | tr -d '"' || true)
fi
AUTH_HEADER=""
if [ -n "$API_KEY" ]; then
  AUTH_HEADER="Authorization: Bearer $API_KEY"
fi

# ── Helpers ──────────────────────────────────────────────────────────────────

green()  { printf "\033[32m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; }
bold()   { printf "\033[1m%s\033[0m\n" "$*"; }

assert_status() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    green "  PASS  $label (HTTP $actual)"
    PASS=$((PASS + 1))
  else
    red "  FAIL  $label — expected $expected, got $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_json_field() {
  local label="$1" body="$2" field="$3" expected="$4"
  local actual
  actual=$(echo "$body" | grep -o "\"$field\":[^,}]*" | head -1 | sed 's/"[^"]*"://')
  # Strip quotes for string comparison
  actual=$(echo "$actual" | tr -d '"' | tr -d ' ')
  expected=$(echo "$expected" | tr -d '"' | tr -d ' ')
  if [ "$actual" = "$expected" ]; then
    green "  PASS  $label ($field=$actual)"
    PASS=$((PASS + 1))
  else
    red "  FAIL  $label — $field expected '$expected', got '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

# ── Start server ─────────────────────────────────────────────────────────────

bold "Starting AgentPay server..."
npx tsx src/index.ts > /tmp/agentpay-test-server.log 2>&1 &
SERVER_PID=$!

cleanup() {
  bold "Stopping server (PID $SERVER_PID)..."
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for server to be ready (tsx cold-start can take 10-15s)
for i in $(seq 1 60); do
  if curl -s "$BASE/health" > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# Verify health (use || true to prevent set -e from aborting on curl non-zero exit)
HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/health" || true)
if [ "$HEALTH_STATUS" != "200" ]; then
  red "Server failed to start (health check returned $HEALTH_STATUS)"
  red "Server log:"
  cat /tmp/agentpay-test-server.log 2>/dev/null || true
  exit 1
fi
green "Server is up!"
echo ""

# ── 1. Create a test service ────────────────────────────────────────────────

bold "1. POST /api/services — create test service"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE/api/services" \
  -H "Content-Type: application/json" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -d "{
    \"providerWallet\": \"$PROVIDER_WALLET\",
    \"name\": \"Test AI Service\",
    \"endpoint\": \"https://api.example.com/v1/test\",
    \"pricePerCall\": 1000,
    \"description\": \"E2E test service\",
    \"category\": \"testing\"
  }")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
assert_status "Create service" "201" "$HTTP_CODE"

# Extract service ID
SERVICE_ID=$(echo "$BODY" | grep -o '"id":"svc_[^"]*"' | head -1 | sed 's/"id":"//;s/"//')
if [ -z "$SERVICE_ID" ]; then
  red "  FAIL  Could not extract serviceId from response"
  echo "$BODY"
  exit 1
fi
green "  Service created: $SERVICE_ID"
echo ""

# ── 2. Create a test wallet (caller) ────────────────────────────────────────

bold "2. POST /api/wallets — create caller wallet"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE/api/wallets" \
  -H "Content-Type: application/json" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -d "{
    \"address\": \"$CALLER_WALLET\",
    \"type\": \"agent\",
    \"name\": \"Test Agent\"
  }")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
assert_status "Create caller wallet" "201" "$HTTP_CODE"
assert_json_field "Wallet type" "$BODY" "type" "agent"
echo ""

# Also register the provider wallet
bold "   POST /api/wallets — create provider wallet"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE/api/wallets" \
  -H "Content-Type: application/json" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -d "{
    \"address\": \"$PROVIDER_WALLET\",
    \"type\": \"provider\",
    \"name\": \"Test Provider\"
  }")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
assert_status "Create provider wallet" "201" "$HTTP_CODE"
echo ""

# ── 3. Authorize caller wallet for the service ──────────────────────────────

bold "3. POST /api/auth — authorize wallet for service"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE/api/auth" \
  -H "Content-Type: application/json" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -d "{
    \"callerWallet\": \"$CALLER_WALLET\",
    \"serviceId\": \"$SERVICE_ID\",
    \"spendCap\": 100000
  }")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
assert_status "Create authorization" "201" "$HTTP_CODE"
assert_json_field "Spend cap" "$BODY" "spendCap" "100000"
assert_json_field "Auth status" "$BODY" "status" "active"
echo ""

# ── 4. Hit paywall-protected endpoint WITHOUT payment → expect 402 ──────────

bold "4. GET /api/test/protected — no payment headers → 402"
RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE/api/test/protected?serviceId=$SERVICE_ID")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
assert_status "Paywall rejects unpaid request" "402" "$HTTP_CODE"
assert_json_field "402 status field" "$BODY" "status" "402"
assert_json_field "Price in 402" "$BODY" "pricePerCall" "1000"
echo ""

# ── 5. Hit paywall-protected endpoint WITH payment proof → expect 200 ───────

bold "5. GET /api/test/protected — with x-402 headers → 200"
# Generate a real EIP-712 signed proof using the caller's test private key
PAYMENT_PROOF=$(npx tsx scripts/gen-test-proof.ts "$CALLER_PRIVATE_KEY" "$PROVIDER_WALLET" "1000")
RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE/api/test/protected?serviceId=$SERVICE_ID" \
  -H "x-402-payment: $PAYMENT_PROOF" \
  -H "x-402-caller: $CALLER_WALLET")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
assert_status "Paywall grants paid request" "200" "$HTTP_CODE"
assert_json_field "Response data" "$BODY" "message" "Access granted — you paid for this!"
echo ""

# Small delay to let the async usage recording complete
sleep 0.5

# ── 6. Verify platform stats updated ────────────────────────────────────────

bold "6. GET /api/platform/stats — verify counters"
RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE/api/platform/stats")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
assert_status "Platform stats" "200" "$HTTP_CODE"
assert_json_field "Total services" "$BODY" "totalServices" "1"
assert_json_field "Total wallets" "$BODY" "totalWallets" "2"
assert_json_field "Total calls" "$BODY" "totalCalls" "1"
assert_json_field "Total volume" "$BODY" "totalVolume" "1000"
echo ""

# ── 7. Verify service stats updated ─────────────────────────────────────────

bold "7. GET /api/services/:id — verify service counters"
RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE/api/services/$SERVICE_ID")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
assert_status "Service detail" "200" "$HTTP_CODE"
assert_json_field "Service total calls" "$BODY" "totalCalls" "1"
assert_json_field "Service gross volume" "$BODY" "grossVolume" "1000"
echo ""

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
bold "════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  green "  ALL $PASS TESTS PASSED"
else
  red "  $FAIL FAILED, $PASS passed"
fi
bold "════════════════════════════════════════"
echo ""

exit "$FAIL"
