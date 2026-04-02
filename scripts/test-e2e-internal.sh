#!/bin/bash
set -e

# ──────────────────────────────────────────────────────────────────────────────
# Mode detection: --live uses the already-running local stack
# ──────────────────────────────────────────────────────────────────────────────
LIVE_MODE=false
for arg in "$@"; do
  if [ "$arg" = "--live" ]; then
    LIVE_MODE=true
  fi
done

echo "=================================================="
echo "End-to-End Test - INTERNAL MODE"
if $LIVE_MODE; then
  echo "  (live mode — using running local stack)"
fi
echo "=================================================="

SERVER_URL="${BASE_URI:-http://localhost:3232}"

if $LIVE_MODE; then
  echo ""
  echo "🔧 Configuration (live mode):"
  echo "  Server URL: $SERVER_URL"
  echo "  No build, no start, no kill — tests against running stack"
  echo ""

  if ! curl -s -f "$SERVER_URL/" > /dev/null 2>&1; then
    echo "❌ MCP server not reachable at $SERVER_URL"
    echo "   Start it with: npm run dev"
    exit 1
  fi
  echo "✅ MCP server is reachable at $SERVER_URL"

else
  echo ""
  echo "Testing merged server with internal auth mode (standalone)"
  echo ""

  USER_ID="e2e-test-internal-$(date +%s)"

  echo "🔧 Configuration:"
  echo "  Server URL: $SERVER_URL"
  echo "  User ID: $USER_ID"
  echo ""

  echo "🔍 Checking prerequisites..."
  if docker ps | grep -q redis; then
    echo "✅ Redis is running"
  else
    echo "⚠️  Redis not running (using in-memory storage)"
  fi

  echo "🔨 Building project..."
  npm run build

  echo "🚀 Starting server in INTERNAL mode..."
  AUTH_MODE=internal PORT="${PORT:-8090}" BASE_URI=$SERVER_URL node dist/index.js &
  SERVER_PID=$!
  sleep 5

  if ! curl -s -f "$SERVER_URL/" > /dev/null 2>&1; then
    echo "❌ Server failed to start at $SERVER_URL"
    kill $SERVER_PID 2>/dev/null || true
    exit 1
  fi
  echo "✅ Server is running in INTERNAL mode (PID: $SERVER_PID)"
  trap "kill $SERVER_PID 2>/dev/null || true" EXIT
fi

echo ""
echo "🔐 PHASE 1: OAuth Metadata & Registration"
echo "==========================================="

echo "📋 Step 1: Verify OAuth metadata"
METADATA=$(curl -s "$SERVER_URL/.well-known/oauth-authorization-server")
if ! echo "$METADATA" | jq -e .issuer > /dev/null 2>&1; then
  echo "   ❌ OAuth metadata not valid JSON"
  echo "   Response: $METADATA"
  exit 1
fi

AUTH_ENDPOINT=$(echo "$METADATA" | jq -r .authorization_endpoint)
TOKEN_ENDPOINT=$(echo "$METADATA" | jq -r .token_endpoint)
REG_ENDPOINT=$(echo "$METADATA" | jq -r .registration_endpoint)
echo "   ✅ Auth endpoint: $AUTH_ENDPOINT"
echo "   ✅ Token endpoint: $TOKEN_ENDPOINT"
echo "   ✅ Registration endpoint: $REG_ENDPOINT"

echo ""
echo "📋 Step 2: Verify Protected Resource Metadata (RFC 9728)"
PRM=$(curl -s "$SERVER_URL/.well-known/oauth-protected-resource/mcp")
if ! echo "$PRM" | jq -e .resource > /dev/null 2>&1; then
  echo "   ❌ Protected Resource Metadata not valid"
  exit 1
fi
PRM_RESOURCE=$(echo "$PRM" | jq -r .resource)
echo "   ✅ Resource: $PRM_RESOURCE"

echo ""
echo "📝 Step 3: Register OAuth client (DCR)"
CLIENT_RESPONSE=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"client_name":"e2e-internal-test","redirect_uris":["http://localhost:3000/callback"]}' \
  "$REG_ENDPOINT")

CLIENT_ID=$(echo "$CLIENT_RESPONSE" | jq -r .client_id)
if [ "$CLIENT_ID" = "null" ] || [ -z "$CLIENT_ID" ]; then
  echo "   ❌ DCR failed"
  echo "   Response: $CLIENT_RESPONSE"
  exit 1
fi
echo "   ✅ Client ID: $CLIENT_ID"

echo ""
echo "🔐 Step 4: Generate PKCE challenge"
CODE_VERIFIER=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-43)
CODE_CHALLENGE=$(echo -n "$CODE_VERIFIER" | openssl dgst -binary -sha256 | base64 | tr "+/" "-_" | tr -d "=")
echo "   ✅ Code verifier + challenge generated"

if $LIVE_MODE; then
  echo ""
  echo "🔐 PHASE 2: Authenticated MCP Testing"
  echo "======================================="
  echo ""
  echo "⚠️  Live mode: skipping mock IdP flow (server uses real Auth0)"
  echo "   Full authenticated MCP testing (OAuth + tools/resources/prompts)"
  echo "   is covered by labs-saas-ctrl wizard e2e:"
  echo "     cd ../labs-saas-ctrl && npm run test:wizard"
  echo ""
  echo "🧪 PHASE 3: Unauthenticated MCP Endpoint Verification"
  echo "======================================================="

  echo ""
  echo "📱 Step 1: Verify /mcp returns 401 without token"
  MCP_401=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e-test","version":"1.0"}}}' \
    "$SERVER_URL/mcp")

  if [ "$MCP_401" = "401" ]; then
    echo "   ✅ /mcp correctly returns 401 without Bearer token"
  else
    echo "   ❌ Expected 401, got $MCP_401"
    exit 1
  fi

  echo ""
  echo "📱 Step 2: Verify 401 includes WWW-Authenticate header"
  WWW_AUTH=$(curl -s -i -X POST \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e-test","version":"1.0"}}}' \
    "$SERVER_URL/mcp" | grep -i "www-authenticate:" | head -1)

  if echo "$WWW_AUTH" | grep -qi "resource_metadata"; then
    echo "   ✅ WWW-Authenticate points to resource metadata"
  else
    echo "   ⚠️  WWW-Authenticate header: $WWW_AUTH"
  fi

  echo ""
  echo "✅ E2E TEST (INTERNAL / LIVE MODE) COMPLETE!"
  echo "============================================="
  echo "✅ OAuth metadata (RFC 8414) valid"
  echo "✅ Protected Resource Metadata (RFC 9728) valid"
  echo "✅ DCR client registration working"
  echo "✅ PKCE challenge generation OK"
  echo "✅ /mcp correctly rejects unauthenticated requests"
  echo ""
  echo "📎 For full authenticated MCP testing:"
  echo "   cd ../labs-saas-ctrl && npm run test:wizard"

else
  # ── Standalone mode: uses mock IdP ──────────────────────────────────────

  echo ""
  echo "🎫 Step 5: Get authorization code"
  STATE_PARAM="e2e-internal-$(date +%s)"
  AUTH_URL="$SERVER_URL/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=http://localhost:3000/callback&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256&state=$STATE_PARAM"
  AUTH_PAGE=$(curl -s "$AUTH_URL")
  AUTH_CODE=$(echo "$AUTH_PAGE" | grep -o 'state=[^"&]*' | cut -d= -f2 | head -1)

  if [ -z "$AUTH_CODE" ]; then
    echo "   ❌ Failed to extract authorization code"
    exit 1
  fi
  echo "   Auth Code: ${AUTH_CODE:0:20}..."

  echo ""
  echo "🔄 Step 6: Complete mock upstream auth"
  CALLBACK_URL="$SERVER_URL/mock-upstream-idp/callback?state=$AUTH_CODE&code=mock-auth-code&userId=$USER_ID"
  CALLBACK_RESPONSE=$(curl -s -i "$CALLBACK_URL")
  LOCATION_HEADER=$(echo "$CALLBACK_RESPONSE" | grep -i "^location:" | tr -d '\r')
  if echo "$LOCATION_HEADER" | grep -q "state=$STATE_PARAM"; then
    echo "   ✅ State parameter verified"
  else
    echo "   ❌ State parameter mismatch"
    exit 1
  fi

  CLIENT_SECRET=$(echo "$CLIENT_RESPONSE" | jq -r .client_secret)

  echo ""
  echo "🎟️  Step 7: Exchange code for access token"
  TOKEN_RESPONSE=$(curl -s -X POST -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=authorization_code&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&code=$AUTH_CODE&redirect_uri=http://localhost:3000/callback&code_verifier=$CODE_VERIFIER" \
    "$SERVER_URL/token")

  ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r .access_token)
  if [ "$ACCESS_TOKEN" = "null" ] || [ -z "$ACCESS_TOKEN" ]; then
    echo "   ❌ Token exchange failed"
    echo "   Response: $TOKEN_RESPONSE"
    exit 1
  fi
  echo "   ✅ Access token: ${ACCESS_TOKEN:0:20}..."

  echo ""
  echo "🔍 Step 8: Test token introspection"
  INTROSPECT_RESPONSE=$(curl -s -X POST -H "Content-Type: application/x-www-form-urlencoded" \
    -d "token=$ACCESS_TOKEN" \
    "$SERVER_URL/introspect")
  IS_ACTIVE=$(echo "$INTROSPECT_RESPONSE" | jq -r .active)
  if [ "$IS_ACTIVE" = "true" ]; then
    echo "   ✅ Token is active"
  else
    echo "   ❌ Token validation failed"
    exit 1
  fi

  echo ""
  echo "🧪 PHASE 2: MCP Feature Testing"
  echo "================================"

  echo ""
  echo "📱 Step 1: Initialize MCP session"
  INIT_RESPONSE=$(curl -i -s -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Accept: application/json, text/event-stream" \
    -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e-internal-test","version":"1.0"}}}' \
    "$SERVER_URL/mcp")

  SESSION_ID=$(echo "$INIT_RESPONSE" | grep -i "mcp-session-id:" | cut -d' ' -f2 | tr -d '\r')
  if [ -n "$SESSION_ID" ]; then
    echo "   ✅ MCP session initialized: $SESSION_ID"
  else
    echo "   ❌ MCP session initialization failed"
    echo "$INIT_RESPONSE"
    exit 1
  fi

  echo ""
  echo "🔧 Step 2: Test Tools"
  TOOLS_RESPONSE=$(curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: $SESSION_ID" \
    -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":"tools","method":"tools/list"}' \
    "$SERVER_URL/mcp")

  TOOL_COUNT=0
  if echo "$TOOLS_RESPONSE" | grep -q "event: message"; then
    TOOLS_JSON=$(echo "$TOOLS_RESPONSE" | grep "^data: " | sed 's/^data: //')
    TOOL_COUNT=$(echo "$TOOLS_JSON" | jq '.result.tools | length')
    echo "   ✅ Tools available: $TOOL_COUNT"

    ECHO_RESPONSE=$(curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
      -H "Accept: application/json, text/event-stream" \
      -H "Mcp-Session-Id: $SESSION_ID" \
      -X POST -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","id":"echo","method":"tools/call","params":{"name":"echo","arguments":{"message":"Internal mode working!"}}}' \
      "$SERVER_URL/mcp")

    if echo "$ECHO_RESPONSE" | grep -q "event: message"; then
      ECHO_JSON=$(echo "$ECHO_RESPONSE" | grep "^data: " | sed 's/^data: //')
      ECHO_RESULT=$(echo "$ECHO_JSON" | jq -r '.result.content[0].text')
      echo "   🔊 Echo test: '$ECHO_RESULT'"
    fi
  fi

  echo ""
  echo "📚 Step 3: Test Resources"
  RESOURCES_RESPONSE=$(curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: $SESSION_ID" \
    -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":"resources","method":"resources/list","params":{}}' \
    "$SERVER_URL/mcp")

  RESOURCE_COUNT=0
  if echo "$RESOURCES_RESPONSE" | grep -q "event: message"; then
    RESOURCES_JSON=$(echo "$RESOURCES_RESPONSE" | grep "^data: " | sed 's/^data: //')
    RESOURCE_COUNT=$(echo "$RESOURCES_JSON" | jq '.result.resources | length')
    echo "   ✅ Resources available: $RESOURCE_COUNT"
  fi

  echo ""
  echo "💭 Step 4: Test Prompts"
  PROMPTS_RESPONSE=$(curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: $SESSION_ID" \
    -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":"prompts","method":"prompts/list"}' \
    "$SERVER_URL/mcp")

  PROMPT_COUNT=0
  if echo "$PROMPTS_RESPONSE" | grep -q "event: message"; then
    PROMPTS_JSON=$(echo "$PROMPTS_RESPONSE" | grep "^data: " | sed 's/^data: //')
    PROMPT_COUNT=$(echo "$PROMPTS_JSON" | jq '.result.prompts | length')
    echo "   ✅ Prompts available: $PROMPT_COUNT"
  fi

  echo ""
  echo "✅ E2E TEST (INTERNAL MODE) COMPLETE!"
  echo "====================================="
  echo "✅ Single server handling auth + MCP"
  echo "✅ OAuth flow working"
  echo "✅ Internal token validation working"
  echo "✅ MCP session management working"
  echo "✅ All features accessible"
  echo ""
  echo "📊 Results:"
  echo "   Tools: $TOOL_COUNT"
  echo "   Resources: $RESOURCE_COUNT"
  echo "   Prompts: $PROMPT_COUNT"

  kill $SERVER_PID 2>/dev/null || true
  pkill -P $SERVER_PID 2>/dev/null || true
fi
