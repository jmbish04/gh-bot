// src/modules/profiles.ts

/**
 * Inserts or updates a developer profile in the database.
 *
 * @param DB - The database instance for executing queries.
 * @param ownerLogin - The login of the developer or organization.
 * @param ownerType - The type of the owner (e.g., 'User' or 'Organization').
 */
export async function upsertDeveloperStub(
  DB: D1Database,
  ownerLogin: string,
  ownerType: 'User' | 'Organization' | string
) {
  await DB.prepare(`
    INSERT INTO developer_profiles (login, type, html_url, last_seen)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(login) DO UPDATE SET
      last_seen = excluded.last_seen,
      updated_at = excluded.last_seen
  `).bind(ownerLogin, ownerType || 'User', `https://github.com/${ownerLogin}`, Date.now()).run()
}

/**
 * Enqueues a scan for a repository owner with a specified priority.
 *
 * @param DB - The database instance for executing queries.
 * @param ownerLogin - The login of the repository owner.
 * @param priority - The priority of the scan (e.g., based on score).
 */
export async function enqueueOwnerScan(
  DB: D1Database,
  ownerLogin: string,
  priority: number // e.g., Math.round(score*10)
) {
  await DB.prepare(`
    INSERT INTO scan_queue (kind, key, priority)
    VALUES ('owner', ?, ?)
    ON CONFLICT(kind, key) DO NOTHING
  `).bind(ownerLogin, priority).run()
}