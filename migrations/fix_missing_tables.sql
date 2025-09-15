-- Comprehensive migration to create all missing tables

-- Create colby_commands table
CREATE TABLE IF NOT EXISTS colby_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER,
  author TEXT NOT NULL,
  command TEXT NOT NULL,
  command_args TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  prompt_generated TEXT,
  result_data TEXT,
  error_message TEXT,
  started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);

CREATE INDEX IF NOT EXISTS idx_colby_commands_repo ON colby_commands(repo);
CREATE INDEX IF NOT EXISTS idx_colby_commands_status ON colby_commands(status);
CREATE INDEX IF NOT EXISTS idx_colby_commands_author ON colby_commands(author);

-- Create best_practices table
CREATE TABLE IF NOT EXISTS best_practices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_text TEXT NOT NULL,
  context_repo TEXT NOT NULL,
  context_pr INTEGER,
  context_file TEXT,
  ai_tags TEXT,
  category TEXT,
  subcategory TEXT,
  confidence REAL DEFAULT 0.5,
  status TEXT DEFAULT 'pending',
  bookmarked_by TEXT NOT NULL,
  votes_up INTEGER DEFAULT 0,
  votes_down INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);

CREATE INDEX IF NOT EXISTS idx_best_practices_category ON best_practices(category, subcategory);
CREATE INDEX IF NOT EXISTS idx_best_practices_status ON best_practices(status);
CREATE INDEX IF NOT EXISTS idx_best_practices_repo ON best_practices(context_repo);

-- Create colby_issues table
CREATE TABLE IF NOT EXISTS colby_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  colby_command_id INTEGER NOT NULL,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  github_issue_id INTEGER,
  title TEXT NOT NULL,
  body TEXT,
  assignee TEXT,
  labels TEXT,
  state TEXT DEFAULT 'open',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  FOREIGN KEY (colby_command_id) REFERENCES colby_commands(id)
);

CREATE INDEX IF NOT EXISTS idx_colby_issues_repo ON colby_issues(repo);
CREATE INDEX IF NOT EXISTS idx_colby_issues_command ON colby_issues(colby_command_id);

-- Create operation_progress table
CREATE TABLE IF NOT EXISTS operation_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  operation_type TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER,
  status TEXT NOT NULL DEFAULT 'started',
  progress_percent INTEGER DEFAULT 0,
  current_step TEXT,
  steps_total INTEGER DEFAULT 1,
  steps_completed INTEGER DEFAULT 0,
  result_data TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);

CREATE INDEX IF NOT EXISTS idx_operation_progress_id ON operation_progress(operation_id);
CREATE INDEX IF NOT EXISTS idx_operation_progress_repo ON operation_progress(repo);
CREATE INDEX IF NOT EXISTS idx_operation_progress_status ON operation_progress(status);
