#!/bin/bash

# Test script to verify the webhook body consumption fix
# This script tests the webhook endpoint with verbose logging

echo "🔧 Testing Webhook Body Consumption Fix"
echo "======================================"
echo ""

# Set the base URL
BASE_URL="${1:-https://gh-bot.hacolby.workers.dev}"
echo "Testing against: $BASE_URL"
echo ""

# Test 1: Simple webhook test (should not consume body twice)
echo "Test 1: Basic webhook test with ping event"
echo "-------------------------------------------"
curl -X POST "$BASE_URL/github/webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: ping" \
  -H "X-GitHub-Delivery: test-$(date +%s)" \
  -H "X-Hub-Signature-256: sha256=invalid" \
  -d '{"zen": "Test webhook", "hook_id": 12345}' \
  -w "\nStatus: %{http_code}\nTime: %{time_total}s\n\n"

# Test 2: Issue comment webhook (should process without body errors)
echo "Test 2: Issue comment webhook"
echo "------------------------------"
curl -X POST "$BASE_URL/github/webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: issue_comment" \
  -H "X-GitHub-Delivery: test-$(date +%s)" \
  -H "X-Hub-Signature-256: sha256=invalid" \
  -d '{
    "action": "created",
    "issue": {
      "number": 123,
      "pull_request": {
        "url": "https://api.github.com/repos/test/repo/pulls/123"
      }
    },
    "comment": {
      "body": "/colby help",
      "user": {
        "login": "testuser",
        "type": "User"
      }
    },
    "repository": {
      "owner": {"login": "test"},
      "name": "repo"
    },
    "installation": {"id": 12345}
  }' \
  -w "\nStatus: %{http_code}\nTime: %{time_total}s\n\n"

# Test 3: Pull request review comment webhook
echo "Test 3: Pull request review comment webhook"
echo "--------------------------------------------"
curl -X POST "$BASE_URL/github/webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request_review_comment" \
  -H "X-GitHub-Delivery: test-$(date +%s)" \
  -H "X-Hub-Signature-256: sha256=invalid" \
  -d '{
    "action": "created",
    "pull_request": {
      "number": 123,
      "head": {
        "ref": "feature-branch",
        "sha": "abc123"
      }
    },
    "comment": {
      "id": 456,
      "body": "```suggestion\nfix this code\n```",
      "path": "src/test.js",
      "line": 10,
      "diff_hunk": "@@ -8,3 +8,3 @@",
      "user": {
        "login": "reviewer",
        "type": "User"
      }
    },
    "repository": {
      "owner": {"login": "test"},
      "name": "repo"
    },
    "installation": {"id": 12345}
  }' \
  -w "\nStatus: %{http_code}\nTime: %{time_total}s\n\n"

# Test 4: Health check (should still work)
echo "Test 4: Health check endpoint"
echo "------------------------------"
curl -X GET "$BASE_URL/health" \
  -w "\nStatus: %{http_code}\nTime: %{time_total}s\n\n"

echo "✅ All webhook tests completed!"
echo ""
echo "Expected results:"
echo "- All webhook tests should return 401 (invalid signature) or 200 (valid processing)"
echo "- No '500' errors should occur from body consumption issues"
echo "- Health check should return 200"
echo ""
echo "If you see any 500 errors, check the Cloudflare Worker logs for details."
echo "The verbose logging should help identify any remaining issues."
