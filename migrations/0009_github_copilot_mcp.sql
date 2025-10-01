-- Migration 0009: GitHub Copilot MCP workspace support
-- Adds configuration, instruction, question, and task tables used by the GitHub Copilot MCP server
-- and seeds a default MCP server configuration so new repositories automatically receive the tool.

-- Ensure supporting tables exist
CREATE TABLE IF NOT EXISTS copilot_configs (
    config_key TEXT PRIMARY KEY,
    config_value TEXT NOT NULL,
    description TEXT,
    category TEXT,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE TABLE IF NOT EXISTS copilot_instructions (
    instruction_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT,
    content TEXT,
    tags TEXT,
    source TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE TABLE IF NOT EXISTS copilot_questions (
    question_id TEXT PRIMARY KEY,
    repo TEXT,
    question TEXT NOT NULL,
    context_json TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    response TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE TABLE IF NOT EXISTS copilot_task_links (
    task_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    source TEXT NOT NULL DEFAULT 'manual',
    source_reference TEXT,
    priority INTEGER DEFAULT 3,
    due_at INTEGER,
    metadata TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- Helpful indexes for filtering
CREATE INDEX IF NOT EXISTS idx_copilot_configs_category ON copilot_configs(category);
CREATE INDEX IF NOT EXISTS idx_copilot_instructions_tags ON copilot_instructions(tags);
CREATE INDEX IF NOT EXISTS idx_copilot_instructions_active ON copilot_instructions(is_active);
CREATE INDEX IF NOT EXISTS idx_copilot_questions_status ON copilot_questions(status);
CREATE INDEX IF NOT EXISTS idx_copilot_questions_created ON copilot_questions(created_at);
CREATE INDEX IF NOT EXISTS idx_copilot_tasks_status ON copilot_task_links(status);
CREATE INDEX IF NOT EXISTS idx_copilot_tasks_due ON copilot_task_links(due_at);

-- Seed default configuration values
INSERT OR IGNORE INTO copilot_configs (config_key, config_value, description, category)
VALUES
    (
        'default_instruction_pack',
        '{"version":"2025-02-11","instructions_uri":"copilot://instructions","summary":"Primary operating instructions for the GH Bot Copilot workspace."}',
        'Primary instruction document that Copilot should load on connect.',
        'instructions'
    ),
    (
        'task_sync_preferences',
        '{"poll_interval_minutes":5,"sync_sources":["manual","agent_generation","infra_guidance"]}',
        'Controls how frequently Copilot should sync the task dashboard.',
        'tasks'
    ),
    (
        'question_routing',
        '{"default_assignee":"triage","status_flow":["open","acknowledged","answered","archived"]}',
        'Defines routing metadata for questions created by GitHub Copilot.',
        'questions'
    );

-- Seed baseline instruction content
INSERT OR IGNORE INTO copilot_instructions (instruction_id, title, summary, content, tags, source)
VALUES
    (
        'operational-guardrails',
        'Operational guardrails for GH Bot automations',
        'Step-by-step checklist Copilot should follow before triggering automation or deployment actions.',
        '1. Confirm repository ownership and recent activity.\n2. Review open incidents or critical alerts.\n3. Validate deployment prerequisites (wrangler config, secrets, migrations).\n4. Use `/status` task summary before high-impact actions.\n5. Capture outputs and link them to the related task record.',
        '["operations","safety","deployments"]',
        'docs/GITHUB_COPILOT_MCP.md'
    ),
    (
        'collaboration-etiquette',
        'Collaboration etiquette for pairing with maintainers',
        'Communication guidance for Copilot-initiated PR reviews, comments, and check-ins.',
        '• Always provide concise context referencing the file path and change summary.\n• Offer remediation steps or follow-up tasks when flagging risks.\n• Use the MCP task tools to create or link actionable items.\n• Prefer async updates via status threads when the maintainer is inactive.',
        '["communication","pull-requests"]',
        'docs/GITHUB_COPILOT_MCP.md'
    ),
    (
        'task-handoff-template',
        'Task hand-off template',
        'Template Copilot should follow when transitioning work back to humans.',
        'Summary:\n- What changed\n- Tests executed\n- Remaining risks\nNext steps:\n- Link or create GH issue\n- Update MCP task status\n- Provide recommended follow-up window',
        '["tasks","handoff"]',
        'docs/GITHUB_COPILOT_MCP.md'
    );

-- Add a placeholder manual task so dashboards have an example entry
INSERT OR IGNORE INTO copilot_task_links (task_id, title, description, status, source, priority, metadata)
VALUES (
    'seed-task-initialize-copilot-workspace',
    'Verify GitHub Copilot MCP workspace wiring',
    'Confirm Copilot can connect to the new MCP endpoint, list resources, and call task APIs.',
    'in_progress',
    'manual',
    2,
    '{"checklist":["Connect via Copilot","Fetch instructions","Sync tasks"],"owner":"platform"}'
);

-- Ensure the GitHub Copilot MCP server is registered as a default tool
INSERT OR IGNORE INTO default_mcp_tools (tool_name, tool_config, description, is_active)
VALUES (
    'github-copilot-mcp',
    '{"type":"sse","url":"{{worker_base_url}}/mcp/github-copilot/sse","tools":["get_copilot_config","list_instructions","submit_question","list_questions","list_tasks","create_manual_task","update_task_status"]}',
    'GH Bot GitHub Copilot workspace MCP server for configuration, instructions, Q&A, and task operations.',
    1
);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES ('0009_github_copilot_mcp', strftime('%s', 'now') * 1000);
