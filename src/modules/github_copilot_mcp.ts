import { DEFAULT_MCP_TOOLS } from "./mcp_tools";

const encoder = new TextEncoder();

export type CopilotToolInvocation = {
  tool: string;
  arguments?: Record<string, unknown> | null;
};

interface CopilotConfigRow {
  config_key: string;
  config_value: string;
  description: string | null;
  category: string | null;
  updated_at: number;
}

interface CopilotInstructionRow {
  instruction_id: string;
  title: string;
  summary: string | null;
  content: string | null;
  tags: string | null;
  source: string | null;
  updated_at: number;
  is_active: number;
}

interface CopilotQuestionRow {
  question_id: string;
  repo: string | null;
  question: string;
  context_json: string | null;
  status: string;
  response: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

interface CopilotTaskRow {
  task_id: string;
  title: string;
  description: string | null;
  status: string;
  source: string;
  source_reference: string | null;
  priority: number | null;
  due_at: number | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

type DbResult<T> = {
  results?: T[];
};

function safeJsonParse<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.warn("[COPILOT_MCP] Failed to parse JSON", { value, error });
    return null;
  }
}

function encodeSse(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

async function fetchCopilotConfigs(db: D1Database, keys?: string[]): Promise<Array<Record<string, unknown>>> {
  let query = `
    SELECT config_key, config_value, description, category, updated_at
    FROM copilot_configs
  `;

  const bindings: unknown[] = [];

  if (keys?.length) {
    const placeholders = keys.map(() => "?").join(", ");
    query += ` WHERE config_key IN (${placeholders})`;
    bindings.push(...keys);
  }

  query += " ORDER BY config_key";

  const result = await db.prepare(query).bind(...bindings).all<CopilotConfigRow>() as DbResult<CopilotConfigRow>;

  return (result.results ?? []).map((row) => ({
    key: row.config_key,
    value: safeJsonParse(row.config_value) ?? row.config_value,
    description: row.description,
    category: row.category,
    updatedAt: row.updated_at,
  }));
}

async function fetchCopilotInstructions(db: D1Database, tags?: string[]): Promise<Array<Record<string, unknown>>> {
  let query = `
    SELECT instruction_id, title, summary, content, tags, source, updated_at, is_active
    FROM copilot_instructions
    WHERE is_active = 1
  `;
  const bindings: unknown[] = [];

  if (tags?.length) {
    const tagFilter = tags.map(() => "tags LIKE ?").join(" OR ");
    query += ` AND (${tagFilter})`;
    bindings.push(...tags.map((tag) => `%${tag}%`));
  }

  query += " ORDER BY updated_at DESC";

  const result = await db.prepare(query).bind(...bindings).all<CopilotInstructionRow>() as DbResult<CopilotInstructionRow>;

  return (result.results ?? []).map((row) => ({
    id: row.instruction_id,
    title: row.title,
    summary: row.summary,
    content: row.content,
    tags: safeJsonParse<string[]>(row.tags) ?? [],
    source: row.source,
    updatedAt: row.updated_at,
  }));
}

async function fetchCopilotQuestions(db: D1Database, status?: string): Promise<Array<Record<string, unknown>>> {
  let query = `
    SELECT question_id, repo, question, context_json, status, response, metadata, created_at, updated_at
    FROM copilot_questions
  `;
  const bindings: unknown[] = [];

  if (status) {
    query += " WHERE status = ?";
    bindings.push(status);
  }

  query += " ORDER BY created_at DESC";

  const result = await db.prepare(query).bind(...bindings).all<CopilotQuestionRow>() as DbResult<CopilotQuestionRow>;

  return (result.results ?? []).map((row) => ({
    id: row.question_id,
    repo: row.repo,
    question: row.question,
    context: safeJsonParse<Record<string, unknown>>(row.context_json),
    status: row.status,
    response: row.response,
    metadata: safeJsonParse<Record<string, unknown>>(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function fetchCopilotTasks(db: D1Database, status?: string): Promise<Array<Record<string, unknown>>> {
  let query = `
    SELECT task_id, title, description, status, source, source_reference, priority, due_at, metadata, created_at, updated_at
    FROM copilot_task_links
  `;
  const bindings: unknown[] = [];

  if (status) {
    query += " WHERE status = ?";
    bindings.push(status);
  }

  query += " ORDER BY COALESCE(due_at, updated_at) ASC";

  const manual = await db.prepare(query).bind(...bindings).all<CopilotTaskRow>() as DbResult<CopilotTaskRow>;

  const manualTasks = (manual.results ?? []).map((row) => ({
    taskId: row.task_id,
    title: row.title,
    description: row.description,
    status: row.status,
    source: row.source,
    sourceReference: row.source_reference,
    priority: row.priority,
    dueAt: row.due_at,
    metadata: safeJsonParse<Record<string, unknown>>(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readOnly: false,
    type: "manual",
  }));

  const agentRequests = await db.prepare(`
    SELECT request_id, repo, status, request_type, project_type, created_at, updated_at
    FROM agent_generation_requests
    ORDER BY created_at DESC
    LIMIT 25
  `).all<{
    request_id: string;
    repo: string;
    status: string;
    request_type: string;
    project_type: string | null;
    created_at: number;
    updated_at: number;
  }>() as DbResult<{
    request_id: string;
    repo: string;
    status: string;
    request_type: string;
    project_type: string | null;
    created_at: number;
    updated_at: number;
  }>;

  const infraRequests = await db.prepare(`
    SELECT request_id, repo, status, infra_type, created_at, updated_at
    FROM infrastructure_guidance_requests
    ORDER BY created_at DESC
    LIMIT 25
  `).all<{
    request_id: string;
    repo: string;
    status: string;
    infra_type: string;
    created_at: number;
    updated_at: number;
  }>() as DbResult<{
    request_id: string;
    repo: string;
    status: string;
    infra_type: string;
    created_at: number;
    updated_at: number;
  }>;

  const agentTasks = (agentRequests.results ?? [])
    .filter((row) => !status || row.status === status)
    .map((row) => ({
      taskId: row.request_id,
      title: `Agent generation for ${row.repo}`,
      status: row.status,
      source: "agent_generation",
      sourceReference: row.repo,
      metadata: {
        requestType: row.request_type,
        projectType: row.project_type,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      readOnly: true,
      type: "agent_generation",
    }));

  const infraTasks = (infraRequests.results ?? [])
    .filter((row) => !status || row.status === status)
    .map((row) => ({
      taskId: row.request_id,
      title: `Infra guidance: ${row.repo}`,
      status: row.status,
      source: "infra_guidance",
      sourceReference: row.repo,
      metadata: {
        infraType: row.infra_type,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      readOnly: true,
      type: "infra_guidance",
    }));

  return [...manualTasks, ...agentTasks, ...infraTasks];
}

async function createCopilotQuestion(db: D1Database, params: { question: string; repo?: string; context?: unknown; metadata?: unknown; }): Promise<{ id: string; status: string; createdAt: number; }> {
  const questionId = crypto.randomUUID();
  const createdAt = Date.now();

  await db.prepare(`
    INSERT INTO copilot_questions (question_id, repo, question, context_json, status, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'open', ?, ?, ?)
  `).bind(
    questionId,
    params.repo || null,
    params.question,
    params.context ? JSON.stringify(params.context) : null,
    params.metadata ? JSON.stringify(params.metadata) : null,
    createdAt,
    createdAt,
  ).run();

  return { id: questionId, status: "open", createdAt };
}

async function createManualTask(db: D1Database, params: { title: string; description?: string; priority?: number; dueAt?: number; metadata?: unknown; }): Promise<{ id: string; status: string; createdAt: number; }> {
  const taskId = crypto.randomUUID();
  const createdAt = Date.now();

  await db.prepare(`
    INSERT INTO copilot_task_links (task_id, title, description, status, source, priority, due_at, metadata, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', 'manual', ?, ?, ?, ?, ?)
  `).bind(
    taskId,
    params.title,
    params.description || null,
    params.priority ?? null,
    params.dueAt ?? null,
    params.metadata ? JSON.stringify(params.metadata) : null,
    createdAt,
    createdAt,
  ).run();

  return { id: taskId, status: "pending", createdAt };
}

async function updateManualTaskStatus(db: D1Database, params: { taskId: string; status: string; metadata?: unknown; }): Promise<{ id: string; status: string; updatedAt: number; }> {
  const updatedAt = Date.now();

  const result = await db.prepare(`
    UPDATE copilot_task_links
    SET status = ?, metadata = COALESCE(?, metadata), updated_at = ?
    WHERE task_id = ?
  `).bind(
    params.status,
    params.metadata ? JSON.stringify(params.metadata) : null,
    updatedAt,
    params.taskId,
  ).run();

  if (!result.success || (result.changes ?? 0) === 0) {
    throw new Error(`Task ${params.taskId} not found or unchanged.`);
  }

  return { id: params.taskId, status: params.status, updatedAt };
}

function listToolDefinitions() {
  const toolConfig = DEFAULT_MCP_TOOLS.mcpServers["github-copilot-mcp"];
  const tools = toolConfig?.tools ?? [];

  const definitions: Record<string, { description: string; inputSchema: Record<string, unknown>; }> = {
    get_copilot_config: {
      description: "Retrieve GitHub Copilot workspace configuration records.",
      inputSchema: {
        type: "object",
        properties: {
          keys: {
            type: "array",
            description: "Optional list of configuration keys to retrieve.",
            items: { type: "string" },
          },
        },
      },
    },
    list_instructions: {
      description: "List operational instruction documents for the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Filter instructions by tag keyword.",
          },
        },
      },
    },
    submit_question: {
      description: "Store a follow-up question for maintainers to answer.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "Question Copilot wants a human to answer." },
          repo: { type: "string", description: "Optional repository context." },
          context: { description: "Additional JSON context to persist with the question." },
          metadata: { description: "Structured metadata to associate with the question." },
        },
        required: ["question"],
      },
    },
    list_questions: {
      description: "Retrieve existing questions submitted by Copilot.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Optional status filter." },
        },
      },
    },
    list_tasks: {
      description: "List manual and system-derived tasks for the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Optional manual task status filter." },
        },
      },
    },
    create_manual_task: {
      description: "Create a new manual task tracked inside the Copilot workspace.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          priority: { type: "integer" },
          dueAt: { type: "integer", description: "Due timestamp in milliseconds." },
          metadata: { description: "Additional JSON metadata." },
        },
        required: ["title"],
      },
    },
    update_task_status: {
      description: "Update the status of a manual task.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          status: { type: "string" },
          metadata: { description: "Optional metadata patch." },
        },
        required: ["taskId", "status"],
      },
    },
  };

  return tools.map((name) => ({
    name,
    description: definitions[name]?.description ?? "Custom MCP tool.",
    inputSchema: definitions[name]?.inputSchema ?? { type: "object" },
  }));
}

export async function createCopilotMcpSseResponse(db: D1Database): Promise<Response> {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sessionEvent = {
        type: "session",
        session: {
          id: crypto.randomUUID(),
          name: "github-copilot-mcp",
          version: "1.0.0",
          capabilities: {
            resources: true,
            tools: true,
          },
          timestamp: new Date().toISOString(),
        },
      };

      controller.enqueue(encodeSse(sessionEvent));

      const [configs, instructions] = await Promise.all([
        fetchCopilotConfigs(db),
        fetchCopilotInstructions(db),
      ]);

      const resourceEvent = {
        type: "resources",
        resources: [
          {
            uri: "copilot://configs",
            name: "GH Bot workspace configuration",
            description: "Key/value configuration entries for GitHub Copilot.",
            mimeType: "application/json",
            stats: { count: configs.length },
          },
          {
            uri: "copilot://instructions",
            name: "Operational instructions",
            description: "Instruction documents referenced during Copilot sessions.",
            mimeType: "application/json",
            stats: { count: instructions.length },
          },
          {
            uri: "copilot://tasks",
            name: "Task dashboard",
            description: "Manual and system-sourced tasks for the workspace.",
            mimeType: "application/json",
          },
          {
            uri: "copilot://questions/open",
            name: "Open Copilot questions",
            description: "Unresolved questions submitted by GitHub Copilot.",
            mimeType: "application/json",
          },
        ],
      };

      controller.enqueue(encodeSse(resourceEvent));

      const toolsEvent = {
        type: "tools",
        tools: listToolDefinitions(),
      };

      controller.enqueue(encodeSse(toolsEvent));

      const readyEvent = {
        type: "ready",
        message: "GitHub Copilot MCP workspace is ready.",
        stats: {
          configs: configs.length,
          instructions: instructions.length,
        },
        timestamp: new Date().toISOString(),
      };

      controller.enqueue(encodeSse(readyEvent));
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export async function handleCopilotResourceRequest(db: D1Database, uri: string): Promise<Record<string, unknown>> {
  switch (uri) {
    case "copilot://configs": {
      const configs = await fetchCopilotConfigs(db);
      return { uri, data: configs };
    }
    case "copilot://instructions": {
      const instructions = await fetchCopilotInstructions(db);
      return { uri, data: instructions };
    }
    case "copilot://tasks": {
      const tasks = await fetchCopilotTasks(db);
      return { uri, data: tasks };
    }
    case "copilot://questions/open": {
      const questions = await fetchCopilotQuestions(db, "open");
      return { uri, data: questions };
    }
    default:
      throw new Error(`Unsupported resource URI: ${uri}`);
  }
}

export async function handleCopilotToolInvocation(db: D1Database, invocation: CopilotToolInvocation) {
  if (!invocation || !invocation.tool) {
    throw new Error("Tool name is required.");
  }

  const args = invocation.arguments ?? {};

  switch (invocation.tool) {
    case "get_copilot_config": {
      const configs = await fetchCopilotConfigs(db, Array.isArray((args as any).keys) ? (args as any).keys : undefined);
      return {
        ok: true,
        tool: invocation.tool,
        result: { configs },
        timestamp: new Date().toISOString(),
      };
    }
    case "list_instructions": {
      const instructions = await fetchCopilotInstructions(db, Array.isArray((args as any).tags) ? (args as any).tags : undefined);
      return {
        ok: true,
        tool: invocation.tool,
        result: { instructions },
        timestamp: new Date().toISOString(),
      };
    }
    case "submit_question": {
      const question = (args as any).question as string | undefined;
      if (!question || !question.trim()) {
        throw new Error("question argument is required");
      }
      const record = await createCopilotQuestion(db, {
        question,
        repo: typeof (args as any).repo === "string" ? (args as any).repo : undefined,
        context: (args as any).context,
        metadata: (args as any).metadata,
      });
      return {
        ok: true,
        tool: invocation.tool,
        result: record,
        timestamp: new Date().toISOString(),
      };
    }
    case "list_questions": {
      const status = typeof (args as any).status === "string" ? (args as any).status : undefined;
      const questions = await fetchCopilotQuestions(db, status);
      return {
        ok: true,
        tool: invocation.tool,
        result: { questions },
        timestamp: new Date().toISOString(),
      };
    }
    case "list_tasks": {
      const status = typeof (args as any).status === "string" ? (args as any).status : undefined;
      const tasks = await fetchCopilotTasks(db, status);
      return {
        ok: true,
        tool: invocation.tool,
        result: { tasks },
        timestamp: new Date().toISOString(),
      };
    }
    case "create_manual_task": {
      const title = (args as any).title as string | undefined;
      if (!title || !title.trim()) {
        throw new Error("title argument is required");
      }
      const record = await createManualTask(db, {
        title,
        description: typeof (args as any).description === "string" ? (args as any).description : undefined,
        priority: typeof (args as any).priority === "number" ? (args as any).priority : undefined,
        dueAt: typeof (args as any).dueAt === "number" ? (args as any).dueAt : undefined,
        metadata: (args as any).metadata,
      });
      return {
        ok: true,
        tool: invocation.tool,
        result: record,
        timestamp: new Date().toISOString(),
      };
    }
    case "update_task_status": {
      const taskId = (args as any).taskId as string | undefined;
      const status = (args as any).status as string | undefined;
      if (!taskId || !status) {
        throw new Error("taskId and status arguments are required");
      }
      const record = await updateManualTaskStatus(db, {
        taskId,
        status,
        metadata: (args as any).metadata,
      });
      return {
        ok: true,
        tool: invocation.tool,
        result: record,
        timestamp: new Date().toISOString(),
      };
    }
    default:
      throw new Error(`Unsupported tool: ${invocation.tool}`);
  }
}
