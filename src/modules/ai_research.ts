import { runAI } from "./ai";

// src/modules/ai_research.ts
/**
 * Summarizes a repository for an internal catalog using AI.
 *
 * @param env - The environment bindings, including AI model configurations.
 * @param param1 - An object containing the repository, its README, and signals.
 * @returns An object containing a short and long summary of the repository.
 */
export async function summarizeRepo2(env: any, { repo, readme, signals }: any) {
  const base = `Summarize a Cloudflare Workers repo for an internal catalog.
Output TWO parts:
[SHORT] one sentence, <140 chars, plain text.
[LONG] 4–7 lines: purpose, key tech (DO/D1/AI/cron/etc), notable endpoints, why interesting.
Signals: ${JSON.stringify(signals)}
Repo: ${repo.full_name}
Desc: ${repo.description||'-'}
README (truncated):\n${(readme||'').slice(0,6000)}`
  const result: any = await runAI({ env, model: env.SUMMARY_CF_MODEL, payload: { prompt: base } })
  const text = result?.response || ''
  const short = (text.match(/\[SHORT\](.*)/)?.[1] || text.split('\n')[0] || '').trim().slice(0,140)
  const long = (text.split('[LONG]')[1] || text).trim()
  return { short, long }
}

/**
 * Saves the generated summaries to the database.
 *
 * @param DB - The database instance for executing queries.
 * @param full_name - The full name of the repository (e.g., "owner/repo").
 * @param short - The short summary of the repository.
 * @param long - The long summary of the repository.
 */
export async function saveSummaries(DB: D1Database, full_name: string, short: string, long: string) {
  await DB.prepare('UPDATE projects SET short_summary=?, long_summary=? WHERE full_name=?')
    .bind(short, long, full_name).run()
}
