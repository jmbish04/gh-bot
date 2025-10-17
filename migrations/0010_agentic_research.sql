-- Migration for Agentic Research Features

-- Stores the overall research tasks
CREATE TABLE IF NOT EXISTS research_tasks (
id TEXT PRIMARY KEY,
query TEXT NOT NULL,
status TEXT NOT NULL, -- 'pending', 'in_progress', 'completed', 'failed'
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Stores the analysis of each repository found during a research task
CREATE TABLE IF NOT EXISTS research_results (
id INTEGER PRIMARY KEY AUTOINCREMENT,
task_id TEXT NOT NULL,
repo_url TEXT NOT NULL,
ai_analysis TEXT,
is_relevant BOOLEAN,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
FOREIGN KEY (task_id) REFERENCES research_tasks(id)
);

-- Stores your interests for the daily proactive search
CREATE TABLE IF NOT EXISTS user_interests (
id INTEGER PRIMARY KEY AUTOINCREMENT,
query TEXT NOT NULL UNIQUE,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tracks which repositories have been sent in a daily digest to avoid duplicates
CREATE TABLE IF NOT EXISTS sent_digests (
id INTEGER PRIMARY KEY AUTOINCREMENT,
repo_url TEXT NOT NULL UNIQUE,
sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Example interest for the daily search. You can add more via the D1 console or another API endpoint.
INSERT OR IGNORE INTO user_interests (query) VALUES ('"cloudflare workers" shadcn'), ('langchain "cloudflare d1"');
