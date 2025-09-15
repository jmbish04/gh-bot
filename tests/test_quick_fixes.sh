#!/bin/bash

echo "Testing GH-Bot Worker Endpoint Fixes"
echo "====================================="

echo ""
echo "1. Testing valid repo analysis (should return 200):"
curl -s -w "Status: %{http_code}\n" "https://gh-bot.hacolby.workers.dev/research/analysis?repo=cloudflare/workers-sdk" | head -5

echo ""
echo "2. Testing SQL injection protection (should return 400):"
curl -s -w "Status: %{http_code}\n" "https://gh-bot.hacolby.workers.dev/research/analysis?repo=%27;%20DROP%20TABLE%20projects;%20--" | head -5

echo ""
echo "3. Testing invalid format (should return 400):"
curl -s -w "Status: %{http_code}\n" "https://gh-bot.hacolby.workers.dev/research/analysis?repo=invalid-format" | head -5

echo ""
echo "4. Testing missing parameter (should return 400):"
curl -s -w "Status: %{http_code}\n" "https://gh-bot.hacolby.workers.dev/research/analysis" | head -5

echo ""
echo "====================================="
echo "If all tests show correct status codes, the fixes are working!"
