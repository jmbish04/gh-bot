-- Migration 0012: Repository setup automation support

CREATE TABLE IF NOT EXISTS repo_setup_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    event_type TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    details_json TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_repo_setup_logs_repo ON repo_setup_logs(repo);
CREATE INDEX IF NOT EXISTS idx_repo_setup_logs_created ON repo_setup_logs(created_at);

CREATE TABLE IF NOT EXISTS repo_guidance_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    language TEXT,
    infrastructure TEXT,
    framework TEXT,
    agent_template TEXT,
    style_template TEXT,
    source TEXT DEFAULT 'manual',
    UNIQUE(language, infrastructure, framework)
);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES ('0012_repo_setup', strftime('%s','now') * 1000);
