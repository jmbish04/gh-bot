-- Add structured JSON analysis support
-- ALTER TABLE repo_analysis ADD COLUMN structured_json TEXT;

-- Create binding index table for fast queries
CREATE TABLE IF NOT EXISTS repo_analysis_bindings (
  repo_full_name TEXT NOT NULL,
  binding TEXT NOT NULL,
  PRIMARY KEY (repo_full_name, binding)
);

CREATE INDEX IF NOT EXISTS idx_repo_analysis_bindings_binding ON repo_analysis_bindings(binding);
