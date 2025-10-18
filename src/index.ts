/// <reference types="@cloudflare/workers-types" />
/**
 * GH Bot Worker — Orchestrator & API
 * -----------------------------------
 * PURPOSE
 * - Receives GitHub webhooks (PR reviews, comments, labels, etc.) and serializes PR work via a Durable Object.
 * - Discovers & indexes repos from your GitHub App installation(s).
 * - Runs AI-assisted repository analysis (light summary + deep structured analysis) and stores results in D1.
 * - Exposes HTTP endpoints for health, streaming demo, research orchestration, status, results, and manual analyses.
 *
 * ARCHITECTURE (high-level)
 * - Hono app (this file) wires routes to:
 * • Webhook router: POST /github/webhook  → forwards to PR Durable Object (PR_WORKFLOWS).
 * • Research DO: POST /research/run, GET /research/status → fan-out repo search & AI summarization.
 * • Query endpoints: GET /research/results, /research/analysis, /research/structured, /research/risks.
 * • Manual triggers: POST /research/analyze, /research/analyze-structured.
 * - Durable Objects:
 * • ResearchOrchestrator: searches repos, dedupes, ranks, enqueues profiles, runs summarizers.
 * • PrWorkflow: serializes per-PR actions (apply suggestions, summarize, etc.).
 * • ProfileScanner: crawls developer profiles/orgs and summarizes.
 * - D1 Database:
 * • tables: projects, repo_analysis, repo_analysis_bindings, gh_events, etc. (see migrations).
 *
 * SECURITY
 * - Webhook signature is verified (HMAC SHA256) using GITHUB_WEBHOOK_SECRET.
 * - GitHub API calls use installation tokens minted from GITHUB_APP_ID + GITHUB_PRIVATE_KEY.
 * - Never echo secrets; prefer ctx.waitUntil for background tasks.
 *
 * PERFORMANCE/RELIABILITY
 * - Use Durable Objects for single-flight per-PR/per-owner/per-research-run.
 * - Bulk checks & UPSERTs to avoid N+1 round trips.
 * - Time-bound AI prompts and cap sampled bytes.
 *
 * AI USAGE
 * - Summaries can use env.AI.run() if AI binding is present; otherwise fallback to REST.
 * - Prompts require ENGLISH-ONLY outputs and structured JSON for machine-readability.
 *
 * ROUTE QUICK REFERENCE
 * GET  /health                       -> { ok: true }
 * GET  /demo/stream                  -> simple server-sent stream demo (dev utility)
 * POST /github/webhook               -> verify sig; route PR events to PR DO
 * POST /research/run                 -> kick off research sweep via ResearchOrchestrator DO
 * GET  /research/status              -> status of last research run
 * GET  /research/results             -> top repos (score + AI summaries)
 * GET  /research/analysis?repo=...   -> raw analysis row for a repo
 * GET  /research/risks               -> repos with flagged risks
 * POST /research/analyze             -> on-demand lightweight analysis
 * GET  /research/structured          -> filterable structured analysis (kind/binding/confidence)
 * POST /research/analyze-structured  -> on-demand structured analysis
 */

import { type Context, Hono } from "hono";
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
 * NOTE: Add the corresponding sections in wrangler.toml:
 * - D1 binding: [[d1_databases]] binding = "DB"
 * - Durable Objects: [durable_objects] bindings = [...]
 * - (Optional) AI binding: [ai] binding = "AI"
 * - (Optional) R2 binding: [[r2_buckets]] binding = "R2"
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
 * Returns 200 with { ok: true } if the worker is reachable.
 */
app.get("/health", (c: HonoContext) => c.json({ ok: true }));

/**
 * GET /api/health
 * Dashboard JSON health check
 */
app.get("/api/health", (c: HonoContext) =>
	c.json({ status: "healthy", timestamp: new Date().toISOString() })
);

/**
 * GET /api/stats
 * Returns dashboard statistics (mocked)
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
 * JSON research operation status
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
 * Returns list of operations (mocked)
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
 * Returns recent activity (mocked)
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
 * Example of streaming a Server-Sent Event-like response from an async generator.
 * Useful to verify your streaming utilities (see ./stream) behave as expected.
 * NOT used by webhook/PR flows; safe to remove in production.
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
 * Model Context Protocol SSE endpoint used by GitHub Copilot tools.
 */
app.get("/mcp/github-copilot/sse", async (c: HonoContext) => {
    return await createCopilotMcpSseResponse(c.env.DB);
});

/**
 * GET /mcp/github-copilot/resource?uri=...
 * Retrieves MCP resource payloads (configs, instructions, tasks, questions).
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
 * Invokes MCP tool handlers for GitHub Copilot.
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
 * POST /github/webhook
 * GitHub → Worker entrypoint. Verifies HMAC signature, parses payload type,
 * and forwards the event to the PR Durable Object (PR_WORKFLOWS).
 *
 * WHY a Durable Object?
 * - Guarantees serialized processing per PR (no race conditions between comments/reviews).
 * - Centralizes commit creation, AI actions, and retries.
 *
 * Implementation detail:
 * - Full router/verification logic is encapsulated in routes/webhook.ts (handleWebhook).
 * - Keep this thin to simplify testing and future route changes.
 */
/**
 * POST /manual/trigger-llms-docs
 * Manual trigger for LLMs documentation creation for a specific repository
 */
app.post("/manual/trigger-llms-docs", async (c: HonoContext) => {
    try {
        const body = await c.req.json();
        const repo = body.repo;
        const installationId = body.installationId;

        if (!repo) {
            return c.json({ error: "repo parameter required" }, 400);
        }

        // First try to look up the repository in the database
        let repoData = await c.env.DB.prepare(
            'SELECT installation_id FROM repos WHERE full_name = ?'
        ).bind(repo).first();

        let finalInstallationId: number;

        if (!repoData) {
            // Repository not in database, try to use provided installationId or default
            if (installationId) {
                finalInstallationId = installationId;
                console.log(`[MANUAL] Using provided installation ID ${installationId} for ${repo}`);
            } else {
                // Try to get the first available installation (assuming org-wide access)
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

        // Create synthetic event for LLMs docs creation
        const syntheticEvent = {
            kind: 'manual_trigger',
            delivery: `manual-${Date.now()}`,
            repo: repo,
            author: 'manual-trigger',
            installationId: finalInstallationId
        };

        // Get the PR_WORKFLOWS durable object
        const doId = c.env.PR_WORKFLOWS.idFromName(`repo-${repo}`);
        const stub = c.env.PR_WORKFLOWS.get(doId);

        // Trigger LLMs documentation creation
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
 * Set up the GitHub App private key in system configuration
 */
app.post("/manual/setup-github-key", async (c: HonoContext) => {
    try {
        const body = await c.req.json();
        const { privateKey, appId } = body;

        if (!privateKey) {
            return c.json({ error: "privateKey parameter required" }, 400);
        }

        if (!appId) {
            return c.json({ error: "appId parameter required" }, 400);
        }

        // Check if we already have GitHub App credentials configured
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

        // Store the GitHub App private key
        await c.env.DB.prepare(
            'INSERT OR REPLACE INTO system_config (key, value, description, updated_at) VALUES (?, ?, ?, ?)'
        ).bind(
            'github_app_private_key',
            privateKey,
            'GitHub App private key for token generation (supports multiple organizations)',
            Date.now()
        ).run();

        // Store the GitHub App ID
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
 * Test GitHub token generation and repository access
 */
app.post("/manual/test-github-token", async (c: HonoContext) => {
    try {
        const body = await c.req.json();
        const { installationId } = body;

        if (!installationId) {
            return c.json({ error: "installationId parameter required" }, 400);
        }

        // Try to generate a GitHub token
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
 * Check the status of operations for a specific repository
 */
app.get("/manual/check-status/:repo", async (c: HonoContext) => {
    try {
        const repo = c.req.param('repo');
        if (!repo) {
            return c.json({ error: "repo parameter required" }, 400);
        }

        // Check if repository exists in database
        const repoData = await c.env.DB.prepare(
            'SELECT * FROM repos WHERE full_name = ?'
        ).bind(repo).first();

        // Check recent operations for this repo
        const operations = await c.env.DB.prepare(
            'SELECT * FROM colby_commands WHERE repo = ? ORDER BY created_at DESC LIMIT 5'
        ).bind(repo).all();

        // Check if LLMs docs exist by trying to read the directory
        let llmsStatus = 'unknown';
        try {
            const [owner, repoName] = repo.split('/');
            // This would require a token to check, so we'll just return what we can
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
 * Manually add a repository to the database
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

        // Check if repository already exists
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

        // Add repository to database
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
 * Manual trigger for worker optimization for a specific repository
 */
app.post("/manual/trigger-optimize", async (c: HonoContext) => {
    try {
        const body = await c.req.json();
        const repo = body.repo;
        const installationId = body.installationId;

        if (!repo) {
            return c.json({ error: "repo parameter required" }, 400);
        }

        // First try to look up the repository in the database
        let repoData = await c.env.DB.prepare(
            'SELECT installation_id FROM repos WHERE full_name = ?'
        ).bind(repo).first();

        let finalInstallationId: number;

        if (!repoData) {
            // Repository not in database, try to use provided installationId or default
            if (installationId) {
                finalInstallationId = installationId;
                console.log(`[MANUAL] Using provided installation ID ${installationId} for ${repo}`);
            } else {
                // Try to get the first available installation (assuming org-wide access)
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

        // Create synthetic event for worker optimization
        const syntheticEvent = {
            kind: 'manual_trigger',
            delivery: `manual-${Date.now()}`,
            repo: repo,
            author: 'manual-trigger',
            installationId: finalInstallationId
        };

        // Get the PR_WORKFLOWS durable object
        const doId = c.env.PR_WORKFLOWS.idFromName(`repo-${repo}`);
        const stub = c.env.PR_WORKFLOWS.get(doId);

        // Trigger worker optimization
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

app.post("/api/merge-operations/status/:operationId", async (c: HonoContext) => {
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
        // Read the body once and pass data instead of the request
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

        // Create webhook data object instead of passing request
        const webhookData = {
            delivery,
            event,
            signature,
            bodyText,
            headers: {
                "x-github-delivery": delivery,
                "x-github-event": event,
                "x-hub-signature-256": signature,
                "content-type": c.req.header("content-type") || "application/json",
            },
        };

        console.log("[MAIN] Calling handleWebhook...");
        const response = await handleWebhook(webhookData, c.env);
        console.log("[MAIN] handleWebhook completed, status:", response.status);

        if (response.status < 400) {
            try {
                const payload = JSON.parse(bodyText);
                const target = normalizeRepositoryTarget(payload);
                if (target) {
                    const logger = createLogger("agent-standardizer", {
                        owner: target.owner,
                        repo: target.repo,
                        delivery,
                        event,
                    });
                    const skipByLabel = hasNoBotAgentsLabel(payload);
                    c.executionCtx?.waitUntil(handleRepoStandardization(c.env, target, logger, skipByLabel));
                } else {
                    console.debug("[MAIN] No repository data detected for standardizer");
                }
            } catch (error) {
                console.warn("[MAIN] Failed to enqueue agent standardization", {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        return response;
    } catch (error) {
        console.error("[MAIN] ERROR in webhook handler:", error);
        console.error(
            "[MAIN] Error stack:",
            error instanceof Error ? error.stack : "No stack available",
        );
        return new Response("Internal server error", { status: 500 });
    }
});

/**
 * Default export: Worker lifecycle hooks
 * - fetch: delegates to Hono app
 * - scheduled: triggers repo sync & discovery via cron (see wrangler.toml [triggers] crons)
 */
export type { Env };

export default {
    fetch: (req: Request, env: Env, ctx: ExecutionContext) =>
        app.fetch(req, env, ctx),

    /**
     * CRON handler
     * Periodically:
     * 1) Lists app installations.
     * 2) For each installation, lists accessible repos.
     * 3) Inserts unseen repos into D1, fetches README, runs a quick summary, and marks sync timestamp.
     * Notes:
     * - This path intentionally does a *lightweight* summary (summarizeRepo) to keep cost low.
     * - Deep/structured analysis is handled elsewhere (ResearchOrchestrator or manual endpoints).
     */
    scheduled: async (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
        ctx.waitUntil(syncRepos(env));
        ctx.waitUntil(backfillLlmDocs(env));

        if (event.cron === '0 12 * * *') {
            ctx.waitUntil(runDailyDiscovery(env));
        }
    },
};

// Export Durable Object classes so Wrangler can register them
export { ProfileScanner, PrWorkflow, ResearchOrchestrator, RepositorySetupCoordinator };

/**
 * Synchronizes repositories by fetching and updating their metadata.
 *
 * @param env - The environment bindings, including database and API tokens.
 */
async function syncRepos(env: Env) {
    const installations = await listInstallations(env);
    const installationList = Array.isArray(installations) ? installations : [];
    for (const inst of installationList) {
        const token = await getInstallationToken(env, inst.id);
        const repos = await listReposForInstallation(token);

        for (const r of repos) {
            const inserted = await insertRepoIfNew(env.DB, {
                id: r.id,
                full_name: r.full_name,
                installation_id: inst.id,
                default_branch: r.default_branch,
                visibility: r.visibility,
                description: r.description || "",
                topics: r.topics || [],
            });

            if (inserted) {
                // On first sighting of a repo, fetch README and store a quick summary.
                const repoName = r.full_name.split("/")[1];
                const readme = await fetchReadme(
                    token,
                    r.owner.login,
                    repoName,
                    r.default_branch,
                );
                const summary = await summarizeRepo(env, { meta: r, readme });
                await env.DB.prepare(
                    "UPDATE repos SET summary=?, last_synced=? WHERE full_name=?",
                )
                    .bind(summary, Date.now(), r.full_name)
                    .run();
            } else {
                // Existing repo: bump timestamp so we know it was seen in this cycle.
                await markRepoSynced(env.DB, r.full_name);
            }
        }
    }
}

/**
 * Backfills LLMs documentation and worker optimization to existing repositories that have wrangler files but no .agents/llms directory.
 *
 * @param env - The environment bindings, including database and Durable Object namespace.
 */
async function backfillLlmDocs(env: Env) {
    console.log('[SCHEDULED] Starting LLMs documentation and worker optimization backfill job');

    try {
        // Get all repositories from the database
        const repos = await env.DB.prepare(`
            SELECT full_name, installation_id
            FROM projects
            WHERE installation_id IS NOT NULL
        `).all();

        console.log(`[SCHEDULED] Found ${repos.results?.length || 0} repositories to check`);

        let processedCount = 0;
        let backfilledCount = 0;

        for (const repo of repos.results || []) {
            const repoName = repo.full_name as string;
            const installationId = repo.installation_id as number;

            try {
                // Get installation token
                const token = await getInstallationToken(env, installationId);
                const [owner, repoOnly] = repoName.split('/');

                // Check if repository already has LLMs documentation
                const hasLlmDocs = await checkForLlmDocs(token, owner, repoOnly);

                if (!hasLlmDocs) {
                    // Check if repository has wrangler files
                    const hasWrangler = await checkForWranglerFiles(token, owner, repoOnly);

                    if (hasWrangler) {
                        console.log(`[SCHEDULED] Backfilling LLMs docs for ${repoName}`);

                        // Create synthetic event to trigger LLMs docs creation
                        const syntheticEvent = {
                            kind: 'backfill_llms',
                            delivery: `backfill-${Date.now()}-${repoName}`,
                            repo: repoName,
                            author: 'scheduled-job',
                            installationId: installationId
                        };

                        // Get the PR_WORKFLOWS durable object and trigger both LLMs docs and optimization
                        const doId = env.PR_WORKFLOWS.idFromName(`repo-${repoName}`);
                        const stub = env.PR_WORKFLOWS.get(doId);

                        // First, create LLMs documentation
                        const llmsRes = await stub.fetch('https://do/create-llms-docs', {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify(syntheticEvent)
                        });

                        // Then, optimize the worker
                        const optimizeRes = await stub.fetch('https://do/optimize-worker', {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify(syntheticEvent)
                        });

                        if (llmsRes.ok && optimizeRes.ok) {
                            backfilledCount++;
                            console.log(`[SCHEDULED] Successfully backfilled LLMs docs and optimized ${repoName}`);
                        } else {
                            const llmsStatus = llmsRes.ok ? '✅' : `❌(${llmsRes.status})`;
                            const optimizeStatus = optimizeRes.ok ? '✅' : `❌(${optimizeRes.status})`;
                            console.log(`[SCHEDULED] Partial success for ${repoName}: LLMs ${llmsStatus}, Optimize ${optimizeStatus}`);
                            // Still count as backfilled if either succeeded
                            backfilledCount++;
                        }
                    }
                }

                processedCount++;

                // Add small delay to avoid rate limiting
                if (processedCount % 10 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

            } catch (error: any) {
                console.log(`[SCHEDULED] Error processing ${repoName}:`, error instanceof Error ? error.message : String(error));
            }
        }

        console.log(`[SCHEDULED] LLMs and optimization backfill completed: ${processedCount} processed, ${backfilledCount} optimized`);

        // Log the backfill operation
        try {
            await env.DB.prepare(`
                INSERT INTO scheduled_jobs (job_type, processed_count, success_count, created_at)
                VALUES (?, ?, ?, ?)
            `).bind('llms_and_optimize_backfill', processedCount, backfilledCount, Date.now()).run();
        } catch (dbError) {
            console.log('[SCHEDULED] Failed to log backfill operation (table may not exist):', dbError);
        }

    } catch (error: any) {
        console.log('[SCHEDULED] Error in LLMs backfill job:', error);
    }
}

/**
 * Checks if a repository already has LLMs documentation.
 *
 * @param token - GitHub API token
 * @param owner - Repository owner
 * @param repo - Repository name
 * @returns True if LLMs docs exist, false otherwise
 */
async function checkForLlmDocs(token: string, owner: string, repo: string): Promise<boolean> {
    try {
        await ghREST(token, 'GET', `/repos/${owner}/${repo}/contents/.agents/llms`);
        return true;
    } catch (error) {
        if (error instanceof GitHubHttpError && error.status === 404) {
            return false;
        }
        throw error;
    }
}

/**
 * Checks if a repository has wrangler configuration files.
 *
 * @param token - GitHub API token
 * @param owner - Repository owner
 * @param repo - Repository name
 * @returns True if wrangler files exist, false otherwise
 */
async function checkForWranglerFiles(token: string, owner: string, repo: string): Promise<boolean> {
    try {
        await ghREST(token, 'GET', `/repos/${owner}/${repo}/contents/wrangler.jsonc`);
        return true;
    } catch (error) {
        if (!(error instanceof GitHubHttpError) || error.status !== 404) {
            throw error;
        }
    }

    try {
        await ghREST(token, 'GET', `/repos/${owner}/${repo}/contents/wrangler.toml`);
        return true;
    } catch (error) {
        if (error instanceof GitHubHttpError && error.status === 404) {
            return false;
        }
        throw error;
    }
}

/**
 * Fetches the README file of a repository.
 *
 * @param token - The GitHub API token for authentication.
 * @param owner - The owner of the repository.
 * @param repo - The name of the repository.
 * @param branch - The branch from which to fetch the README.
 * @returns The content of the README file.
 */
async function fetchReadme(
    token: string,
    owner: string,
    repo: string,
    branch: string,
) {
    const content = await getFileAtRef(token, owner, repo, "README.md", branch);
    return content ?? "";
}

/**
 * POST /research/run
 * ------------------
 * Kicks off a research sweep via the ResearchOrchestrator DO.
 * Request body may include:
 * - queries?: string[]     → explicit search queries to run
 * - categories?: string[]  → load active queries from D1 for these categories
 *
 * Returns 202 on accepted; use /research/status to poll.
 */
app.post("/research/run", async (c: HonoContext) => {
    // Check for authentication - either webhook secret or frontend password
    const providedSecret = c.req.header('X-Webhook-Secret');
    const providedPassword = c.req.header('X-Frontend-Password');
    const expectedSecret = c.env.GITHUB_WEBHOOK_SECRET;
    const expectedPassword = c.env.FRONTEND_AUTH_PASSWORD;
    
    const isWebhookAuth = providedSecret && expectedSecret && providedSecret === expectedSecret;
    const isFrontendAuth = providedPassword && expectedPassword && providedPassword === expectedPassword;
    
    if (!isWebhookAuth && !isFrontendAuth) {
        return c.json({ error: "Invalid or missing authentication. Provide either X-Webhook-Secret or X-Frontend-Password header." }, 401);
    }

    if (!c.env.RESEARCH_ORCH) {
        return c.json({ error: "Research orchestrator not available" }, 503);
    }
    const doId = c.env.RESEARCH_ORCH.idFromName("global");
    const stub = c.env.RESEARCH_ORCH.get(doId);
    const body = await c.req.json().catch(() => ({}));
    const res = await stub.fetch("https://do/run", {
        method: "POST",
        body: JSON.stringify(body),
    });
    // Don't consume response body to avoid "Body has already been used" error
    return new Response("research-run-started", { status: res.status });
});

/**
 * GET /research/debug
 * --------------------
 * Debug endpoint to test Durable Object database access
 */
app.get("/research/debug", async (c: HonoContext) => {
    if (!c.env.RESEARCH_ORCH) {
        return c.json({ error: "Research orchestrator not available" }, 503);
    }
    
    const doId = c.env.RESEARCH_ORCH.idFromName("global");
    const stub = c.env.RESEARCH_ORCH.get(doId);
    
    try {
        const res = await stub.fetch("https://do/debug", {
            method: "GET",
        });
        const result = await res.text();
        return c.text(result);
    } catch (error) {
        return c.json({ error: `Failed to debug research orchestrator: ${error instanceof Error ? error.message : String(error)}` }, 500);
    }
});

/**
 * POST /research/reset
 * --------------------
 * Reset the research orchestrator status
 */
app.post("/research/reset", async (c: HonoContext) => {
    if (!c.env.RESEARCH_ORCH) {
        return c.json({ error: "Research orchestrator not available" }, 503);
    }
    
    const doId = c.env.RESEARCH_ORCH.idFromName("global");
    const stub = c.env.RESEARCH_ORCH.get(doId);
    
    try {
        const res = await stub.fetch("https://do/reset", {
            method: "POST",
        });
        const result = await res.json() as any;
        return c.json(result);
    } catch (error) {
        return c.json({ error: `Failed to reset research orchestrator: ${error instanceof Error ? error.message : String(error)}` }, 500);
    }
});

/**
 * GET /research/status
 * --------------------
 * Returns the last-known status of the ResearchOrchestrator run.
 * Use this to monitor long sweeps triggered by /research/run or cron.
 */
app.get("/research/status", async (c: HonoContext) => {
    if (!c.env.RESEARCH_ORCH) {
        return c.html(`
            <div class="error-card">
                <h3>❌ Research Orchestrator Unavailable</h3>
                <p>The research orchestrator is not available. Please check your configuration.</p>
            </div>
        `);
    }
    
    const stub = c.env.RESEARCH_ORCH.get(
        c.env.RESEARCH_ORCH.idFromName("global"),
    );
    const res = await stub.fetch("https://do/status");
    
    if (!res.ok) {
        return c.html(`
            <div class="error-card">
                <h3>❌ Research Status Error</h3>
                <p>Failed to fetch research status: ${res.status} ${res.statusText}</p>
            </div>
        `);
    }
    
    try {
        const statusData = await res.json() as any;
        
        // Format the status data into a nice HTML card
        const statusHtml = `
            <div class="status-card">
                <div class="status-header">
                    <h3>🔬 Research Status</h3>
                    <div class="status-badge ${statusData.status === 'running' ? 'running' : statusData.status === 'completed' ? 'completed' : 'idle'}">
                        ${statusData.status || 'Unknown'}
                    </div>
                </div>
                <div class="status-details">
                    ${statusData.message ? `<p><strong>Message:</strong> ${statusData.message}</p>` : ''}
                    ${statusData.started_at ? `<p><strong>Started:</strong> ${new Date(statusData.started_at).toLocaleString()}</p>` : ''}
                    ${statusData.completed_at ? `<p><strong>Completed:</strong> ${new Date(statusData.completed_at).toLocaleString()}</p>` : ''}
                    ${statusData.repositories_found ? `<p><strong>Repositories Found:</strong> ${statusData.repositories_found}</p>` : ''}
                    ${statusData.repositories_analyzed ? `<p><strong>Repositories Analyzed:</strong> ${statusData.repositories_analyzed}</p>` : ''}
                    ${statusData.queries_run ? `<p><strong>Queries Run:</strong> ${statusData.queries_run}</p>` : ''}
                    ${statusData.error ? `<p class="error-text"><strong>Error:</strong> ${statusData.error}</p>` : ''}
                </div>
                <div class="status-actions">
                    <button onclick="showResearchModal()" class="btn btn-primary">🚀 Run New Research</button>
                    <button onclick="location.reload()" class="btn btn-secondary">🔄 Refresh</button>
                </div>
            </div>
        `;
        
        return c.html(statusHtml);
    } catch (error) {
        return c.html(`
            <div class="error-card">
                <h3>❌ Parse Error</h3>
                <p>Failed to parse research status: ${error instanceof Error ? error.message : String(error)}</p>
            </div>
        `);
    }
});

/**
 * GET /debug/repos
 * ----------------
 * Debug endpoint to see what repositories the bot can access
 */
app.get("/debug/repos", async (c: HonoContext) => {
    try {
        const installations = await listInstallations(c.env);
        const installationList = Array.isArray(installations) ? installations : [];
        const allRepos = [];

        for (const inst of installationList) {
            const token = await getInstallationToken(c.env, inst.id);
            const repos = await listReposForInstallation(token);
            
            allRepos.push({
                installation: inst,
                repos: repos.map(r => ({
                    full_name: r.full_name,
                    owner: r.owner.login,
                    owner_type: (r as any).owner.type,
                    name: (r as any).name,
                    private: (r as any).private,
                    html_url: (r as any).html_url
                }))
            });
        }

        return c.json({
            installations: installationList.length,
            repositories: allRepos
        });
    } catch (error) {
        return c.json({ error: "Failed to list repositories", details: String(error) }, 500);
    }
});

/**
 * GET /debug/operations
 * Debug endpoint to see all operations in the database
 */
app.get("/debug/operations", async (c: HonoContext) => {
    try {
        const operations = await c.env.DB.prepare(`
      SELECT * FROM operation_progress
      ORDER BY created_at DESC
      LIMIT 50
    `).all();

        return c.json({
            total: operations.results?.length || 0,
            operations: operations.results || []
        });
    } catch (error) {
        return c.json({ error: "Failed to fetch operations", details: String(error) }, 500);
    }
});

/**
 * GET /debug/webhook-events
 * Debug endpoint to see recent webhook events
 */
app.get("/debug/webhook-events", async (c: HonoContext) => {
    try {
        const eventId = c.req.query('id');
        
        let query: string;
        let params: any[];
        if (eventId) {
            // Query specific event by ID
            query = `
                SELECT id, delivery_id, event, repo, pr_number, author, action, created_at, response_status, response_message, error_details, payload_json, suggestions_json
                FROM gh_events
                WHERE id = ?
            `;
            params = [eventId];
        } else {
            // Query recent events
            query = `
                SELECT id, delivery_id, event, repo, pr_number, author, action, created_at, response_status, response_message, error_details, payload_json, suggestions_json
                FROM gh_events
                ORDER BY created_at DESC
                LIMIT 20
            `;
            params = [];
        }

        const events = await c.env.DB.prepare(query).bind(...params).all();

        return c.json({
            total: events.results?.length || 0,
            events: events.results || []
        });
    } catch (error) {
        return c.json({ error: "Failed to fetch webhook events", details: String(error) }, 500);
    }
});

/**
 * GET /debug/webhook-command-log
 * Debug endpoint to see webhook command processing log
 */
app.get("/debug/webhook-command-log", async (c: HonoContext) => {
    try {
        const limit = c.req.query('limit') || '50';
        const limitNum = parseInt(limit, 10);
        
        const events = await c.env.DB.prepare(`
            SELECT id, delivery_id, command_text, command_type, command_args, execution_status, execution_result, started_at, completed_at, created_at
            FROM webhook_command_log
            ORDER BY id DESC
            LIMIT ?
        `).bind(limitNum).all();

        return c.json({
            total: events.results?.length || 0,
            events: events.results || []
        });
    } catch (error) {
        return c.json({ error: "Failed to fetch webhook command log", details: String(error) }, 500);
    }
});

/**
 * GET /setup
 * GitHub App setup page with automated configuration
 */
app.get("/setup", async (c: HonoContext) => {
    const baseUrl = c.req.header('host') ? `https://${c.req.header('host')}` : 'https://gh-bot.hacolby.workers.dev';
    
    const manifest = {
        name: "Colby GitHub Bot",
        url: baseUrl,
        description: "AI-powered GitHub workflow automation and research.",
        public: false,
        hook_attributes: {
            url: `${baseUrl}/github/webhook`,
            active: true
        },
        redirect_url: `${baseUrl}/github/manifest/callback`,
        callback_urls: [
            `${baseUrl}/github/oauth/callback`
        ],
        default_permissions: {
            metadata: "read",
            contents: "read",
            issues: "write",
            pull_requests: "write",
            checks: "read",
            actions: "read"
        },
        default_events: [
            "issues",
            "issue_comment",
            "pull_request",
            "pull_request_review",
            "pull_request_review_comment",
            "check_suite",
            "check_run",
            "push"
        ]
    };

    const setupHtml = `
<!DOCTYPE html>
<html>
<head>
    <title>Colby GitHub Bot - Setup</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f6f8fa; }
        .container { max-width: 800px; margin: 0 auto; background: white; border-radius: 8px; padding: 30px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .header { text-align: center; margin-bottom: 30px; }
        .step { margin: 20px 0; padding: 20px; border: 1px solid #e1e4e8; border-radius: 6px; }
        .step h3 { margin-top: 0; color: #24292e; }
        .code-block { background: #f6f8fa; padding: 15px; border-radius: 6px; font-family: 'SF Mono', Monaco, monospace; font-size: 14px; overflow-x: auto; position: relative; }
        .code-block-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid #e1e4e8; }
        .code-block-title { font-weight: 600; color: #24292e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
        .copy-btn { background: #0366d6; color: white; border: none; padding: 4px 8px; border-radius: 4px; font-size: 11px; cursor: pointer; font-family: inherit; }
        .copy-btn:hover { background: #0256cc; }
        .copy-btn.copied { background: #28a745; }
        .json-block { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px; margin: 15px 0; overflow: hidden; }
        .json-content { padding: 15px; font-family: 'SF Mono', Monaco, monospace; font-size: 13px; line-height: 1.5; white-space: pre-wrap; overflow-x: auto; }
        .code-content { padding: 15px; font-family: 'SF Mono', Monaco, monospace; font-size: 13px; line-height: 1.5; white-space: pre-wrap; overflow-x: auto; }
        .btn { display: inline-block; padding: 10px 20px; background: #0366d6; color: white; text-decoration: none; border-radius: 6px; margin: 10px 5px; }
        .btn:hover { background: #0256cc; }
        .warning { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 6px; margin: 15px 0; }
        .success { background: #d4edda; border: 1px solid #c3e6cb; padding: 15px; border-radius: 6px; margin: 15px 0; }
        .form-group { margin: 15px 0; }
        .form-group label { display: block; margin-bottom: 5px; font-weight: 600; }
        .form-group input { width: 100%; padding: 8px; border: 1px solid #d1d5da; border-radius: 4px; }
        .form-group textarea { width: 100%; height: 200px; padding: 8px; border: 1px solid #d1d5da; border-radius: 4px; font-family: monospace; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 Colby GitHub Bot Setup</h1>
            <p>Automated setup for your GitHub App installation</p>
        </div>

        <div class="step">
            <h3>📋 Step 1: Create GitHub App Manifest</h3>
            <p>Copy the manifest JSON below and save it as <code>colby-app-manifest.json</code>:</p>
            <div class="json-block">
                <div class="code-block-header">
                    <span class="code-block-title">Manifest JSON</span>
                    <button class="copy-btn" onclick="copyToClipboard('manifest-json')">📋 Copy</button>
                </div>
                <div class="json-content" id="manifest-json">${JSON.stringify(manifest, null, 2)}</div>
            </div>
        </div>

        <div class="step">
            <h3>🚀 Step 2: Create GitHub App via Manifest</h3>
            <p>Use the GitHub App Manifest flow to create your app:</p>
            
            <h4>Option A: Automated Manifest Creation (Recommended)</h4>
            <div class="code-block">
                <div class="code-block-header">
                    <span class="code-block-title">Shell Command</span>
                    <button class="copy-btn" onclick="copyToClipboard('cli-create-command')">📋 Copy</button>
                </div>
                <div class="code-content" id="cli-create-command"># First, make sure you're signed in to GitHub CLI
gh auth status

# Generate a webhook secret
WEBHOOK_SECRET=$(openssl rand -hex 32)
echo "Generated webhook secret: $WEBHOOK_SECRET"

# Create the manifest JSON file
cat > manifest.json << 'EOF'
{
  "name": "Colby GitHub Bot",
  "url": "https://gh-bot.hacolby.workers.dev",
  "description": "AI-powered GitHub workflow automation and research.",
  "public": false,
  "hook_attributes": {
    "url": "https://gh-bot.hacolby.workers.dev/github/webhook",
    "active": true
  },
  "redirect_url": "https://gh-bot.hacolby.workers.dev/github/manifest/callback",
  "callback_urls": [
    "https://gh-bot.hacolby.workers.dev/github/oauth/callback"
  ],
  "default_permissions": {
    "metadata": "read",
    "contents": "read",
    "issues": "write",
    "pull_requests": "write",
    "checks": "read",
    "actions": "read"
  },
  "default_events": [
    "issues",
    "issue_comment",
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
    "check_suite",
    "check_run",
    "push"
  ]
}
EOF

# Generate the manifest URL and open it
MANIFEST_QS=$(python3 -c "import json,urllib.parse; print(urllib.parse.quote(open('manifest.json').read()))")
echo "Opening: https://github.com/settings/apps/new?manifest=$MANIFEST_QS"
open "https://github.com/settings/apps/new?manifest=$MANIFEST_QS"

echo "After creating the app, GitHub will redirect you to:"
echo "https://gh-bot.hacolby.workers.dev/github/manifest/callback?code=YOUR_CODE"
echo "Copy the code from the URL and use it in the next step."</div>
            </div>
            
            <h4>Option B: Manual Manifest Form (Fallback)</h4>
            <p>If the CLI method doesn't work, use the manual form approach:</p>
            <div class="code-block">
                <div class="code-block-header">
                    <span class="code-block-title">Manual Steps</span>
                    <button class="copy-btn" onclick="copyToClipboard('manual-steps')">📋 Copy</button>
                </div>
                <div class="code-content" id="manual-steps"># 1. Go to GitHub App creation page
open "https://github.com/settings/apps/new"

# 2. Fill in the form manually with these values:
# - App name: Colby GitHub Bot
# - Homepage URL: https://gh-bot.hacolby.workers.dev
# - Webhook URL: https://gh-bot.hacolby.workers.dev/github/webhook
# - Webhook secret: (generate a random string)
# - Permissions: See the JSON manifest below for exact permissions
# - Events: issues, issue_comment, pull_request, pull_request_review, pull_request_review_comment, check_suite, check_run, push</div>
            </div>
            
            <h4>Option C: Direct Manifest Link (Alternative)</h4>
            <p>If you prefer the manifest approach, try this direct link:</p>
            <div class="code-block">
                <div class="code-block-header">
                    <span class="code-block-title">Direct URL</span>
                    <button class="copy-btn" onclick="copyToClipboard('direct-url')">📋 Copy</button>
                </div>
                <div class="code-content" id="direct-url">https://github.com/settings/apps/new?manifest=${encodeURIComponent(JSON.stringify(manifest))}</div>
            </div>
            
            
            <div class="warning">
                <strong>⚠️ Important:</strong> After clicking "Create GitHub App", GitHub will redirect to your callback URL with a code. You'll need to exchange this code for credentials in the next step.
            </div>
        </div>

        <div class="step">
            <h3>🔧 Step 3: Get App Credentials</h3>
            <p>After creating the app, you'll need to get the credentials for your Cloudflare Worker:</p>
            
            <h4>If you used Option A (Manifest Creation):</h4>
            <div class="code-block">
                <div class="code-block-header">
                    <span class="code-block-title">Exchange Code for Credentials</span>
                    <button class="copy-btn" onclick="copyToClipboard('manifest-credentials')">📋 Copy</button>
                </div>
                <div class="code-content" id="manifest-credentials"># After creating the app via manifest, GitHub redirects with a code
# Replace YOUR_CODE with the actual code from the redirect URL
CODE="YOUR_CODE"

# Exchange the code for app credentials
gh api -X POST \\
  -H "Accept: application/vnd.github+json" \\
  "/app-manifests/$CODE/conversions" \\
  > app_credentials.json

# Extract the credentials
echo "App created! Here are your credentials:"
echo "App ID: $(jq -r '.id' app_credentials.json)"
echo "App Slug: $(jq -r '.slug' app_credentials.json)"
echo "Webhook Secret: $(jq -r '.webhook_secret' app_credentials.json)"

# Save the private key
jq -r '.pem' app_credentials.json > gh_app_private_key.pem
echo "Private key saved to: gh_app_private_key.pem"

# Generate environment variables
echo "=== Environment Variables for Cloudflare Worker ==="
echo "GITHUB_APP_ID=$(jq -r '.id' app_credentials.json)"
echo "GITHUB_WEBHOOK_SECRET=$(jq -r '.webhook_secret' app_credentials.json)"
echo "GITHUB_CLIENT_ID=$(jq -r '.client_id' app_credentials.json)"
echo "GITHUB_CLIENT_SECRET=$(jq -r '.client_secret' app_credentials.json)"
echo "SUMMARY_CF_MODEL=@cf/meta/llama-3.1-8b-instruct"</div>
            </div>
            
            <h4>If you used the Manifest Form:</h4>
            <p>After GitHub redirects to your callback URL, extract the code and exchange it for app credentials:</p>
            <div class="code-block">
                <div class="code-block-header">
                    <span class="code-block-title">Shell Commands</span>
                    <button class="copy-btn" onclick="copyToClipboard('credentials-commands')">📋 Copy</button>
                </div>
                <div class="code-content" id="credentials-commands"># Extract the code from the redirect URL (e.g., ?code=abc123)
CODE="paste_the_code_from_redirect_url_here"

# Exchange manifest code for credentials
gh api -X POST \\
  -H "Accept: application/vnd.github+json" \\
  "/app-manifests/\${CODE}/conversions" > app_credentials.json

# Extract key bits for your Cloudflare Worker
jq -r '.pem' app_credentials.json > gh_app_private_key.pem
jq -r '"GITHUB_APP_ID=\(.id)\\nGITHUB_WEBHOOK_SECRET=\(.webhook_secret)\\nGITHUB_CLIENT_ID=\(.client_id)\\nGITHUB_CLIENT_SECRET=\(.client_secret)"' app_credentials.json

# Your Cloudflare Worker environment variables:
CF_ACCOUNT_ID=your_account_id
CF_API_TOKEN=your_api_token
SUMMARY_CF_MODEL=@cf/meta/llama-2-7b-chat-fp16</div>
            </div>
            
            <div class="warning">
                <strong>⚠️ Time Limit:</strong> The manifest code expires in ~1 hour, so complete this step quickly after creating the app.
            </div>
        </div>

        <div class="step">
            <h3>📱 Step 4: Install the App</h3>
            <p>After creating the app, install it on your repositories:</p>
            <div class="code-block">
                <div class="code-block-header">
                    <span class="code-block-title">Installation Commands</span>
                    <button class="copy-btn" onclick="copyToClipboard('install-commands')">📋 Copy</button>
                </div>
                <div class="code-content" id="install-commands"># Install on personal repositories
gh api /user/installations

# Install on organization repositories  
gh api /orgs/your-org/installations</div>
            </div>
        </div>

        <div class="step">
            <h3>✅ Step 5: Verify Installation</h3>
            <p>Test that everything is working:</p>
            <div class="code-block">
                <div class="code-block-header">
                    <span class="code-block-title">Verification Commands</span>
                    <button class="copy-btn" onclick="copyToClipboard('verify-commands')">📋 Copy</button>
                </div>
                <div class="code-content" id="verify-commands"># Check if the bot can access repositories
curl \${baseUrl}/debug/repos

# Test the webhook (replace with your actual webhook URL)
curl -X POST \${baseUrl}/github/webhook \\
  -H "Content-Type: application/json" \\
  -H "X-GitHub-Event: ping" \\
  -d '{"zen":"Keep it logically awesome."}'</div>
            </div>
        </div>

        <div class="step">
            <h3>🆘 Troubleshooting</h3>
            <p>If you encounter issues:</p>
            <ul>
                <li><strong>Blank manifest form:</strong> Sign in to GitHub first, then refresh the page</li>
                <li><strong>GitHub CLI not authenticated:</strong> Run <code>gh auth login</code> and follow the prompts</li>
                <li><strong>Webhook URL not accessible:</strong> Ensure your Cloudflare Worker is deployed and accessible</li>
                <li><strong>Environment variables:</strong> Verify all required variables are set in your Cloudflare Worker</li>
                <li><strong>Debug information:</strong> Check the <a href="/debug/operations">operations debug page</a> for errors</li>
            </ul>
            
                    <h4>Common Solutions:</h4>
                    <div class="code-block">
                        <div class="code-block-header">
                            <span class="code-block-title">Troubleshooting Commands</span>
                            <button class="copy-btn" onclick="copyToClipboard('troubleshoot-commands')">📋 Copy</button>
                        </div>
                        <div class="code-content" id="troubleshoot-commands"># Check GitHub CLI authentication
gh auth status

# Re-authenticate if needed
gh auth login

# Test webhook accessibility
curl -I https://gh-bot.hacolby.workers.dev/github/webhook

# Check if the worker is responding
curl https://gh-bot.hacolby.workers.dev/debug/repos

# If manifest form is blank, try this alternative approach:
# 1. Go directly to: https://github.com/settings/apps/new
# 2. Fill in the form manually using the manifest JSON above
# 3. Use the same redirect URL: https://gh-bot.hacolby.workers.dev/github/manifest/callback</div>
                    </div>
                    
                    <h4>Blank Form Fix:</h4>
                    <p>If the manifest form appears blank, try these solutions:</p>
                    <ul>
                        <li><strong>Clear browser cache</strong> and try again</li>
                        <li><strong>Use incognito/private mode</strong> to avoid cache issues</li>
                        <li><strong>Try a different browser</strong> (Chrome, Firefox, Safari)</li>
                        <li><strong>Manual form entry</strong> - Go to <code>https://github.com/settings/apps/new</code> and fill in manually</li>
                        <li><strong>Check network connectivity</strong> - Ensure you can access GitHub normally</li>
                    </ul>
        </div>

        <div style="text-align: center; margin-top: 30px;">
            <a href="/" class="btn">← Back to Dashboard</a>
            <a href="/help" class="btn">📖 View Help</a>
            <a href="/setup" class="btn">⚙️ Setup GitHub App</a>
        </div>
    </div>

    <script>
        function copyToClipboard(elementId) {
            const element = document.getElementById(elementId);
            const text = element.textContent || element.innerText;
            
            // Use the modern clipboard API if available
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(() => {
                    showCopySuccess(elementId);
                }).catch(err => {
                    fallbackCopyTextToClipboard(text, elementId);
                });
            } else {
                fallbackCopyTextToClipboard(text, elementId);
            }
        }
        
        function fallbackCopyTextToClipboard(text, elementId) {
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.style.position = "fixed";
            textArea.style.left = "-999999px";
            textArea.style.top = "-999999px";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            
            try {
                document.execCommand('copy');
                showCopySuccess(elementId);
            } catch (err) {
                console.error('Fallback: Could not copy text: ', err);
            }
            
            document.body.removeChild(textArea);
        }
        
        function showCopySuccess(elementId) {
            const button = document.querySelector('[onclick="copyToClipboard(\\'' + elementId + '\\')"]');
            const originalText = button.textContent;
            button.textContent = '✅ Copied!';
            button.classList.add('copied');
            
            setTimeout(() => {
                button.textContent = originalText;
                button.classList.remove('copied');
            }, 2000);
        }
    </script>
</body>
</html>`;

    return c.html(setupHtml);
});

/**
 * POST /setup/auto
 * Automated setup using personal access token
 */
app.post("/setup/auto", async (c: HonoContext) => {
    try {
        const { personalToken, appName, description } = await c.req.json();
        
        if (!personalToken) {
            return c.json({ error: "Personal access token is required" }, 400);
        }

        const baseUrl = c.req.header('host') ? `https://${c.req.header('host')}` : 'https://gh-bot.hacolby.workers.dev';
        
        // Note: The automated setup via personal token is not supported for GitHub Apps
        // GitHub Apps must be created via the manifest flow for security reasons
        return c.json({
            error: "Automated GitHub App creation not supported",
            message: "GitHub Apps must be created using the manifest flow for security reasons. Please use the manual setup process at /setup",
            manifest: {
                name: appName || "Colby GitHub Bot",
                url: baseUrl,
                description: description || "AI-powered GitHub workflow automation and research.",
                public: false,
                hook_attributes: {
                    url: `${baseUrl}/github/webhook`,
                    active: true
                },
                redirect_url: `${baseUrl}/github/manifest/callback`,
                callback_urls: [
                    `${baseUrl}/github/oauth/callback`
                ],
                default_permissions: {
                    metadata: "read",
                    contents: "read",
                    issues: "write",
                    pull_requests: "write",
                    checks: "read",
                    actions: "read"
                },
                default_events: [
                    "issues",
                    "issue_comment",
                    "pull_request",
                    "pull_request_review",
                    "pull_request_review_comment",
                    "check_suite",
                    "check_run",
                    "push"
                ]
            },
            next_steps: [
                "Use the manifest above with the manual setup process",
                "Visit /setup for complete instructions",
                "Follow the manifest flow to create your GitHub App"
            ]
        }, 400);

    } catch (error) {
        return c.json({ 
            error: "Setup failed", 
            details: String(error) 
        }, 500);
    }
});

/**
 * GET /github/manifest/callback
 * Handle GitHub App manifest callback
 */
app.get("/github/manifest/callback", async (c: HonoContext) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    
    if (!code) {
        return c.html(`
            <!DOCTYPE html>
            <html>
            <head><title>GitHub App Setup - Error</title></head>
            <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 40px; text-align: center;">
                <h2>❌ Setup Error</h2>
                <p>No authorization code received from GitHub.</p>
                <p>Please try the setup process again.</p>
                <a href="/setup" style="color: #0366d6;">← Back to Setup</a>
            </body>
            </html>
        `);
    }

    return c.html(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>GitHub App Setup - Success</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 40px; background: #f6f8fa; }
                .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
                .code-block { background: #f6f8fa; padding: 15px; border-radius: 6px; font-family: 'SF Mono', Monaco, monospace; margin: 15px 0; word-break: break-all; position: relative; }
                .code-block-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid #e1e4e8; }
                .code-block-title { font-weight: 600; color: #24292e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
                .copy-btn { background: #0366d6; color: white; border: none; padding: 4px 8px; border-radius: 4px; font-size: 11px; cursor: pointer; font-family: inherit; }
                .copy-btn:hover { background: #0256cc; }
                .copy-btn.copied { background: #28a745; }
                .btn { display: inline-block; padding: 10px 20px; background: #0366d6; color: white; text-decoration: none; border-radius: 6px; margin: 10px 5px; }
                .success { background: #d4edda; border: 1px solid #c3e6cb; padding: 15px; border-radius: 6px; margin: 15px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <h2>✅ GitHub App Created Successfully!</h2>
                
                <div class="success">
                    <strong>Next Step:</strong> Exchange the authorization code for your app credentials.
                </div>
                
                <h3>🔑 Exchange Code for Credentials</h3>
                <p>Copy the code below and run these commands in your terminal:</p>
                
                <div class="code-block">
                    <div class="code-block-header">
                        <span class="code-block-title">Authorization Code</span>
                        <button class="copy-btn" onclick="copyToClipboard('auth-code')">📋 Copy</button>
                    </div>
                    <div class="code-content" id="auth-code">${code}</div>
                </div>
                
                <h4>Run these commands:</h4>
                <div class="code-block">
                    <div class="code-block-header">
                        <span class="code-block-title">Shell Commands</span>
                        <button class="copy-btn" onclick="copyToClipboard('callback-commands')">📋 Copy</button>
                    </div>
                    <div class="code-content" id="callback-commands"># Exchange the code for credentials
gh api -X POST \\
  -H "Accept: application/vnd.github+json" \\
  "/app-manifests/\${code}/conversions" > app_credentials.json

# Extract the credentials
jq -r '.pem' app_credentials.json > gh_app_private_key.pem
jq -r '"GITHUB_APP_ID=\(.id)\\nGITHUB_WEBHOOK_SECRET=\(.webhook_secret)\\nGITHUB_CLIENT_ID=\(.client_id)\\nGITHUB_CLIENT_SECRET=\(.client_secret)"' app_credentials.json</div>
                </div>
                
                <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 6px; margin: 15px 0;">
                    <strong>⚠️ Important:</strong> This code expires in ~1 hour. Complete the exchange process quickly!
                </div>
                
                <div style="text-align: center; margin-top: 30px;">
                    <a href="/setup" class="btn">← Back to Setup Guide</a>
                    <a href="/" class="btn">🏠 Dashboard</a>
                </div>
            </div>
        </body>
        <script>
            function copyToClipboard(elementId) {
                const element = document.getElementById(elementId);
                const text = element.textContent || element.innerText;
                
                // Use the modern clipboard API if available
                if (navigator.clipboard && window.isSecureContext) {
                    navigator.clipboard.writeText(text).then(() => {
                        showCopySuccess(elementId);
                    }).catch(err => {
                        fallbackCopyTextToClipboard(text, elementId);
                    });
                } else {
                    fallbackCopyTextToClipboard(text, elementId);
                }
            }
            
            function fallbackCopyTextToClipboard(text, elementId) {
                const textArea = document.createElement("textarea");
                textArea.value = text;
                textArea.style.position = "fixed";
                textArea.style.left = "-999999px";
                textArea.style.top = "-999999px";
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                
                try {
                    document.execCommand('copy');
                    showCopySuccess(elementId);
                } catch (err) {
                    console.error('Fallback: Could not copy text: ', err);
                }
                
                document.body.removeChild(textArea);
            }
            
            function showCopySuccess(elementId) {
                const button = document.querySelector('[onclick="copyToClipboard(\\'' + elementId + '\\')"]');
                const originalText = button.textContent;
                button.textContent = '✅ Copied!';
                button.classList.add('copied');
                
                setTimeout(() => {
                    button.textContent = originalText;
                    button.classList.remove('copied');
                }, 2000);
            }
        </script>
        </html>
    `);
});

/**
 * GET /research/results
 * ---------------------
 * Returns ranked project results from D1, optionally enriched with AI analysis.
 * Query params:
 * - min_score (number, default 0.6): minimum project score to include
 * - limit     (number, default 50, max 200)
 *
 * Sorting:
 * - p.score DESC, then analysis confidence DESC, then recency.
 */
app.get("/research/results", async (c: HonoContext) => {
    try {
        const minScore = c.req.query("min_score");
        const limitParam = c.req.query("limit");

        // Validate and sanitize inputs
        const min = minScore ? Math.max(0, Math.min(1, Number(minScore))) : 0.6;
        const requestedLimit = limitParam ? Number(limitParam) : 50;
        const lim = Math.max(1, Math.min(requestedLimit, 200)); // Cap at 200, minimum 1

        // Validate numeric inputs
        if (minScore && (Number.isNaN(min) || min < 0 || min > 1)) {
            return c.json(
                { error: "min_score must be a number between 0 and 1" },
                400,
            );
        }
        if (limitParam && (Number.isNaN(requestedLimit) || requestedLimit < 1)) {
            return c.json({ error: "limit must be a positive number" }, 400);
        }
        const countResult = await c.env.DB.prepare(
            "SELECT COUNT(*) as count FROM projects",
        ).first();
        const totalProjects = (countResult as { count: number })?.count || 0;

        if (totalProjects === 0) {
        return c.html(`
            <div class="no-results-card">
                <h3>📊 No Research Results Found</h3>
                <p>No projects have been analyzed yet. Run a research sweep to discover and analyze Cloudflare Workers repositories.</p>
                <div class="no-results-actions">
                    <button onclick="showResearchModal()" class="btn btn-primary">🚀 Run Research Sweep</button>
                </div>
            </div>
        `);
        }

        const rows = await c.env.DB.prepare(`
      SELECT
        p.full_name, p.html_url, p.stars, p.score,
        p.short_summary, p.long_summary, p.updated_at,
        ra.purpose, ra.summary_short as ai_summary_short,
        ra.confidence, ra.risk_flags_json, ra.analyzed_at
      FROM projects p
      LEFT JOIN repo_analysis ra ON p.full_name = ra.repo_full_name
      WHERE p.score >= ?
      ORDER BY p.score DESC, ra.confidence DESC NULLS LAST
      LIMIT ?
    `)
            .bind(min, lim)
            .all();

        // Check if this is a request for HTML (from dashboard)
        const acceptHeader = c.req.header("Accept") || "";
        const isHTMLRequest =
            acceptHeader.includes("text/html") || c.req.header("HX-Request");

        if (isHTMLRequest) {
            if (!rows.results || rows.results.length === 0) {
                return c.html('<div class="loading">No repositories found</div>');
            }

            const repos = (rows.results as Array<{
                full_name: string;
                html_url: string;
                stars: number;
                score: number;
                short_summary?: string;
                long_summary?: string;
            }>)
            
            // Process repos with badges asynchronously
            const reposWithBadges = await Promise.all(
                repos.map(async (repo) => {
                    const stars = repo.stars || 0;
                    const score = repo.score ? (repo.score * 100).toFixed(1) : "N/A";

                    // Generate badges for this repo
                    const badgeResult = await detectRepoBadges(repo);
                    const badgesHtml = badgeResult.badges.map(badge => 
                        `<span class="badge" style="background-color: ${badge.color}; color: white; padding: 2px 8px; border-radius: 12px; font-size: 11px; margin-right: 4px; display: inline-block;">${badge.label}</span>`
                    ).join('');

                    return `
          <div class="practice-item">
            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 10px;">
              <div>
                <h4><a href="${repo.html_url}" target="_blank" style="color: #0366d6;">${repo.full_name}</a></h4>
                <div class="operation-meta">⭐ ${stars} stars • Score: ${score}%</div>
                <div style="margin-top: 8px;">${badgesHtml}</div>
              </div>
              <button onclick="openRepoModal('${repo.full_name}')" class="btn btn-secondary" style="font-size: 12px;">View Details</button>
            </div>
            <div style="margin-bottom: 10px;">${repo.short_summary || "No summary available"}</div>
            ${repo.long_summary ? `<div style="font-size: 14px; color: #586069;">${repo.long_summary.slice(0, 200)}...</div>` : ""}
          </div>
        `;
                })
            );
            
            const html = reposWithBadges.join("");

            return c.html(html);
        }

        // Format results as JSON for non-HTML requests
        return c.json({
            results: rows.results || [],
            total: totalProjects,
            showing: (rows.results || []).length,
            minScore: min
        });
    } catch (error) {
        return c.json(
            {
                error: "Database query failed",
                details: String(error),
                results: [],
            },
            500,
        );
    }
});

/**
 * GET /research/analysis
 * ----------------------
 * Returns the raw analysis row for a specific repo.
 * Query params:
 * - repo = "owner/name" (required)
 */
app.get("/research/analysis", async (c: HonoContext) => {
    try {
        const repo = c.req.query("repo");
        if (!repo)
            return c.json(
                { error: "repo parameter required", example: "?repo=owner/name" },
                400,
            );

        // Input validation - detect potential SQL injection attempts
        if (
            repo.includes(";") ||
            repo.includes("--") ||
            repo.includes("DROP") ||
            repo.includes("DELETE") ||
            repo.includes("INSERT") ||
            repo.includes("UPDATE") ||
            repo.includes("UNION") ||
            repo.includes("/*") ||
            repo.includes("*/") ||
            repo.includes("\\")
        ) {
            return c.json(
                {
                    error: "Invalid repository name format",
                    message: 'Repository names should be in format "owner/name"',
                    hint: "Special characters and SQL keywords are not allowed",
                },
                400,
            );
        }

        // Basic format validation for owner/repo pattern
        if (
            !repo.includes("/") ||
            repo.split("/").length !== 2 ||
            repo.startsWith("/") ||
            repo.endsWith("/")
        ) {
            return c.json(
                {
                    error: "Invalid repository format",
                    message: 'Repository must be in format "owner/name"',
                    example: "cloudflare/workers-sdk",
                },
                400,
            );
        }

        const [owner, repoName] = repo.split("/");
        if (!owner.trim() || !repoName.trim()) {
            return c.json(
                {
                    error: "Invalid repository format",
                    message: "Both owner and repository name are required",
                    example: "cloudflare/workers-sdk",
                },
                400,
            );
        }

        const row = await c.env.DB.prepare(
            "SELECT * FROM repo_analysis WHERE repo_full_name=?",
        )
            .bind(repo)
            .first();

        if (!row) {
            // Return 200 with helpful information instead of 404
            return c.json(
                {
                    message: `No analysis found for repository '${repo}'`,
                    repo: repo,
                    suggestions: [
                        "Run analysis with: POST /research/analyze",
                        "Check if the repository exists and is accessible",
                        "Browse available analyses at: GET /research/results",
                    ],
                    status: "no_data",
                },
                200,
            );
        }

        return c.json({
            message: "Analysis data found",
            repo: repo,
            analysis: row,
            status: "success",
        });
    } catch (error) {
        return c.json(
            {
                error: "Database query failed",
                details: String(error),
            },
            500,
        );
    }
});

/**
 * GET /research/risks
 * -------------------
 * “Safety board” view. Lists repos with non-empty risk flags, ordered by
 * analysis confidence (desc) and project score (desc).
 * Useful for triaging suspicious/vague repos (e.g., proxy/vpn, abuse-risk).
 */
app.get("/research/risks", async (c: HonoContext) => {
    try {
        // First check if we have any analysis data
        const analysisCount = await c.env.DB.prepare(
            "SELECT COUNT(*) as count FROM repo_analysis",
        ).first();
        const totalAnalysis = (analysisCount as { count: number })?.count || 0;

        if (totalAnalysis === 0) {
            return c.json({
                message:
                    "No repository analysis data found. Run analyses first with POST /research/analyze",
                total_analyses: 0,
                results: [],
            });
        }

        const rows = await c.env.DB.prepare(`
      SELECT
        ra.repo_full_name, ra.purpose, ra.summary_short,
        ra.risk_flags_json, ra.confidence, ra.analyzed_at,
        p.html_url, p.stars, p.score
      FROM repo_analysis ra
      LEFT JOIN projects p ON ra.repo_full_name = p.full_name
      WHERE ra.risk_flags_json != '[]' AND ra.risk_flags_json IS NOT NULL
      ORDER BY ra.confidence DESC, p.score DESC NULLS LAST
      LIMIT 100
    `).all();

        return c.json({
            total_analyses: totalAnalysis,
            results: (rows.results || []).map((row: any) => ({
                ...row,
                risk_flags: JSON.parse(row.risk_flags_json || "[]"),
            })),
        });
    } catch (error) {
        return c.json(
            {
                error: "Database query failed",
                details: String(error),
                results: [],
            },
            500,
        );
    }
});

/**
 * POST /research/analyze
 * ----------------------
 * Manually run the lightweight code analysis for a specific repo.
 * Body:
 * { owner: string, repo: string, force?: boolean=false }
 * Behavior:
 * - if existing analysis is fresh (<24h) and force=false → returns a message instead of re-running.
 * - otherwise fetches default branch, samples code, calls AI, and stores results.
 */
app.post("/research/analyze", async (c: HonoContext) => {
    const body = await c.req.json().catch(() => ({}));
    const { owner, repo, force = false } = body;

    if (!owner || !repo) {
        return c.json({ error: "owner and repo required" }, 400);
    }

    try {
        const installations = await listInstallations(c.env);
        const installationList = Array.isArray(installations) ? installations : [];
        if (installationList.length === 0) {
            return c.json({ error: "No GitHub installations available" }, 400);
        }
        const token = await getInstallationToken(c.env, installationList[0].id);

        if (!force) {
            const existing = await c.env.DB.prepare(
                "SELECT analyzed_at FROM repo_analysis WHERE repo_full_name = ?",
            )
                .bind(`${owner}/${repo}`)
                .first();
            if (existing) {
                const age = Date.now() - (existing as { analyzed_at: number }).analyzed_at;
                const maxAge = 24 * 60 * 60 * 1000; // 24 hours
                if (age < maxAge) {
                    return c.json(
                        { message: "Analysis is recent, use force=true to override" },
                        200,
                    );
                }
            }
        }

        const repoInfo = await ghREST(token, 'GET', `/repos/${owner}/${repo}`) as { default_branch?: string };

        if (!repoInfo.default_branch) {
            return c.json({ error: "Repository not found or no access" }, 404);
        }

        const analysis = await analyzeRepoCode(c.env as any, {
            token,
            owner,
            repo,
            ref: repoInfo.default_branch,
        });

        return c.json({ message: "Analysis completed", analysis });
    } catch (error) {
        return c.json({ error: "Analysis failed", details: String(error) }, 500);
    }
});

/**
 * GET /research/structured
 * ------------------------
 * Returns projects joined with their structured AI analysis as JSON objects.
 * Query params (all optional):
 * - binding  (string): filter by wrangler binding (e.g., "d1", "durable_objects")
 * - kind     (string): filter by repo_kind ("frontend"|"backend"|...)
 * - min_conf (number): filter by minimum confidence [0..1]
 */
app.get("/research/structured", async (c: HonoContext) => {
    try {
        const binding = c.req.query("binding");
        const kind = c.req.query("kind");
        const minConf = Number(c.req.query("min_conf") ?? "0.0");

        // First check if we have any structured analysis data
        const structuredCount = await c.env.DB.prepare(
            "SELECT COUNT(*) as count FROM repo_analysis WHERE structured_json IS NOT NULL",
        ).first();
        const totalStructured = (structuredCount as { count: number })?.count || 0;

        if (totalStructured === 0) {
            return c.json({
                message:
                    "No structured analysis data found. Run structured analyses first with POST /research/analyze-structured",
                total_structured_analyses: 0,
                filters: { binding, kind, min_conf: minConf },
                results: [],
            });
        }

        let sql = `
      SELECT p.full_name, p.html_url, p.stars, a.structured_json
      FROM projects p
      JOIN repo_analysis a ON a.repo_full_name = p.full_name
      WHERE a.structured_json IS NOT NULL
    `;
        const args: (string | number)[] = [];

        if (binding) {
            sql += ` AND EXISTS (
        SELECT 1 FROM repo_analysis_bindings b
        WHERE b.repo_full_name = p.full_name AND b.binding = ?
      )`;
            args.push(binding);
        }

        if (kind) {
            sql += ` AND json_extract(a.structured_json, '$.repo_kind') = ?`;
            args.push(kind);
        }

        if (!Number.isNaN(minConf) && minConf > 0) {
            sql += ` AND json_extract(a.structured_json, '$.confidence') >= ?`;
            args.push(minConf);
        }

        sql += ` ORDER BY p.stars DESC, p.updated_at DESC LIMIT 200`;

        const rows = await c.env.DB.prepare(sql)
            .bind(...args)
            .all();
        return c.json({
            total_structured_analyses: totalStructured,
            filters: { binding, kind, min_conf: minConf },
            results: (rows.results || []).map((r: any) => ({
                full_name: r.full_name,
                html_url: r.html_url,
                stars: r.stars,
                analysis: JSON.parse(r.structured_json || "{}"),
            })),
        });
    } catch (error) {
        return c.json(
            {
                error: "Query failed",
                details: String(error),
                results: [],
            },
            500,
        );
    }
});

/**
 * POST /research/analyze-structured
 * ---------------------------------
 * Manually run the **structured** code analysis for a specific repo.
 * Body:
 * { owner: string, repo: string, force?: boolean=false }
 * Behavior:
 * - checks freshness (24h) unless force=true
 * - loads default branch
 * - runs analyzeRepoCodeStructured (which returns a strict JSON object)
 * - stores result in repo_analysis.structured_json (see repo_analyzer module)
 */
app.post("/research/analyze-structured", async (c: HonoContext) => {
    const body = await c.req.json().catch(() => ({}));
    const { owner, repo, force = false } = body;

    if (!owner || !repo) {
        return c.json({ error: "owner and repo required" }, 400);
    }

    try {
        const installations = await listInstallations(c.env);
        const installationList = Array.isArray(installations) ? installations : [];
        if (installationList.length === 0) {
            return c.json({ error: "No GitHub installations available" }, 400);
        }
        const token = await getInstallationToken(c.env, installationList[0].id);

        if (!force) {
            const existing = await c.env.DB.prepare(
                "SELECT analyzed_at, structured_json FROM repo_analysis WHERE repo_full_name = ?",
            )
                .bind(`${owner}/${repo}`)
                .first();

            if (existing && (existing as { structured_json: string; analyzed_at: number }).structured_json) {
                const age = Date.now() - (existing as { analyzed_at: number }).analyzed_at;
                const maxAge = 24 * 60 * 60 * 1000; // 24 hours
                if (age < maxAge) {
                    return c.json(
                        {
                            message:
                                "Structured analysis is recent, use force=true to override",
                            analysis: JSON.parse((existing as { structured_json: string }).structured_json),
                        },
                        200,
                    );
                }
            }
        }

        const repoInfo = await ghREST(token, 'GET', `/repos/${owner}/${repo}`) as { default_branch?: string };

        if (!repoInfo.default_branch) {
            return c.json({ error: "Repository not found or no access" }, 404);
        }

        const analysis = await analyzeRepoCodeStructured(c.env as any, {
            token,
            owner,
            repo,
            ref: repoInfo.default_branch,
        });

        return c.json({ message: "Structured analysis completed", analysis });
    } catch (error) {
        return c.json(
            { error: "Structured analysis failed", details: String(error) },
            500,
        );
    }
});

// ===== NEW COLBY API ENDPOINTS =====

/**
 * POST /api/agent-setup
 * ---------------------
 * Generates AI agent configuration files based on project context.
 *
 * Request body:
 * {
 *   repo?: string,           // GitHub repo (owner/name) - optional if context provided
 *   context: string,         // Project context and goals
 *   goals?: string,          // Specific goals and outcomes
 *   outcomes?: string,       // Expected outcomes
 *   infrastructure?: string  // Target infrastructure type
 * }
 *
 * Response:
 * - If API mode: Returns R2 URLs for generated files
 * - Generates: .agents/AGENT.md, .agents/prompt.md, .agents/PRD.md, .agents/project_tasks.json
 */
app.post("/api/agent-setup", async (c: HonoContext) => {
    try {
        const body = await c.req.json().catch(() => ({}));
        const { repo, context, goals, outcomes, infrastructure } = body;

        // Validate required fields
        if (!context) {
            return c.json(
                {
                    error: "Missing required field: context",
                    message:
                        "Please provide project context describing what you want to build",
                },
                400,
            );
        }

        console.log("[API] Agent setup request:", {
            repo,
            hasContext: !!context,
            goals,
            infrastructure,
        });

        // Generate agent assets using the service module
        const result = await generateAgentAssets(c.env as any, {
            repo: repo || "api-generated-project",
            context,
            goals: goals || "",
            outcome: outcomes || "",
        });

        return c.json({
            message: "Agent assets generated successfully",
            assets: result,
            downloadUrls: [], // R2 URLs would be provided by the service
            metadata: {
                projectType: "cloudflare-worker", // Default for API requests
                generatedAt: Date.now(),
                context: context.substring(0, 100) + "...",
            },
        });
    } catch (err) {
        console.error("[API] Agent setup error:", err);
        return c.json(
            {
                error: "Failed to generate agent assets",
                details: err instanceof Error ? err.message : String(err),
            },
            500,
        );
    }
});

/**
 * POST /api/guidance
 * ------------------
 * Provides infrastructure-specific guidance and recommendations.
 *
 * Request body:
 * {
 *   infrastructure: string,  // Infrastructure type (required)
 *   repo?: string,          // GitHub repo for context analysis
 *   context?: string,       // Additional project context
 *   goals?: string          // Project goals and requirements
 * }
 */
app.post("/api/guidance", async (c: HonoContext) => {
    try {
        const body = await c.req.json().catch(() => ({}));
        const { infrastructure, repo, context, goals } = body;

        // Validate required fields
        if (!infrastructure) {
            return c.json(
                {
                    error: "Missing required field: infrastructure",
                    message:
                        "Please specify the infrastructure type you need guidance for",
                    availableTypes: [
                        "cloudflare-workers",
                        "cloudflare-pages",
                        "nextjs-pages",
                        "python",
                        "apps-script",
                        "nodejs",
                        "react",
                        "vue",
                    ],
                },
                400,
            );
        }

        console.log("[API] Infrastructure guidance request:", {
            infrastructure,
            repo,
            hasContext: !!context,
        });

        // Generate infrastructure guidance
        const guidance = await generateInfrastructureGuidance(c.env as any, {
            repo,
            infraType: infrastructure,
        });

        return c.json({
            message: "Infrastructure guidance generated successfully",
            infrastructure,
            guidance,
            generatedAt: Date.now(),
        });
    } catch (err) {
        console.error("[API] Infrastructure guidance error:", err);
        return c.json(
            {
                error: "Failed to generate infrastructure guidance",
                details: err instanceof Error ? err.message : String(err),
            },
            500,
        );
    }
});

/**
 * POST /api/llm-full
 * ------------------
 * Fetches relevant LLM documentation content based on project context.
 *
 * Request body:
 * {
 *   context?: string,        // Project context for relevance analysis
 *   repo?: string,          // GitHub repo for analysis
 *   searchQuery?: string,   // Specific search terms
 *   goals?: string,         // Project goals
 *   categories?: string[]   // Specific documentation categories to focus on
 * }
 */
app.post("/api/llm-full", async (c: HonoContext) => {
    try {
        const body = await c.req.json().catch(() => ({}));
        const { context, repo, searchQuery, goals, categories } = body;

        console.log("[API] LLM content request:", {
            repo,
            hasContext: !!context,
            searchQuery,
            goals,
            categories,
        });

        // Create project analysis context
        const projectContext = {
            repo: repo || "api-request",
            repoStructure: {
                projectType: "cloudflare-worker" as const, // Default assumption for API requests
                hasWrangler: true,
                hasNextConfig: false,
                hasPackageJson: true,
                hasClaspJson: false,
                hasAppsScriptJson: false,
                hasPythonFiles: false,
                dependencies: [],
                devDependencies: [],
            },
            goals,
            context,
            searchQuery,
        };

        // Fetch relevant LLM content
        const contentResults = await fetchRelevantLLMContent(
            c.env as any,
            projectContext,
            {
                forceRefresh: false,
                includeChunks: true,
                maxContentLength: 50000,
            },
        );

        // Format response with top relevant content
        const topResults = contentResults.slice(0, 5).map((result) => ({
            url: result.content.url,
            category: result.content.category,
            title: result.content.title,
            relevanceScore: result.relevanceScore,
            relevanceReasons: result.relevanceReasons,
            matchedKeywords: result.matchedKeywords,
            contentPreview: result.content.content.substring(0, 500) + "...",
            metadata: result.content.metadata,
        }));

        return c.json({
            message: "Relevant LLM content retrieved successfully",
            totalResults: contentResults.length,
            topResults,
            suggestions:
                contentResults.length === 0
                    ? [
                            "Try being more specific about your project type",
                            "Include technology stack details in your context",
                            "Check the available documentation categories",
                        ]
                    : [],
            availableCategories: [
                "Application Hosting / Full Stack",
                "AI & Agents",
                "Edge Compute",
                "Stateful Services",
                "Developer Tools & Platform",
                "Browser/Rendering/Images/Media",
                "Other/General",
            ],
            generatedAt: Date.now(),
        });
    } catch (err) {
        console.error("[API] LLM content error:", err);
        return c.json(
            {
                error: "Failed to fetch LLM content",
                details: err instanceof Error ? err.message : String(err),
            },
            500,
        );
    }
});

// ===== COLBY COMMAND ENDPOINTS =====

const KNOWN_COLBY_COMMANDS = [
    "implement",
    "create_issue",
    "bookmark_suggestion",
    "extract_suggestions",
    "extract_suggestions_to_issues",
    "group_comments_by_file",
    "create_llms_docs",
    "optimize_worker",
    "help",
    "resolve_conflicts",
];

type SuggestionDetail = {
    source: string;
    content: string;
    lineCount: number;
};

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
    if (!value) {
        return fallback;
    }
    try {
        return JSON.parse(value) as T;
    } catch (error) {
        return fallback;
    }
}

function detectTriggersFromText(text: string): string[] {
    if (!text) {
        return [];
    }

    const triggers: string[] = [];
    let match: RegExpExecArray | null;

    const originalRe = /^\s*\/(apply|fix|summarize|lint|test)\b.*$/gim;
    while ((match = originalRe.exec(text)) !== null) {
        triggers.push(match[0].trim());
    }

    const colbyRe = /^\s*\/colby\s+(implement|create\s+issue(?:\s+and\s+assign\s+to\s+copilot)?|bookmark\s+this\s+suggestion|extract\s+suggestions(?:\s+to\s+issues?)?|help|configure\s+agent|provide\s+\w+\s+guidance|provide\s+guidance|llm-full|resolve\s+conflicts?|clear\s+conflicts?|create\s+llms?\s+docs?|fetch\s+llms?\s+docs?|optimize\s+worker|setup\s+worker)\b.*$/gim;
    while ((match = colbyRe.exec(text)) !== null) {
        triggers.push(match[0].trim());
    }

    return triggers;
}

function detectSuggestionsFromBody(body: string, diffHunk?: string | null): {
    suggestions: string[];
    details: SuggestionDetail[];
} {
    const text = body || "";
    const details: SuggestionDetail[] = [];
    const seen = new Set<string>();

    const record = (source: string, raw: string) => {
        const normalized = (raw || "").replace(/\r\n/g, "\n");
        const trimmed = normalized.trimEnd();
        if (!trimmed.trim() || seen.has(trimmed)) {
            return;
        }
        seen.add(trimmed);
        details.push({
            source,
            content: trimmed,
            lineCount: trimmed.split("\n").length,
        });
    };

    let match: RegExpExecArray | null;

    const suggestionRe = /```suggestion\s*\n([\s\S]*?)```/g;
    while ((match = suggestionRe.exec(text)) !== null) {
        record("suggestion_block", match[1]);
    }

    const languageBlockRe = /```(?:typescript|javascript|ts|js|python|py|java|cpp|c|go|rust|php|ruby|swift|kotlin|scala|r|sql|html|css|json|yaml|xml|markdown|md|bash|sh|powershell|ps1|dockerfile|docker|yaml|yml|toml|ini|conf|config|txt|text|plain|diff|patch)\s*\n([\s\S]*?)```/g;
    while ((match = languageBlockRe.exec(text)) !== null) {
        const code = match[1].trim();
        if (code.length > 10 && !code.includes("// Example") && !code.includes("// Sample")) {
            record("code_block", code);
        }
    }

    const diffLineRe = /^\+.*$/gm;
    const diffMatches = text.match(diffLineRe);
    if (diffMatches && diffMatches.length > 0) {
        const diffSuggestion = diffMatches.map((line) => line.substring(1)).join("\n");
        if (diffSuggestion.trim().length > 0) {
            record("diff_body", diffSuggestion.trim());
        }
    }

    const aiBlockRe = /```(?:typescript|javascript|ts|js|python|py|java|cpp|c|go|rust|php|ruby|swift|kotlin|scala|r|sql|html|css|json|yaml|xml|markdown|md|bash|sh|powershell|ps1|dockerfile|docker|yaml|yml|toml|ini|conf|config|txt|text|plain|diff|patch)\s*\n([\s\S]*?)```/g;
    while ((match = aiBlockRe.exec(text)) !== null) {
        const code = match[1].trim();
        if (
            code.length > 5 &&
            (
                code.includes("function") ||
                code.includes("const") ||
                code.includes("let") ||
                code.includes("var") ||
                code.includes("class") ||
                code.includes("interface") ||
                code.includes("type") ||
                code.includes("import") ||
                code.includes("export") ||
                code.includes("return") ||
                code.includes("if") ||
                code.includes("for") ||
                code.includes("while") ||
                code.includes("{") ||
                code.includes("}") ||
                code.includes("(") ||
                code.includes(")") ||
                code.includes("=") ||
                code.includes("=>") ||
                code.includes(";") ||
                code.includes("def ") ||
                code.includes("public ") ||
                code.includes("private ") ||
                code.includes("protected ")
            )
        ) {
            record("ai_code_block", code);
        }
    }

    const geminiPatterns = [
        /```(?:typescript|javascript|ts|js|python|py|java|cpp|c|go|rust|php|ruby|swift|kotlin|scala|r|sql|html|css|json|yaml|xml|markdown|md|bash|sh|powershell|ps1|dockerfile|docker|yaml|yml|toml|ini|conf|config|txt|text|plain|diff|patch)\s*\n([\s\S]*?)```/g,
        /```\s*\n([\s\S]*?)```/g,
    ];
    for (const pattern of geminiPatterns) {
        while ((match = pattern.exec(text)) !== null) {
            const code = match[1].trim();
            if (
                code.length > 10 &&
                (
                    code.includes("function") ||
                    code.includes("const") ||
                    code.includes("let") ||
                    code.includes("var") ||
                    code.includes("class") ||
                    code.includes("interface") ||
                    code.includes("type") ||
                    code.includes("import") ||
                    code.includes("export") ||
                    code.includes("return") ||
                    code.includes("if") ||
                    code.includes("for") ||
                    code.includes("while") ||
                    code.includes("{") ||
                    code.includes("}") ||
                    code.includes("(") ||
                    code.includes(")") ||
                    code.includes("=") ||
                    code.includes("=>") ||
                    code.includes(";") ||
                    code.includes("def ") ||
                    code.includes("public ") ||
                    code.includes("private ") ||
                    code.includes("protected ")
                )
            ) {
                record("gemini_block", code);
            }
        }
    }

    const inlineCodeRe = /`([^`\n]{10,})`/g;
    while ((match = inlineCodeRe.exec(text)) !== null) {
        const code = match[1].trim();
        if (
            code.length > 10 &&
            (
                code.includes("function") ||
                code.includes("const") ||
                code.includes("let") ||
                code.includes("var") ||
                code.includes("class") ||
                code.includes("interface") ||
                code.includes("type") ||
                code.includes("import") ||
                code.includes("export") ||
                code.includes("return") ||
                code.includes("if") ||
                code.includes("for") ||
                code.includes("while") ||
                code.includes("{") ||
                code.includes("}") ||
                code.includes("(") ||
                code.includes(")") ||
                code.includes("=") ||
                code.includes("=>") ||
                code.includes(";")
            )
        ) {
            record("inline_code", code);
        }
    }

    const suggestionKeywords = [
        "suggest",
        "recommend",
        "propose",
        "improve",
        "fix",
        "update",
        "change",
        "modify",
        "should",
        "could",
        "would",
    ];
    const lines = text.split("\n");
    let currentSuggestion = "";
    let inSuggestion = false;

    for (const line of lines) {
        const lowerLine = line.toLowerCase();
        if (
            suggestionKeywords.some((keyword) => lowerLine.includes(keyword)) &&
            (line.includes("```") ||
                line.trim().startsWith("function") ||
                line.trim().startsWith("const") ||
                line.trim().startsWith("let") ||
                line.trim().startsWith("var"))
        ) {
            inSuggestion = true;
            currentSuggestion = line;
        } else if (
            inSuggestion &&
            (line.trim() === "" || line.startsWith(" ") || line.startsWith("\t") || line.includes("```"))
        ) {
            if (line.includes("```")) {
                inSuggestion = false;
                if (currentSuggestion.trim().length > 0) {
                    record("keyword_block", currentSuggestion.trim());
                    currentSuggestion = "";
                }
            } else {
                currentSuggestion += "\n" + line;
            }
        } else if (inSuggestion && line.trim() !== "") {
            currentSuggestion += "\n" + line;
        }
    }

    if (currentSuggestion.trim().length > 0) {
        record("keyword_block", currentSuggestion.trim());
    }

    if (details.length === 0 && diffHunk) {
        const addedLines = diffHunk
            .split("\n")
            .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
            .map((line) => line.substring(1))
            .filter((line) => line.trim().length > 0);

        if (addedLines.length > 0) {
            record("diff_hunk", addedLines.join("\n"));
        }
    }

    return {
        suggestions: details.map((detail) => detail.content),
        details,
    };
}

/**
 * GET /api/stats
 * Dashboard statistics endpoint
 */
app.get("/api/stats", async (c: HonoContext) => {
    try {
        // Get basic counts from the database
        const [projectsCount, commandsCount, practicesCount, analysisCount] =
            await Promise.all([
                c.env.DB.prepare("SELECT COUNT(*) as count FROM projects")
                    .first()
                    .catch(() => ({ count: 0 })),
                c.env.DB.prepare("SELECT COUNT(*) as count FROM colby_commands")
                    .first()
                    .catch(() => ({ count: 0 })),
                c.env.DB.prepare("SELECT COUNT(*) as count FROM best_practices")
                    .first()
                    .catch(() => ({ count: 0 })),
                c.env.DB.prepare("SELECT COUNT(*) as count FROM repo_analysis")
                    .first()
                    .catch(() => ({ count: 0 })),
            ]);

        return c.json({
            projects: (projectsCount as any)?.count || 0,
            commands: (commandsCount as any)?.count || 0,
            practices: (practicesCount as any)?.count || 0,
            analyses: (analysisCount as any)?.count || 0,
            operations: 0, // Will be calculated separately
            repositories: (projectsCount as any)?.count || 0
        });
    } catch (error) {
        return c.json({ error: "Failed to load stats", details: String(error) }, 500);
    }
});

/**
 * GET /api/recent-activity
 * Dashboard recent activity endpoint
 */
app.get("/api/recent-activity", async (c: HonoContext) => {
    try {
        // Get recent commands (with fallback for missing tables)
        let recentCommands = { results: [] };
        try {
            recentCommands = await c.env.DB.prepare(`
        SELECT * FROM colby_commands
        ORDER BY created_at DESC
        LIMIT 5
      `).all();
        } catch (tableError) {
            // Table doesn't exist, return empty activity
        }

                const commands = (recentCommands.results || []) as any[];

                const accept = c.req.header("Accept") || "";
                if (accept.includes("application/json")) {
                        return c.json({
                                activity: commands.map((cmd) => ({
                                        id: cmd.id,
                                        type: "command",
                                        command: cmd.command,
                                        repo: cmd.repo,
                                        author: cmd.author,
                                        status: cmd.status,
                                        timestamp: cmd.created_at,
                                })),
                        });
                }

                if (commands.length === 0) {
                        return c.html('<div class="loading">No recent activity</div>');
                }

                const html = commands
                        .map((cmd) => {
                                const timeAgo = new Date(cmd.created_at).toLocaleString();
                                return `
        <div class="operation-item">
          <div class="operation-info">
            <h4>/colby ${cmd.command}</h4>
            <div class="operation-meta">
              <strong>${cmd.repo}</strong> • by @${cmd.author} • ${timeAgo}
            </div>
          </div>
          <span class="status ${cmd.status}">${cmd.status}</span>
        </div>
      `;
                        })
                        .join("");

                return c.html(html);
        } catch (error) {
                const accept = c.req.header("Accept") || "";
                if (accept.includes("application/json")) {
                        return c.json({ error: "Error loading recent activity" }, 500);
                }
                return c.html('<div class="loading">Error loading recent activity</div>');
        }
});


/**
 * GET /colby/operations/:id
 * Get real-time operation progress
 */
app.get("/colby/operations/:id", async (c: HonoContext) => {
    const operationId = c.req.param("id");

    try {
        // Try to create the operation_progress table if it doesn't exist
        try {
            await c.env.DB.prepare(`
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
        )
      `).run();
        } catch {
            // Table might already exist, continue
      console.log("Operation progress table creation attempted.");
        }

        const operation = await c.env.DB.prepare(
            "SELECT * FROM operation_progress WHERE operation_id = ?",
        )
            .bind(operationId)
            .first();

        if (!operation) {
            return c.json({ error: "Operation not found" }, 404);
        }

        return c.json({
            id: operation.operation_id,
            type: operation.operation_type,
            repo: operation.repo,
            prNumber: operation.pr_number,
            status: operation.status,
            progress: operation.progress_percent,
            currentStep: operation.current_step,
            stepsTotal: operation.steps_total,
            stepsCompleted: operation.steps_completed,
            result: operation.result_data
                ? JSON.parse(operation.result_data as string)
                : null,
            error: operation.error_message,
            createdAt: operation.created_at,
            updatedAt: operation.updated_at,
        });
    } catch (error) {
        return c.json({ error: "Failed to fetch operation" }, 500);
    }
});

/**
 * GET /colby/commands
 * List colby commands with filtering
 */
app.get("/colby/commands", async (c: HonoContext) => {
    const repo = c.req.query("repo");
    const author = c.req.query("author");
    const status = c.req.query("status");
    const command = c.req.query("command");

    // Safe parameter parsing with validation
    const limitParam = c.req.query("limit");
    const offsetParam = c.req.query("offset");

    // Parse and validate limit parameter
    let limit = 50; // default
    if (limitParam) {
        const parsedLimit = Number(limitParam);
        if (Number.isNaN(parsedLimit) || parsedLimit < 1) {
            return c.json(
                { error: "Invalid limit parameter. Must be a positive number." },
                400,
            );
        }
        limit = Math.min(parsedLimit, 200);
    }

    // Parse and validate offset parameter
    let offset = 0; // default
    if (offsetParam) {
        const parsedOffset = Number(offsetParam);
        if (Number.isNaN(parsedOffset) || parsedOffset < 0) {
            return c.json(
                { error: "Invalid offset parameter. Must be a non-negative number." },
                400,
            );
        }
        offset = parsedOffset;
    }

    try {
        // Try to create the colby_commands table if it doesn't exist
        try {
            await c.env.DB.prepare(`
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
        )
      `).run();
        } catch (createError) {
            // Table might already exist, continue
        }

        // First check if the colby_commands table exists
        try {
            await c.env.DB.prepare("SELECT 1 FROM colby_commands LIMIT 1").all();
        } catch (tableError) {
            // Table doesn't exist, try to create it
            try {
                await c.env.DB.prepare(`
          CREATE TABLE colby_commands (
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
          )
        `).run();
            } catch (createError) {
                // Return helpful message
                return c.json(
                    {
                        error: "Database setup incomplete",
                        message: "Run: wrangler d1 migrations apply gh-bot --remote",
                        commands: [],
                        pagination: { limit, offset },
                    },
                    200,
                );
            }
        }

        let sql = "SELECT * FROM colby_commands WHERE 1=1";
        const params: any[] = [];

        if (repo) {
            sql += " AND repo = ?";
            params.push(repo);
        }
        if (author) {
            sql += " AND author = ?";
            params.push(author);
        }
        if (status) {
            sql += " AND status = ?";
            params.push(status);
        }
        if (command) {
            sql += " AND command = ?";
            params.push(command);
        }

        sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
        params.push(limit, offset);

        const commands = await c.env.DB.prepare(sql)
            .bind(...params)
            .all();

        // Check if this is a request for HTML (from dashboard)
        const acceptHeader = c.req.header("Accept") || "";
        const isHTMLRequest =
            acceptHeader.includes("text/html") || c.req.header("HX-Request");

        if (isHTMLRequest) {
            if (!commands.results || commands.results.length === 0) {
                return c.html('<div class="loading">No commands found</div>');
            }

            const html = (commands.results as any[])
                .map((cmd) => {
                    const timeAgo = new Date(cmd.created_at).toLocaleString();
                    const statusClass = cmd.status;
                    const args = cmd.command_args ? JSON.parse(cmd.command_args) : {};

                    return `
          <div class="command-item">
            <h4>/colby ${cmd.command}</h4>
            <div class="operation-meta">
              <strong>${cmd.repo}</strong> • by @${cmd.author} • ${timeAgo}
              ${cmd.pr_number ? ` • PR #${cmd.pr_number}` : ""}
            </div>
            <div style="margin-top: 5px;">
              <span class="status ${statusClass}">${cmd.status}</span>
              ${cmd.error_message ? `<span style="color: #721c24; margin-left: 10px;">${cmd.error_message}</span>` : ""}
            </div>
          </div>
        `;
                })
                .join("");

            return c.html(html);
        }

        return c.json({
            commands: (commands.results || []).map((cmd: any) => ({
                id: cmd.id,
                deliveryId: cmd.delivery_id,
                repo: cmd.repo,
                prNumber: cmd.pr_number,
                author: cmd.author,
                command: cmd.command,
                commandArgs: cmd.command_args ? JSON.parse(cmd.command_args) : null,
                status: cmd.status,
                promptGenerated: cmd.prompt_generated,
                resultData: cmd.result_data ? JSON.parse(cmd.result_data) : null,
                errorMessage: cmd.error_message,
                startedAt: cmd.started_at,
                completedAt: cmd.completed_at,
                createdAt: cmd.created_at,
            })),
            pagination: { limit, offset },
        });
    } catch (error) {
        return c.json({ error: "Failed to fetch commands" }, 500);
    }
});

/**
 * GET /colby/best-practices
 * List bookmarked best practices
 */
app.get("/colby/best-practices", async (c: HonoContext) => {
    const category = c.req.query("category");
    const subcategory = c.req.query("subcategory");
    const status = c.req.query("status") || "pending";

    // Safe parameter parsing with validation
    const limitParam = c.req.query("limit");
    const offsetParam = c.req.query("offset");

    // Parse and validate limit parameter
    let limit = 50; // default
    if (limitParam) {
        const parsedLimit = Number(limitParam);
        if (isNaN(parsedLimit) || parsedLimit < 1) {
            return c.json(
                { error: "Invalid limit parameter. Must be a positive number." },
                400,
            );
        }
        limit = Math.min(parsedLimit, 200);
    }

    // Parse and validate offset parameter
    let offset = 0; // default
    if (offsetParam) {
        const parsedOffset = Number(offsetParam);
        if (isNaN(parsedOffset) || parsedOffset < 0) {
            return c.json(
                { error: "Invalid offset parameter. Must be a non-negative number." },
                400,
            );
        }
        offset = parsedOffset;
    }

    try {
        // Try to create the best_practices table if it doesn't exist
        try {
            await c.env.DB.prepare(`
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
        )
      `).run();
        } catch (createError) {
            // Table might already exist, continue
        }

        // First check if the best_practices table exists
        try {
            await c.env.DB.prepare("SELECT 1 FROM best_practices LIMIT 1").all();
        } catch (tableError) {
            // Table doesn't exist, try to create it
            try {
                await c.env.DB.prepare(`
          CREATE TABLE best_practices (
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
          )
        `).run();
            } catch (createError) {
                return c.json(
                    {
                        error: "Database setup incomplete",
                        message: "Run: wrangler d1 migrations apply gh-bot --remote",
                        practices: [],
                        pagination: { limit, offset },
                    },
                    200,
                );
            }
        }
        let sql = "SELECT * FROM best_practices WHERE status = ?";
        const params: any[] = [status];

        if (category) {
            sql += " AND category = ?";
            params.push(category);
        }
        if (subcategory) {
            sql += " AND subcategory = ?";
            params.push(subcategory);
        }

        sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
        params.push(limit, offset);

        const practices = await c.env.DB.prepare(sql)
            .bind(...params)
            .all();

        // Check if this is a request for HTML (from dashboard)
        const acceptHeader = c.req.header("Accept") || "";
        const isHTMLRequest =
            acceptHeader.includes("text/html") || c.req.header("HX-Request");

        if (isHTMLRequest) {
            if (!practices.results || practices.results.length === 0) {
                return c.html('<div class="loading">No best practices found</div>');
            }

            const html = (practices.results as any[])
                .map((p) => {
                    const tags = p.ai_tags ? JSON.parse(p.ai_tags) : [];
                    const timeAgo = new Date(p.created_at).toLocaleString();

                    return `
          <div class="practice-item">
            <div style="font-weight: 600; margin-bottom: 10px;">${p.category} → ${p.subcategory}</div>
            <div style="margin-bottom: 10px;">${p.suggestion_text}</div>
            <div class="operation-meta">
              From <strong>${p.context_repo}</strong>${p.context_pr ? ` PR #${p.context_pr}` : ""} •
              by @${p.bookmarked_by} • ${timeAgo}
            </div>
            <div class="tags">
              ${tags.map((tag: string) => `<span class="tag">${tag}</span>`).join("")}
            </div>
          </div>
        `;
                })
                .join("");

            return c.html(html);
        }

        return c.json({
            practices: (practices.results || []).map((p: any) => ({
                id: p.id,
                suggestionText: p.suggestion_text,
                contextRepo: p.context_repo,
                contextPr: p.context_pr,
                contextFile: p.context_file,
                tags: p.ai_tags ? JSON.parse(p.ai_tags) : [],
                category: p.category,
                subcategory: p.subcategory,
                confidence: p.confidence,
                status: p.status,
                bookmarkedBy: p.bookmarked_by,
                votesUp: p.votes_up,
                votesDown: p.votes_down,
                createdAt: p.created_at,
                updatedAt: p.updated_at,
            })),
            pagination: { limit, offset },
        });
    } catch (error) {
        return c.json({ error: "Failed to fetch best practices" }, 500);
    }
});

/**
 * GET /colby/pr/:owner/:repo/:prNumber/comments
 * Inspect PR comments with detected suggestions and /colby command triggers.
 */
app.get("/colby/pr/:owner/:repo/:prNumber/comments", async (c: HonoContext) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const prParam = c.req.param("prNumber");
    const prNumber = Number(prParam);

    if (!owner || !repo || !prParam || Number.isNaN(prNumber)) {
        return c.json(
            {
                error: "Invalid parameters",
                details: "Provide owner, repo, and a numeric pull request number.",
            },
            400,
        );
    }

    const repoFullName = `${owner}/${repo}`;

    try {
        let eventsRows: any[] = [];
        try {
            const eventsResult = await c.env.DB.prepare(
                `SELECT delivery_id, event, action, created_at, response_status, response_message, error_details, payload_json
                 FROM gh_events
                 WHERE repo = ? AND pr_number = ? AND event IN ('pull_request_review_comment', 'issue_comment', 'pull_request_review')
                 ORDER BY created_at ASC`,
            )
                .bind(repoFullName, prNumber)
                .all();
            eventsRows = (eventsResult.results || []) as any[];
        } catch (error) {
            eventsRows = [];
        }

        const comments = eventsRows.map((row) => {
            const payload = safeJsonParse<any>(row.payload_json, {});
            const commentNode =
                row.event === "pull_request_review_comment"
                    ? payload.comment || null
                    : row.event === "issue_comment"
                    ? payload.comment || null
                    : row.event === "pull_request_review"
                    ? payload.review || null
                    : null;

            const body: string = commentNode?.body || "";
            const diffHunk: string | null = commentNode?.diff_hunk || null;

            const triggers = detectTriggersFromText(body);
            const suggestionAnalysis = detectSuggestionsFromBody(body, diffHunk);

            const colbyCommands = triggers
                .filter((trigger) => trigger.toLowerCase().startsWith("/colby"))
                .map((trigger) => {
                    const parsed = parseColbyCommand(trigger.toLowerCase());
                    return {
                        raw: trigger,
                        command: parsed.command,
                        args: parsed.args,
                    };
                });

            return {
                deliveryId: row.delivery_id,
                event: row.event,
                action: row.action,
                createdAt: row.created_at,
                responseStatus: row.response_status,
                responseMessage: row.response_message,
                errorDetails: row.error_details,
                commentId: commentNode?.id ?? null,
                inReplyToId: commentNode?.in_reply_to_id ?? null,
                user:
                    commentNode?.user?.login ??
                    payload.comment?.user?.login ??
                    payload.review?.user?.login ??
                    null,
                body,
                bodyPreview: body ? body.substring(0, 200) : "",
                htmlUrl: commentNode?.html_url ?? payload.review?.html_url ?? null,
                path: commentNode?.path ?? null,
                line: commentNode?.line ?? null,
                side: commentNode?.side ?? null,
                diffHunk,
                suggestions: suggestionAnalysis.suggestions,
                suggestionDetails: suggestionAnalysis.details,
                suggestionsCount: suggestionAnalysis.suggestions.length,
                triggers,
                colbyCommands,
            };
        });

        const summary = {
            totalEvents: comments.length,
            reviewComments: comments.filter((c) => c.event === "pull_request_review_comment").length,
            issueComments: comments.filter((c) => c.event === "issue_comment").length,
            prReviews: comments.filter((c) => c.event === "pull_request_review").length,
            commentsWithSuggestions: comments.filter((c) => c.suggestionsCount > 0).length,
            commentsWithCommands: comments.filter((c) => c.colbyCommands.length > 0).length,
        };

        return c.json({
            repo: repoFullName,
            prNumber,
            summary,
            comments,
        });
    } catch (error) {
        return c.json(
            {
                error: "Failed to load PR comment diagnostics",
                details: error instanceof Error ? error.message : String(error),
            },
            500,
        );
    }
});

/**
 * GET /colby/pr/:owner/:repo/:prNumber/commands
 * Summarize /colby command executions and operation progress for a PR.
 */
app.get("/colby/pr/:owner/:repo/:prNumber/commands", async (c: HonoContext) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const prParam = c.req.param("prNumber");
    const prNumber = Number(prParam);

    if (!owner || !repo || !prParam || Number.isNaN(prNumber)) {
        return c.json(
            {
                error: "Invalid parameters",
                details: "Provide owner, repo, and a numeric pull request number.",
            },
            400,
        );
    }

    const repoFullName = `${owner}/${repo}`;

    try {
        let commandRows: any[] = [];
        try {
            const commandResult = await c.env.DB.prepare(
                `SELECT id, delivery_id, repo, pr_number, author, command, command_args, status, result_data, error_message, started_at, completed_at, created_at
                 FROM colby_commands
                 WHERE repo = ? AND pr_number = ?
                 ORDER BY created_at DESC`,
            )
                .bind(repoFullName, prNumber)
                .all();
            commandRows = (commandResult.results || []) as any[];
        } catch (error) {
            commandRows = [];
        }

        const commands = commandRows.map((row: any) => {
            const commandArgs = safeJsonParse<Record<string, unknown> | null>(row.command_args, null);
            const resultData = safeJsonParse<Record<string, unknown> | null>(row.result_data, null);

            return {
                id: row.id,
                deliveryId: row.delivery_id,
                repo: row.repo,
                prNumber: row.pr_number,
                author: row.author,
                command: row.command,
                status: row.status,
                commandArgs,
                resultData,
                errorMessage: row.error_message || null,
                startedAt: row.started_at,
                completedAt: row.completed_at,
                createdAt: row.created_at,
            };
        });

        const summaryRecord: Record<
            string,
            {
                total: number;
                lastStatus: string | null;
                lastRunAt: number | null;
                lastDeliveryId: string | null;
                lastArgs: Record<string, unknown> | null;
                lastResult: Record<string, unknown> | null;
                lastError: string | null;
            }
        > = {};

        for (const commandName of KNOWN_COLBY_COMMANDS) {
            summaryRecord[commandName] = {
                total: 0,
                lastStatus: null,
                lastRunAt: null,
                lastDeliveryId: null,
                lastArgs: null,
                lastResult: null,
                lastError: null,
            };
        }

        for (const entry of commands) {
            const key = entry.command || "unknown";
            if (!summaryRecord[key]) {
                summaryRecord[key] = {
                    total: 0,
                    lastStatus: null,
                    lastRunAt: null,
                    lastDeliveryId: null,
                    lastArgs: null,
                    lastResult: null,
                    lastError: null,
                };
            }
            summaryRecord[key].total += 1;

            if (
                summaryRecord[key].lastRunAt === null ||
                (typeof entry.createdAt === "number" && entry.createdAt > summaryRecord[key].lastRunAt)
            ) {
                summaryRecord[key].lastRunAt = typeof entry.createdAt === "number" ? entry.createdAt : summaryRecord[key].lastRunAt;
                summaryRecord[key].lastStatus = entry.status;
                summaryRecord[key].lastDeliveryId = entry.deliveryId;
                summaryRecord[key].lastArgs = entry.commandArgs;
                summaryRecord[key].lastResult = entry.resultData;
                summaryRecord[key].lastError = entry.errorMessage;
            }
        }

        let operationRows: any[] = [];
        try {
            const operationsResult = await c.env.DB.prepare(
                `SELECT operation_id, operation_type, status, progress_percent, current_step, result_data, error_message, repo, pr_number, created_at, updated_at
                 FROM operation_progress
                 WHERE repo = ? AND (pr_number = ? OR pr_number IS NULL)
                 ORDER BY created_at DESC`,
            )
                .bind(repoFullName, prNumber)
                .all();
            operationRows = (operationsResult.results || []) as any[];
        } catch (error) {
            operationRows = [];
        }

        const operations = operationRows.map((row: any) => ({
            operationId: row.operation_id,
            type: row.operation_type,
            status: row.status,
            progressPercent: row.progress_percent,
            currentStep: row.current_step,
            repo: row.repo,
            prNumber: row.pr_number,
            resultData: safeJsonParse<Record<string, unknown> | null>(row.result_data, null),
            errorMessage: row.error_message || null,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        }));

        const summary = Object.entries(summaryRecord).map(([commandName, data]) => ({
            command: commandName,
            totalRuns: data.total,
            lastStatus: data.lastStatus,
            lastRunAt: data.lastRunAt,
            lastDeliveryId: data.lastDeliveryId,
            lastArgs: data.lastArgs,
            lastResult: data.lastResult,
            lastError: data.lastError,
        }));

        const missingCommands = summary
            .filter((item) => item.totalRuns === 0)
            .map((item) => item.command);

        return c.json({
            repo: repoFullName,
            prNumber,
            totals: {
                commandsExecuted: commands.length,
                operationsTracked: operations.length,
            },
            summary,
            missingCommands,
            commands,
            operations,
        });
    } catch (error) {
        return c.json(
            {
                error: "Failed to load PR command diagnostics",
                details: error instanceof Error ? error.message : String(error),
            },
            500,
        );
    }
});

/**
 * GET /colby/repo/:owner/:repo
 * Get repo-specific colby activity
 */
app.get("/colby/repo/:owner/:repo", async (c: HonoContext) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const repoFullName = `${owner}/${repo}`;

    try {
        // Get recent commands (with fallback)
        let commands = { results: [] };
        try {
            commands = await c.env.DB.prepare(`
        SELECT * FROM colby_commands
        WHERE repo = ?
        ORDER BY created_at DESC
        LIMIT 20
      `)
                .bind(repoFullName)
                .all();
        } catch (error) {
            // Table might not exist, continue with empty results
        }

        // Get best practices from this repo (with fallback)
        let practices = { results: [] };
        try {
            practices = await c.env.DB.prepare(`
        SELECT * FROM best_practices
        WHERE context_repo = ?
        ORDER BY created_at DESC
        LIMIT 20
      `)
                .bind(repoFullName)
                .all();
        } catch (error) {
            // Table might not exist, continue with empty results
        }

        // Get created issues (with fallback)
        let issues = { results: [] };
        try {
            issues = await c.env.DB.prepare(`
        SELECT * FROM colby_issues
        WHERE repo = ?
        ORDER BY created_at DESC
        LIMIT 20
      `)
                .bind(repoFullName)
                .all();
        } catch (error) {
            // Table might not exist, continue with empty results
        }

        return c.json({
            repo: repoFullName,
            commands: commands.results || [],
            bestPractices: practices.results || [],
            issues: issues.results || [],
        });
    } catch (error) {
        return c.json({ error: "Failed to fetch repo data" }, 500);
    }
});

/**
 * GET /api/repo/:owner/:repo/analysis
 * Get detailed AI analysis for a repository
 */
app.get("/api/repo/:owner/:repo/analysis", async (c: HonoContext) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const repoFullName = `${owner}/${repo}`;

    try {
        // Get repo data from database
        const repoData = await c.env.DB.prepare(`
            SELECT * FROM projects WHERE full_name = ?
        `).bind(repoFullName).first();

        if (!repoData) {
            return c.json({ error: "Repository not found" }, 404);
        }

        // Detect badges
        const badgeResult = await detectRepoBadges(repoData);
        
        // Get AI analysis
        const aiAnalyzer = new AIRepoAnalyzer(c.env.AI);
        const analysis = await aiAnalyzer.analyzeRepository(repoData, badgeResult.badges);
        
        // Generate action commands
        const commands = await aiAnalyzer.generateActionCommands(repoData, analysis);

        return c.json({
            repo: repoFullName,
            analysis,
            badges: badgeResult.badges,
            commands,
            timestamp: Date.now()
        });
    } catch (error) {
        console.error('Error analyzing repository:', error);
        return c.json({ error: "Failed to analyze repository" }, 500);
    }
});

/**
 * POST /api/repo/:owner/:repo/feedback
 * Record user feedback for a repository
 */
app.post("/api/repo/:owner/:repo/feedback", async (c: HonoContext) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const repoFullName = `${owner}/${repo}`;
    
    try {
        const body = await c.req.json();
        const { feedback, reasoning } = body;
        
        if (!feedback || !['like', 'dislike'].includes(feedback)) {
            return c.json({ error: "Invalid feedback type" }, 400);
        }

        const userPrefs = new UserPreferencesManager(c.env.USER_PREFERENCES);
        await userPrefs.recordRepoFeedback('default-user', repoFullName, feedback, reasoning);

        return c.json({ success: true });
    } catch (error) {
        console.error('Error recording feedback:', error);
        return c.json({ error: "Failed to record feedback" }, 500);
    }
});

/**
 * GET /openapi.json
 * OpenAPI 3.1.0 specification for custom GPT actions
 * Returns the comprehensive API specification from static file
 */
app.get("/openapi.json", async (c: HonoContext) => {
    // Serve the static OpenAPI specification file from assets
    try {
        const response = await c.env.ASSETS.fetch(new URL("/openapi.json", c.req.url));
        if (!response.ok) {
            throw new Error(`Failed to fetch OpenAPI spec: ${response.status}`);
        }
        // The response from c.env.ASSETS.fetch will have the correct
        // Content-Type, and the CORS middleware will add CORS headers without
        // overriding it. We can return the response directly.
        return response;
    } catch (error) {
        console.error("Error loading OpenAPI spec:", error);
        return c.json({ error: "Failed to load OpenAPI specification" }, 500);
    }
});

/**
 * GET /
 * Main dashboard UI
 */
app.get("/", async (c: HonoContext) => {
    return c.html(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Colby GitHub Bot - Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            background: #f6f8fa; 
            color: #24292e;
            line-height: 1.6;
        }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .header { 
            background: white; 
            border-radius: 8px; 
            padding: 30px; 
            margin-bottom: 20px; 
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            text-align: center;
        }
        .header h1 { color: #0366d6; margin-bottom: 10px; }
        .header p { color: #586069; font-size: 18px; }
        .nav { 
            background: white; 
            border-radius: 8px; 
            padding: 20px; 
            margin-bottom: 20px; 
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .nav-buttons { 
            display: flex; 
            gap: 10px; 
            flex-wrap: wrap; 
            justify-content: center;
        }
        .nav-btn { 
            background: #0366d6; 
            color: white; 
            border: none; 
            padding: 12px 24px; 
            border-radius: 6px; 
            cursor: pointer; 
            font-size: 14px;
            transition: background 0.2s;
        }
        .nav-btn:hover { background: #0256cc; }
        .nav-btn.active { background: #28a745; }
        .content { 
            background: white; 
            border-radius: 8px; 
            padding: 30px; 
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .stats-grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); 
            gap: 20px; 
            margin-bottom: 30px;
        }
        .stat-card { 
            background: #f8f9fa; 
            border: 1px solid #e1e4e8; 
            border-radius: 6px; 
            padding: 20px; 
            text-align: center;
        }
        .stat-number { 
            font-size: 2em; 
            font-weight: bold; 
            color: #0366d6; 
            margin-bottom: 5px;
        }
        .stat-label { color: #586069; font-size: 14px; }
        .btn { 
            background: #28a745; 
            color: white; 
            border: none; 
            padding: 10px 20px; 
            border-radius: 6px; 
            cursor: pointer; 
            font-size: 14px;
            margin: 5px;
        }
        .btn:hover { background: #218838; }
        .btn-secondary { background: #6c757d; }
        .btn-secondary:hover { background: #5a6268; }
        .loading { color: #586069; font-style: italic; }
        .error { color: #d73a49; background: #ffeef0; padding: 10px; border-radius: 6px; margin: 10px 0; }
        .success { color: #28a745; background: #f0fff4; padding: 10px; border-radius: 6px; margin: 10px 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 Colby GitHub Bot</h1>
            <p>AI-powered GitHub workflow automation and research platform</p>
        </div>
        
        <div class="nav">
            <div class="nav-buttons">
                <button class="nav-btn active" onclick="showTab('dashboard', event)">📊 Dashboard</button>
                <button class="nav-btn" onclick="showTab('operations', event)">⚡ Operations</button>
                <button class="nav-btn" onclick="showTab('commands', event)">🤖 Commands</button>
                <button class="nav-btn" onclick="showTab('practices', event)">📋 Best Practices</button>
                <button class="nav-btn" onclick="showTab('research', event)">🔬 Research</button>
                <button class="nav-btn" onclick="showTab('help', event)">❓ Help</button>
            </div>
        </div>
        
        <div class="content">
            <!-- Dashboard Tab -->
            <div id="dashboard" class="tab-content active">
                <h2>📊 Dashboard Overview</h2>
                <div class="stats-grid" id="stats-grid">
                    <div class="stat-card">
                        <div class="stat-number loading">Loading...</div>
                        <div class="stat-label">Total Commands</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number loading">Loading...</div>
                        <div class="stat-label">Active Operations</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number loading">Loading...</div>
                        <div class="stat-label">Repositories</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number loading">Loading...</div>
                        <div class="stat-label">Best Practices</div>
                    </div>
                </div>
                
                <div style="text-align: center; margin: 30px 0;">
                    <button class="btn" onclick="refreshStats()">🔄 Refresh Stats</button>
                    <button class="btn btn-secondary" onclick="showTab('research', event)">🚀 Run Research</button>
                </div>
            </div>
            
            <!-- Operations Tab -->
            <div id="operations" class="tab-content">
                <h2>⚡ Live Operations</h2>
                <div id="operations-content" class="loading">Loading operations...</div>
                <div style="text-align: center; margin: 20px 0;">
                    <button class="btn" onclick="refreshOperations()">🔄 Refresh</button>
                </div>
            </div>
            
            <!-- Commands Tab -->
            <div id="commands" class="tab-content">
                <h2>🤖 Recent Commands</h2>
                <div id="commands-content" class="loading">Loading commands...</div>
                <div style="text-align: center; margin: 20px 0;">
                    <button class="btn" onclick="refreshCommands()">🔄 Refresh</button>
                </div>
            </div>
            
            <!-- Best Practices Tab -->
            <div id="practices" class="tab-content">
                <h2>📋 Best Practices</h2>
                <div id="practices-content" class="loading">Loading best practices...</div>
                <div style="text-align: center; margin: 20px 0;">
                    <button class="btn" onclick="refreshPractices()">🔄 Refresh</button>
                </div>
            </div>
            
            <!-- Research Tab -->
            <div id="research" class="tab-content">
                <h2>🔬 Research & Analysis</h2>
                <div style="text-align: center; margin: 30px 0;">
                    <button class="btn" onclick="showResearchModal()">🚀 Run Research Sweep</button>
                    <button class="btn btn-secondary" onclick="window.open('/research/status', '_blank')">📊 Research Status</button>
                    <button class="btn btn-secondary" onclick="window.open('/research/results', '_blank')">📁 View Results</button>
                </div>
            </div>
            
            <!-- Help Tab -->
            <div id="help" class="tab-content">
                <h2>❓ Help & Documentation</h2>
                <div style="margin: 20px 0;">
                    <h3>Available Commands</h3>
                    <ul style="margin: 10px 0; padding-left: 20px;">
                        <li><code>/colby help</code> - Show all available commands</li>
                        <li><code>/colby implement</code> - Implement code suggestions from AI reviewers</li>
                        <li><code>/colby create issue</code> - Create an issue from a comment</li>
                        <li><code>/colby group comments by file</code> - Group PR comments by file and create issues</li>
                        <li><code>/colby resolve conflicts</code> - Help resolve merge conflicts</li>
                    </ul>
                </div>
                <div style="margin: 20px 0;">
                    <h3>Setup</h3>
                    <p>To set up the GitHub App, visit the <a href="/setup" target="_blank">setup page</a>.</p>
                </div>
            </div>
        </div>
    </div>

    <script>
        
        async function refreshStats() {
            const statsGrid = document.getElementById('stats-grid');
            statsGrid.innerHTML = '<div class="loading">Refreshing stats...</div>';
            
            try {
                const response = await fetch('/api/stats');
                const stats = await response.json();
                
                statsGrid.innerHTML = \`
                    <div class="stat-card">
                        <div class="stat-number">\${stats.commands || 0}</div>
                        <div class="stat-label">Total Commands</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">\${stats.operations || 0}</div>
                        <div class="stat-label">Active Operations</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">\${stats.repositories || 0}</div>
                        <div class="stat-label">Repositories</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">\${stats.practices || 0}</div>
                        <div class="stat-label">Best Practices</div>
                    </div>
                \`;
            } catch (error) {
                statsGrid.innerHTML = '<div class="error">Failed to load stats: ' + error.message + '</div>';
            }
        }
        
        async function refreshOperations() {
            const content = document.getElementById('operations-content');
            content.innerHTML = '<div class="loading">Loading operations...</div>';
            
            try {
                const response = await fetch('/api/operations');
                const html = await response.text();
                content.innerHTML = html;
            } catch (error) {
                content.innerHTML = '<div class="error">Failed to load operations: ' + error.message + '</div>';
            }
        }
        
        async function refreshCommands() {
            const content = document.getElementById('commands-content');
            content.innerHTML = '<div class="loading">Loading commands...</div>';
            
            try {
                const response = await fetch('/api/recent-activity');
                const html = await response.text();
                content.innerHTML = html;
            } catch (error) {
                content.innerHTML = '<div class="error">Failed to load commands: ' + error.message + '</div>';
            }
        }
        
        async function refreshPractices() {
            const content = document.getElementById('practices-content');
            content.innerHTML = '<div class="loading">Loading best practices...</div>';
            
            try {
                const response = await fetch('/colby/best-practices');
                const html = await response.text();
                content.innerHTML = html;
            } catch (error) {
                content.innerHTML = '<div class="error">Failed to load best practices: ' + error.message + '</div>';
            }
        }
        
        function showResearchModal() {
            alert('Research functionality coming soon! Use the Research Status and View Results buttons for now.');
        }
        
        // Load data when tabs are shown
        function showTab(tabName, event) {
            // Hide all tab contents
            const contents = document.querySelectorAll('.tab-content');
            contents.forEach(content => content.classList.remove('active'));
            
            // Remove active class from all nav buttons
            const buttons = document.querySelectorAll('.nav-btn');
            buttons.forEach(btn => btn.classList.remove('active'));
            
            // Show selected tab content
            document.getElementById(tabName).classList.add('active');
            
            // Add active class to clicked button
            if (event && event.target) {
                event.target.classList.add('active');
            }
            
            // Load data for the tab
            if (tabName === 'operations') {
                refreshOperations();
            } else if (tabName === 'commands') {
                refreshCommands();
            } else if (tabName === 'practices') {
                refreshPractices();
            }
        }
        
        // Load stats on page load
        document.addEventListener('DOMContentLoaded', refreshStats);
    </script>
</body>
</html>
    `);
});

// ===== DASHBOARD API ENDPOINTS =====

/**
 * GET /api/stats
 * Dashboard statistics
 */

/**
 * GET /api/recent-activity
 * Recent colby activity
 */
app.get("/api/recent-activity", async (c: HonoContext) => {
    try {
        const recent = await c.env.DB.prepare(`
      SELECT * FROM colby_commands
      ORDER BY created_at DESC
      LIMIT 10
    `).all();

        if (!recent.results || recent.results.length === 0) {
            return c.html('<div class="loading">No recent activity</div>');
        }

        const html = (recent.results as any[])
            .map((cmd) => {
                const timeAgo = new Date(cmd.created_at).toLocaleString();
                const statusClass = cmd.status;
                return `
        <div class="operation-item">
          <div class="operation-info">
            <h4>/${cmd.command}</h4>
            <div class="operation-meta">
              ${cmd.repo} • by @${cmd.author} • ${timeAgo}
            </div>
          </div>
          <div class="status ${statusClass}">${cmd.status}</div>
        </div>
      `;
            })
            .join("");

        return c.html(html);
    } catch (error) {
        return c.html('<div class="loading">Error loading activity</div>');
    }
});

/**
 * GET /api/operations
 * Live operations for dashboard
 */
app.get("/api/operations", async (c: HonoContext) => {
    try {
        // First, try to create the table if it doesn't exist
        try {
            await c.env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS operation_progress (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          operation_id TEXT NOT NULL UNIQUE,
          operation_type TEXT NOT NULL,
          repo TEXT NOT NULL,
          pr_number INTEGER,
          status TEXT NOT NULL DEFAULT 'started',
          current_step TEXT,
          progress_percent INTEGER DEFAULT 0,
          steps_total INTEGER,
          steps_completed INTEGER,
          error_message TEXT,
          result_data TEXT,
          created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
          updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
        )
      `).run();
        } catch (createError) {
            console.log("Operation progress table creation attempted:", createError);
        }

        // Get recent operations (last 24 hours) with more inclusive status filtering
        const operations = await c.env.DB.prepare(`
      SELECT * FROM operation_progress
      WHERE (status IN ('started', 'progress', 'queued') OR updated_at > ?)
      ORDER BY created_at DESC
      LIMIT 20
    `)
            .bind(Date.now() - 24 * 60 * 60 * 1000)
            .all();

                const ops = (operations.results || []) as any[];
                const accept = c.req.header("Accept") || "";

                if (accept.includes("application/json")) {
                        return c.json({
                                operations: ops.map((op) => ({
                                        id: op.operation_id,
                                        type: op.operation_type,
                                        repo: op.repo,
                                        status: op.status,
                                        progress: op.progress_percent,
                                        current_step: op.current_step,
                                        updated_at: op.updated_at,
                                })),
                        });
                }

                if (!ops.length) {
                        return c.html(`
        <div class="no-operations">
          <div style="text-align: center; padding: 40px; color: #586069;">
            <h3>No Active Operations</h3>
            <p>Operations will appear here when you use Colby commands in GitHub PRs or issues.</p>
            <p>Try using <code>/colby help</code> in a PR comment to get started!</p>
          </div>
        </div>
      `);
                }

                const html = ops
                        .map((op) => {
                                const progress = op.progress_percent || 0;
                                const statusClass =
                                        op.status === "started" || op.status === "progress" || op.status === "queued"
                                                ? "working"
                                                : op.status === "completed"
                                                        ? "completed"
                                                        : op.status === "failed"
                                                                ? "failed"
                                                                : "queued";

                                const timeAgo = op.updated_at ? Math.round((Date.now() - op.updated_at) / 1000) : 0;
                                const timeText =
                                        timeAgo < 60
                                                ? `${timeAgo}s ago`
                                                : timeAgo < 3600
                                                        ? `${Math.round(timeAgo / 60)}m ago`
                                                        : `${Math.round(timeAgo / 3600)}h ago`;

                                return `
        <div class="operation-item" onclick="showOperationDetail('${op.operation_id}')" style="cursor: pointer;">
          <div class="operation-info">
            <h4>${op.operation_type || 'Unknown Operation'}</h4>
            <div class="operation-meta">
              ${op.repo || 'Unknown Repo'}${op.pr_number ? ` • PR #${op.pr_number}` : ''} • ${op.current_step || "Initializing..."}
              <span style="color: #586069; font-size: 12px; margin-left: 10px;">${timeText}</span>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 10px;">
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${progress}%"></div>
            </div>
            <div class="status ${statusClass}">${op.status}</div>
          </div>
        </div>
      `;
                        })
                        .join("");

                return c.html(html);
        } catch (error) {
                console.error("Error fetching operations:", error);
                const accept = c.req.header("Accept") || "";
                if (accept.includes("application/json")) {
                        return c.json({ error: "Failed to load operations" }, 500);
                }
                return c.html(`
      <div class="error">
        <h3>Error Loading Operations</h3>
        <p>Failed to load operations: ${error instanceof Error ? error.message : String(error)}</p>
        <p>Check the console for more details.</p>
      </div>
    `);
        }
});

/**
 * GET /api/operations/:id
 * Get detailed information about a specific operation
 */
app.get("/api/operations/:id", async (c: HonoContext) => {
    try {
        const operationId = c.req.param('id');
        
        const operation = await c.env.DB.prepare(`
            SELECT * FROM operation_progress 
            WHERE operation_id = ?
        `).bind(operationId).first();

        if (!operation) {
            return c.json({ error: 'Operation not found' }, 404);
        }

        return c.json(operation);
    } catch (error) {
        console.error("Error fetching operation details:", error);
        return c.json({ error: 'Failed to fetch operation details' }, 500);
    }
});

/**
 * GET /api/operations/:id/logs
 * Get logs for a specific operation
 */
app.get("/api/operations/:id/logs", async (c: HonoContext) => {
    try {
        const operationId = c.req.param('id');
        const limit = parseInt(c.req.query('limit') || '100');
        
        const logs = await c.env.DB.prepare(`
            SELECT operation_id, log_level, message, details, timestamp
            FROM operation_logs
            WHERE operation_id = ?
            ORDER BY timestamp DESC
            LIMIT ?
        `).bind(operationId, limit).all();

        const formattedLogs = (logs.results as any[]).map(row => ({
            operationId: row.operation_id,
            level: row.log_level,
            message: row.message,
            details: row.details ? JSON.parse(row.details) : undefined,
            timestamp: row.timestamp,
            timeAgo: Math.round((Date.now() - row.timestamp) / 1000)
        }));

        return c.json({ logs: formattedLogs });
    } catch (error) {
        console.error("Error fetching operation logs:", error);
        return c.json({ error: 'Failed to fetch operation logs' }, 500);
    }
});

// New endpoint to trigger targeted research
app.post('/research', async (c) => {
  const { query, rounds = 5 } = await c.req.json<{ query: string; rounds?: number }>();
  if (!query) {
    return c.json({ error: 'Query is required' }, 400);
  }

  const id = c.env.RESEARCH_ORCHESTRATOR.newUniqueId();
  const stub = c.env.RESEARCH_ORCHESTRATOR.get(id);

  // Start the research in the background without waiting for it to complete
  // The DO will handle the long-running task.
  c.executionCtx.waitUntil(
    stub.fetch(new Request(`https://worker.local/start`, {
      method: 'POST',
      body: JSON.stringify({ query, rounds }),
      headers: { 'Content-Type': 'application/json' },
    }))
  );

  return c.json({
    message: 'Research task started.',
    taskId: id.toString(),
    statusUrl: `${c.req.url}/${id.toString()}`,
  });
});

// Endpoint to check research status
app.get('/research/:taskId', async (c) => {
    const { taskId } = c.req.param();
    const id = c.env.RESEARCH_ORCHESTRATOR.idFromString(taskId);
    const stub = c.env.RESEARCH_ORCHESTRATOR.get(id);
    const response = await stub.fetch(new Request(`https://worker.local/status`));
    return c.json(await response.json());
});


