CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY,
  full_name TEXT UNIQUE,           -- owner/name
  installation_id INTEGER NOT NULL,
  webhook_id INTEGER,              -- if you create repo webhooks
  default_branch TEXT,
  visibility TEXT,
  description TEXT,
  topics TEXT,                     -- JSON string
  summary TEXT,                    -- AI summary
  last_synced INTEGER,             -- epoch ms
  created_at INTEGER DEFAULT (strftime('%s','now')*1000),
  updated_at INTEGER DEFAULT (strftime('%s','now')*1000)
);
CREATE INDEX IF NOT EXISTS idx_repos_install ON repos(installation_id);

CREATE TABLE IF NOT EXISTS research_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,            -- running|success|error
  queries_json TEXT NOT NULL,      -- array of queries
  notes TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  repo_id INTEGER PRIMARY KEY,
  full_name TEXT UNIQUE,
  html_url TEXT,
  description TEXT,
  default_branch TEXT,
  stars INTEGER,
  forks INTEGER,
  topics TEXT,                     -- JSON array
  last_commit_ts INTEGER,
  created_at INTEGER,
  updated_at INTEGER,
  score REAL,
  short_summary TEXT,
  long_summary TEXT,
  last_seen INTEGER
);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_full_name TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  query TEXT NOT NULL,
  reason TEXT,
  signals_json TEXT,               -- raw scoring signals
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_findings_repo ON findings(repo_full_name);
CREATE INDEX IF NOT EXISTS idx_projects_score ON projects(score DESC);

-- Search terms master
CREATE TABLE IF NOT EXISTS search_terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,               -- the GitHub search query
  category TEXT NOT NULL,            -- e.g., 'cloudflare', 'appsscript'
  active INTEGER NOT NULL DEFAULT 1, -- 1=active, 0=inactive
  weight REAL NOT NULL DEFAULT 1.0,  -- influence in scoring/priority
  notes TEXT,                        -- free-form rationale
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  last_run_at INTEGER                -- when this term was last used
);

CREATE INDEX IF NOT EXISTS idx_terms_active ON search_terms(active);
CREATE INDEX IF NOT EXISTS idx_terms_category ON search_terms(category, active);

-- Seed: Cloudflare
INSERT OR IGNORE INTO search_terms (query, category, active, weight, notes) VALUES
('topic:cloudflare-workers',            'cloudflare', 1, 1.2, 'Official topic'),
('"wrangler.toml" path:/',              'cloudflare', 1, 1.0, 'Has wrangler config'),
('"compatibility_date" language:toml',  'cloudflare', 1, 1.0, 'Workers signal'),
('"DurableObject" language:typescript', 'cloudflare', 1, 1.0, 'DO projects'),
('"[[d1_databases]]" wrangler.toml',    'cloudflare', 1, 1.0, 'D1 binding'),
('"@cloudflare/ai" language:typescript','cloudflare', 1, 1.0, 'Workers AI'),
('"scheduled(event" language:typescript','cloudflare',1, 0.9, 'Cron usage'),
('"import { Hono" language:typescript', 'cloudflare', 1, 0.8, 'Hono + Workers');

-- Seed: Apps Script
INSERT OR IGNORE INTO search_terms (query, category, active, weight, notes) VALUES
('topic:google-apps-script',                 'appsscript', 1, 1.2, 'Official topic'),
('"Apps Script" language:javascript',        'appsscript', 1, 1.0, 'General'),
('"clasp" path:/ package.json',              'appsscript', 1, 1.0, 'CLASP projects'),
('"doGet(e)" OR "doPost(e)" language:javascript', 'appsscript', 1, 1.0, 'Web apps'),
('"google.script.run" language:javascript',  'appsscript', 1, 0.9, 'Client GAS calls'),
('"HtmlService.createTemplate" language:javascript','appsscript',1,0.9,'UI apps');

-- Developers / orgs (owners)
CREATE TABLE IF NOT EXISTS developer_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT UNIQUE NOT NULL,         -- e.g. "cloudflare", "jmbish04"
  type TEXT NOT NULL,                 -- "User" | "Organization"
  html_url TEXT,
  name TEXT,
  company TEXT,                       -- free-text from GitHub profile
  bio TEXT,
  location TEXT,
  blog TEXT,
  twitter TEXT,
  followers INTEGER,
  following INTEGER,
  public_repos INTEGER,
  orgs_json TEXT,                     -- JSON: orgs the user is in (for type=User)
  labels_json TEXT,                   -- JSON: derived labels (e.g. ["cloudflare","google","advocate"])
  affiliation_confidence REAL,        -- 0..1 derived
  short_summary TEXT,
  long_summary TEXT,
  last_seen INTEGER,                  -- epoch ms last time we saw activity
  created_at INTEGER DEFAULT (strftime('%s','now')*1000),
  updated_at INTEGER DEFAULT (strftime('%s','now')*1000)
);

-- Link interesting projects to owners (many projects ↔ one owner)
-- ALTER TABLE projects ADD COLUMN owner_login TEXT;
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_login);

-- Track scan work
CREATE TABLE IF NOT EXISTS scan_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                 -- "owner"
  key TEXT NOT NULL,                  -- e.g. owner login
  priority INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued|running|done|error
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  UNIQUE(kind, key)
);
CREATE INDEX IF NOT EXISTS idx_scan_queue_status ON scan_queue(status, priority DESC, created_at ASC);

CREATE TABLE IF NOT EXISTS gh_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT,             -- X-GitHub-Delivery
  event TEXT,                   -- header x-github-event
  repo TEXT,
  pr_number INTEGER,
  author TEXT,
  action TEXT,
  created_at INTEGER NOT NULL,
  payload_json TEXT,            -- Complete webhook payload
  triggers_json TEXT,           -- Array of trigger commands found
  suggestions_json TEXT,        -- Array of code suggestions found
  response_status TEXT,         -- Success/error status
  response_message TEXT,        -- Response sent to user
  processing_time_ms INTEGER,   -- How long processing took
  error_details TEXT            -- Full error details if failed
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_gh_delivery ON gh_events(delivery_id);

-- Add indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_gh_events_event ON gh_events(event);
CREATE INDEX IF NOT EXISTS idx_gh_events_repo ON gh_events(repo);
CREATE INDEX IF NOT EXISTS idx_gh_events_status ON gh_events(response_status);
CREATE INDEX IF NOT EXISTS idx_gh_events_created_at ON gh_events(created_at);