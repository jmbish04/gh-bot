# GitHub Copilot MCP Workspace

This document summarizes how the GH Bot worker exposes a Model Context Protocol (MCP) workspace that GitHub Copilot can use to synchronize configuration, instructions, questions, and task management data.

## Overview
- **Endpoint**: `GET {{worker_base_url}}/mcp/github-copilot/sse`
- **Protocol**: Server-Sent Events (SSE) following the MCP handshake model
- **Tools exposed**:
  - `get_copilot_config`
  - `list_instructions`
  - `submit_question`
  - `list_questions`
  - `list_tasks`
  - `create_manual_task`
  - `update_task_status`

The migration `0009_github_copilot_mcp.sql` seeds tables that back these tools and registers the server as a default MCP integration for repositories that do not already have custom MCP tooling configured.

## Data Stores

| Table | Purpose |
| --- | --- |
| `copilot_configs` | Key/value configuration payloads returned by the `get_copilot_config` tool. |
| `copilot_instructions` | Instruction documents Copilot can retrieve via `list_instructions`. |
| `copilot_questions` | Records submitted by Copilot when it invokes `submit_question`. |
| `copilot_task_links` | Manual tasks that Copilot can create, list, or update. |

The MCP server also surfaces recent `agent_generation_requests` and `infrastructure_guidance_requests` as read-only tasks so Copilot has full context when coordinating work.

## Recommended Copilot Workflow

1. **Connect** to the SSE endpoint. The server will emit:
   - A session descriptor with capability metadata
   - A list of resources Copilot can fetch (`copilot://configs`, `copilot://instructions`, `copilot://tasks`, `copilot://questions/open`)
   - A tool schema definition payload
2. **Load instructions** using `list_instructions` or the `copilot://instructions` resource.
3. **Synchronize configuration** via `get_copilot_config`, optionally filtering by key.
4. **Plan work** by calling `list_tasks`. Copilot can create new manual tasks or update existing ones using the exposed tools.
5. **Ask clarifying questions** with `submit_question`. These records are tracked in the `copilot_questions` table so humans can triage and respond.
6. **Update statuses** using `update_task_status` once work is complete to keep the shared task board accurate.

## Security Notes
- The MCP endpoints use the same Worker runtime authentication model as the rest of the API.
- Data is stored in D1 and benefits from the existing operational logging via `mcp_tools_logs`.
- No secrets are exposed through the MCP server; configuration values seeded in the migration are descriptive metadata only.

## Extending the Workspace
- Add new instruction documents by inserting records into `copilot_instructions`.
- Register additional configuration keys in `copilot_configs` to make them queryable by Copilot.
- Extend task automation by inserting new sources into `copilot_task_links` or joining additional system tables inside `fetchCopilotTasks`.
- Update the default MCP server payload inside `migrations/0009_github_copilot_mcp.sql` (and `DEFAULT_MCP_TOOLS` in `src/modules/mcp_tools.ts`) if you deploy the Worker to a different hostname.

