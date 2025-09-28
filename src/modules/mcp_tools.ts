// src/modules/mcp_tools.ts
// Module for managing MCP tools configuration and operations

interface McpToolsConfig {
  mcpServers: Record<string, McpServerConfig>
}

interface McpServerConfig {
  type: string
  url: string
  tools: string[]
}

interface McpToolRecord {
  id?: number
  tool_name: string
  tool_config: string // JSON string
  description?: string
  is_active: number
  source?: string
  created_at?: number
  updated_at?: number
}

interface McpOperationLog {
  repo: string
  operation: 'setup' | 'update' | 'check' | 'skip'
  operation_details?: string // JSON string
  tools_added?: string // JSON array
  tools_found?: string // JSON array
  status: 'success' | 'error' | 'warning'
  error_message?: string
  processing_time_ms?: number
  triggered_by: 'webhook_event' | 'manual' | 'sync'
  event_type?: string
}

/**
 * Default MCP tools configuration
 */
export const DEFAULT_MCP_TOOLS: McpToolsConfig = {
  mcpServers: {
    "cloudflare-playwright-mcp": {
      type: "sse",
      url: "https://browser-renderer-mcp.hacolby.workers.dev/sse",
      tools: [
        "browser_close",
        "browser_resize",
        "browser_console_messages",
        "browser_handle_dialog",
        "browser_file_upload",
        "browser_press_key",
        "browser_navigate",
        "browser_navigate_back",
        "browser_navigate_forward",
        "browser_network_requests",
        "browser_pdf_save",
        "browser_take_screenshot",
        "browser_snapshot",
        "browser_click",
        "browser_drag",
        "browser_hover",
        "browser_type",
        "browser_select_option",
        "browser_tab_list",
        "browser_tab_new",
        "browser_tab_select",
        "browser_tab_close",
        "browser_generate_playwright_test",
        "browser_wait_for"
      ]
    },
    "cloudflare-docs": {
      type: "sse",
      url: "https://docs.mcp.cloudflare.com/sse",
      tools: [
        "search_cloudflare_documentation",
        "migrate_pages_to_workers_guide"
      ]
    }
  }
}

interface DbToolRecord {
  tool_name: string
  tool_config: string
}

/**
 * Gets active default MCP tools from the database
 */
export async function getDefaultMcpTools(db: D1Database): Promise<McpToolsConfig> {
  try {
    const results = await db.prepare(`
      SELECT tool_name, tool_config
      FROM default_mcp_tools 
      WHERE is_active = 1
    `).all<DbToolRecord>()

    const mcpServers: Record<string, McpServerConfig> = {}
    
    for (const row of results.results ?? []) {
      try {
        mcpServers[row.tool_name] = JSON.parse(row.tool_config)
      } catch (error) {
        console.warn(`[MCP_TOOLS] Failed to parse config for tool ${row.tool_name}:`, error)
      }
    }

    return { mcpServers }
  } catch (error) {
    console.error('[MCP_TOOLS] Error getting default MCP tools:', error)
    // Return hardcoded defaults as fallback
    return DEFAULT_MCP_TOOLS
  }
}

/**
 * Gets MCP tools configured for a specific repository
 */
export async function getRepoMcpTools(db: D1Database, repo: string): Promise<McpToolsConfig | null> {
  try {
    const results = await db.prepare(`
      SELECT tool_name, tool_config
      FROM repo_mcp_tools 
      WHERE repo = ? AND is_active = 1
    `).bind(repo).all<DbToolRecord>()

    if (!results.results?.length) {
      return null // No MCP tools configured for this repo
    }

    const mcpServers: Record<string, McpServerConfig> = {}
    
    for (const row of results.results) {
      try {
        mcpServers[row.tool_name] = JSON.parse(row.tool_config)
      } catch (error) {
        console.warn(`[MCP_TOOLS] Failed to parse config for repo ${repo} tool ${row.tool_name}:`, error)
      }
    }

    return { mcpServers }
  } catch (error) {
    console.error(`[MCP_TOOLS] Error getting MCP tools for repo ${repo}:`, error)
    return null
  }
}

/**
 * Gets MCP tool names for a repository (more efficient than getting full configs)
 */
async function getRepoMcpToolNames(db: D1Database, repo: string): Promise<string[]> {
  try {
    const results = await db.prepare(`
      SELECT tool_name FROM repo_mcp_tools WHERE repo = ? AND is_active = 1
    `).bind(repo).all<{tool_name: string}>()
    
    return results.results?.map(r => r.tool_name) ?? []
  } catch (error) {
    console.error(`[MCP_TOOLS] Error getting tool names for repo ${repo}:`, error)
    return []
  }
}

/**
 * Checks if a repository has MCP tools configured
 */
export async function hasRepoMcpTools(db: D1Database, repo: string): Promise<boolean> {
  try {
    const result = await db.prepare(`
      SELECT 1
      FROM repo_mcp_tools 
      WHERE repo = ? AND is_active = 1
      LIMIT 1
    `).bind(repo).first()

    return !!result
  } catch (error) {
    console.error(`[MCP_TOOLS] Error checking if repo ${repo} has MCP tools:`, error)
    return false
  }
}

/**
 * Sets up default MCP tools for a repository
 */
export async function setupDefaultMcpTools(
  db: D1Database, 
  repo: string
): Promise<{ success: boolean; toolsAdded: string[]; error?: string }> {
  const startTime = Date.now()
  const toolsAdded: string[] = []

  try {
    // Get default MCP tools
    const defaultTools = await getDefaultMcpTools(db)
    
    // Insert each default tool for this repository
    for (const [toolName, toolConfig] of Object.entries(defaultTools.mcpServers)) {
      try {
        const result = await db.prepare(`
          INSERT OR IGNORE INTO repo_mcp_tools 
          (repo, tool_name, tool_config, source, is_active)
          VALUES (?, ?, ?, 'default', 1)
        `).bind(repo, toolName, JSON.stringify(toolConfig)).run()
        
        if (result.changes && result.changes > 0) {
          toolsAdded.push(toolName)
        }
      } catch (error) {
        console.warn(`[MCP_TOOLS] Failed to add tool ${toolName} for repo ${repo}:`, error)
      }
    }

    const processingTime = Date.now() - startTime

    // Log the operation
    await logMcpOperation(db, {
      repo,
      operation: 'setup',
      operation_details: JSON.stringify({
        source: 'default_tools',
        total_tools: toolsAdded.length
      }),
      tools_added: JSON.stringify(toolsAdded),
      status: 'success',
      processing_time_ms: processingTime,
      triggered_by: 'webhook_event'
    })

    console.log(`[MCP_TOOLS] Successfully set up ${toolsAdded.length} default MCP tools for repo ${repo}`)
    
    return { success: true, toolsAdded }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const processingTime = Date.now() - startTime

    // Log the error
    await logMcpOperation(db, {
      repo,
      operation: 'setup',
      status: 'error',
      error_message: errorMessage,
      processing_time_ms: processingTime,
      triggered_by: 'webhook_event'
    })

    console.error(`[MCP_TOOLS] Failed to set up default MCP tools for repo ${repo}:`, error)
    
    return { success: false, toolsAdded: [], error: errorMessage }
  }
}

/**
 * Checks and sets up MCP tools for a repository if needed
 * This is the main function called by webhook handlers
 */
export async function ensureRepoMcpTools(
  db: D1Database, 
  repo: string, 
  eventType?: string
): Promise<{ action: 'setup' | 'skip'; toolsAdded?: string[]; toolsFound?: string[]; error?: string }> {
  const startTime = Date.now()

  try {
    // Check if repo already has MCP tools (more efficient check)
    const existingToolNames = await getRepoMcpToolNames(db, repo)
    
    if (existingToolNames.length > 0) {
      // Repository already has MCP tools configured - don't modify
      const processingTime = Date.now() - startTime

      await logMcpOperation(db, {
        repo,
        operation: 'check',
        operation_details: JSON.stringify({
          found_tools: existingToolNames.length,
          action: 'skipped_existing_config'
        }),
        tools_found: JSON.stringify(existingToolNames),
        status: 'success',
        processing_time_ms: processingTime,
        triggered_by: 'webhook_event',
        event_type: eventType
      })

      console.log(`[MCP_TOOLS] Repo ${repo} already has ${existingToolNames.length} MCP tools configured - skipping setup`)
      
      return { action: 'skip', toolsFound: existingToolNames }
    }

    // No MCP tools found - set up defaults
    const setupResult = await setupDefaultMcpTools(db, repo)
    
    if (setupResult.success) {
      console.log(`[MCP_TOOLS] Set up default MCP tools for repo ${repo}: ${setupResult.toolsAdded.join(', ')}`)
      return { action: 'setup', toolsAdded: setupResult.toolsAdded }
    } else {
      return { action: 'setup', error: setupResult.error }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const processingTime = Date.now() - startTime

    await logMcpOperation(db, {
      repo,
      operation: 'check',
      status: 'error',
      error_message: errorMessage,
      processing_time_ms: processingTime,
      triggered_by: 'webhook_event',
      event_type: eventType
    })

    console.error(`[MCP_TOOLS] Error ensuring MCP tools for repo ${repo}:`, error)
    
    return { action: 'skip', error: errorMessage }
  }
}

/**
 * Logs MCP tools operations for traceability
 */
async function logMcpOperation(db: D1Database, logData: McpOperationLog): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO mcp_tools_logs 
      (repo, operation, operation_details, tools_added, tools_found, status, 
       error_message, processing_time_ms, triggered_by, event_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      logData.repo,
      logData.operation,
      logData.operation_details || null,
      logData.tools_added || null,
      logData.tools_found || null,
      logData.status,
      logData.error_message || null,
      logData.processing_time_ms || null,
      logData.triggered_by,
      logData.event_type || null,
      Date.now()
    ).run()
  } catch (error) {
    // Don't fail the operation if logging fails, but warn about it
    console.warn('[MCP_TOOLS] Failed to log MCP operation:', error)
  }
}

/**
 * Updates default MCP tools in the database (for frontend self-service)
 */
export async function updateDefaultMcpTool(
  db: D1Database,
  toolName: string,
  toolConfig: McpServerConfig,
  description?: string
): Promise<boolean> {
  try {
    await db.prepare(`
      INSERT INTO default_mcp_tools (tool_name, tool_config, description, is_active, updated_at)
      VALUES (?1, ?2, ?3, 1, ?4)
      ON CONFLICT(tool_name) DO UPDATE SET
        tool_config = excluded.tool_config,
        description = excluded.description,
        is_active = excluded.is_active,
        updated_at = excluded.updated_at
    `).bind(
      toolName, 
      JSON.stringify(toolConfig), 
      description || null, 
      Date.now()
    ).run()

    console.log(`[MCP_TOOLS] Updated default MCP tool: ${toolName}`)
    return true
  } catch (error) {
    console.error(`[MCP_TOOLS] Failed to update default MCP tool ${toolName}:`, error)
    return false
  }
}

/**
 * Gets MCP tools operation logs for a repository
 */
export async function getMcpToolsLogs(
  db: D1Database,
  repo: string,
  limit: number = 50
): Promise<McpOperationLog[]> {
  try {
    const results = await db.prepare(`
      SELECT *
      FROM mcp_tools_logs
      WHERE repo = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(repo, limit).all<McpOperationLog>()

    return results.results ?? []
  } catch (error) {
    console.error(`[MCP_TOOLS] Error getting logs for repo ${repo}:`, error)
    return []
  }
}