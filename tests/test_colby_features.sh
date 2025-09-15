#!/bin/bash

echo "🤖 Testing Colby GitHub Bot Features"
echo "======================================"

# Set the base URL (change to your deployed worker URL)
BASE_URL="http://localhost:8787"

echo ""
echo "1. Testing Health Endpoint"
curl -s "$BASE_URL/health" | jq '.'

echo ""
echo "2. Testing Help Page"
curl -s "$BASE_URL/help" | head -10

echo ""
echo "3. Testing OpenAPI Specification"
curl -s "$BASE_URL/openapi.json" | jq '.info'

echo ""
echo "4. Testing Dashboard (HTML response)"
curl -s "$BASE_URL/" | grep -o '<title>.*</title>'

echo ""
echo "5. Testing Dashboard API Stats"
curl -s "$BASE_URL/api/stats" | head -5

echo ""
echo "6. Testing Colby Commands Endpoint"
curl -s "$BASE_URL/colby/commands?limit=5" | jq '.commands | length'

echo ""
echo "7. Testing Best Practices Endpoint"
curl -s "$BASE_URL/colby/best-practices?limit=5" | jq '.practices | length'

echo ""
echo "8. Testing Research Results"
curl -s "$BASE_URL/research/results?limit=3" | jq '.results | length'

echo ""
echo "9. Testing Operation Progress Endpoint (should return 404 for non-existent ID)"
curl -s -w "Status: %{http_code}\n" "$BASE_URL/colby/operations/test123" | head -2

echo ""
echo "10. Testing Webhook Parsing (simulated)"
echo "This would normally be triggered by GitHub webhooks with /colby commands"

echo ""
echo "🧪 All endpoints tested!"
echo ""
echo "📝 Expected behavior:"
echo "- Health should return {\"ok\":true}"
echo "- Help page should return HTML with command documentation"
echo "- OpenAPI should return valid spec"
echo "- Dashboard should return HTML with Colby branding"
echo "- API endpoints should return empty arrays for fresh installations"
echo "- Operation endpoint should return 404 for non-existent operations"
echo ""
echo "🚀 To trigger colby commands, use them in GitHub PR comments:"
echo "  /colby implement"
echo "  /colby create issue"
echo "  /colby bookmark this suggestion"
echo "  /colby extract suggestions"
echo "  /colby help"
