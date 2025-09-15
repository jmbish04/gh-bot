/**
 * Ensures a GitHub webhook exists for the specified repository.
 *
 * This function:
 * 1. Lists all webhooks on the given repository via the GitHub API.
 * 2. Checks if a webhook with the specified `hookUrl` already exists.
 * 3. Creates the webhook if it does not exist, subscribing to PR-related events.
 *
 * @param token  - GitHub personal access token with `admin:repo_hook` permission.
 * @param owner  - Owner (user or organization) of the target repository.
 * @param repo   - Name of the target repository.
 * @param hookUrl - The full URL GitHub should call when the webhook triggers.
 * @param secret - Shared secret used to verify webhook signatures.
 *
 * @returns `false` if the webhook already exists (no changes made),
 *          `true` if the webhook was successfully created.
 *
 * @throws {Error} If listing or creating the webhook fails.
 */
export async function ensureWebhook(
  token: string,
  owner: string,
  repo: string,
  hookUrl: string,
  secret: string,
): Promise<boolean> {
  // 1. List hooks
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Colby-GitHub-Bot/1.0'
    }
  })
  if (!r.ok) {
    const errorText = await r.text()
    console.error(`[WEBHOOK] Failed to list hooks for ${owner}/${repo}:`, {
      status: r.status,
      statusText: r.statusText,
      error: errorText
    })
    
    // If it's a 403 Forbidden, it means we don't have webhook permissions
    // This is not a critical error for research, so we'll return false and continue
    if (r.status === 403) {
      console.warn(`[WEBHOOK] No webhook permissions for ${owner}/${repo}, skipping webhook management`)
      return false
    }
    
    throw new Error(`Failed to list hooks for ${owner}/${repo}: ${r.status} ${r.statusText}`)
  }
  const hooks = await r.json() as Array<{ config?: { url?: string } }>

  // 2. See if it exists
  const exists = hooks.some((h: any) => h.config?.url === hookUrl)
  if (exists) return false // no change

  // 3. Create it
  const createRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Colby-GitHub-Bot/1.0'
    },
    body: JSON.stringify({
      name: 'web',
      active: true,
      events: ['pull_request', 'pull_request_review', 'pull_request_review_comment'],
      config: {
        url: hookUrl,
        content_type: 'json',
        secret,
      }
    })
  })
  if (!createRes.ok) {
    const errorText = await createRes.text()
    console.error(`[WEBHOOK] Failed to create webhook for ${owner}/${repo}:`, {
      status: createRes.status,
      statusText: createRes.statusText,
      error: errorText
    })
    
    // If it's a 403 Forbidden, it means we don't have webhook permissions
    if (createRes.status === 403) {
      console.warn(`[WEBHOOK] No webhook creation permissions for ${owner}/${repo}, skipping`)
      return false
    }
    
    throw new Error(`Failed to create webhook for ${owner}/${repo}: ${createRes.status} ${createRes.statusText}`)
  }
  return true // created
}