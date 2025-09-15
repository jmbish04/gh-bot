#!/usr/bin/env bash

echo "🚀 GH-Bot Worker Deployment Verification"
echo "========================================"

# Test the basic health endpoint
echo ""
echo "1. Testing health endpoint..."
curl -s https://gh-bot.hacolby.workers.dev/health | jq .

echo ""
echo "2. Testing fixed colby commands endpoint..."
curl -s "https://gh-bot.hacolby.workers.dev/colby/commands?limit=5" | jq .

echo ""
echo "3. Testing parameter validation fix..."
curl -s "https://gh-bot.hacolby.workers.dev/colby/commands?limit=wat" | jq .

echo ""
echo "4. Testing research analysis endpoint fix..."
curl -s "https://gh-bot.hacolby.workers.dev/research/analysis?repo=cloudflare/workers-sdk" | jq .

echo ""
echo "5. Testing dashboard..."
curl -s -I https://gh-bot.hacolby.workers.dev/ | head -5

echo ""
echo "6. Testing OpenAPI spec..."
curl -s https://gh-bot.hacolby.workers.dev/openapi.json | jq '.info'

echo ""
echo "✅ Basic verification complete!"
