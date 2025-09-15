#!/usr/bin/env bash

echo "🎯 GH-Bot Worker - Final Deployment Commands"
echo "============================================"

echo ""
echo "1. Apply Database Migration (REQUIRED):"
echo "wrangler d1 migrations apply gh-bot --remote"

echo ""
echo "2. Deploy Worker:"
echo "wrangler deploy"

echo ""
echo "3. Test Deployment:"
echo "curl https://gh-bot.hacolby.workers.dev/health"

echo ""
echo "4. Test Fixed Endpoints:"
echo "curl 'https://gh-bot.hacolby.workers.dev/colby/commands?limit=wat'"
echo "curl 'https://gh-bot.hacolby.workers.dev/research/analysis?repo=test/repo'"

echo ""
echo "5. Run Comprehensive Test Suite:"
echo "python tests/test_worker.py"

echo ""
echo "6. Check Dashboard:"
echo "open https://gh-bot.hacolby.workers.dev"

echo ""
echo "🚀 Ready for production!"
