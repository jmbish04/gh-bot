# Testing Endpoints Documentation

This document describes the testing infrastructure for the webhook module.

## Overview

The testing system provides:
- Automated daily test runs via cron (2 AM daily)
- Manual test triggering via API endpoint
- Test result storage in D1 database
- Health endpoint showing latest test results

## Endpoints

### Run Tests (POST `/tests/run`)

Triggers the test suite manually. Can be called via curl:

```bash
curl -X POST https://your-worker.workers.dev/tests/run
```

Optional query parameter:
- `trigger`: Set to `'manual'`, `'api'`, or `'cron'` (default: `'manual'`)

**Response:**
```json
{
  "success": true,
  "testId": 123,
  "result": {
    "suite": "webhook",
    "totalTests": 9,
    "passedTests": 9,
    "failedTests": 0,
    "skippedTests": 0,
    "durationMs": 45,
    "status": "passed",
    "triggeredBy": "manual"
  },
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

### Get Test Results (GET `/tests/results`)

Retrieves historical test results from the database.

**Query Parameters:**
- `limit`: Number of results to return (default: 10)

**Example:**
```bash
curl https://your-worker.workers.dev/tests/results?limit=20
```

**Response:**
```json
{
  "results": [
    {
      "id": 123,
      "suite": "webhook",
      "totalTests": 9,
      "passedTests": 9,
      "failedTests": 0,
      "skippedTests": 0,
      "durationMs": 45,
      "status": "passed",
      "errorMessage": null,
      "triggeredBy": "manual",
      "createdAt": "2024-01-01T12:00:00.000Z"
    }
  ],
  "count": 1
}
```

### Health Endpoint (GET `/health`)

Shows the latest test results and overall health status.

**Example:**
```bash
curl https://your-worker.workers.dev/health
```

**Response (when tests have run):**
```json
{
  "ok": true,
  "status": "healthy",
  "testResults": {
    "suite": "webhook",
    "totalTests": 9,
    "passedTests": 9,
    "failedTests": 0,
    "skippedTests": 0,
    "durationMs": 45,
    "status": "passed",
    "triggeredBy": "cron"
  },
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

**Response (no tests run yet):**
```json
{
  "ok": true,
  "status": "healthy",
  "message": "No test results available yet",
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

**Health Status Values:**
- `healthy`: All tests passed
- `degraded`: Some tests failed
- `unhealthy`: Test execution error

### Alternative Health Endpoint (GET `/api/health`)

Same as `/health` but with slightly different response format.

## Cron Schedule

Tests run automatically daily at 2 AM UTC via cron trigger:
- Schedule: `0 2 * * *` (2 AM every day)
- Trigger: `cron`
- Results are automatically saved to the database

## Database Schema

Test results are stored in the `test_results` table:

```sql
CREATE TABLE test_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  test_suite TEXT NOT NULL,
  total_tests INTEGER NOT NULL,
  passed_tests INTEGER NOT NULL,
  failed_tests INTEGER NOT NULL,
  skipped_tests INTEGER DEFAULT 0,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('passed', 'failed', 'error')),
  error_message TEXT,
  test_details_json TEXT,
  triggered_by TEXT DEFAULT 'cron' CHECK(triggered_by IN ('cron', 'manual', 'api')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Test Coverage

The test suite currently covers:
- `parseTriggers` - Command parsing
- `extractSuggestions` - Code suggestion extraction
- `truncateText` - Text truncation utility
- `simplifyUser` - User object simplification
- `simplifyRepository` - Repository object simplification
- `extractRelevantData` - Webhook payload extraction
- `checkRecentDuplicate` - Duplicate detection
- `isNewRepository` - Repository existence check
- `CONFLICT_MENTION_PATTERN` - Conflict mention regex

## Migration

To set up the database table, run:

```bash
npx wrangler d1 migrations apply DB --remote
# or for local development:
npx wrangler d1 migrations apply DB --local
```

## Example Usage

### Run tests manually:
```bash
curl -X POST https://gh-bot.your-domain.workers.dev/tests/run
```

### Check health:
```bash
curl https://gh-bot.your-domain.workers.dev/health | jq
```

### Get last 5 test results:
```bash
curl "https://gh-bot.your-domain.workers.dev/tests/results?limit=5" | jq
```

