// src/modules/research.ts

import { GitHubClient, getFileAtRef } from '../github'

interface GitHubSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: any[];
}

interface GitHubSearchResult extends GitHubSearchResponse {
  rateLimitRemaining: number;
}

/**
 * Searches GitHub repositories using the provided query.
 *
 * @param token - The GitHub API token for authentication.
 * @param q - The search query string.
 * @param page - The page number for paginated results (default is 1).
 * @returns The search results and rate limit information.
 */
export async function ghSearchRepos(token: string, q: string, page=1): Promise<GitHubSearchResult> {
  const params = new URLSearchParams({ q, per_page: '30', page: String(page), sort: 'updated' })
  const client = new GitHubClient({ installationToken: token })
  const { data, response } = await client.restWithResponse<GitHubSearchResponse>(
    'GET',
    `/search/repositories?${params.toString()}`
  )
  const rateLimitRemaining = Number(response.headers.get('x-ratelimit-remaining') || '60')
  return { ...data, rateLimitRemaining }
}

/**
 * Collects signals from a repository, such as the presence of specific files or bindings.
 *
 * @param token - The GitHub API token for authentication.
 * @param repo - The repository object containing details like owner and name.
 * @returns An object containing various signals detected in the repository.
 */
export async function collectSignals(token: string, repo: any) {
  // lightweight signals: check for wrangler.toml, DO classes, D1 bindings
  const signals: any = {
    hasWrangler: false, hasDO: false, hasD1: false, hasWorkersAI: false, hasScheduled: false,
    workersSpecificity: 0
  }
  try {
    const txt = await getFileAtRef(token, repo.owner.login, repo.name, 'wrangler.toml', repo.default_branch)
    if (txt) {
      signals.hasWrangler = true
      if (/\[\[d1_databases\]\]/i.test(txt)) signals.hasD1 = true
      if (/durable_objects/i.test(txt)) signals.hasDO = true
      if (/triggers]\s*[\r\n]+crons/i.test(txt)) signals.hasScheduled = true
    }
  } catch {}
  // quick code peek
  try {
    const t = await getFileAtRef(token, repo.owner.login, repo.name, 'src/index.ts', repo.default_branch)
    if (t) {
      if (/DurableObject/.test(t)) signals.hasDO = true
      if (/\/ai\/run\//.test(t) || /@cloudflare\/ai/.test(t)) signals.hasWorkersAI = true
      if (/scheduled\s*\(/.test(t)) signals.hasScheduled = true
    }
  } catch {}
  signals.workersSpecificity = (signals.hasWrangler?1:0) + (signals.hasDO?0.3:0) + (signals.hasD1?0.2:0)
  return signals
}

export function scoreRepo(repo: any, s: any) {
  const starsNorm = Math.min((repo.stargazers_count || 0)/5000, 1)
  const pushed = Date.parse(repo.pushed_at || repo.updated_at || repo.created_at)
  const days = (Date.now() - pushed)/86400000
  const recency = days <= 30 ? 1 : days <= 90 ? 0.7 : 0.3
  const signalHits = (s.hasWrangler?1:0)+(s.hasDO?1:0)+(s.hasD1?1:0)+(s.hasWorkersAI?1:0)+(s.hasScheduled?1:0)
  const w1=0.35,w2=0.25,w3=0.25,w4=0.15
  return +(w1*starsNorm + w2*recency + w3*(signalHits/5) + w4*Math.min(s.workersSpecificity,1)).toFixed(3)
}

export async function upsertProject(DB: D1Database, repo:any, score:number, signals:any) {
  const existing = await DB.prepare('SELECT repo_id FROM projects WHERE repo_id=?').bind(repo.id).first()
  const topics = JSON.stringify(repo.topics||[])
  const now = Date.now()
  const lastCommitTs = Date.parse(repo.pushed_at||repo.updated_at||repo.created_at)||now
  if (!existing) {
    await DB.prepare(`
      INSERT INTO projects
        (repo_id, full_name, owner_login, html_url, description, default_branch, stars, forks, topics,
         last_commit_ts, created_at, updated_at, score, last_seen)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      repo.id, repo.full_name, repo.owner.login, repo.html_url, repo.description||'', repo.default_branch,
      repo.stargazers_count||0, repo.forks_count||0, topics, lastCommitTs, now, now, score, now
    ).run()
    signals._isNew = true
  } else {
    await DB.prepare(`
      UPDATE projects SET owner_login=?, stars=?, forks=?, topics=?, last_commit_ts=?, updated_at=?, score=?, last_seen=?
      WHERE repo_id=?
    `).bind(
      repo.owner.login,
      repo.stargazers_count||0, repo.forks_count||0, topics, lastCommitTs, now, score, now, repo.id
    ).run()
  }
}


export async function insertFinding(
  DB: D1Database,
  full_name: string,
  runId: number,
  query: string,
  signals: any
) {
  await DB.prepare(`
    INSERT INTO findings (repo_full_name, run_id, query, reason, signals_json, created_at)
    VALUES (?,?,?,?,?,?)
  `).bind(full_name, runId, query, 'matched query', JSON.stringify(signals), Date.now()).run()
}
