#!/usr/bin/env bash

echo "🔧 Testing Parameter Validation Fixes"
echo "===================================="

echo ""
echo "1. Testing /colby/commands with invalid limit..."
response1=$(curl -s "https://gh-bot.hacolby.workers.dev/colby/commands?limit=wat")
echo "Response: $response1"

echo ""
echo "2. Testing /colby/best-practices with invalid limit..."
response2=$(curl -s "https://gh-bot.hacolby.workers.dev/colby/best-practices?limit=invalid")
echo "Response: $response2"

echo ""
echo "3. Testing /colby/commands with negative offset..."
response3=$(curl -s "https://gh-bot.hacolby.workers.dev/colby/commands?offset=-1")
echo "Response: $response3"

echo ""
echo "4. Testing /colby/best-practices with non-numeric limit..."
response4=$(curl -s "https://gh-bot.hacolby.workers.dev/colby/best-practices?limit=abc")
echo "Response: $response4"

echo ""
echo "5. Testing valid parameters..."
response5=$(curl -s "https://gh-bot.hacolby.workers.dev/colby/commands?limit=5")
echo "Response: $response5"

echo ""
echo "✅ Parameter validation tests complete!"
