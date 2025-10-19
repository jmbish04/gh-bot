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

		return await handleWebhook(c, { delivery, event, signature, body: bodyText });
	} catch (error) {
		const errStr = error instanceof Error ? error.message : String(error);
		console.error("[MAIN] Unhandled exception in webhook handler", { error: errStr });
		return c.json({ error: "Internal Server Error", message: errStr }, 500);
	}
});


export default app;