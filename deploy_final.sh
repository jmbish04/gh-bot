#!/bin/bash

# 🚀 Final Deployment Script
# ==========================

set -e  # Exit on any error

echo "🔍 GitHub Bot - Final Deployment Process"
echo "========================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo -e "${BLUE}Step 1: Checking TypeScript compilation...${NC}"
if npx tsc --noEmit --skipLibCheck; then
    echo -e "${GREEN}✅ TypeScript compilation passed${NC}"
else
    echo -e "${RED}❌ TypeScript compilation failed${NC}"
    echo "   Please fix TypeScript errors before deploying"
    exit 1
fi

echo ""
echo -e "${BLUE}Step 2: Building Worker...${NC}"
if npx wrangler build; then
    echo -e "${GREEN}✅ Worker built successfully${NC}"
else
    echo -e "${RED}❌ Worker build failed${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}Step 3: Applying database migrations...${NC}"
if npx wrangler d1 migrations apply DB --remote; then
    echo -e "${GREEN}✅ Database migrations applied${NC}"
else
    echo -e "${RED}❌ Database migration failed${NC}"
    echo "   Check your Cloudflare credentials and database configuration"
    exit 1
fi

echo ""
echo -e "${BLUE}Step 4: Deploying Worker...${NC}"
if npx wrangler deploy; then
    echo -e "${GREEN}✅ Worker deployed successfully${NC}"
else
    echo -e "${RED}❌ Worker deployment failed${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}Step 5: Testing deployment...${NC}"
WORKER_URL=$(npx wrangler whoami 2>/dev/null | grep -o "https://.*workers.dev" || echo "")
if [ -z "$WORKER_URL" ]; then
    WORKER_URL="https://gh-bot.hacolby.workers.dev"  # fallback
fi

echo "Testing health endpoint at: $WORKER_URL/health"
if curl -f -s "$WORKER_URL/health" > /dev/null; then
    echo -e "${GREEN}✅ Health check passed${NC}"
else
    echo -e "${YELLOW}⚠️  Health check failed - worker may still be starting${NC}"
fi

echo ""
echo "========================================"
echo -e "${GREEN}🎉 DEPLOYMENT COMPLETE!${NC}"
echo "========================================"
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo "1. Update your GitHub App webhook URL to: $WORKER_URL/github/webhook"
echo "2. Test with a GitHub PR comment containing: /colby help"
echo "3. Monitor logs with: npx wrangler tail"
echo ""
echo -e "${BLUE}Useful commands:${NC}"
echo "• View logs: npx wrangler tail"
echo "• Check status: curl $WORKER_URL/health"
echo "• View dashboard: $WORKER_URL/"
echo ""
echo -e "${GREEN}✅ Your GitHub bot is now live!${NC}"
