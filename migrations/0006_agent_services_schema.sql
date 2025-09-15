-- Migration 0006: Agent Services Schema
-- Add database tables for LLM content caching, agent generation tracking, and vectorization support

-- LLM Content Storage for caching fetched documentation
CREATE TABLE IF NOT EXISTS llms_full_content (
    content_id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    last_fetched INTEGER NOT NULL,
    content_length INTEGER NOT NULL,
    chunks TEXT, -- JSON array of content chunks
    metadata TEXT NOT NULL, -- JSON metadata (language, contentType, tags, etc.)
    is_active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- Index for efficient content retrieval
CREATE INDEX IF NOT EXISTS idx_llms_content_url ON llms_full_content(url);
CREATE INDEX IF NOT EXISTS idx_llms_content_category ON llms_full_content(category);
CREATE INDEX IF NOT EXISTS idx_llms_content_hash ON llms_full_content(content_hash);
CREATE INDEX IF NOT EXISTS idx_llms_content_active ON llms_full_content(is_active);
CREATE INDEX IF NOT EXISTS idx_llms_content_fetched ON llms_full_content(last_fetched);

-- Agent Generation Requests tracking
CREATE TABLE IF NOT EXISTS agent_generation_requests (
    request_id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    request_type TEXT NOT NULL, -- 'api' or 'slash_command'
    context TEXT, -- JSON context provided by user
    project_type TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
    assets_generated TEXT, -- JSON of generated asset URLs/paths
    r2_urls TEXT, -- JSON of R2 URLs (for API requests)
    github_commit TEXT, -- GitHub commit SHA (for slash commands)
    error_details TEXT,
    processing_time_ms INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    completed_at INTEGER
);

-- Indexes for agent generation requests
CREATE INDEX IF NOT EXISTS idx_agent_requests_repo ON agent_generation_requests(repo);
CREATE INDEX IF NOT EXISTS idx_agent_requests_status ON agent_generation_requests(status);
CREATE INDEX IF NOT EXISTS idx_agent_requests_type ON agent_generation_requests(request_type);
CREATE INDEX IF NOT EXISTS idx_agent_requests_created ON agent_generation_requests(created_at);

-- Infrastructure Guidance Requests tracking
CREATE TABLE IF NOT EXISTS infrastructure_guidance_requests (
    request_id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    infra_type TEXT NOT NULL,
    request_context TEXT, -- JSON context (goals, current stack, requirements)
    recommendations TEXT, -- JSON of generated recommendations
    complexity_level TEXT, -- 'low', 'medium', 'high'
    estimated_time TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error_details TEXT,
    processing_time_ms INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    completed_at INTEGER
);

-- Indexes for infrastructure guidance
CREATE INDEX IF NOT EXISTS idx_infra_requests_repo ON infrastructure_guidance_requests(repo);
CREATE INDEX IF NOT EXISTS idx_infra_requests_type ON infrastructure_guidance_requests(infra_type);
CREATE INDEX IF NOT EXISTS idx_infra_requests_status ON infrastructure_guidance_requests(status);
CREATE INDEX IF NOT EXISTS idx_infra_requests_created ON infrastructure_guidance_requests(created_at);

-- LLM Content Search and Retrieval tracking
CREATE TABLE IF NOT EXISTS llm_content_usage (
    usage_id TEXT PRIMARY KEY,
    content_id TEXT NOT NULL,
    repo TEXT,
    query_context TEXT,
    relevance_score REAL,
    matched_keywords TEXT, -- JSON array
    used_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    FOREIGN KEY (content_id) REFERENCES llms_full_content(content_id)
);

-- Index for usage tracking
CREATE INDEX IF NOT EXISTS idx_llm_usage_content ON llm_content_usage(content_id);
CREATE INDEX IF NOT EXISTS idx_llm_usage_repo ON llm_content_usage(repo);
CREATE INDEX IF NOT EXISTS idx_llm_usage_used_at ON llm_content_usage(used_at);

-- Content Chunks for Vectorization (when Vectorize is available)
CREATE TABLE IF NOT EXISTS llm_content_chunks (
    chunk_id TEXT PRIMARY KEY,
    content_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    chunk_content TEXT NOT NULL,
    start_index INTEGER NOT NULL,
    end_index INTEGER NOT NULL,
    relevance_score REAL DEFAULT 0,
    embedding_vector TEXT, -- JSON array of embedding values (when available)
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    FOREIGN KEY (content_id) REFERENCES llms_full_content(content_id)
);

-- Indexes for content chunks
CREATE INDEX IF NOT EXISTS idx_chunks_content_id ON llm_content_chunks(content_id);
CREATE INDEX IF NOT EXISTS idx_chunks_relevance ON llm_content_chunks(relevance_score);

-- Table for vectorized chunks used by VectorizeService
CREATE TABLE IF NOT EXISTS vectorized_chunks (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    category TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    total_chunks INTEGER NOT NULL,
    title TEXT,
    url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for vectorized chunks
CREATE INDEX IF NOT EXISTS idx_vectorized_chunks_source ON vectorized_chunks(source);
CREATE INDEX IF NOT EXISTS idx_vectorized_chunks_category ON vectorized_chunks(category);
CREATE INDEX IF NOT EXISTS idx_vectorized_chunks_created ON vectorized_chunks(created_at);

-- Documentation Refresh Jobs tracking
CREATE TABLE IF NOT EXISTS documentation_refresh_jobs (
    job_id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL, -- 'scheduled', 'manual', 'triggered'
    urls_processed INTEGER DEFAULT 0,
    urls_successful INTEGER DEFAULT 0,
    urls_failed INTEGER DEFAULT 0,
    total_content_size INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'running', 'completed', 'failed'
    error_details TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    processing_time_ms INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- Index for refresh jobs
CREATE INDEX IF NOT EXISTS idx_refresh_jobs_status ON documentation_refresh_jobs(status);
CREATE INDEX IF NOT EXISTS idx_refresh_jobs_created ON documentation_refresh_jobs(created_at);

-- Project Type Detection Cache
CREATE TABLE IF NOT EXISTS project_type_cache (
    repo TEXT PRIMARY KEY,
    project_type TEXT NOT NULL,
    has_wrangler INTEGER DEFAULT 0,
    has_next_config INTEGER DEFAULT 0,
    has_package_json INTEGER DEFAULT 0,
    has_clasp_json INTEGER DEFAULT 0,
    has_apps_script_json INTEGER DEFAULT 0,
    has_python_files INTEGER DEFAULT 0,
    dependencies TEXT, -- JSON array
    dev_dependencies TEXT, -- JSON array
    analysis_details TEXT, -- JSON with file analysis details
    confidence_score REAL DEFAULT 0,
    last_analyzed INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- Index for project type cache
CREATE INDEX IF NOT EXISTS idx_project_cache_type ON project_type_cache(project_type);
CREATE INDEX IF NOT EXISTS idx_project_cache_analyzed ON project_type_cache(last_analyzed);

-- R2 Asset Tracking (for cleanup and management)
CREATE TABLE IF NOT EXISTS r2_asset_tracking (
    asset_id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    asset_type TEXT NOT NULL, -- 'agent-configuration', 'guidance-report', etc.
    r2_key TEXT NOT NULL,
    r2_url TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    content_type TEXT,
    metadata TEXT, -- JSON metadata
    expires_at INTEGER, -- For automatic cleanup
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- Indexes for R2 asset tracking
CREATE INDEX IF NOT EXISTS idx_r2_assets_repo ON r2_asset_tracking(repo);
CREATE INDEX IF NOT EXISTS idx_r2_assets_type ON r2_asset_tracking(asset_type);
CREATE INDEX IF NOT EXISTS idx_r2_assets_expires ON r2_asset_tracking(expires_at);
CREATE INDEX IF NOT EXISTS idx_r2_assets_created ON r2_asset_tracking(created_at);

-- GitHub Commits tracking (for logging commit activity)
CREATE TABLE IF NOT EXISTS github_commits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    commit_url TEXT NOT NULL,
    branch TEXT NOT NULL,
    files_committed TEXT NOT NULL, -- JSON array of file paths
    commit_message TEXT NOT NULL,
    pull_request_number INTEGER,
    pull_request_url TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- Indexes for GitHub commits
CREATE INDEX IF NOT EXISTS idx_github_commits_repo ON github_commits(repo);
CREATE INDEX IF NOT EXISTS idx_github_commits_sha ON github_commits(commit_sha);
CREATE INDEX IF NOT EXISTS idx_github_commits_branch ON github_commits(branch);
CREATE INDEX IF NOT EXISTS idx_github_commits_created ON github_commits(created_at);
CREATE INDEX IF NOT EXISTS idx_github_commits_pr ON github_commits(pull_request_number);

-- Add triggers to update updated_at timestamps
CREATE TRIGGER IF NOT EXISTS update_llms_content_timestamp
    AFTER UPDATE ON llms_full_content
    FOR EACH ROW
BEGIN
    UPDATE llms_full_content
    SET updated_at = strftime('%s', 'now') * 1000
    WHERE content_id = NEW.content_id;
END;

CREATE TRIGGER IF NOT EXISTS update_agent_requests_timestamp
    AFTER UPDATE ON agent_generation_requests
    FOR EACH ROW
BEGIN
    UPDATE agent_generation_requests
    SET updated_at = strftime('%s', 'now') * 1000
    WHERE request_id = NEW.request_id;
END;

CREATE TRIGGER IF NOT EXISTS update_infra_requests_timestamp
    AFTER UPDATE ON infrastructure_guidance_requests
    FOR EACH ROW
BEGIN
    UPDATE infrastructure_guidance_requests
    SET updated_at = strftime('%s', 'now') * 1000
    WHERE request_id = NEW.request_id;
END;

-- Views for common queries

-- Active LLM Content with metadata
CREATE VIEW IF NOT EXISTS v_active_llm_content AS
SELECT
    content_id,
    category,
    url,
    title,
    content_length,
    last_fetched,
    json_extract(metadata, '$.contentType') as content_type,
    json_extract(metadata, '$.difficulty') as difficulty,
    json_extract(metadata, '$.wordCount') as word_count,
    created_at,
    updated_at
FROM llms_full_content
WHERE is_active = 1;

-- Recent Agent Generation Requests with summary
CREATE VIEW IF NOT EXISTS v_recent_agent_requests AS
SELECT
    request_id,
    repo,
    request_type,
    project_type,
    status,
    processing_time_ms,
    created_at,
    completed_at,
    CASE
        WHEN status = 'completed' AND completed_at IS NOT NULL
        THEN 'success'
        WHEN status = 'failed' OR error_details IS NOT NULL
        THEN 'failed'
        ELSE 'pending'
    END as result_status
FROM agent_generation_requests
ORDER BY created_at DESC;

-- Documentation freshness summary
CREATE VIEW IF NOT EXISTS v_documentation_freshness AS
SELECT
    category,
    COUNT(*) as total_docs,
    AVG(last_fetched) as avg_last_fetched,
    MIN(last_fetched) as oldest_fetch,
    MAX(last_fetched) as newest_fetch,
    AVG(content_length) as avg_content_length
FROM llms_full_content
WHERE is_active = 1
GROUP BY category;

-- System Configuration table for storing app-wide settings
CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- Create initial system configuration record
INSERT OR IGNORE INTO system_config (key, value, created_at) VALUES
('agent_services_version', '1.0.0', strftime('%s', 'now') * 1000),
('llm_content_cache_enabled', 'true', strftime('%s', 'now') * 1000),
('vectorization_enabled', 'false', strftime('%s', 'now') * 1000),
('auto_refresh_interval_hours', '24', strftime('%s', 'now') * 1000);

-- Create schema_migrations table if it doesn't exist (for migration tracking)
CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
);

-- Migration complete
INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES ('0006_agent_services_schema', strftime('%s', 'now') * 1000);
