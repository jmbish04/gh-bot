/// <reference types="@cloudflare/workers-types" />
// src/do_research.ts
import { saveSummaries, summarizeRepo2 } from './modules/ai_research'
import { getInstallationToken, listInstallations, listReposForInstallation } from './modules/github'
import { enqueueOwnerScan, upsertDeveloperStub } from './modules/profiles'
import { getExistingRepoIds } from './modules/projects'
import { analyzeRepoCode, isRepoAnalysisStale } from './modules/repo_analyzer'
import { collectSignals, ghSearchRepos, insertFinding, scoreRepo, upsertProject } from './modules/research'
import { OperationLogger } from './modules/operation_logger'



type Env = {
  DB: D1Database
  RESEARCH_ORCH: DurableObjectNamespace
  GITHUB_APP_ID: string
  GITHUB_PRIVATE_KEY: string
  WEBHOOK_URL: string
  GITHUB_WEBHOOK_SECRET: string
  CF_ACCOUNT_ID: string
  CF_API_TOKEN: string
  SUMMARY_CF_MODEL: string
  AI: any
}
export async function doResearch(env: Env, queries?: string[]) {
  const orch = env.RESEARCH_ORCH.get(env.RESEARCH_ORCH.idFromName('research-orchestrator'))
  const resp = await orch.fetch(new Request('https://example.com/run', {
    method: 'POST',
    body: JSON.stringify({ queries }),
    headers: { 'Content-Type': 'application/json' }
  }))
  if (!resp.ok) throw new Error(`Research orchestrator failed: ${resp.status} ${resp.statusText}`)
  return resp.json()
}
export async function doResearchStatus(env: Env) {
  const orch = env.RESEARCH_ORCH.get(env.RESEARCH_ORCH.idFromName('research-orchestrator'))
  const resp = await orch.fetch(new Request('https://example.com/status'))
  if (!resp.ok) throw new Error(`Research orchestrator status failed: ${resp.status} ${resp.statusText}`)
  return resp.json()
}
export async function doResearchRun(env: Env, queries?: string[]) {
  const orch = env.RESEARCH_ORCH.get(env.RESEARCH_ORCH.idFromName('research-orchestrator'))
  const resp = await orch.fetch(new Request('https://example.com/run', {
    method: 'POST',
    body: JSON.stringify({ queries }),
    headers: { 'Content-Type': 'application/json' }
  }))
  if (!resp.ok) throw new Error(`Research run failed: ${resp.status} ${resp.statusText}`)
  return resp.json()
}

export class ResearchOrchestrator {
  state: DurableObjectState
  env: Env
  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(req: Request) {
    const url = new URL(req.url)
    if (url.pathname === '/run' && req.method === 'POST') {
      const body = await req.json() as { queries?: string[] }
      const running = await this.state.storage.get<boolean>('running')
      if (running) return new Response('already running', { status: 202 })

      await this.state.storage.put('running', true)
      
      // Run the sweep and handle errors properly
      this.state.waitUntil(
        this.runSweep(body.queries).catch(async (error) => {
          console.error('Research sweep failed:', error)
          await this.state.storage.put('running', false)
          await this.state.storage.put('status', { 
            status: 'error', 
            error: error instanceof Error ? error.message : String(error),
            finished_at: Date.now()
          })
        })
      )
      return new Response('started', { status: 202 })
    }
    if (url.pathname === '/status') {
      const st = await this.state.storage.get<any>('status')
      return Response.json(st || { status: 'idle' })
    }
    if (url.pathname === '/reset' && req.method === 'POST') {
      await this.state.storage.put('running', false)
      await this.state.storage.put('status', { status: 'idle' })
      return Response.json({ status: 'reset' })
    }
    if (url.pathname === '/debug') {
      try {
        // Test database access
        const testResult = await this.env.DB.prepare('SELECT 1 as test').first()
        const operationCount = await this.env.DB.prepare('SELECT COUNT(*) as count FROM operation_progress').first()
        const logCount = await this.env.DB.prepare('SELECT COUNT(*) as count FROM operation_logs').first()
        
        // Test creating an operation progress record
        const testOperationId = `test-${Date.now()}`
        const testResult2 = await this.env.DB.prepare(`
          INSERT OR REPLACE INTO operation_progress (
            operation_id, operation_type, repo, status, current_step, 
            progress_percent, steps_total, steps_completed, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          testOperationId, 'test', 'test-repo', 'started', 'Testing database access',
          0, 100, 0, Date.now(), Date.now()
        ).run()
        
        // Test defaultQueries function
        const queries = defaultQueries()
        
        return Response.json({
          databaseAccess: 'OK',
          testQuery: testResult,
          operationCount: operationCount,
          logCount: logCount,
          testOperationCreated: testResult2,
          testOperationId: testOperationId,
          defaultQueries: queries,
          queriesCount: queries.length,
          env: {
            hasDB: !!this.env.DB,
            hasAI: !!this.env.AI
          }
        })
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          env: {
            hasDB: !!this.env.DB,
            hasAI: !!this.env.AI
          }
        }, { status: 500 })
      }
    }
    return new Response('not found', { status: 404 })
  }

  private async updateOperationProgress(operationId: string, status: string, currentStep: string, progressPercent: number) {
    try {
      await this.env.DB.prepare(`
        UPDATE operation_progress 
        SET status = ?, current_step = ?, progress_percent = ?, updated_at = ?
        WHERE operation_id = ?
      `).bind(status, currentStep, progressPercent, Date.now(), operationId).run()
    } catch (error) {
      console.error('Failed to update operation progress:', error)
    }
  }

  private async runSweep(overrideQueries?: string[]) {
    const started_at = Date.now()
    const operationId = `research-${started_at}`
    
    // Initialize logger
    const logger = new OperationLogger(this.env, operationId)
    
    // Create operation progress record
    try {
      await this.env.DB.prepare(`
        INSERT OR REPLACE INTO operation_progress (
          operation_id, operation_type, repo, status, current_step, 
          progress_percent, steps_total, steps_completed, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        operationId, 'research', 'all_repos', 'started', 'Initializing research sweep',
        0, 100, 0, started_at, started_at
      ).run()
      
      await logger.info('Research sweep initialized', { operationId, started_at })
    } catch (error: any) {
      console.error('Failed to create operation progress record:', error);
      await logger.error('Failed to create operation progress record', { error: error?.message ?? String(error) });
      // Don't abort the sweep if we fail to create the progress record - continue anyway
    }

    await this.state.storage.put('status', { status: 'running', started_at, operationId });
    let runId: number | null = null;
    try {
      console.log(`[RESEARCH] Getting queries for operation ${operationId}`)
      const queries = overrideQueries ?? defaultQueries()
      console.log(`[RESEARCH] Got ${queries.length} queries for operation ${operationId}`)
      await logger.info('Starting research run', { queries: queries.length, customQueries: !!overrideQueries })
      
      // record run
      const { meta } = await this.env.DB.prepare(
        'INSERT INTO research_runs (started_at,status,queries_json) VALUES (?,?,?)'
      ).bind(started_at, 'running', JSON.stringify(queries)).run()
      runId = meta.last_row_id
      await logger.info('Research run recorded in database', { runId })

      // Update progress: Getting installations
      await this.updateOperationProgress(operationId, 'progress', 'Getting GitHub installations', 10)
      await logger.info('Fetching GitHub installations')
      
      const installations = await listInstallations(this.env)
      const installationList = Array.isArray(installations) ? installations : []
      await logger.info('GitHub installations retrieved', { count: installationList.length })
      
      // Update progress: Processing installations
      await this.updateOperationProgress(operationId, 'progress', `Processing ${installationList.length} installations`, 20)
      
      for (const inst of installationList) {
        await logger.info('Processing installation', { installationId: inst.id, account: inst.account?.login })
        const token = await getInstallationToken(this.env, inst.id)

        // Get repositories for this installation
        const repos = await listReposForInstallation(token)
        await logger.info('Repositories retrieved for installation', { 
          installationId: inst.id, 
          repoCount: repos.length 
        })
        
        // Update progress: Processing repositories
        await this.updateOperationProgress(operationId, 'progress', `Processing ${repos.length} repositories`, 30)

        for (const q of queries) {
          await logger.info('Processing search query', { query: q })
          let page = 1
          let totalFound = 0
          do {
            const batch = await ghSearchRepos(token, q, page)
            if (!batch.items?.length) break
            const pageRepos = batch.items as any[]
            const allIds = pageRepos.map(r => r.id)
            const existing = await getExistingRepoIds(this.env.DB, allIds)
            const newRepos = pageRepos.filter(r => !existing.has(r.id))
            
            await logger.debug('Search batch processed', { 
              query: q, 
              page, 
              totalInBatch: pageRepos.length, 
              newRepos: newRepos.length,
              existingRepos: existing.size
            })
            
            totalFound += newRepos.length

            // Touch existing to refresh last_seen cheaply
            if (existing.size) {
              const MAX_PARAMS = 500
              for (let i = 0; i < allIds.length; i += MAX_PARAMS) {
                const chunk = allIds.slice(i, i + MAX_PARAMS).filter(id => existing.has(id))
                if (!chunk.length) continue
                const placeholders = chunk.map(()=>'?').join(',')
                await this.env.DB.prepare(
                  `UPDATE projects SET last_seen=?, updated_at=? WHERE repo_id IN (${placeholders})`
                ).bind(Date.now(), Date.now(), ...chunk).run()
              }
            }

            for (const repo of newRepos) {
              await logger.debug('Processing new repository', { 
                repo: repo.full_name, 
                description: repo.description?.substring(0, 100) + '...' 
              })
              
              const signals = await collectSignals(token, repo)
              const score = scoreRepo(repo, signals)
              await logger.debug('Repository signals collected', { 
                repo: repo.full_name, 
                score, 
                signals: {
                  hasWrangler: signals.hasWrangler,
                  hasDO: signals.hasDO,
                  hasD1: signals.hasD1,
                  hasR2: signals.hasR2,
                  hasKV: signals.hasKV
                }
              })
              
              await upsertProject(this.env.DB, repo, score, signals)
              await insertFinding(this.env.DB, repo.full_name, runId!, q, signals)
              await upsertDeveloperStub(this.env.DB, repo.owner.login, repo.owner.type || 'User')
              await enqueueOwnerScan(this.env.DB, repo.owner.login, Math.round(score * 10))

              // Check if repo looks vague or needs AI analysis
              const looksVague = (!repo.description || repo.description.length < 20)
                || (!signals.hasWrangler && !signals.hasDO && !signals.hasD1)
                || /[\u0400-\u9FFF]/.test(repo.description || '') // quick non-Latin heuristic

              if (looksVague && await isRepoAnalysisStale(this.env, repo.full_name)) {
                try {
                  await analyzeRepoCode(this.env, {
                    token,
                    owner: repo.owner.login,
                    repo: repo.name,
                    ref: repo.default_branch
                  })
                } catch (e) {
                  // don't crash the sweep; keep going
                  console.error(`Failed to analyze ${repo.full_name}:`, e)
                }
              }

              if (score >= 0.75) {
                const readme = await fetchReadme(token, repo.owner.login, repo.name, repo.default_branch)
                const { short, long } = await summarizeRepo2(this.env as any, { repo, readme, signals })
                await saveSummaries(this.env.DB, repo.full_name, short, long)
              }
            }
            page += 1
            await this.backoff(batch.rateLimitRemaining)
          } while (page <= 5)
          
          await logger.info('Search query completed', { query: q, totalFound })
        }
      }

      await logger.info('Research sweep completed successfully', { runId, totalQueries: queries.length })
      await this.env.DB.prepare('UPDATE research_runs SET finished_at=?, status=? WHERE id=?')
        .bind(Date.now(), 'success', runId).run()
      
      // Update operation progress: Completed
      await this.updateOperationProgress(operationId, 'completed', 'Research sweep completed successfully', 100)
      
      await this.state.storage.put('status', { status: 'success', started_at, finished_at: Date.now() })
    } catch (e:any) {
      console.error('Research sweep error:', e)
      console.error('Research sweep error stack:', e?.stack)
      await logger.error('Research sweep failed', { error: e?.message || e, stack: e?.stack })
      
      if (runId) {
        await this.env.DB.prepare('UPDATE research_runs SET finished_at=?, status=?, notes=? WHERE id=?')
          .bind(Date.now(), 'error', String(e?.message || e), runId).run()
      }
      
      // Update operation progress: Error
      await this.updateOperationProgress(operationId, 'error', `Error: ${String(e?.message || e)}`, 0)
      
      await this.state.storage.put('status', { status: 'error', error: String(e?.message || e), started_at })
    } finally {
      await this.state.storage.put('running', false)
    }
  }

  private async backoff(rem?: number) {
    if (rem !== undefined && rem < 10) await this.state.waitUntil(sleep(2000))
  }
}

// simple helper replicating index.ts readme fetch
async function fetchReadme(token: string, owner: string, repo: string, branch: string) {
  const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`, {
    headers: { Authorization: `token ${token}` }
  })
  if (res.ok) return await res.text()
  return ''
}

function defaultQueries(): string[] {
  return [
    'topic:cloudflare-workers',
    '"wrangler.toml" path:/',
    '"compatibility_date" language:toml',
    '"DurableObject" language:typescript',
    '"[[d1_databases]]" wrangler.toml',
    '"@cloudflare/ai" language:typescript',
    '"scheduled(event" language:typescript',
    '"import { Hono" language:typescript',
    // Add specific queries for your accounts
    'user:jmbish04',
    'user:jmbish04 "wrangler.toml"',
    'user:jmbish04 "DurableObject"'
  ]
}
const sleep = (ms:number)=> new Promise(r=>setTimeout(r,ms))
