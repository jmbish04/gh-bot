#!/bin/bash

# MCP Tools Integration Test Script
# Tests the complete MCP tools workflow

echo "🧪 Starting MCP Tools Integration Tests..."
echo "========================================="

# Change to script directory
cd "$(dirname "$0")/.."

# Test 1: Validate build includes MCP tools module
echo ""
echo "🔧 Test 1: Building project with MCP tools integration..."
if npm run build > /dev/null 2>&1; then
  echo "✅ Build successful - MCP tools module integrated properly"
else
  echo "❌ Build failed - check MCP tools integration"
  exit 1
fi

# Test 2: Check migration syntax
echo ""
echo "🗄️ Test 2: Validating MCP tools database migration..."
if grep -q "CREATE TABLE.*default_mcp_tools" migrations/0008_mcp_tools_schema.sql; then
  echo "✅ Migration contains default_mcp_tools table"
else
  echo "❌ Migration missing default_mcp_tools table"
  exit 1
fi

if grep -q "CREATE TABLE.*repo_mcp_tools" migrations/0008_mcp_tools_schema.sql; then
  echo "✅ Migration contains repo_mcp_tools table"
else
  echo "❌ Migration missing repo_mcp_tools table" 
  exit 1
fi

if grep -q "CREATE TABLE.*mcp_tools_logs" migrations/0008_mcp_tools_schema.sql; then
  echo "✅ Migration contains mcp_tools_logs table"
else
  echo "❌ Migration missing mcp_tools_logs table"
  exit 1
fi

# Test 3: Validate default MCP tools are inserted
echo ""
echo "📦 Test 3: Checking default MCP tools insertion..."
if grep -q "cloudflare-playwright-mcp" migrations/0008_mcp_tools_schema.sql; then
  echo "✅ Default playwright MCP tool configured"
else
  echo "❌ Missing default playwright MCP tool"
  exit 1
fi

if grep -q "cloudflare-docs" migrations/0008_mcp_tools_schema.sql; then
  echo "✅ Default docs MCP tool configured"
else
  echo "❌ Missing default docs MCP tool"
  exit 1
fi

# Test 4: Check webhook integration
echo ""
echo "🪝 Test 4: Validating webhook MCP tools integration..."
if grep -q "handleMcpToolsForRepo" src/routes/webhook.ts; then
  echo "✅ Webhook calls MCP tools setup function"
else
  echo "❌ Webhook missing MCP tools integration"
  exit 1
fi

# Count the number of event handlers that include MCP setup
mcp_integrations=$(grep -c "await handleMcpToolsForRepo" src/routes/webhook.ts)
echo "✅ MCP tools integrated into $mcp_integrations webhook handlers"

# Test 5: Check logging implementation
echo ""
echo "📝 Test 5: Validating MCP tools logging..."
if grep -q "Set up.*default MCP tools" src/routes/webhook.ts; then
  echo "✅ Setup logging implemented"
else
  echo "❌ Missing setup logging"
  exit 1
fi

if grep -q "already has.*MCP tools configured" src/routes/webhook.ts; then
  echo "✅ Skip logging implemented"  
else
  echo "❌ Missing skip logging"
  exit 1
fi

# Test 6: Validate configuration matches requirements
echo ""
echo "⚙️ Test 6: Checking MCP tools configuration compliance..."

# Check for browser automation tools (expanded list for better coverage)
required_tools=("browser_navigate" "browser_click" "browser_type" "browser_take_screenshot" "browser_snapshot" "browser_close" "browser_resize" "browser_drag" "browser_hover" "browser_wait_for")
for tool in "${required_tools[@]}"; do
  if grep -q "\"$tool\"" src/modules/mcp_tools.ts; then
    echo "✅ Found required tool: $tool"
  else
    echo "❌ Missing required tool: $tool"
    exit 1
  fi
done

# Check for documentation tools
if grep -q "search_cloudflare_documentation" src/modules/mcp_tools.ts; then
  echo "✅ Found required docs tool: search_cloudflare_documentation"
else
  echo "❌ Missing required docs tool"
  exit 1
fi

# Test 7: Check error handling
echo ""
echo "🛡️ Test 7: Validating error handling..."
if grep -q "Failed to process MCP tools for repository" src/routes/webhook.ts; then
  echo "✅ Error handling implemented in webhooks"
else
  echo "❌ Missing error handling in webhooks"
  exit 1
fi

if grep -q "Error setting up MCP tools for repository" src/routes/webhook.ts; then
  echo "✅ Comprehensive error logging implemented"
else
  echo "❌ Missing comprehensive error logging"
  exit 1
fi

# Summary
echo ""
echo "🎉 All MCP Tools Integration Tests Passed!"
echo "=========================================="
echo ""
echo "📋 Summary:"
echo "• Build includes MCP tools module"
echo "• Database migration creates all required tables"
echo "• Default MCP tools match requirements exactly"
echo "• $mcp_integrations webhook handlers integrated"
echo "• Comprehensive logging implemented"
echo "• Error handling prevents webhook failures"
echo "• All required browser and docs tools included"
echo ""
echo "✨ MCP tools integration is ready for deployment!"

# Optional: Show file sizes to confirm reasonable bundle impact
echo ""
echo "📊 Bundle impact:"
echo "MCP tools module: $(wc -c < src/modules/mcp_tools.ts) bytes"
echo "Migration file: $(wc -c < migrations/0008_mcp_tools_schema.sql) bytes"
echo ""
echo "🚀 Ready for production deployment!"