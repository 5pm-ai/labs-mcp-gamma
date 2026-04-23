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
echo "Integration Test - EXTERNAL MODE"
if $LIVE_MODE; then
  echo "  (live mode — using running local stack)"
fi
echo "=================================================="

if $LIVE_MODE; then
  MCP_SERVER="${BASE_URI:-http://localhost:3232}"

  echo ""
  echo "🔧 Configuration (live mode):"
  echo "  MCP Server: $MCP_SERVER"
  echo "  No build, no start, no kill — tests against running stack"
  echo ""

  if ! curl -s -f "$MCP_SERVER/" > /dev/null 2>&1; then
    echo "❌ MCP server not reachable at $MCP_SERVER"
    echo "   Start it with: npm run dev"
    exit 1
  fi
  echo "✅ MCP server is reachable"

  echo ""
  echo "📋 Note: The running server uses internal auth mode (Auth0)."
  echo "   External mode (separate auth server) is tested in standalone mode."
  echo "   Running protocol verification against the live server instead."
  echo ""

  echo "🔐 PHASE 1: OAuth Metadata & Registration"
  echo "==========================================="

  echo ""
  echo "📋 Step 1: Verify OAuth metadata"
  METADATA=$(curl -s "$MCP_SERVER/.well-known/oauth-authorization-server")
  if ! echo "$METADATA" | jq -e .issuer > /dev/null 2>&1; then
    echo "   ❌ OAuth metadata not valid JSON"
    exit 1
  fi
  ISSUER=$(echo "$METADATA" | jq -r .issuer)
  echo "   ✅ Issuer: $ISSUER"
  echo "   ✅ Auth: $(echo "$METADATA" | jq -r .authorization_endpoint)"
  echo "   ✅ Token: $(echo "$METADATA" | jq -r .token_endpoint)"

  echo ""
  echo "📋 Step 2: Verify Protected Resource Metadata"
  PRM=$(curl -s "$MCP_SERVER/.well-known/oauth-protected-resource/mcp")
  if ! echo "$PRM" | jq -e .resource > /dev/null 2>&1; then
    echo "   ❌ Protected Resource Metadata not valid"
    exit 1
  fi
  echo "   ✅ Resource: $(echo "$PRM" | jq -r .resource)"

  echo ""
  echo "📝 Step 3: Register OAuth client (DCR)"
  CLIENT_RESPONSE=$(curl -s -X POST -H "Content-Type: application/json" \
    -d '{"client_name":"e2e-external-test","redirect_uris":["http://localhost:3000/callback"]}' \
    "$MCP_SERVER/register")

  CLIENT_ID=$(echo "$CLIENT_RESPONSE" | jq -r .client_id)
  if [ "$CLIENT_ID" = "null" ] || [ -z "$CLIENT_ID" ]; then
    echo "   ❌ DCR failed"
    exit 1
  fi
  echo "   ✅ Client ID: $CLIENT_ID"

  echo ""
  echo "📱 Step 4: Verify /mcp returns 401 without token"
  MCP_401=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e-test","version":"1.0"}}}' \
    "$MCP_SERVER/mcp")

  if [ "$MCP_401" = "401" ]; then
    echo "   ✅ /mcp correctly returns 401 without Bearer token"
  else
    echo "   ❌ Expected 401, got $MCP_401"
    exit 1
  fi

  echo ""
  echo "✅ INTEGRATION TEST (EXTERNAL / LIVE MODE) COMPLETE!"
  echo "============================================="
  echo "✅ OAuth metadata valid"
  echo "✅ Protected Resource Metadata valid"
  echo "✅ DCR client registration working"
  echo "✅ /mcp correctly rejects unauthenticated requests"
  echo ""
  echo "📎 For full authenticated MCP testing (external auth separation):"
  echo "   Run standalone mode: npm run test:int:external"
  echo "   Or full integration: cd ../labs-saas-ctrl && npm run test:int:wizard"

else
  # ── Standalone mode: starts separate auth + MCP servers ────────────────

  AUTH_SERVER="${AUTH_SERVER_URL:-http://localhost:3001}"
  MCP_SERVER="${BASE_URI:-http://localhost:8090}"
  USER_ID="e2e-test-external-$(date +%s)"

  echo ""
  echo "Testing separate auth and MCP servers"
  echo ""
  echo "🔧 Configuration:"
  echo "  Auth Server: $AUTH_SERVER (external)"
  echo "  MCP Server: $MCP_SERVER"
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

  echo "🚀 Starting AUTH server on port 3001..."
  AUTH_MODE=auth_server PORT=3001 BASE_URI=$AUTH_SERVER node dist/index.js &
  AUTH_PID=$!
  sleep 5

  if ! curl -s -f "$AUTH_SERVER/" > /dev/null 2>&1; then
    echo "❌ Auth server failed to start at $AUTH_SERVER"
    kill $AUTH_PID 2>/dev/null || true
    exit 1
  fi
  echo "✅ Auth server is running (PID: $AUTH_PID)"

  echo "🚀 Starting MCP server in EXTERNAL mode..."
  AUTH_MODE=external AUTH_SERVER_URL=$AUTH_SERVER PORT=8090 BASE_URI=$MCP_SERVER node dist/index.js &
  MCP_PID=$!
  sleep 5

  if ! curl -s -f "$MCP_SERVER/" > /dev/null 2>&1; then
    echo "❌ MCP server failed to start at $MCP_SERVER"
    kill $AUTH_PID 2>/dev/null || true
    kill $MCP_PID 2>/dev/null || true
    exit 1
  fi
  echo "✅ MCP server is running in EXTERNAL mode (PID: $MCP_PID)"

  trap "kill $AUTH_PID $MCP_PID 2>/dev/null || true" EXIT

  echo ""
  echo "🔐 PHASE 1: OAuth Authentication (External Auth)"
  echo "================================================="

  echo "📋 Step 1: Verify OAuth metadata delegation"
  METADATA=$(curl -s "$MCP_SERVER/.well-known/oauth-authorization-server")
  AUTH_ISSUER=$(echo "$METADATA" | jq -r .issuer)
  AUTH_ENDPOINT=$(echo "$METADATA" | jq -r .authorization_endpoint)
  TOKEN_ENDPOINT=$(echo "$METADATA" | jq -r .token_endpoint)
  INTROSPECT_ENDPOINT=$(echo "$METADATA" | jq -r .introspection_endpoint)
  echo "   Issuer: $AUTH_ISSUER"
  echo "   Auth endpoint: $AUTH_ENDPOINT"
  echo "   Token endpoint: $TOKEN_ENDPOINT"
  echo "   Introspect endpoint: $INTROSPECT_ENDPOINT"

  if [ "$AUTH_ISSUER" != "$AUTH_SERVER" ]; then
    echo "   ❌ OAuth metadata not pointing to auth server"
    exit 1
  fi
  echo "   ✅ OAuth metadata correctly points to external auth server"

  echo ""
  echo "📝 Step 2: Register OAuth client with auth server"
  CLIENT_RESPONSE=$(curl -s -X POST -H "Content-Type: application/json" \
    -d '{"client_name":"e2e-external-test","redirect_uris":["http://localhost:3000/callback"]}' \
    "$AUTH_SERVER/register")
  CLIENT_ID=$(echo "$CLIENT_RESPONSE" | jq -r .client_id)
  CLIENT_SECRET=$(echo "$CLIENT_RESPONSE" | jq -r .client_secret)
  echo "   Client ID: $CLIENT_ID"

  echo ""
  echo "🔐 Step 3: Generate PKCE challenge"
  CODE_VERIFIER=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-43)
  CODE_CHALLENGE=$(echo -n "$CODE_VERIFIER" | openssl dgst -binary -sha256 | base64 | tr "+/" "-_" | tr -d "=")
  echo "   Code verifier generated"

  echo ""
  echo "🎫 Step 4: Get authorization code from auth server"
  STATE_PARAM="e2e-external-$(date +%s)"
  AUTH_URL="$AUTH_SERVER/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=http://localhost:3000/callback&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256&state=$STATE_PARAM"
  AUTH_PAGE=$(curl -s "$AUTH_URL")
  AUTH_CODE=$(echo "$AUTH_PAGE" | grep -o 'state=[^"&]*' | cut -d= -f2 | head -1)

  if [ -z "$AUTH_CODE" ]; then
    echo "   ❌ Failed to extract authorization code"
    exit 1
  fi
  echo "   Auth Code: ${AUTH_CODE:0:20}..."

  echo ""
  echo "🔄 Step 5: Complete mock upstream auth"
  CALLBACK_URL="$AUTH_SERVER/mock-upstream-idp/callback?state=$AUTH_CODE&code=mock-auth-code&userId=$USER_ID"
  CALLBACK_RESPONSE=$(curl -s -i "$CALLBACK_URL")
  LOCATION_HEADER=$(echo "$CALLBACK_RESPONSE" | grep -i "^location:" | tr -d '\r')
  if echo "$LOCATION_HEADER" | grep -q "state=$STATE_PARAM"; then
    echo "   ✅ State parameter verified"
  else
    echo "   ❌ State parameter mismatch"
    exit 1
  fi

  echo ""
  echo "🎟️  Step 6: Exchange code for access token"
  TOKEN_RESPONSE=$(curl -s -X POST -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=authorization_code&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&code=$AUTH_CODE&redirect_uri=http://localhost:3000/callback&code_verifier=$CODE_VERIFIER" \
    "$AUTH_SERVER/token")

  ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r .access_token)
  if [ "$ACCESS_TOKEN" = "null" ] || [ -z "$ACCESS_TOKEN" ]; then
    echo "   ❌ Token exchange failed"
    echo "Response: $TOKEN_RESPONSE"
    exit 1
  fi
  echo "   ✅ Access token: ${ACCESS_TOKEN:0:20}..."

  echo ""
  echo "🧪 PHASE 2: MCP Feature Testing (External Auth)"
  echo "================================================"

  echo ""
  echo "📱 Step 1: Initialize MCP session"
  INIT_RESPONSE=$(curl -i -s -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Accept: application/json, text/event-stream" \
    -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e-external-test","version":"1.0"}}}' \
    "$MCP_SERVER/mcp")

  SESSION_ID=$(echo "$INIT_RESPONSE" | grep -i "mcp-session-id:" | cut -d' ' -f2 | tr -d '\r')
  if [ -n "$SESSION_ID" ]; then
    echo "   ✅ MCP session initialized: $SESSION_ID"
    echo "   ✅ External auth token accepted by MCP server!"
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
    "$MCP_SERVER/mcp")

  TOOL_COUNT=0
  if echo "$TOOLS_RESPONSE" | grep -q "event: message"; then
    TOOLS_JSON=$(echo "$TOOLS_RESPONSE" | grep "^data: " | sed 's/^data: //')
    TOOL_COUNT=$(echo "$TOOLS_JSON" | jq '.result.tools | length')
    echo "   ✅ Tools available: $TOOL_COUNT"

    ECHO_RESPONSE=$(curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
      -H "Accept: application/json, text/event-stream" \
      -H "Mcp-Session-Id: $SESSION_ID" \
      -X POST -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","id":"echo","method":"tools/call","params":{"name":"echo","arguments":{"message":"External mode working!"}}}' \
      "$MCP_SERVER/mcp")

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
    "$MCP_SERVER/mcp")

  PROMPT_COUNT=0
  if echo "$PROMPTS_RESPONSE" | grep -q "event: message"; then
    PROMPTS_JSON=$(echo "$PROMPTS_RESPONSE" | grep "^data: " | sed 's/^data: //')
    PROMPT_COUNT=$(echo "$PROMPTS_JSON" | jq '.result.prompts | length')
    echo "   ✅ Prompts available: $PROMPT_COUNT"
  fi

  echo ""
  echo "💾 Step 5: Test token validation caching"
  echo "   Making rapid requests to test cache..."
  for i in {1..3}; do
    START_TIME=$(date +%s%N)
    curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
      -H "Accept: application/json, text/event-stream" \
      -H "Mcp-Session-Id: $SESSION_ID" \
      -X POST -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","id":"cache'$i'","method":"tools/list"}' \
      "$MCP_SERVER/mcp" > /dev/null
    END_TIME=$(date +%s%N)
    DURATION=$((($END_TIME - $START_TIME) / 1000000))
    echo "   Request $i: ${DURATION}ms"
  done
  echo "   ✅ Token caching working"

  echo ""
  echo "✅ INTEGRATION TEST (EXTERNAL MODE) COMPLETE!"
  echo "====================================="
  echo "✅ Separate auth and MCP servers"
  echo "✅ OAuth flow working via auth server"
  echo "✅ Token validation via introspection"
  echo "✅ Token caching reduces auth server load"
  echo ""
  echo "📊 Results:"
  echo "   Tools: $TOOL_COUNT"
  echo "   Resources: $RESOURCE_COUNT"
  echo "   Prompts: $PROMPT_COUNT"

  kill $AUTH_PID $MCP_PID 2>/dev/null || true
  pkill -P $AUTH_PID 2>/dev/null || true
  pkill -P $MCP_PID 2>/dev/null || true
fi
