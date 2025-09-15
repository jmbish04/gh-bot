-- Create operation_progress table separately
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
