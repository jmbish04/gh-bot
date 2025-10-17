/// <reference types="@cloudflare/workers-types" />

import { getGeminiModel } from './gemini';
import { GitHubClient, getFileAtRef, getInstallationToken, listInstallations, listReposForInstallation } from './github';
// Existing Imports
import { saveSummaries, summarizeRepo2 } from './modules/ai_research';
import { OperationLogger } from './modules/operation_logger';
import { enqueueOwnerScan, upsertDeveloperStub } from './modules/profiles';
import { getExistingRepoIds } from './modules/projects';
import { analyzeRepoCode, isRepoAnalysisStale } from './modules/repo_analyzer';
// New Agentic Research Imports
import { runTargetedResearch } from './agents/research_agent';
import { collectSignals, ghSearchRepos, insertFinding, scoreRepo, upsertProject } from './modules/research';

// Merged Environment Type
type Env = {
  DB: D1Database;
  RESEARCH_ORCH: DurableObjectNamespace;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_TOKEN?: string;
  WEBHOOK_URL: string;
  GITHUB_WEBHOOK_SECRET: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  SUMMARY_CF_MODEL: string;
  AI: any;
  // New Bindings
  GEMINI_API_KEY: string;
  SEB: SendEmail;
};

// --- Top-Level Functions ---

export async function doResearch(env: Env, queries?: string[]) {
  const orch = env.RESEARCH_ORCH.get(env.RESEARCH_ORCH.idFromName('research-orchestrator'));
  const resp = await orch.fetch(
    new Request('https://do.colby.com/run', {
      method: 'POST',
      body: JSON.stringify({ queries }),
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  if (!resp.ok) throw new Error(`Research orchestrator failed: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

export async function doResearchStatus(env: Env) {
  const orch = env.RESEARCH_ORCH.get(env.RESEARCH_ORCH.idFromName('research-orchestrator'));
  const resp = await orch.fetch(new Request('https://do.colby.com/status'));
  if (!resp.ok) throw new Error(`Research orchestrator status failed: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

export async function doResearchRun(env: Env, queries?: string[]) {
  const orch = env.RESEARCH_ORCH.get(env.RESEARCH_ORCH.idFromName('research-orchestrator'));
  const resp = await orch.fetch(
    new Request('https://do.colby.com/run', {
      method: 'POST',
      body: JSON.stringify({ queries }),
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  if (!resp.ok) throw new Error(`Research run failed: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

// --- Durable Object Class ---

export class ResearchOrchestrator {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request) {
    const url = new URL(req.url);

    // --- ROUTING FOR NEW TARGETED RESEARCH ---
    if (url.pathname === '/start' && req.method === 'POST') {
      const { query, rounds } = (await req.json()) as { query: string; rounds: number };
      const taskId = this.state.id.toString();

      await this.state.storage.put('taskType', 'targeted');
      await this.state.storage.put('query', query);
      await this.state.storage.put('status', 'pending');

      // Run in the background
      this.state.waitUntil(this.runTargetedResearch(taskId, query, rounds));

      return new Response(JSON.stringify({ status: 'started', taskId }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/status' && (await this.state.storage.get('taskType')) === 'targeted') {
      const query = await this.state.storage.get('query');
      const dbQuery = this.env.DB.prepare('SELECT * FROM research_tasks WHERE id = ?').bind(this.state.id.toString());
      const taskInfo = await dbQuery.first();
      const resultsQuery = this.env.DB.prepare('SELECT repo_url, ai_analysis, is_relevant FROM research_results WHERE task_id = ?').bind(
        this.state.id.toString(),
      );
      const results = await resultsQuery.all();

      return Response.json({
        taskId: this.state.id.toString(),
        query,
        status: taskInfo?.status,
        results: results.results,
      });
    }

    // --- ROUTING FOR EXISTING BROAD SWEEP RESEARCH ---
    if (url.pathname === '/run' && req.method === 'POST') {
      const body = (await req.json()) as { queries?: string[] };
      const running = await this.state.storage.get<boolean>('running');
      if (running) return new Response('already running', { status: 409 });

      await this.state.storage.put('running', true);
      await this.state.storage.put('taskType', 'sweep');

      this.state.waitUntil(
        this.runSweep(body.queries).catch(async (error) => {
          console.error('Research sweep failed:', error);
          await this.state.storage.put('running', false);
          await this.state.storage.put('status', {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            finished_at: Date.now(),
          });
        }),
      );
      return new Response('started', { status: 202 });
    }

    if (url.pathname === '/status' && (await this.state.storage.get('taskType')) === 'sweep') {
      const st = await this.state.storage.get<any>('status');
      return Response.json(st || { status: 'idle' });
    }

    // --- COMMON UTILITY ENDPOINTS ---
    if (url.pathname === '/reset' && req.method === 'POST') {
      await this.state.storage.deleteAll();
      return Response.json({ status: 'reset' });
    }

    if (url.pathname === '/debug') {
      try {
        const queries = await getDefaultQueries(this.env.DB);
        return Response.json({
          databaseAccess: 'OK',
          defaultQueries: queries,
          queriesCount: queries.length,
          env: { hasDB: !!this.env.DB, hasAI: !!this.env.AI },
        });
      } catch (error) {
        return Response.json({
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          }, { status: 500 });
      }
    }

    return new Response('Not found or invalid route for this durable object.', { status: 404 });
  }

  private async runTargetedResearch(taskId: string, query: string, rounds: number) {
    await this.env.DB.prepare('INSERT INTO research_tasks (id, query, status) VALUES (?, ?, ?)')
      .bind(taskId, query, 'pending')
      .run();

    const token = this.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN is required to run targeted research.');
    }
    const ghClient = new GitHubClient({ personalAccessToken: token });
    const aiModel = getGeminiModel(this.env);

    await runTargetedResearch(this.env.DB, ghClient, aiModel, taskId, query, rounds);
  }

  private async updateOperationProgress(operationId: string, status: string, currentStep: string, progressPercent: number) {
    try {
      await this.env.DB.prepare(
        `UPDATE operation_progress SET status = ?, current_step = ?, progress_percent = ?, updated_at = ? WHERE operation_id = ?`,
      )
        .bind(status, currentStep, progressPercent, Date.now(), operationId)
        .run();
    } catch (error) {
      console.error('Failed to update operation progress:', error);
    }
  }

  private async runSweep(overrideQueries?: string[]) {
    const started_at = Date.now();
    const operationId = `research-${started_at}`;
    const logger = new OperationLogger(this.env, operationId);

    try {
      await this.env.DB.prepare(
        `INSERT INTO operation_progress (operation_id, operation_type, repo, status, current_step, progress_percent, steps_total, steps_completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(operationId, 'research', 'all_repos', 'started', 'Initializing research sweep', 0, 100, 0, started_at, started_at).run();
      await logger.info('Research sweep initialized', { operationId, started_at });
    } catch (error: any) {
      console.error('Failed to create operation progress record:', error);
      await logger.error('Failed to create operation progress record', { error: error?.message ?? String(error) });
    }

    await this.state.storage.put('status', { status: 'running', started_at, operationId });
    let runId: number | null = null;
    try {
      const queries = overrideQueries ?? (await getDefaultQueries(this.env.DB));
      await logger.info('Starting research run', { queries: queries.length, customQueries: !!overrideQueries });

      const { meta } = await this.env.DB.prepare('INSERT INTO research_runs (started_at,status,queries_json) VALUES (?,?,?)')
        .bind(started_at, 'running', JSON.stringify(queries)).run();
      runId = meta.last_row_id;
      await logger.info('Research run recorded in database', { runId });

      await this.updateOperationProgress(operationId, 'progress', 'Getting GitHub installations', 10);
      const installations = await listInstallations(this.env);
      const installationList = Array.isArray(installations) ? installations : [];
      await logger.info('GitHub installations retrieved', { count: installationList.length });

      await this.updateOperationProgress(operationId, 'progress', `Processing ${installationList.length} installations`, 20);

      for (const inst of installationList) {
        await logger.info('Processing installation', { installationId: inst.id, account: inst.account?.login });
        const token = await getInstallationToken(this.env, inst.id);
        
        // This part of the logic seems to process repos from the installation, which is different from searching.
        // I'll leave this as-is but note that the daily discovery would likely use a global search token.
        // For the sweep, processing installed repos makes sense.

        for (const q of queries) {
          await logger.info('Processing search query', { query: q });
          let page = 1;
          let totalFound = 0;
          do {
            const batch = await ghSearchRepos(token, q, page);
            if (!batch.items?.length) break;
            
            const newRepos = await this.processRepoBatch(batch.items, runId!, q, token, logger);
            totalFound += newRepos.length;
            
            page += 1;
            await this.backoff(batch.rateLimitRemaining);
          } while (page <= 5); // Limit to 5 pages per query for now

          await logger.info('Search query completed', { query: q, totalFound });
        }
      }

      await logger.info('Research sweep completed successfully', { runId, totalQueries: queries.length });
      await this.env.DB.prepare('UPDATE research_runs SET finished_at=?, status=? WHERE id=?').bind(Date.now(), 'success', runId).run();
      await this.updateOperationProgress(operationId, 'completed', 'Research sweep completed successfully', 100);
      await this.state.storage.put('status', { status: 'success', started_at, finished_at: Date.now() });
    } catch (e: any) {
      console.error('Research sweep error:', e);
      await logger.error('Research sweep failed', { error: e?.message || e, stack: e?.stack });
      if (runId) {
        await this.env.DB.prepare('UPDATE research_runs SET finished_at=?, status=?, notes=? WHERE id=?').bind(Date.now(), 'error', String(e?.message || e), runId).run();
      }
      await this.updateOperationProgress(operationId, 'error', `Error: ${String(e?.message || e)}`, 0);
      await this.state.storage.put('status', { status: 'error', error: String(e?.message || e), started_at });
    } finally {
      await this.state.storage.put('running', false);
    }
  }

  private async processRepoBatch(repos: any[], runId: number, query: string, token: string, logger: OperationLogger): Promise<any[]> {
    const allIds = repos.map((r) => r.id);
    const existing = await getExistingRepoIds(this.env.DB, allIds);
    const newRepos = repos.filter((r) => !existing.has(r.id));
    
    // Touch existing repos to update their `last_seen` timestamp
    if (existing.size > 0) {
        const existingIds = allIds.filter(id => existing.has(id));
        const placeholders = existingIds.map(() => '?').join(',');
        await this.env.DB.prepare(`UPDATE projects SET last_seen = CURRENT_TIMESTAMP WHERE repo_id IN (${placeholders})`).bind(...existingIds).run();
    }

    for (const repo of newRepos) {
        await logger.debug('Processing new repository', { repo: repo.full_name });
        const signals = await collectSignals(token, repo);
        const score = scoreRepo(repo, signals);
        
        await upsertProject(this.env.DB, repo, score, signals);
        await insertFinding(this.env.DB, repo.full_name, runId, query, signals);
        await upsertDeveloperStub(this.env.DB, repo.owner.login, repo.owner.type || 'User');
        await enqueueOwnerScan(this.env.DB, repo.owner.login, Math.round(score * 10));

        const looksVague = !repo.description || repo.description.length < 20 || /[\u0400-\u9FFF]/.test(repo.description || '');
        if (looksVague && await isRepoAnalysisStale(this.env, repo.full_name)) {
            try {
                await analyzeRepoCode(this.env, { token, owner: repo.owner.login, repo: repo.name, ref: repo.default_branch });
            } catch (e) { console.error(`Failed to analyze ${repo.full_name}:`, e); }
        }

        if (score >= 0.75) {
            const readme = await fetchReadme(token, repo.owner.login, repo.name, repo.default_branch);
            const { short, long } = await summarizeRepo2(this.env as any, { repo, readme, signals });
            await saveSummaries(this.env.DB, repo.full_name, short, long);
        }
    }
    return newRepos;
  }
  
  private async backoff(rem?: number) {
    if (rem !== undefined && rem < 10) await sleep(2000);
  }
}

// --- Helper Functions ---

async function fetchReadme(token: string, owner: string, repo: string, branch: string) {
  const content = await getFileAtRef(token, owner, repo, 'README.md', branch);
  return content ?? '';
}

/**
 * Fetches active default queries from the D1 database.
 * @param db - The D1 Database instance.
 * @returns An array of query strings.
 */
async function getDefaultQueries(db: D1Database): Promise<string[]> {
  try {
    const { results } = await db.prepare('SELECT query FROM default_queries WHERE is_active = 1').all<{ query: string }>();
    return results ? results.map(row => row.query) : [];
  } catch (error) {
    console.error("Failed to fetch default queries from D1, returning empty array:", error);
    // As a fallback, you could return a minimal hardcoded list, but for now, we'll return empty.
    return [];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

