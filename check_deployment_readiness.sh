#!/bin/bash

# 🚀 Deployment Readiness Checker
# ===============================

echo "🔍 GitHub Bot - Deployment Readiness Check"
echo "=========================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Tracking
ERRORS=0
WARNINGS=0

echo ""
echo -e "${BLUE}1. Checking TypeScript Compilation...${NC}"
if npx tsc --noEmit --skipLibCheck 2>/dev/null; then
    echo -e "${GREEN}✅ TypeScript compilation passed${NC}"
else
    echo -e "${RED}❌ TypeScript compilation failed${NC}"
    echo "   Run: npx tsc --noEmit to see errors"
    ((ERRORS++))
fi

echo ""
echo -e "${BLUE}2. Checking Wrangler Configuration...${NC}"
if [ -f "wrangler.jsonc" ]; then
    echo -e "${GREEN}✅ wrangler.jsonc exists${NC}"
else
    echo -e "${RED}❌ wrangler.jsonc missing${NC}"
    ((ERRORS++))
fi

echo ""
echo -e "${BLUE}3. Checking Database Migrations...${NC}"
if [ -d "migrations" ] && [ "$(ls -A migrations)" ]; then
    echo -e "${GREEN}✅ Database migrations found${NC}"
    echo "   Latest migration: $(ls migrations/ | tail -1)"
else
    echo -e "${RED}❌ No database migrations found${NC}"
    ((ERRORS++))
fi

echo ""
echo -e "${BLUE}4. Checking Package Dependencies...${NC}"
if [ -f "package.json" ] && [ -f "pnpm-lock.yaml" ]; then
    echo -e "${GREEN}✅ Package files exist${NC}"
else
    echo -e "${YELLOW}⚠️  Missing package files${NC}"
    ((WARNINGS++))
fi

echo ""
echo -e "${BLUE}5. Checking Core Source Files...${NC}"
REQUIRED_FILES=(
    "src/index.ts"
    "src/do_pr_workflows.ts"
    "src/modules/colby.ts"
    "src/modules/github_helpers.ts"
)

for file in "${REQUIRED_FILES[@]}"; do
    if [ -f "$file" ]; then
        echo -e "${GREEN}✅ $file${NC}"
    else
        echo -e "${RED}❌ $file missing${NC}"
        ((ERRORS++))
    fi
done

echo ""
echo -e "${BLUE}6. Checking Environment Variables...${NC}"
ENV_VARS=(
    "GITHUB_APP_ID"
    "GITHUB_PRIVATE_KEY"
    "GITHUB_WEBHOOK_SECRET"
    "CF_ACCOUNT_ID"
    "CF_API_TOKEN"
    "SUMMARY_CF_MODEL"
)

if [ -f ".dev.vars" ]; then
    echo -e "${GREEN}✅ .dev.vars file exists${NC}"

    for var in "${ENV_VARS[@]}"; do
        if grep -q "^$var=" .dev.vars; then
            echo -e "${GREEN}✅ $var configured${NC}"
        else
            echo -e "${RED}❌ $var missing from .dev.vars${NC}"
            ((ERRORS++))
        fi
    done
else
    echo -e "${YELLOW}⚠️  .dev.vars file not found${NC}"
    echo "   Create this file with your environment variables"
    ((WARNINGS++))
fi

echo ""
echo -e "${BLUE}7. Testing Worker Build...${NC}"
if npx wrangler build 2>/dev/null; then
    echo -e "${GREEN}✅ Worker builds successfully${NC}"
else
    echo -e "${RED}❌ Worker build failed${NC}"
    echo "   Run: npx wrangler build for details"
    ((ERRORS++))
fi

echo ""
echo "========================================"
echo -e "${BLUE}📊 DEPLOYMENT READINESS SUMMARY${NC}"
echo "========================================"

if [ $ERRORS -eq 0 ]; then
    if [ $WARNINGS -eq 0 ]; then
        echo -e "${GREEN}🎉 READY TO DEPLOY!${NC}"
        echo -e "${GREEN}   No errors or warnings found${NC}"
        echo ""
        echo -e "${BLUE}Next steps:${NC}"
        echo "1. Run: pnpm run migrate:remote"
        echo "2. Run: pnpm run deploy"
        exit 0
    else
        echo -e "${YELLOW}⚠️  READY WITH WARNINGS${NC}"
        echo -e "${YELLOW}   $WARNINGS warning(s) found${NC}"
        echo ""
        echo -e "${BLUE}Next steps:${NC}"
        echo "1. Address warnings if needed"
        echo "2. Run: pnpm run migrate:remote"
        echo "3. Run: pnpm run deploy"
        exit 0
    fi
else
    echo -e "${RED}❌ NOT READY TO DEPLOY${NC}"
    echo -e "${RED}   $ERRORS error(s) must be fixed${NC}"
    if [ $WARNINGS -gt 0 ]; then
        echo -e "${YELLOW}   $WARNINGS warning(s) should be addressed${NC}"
    fi
    echo ""
    echo -e "${BLUE}Required fixes:${NC}"
    echo "1. Fix TypeScript compilation errors"
    echo "2. Ensure all required files exist"
    echo "3. Configure environment variables"
    echo "4. Fix build issues"
    exit 1
fi
