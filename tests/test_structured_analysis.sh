#!/bin/bash

# Test structured analysis functionality
echo "Testing structured analysis..."

# First, let's test the existing analyze endpoint with a simple repo
curl -X POST "https://gh-bot.hacolby.workers.dev/research/analyze-structured" \
  -H "Content-Type: application/json" \
  -d '{
    "owner": "cloudflare",
    "repo": "workers-sdk",
    "force": true
  }' | jq '.'

echo -e "\n\nTesting structured query endpoint..."

# Test the structured query endpoint
curl "https://gh-bot.hacolby.workers.dev/research/structured?binding=d1&min_conf=0.5" | jq '.'

echo -e "\n\nDone!"
