# AI Code Exploration Setup - Manual Test Guide

This documents the new AI code exploration system for analyzing GitHub repositories that have been added to your Workers bot.

## What Was Added

### 1. Database Schema (`migrations/0002_repo_analysis.sql`)
```sql
CREATE TABLE IF NOT EXISTS repo_analysis (
  repo_full_name TEXT PRIMARY KEY,
  analyzed_at INTEGER NOT NULL,
  files_sampled INTEGER NOT NULL,
  bytes_sampled INTEGER NOT NULL,
  languages_json TEXT,             -- ["ts","js","toml","md",...]
  signals_json TEXT,               -- extracted signals (routes, fetch, CF bindings)
  purpose TEXT,                    -- single line purpose
  summary_short TEXT,              -- <140 chars
  summary_long TEXT,               -- 5–10 lines
  risk_flags_json TEXT,            -- ["proxy/vpn","abuse-risk","network-tunneling",...]
  confidence REAL                  -- 0..1
);
```

### 2. Repo Analyzer Module (`src/modules/repo_analyzer.ts`)
- `analyzeRepoCode()` - Main function that analyzes repository code
- `pickImportantFiles()` - Prioritizes files that reveal behavior (wrangler.toml, package.json, src/, etc.)
- `extractSignals()` - Extracts meaningful code patterns (frameworks, routes, risk flags)
- `buildPrompt()` - Creates AI prompt for analysis
- `runRepoLLM()` - Calls Workers AI for analysis

### 3. Integration in Research Orchestrator (`src/do_research.ts`)
The system now:
- Checks if repos look "vague" (poor description, non-English, or low confidence signals)
- Triggers AI analysis for vague repos during research sweeps
- Stores results in the `repo_analysis` table

### 4. API Endpoints (`src/index.ts`)
New endpoints:
- `GET /research/analysis?repo=owner/name` - Returns AI analysis results for a specific repository
- `GET /research/risks` - Dashboard of repositories with security risk flags
- `POST /research/analyze` - Manual trigger to analyze a specific repository
- Enhanced `GET /research/results` - Now includes AI analysis data when available

## Testing the System

### 1. Run Migration
```bash
cd /path/to/gh-bot
wrangler d1 migrations apply gh-bot --local
```

### 2. Trigger Research Sweep
```bash
curl -X POST http://localhost:8787/research/run
```

### 3. Check Analysis Results
```bash
# Get analysis for a specific repo
curl "http://localhost:8787/research/analysis?repo=owner/repo-name"

# Example response:
{
  "repo_full_name": "example/workers-project",
  "analyzed_at": 1723456789000,
  "files_sampled": 12,
  "bytes_sampled": 45000,
  "languages_json": "[\"ts\",\"toml\",\"md\"]",
  "signals_json": "{\"hasWrangler\":true,\"hasDO\":false,\"hasD1\":true,\"routes\":[\"api/*\",\"auth/*\"]}",
  "purpose": "Cloudflare Workers API with authentication and D1 database integration",
  "summary_short": "Workers API with JWT auth, D1 storage, and Hono framework",
  "summary_long": "• REST API built with Hono framework\\n• JWT-based authentication system\\n• D1 database for user data storage\\n• Protected routes for user management\\n• Integration with Workers AI for text processing",
  "risk_flags_json": "[\"auth-bypass\"]",
  "confidence": 0.85
}
```

### 4. Check Research Results (Enhanced)
```bash
curl "http://localhost:8787/research/results?min_score=0.5&limit=20"
```

### 4. Check Risk Dashboard
```bash
# View repositories flagged with security concerns
curl "http://localhost:8787/research/risks"

# Example response:
[
  {
    "repo_full_name": "suspicious/crypto-miner",
    "purpose": "Cryptocurrency mining script with proxy capabilities",
    "summary_short": "Workers script for mining operations with network tunneling",
    "risk_flags": ["crypto-mining", "network-tunneling", "proxy/vpn"],
    "confidence": 0.92,
    "html_url": "https://github.com/suspicious/crypto-miner",
    "stars": 5,
    "score": 0.3
  }
]
```

### 5. Manual Repository Analysis
```bash
# Trigger analysis for a specific repository
curl -X POST "http://localhost:8787/research/analyze" \
  -H "Content-Type: application/json" \
  -d '{
    "owner": "cloudflare",
    "repo": "workers-sdk",
    "force": false
  }'

# Force re-analysis of recently analyzed repo
curl -X POST "http://localhost:8787/research/analyze" \
  -H "Content-Type: application/json" \
  -d '{
    "owner": "example",
    "repo": "my-workers-app",
    "force": true
  }'
```

### 6. Use Test Script
```bash
# Make the test script executable and run it
chmod +x test_ai_exploration.sh
./test_ai_exploration.sh
```

## How It Works

### File Prioritization
The system prioritizes files that reveal repository behavior:
1. **High Priority**: `wrangler.toml`, `package.json`, `README.md`, `_routes.json`
2. **Medium Priority**: Files in `src/`, `functions/`, `workers/`, `api/`, `edge/` directories
3. **Language Files**: `.ts`, `.js`, `.mjs`, `.cjs`, `.toml` files
4. **Framework Detection**: Looks for Durable Objects, D1, cron jobs, AI usage

### Signal Extraction
Detects:
- **Cloudflare Workers signals**: wrangler.toml, DurableObjects, D1 databases, cron jobs
- **Framework usage**: Hono, Express, Fastify, Next.js, React, Vue
- **Security patterns**: Authentication, proxies, network requests, file operations
- **API routes**: Express/Hono route definitions
- **Dependencies**: From package.json

### AI Analysis
Sends a structured prompt to Workers AI (`@cf/meta/llama-3.1-8b-instruct`) containing:
- Repository metadata (owner, languages, frameworks)
- Key code samples (up to 15 files, 3000 chars each)
- Extracted signals (routes, security flags, etc.)

AI returns structured JSON with:
- **Purpose**: One-line description
- **Summary Short**: <140 character summary
- **Summary Long**: 5-10 bullet points of functionality
- **Risk Flags**: Array of potential security/abuse concerns
- **Confidence**: 0-1 confidence score

### Integration Points
- **Research Sweeps**: Automatically analyzes vague repos during `/research/run`
- **API Access**: Query analysis via `/research/analysis?repo=owner/name`
- **Conditional Triggering**: Only analyzes repos that appear vague or have stale analysis

## Configuration

### Environment Variables Needed
```toml
# wrangler.toml
[vars]
CF_ACCOUNT_ID = "your-account-id"
CF_API_TOKEN = "your-api-token"
```

### Tuning Parameters
In `analyzeRepoCode()`:
- `maxBytes`: Maximum bytes to analyze (default: 200,000)
- `maxFiles`: Maximum files to sample (default: 60)
- `maxAgeMs`: How long analysis stays fresh (default: 7 days)

## Monitoring

### Check Analysis Coverage
```sql
-- See how many repos have been analyzed
SELECT COUNT(*) as analyzed_repos FROM repo_analysis;

-- See analysis results by confidence
SELECT
  CASE
    WHEN confidence >= 0.8 THEN 'High'
    WHEN confidence >= 0.6 THEN 'Medium'
    ELSE 'Low'
  END as confidence_level,
  COUNT(*) as count
FROM repo_analysis
GROUP BY confidence_level;

-- Recent analyses
SELECT repo_full_name, purpose, confidence, analyzed_at
FROM repo_analysis
ORDER BY analyzed_at DESC
LIMIT 10;
```

### Performance Metrics
- Files sampled per repo (typically 10-60)
- Bytes analyzed per repo (typically 50K-200K)
- Analysis time (depends on AI model response time)

## Troubleshooting

### Common Issues
1. **AI Analysis Fails**: Check CF_ACCOUNT_ID and CF_API_TOKEN are set
2. **No Repos Analyzed**: Verify repos meet "vague" criteria (poor description, non-English, low signals)
3. **Empty Results**: Check Workers AI model availability and quotas

### Debug Logging
The system logs errors for failed analyses but continues processing other repos to avoid crashing research sweeps.

## Next Steps

### Enhanced Results Display
Consider joining `projects` with `repo_analysis` in `/research/results` to show richer information:

```sql
SELECT
  p.full_name, p.html_url, p.stars, p.score,
  p.short_summary, p.long_summary,
  ra.purpose, ra.confidence, ra.risk_flags_json
FROM projects p
LEFT JOIN repo_analysis ra ON p.full_name = ra.repo_full_name
WHERE p.score >= ?
ORDER BY p.score DESC, ra.confidence DESC
```

### Risk Dashboard
Build a dashboard showing repos flagged with high-risk categories for security review.

### Multi-Language Support
The system automatically detects and analyzes repos in various languages, with prompts asking AI to translate descriptions if needed.
