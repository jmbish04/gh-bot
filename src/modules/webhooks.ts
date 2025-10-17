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
import { ghREST, GitHubHttpError } from '../github'

export async function ensureWebhook(
  token: string,
  owner: string,
  repo: string,
  hookUrl: string,
  secret: string,
): Promise<boolean> {
  try {
    const hooks = await ghREST(token, 'GET', `/repos/${owner}/${repo}/hooks`) as Array<{ config?: { url?: string } }>

    const exists = hooks.some((h: any) => h.config?.url === hookUrl)
    if (exists) return false // no change

    await ghREST(token, 'POST', `/repos/${owner}/${repo}/hooks`, {
      name: 'web',
      active: true,
      events: ['pull_request', 'pull_request_review', 'pull_request_review_comment'],
      config: {
        url: hookUrl,
        content_type: 'json',
        secret,
      }
    })
    return true // created
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status === 403) {
      console.warn(`[WEBHOOK] No webhook permissions for ${owner}/${repo}, skipping webhook management`)
      return false
    }
    throw error
  }
}