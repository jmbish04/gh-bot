# MCP Tools Integration - Deployment Guide

## Overview
This implementation adds automatic MCP (Model Context Protocol) tools setup for repositories. When any repository event occurs, the worker checks if MCP tools are configured and automatically sets up defaults if none exist.

## Features Implemented

### ✅ Core Functionality
- **Automatic Setup**: Every repository event triggers MCP tools check
- **Default Configuration**: Uses specified Cloudflare Playwright and Docs MCP tools
- **Smart Detection**: Only sets up tools for repos that don't have them
- **Comprehensive Logging**: All operations logged for traceability
- **Error Handling**: Failures don't break existing webhook processing

### ✅ Database Schema
```sql
-- Tables created by migration 0008_mcp_tools_schema.sql
default_mcp_tools     -- Default tool configurations (self-service ready)
repo_mcp_tools        -- Repository-specific tool configurations  
mcp_tools_logs        -- Comprehensive operation logging
```

### ✅ Default Tools Configuration
```json
{
  "mcpServers": {
    "cloudflare-playwright-mcp": {
      "type": "sse",
      "url": "https://browser-renderer-mcp.hacolby.workers.dev/sse", 
      "tools": [24 browser automation tools]
    },
    "cloudflare-docs": {
      "type": "sse",
      "url": "https://docs.mcp.cloudflare.com/sse",
      "tools": [2 documentation tools]
    }
  }
}
```

## Deployment Steps

### 1. Apply Database Migration
```bash
# Local testing
npx wrangler d1 migrations apply gh-bot --local

# Production deployment
npx wrangler d1 migrations apply gh-bot --remote
```

### 2. Deploy Worker
```bash
npm run deploy
```

### 3. Verify Deployment
```bash
# Run integration tests
./tests/test_mcp_tools_integration.sh
```

## How It Works

### Repository Event Flow
1. **Webhook Received** → Any repository event (PR, issue, comment, etc.)
2. **MCP Check** → `ensureRepoMcpTools(db, repo, eventType)` called
3. **Decision Logic**:
   - **Has MCP Tools** → Log existing tools, continue processing
   - **No MCP Tools** → Set up defaults from database, log tools added
4. **Continue** → Normal webhook processing continues

### Example Logs

**New Repository (Setup):**
```
[WEBHOOK] Set up 2 default MCP tools for repository owner/repo: cloudflare-playwright-mcp, cloudflare-docs
[MCP_TOOLS] Successfully set up 2 default MCP tools for repo owner/repo
```

**Existing Repository (Skip):**
```
[WEBHOOK] Repository owner/repo already has 3 MCP tools configured
[MCP_TOOLS] Repo owner/repo already has 3 MCP tools configured - skipping setup
```

## API Functions

### Core Functions (src/modules/mcp_tools.ts)

```typescript
// Main function called by webhooks
ensureRepoMcpTools(db, repo, eventType) 
// → { action: 'setup'|'skip', toolsAdded?: [], toolsFound?: [], error?: string }

// Check if repo has MCP tools
hasRepoMcpTools(db, repo) 
// → boolean

// Get default tools from database
getDefaultMcpTools(db)
// → McpToolsConfig

// Setup defaults for new repo
setupDefaultMcpTools(db, repo)
// → { success: boolean, toolsAdded: string[], error?: string }
```

### Database Queries

```sql
-- Check default tools
SELECT tool_name, is_active FROM default_mcp_tools WHERE is_active = 1;

-- Check repository tools  
SELECT repo, tool_name, source FROM repo_mcp_tools WHERE repo = 'owner/repo';

-- Check operation logs
SELECT operation, status, tools_added, created_at 
FROM mcp_tools_logs 
WHERE repo = 'owner/repo' 
ORDER BY created_at DESC;
```

## Frontend Self-Service

The default MCP tools are stored in the `default_mcp_tools` table, enabling future frontend functionality:

```typescript
// Update default MCP tool (for frontend use)
updateDefaultMcpTool(db, toolName, toolConfig, description)

// Get MCP logs (for frontend monitoring)
getMcpToolsLogs(db, repo, limit)
```

## Monitoring & Troubleshooting

### Key Metrics to Monitor
- **Setup Rate**: How many repos get default MCP tools
- **Skip Rate**: How many repos already have tools
- **Error Rate**: Any failures in MCP setup process

### Troubleshooting Commands
```sql
-- Find repos with MCP tools
SELECT repo, COUNT(*) as tool_count 
FROM repo_mcp_tools 
GROUP BY repo;

-- Find recent MCP operations
SELECT repo, operation, status, error_message, created_at
FROM mcp_tools_logs
WHERE created_at > (strftime('%s', 'now') - 3600) * 1000
ORDER BY created_at DESC;

-- Find failed operations
SELECT * FROM mcp_tools_logs WHERE status = 'error';
```

## Testing

### Integration Test
```bash
./tests/test_mcp_tools_integration.sh
```

Validates:
- ✅ Build includes MCP tools module
- ✅ Migration creates all required tables
- ✅ Default tools match requirements
- ✅ 6 webhook handlers integrated
- ✅ Comprehensive logging implemented
- ✅ Error handling prevents failures

### Manual Testing
1. **Trigger Webhook**: Create PR, issue, or comment on repository
2. **Check Logs**: Verify MCP setup/skip messages appear
3. **Query Database**: Confirm tools added to `repo_mcp_tools` table
4. **Verify Logs**: Check `mcp_tools_logs` for operation record

## Security & Performance

### Security
- ✅ No external API calls during MCP setup
- ✅ All data stored in secure D1 database
- ✅ No sensitive information in logs
- ✅ Proper error handling prevents information leakage

### Performance
- ✅ Minimal bundle impact (16KB total)
- ✅ Database operations optimized with indexes
- ✅ Async operation doesn't block webhook processing
- ✅ Smart caching reduces redundant database calls

## Future Enhancements

### Planned Frontend Features
- MCP tools management UI
- Repository-specific tool customization
- Operation monitoring dashboard
- Tool usage analytics

### Potential Improvements
- MCP tool health monitoring
- Automatic tool updates
- Per-organization defaults
- Integration with external MCP registries

---

## Summary

🎉 **MCP Tools integration is complete and ready for production!**

The implementation fully satisfies all requirements:
- ✅ Checks MCP tools on every repository event
- ✅ Sets up defaults if none exist
- ✅ Leaves existing configurations alone
- ✅ Comprehensive logging for traceability
- ✅ Default tools stored in D1 for self-service
- ✅ Minimal impact on existing functionality