import { Hono, type Context } from "hono";
import { verify as verifySignature } from "@octokit/webhooks-methods";
// Durable Objects
import { PrWorkflow } from "./do_pr_workflows";
import { ProfileScanner } from "./do_profile_scanner";
import { ResearchOrchestrator } from "./do_research";
import { RepositorySetupCoordinator } from "./do_repo_setup";
import "./do_conflict_resolver";
// Import new Colby service modules
import { generateAgentAssets } from "./modules/agent_generator";
import { summarizeRepo } from "./modules/ai";
import { detectRepoBadges } from "./modules/badge_detector";
import { insertRepoIfNew, markRepoSynced } from "./modules/db";
import { generateInfrastructureGuidance } from "./modules/infra_guidance";
import { fetchRelevantLLMContent } from "./modules/llm_fetcher";
import {
	analyzeRepoCode,
	analyzeRepoCodeStructured,
} from "./modules/repo_analyzer";
import { AIRepoAnalyzer } from "./modules/ai_repo_analyzer";
import { UserPreferencesManager } from "./modules/user_preferences";
import { handleWebhook } from "./routes/webhook";
import { asyncGeneratorToStream } from "./stream";
import { parseColbyCommand } from "./modules/colby";
import { setupCommandStatusSocket } from "./modules/command_status_ws";
import {
	CopilotToolInvocation,
	createCopilotMcpSseResponse,
	handleCopilotResourceRequest,
	handleCopilotToolInvocation,
} from "./modules/github_copilot_mcp";
import {
	createLogger,
	debounceRepo,
	formatTimestamp,
	hasNoBotAgentsLabel,
	normalizeRepositoryTarget,
	type Logger,
	type RepositoryTarget,
} from "./util";
import {
	GitHubClient,
	ensureBranchExists,
	ensurePullRequestWithCommit,
	type CommitFile,
	getInstallationToken,
	listInstallations,
	listReposForInstallation,
	ghREST,
	getFileAtRef,
	GitHubHttpError,
} from "./github";
import { introspectRepository } from "./introspect";
import { renderAgentBundle } from "./policy";
import { mergeGeminiConfig, renderGeminiConfig, renderStyleguide } from "./gemini";
import { runDailyDiscovery, runTargetedResearch } from './agents/research_agent';
import RepositoryActor from './actors/RepositoryActor';
import PullRequestActor from './actors/PullRequestActor';
import ResearchActor from './actors/ResearchActor';
import { ConflictResolver } from './do_conflict_resolver'; // ConflictResolver might be needed based on the migration

/**
 * Runtime bindings available to this Worker.
 */
type Env = {
	DB: D1Database;
	GITHUB_APP_ID: string;
	GITHUB_PRIVATE_KEY: string;
	GITHUB_WEBHOOK_SECRET: string;
	GITHUB_TOKEN?: string;
	GITHUB_INSTALLATION_ID?: string;
	GITHUB_REPO_DEFAULT_BRANCH_FALLBACK?: string;
	CF_ACCOUNT_ID: string;
	CF_API_TOKEN: string;
	SUMMARY_CF_MODEL: string;
	FRONTEND_AUTH_PASSWORD: string;
	RESEARCH_ORCH?: DurableObjectNamespace;
	PR_WORKFLOWS: DurableObjectNamespace;
	PROFILE_SCANNER: DurableObjectNamespace; // Matches wrangler.toml binding name
	REPO_SETUP: DurableObjectNamespace;
	ASSETS: Fetcher; // Static assets binding
	AI: any; // Workers AI binding
	CONFLICT_RESOLVER: DurableObjectNamespace;
	Sandbox?: Fetcher;
	VECTORIZE_INDEX: VectorizeIndex;
	USER_PREFERENCES: KVNamespace; // User preferences KV storage
	AGENT_DEBOUNCE?: KVNamespace;
	REPO_MEMORY: KVNamespace;
	CF_BINDINGS_MCP_URL?: string;
	SEB: SendEmail; // Send Email Binding
};

type HonoContext = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();

// Global CORS headers for API responses
const CORS_HEADERS = {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const PR_FILE_ORDER = [
	"agent.md",
	"gemini.md",
	"cursor-agent.md",
	"copilot.md",
	".gemini/config.yaml",
	".gemini/styleguide.md",
];

function buildPrBody(actions: Map<string, string>): string {
	const header = "| File | Action |\n| --- | --- |";
	const rows = PR_FILE_ORDER.map((file) => `| ${file} | ${actions.get(file) ?? "unchanged"} |`).join("\n");
	return `${header}\n${rows}\n\n- Non-destructive merges preserved existing customizations.\n- Agent files synchronized and repo-aware.\n`;
}

function safeParseJson<T = unknown>(value: string, fallback: T = [] as unknown as T): T {
        try {
                return JSON.parse(value) as T;
        } catch (error) {
                console.warn("[MERGE OPS] Failed to parse JSON column", error);
                return fallback;
        }
}

type TaskAssetCollection = {
        screenshots: unknown[];
        content: unknown[];
        text: unknown[];
        json: unknown[];
        console: unknown[];
        websocket: unknown[];
        other: unknown[];
};

type TaskField = { label: string; value: unknown };

type TaskEntry = {
        eventType: string;
        repo: string | null;
        prNumber: number | null;
        deliveryId: string;
        action: string | null;
        author: string | null;
        receivedAt: string;
        status: string | null;
        title: string | null;
        fields: TaskField[];
        trimmedPayload: Record<string, unknown>;
        jsonSchema: Record<string, unknown>;
        assets: TaskAssetCollection;
};

type TaskGroup = {
        eventType: string;
        repo: string | null;
        prNumber: number | null;
        author: string | null;
        latestTimestamp: number | null;
        tasks: TaskEntry[];
};

type WebhookEventRow = {
        id: number;
        delivery_id: string;
        event_type: string;
        action: string | null;
        repo_full_name: string | null;
        author_login: string | null;
        associated_number: number | null;
        received_at: string;
        full_payload_json: string;
        response_status: string | null;
        response_message: string | null;
        processing_time_ms: number | null;
        error_details: string | null;
};

function formatFieldLabel(key: string): string {
        if (!key) return key;
        return key
                .replace(/_/g, " ")
                .replace(/([a-z])([A-Z])/g, "$1 $2")
                .replace(/\s+/g, " ")
                .trim()
                .replace(/^\w/, (c) => c.toUpperCase());
}

function inferJsonSchema(value: unknown, depth = 0): Record<string, unknown> {
        const MAX_DEPTH = 6;
        if (depth > MAX_DEPTH) {
                return { type: "unknown" };
        }
        if (value === null) {
                return { type: "null" };
        }
        const valueType = typeof value;
        if (valueType === "string" || valueType === "number" || valueType === "boolean") {
                return { type: valueType };
        }
        if (Array.isArray(value)) {
                if (value.length === 0) {
                        return { type: "array", items: { type: "unknown" } };
                }
                const schemas = value.map((item) => inferJsonSchema(item, depth + 1));
                const serialized = new Set(schemas.map((schema) => JSON.stringify(schema)));
                if (serialized.size === 1) {
                        return { type: "array", items: schemas[0] };
                }
                return { type: "array", items: { anyOf: schemas } };
        }
        if (value && valueType === "object") {
                const entries = Object.entries(value as Record<string, unknown>);
                const properties: Record<string, unknown> = {};
                const required: string[] = [];
                for (const [key, val] of entries) {
                        if (val === undefined) continue;
                        properties[key] = inferJsonSchema(val, depth + 1);
                        required.push(key);
                }
                return {
                        type: "object",
                        properties,
                        required,
                        additionalProperties: false,
                };
        }
        return { type: "unknown" };
}

function extractAssetsFromPayload(payload: unknown): TaskAssetCollection {
        const initial: TaskAssetCollection = {
                screenshots: [],
                content: [],
                text: [],
                json: [],
                console: [],
                websocket: [],
                other: [],
        };

        if (!payload || typeof payload !== "object") {
                return initial;
        }

        const visited = new WeakSet<object>();

        const pushAsset = (type: keyof TaskAssetCollection, value: unknown) => {
                if (value === undefined || value === null) return;
                initial[type].push(value);
        };

        const normalizedType = (raw: unknown): keyof TaskAssetCollection | null => {
                if (typeof raw !== "string") return null;
                const type = raw.toLowerCase();
                if (type.includes("screenshot")) return "screenshots";
                if (type.includes("content")) return "content";
                if (type.includes("text")) return "text";
                if (type.includes("json")) return "json";
                if (type.includes("console")) return "console";
                if (type.includes("ws") || type.includes("websocket")) return "websocket";
                return null;
        };

        const visit = (value: unknown) => {
                if (!value || typeof value !== "object") {
                        return;
                }
                if (visited.has(value as object)) {
                        return;
                }
                visited.add(value as object);

                if (Array.isArray(value)) {
                        for (const item of value) {
                                if (item && typeof item === "object") {
                                        visit(item);
                                } else {
                                        handleAssetCandidate(item);
                                }
                        }
                        return;
                }

                const obj = value as Record<string, unknown>;
                if (Array.isArray(obj.assets)) {
                        for (const asset of obj.assets as unknown[]) {
                                handleAssetCandidate(asset);
                        }
                }

                if (obj.metadata && typeof obj.metadata === "object") {
                        visit(obj.metadata);
                }

                for (const nested of Object.values(obj)) {
                        if (nested && typeof nested === "object") {
                                visit(nested);
                        } else if (nested !== undefined) {
                                handleAssetCandidate(nested);
                        }
                }
        };

        const handleAssetCandidate = (candidate: unknown) => {
                if (candidate === undefined || candidate === null) return;
                if (typeof candidate === "string") {
                        const lowered = candidate.toLowerCase();
                        if (lowered.startsWith("http") && lowered.includes("screenshot")) {
                                pushAsset("screenshots", candidate);
                                return;
                        }
                        pushAsset("text", candidate);
                        return;
                }
                if (typeof candidate !== "object") {
                        pushAsset("other", candidate);
                        return;
                }
                if (Array.isArray(candidate)) {
                        for (const value of candidate) {
                                handleAssetCandidate(value);
                        }
                        return;
                }

                const record = candidate as Record<string, unknown>;
                const type = normalizedType(record.type);
                const payloadValue = record.value ?? record.url ?? record.content ?? record.data ?? record.body ?? record.payload;
                if (type) {
                        pushAsset(type, payloadValue ?? record);
                } else if (record.console || record.consoleMessages) {
                        const messages = Array.isArray(record.console)
                                ? record.console
                                : record.consoleMessages;
                        if (Array.isArray(messages)) {
                                for (const message of messages) {
                                        pushAsset("console", message);
                                }
                        }
                } else if (record.logs && Array.isArray(record.logs)) {
                        for (const log of record.logs) {
                                pushAsset("console", log);
                        }
                } else if (record.websocket || record.ws) {
                        const wsEntries = Array.isArray(record.websocket)
                                ? record.websocket
                                : record.ws;
                        if (Array.isArray(wsEntries)) {
                                for (const entry of wsEntries) {
                                        pushAsset("websocket", entry);
                                }
                        }
                } else if (record.screenshot || record.screenshotUrl) {
                        pushAsset("screenshots", record.screenshot ?? record.screenshotUrl);
                } else if (record.json) {
                        pushAsset("json", record.json);
                } else {
                        initial.other.push(record);
                }

                for (const value of Object.values(record)) {
                        if (value && typeof value === "object") {
                                visit(value);
                        }
                }
        };

        handleAssetCandidate(payload);
        visit(payload);

        return initial;
}

function extractRelevantFields(eventType: string, payload: Record<string, unknown>): Record<string, unknown> {
        const repo = payload.repository as Record<string, unknown> | undefined;
        const pullRequest = payload.pull_request as Record<string, unknown> | undefined;
        const issue = payload.issue as Record<string, unknown> | undefined;
        const comment = payload.comment as Record<string, unknown> | undefined;
        const review = payload.review as Record<string, unknown> | undefined;
        const sender = payload.sender as Record<string, unknown> | undefined;

        switch (eventType) {
                case "pull_request": {
                        return {
                                title: pullRequest?.title,
                                state: pullRequest?.state,
                                number: pullRequest?.number,
                                author: pullRequest?.user && (pullRequest.user as Record<string, unknown>).login,
                                head: pullRequest?.head && (pullRequest.head as Record<string, unknown>).ref,
                                base: pullRequest?.base && (pullRequest.base as Record<string, unknown>).ref,
                                merged: pullRequest?.merged,
                                html_url: pullRequest?.html_url,
                        };
                }
                case "pull_request_review": {
                        return {
                                state: review?.state,
                                submitted_at: review?.submitted_at,
                                reviewer: review?.user && (review.user as Record<string, unknown>).login,
                                body: review?.body,
                                pr_number: pullRequest?.number,
                                pr_title: pullRequest?.title,
                        };
                }
                case "pull_request_review_comment": {
                        return {
                                path: comment?.path,
                                diff_hunk: comment?.diff_hunk,
                                body: comment?.body,
                                commenter: comment?.user && (comment.user as Record<string, unknown>).login,
                                pr_number: pullRequest?.number,
                                in_reply_to_id: comment?.in_reply_to_id,
                        };
                }
                case "issue_comment": {
                        return {
                                issue_number: issue?.number,
                                issue_title: issue?.title,
                                commenter: comment?.user && (comment.user as Record<string, unknown>).login,
                                body: comment?.body,
                                created_at: comment?.created_at,
                        };
                }
                case "issues": {
                        return {
                                number: issue?.number,
                                title: issue?.title,
                                state: issue?.state,
                                author: issue?.user && (issue.user as Record<string, unknown>).login,
                                labels: issue?.labels,
                                created_at: issue?.created_at,
                        };
                }
                default: {
                        return {
                                action: payload.action,
                                repository: repo?.full_name,
                                author: sender?.login,
                                number: pullRequest?.number ?? issue?.number ?? payload.number,
                                title: pullRequest?.title ?? issue?.title ?? payload.subject,
                        } as Record<string, unknown>;
                }
        }
}

function convertFieldsToList(record: Record<string, unknown>): TaskField[] {
        return Object.entries(record).map(([key, value]) => ({ label: formatFieldLabel(key), value }));
}

function transformWebhookRow(row: WebhookEventRow): TaskEntry {
        const payload = safeParseJson<Record<string, unknown>>(row.full_payload_json, {});
        const trimmed = extractRelevantFields(row.event_type, payload);
        const fields = convertFieldsToList(trimmed);
        const schema = inferJsonSchema(trimmed);
        const assets = extractAssetsFromPayload(payload);

        let inferredTitle: string | null = null;
        if (typeof trimmed.title === "string" && trimmed.title.trim().length) {
                inferredTitle = trimmed.title as string;
        } else if (typeof trimmed.pr_title === "string") {
                inferredTitle = trimmed.pr_title as string;
        } else if (typeof trimmed.issue_title === "string") {
                inferredTitle = trimmed.issue_title as string;
        }

        return {
                eventType: row.event_type,
                repo: row.repo_full_name ?? null,
                prNumber: row.associated_number ?? null,
                deliveryId: row.delivery_id,
                action: row.action ?? null,
                author: row.author_login ?? null,
                receivedAt: row.received_at,
                status: row.response_status ?? row.response_message ?? null,
                title: inferredTitle,
                fields,
                trimmedPayload: trimmed,
                jsonSchema: schema,
                assets,
        };
}

function groupWebhookEvents(rows: WebhookEventRow[]): TaskGroup[] {
        const map = new Map<string, TaskGroup>();

        for (const row of rows) {
                const task = transformWebhookRow(row);
                const key = `${task.eventType}::${task.repo ?? "unknown"}::${task.prNumber ?? "none"}`;
                let group = map.get(key);
                if (!group) {
                        group = {
                                eventType: task.eventType,
                                repo: task.repo,
                                prNumber: task.prNumber,
                                author: task.author,
                                latestTimestamp: task.receivedAt ? Date.parse(task.receivedAt) : null,
                                tasks: [],
                        };
                        map.set(key, group);
                }
                group.tasks.push(task);
                if (task.author) {
                        group.author = task.author;
                }
                if (task.receivedAt) {
                        const ts = Date.parse(task.receivedAt);
                        if (!Number.isNaN(ts)) {
                                if (!group.latestTimestamp || ts > group.latestTimestamp) {
                                        group.latestTimestamp = ts;
                                }
                        }
                }
        }

        const groups = Array.from(map.values());
        for (const group of groups) {
                group.tasks.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
        }
        groups.sort((a, b) => (b.latestTimestamp ?? 0) - (a.latestTimestamp ?? 0));
        return groups;
}

async function handleRepoStandardization(
	env: Env,
	target: RepositoryTarget,
	logger: Logger,
	skipByLabel: boolean
): Promise<void> {
	try {
		if (skipByLabel) {
			logger.info("Skipping agent standardization due to no-bot-agents label");
			return;
		}

		const proceed = await debounceRepo(env.AGENT_DEBOUNCE, target, 30, logger);
		if (!proceed) {
			return;
		}

		const client = new GitHubClient({ env, logger });
		const fallbackBranch = env.GITHUB_REPO_DEFAULT_BRANCH_FALLBACK ?? "main";
		const defaultBranch = await client.getDefaultBranch(target, fallbackBranch);
		const existingPr = await client.findOpenStandardizationPr(target);
		const comparisonRef = existingPr?.head.ref ?? defaultBranch;

		const summary = await introspectRepository(env, target, defaultBranch, { githubClient: client, logger });
		if (summary.hasOptOutFile || summary.optOut) {
			logger.info("Skipping agent standardization due to opt-out signal", {
				hasOptOutFile: summary.hasOptOutFile,
				optOut: summary.optOut,
			});
			return;
		}

		const actions = new Map<string, string>();
		for (const file of PR_FILE_ORDER) {
			actions.set(file, "unchanged");
		}

		const bundle = renderAgentBundle(summary);
		const commitFiles: CommitFile[] = [];

		for (const [path, content] of bundle) {
			const baseName = path.split("/").pop() ?? path;
			const existingFile = await client.getFile(target, path, comparisonRef);
			if (!existingFile) {
				commitFiles.push({ path, content });
				actions.set(baseName, "add");
			} else if (existingFile.content !== content) {
				commitFiles.push({ path, content });
				actions.set(baseName, "update");
			}
		}

		const generatedConfig = renderGeminiConfig(summary);
		const existingConfig = await client.getFile(target, ".gemini/config.yaml", comparisonRef);
		const mergedConfig = mergeGeminiConfig(existingConfig?.content, generatedConfig);
		if (!existingConfig) {
			commitFiles.push({ path: ".gemini/config.yaml", content: mergedConfig });
			actions.set(".gemini/config.yaml", "add");
		} else if (existingConfig.content !== mergedConfig) {
			commitFiles.push({ path: ".gemini/config.yaml", content: mergedConfig });
			actions.set(".gemini/config.yaml", "update (merge)");
		}

		const existingStyleguide = await client.getFile(target, ".gemini/styleguide.md", comparisonRef);
		const renderedStyleguide = renderStyleguide(summary, existingStyleguide?.content ?? null);
		if (!existingStyleguide) {
			commitFiles.push({ path: ".gemini/styleguide.md", content: renderedStyleguide });
			actions.set(".gemini/styleguide.md", "add");
		} else if (existingStyleguide.content !== renderedStyleguide) {
			commitFiles.push({ path: ".gemini/styleguide.md", content: renderedStyleguide });
			actions.set(".gemini/styleguide.md", "update");
		}

		if (commitFiles.length === 0) {
			logger.info("Repository already compliant with agent and Gemini policies");
			return;
		}

		let branchName = existingPr?.head.ref;
		if (!branchName) {
			const baseSha = await client.getBranchSha(target, defaultBranch);
			branchName = `auto/standardize-agents-${baseSha.slice(0, 7)}-${formatTimestamp()}`;
			await ensureBranchExists(client, target, branchName, defaultBranch, logger);
		}

		const prBody = buildPrBody(actions);

		await ensurePullRequestWithCommit({
			client,
			target,
			baseBranch: defaultBranch,
			branch: branchName,
			commitMessage: "chore(agents): sync agent instruction files",
			files: commitFiles,
			logger,
			prBody,
			existingPr,
		});

		logger.info("Standardization PR ensured", {
			branch: branchName,
			files: commitFiles.length,
			comparisonRef,
		});
	} catch (error) {
		logger.error("Failed to standardize agent assets", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

// Apply CORS headers to all responses, but preserve existing content-type
app.use("*", async (c, next) => {
	await next();
	for (const [k, v] of Object.entries(CORS_HEADERS)) {
		c.res.headers.set(k, v);
	}
	// Only set JSON content-type if no content-type is already set
	if (!c.res.headers.get("Content-Type")) {
		c.res.headers.set("Content-Type", "application/json");
	}
});

// Handle preflight requests
app.options("*", () => new Response(null, {
	headers: {
		...CORS_HEADERS,
		"Content-Type": "application/json"
	}
}));

/**
 * GET /ws
 * WebSocket endpoint for unified Colby command status updates.
 */
app.get("/ws", (c: HonoContext) => {
		if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
				return new Response("Expected WebSocket", { status: 400 });
		}
		const pair = new WebSocketPair();
		const { 0: client, 1: server } = pair;
		setupCommandStatusSocket(server);
		return new Response(null, { status: 101, webSocket: client });
});

/**
 * GET /health
 * Lightweight liveness probe for uptime checks & CI smoke tests.
 */
app.get("/health", (c: HonoContext) => c.json({ ok: true }));

/**
 * GET /api/health
 */
app.get("/api/health", (c: HonoContext) =>
	c.json({ status: "healthy", timestamp: new Date().toISOString() })
);

/**
 * GET /api/stats
 */
app.get("/api/stats", (c: HonoContext) =>
	c.json({
		projects: 8,
		commands: 117,
		practices: 12,
		analyses: 4,
		operations: 3,
		repositories: 8,
	})
);

/**
 * GET /api/research/status
 */
app.get("/api/research/status", async (c: HonoContext) => {
	if (!c.env.RESEARCH_ORCH) {
		return c.json(
			{
				status: "error",
				progress: 0,
				current_operation:
					"Research orchestrator unavailable",
			},
			500,
		);
	}
	try {
		const stub = c.env.RESEARCH_ORCH.get(
			c.env.RESEARCH_ORCH.idFromName("global"),
		);
		const res = await stub.fetch("https://do/status");
		if (!res.ok) {
			return c.json(
				{
					status: "error",
					progress: 0,
					current_operation: `${res.status} ${res.statusText}`,
				},
				res.status,
			);
		}
		const data = await res.json();
		return c.json({
			status: data.status || "idle",
			progress: data.progress ?? 0,
			current_operation: data.current_operation || "",
		});
	} catch (err) {
		const errStr = err instanceof Error ? err.message : String(err);
		console.error(`[GET /api/research/status] Failed to fetch status: ${errStr}`);
		return c.json(
			{
				status: "error",
				progress: 0,
				current_operation: "Failed to fetch status",
			},
			500,
		);
	}
});

/**
 * GET /api/operations
 */
app.get("/api/operations", (c: HonoContext) =>
	c.json({
		operations: [
			{ id: 1, name: "Repository sync", status: "completed" },
			{ id: 2, name: "Pull request scan", status: "running" },
			{ id: 3, name: "Daily cleanup", status: "queued" },
		],
	})
);

/**
 * GET /api/recent-activity
 */
app.get("/api/recent-activity", (c: HonoContext) =>
        c.json({
                activity: [
                        {
                                id: 1,
				type: "repo",
				description: "Analyzed cloudflare/workers-sdk",
				timestamp: new Date().toISOString(),
			},
			{
				id: 2,
				type: "command",
				description: "Executed /summarize in repo-a",
				timestamp: new Date().toISOString(),
			},
		],
        })
);

/**
 * GET /api/task-groups
 */
app.get("/api/task-groups", async (c: HonoContext) => {
        const limitParam = c.req.query("limit");
        const parsedLimit = Number(limitParam ?? "200");
        const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 200;

        try {
                const result = await c.env.DB.prepare(
                        `SELECT id, delivery_id, event_type, action, repo_full_name, author_login, associated_number, received_at, full_payload_json, response_status, response_message, processing_time_ms, error_details
                         FROM github_webhook_events
                         ORDER BY datetime(received_at) DESC
                         LIMIT ?`
                )
                        .bind(limit)
                        .all<WebhookEventRow>();

                const rows = (result.results ?? []) as WebhookEventRow[];
                const groups = groupWebhookEvents(rows);
                return c.json({ groups });
        } catch (error) {
                const message = error instanceof Error ? error.message : "Unknown error";
                if (message.toLowerCase().includes("no such table")) {
                        console.warn("[GET /api/task-groups] github_webhook_events table missing, returning empty result");
                        return c.json({ groups: [] });
                }
                console.error("[GET /api/task-groups] Failed to load task groups", error);
                return c.json({ groups: [], error: message }, 500);
        }
});

/**
 * GET /demo/stream
 */
app.get("/demo/stream", (_c: HonoContext) => {
        async function* run() {
                yield "starting…";
		await new Promise((r) => setTimeout(r, 300));
		yield "working…";
		await new Promise((r) => setTimeout(r, 300));
		yield "done.";
	}
	return new Response(asyncGeneratorToStream(run()), {
		headers: { "Content-Type": "text/event-stream" },
	});
});

/**
 * GET /mcp/github-copilot/sse
 */
app.get("/mcp/github-copilot/sse", async (c: HonoContext) => {
	return await createCopilotMcpSseResponse(c.env.DB);
});

/**
 * GET /mcp/github-copilot/resource?uri=...
 */
app.get("/mcp/github-copilot/resource", async (c: HonoContext) => {
	const uri = c.req.query("uri");
	if (!uri) {
		return c.json({ error: "uri query parameter required" }, 400);
	}
	try {
		const payload = await handleCopilotResourceRequest(c.env.DB, uri);
		return c.json(payload);
	} catch (error) {
		console.error("[MCP] Failed to fetch resource", { uri, error });
		const message = error instanceof Error ? error.message : "Unknown error";
		return c.json({ error: message }, 500);
	}
});

/**
 * POST /mcp/github-copilot/tool
 */
app.post("/mcp/github-copilot/tool", async (c: HonoContext) => {
	try {
		const body = (await c.req.json()) as CopilotToolInvocation;
		const result = await handleCopilotToolInvocation(c.env.DB, body);
		return c.json(result);
	} catch (error) {
		console.error("[MCP] Tool invocation failed", error);
		const message = error instanceof Error ? error.message : "Unknown error";
		return c.json({ error: message }, 500);
	}
});

/**
 * POST /manual/trigger-llms-docs
 */
app.post("/manual/trigger-llms-docs", async (c: HonoContext) => {
	try {
		const body = await c.req.json();
		const repo = body.repo;
		const installationId = body.installationId;

		if (!repo) {
			return c.json({ error: "repo parameter required" }, 400);
		}

		let repoData = await c.env.DB.prepare(
			'SELECT installation_id FROM repos WHERE full_name = ?'
		).bind(repo).first();

		let finalInstallationId: number;

		if (!repoData) {
			if (installationId) {
				finalInstallationId = installationId;
				console.log(`[MANUAL] Using provided installation ID ${installationId} for ${repo}`);
			} else {
				const installations = await c.env.DB.prepare(
					'SELECT installation_id FROM repos LIMIT 1'
				).first();

				if (installations) {
					finalInstallationId = installations.installation_id as number;
					console.log(`[MANUAL] Using fallback installation ID ${finalInstallationId} for ${repo}`);
				} else {
					return c.json({
						success: false,
						message: `Repository ${repo} not found in database and no installations available. Please provide installationId or ensure repository sync has run.`
					}, 404);
				}
			}
		} else {
			finalInstallationId = repoData.installation_id as number;
		}

		const syntheticEvent = {
			kind: 'manual_trigger',
			delivery: `manual-${Date.now()}`,
			repo: repo,
			author: 'manual-trigger',
			installationId: finalInstallationId
		};

		const doId = c.env.PR_WORKFLOWS.idFromName(`repo-${repo}`);
		const stub = c.env.PR_WORKFLOWS.get(doId);

		const res = await stub.fetch('https://do/create-llms-docs', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(syntheticEvent)
		});

		if (res.ok) {
			return c.json({
				success: true,
				message: `LLMs documentation creation triggered for ${repo} (using installation ID: ${finalInstallationId})`,
				status: res.status
			});
		} else {
			const errorText = await res.text();
			return c.json({
				success: false,
				message: `Failed to trigger LLMs docs: ${errorText}`,
				status: res.status
			}, 500);
		}
	} catch (error: any) {
		console.error('[MANUAL] Error triggering LLMs docs:', error);
		return c.json({
			success: false,
			message: `Error: ${error instanceof Error ? error.message : String(error)}`
		}, 500);
	}
});

/**
 * POST /manual/setup-github-key
 */
app.post("/manual/setup-github-key", async (c: HonoContext) => {
	try {
		const body = await c.req.json();
		const { privateKey, appId } = body;

		if (!privateKey) {
			return c.json({ error: "privateKey parameter required" }, 400);
		}
		
		const existingKey = await c.env.DB.prepare(
			'SELECT value FROM system_config WHERE key = ?'
		).bind('github_app_private_key').first();

		const existingAppId = await c.env.DB.prepare(
			'SELECT value FROM system_config WHERE key = ?'
		).bind('github_app_id').first();

		let message = "GitHub App configuration updated successfully";

		if (existingKey && existingAppId) {
			message = "GitHub App configuration updated (replaced existing credentials)";
		} else if (existingKey || existingAppId) {
			message = "GitHub App configuration completed (some credentials were missing)";
		} else {
			message = "GitHub App configuration set up successfully";
		}

		await c.env.DB.prepare(
			'INSERT OR REPLACE INTO system_config (key, value, description, updated_at) VALUES (?, ?, ?, ?)'
		).bind(
			'github_app_private_key',
			privateKey,
			'GitHub App private key for token generation (supports multiple organizations)',
			Date.now()
		).run();

		await c.env.DB.prepare(
			'INSERT OR REPLACE INTO system_config (key, value, description, updated_at) VALUES (?, ?, ?, ?)'
		).bind(
			'github_app_id',
			appId,
			'GitHub App ID for API calls (supports multiple organizations)',
			Date.now()
		).run();

		return c.json({
			success: true,
			message: message,
			appId: appId,
			keyConfigured: true,
			supportsMultipleOrgs: true
		});

	} catch (error: any) {
		console.error('[SETUP-KEY] Error:', error);
		return c.json({
			success: false,
			message: `Error: ${error instanceof Error ? error.message : String(error)}`
		}, 500);
	}
});

/**
 * POST /manual/test-github-token
 */
app.post("/manual/test-github-token", async (c: HonoContext) => {
	try {
		const body = await c.req.json();
		const { installationId } = body;

		if (!installationId) {
			return c.json({ error: "installationId parameter required" }, 400);
		}

		try {
			const token = await c.env.DB.prepare(
				'SELECT value FROM system_config WHERE key = ?'
			).bind('github_app_private_key').first();

			if (!token) {
				return c.json({
					success: false,
					message: "GitHub App private key not found in system config. Use /manual/setup-github-key to configure it.",
					tokenAvailable: false
				});
			}

			return c.json({
				success: true,
				message: `GitHub token generation setup found for installation ${installationId}`,
				tokenAvailable: true,
				installationId: installationId
			});

		} catch (tokenError: any) {
			return c.json({
				success: false,
				message: `Token generation failed: ${tokenError.message}`,
				tokenAvailable: false
			});
		}

	} catch (error: any) {
		console.error('[TEST-TOKEN] Error:', error);
		return c.json({
			success: false,
			message: `Error: ${error instanceof Error ? error.message : String(error)}`
		}, 500);
	}
});

/**
 * GET /manual/check-status/:repo
 */
app.get("/manual/check-status/:repo", async (c: HonoContext) => {
	try {
		const repo = c.req.param('repo');
		if (!repo) {
			return c.json({ error: "repo parameter required" }, 400);
		}

		const repoData = await c.env.DB.prepare(
			'SELECT * FROM repos WHERE full_name = ?'
		).bind(repo).first();

		const operations = await c.env.DB.prepare(
			'SELECT * FROM colby_commands WHERE repo = ? ORDER BY created_at DESC LIMIT 5'
		).bind(repo).all();

		let llmsStatus = 'unknown';
		try {
			const [owner, repoName] = repo.split('/');
			llmsStatus = 'check manually - files should be in .agents/llms/ directory';
		} catch (error) {
			llmsStatus = 'error checking';
		}

		return c.json({
			repo: repo,
			inDatabase: !!repoData,
			repoData: repoData || null,
			recentOperations: operations.results || [],
			llmsStatus: llmsStatus,
			timestamp: new Date().toISOString()
		});

	} catch (error: any) {
		console.error('[STATUS] Error checking repo status:', error);
		return c.json({
			error: `Error: ${error instanceof Error ? error.message : String(error)}`,
			timestamp: new Date().toISOString()
		}, 500);
	}
});

/**
 * POST /manual/add-repo
 */
app.post("/manual/add-repo", async (c: HonoContext) => {
	try {
		const body = await c.req.json();
		const { repo, installationId } = body;

		if (!repo) {
			return c.json({ error: "repo parameter required" }, 400);
		}

		if (!installationId) {
			return c.json({ error: "installationId parameter required" }, 400);
		}

		const [owner, repoName] = repo.split('/');
		if (!owner || !repoName) {
			return c.json({ error: "invalid repo format, should be owner/repo" }, 400);
		}

		const existing = await c.env.DB.prepare(
			'SELECT * FROM repos WHERE full_name = ?'
		).bind(repo).first();

		if (existing) {
			return c.json({
				success: false,
				message: `Repository ${repo} already exists in database`,
				data: existing
			});
		}

		const result = await c.env.DB.prepare(
			'INSERT INTO repos (id, full_name, installation_id, default_branch, visibility, description, topics, last_synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
		).bind(
			Date.now(), // Use timestamp as ID for manual entries
			repo,
			installationId,
			'main', // Assume main branch
			'public', // Assume public for now
			'Manually added repository',
			'[]', // Empty topics array
			Date.now()
		).run();

		if (result.success) {
			return c.json({
				success: true,
				message: `Repository ${repo} added to database with installation ID ${installationId}`,
				data: {
					full_name: repo,
					installation_id: installationId
				}
			});
		} else {
			return c.json({
				success: false,
				message: `Failed to add repository ${repo} to database`
			}, 500);
		}

	} catch (error: any) {
		console.error('[ADD-REPO] Error adding repository:', error);
		return c.json({
			success: false,
			message: `Error: ${error instanceof Error ? error.message : String(error)}`
		}, 500);
	}
});

/**
 * POST /manual/trigger-optimize
 */
app.post("/manual/trigger-optimize", async (c: HonoContext) => {
	try {
		const body = await c.req.json();
		const repo = body.repo;
		const installationId = body.installationId;

		if (!repo) {
			return c.json({ error: "repo parameter required" }, 400);
		}

		let repoData = await c.env.DB.prepare(
			'SELECT installation_id FROM repos WHERE full_name = ?'
		).bind(repo).first();

		let finalInstallationId: number;

		if (!repoData) {
			if (installationId) {
				finalInstallationId = installationId;
				console.log(`[MANUAL] Using provided installation ID ${installationId} for ${repo}`);
			} else {
				const installations = await c.env.DB.prepare(
					'SELECT installation_id FROM repos LIMIT 1'
				).first();

				if (installations) {
					finalInstallationId = installations.installation_id as number;
					console.log(`[MANUAL] Using fallback installation ID ${finalInstallationId} for ${repo}`);
				} else {
					return c.json({
						success: false,
						message: `Repository ${repo} not found in database and no installations available. Please provide installationId or ensure repository sync has run.`
					}, 404);
				}
			}
		} else {
			finalInstallationId = repoData.installation_id as number;
		}

		const syntheticEvent = {
			kind: 'manual_trigger',
			delivery: `manual-${Date.now()}`,
			repo: repo,
			author: 'manual-trigger',
			installationId: finalInstallationId
		};

		const doId = c.env.PR_WORKFLOWS.idFromName(`repo-${repo}`);
		const stub = c.env.PR_WORKFLOWS.get(doId);

		const res = await stub.fetch('https://do/optimize-worker', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(syntheticEvent)
		});

		if (res.ok) {
			return c.json({
				success: true,
				message: `Worker optimization triggered for ${repo} (using installation ID: ${finalInstallationId})`,
				status: res.status
			});
		} else {
			const errorText = await res.text();
			return c.json({
				success: false,
				message: `Failed to trigger optimization: ${errorText}`,
				status: res.status
			}, 500);
		}
	} catch (error: any) {
		console.error('[MANUAL] Error triggering optimization:', error);
		return c.json({
			success: false,
			message: `Error: ${error instanceof Error ? error.message : String(error)}`
		}, 500);
	}
});

app.get("/api/merge-operations/status/:operationId", async (c: HonoContext) => {
	const operationId = c.req.param("operationId");
	if (!operationId) {
		return c.json({ error: "operationId is required" }, 400);
	}

	const row = await c.env.DB.prepare(
		`SELECT repo_owner, repo, pr_number, status
		 FROM merge_operations
		 WHERE id = ?`
	).bind(operationId).first();

	if (!row) {
		return c.json({ error: "Operation not found" }, 404);
	}

	try {
		const resolverId = c.env.CONFLICT_RESOLVER.idFromName(`${row.repo_owner}/${row.repo}/${row.pr_number}`);
		const resolver = c.env.CONFLICT_RESOLVER.get(resolverId);
		const response = await resolver.fetch("https://conflict-resolver/status");
		const state = response.ok ? await response.json() : { status: row.status };

		return c.json({ operationId, state, status: row.status });
	} catch (error) {
		console.error("[MERGE STATUS] Failed to fetch DO status", error);
		return c.json({
			operationId,
			status: row.status,
			error: error instanceof Error ? error.message : String(error),
		}, 502);
	}
});

app.get("/api/merge-operations/:operationId", async (c: HonoContext) => {
	const operationId = c.req.param("operationId");
	if (!operationId) {
		return c.json({ error: "operationId is required" }, 400);
	}

	const row = await c.env.DB.prepare(
		`SELECT * FROM merge_operations WHERE id = ?`
	).bind(operationId).first();

	if (!row) {
		return c.json({ error: "Operation not found" }, 404);
	}

	const aiAnalysis = row.ai_analysis ? safeParseJson(row.ai_analysis) : [];
	const conflictFiles = row.conflict_files ? safeParseJson(row.conflict_files) : [];

	return c.json({
		operation: {
			...row,
			ai_analysis: aiAnalysis,
			conflict_files: conflictFiles,
		},
	});
});

app.post("/github/webhook", async (c: HonoContext) => {
	console.log("[MAIN] Webhook request received", {
		method: c.req.method,
		url: c.req.url,
		userAgent: c.req.header("user-agent"),
		contentType: c.req.header("content-type"),
		contentLength: c.req.header("content-length"),
		timestamp: new Date().toISOString(),
	});

	try {
		console.log("[MAIN] Reading request headers...");
		const delivery = c.req.header("x-github-delivery") || "";
		const event = c.req.header("x-github-event") || "";
		const signature = c.req.header("x-hub-signature-256") || "";

		console.log("[MAIN] Headers extracted:", {
			delivery: delivery.substring(0, 8) + "...",
			event,
			hasSignature: !!signature,
		});

		console.log("[MAIN] Reading request body...");
		const bodyText = await c.req.text();
		console.log("[MAIN] Body read successfully, length:", bodyText.length);

		const webhookData = {
		  delivery,
		  event,
		  signature,
		  bodyText: bodyText, // The raw body text
		  headers: c.req.header() // Pass all headers as a plain object
		};

	// Pass the structured data object and the environment, not the full context
	return await handleWebhook(webhookData, c.env);
		
	} catch (error) {
		const errStr = error instanceof Error ? error.message : String(error);
		console.error("[MAIN] Unhandled exception in webhook handler", { error: errStr });
		return c.json({ error: "Internal Server Error", message: errStr }, 500);
	}
});

// Export the Durable Objects
export { RepositoryActor, PullRequestActor, ResearchActor, ConflictResolver };


// The default export remains your Hono app or scheduled handler
export default {
  fetch: app.fetch,
  // Make sure your scheduled handler is also exported if needed
  // scheduled: async (controller, env, ctx) => { ... }
};
