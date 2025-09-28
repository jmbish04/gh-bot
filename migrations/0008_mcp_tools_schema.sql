-- Migration 0008: MCP Tools Schema
-- Add database tables for MCP tools configuration and management

-- Default MCP Tools Configuration table
CREATE TABLE IF NOT EXISTS default_mcp_tools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name TEXT NOT NULL UNIQUE,
    tool_config TEXT NOT NULL, -- JSON configuration
    description TEXT,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- Repository-specific MCP Tools Configuration table
CREATE TABLE IF NOT EXISTS repo_mcp_tools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL, -- owner/repo format
    tool_name TEXT NOT NULL,
    tool_config TEXT NOT NULL, -- JSON configuration
    is_active INTEGER DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'custom', -- 'default' or 'custom'
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    UNIQUE(repo, tool_name)
);

-- MCP Tools Operation Logs table for detailed tracking
CREATE TABLE IF NOT EXISTS mcp_tools_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    operation TEXT NOT NULL, -- 'setup', 'update', 'check', 'skip'
    operation_details TEXT, -- JSON with details about what was done
    tools_added TEXT, -- JSON array of tool names added
    tools_found TEXT, -- JSON array of tool names that already existed
    status TEXT NOT NULL DEFAULT 'success', -- 'success', 'error', 'warning'
    error_message TEXT,
    processing_time_ms INTEGER,
    triggered_by TEXT, -- 'webhook_event', 'manual', 'sync'
    event_type TEXT, -- 'repository_created', 'push', etc.
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_default_mcp_tools_active ON default_mcp_tools(is_active);
CREATE INDEX IF NOT EXISTS idx_repo_mcp_tools_repo ON repo_mcp_tools(repo);
CREATE INDEX IF NOT EXISTS idx_repo_mcp_tools_active ON repo_mcp_tools(is_active);
CREATE INDEX IF NOT EXISTS idx_repo_mcp_tools_source ON repo_mcp_tools(source);
CREATE INDEX IF NOT EXISTS idx_mcp_tools_logs_repo ON mcp_tools_logs(repo);
CREATE INDEX IF NOT EXISTS idx_mcp_tools_logs_operation ON mcp_tools_logs(operation);
CREATE INDEX IF NOT EXISTS idx_mcp_tools_logs_status ON mcp_tools_logs(status);
CREATE INDEX IF NOT EXISTS idx_mcp_tools_logs_created ON mcp_tools_logs(created_at);

-- Insert default MCP tools configuration
INSERT OR IGNORE INTO default_mcp_tools (tool_name, tool_config, description) VALUES 
(
    'cloudflare-playwright-mcp',
    '{
        "type": "sse",
        "url": "https://browser-renderer-mcp.hacolby.workers.dev/sse",
        "tools": [
            "browser_close",
            "browser_resize",
            "browser_console_messages",
            "browser_handle_dialog",
            "browser_file_upload",
            "browser_press_key",
            "browser_navigate",
            "browser_navigate_back",
            "browser_navigate_forward",
            "browser_network_requests",
            "browser_pdf_save",
            "browser_take_screenshot",
            "browser_snapshot",
            "browser_click",
            "browser_drag",
            "browser_hover",
            "browser_type",
            "browser_select_option",
            "browser_tab_list",
            "browser_tab_new",
            "browser_tab_select",
            "browser_tab_close",
            "browser_generate_playwright_test",
            "browser_wait_for"
        ]
    }',
    'Cloudflare Playwright MCP server for browser automation and testing'
),
(
    'cloudflare-docs',
    '{
        "type": "sse",
        "url": "https://docs.mcp.cloudflare.com/sse",
        "tools": [
            "search_cloudflare_documentation",
            "migrate_pages_to_workers_guide"
        ]
    }',
    'Cloudflare documentation MCP server for accessing official docs'
);

-- Add triggers to update updated_at timestamps
CREATE TRIGGER IF NOT EXISTS update_default_mcp_tools_timestamp
    AFTER UPDATE ON default_mcp_tools
    FOR EACH ROW
BEGIN
    UPDATE default_mcp_tools
    SET updated_at = strftime('%s', 'now') * 1000
    WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_repo_mcp_tools_timestamp
    AFTER UPDATE ON repo_mcp_tools
    FOR EACH ROW
BEGIN
    UPDATE repo_mcp_tools
    SET updated_at = strftime('%s', 'now') * 1000
    WHERE id = NEW.id;
END;

-- Views for common queries

-- Active default MCP tools view
CREATE VIEW IF NOT EXISTS v_active_default_mcp_tools AS
SELECT
    tool_name,
    tool_config,
    description,
    created_at,
    updated_at
FROM default_mcp_tools
WHERE is_active = 1;

-- Repository MCP tools summary view
CREATE VIEW IF NOT EXISTS v_repo_mcp_tools_summary AS
SELECT
    repo,
    COUNT(*) as total_tools,
    COUNT(CASE WHEN source = 'default' THEN 1 END) as default_tools,
    COUNT(CASE WHEN source = 'custom' THEN 1 END) as custom_tools,
    COUNT(CASE WHEN is_active = 1 THEN 1 END) as active_tools,
    MAX(created_at) as last_tool_added
FROM repo_mcp_tools
GROUP BY repo;

-- Migration complete
INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES ('0008_mcp_tools_schema', strftime('%s', 'now') * 1000);