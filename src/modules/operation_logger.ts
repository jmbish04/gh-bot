/**
 * Operation Logger
 * Provides structured logging for operations with database persistence
 */

export interface LogEntry {
  operationId: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  details?: any;
  timestamp?: number;
}

export interface Env {
  DB: D1Database;
}

export class OperationLogger {
  private env: Env;
  private operationId: string;

  constructor(env: Env, operationId: string) {
    this.env = env;
    this.operationId = operationId;
  }

  /**
   * Log a debug message
   */
  async debug(message: string, details?: any): Promise<void> {
    await this.log('debug', message, details);
  }

  /**
   * Log an info message
   */
  async info(message: string, details?: any): Promise<void> {
    await this.log('info', message, details);
  }

  /**
   * Log a warning message
   */
  async warn(message: string, details?: any): Promise<void> {
    await this.log('warn', message, details);
  }

  /**
   * Log an error message
   */
  async error(message: string, details?: any): Promise<void> {
    await this.log('error', message, details);
  }

  /**
   * Log a message with the specified level
   */
  private async log(level: 'debug' | 'info' | 'warn' | 'error', message: string, details?: any): Promise<void> {
    const timestamp = Date.now();
    
    try {
      // Store in database
      await this.env.DB.prepare(`
        INSERT INTO operation_logs (operation_id, log_level, message, details, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        this.operationId,
        level,
        message,
        details ? JSON.stringify(details) : null,
        timestamp
      ).run();

      // Also log to console for development
      const logMessage = `[${this.operationId}] ${level.toUpperCase()}: ${message}`;
      const logDetails = details ? ` | Details: ${JSON.stringify(details)}` : '';
      
      switch (level) {
        case 'debug':
          console.debug(logMessage + logDetails);
          break;
        case 'info':
          console.info(logMessage + logDetails);
          break;
        case 'warn':
          console.warn(logMessage + logDetails);
          break;
        case 'error':
          console.error(logMessage + logDetails);
          break;
      }
    } catch (error) {
      console.error(`Failed to log message for operation ${this.operationId}:`, error);
    }
  }

  /**
   * Get logs for this operation
   */
  async getLogs(limit: number = 100): Promise<LogEntry[]> {
    try {
      const result = await this.env.DB.prepare(`
        SELECT operation_id, log_level, message, details, timestamp
        FROM operation_logs
        WHERE operation_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `).bind(this.operationId, limit).all();

      return (result.results as any[]).map(row => ({
        operationId: row.operation_id,
        level: row.log_level,
        message: row.message,
        details: row.details ? JSON.parse(row.details) : undefined,
        timestamp: row.timestamp
      }));
    } catch (error) {
      console.error(`Failed to get logs for operation ${this.operationId}:`, error);
      return [];
    }
  }

  /**
   * Get logs for any operation
   */
  static async getLogsForOperation(env: Env, operationId: string, limit: number = 100): Promise<LogEntry[]> {
    try {
      const result = await env.DB.prepare(`
        SELECT operation_id, log_level, message, details, timestamp
        FROM operation_logs
        WHERE operation_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `).bind(operationId, limit).all();

      return (result.results as any[]).map(row => ({
        operationId: row.operation_id,
        level: row.log_level,
        message: row.message,
        details: row.details ? JSON.parse(row.details) : undefined,
        timestamp: row.timestamp
      }));
    } catch (error) {
      console.error(`Failed to get logs for operation ${operationId}:`, error);
      return [];
    }
  }

  /**
   * Get recent logs across all operations
   */
  static async getRecentLogs(env: Env, limit: number = 50): Promise<LogEntry[]> {
    try {
      const result = await env.DB.prepare(`
        SELECT operation_id, log_level, message, details, timestamp
        FROM operation_logs
        ORDER BY timestamp DESC
        LIMIT ?
      `).bind(limit).all();

      return (result.results as any[]).map(row => ({
        operationId: row.operation_id,
        level: row.log_level,
        message: row.message,
        details: row.details ? JSON.parse(row.details) : undefined,
        timestamp: row.timestamp
      }));
    } catch (error) {
      console.error('Failed to get recent logs:', error);
      return [];
    }
  }
}
