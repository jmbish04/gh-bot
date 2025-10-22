-- 0014_normalized_webhook_schema.sql
-- Introduces normalized schema for GitHub webhook ingestion
-- Creates a primary github_webhook_events table and supporting tables

-- 1. Main table to capture ALL incoming webhooks
CREATE TABLE IF NOT EXISTS github_webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    action TEXT,
    repo_full_name TEXT,
    author_login TEXT,
    associated_number INTEGER,
    received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    full_payload_json TEXT NOT NULL,
    ai_context_payload_json TEXT, -- Smaller context forwarded to AI assistants
    response_status TEXT,
    response_message TEXT,
    processing_time_ms INTEGER,
    error_details TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_github_webhook_events_delivery_id ON github_webhook_events (delivery_id);
CREATE INDEX IF NOT EXISTS idx_github_webhook_events_event_action ON github_webhook_events (event_type, action);
CREATE INDEX IF NOT EXISTS idx_github_webhook_events_repo ON github_webhook_events (repo_full_name);

-- 2. Supporting table for Pull Request events
CREATE TABLE IF NOT EXISTS pull_request_details (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_event_id INTEGER NOT NULL,
    pr_github_id INTEGER NOT NULL,
    pr_number INTEGER NOT NULL,
    pr_title TEXT,
    pr_state TEXT,
    pr_merged BOOLEAN,
    pr_created_at TEXT,
    pr_updated_at TEXT,
    pr_closed_at TEXT,
    pr_merged_at TEXT,
    FOREIGN KEY (webhook_event_id) REFERENCES github_webhook_events(id)
);

CREATE INDEX IF NOT EXISTS idx_pull_request_details_number ON pull_request_details (pr_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pull_request_details_github_id ON pull_request_details (pr_github_id);

-- 3. Supporting table for Pull Request Review events
CREATE TABLE IF NOT EXISTS pull_request_review_details (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_event_id INTEGER NOT NULL,
    review_github_id INTEGER NOT NULL,
    pr_number INTEGER NOT NULL,
    review_state TEXT,
    submitted_at TEXT,
    review_body TEXT,
    FOREIGN KEY (webhook_event_id) REFERENCES github_webhook_events(id)
);

CREATE INDEX IF NOT EXISTS idx_pull_request_review_details_pr_number ON pull_request_review_details (pr_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pull_request_review_details_github_id ON pull_request_review_details (review_github_id);

-- 4. Supporting table for Issue/PR Comment events
CREATE TABLE IF NOT EXISTS comment_details (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_event_id INTEGER NOT NULL,
    comment_github_id INTEGER NOT NULL,
    issue_number INTEGER NOT NULL,
    comment_type TEXT NOT NULL,
    comment_body TEXT,
    created_at TEXT,
    updated_at TEXT,
    FOREIGN KEY (webhook_event_id) REFERENCES github_webhook_events(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_details_github_id ON comment_details (comment_github_id);
CREATE INDEX IF NOT EXISTS idx_comment_details_issue_number ON comment_details (issue_number);

-- (Optional) Keep the legacy gh_events table for historical data until backfill is complete.
-- DROP TABLE IF EXISTS gh_events;
