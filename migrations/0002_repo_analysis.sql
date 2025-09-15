-- Add repo analysis table for AI code exploration
CREATE TABLE IF NOT EXISTS repo_analysis (
  repo_full_name TEXT PRIMARY KEY,
  analyzed_at INTEGER NOT NULL,
  files_sampled INTEGER NOT NULL,
  bytes_sampled INTEGER NOT NULL,
  languages_json TEXT,             -- ["ts","js","toml","md",...]
  signals_json TEXT,               -- extracted signals (routes, fetch, CF bindings)
  purpose TEXT,                    -- single line purpose
  summary_short TEXT,              -- <140 chars
  summary_long TEXT,               -- 5–10 lines
  risk_flags_json TEXT,            -- ["proxy/vpn","abuse-risk","network-tunneling",...]
  confidence REAL,                  -- 0..1
  structured_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_repo_analysis_analyzed_at ON repo_analysis(analyzed_at DESC);
CREATE INDEX IF NOT EXISTS idx_repo_analysis_confidence ON repo_analysis(confidence DESC);
