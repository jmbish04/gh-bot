// DEPRECATED: replaced by src/github.ts (migrated incrementally).
import { Octokit } from '@octokit/rest';
import jwt from '@tsndr/cloudflare-worker-jwt'; // small JWT for Workers

type Env = {
  GITHUB_APP_ID: string
  GITHUB_PRIVATE_KEY: string
}

/**
 * Lists all installations of the GitHub App.
 *
 * @param env - The environment bindings, including GitHub App credentials.
 * @returns An array of installations for the GitHub App.
 */
export async function listInstallations(env: Env) {
  const appJwt = await mintAppJWT(env)
  const r = await fetch('https://api.github.com/app/installations', {
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Colby-GitHub-Bot/1.0'
    }
  })
  const data = await r.json()

  // Narrow the type of 'data'
  if (typeof data === "object" && data !== null) {
    const typedData = data as { key: string }; // Adjust type as needed
  }

  return data || []
}

/**
 * Retrieves an installation token for a specific GitHub App installation.
 *
 * @param env - The environment bindings, including GitHub App credentials.
 * @param installationId - The ID of the GitHub App installation.
 * @returns The installation token for the specified installation.
 */
export async function getInstallationToken(env: Env, installationId: number) {
  const appJwt = await mintAppJWT(env)
  const r = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Colby-GitHub-Bot/1.0'
    }
  })
  const data = await r.json()
  if (typeof data === 'object' && data !== null && 'token' in data && typeof data.token === 'string') {
    return data.token
  }
  throw new Error('Invalid response: token not found')
}

/**
 * Lists repositories accessible to a GitHub App installation.
 *
 * Uses the GitHub REST endpoint `GET /installation/repositories` and returns a
 * simplified array of repository metadata (subset of fields).
 *
 * @param installationToken - A GitHub App installation access token (NOT the app private key).
 * Must have permissions to read the repositories for that installation.
 *
 * @returns Promise resolving to an array of repository descriptors containing:
 * - id: Repository numeric identifier
 * - full_name: "owner/name"
 * - default_branch: The repository's default branch
 * - visibility: Visibility (e.g. "public", "private", "internal")
 * - description: Repository description (may be null)
 * - topics: Array of repository topics (if provided by the API)
 * - owner.login: Owner account login
 * - name: Short repository name
 *
 * @throws Will reject if:
 * - Network request fails
 * - The response body cannot be parsed as JSON
 *
 * @remarks
 * - The function does not currently check `r.ok`; non-2xx responses will still be
 *   parsed and may yield unexpected shapes or missing data.
 * - Consider enhancing with error handling and pagination (if needed in future APIs).
 * - Does not perform runtime validation of the returned JSON structure.
 *
 * @see https://docs.github.com/rest/apps/installations#list-repositories-accessible-to-the-app-installation
 */
export async function listReposForInstallation(installationToken: string) {
  const r = await fetch('https://api.github.com/installation/repositories', {
    headers: {
      Authorization: `token ${installationToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Colby-GitHub-Bot/1.0'
    }
  })
  const data = await r.json()
  if (typeof data === 'object' && data !== null && 'repositories' in data && Array.isArray((data as any).repositories)) {
    return (data.repositories as any[]).map((x: any) => ({
    id: x.id,
    full_name: x.full_name,
    default_branch: x.default_branch,
    visibility: x.visibility,
    description: x.description,
    topics: x.topics,
    owner: { login: x.owner.login },
    }))
  }
  throw new Error('Invalid response: repositories not found')
}

// If you still want “searchGithub” like in your file, keep the same signature
/**
 * Performs a GitHub search request (issues, commits, repositories, or users) using an installation (App) token.
 *
 * Wraps Octokit's `search.*` endpoints and returns only the `.data` payload from the API response.
 *
 * @param installationToken - A GitHub App installation access token used to authenticate the request.
 * @param endpoint - The search domain to query. One of:
 *  - 'issues'        → Uses `octo.search.issuesAndPullRequests`
 *  - 'commits'       → Uses `octo.search.commits`
 *  - 'repositories'  → Uses `octo.search.repos`
 *  - 'users'         → Uses `octo.search.users`
 * @param q - The GitHub search query string. Must follow the syntax required by the chosen endpoint
 *            (e.g. `repo:owner/name is:pr is:open label:bug` for issues/PRs).
 * @param extra - Optional additional search parameters (e.g. `per_page`, `page`, `sort`, `order`).
 *                These are spread into the underlying Octokit call. Avoid passing a `q` key here as it
 *                would be overridden by the explicit `q` parameter.
 *
 * @returns The `.data` portion of the Octokit search response, whose shape depends on the endpoint:
 *  - issues: `SearchIssuesAndPullRequestsResponseData`
 *  - commits: `SearchCommitsResponseData`
 *  - repositories: `SearchReposResponseData`
 *  - users: `SearchUsersResponseData`
 *
 * @throws Error If an unsupported endpoint value is provided.
 *
 * @example
 * // Search open pull requests with the "bug" label in a repository:
 * const prs = await searchGithub(token, 'issues', 'repo:acme/widgets is:pr is:open label:bug', { per_page: 50 });
 *
 * @example
 * // Search repositories matching a topic, sorted by stars:
 * const repos = await searchGithub(token, 'repositories', 'topic:observability language:typescript', {
 *   sort: 'stars',
 *   order: 'desc',
 *   per_page: 10
 * });
 *
 * @example
 * // Search users located in Berlin:
 * const users = await searchGithub(token, 'users', 'type:user location:Berlin', { per_page: 30 });
 *
 * @example
 * // Search commits authored by a user in a repo:
 * const commits = await searchGithub(token, 'commits', 'repo:acme/widgets author:octocat', { per_page: 25 });
 */
export async function searchGithub(installationToken: string, endpoint: 'issues'|'commits'|'repositories'|'users', q: string, extra: Record<string, any> = {}) {
  const octo = new Octokit({ auth: installationToken, request: { fetch } as any })
  if (endpoint === 'issues') return (await octo.search.issuesAndPullRequests({ q, ...extra })).data
  if (endpoint === 'commits') return (await octo.search.commits({ q, ...extra })).data
  if (endpoint === 'repositories') return (await octo.search.repos({ q, ...extra })).data
  if (endpoint === 'users') return (await octo.search.users({ q, ...extra })).data
  throw new Error('Unsupported endpoint')
}

async function mintAppJWT(env: Env) {
  const now = Math.floor(Date.now()/1000)
  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: env.GITHUB_APP_ID
  }
  return await jwt.sign(payload, env.GITHUB_PRIVATE_KEY, { algorithm: 'RS256' })
}