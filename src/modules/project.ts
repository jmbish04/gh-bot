// src/modules/projects.ts
/**
 * Fetches existing repository IDs from the database to avoid redundant queries.
 *
 * @param DB - The database instance for executing queries.
 * @param ids - An array of repository IDs to check.
 * @returns A set of existing repository IDs.
 */
export async function getExistingRepoIds(DB: D1Database, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set()
  const MAX_PARAMS = 500; // keep well under SQLite's 999 param limit
  const seen = new Set<number>()
  for (let i = 0; i < ids.length; i += MAX_PARAMS) {
    const chunk = ids.slice(i, i + MAX_PARAMS)
    const placeholders = chunk.map(() => '?').join(',')
    const { results } = await DB
      .prepare(`SELECT repo_id FROM projects WHERE repo_id IN (${placeholders})`)
      .bind(...chunk)
      .all()
    for (const r of results || []) seen.add(Number(r.repo_id))
  }
  return seen
}