CREATE TABLE IF NOT EXISTS merge_operations (
  id TEXT PRIMARY KEY,
  pr_id INTEGER,
  pr_number INTEGER NOT NULL,
  repo TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  triggered_by TEXT NOT NULL,
  trigger_comment_id INTEGER,

  status TEXT NOT NULL DEFAULT 'pending',
  conflicts_detected INTEGER,
  conflict_files TEXT,
  ai_analysis TEXT,
  suggestion_comment_id INTEGER,
  suggestion_posted_at DATETIME,

  user_action TEXT,
  user_action_at DATETIME,
  approved_by TEXT,

  committed_hash TEXT,
  committed_at DATETIME,

  error_message TEXT,
  error_details TEXT,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,

  FOREIGN KEY (pr_id) REFERENCES projects(repo_id)
);

CREATE INDEX IF NOT EXISTS idx_merge_ops_pr ON merge_operations(pr_id, pr_number);
CREATE INDEX IF NOT EXISTS idx_merge_ops_status ON merge_operations(status);
CREATE INDEX IF NOT EXISTS idx_merge_ops_created ON merge_operations(created_at DESC);
