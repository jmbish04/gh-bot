-- Migration 0005: Enhanced Webhook Logging
-- Add comprehensive webhook payload storage and command tracking

-- Enhance gh_events table to store complete webhook data
-- ALTER TABLE gh_events ADD COLUMN payload_json TEXT;        -- Complete webhook payload
-- ALTER TABLE gh_events ADD COLUMN triggers_json TEXT;       -- Array of trigger commands found
-- ALTER TABLE gh_events ADD COLUMN suggestions_json TEXT;    -- Array of code suggestions found
-- ALTER TABLE gh_events ADD COLUMN response_status TEXT;     -- Success/error status
-- ALTER TABLE gh_events ADD COLUMN response_message TEXT;    -- Response sent to user
-- ALTER TABLE gh_events ADD COLUMN processing_time_ms INTEGER; -- How long processing took
-- ALTER TABLE gh_events ADD COLUMN error_details TEXT;       -- Full error details if failed



-- Create table for detailed command execution tracking
CREATE TABLE IF NOT EXISTS webhook_command_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL,           -- Links to gh_events
  command_text TEXT NOT NULL,          -- Full command as typed by user
  command_type TEXT NOT NULL,          -- e.g., "colby_implement", "apply", "summarize"
  command_args TEXT,                   -- JSON of parsed arguments
  execution_status TEXT NOT NULL,      -- "started", "completed", "failed"
  execution_result TEXT,               -- Result details or error message
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),

  FOREIGN KEY (delivery_id) REFERENCES gh_events(delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_commands_delivery ON webhook_command_log(delivery_id);
CREATE INDEX IF NOT EXISTS idx_webhook_commands_type ON webhook_command_log(command_type);
CREATE INDEX IF NOT EXISTS idx_webhook_commands_status ON webhook_command_log(execution_status);
