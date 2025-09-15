-- Migration 0004: Colby Features
-- Tables to support /colby commands and frontend features

-- Table for tracking colby command executions
CREATE TABLE IF NOT EXISTS colby_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL,        -- GitHub webhook delivery ID
  repo TEXT NOT NULL,               -- owner/repo
  pr_number INTEGER,                -- PR number if applicable
  author TEXT NOT NULL,             -- GitHub user who triggered command
  command TEXT NOT NULL,            -- e.g., "implement", "create issue", "bookmark"
  command_args TEXT,                -- JSON with command-specific arguments
  status TEXT NOT NULL DEFAULT 'queued',  -- queued|working|completed|failed
  prompt_generated TEXT,            -- AI-generated prompt for codex
  result_data TEXT,                 -- JSON with command results
  error_message TEXT,               -- Error details if failed
  started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);

CREATE INDEX IF NOT EXISTS idx_colby_commands_repo ON colby_commands(repo);
CREATE INDEX IF NOT EXISTS idx_colby_commands_status ON colby_commands(status);
CREATE INDEX IF NOT EXISTS idx_colby_commands_author ON colby_commands(author);

-- Table for bookmarked suggestions/best practices
CREATE TABLE IF NOT EXISTS best_practices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_text TEXT NOT NULL,
  context_repo TEXT NOT NULL,       -- repo where suggestion originated
  context_pr INTEGER,               -- PR number where found
  context_file TEXT,                -- file path if applicable
  ai_tags TEXT,                     -- JSON array of AI-generated tags
  category TEXT,                    -- e.g., "infrastructure", "framework", "security"
  subcategory TEXT,                 -- e.g., "workers", "appscript", "python", "shadcn", "tailwind"
  confidence REAL DEFAULT 0.5,     -- AI confidence in categorization (0-1)
  status TEXT DEFAULT 'pending',   -- pending|approved|rejected
  bookmarked_by TEXT NOT NULL,     -- GitHub user who bookmarked
  votes_up INTEGER DEFAULT 0,      -- community voting (future feature)
  votes_down INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);

CREATE INDEX IF NOT EXISTS idx_best_practices_category ON best_practices(category, subcategory);
CREATE INDEX IF NOT EXISTS idx_best_practices_status ON best_practices(status);
CREATE INDEX IF NOT EXISTS idx_best_practices_repo ON best_practices(context_repo);

-- Table for extracted suggestions from Gemini/code reviews
CREATE TABLE IF NOT EXISTS extracted_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  extraction_command_id INTEGER,    -- FK to colby_commands table
  gemini_comment_id TEXT,           -- Original Gemini comment ID
  suggestion_text TEXT NOT NULL,
  suggestion_type TEXT,             -- e.g., "code_change", "architecture", "security"
  target_file TEXT,                 -- file the suggestion applies to
  line_numbers TEXT,                -- JSON array of line numbers
  codex_prompt TEXT,                -- generated prompt for codex submission
  codex_job_id TEXT,                -- codex job ID if submitted
  codex_status TEXT,                -- pending|running|completed|failed
  processed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  FOREIGN KEY (extraction_command_id) REFERENCES colby_commands(id)
);

CREATE INDEX IF NOT EXISTS idx_extracted_suggestions_repo ON extracted_suggestions(repo, pr_number);
CREATE INDEX IF NOT EXISTS idx_extracted_suggestions_codex ON extracted_suggestions(codex_status);

-- Table for tracking GitHub issues created by colby
CREATE TABLE IF NOT EXISTS colby_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  colby_command_id INTEGER NOT NULL,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  github_issue_id INTEGER,          -- GitHub's internal issue ID
  title TEXT NOT NULL,
  body TEXT,
  assignee TEXT,                    -- GitHub username if assigned
  labels TEXT,                      -- JSON array of labels
  state TEXT DEFAULT 'open',       -- open|closed
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  FOREIGN KEY (colby_command_id) REFERENCES colby_commands(id)
);

CREATE INDEX IF NOT EXISTS idx_colby_issues_repo ON colby_issues(repo);
CREATE INDEX IF NOT EXISTS idx_colby_issues_command ON colby_issues(colby_command_id);

-- Table for operation progress tracking (for frontend real-time updates)
CREATE TABLE IF NOT EXISTS operation_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE, -- UUID for the operation
  operation_type TEXT NOT NULL,      -- command type
  repo TEXT NOT NULL,
  pr_number INTEGER,
  status TEXT NOT NULL DEFAULT 'started', -- started|progress|completed|failed
  progress_percent INTEGER DEFAULT 0, -- 0-100
  current_step TEXT,                  -- human-readable current step
  steps_total INTEGER DEFAULT 1,
  steps_completed INTEGER DEFAULT 0,
  result_data TEXT,                   -- JSON with final results
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);

CREATE INDEX IF NOT EXISTS idx_operation_progress_id ON operation_progress(operation_id);
CREATE INDEX IF NOT EXISTS idx_operation_progress_repo ON operation_progress(repo);
CREATE INDEX IF NOT EXISTS idx_operation_progress_status ON operation_progress(status);
