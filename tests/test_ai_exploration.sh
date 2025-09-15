#!/bin/bash

# Test script for AI Code Exploration system
# Run this after setting up the system to validate functionality

echo "🚀 Testing AI Code Exploration System"
echo "======================================"

BASE_URL="https://gh-bot.hacolby.workers.dev"

echo ""
echo "1. Testing health endpoint..."
curl -s "$BASE_URL/health" | jq .

echo ""
echo "2. Running migration (if needed)..."
# wrangler d1 migrations apply gh-bot --local

echo ""
echo "3. Starting research sweep..."
curl -s -X POST "$BASE_URL/research/run"
echo ""

echo ""
echo "4. Checking research status..."
curl -s "$BASE_URL/research/status" | jq .

echo ""
echo "5. Waiting for research to complete (30 seconds)..."
sleep 30

echo ""
echo "6. Getting research results..."
curl -s "$BASE_URL/research/results?limit=5" | jq .

echo ""
echo "7. Checking for any analyzed repositories..."
curl -s "$BASE_URL/research/analysis?repo=example/test" | jq .

echo ""
echo "8. Checking risk dashboard..."
curl -s "$BASE_URL/research/risks" | jq .

echo ""
echo "9. Testing manual analysis trigger..."
curl -s -X POST "$BASE_URL/research/analyze" \
  -H "Content-Type: application/json" \
  -d '{"owner":"cloudflare","repo":"workers-sdk","force":false}' | jq .

echo ""
echo "✅ Test complete! Check the outputs above for any errors."
echo ""
echo "Expected behaviors:"
echo "- Health should return {\"ok\": true}"
echo "- Research sweep should start with status 202"
echo "- Results should show projects with scores and potentially AI analysis"
echo "- Risk dashboard should show repositories with risk flags"
echo "- Manual analysis should either analyze or indicate recent analysis exists"
