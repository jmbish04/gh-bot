-- Create operation_logs table for detailed operation logging
CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL,
    log_level TEXT NOT NULL DEFAULT 'info', -- debug, info, warn, error
    message TEXT NOT NULL,
    details TEXT, -- JSON string for additional context
    timestamp INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

-- Create index for efficient querying by operation_id
CREATE INDEX IF NOT EXISTS idx_operation_logs_operation_id ON operation_logs(operation_id);
CREATE INDEX IF NOT EXISTS idx_operation_logs_timestamp ON operation_logs(timestamp);

-- Create index for log level filtering
CREATE INDEX IF NOT EXISTS idx_operation_logs_level ON operation_logs(log_level);
