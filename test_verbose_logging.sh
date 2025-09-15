#!/bin/bash

echo "Testing webhook handler with verbose logging..."

# Test the webhook endpoint with a sample payload
curl -X POST https://gh-bot.hacolby.workers.dev/github/webhook \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: ping" \
  -H "X-GitHub-Delivery: test-delivery-$(date +%s)" \
  -H "X-Hub-Signature-256: sha256=test-signature" \
  -d '{"zen": "Testing webhook with verbose logging"}' \
  -v

echo ""
echo "Check the Cloudflare Worker logs to see verbose output"
echo "The logs should show:"
echo "1. [MAIN] Webhook request received"
echo "2. [MAIN] Reading request headers..."
echo "3. [MAIN] Headers extracted"
echo "4. [MAIN] Reading request body..."
echo "5. [MAIN] Body read successfully"
echo "6. [MAIN] Calling handleWebhook..."
echo "7. [WEBHOOK] Starting webhook processing"
echo "8. [WEBHOOK] Ping received, responding with pong"
