# Comprehensive Test Suite for GH-Bot Worker

This document outlines the comprehensive test coverage added to `tests/test_worker.py`.

## Test Categories Added

### 1. Colby Command Endpoints (`test_colby_endpoints`)
- **GET /colby/commands** - Basic command listing
- **GET /colby/commands?limit=5** - Command listing with limit
- **GET /colby/commands?repo=test/repo&author=testuser** - Filtered commands
- **GET /colby/commands?limit=wat** - Invalid parameter handling
- **GET /colby/best-practices** - Best practices listing
- **GET /colby/best-practices?category=typescript&status=pending** - Filtered practices
- **GET /colby/best-practices?limit=invalid** - Invalid parameter handling
- **GET /colby/operations/test-operation-123** - Operation status lookup
- **GET /colby/repo/cloudflare/workers-sdk** - Repo-specific activity

### 2. Dashboard & UI Endpoints (`test_dashboard_endpoints`)
- **GET /** - Main dashboard UI (HTML)
- **GET /help** - Help page (HTML)
- **GET /openapi.json** - OpenAPI specification (JSON)

### 3. Dashboard API Endpoints (`test_dashboard_api_endpoints`)
- **GET /api/stats** - Dashboard statistics
- **GET /api/recent-activity** - Recent activity feed
- **GET /api/operations** - Live operations status
- **HTMX endpoints** - Tests with `HX-Request: true` header
  - Research results for HTMX
  - Colby commands for HTMX

### 4. Parameter Validation (`test_parameter_validation`)
Tests for invalid parameter handling:
- Invalid `min_score` parameters
- Zero and negative `limit` parameters
- Out of range `confidence` values
- Negative `offset` parameters
- Non-numeric limits

### 5. CORS & Headers (`test_cors_and_headers`)
Tests different Accept headers:
- `application/json`
- `text/html`
- `*/*`
- `application/xml`
- Missing Accept header

### 6. Security & Input Validation (`test_security_endpoints`)
**SQL Injection Tests:**
- `'; DROP TABLE colby_commands; --`
- `test' OR '1'='1`
- INSERT and DELETE injection attempts
- Quote-based injection variants

**XSS Tests:**
- Basic script injection
- JavaScript protocol XSS
- URL encoded XSS

### 7. Enhanced Webhook Tests (`test_webhook_endpoints`)
- Webhook without signature (should fail)
- Webhook with invalid signature
- Webhook with valid signature (if secret provided)
- Different webhook event types:
  - `issue_comment`
  - `pull_request_review`
  - `pull_request_review_comment`
  - `pull_request`
  - `push`
  - `installation`

### 8. Colby Command Parsing (`test_colby_command_parsing`)
Tests webhook payloads containing various Colby commands:
- `/colby implement`
- `/colby create issue`
- `/colby create issue and assign to copilot`
- `/colby bookmark this suggestion`
- `/colby extract suggestions`
- `/colby help`
- Legacy commands (`/apply`, `/summarize`)
- Natural language containing commands
- Multiple commands in one comment

### 9. Enhanced Performance Tests (`run_performance_tests`)
- **Concurrent requests** - 10 parallel health checks
- **Endpoint response times** - Individual endpoint timing
- **Database query performance** - Tests all DB-dependent endpoints
- Response time thresholds and warnings

### 10. Load Tests (`run_load_tests`)
- **Mixed endpoint load** - 21 concurrent requests across different endpoints
- **Success rate calculation** - Percentage of successful requests
- **Performance metrics** - Average, P95, and maximum response times
- **Failure tracking** - Reports which endpoints failed

## Test Configuration

The test suite uses configuration from:
- **`.dev.vars`** file (if present)
- **Environment variables** as fallback
- **Hardcoded defaults** as last resort

### Key Configuration Options:
- `WORKER_URL` - Target worker URL
- `API_KEY` - Optional API key for authenticated endpoints
- `GITHUB_WEBHOOK_SECRET` - Required for webhook signature tests
- `OUTPUT_FILE` - JSON results output file

## Running the Tests

### Full Comprehensive Suite:
```bash
python test_comprehensive.py
```

### Individual Test Module:
```bash
cd tests && python test_worker.py
```

### With Custom Configuration:
```bash
WORKER_URL=https://your-worker.dev python test_comprehensive.py
```

## Test Output

The suite provides:
- **Colored terminal output** with pass/fail indicators
- **Detailed timing information** for performance analysis
- **JSON results file** for automated processing
- **Comprehensive summary** with success rates and performance metrics

## Expected Test Results

- **Health endpoints** - Should all pass (200 OK)
- **Research endpoints** - May return 500 if database not set up
- **Colby endpoints** - May return 500 if migration not applied
- **Webhook endpoints** - Require valid secret for full testing
- **Security tests** - Should handle attacks gracefully (400 or safe 200)
- **Performance tests** - Should complete within reasonable time limits

## Database Migration Dependency

Many tests require the database migrations to be applied:
```bash
wrangler d1 migrations apply gh-bot --remote
```

Without migrations, expect 500 errors from:
- `/colby/commands`
- `/colby/best-practices`
- `/colby/operations/*`
- `/api/*` endpoints

The test suite detects these scenarios and provides helpful error messages.
