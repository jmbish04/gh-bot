#!/bin/bash

# Manual Database Setup Script
# Run this if automatic migrations fail

echo "🚀 Setting up Colby GitHub Bot Database..."

echo "📝 Creating colby_commands table..."
npx wrangler d1 execute gh-bot --remote --command "
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
"

echo "📝 Creating best_practices table..."
npx wrangler d1 execute gh-bot --remote --command "
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
"

echo "📝 Creating operation_progress table..."
npx wrangler d1 execute gh-bot --remote --command "
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
"

echo "📝 Creating colby_issues table..."
npx wrangler d1 execute gh-bot --remote --command "
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
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);
"

echo "📝 Creating indexes..."
npx wrangler d1 execute gh-bot --remote --command "
CREATE INDEX IF NOT EXISTS idx_colby_commands_repo ON colby_commands(repo);
CREATE INDEX IF NOT EXISTS idx_colby_commands_status ON colby_commands(status);
CREATE INDEX IF NOT EXISTS idx_best_practices_status ON best_practices(status);
CREATE INDEX IF NOT EXISTS idx_operation_progress_status ON operation_progress(status);
"

echo "✅ Database setup complete!"
echo "🧪 Testing endpoints..."

echo "Testing /colby/commands..."
curl -s "https://gh-bot.hacolby.workers.dev/colby/commands" | head -100

echo -e "\n\nTesting /colby/best-practices..."
curl -s "https://gh-bot.hacolby.workers.dev/colby/best-practices" | head -100

echo -e "\n\n✨ Setup complete! Visit https://gh-bot.hacolby.workers.dev/ to see the dashboard."
