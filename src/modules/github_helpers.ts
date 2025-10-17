// DEPRECATED: replaced by src/github.ts (migrated incrementally).
import jwt from '@tsndr/cloudflare-worker-jwt'

type Env = {
  GITHUB_APP_ID: string
  GITHUB_PRIVATE_KEY: string
}

/**
 * Retrieves an installation token for a specific GitHub App installation.
 *
 * @param env - The environment bindings, including GitHub App credentials.
 * @param installationId - The ID of the GitHub App installation.
 * @returns The installation token for the specified installation.
 */
export async function getInstallationToken(env: Env, installationId: number) {
  console.log('[GITHUB] Getting installation token for ID:', installationId)

  const now = Math.floor(Date.now()/1000)
  const jwtToken = await jwt.sign(
    { iat: now - 60, exp: now + 9*60, iss: env.GITHUB_APP_ID },
    env.GITHUB_PRIVATE_KEY,
    { algorithm: 'RS256' }
  )

  console.log('[GITHUB] JWT created, calling GitHub API...')

  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwtToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Colby-GitHub-Bot/1.0'
    }
  })

  console.log('[GITHUB] GitHub API response:', {
    status: res.status,
    statusText: res.statusText,
    ok: res.ok
  })

  if (!res.ok) {
    const errorBody = await res.text().catch(() => 'Could not read error body')
    console.log('[GITHUB] ERROR response body:', errorBody)
    throw new Error(`install token failed: ${res.status} ${res.statusText} - ${errorBody}`)
  }

  const j: { token: string } = await res.json()
  console.log('[GITHUB] Installation token obtained successfully')
  return j.token
}

interface GraphQLResponse<T = any> {
  data?: T
  errors?: Array<{ message: string; [key: string]: any }>
}

export async function ghGraphQL<T = any>(token: string, query: string, variables?: any): Promise<GraphQLResponse<T>> {
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type':'application/json',
      'User-Agent': 'Colby-GitHub-Bot/1.0'
    },
    body: JSON.stringify({ query, variables })
  })
  return await r.json() as GraphQLResponse<T>
}

export async function ghREST(token: string, method: 'GET'|'POST'|'PATCH'|'PUT'|'DELETE', path: string, body?: any) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Colby-GitHub-Bot/1.0',
      ...(body ? { 'Content-Type':'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!r.ok) throw new Error(`${method} ${path} failed: ${r.status}`)
  return await r.json().catch(()=> ({}))
}

export async function getFileAtRef(token: string, owner: string, repo: string, path: string, ref: string) {
  // raw content at a commit
  const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`, {
    headers: {
      Authorization: `token ${token}`,
      'User-Agent': 'Colby-GitHub-Bot/1.0'
    }
  })
  if (!r.ok) return null
  return await r.text()
}

/**
 * Robust GitHub comment reply handler that automatically detects comment type and uses appropriate endpoint.
 * Fixes common 404 issues with POST /pulls/comments/{id}/replies by:
 * 1. Detecting if comment is a review comment vs issue comment
 * 2. Using correct auth header format for installation tokens
 * 3. Falling back to GraphQL for edge cases
 * 4. Gracefully handling different comment types
 */
export async function replyToGitHubComment({
  installationToken, owner, repo, prNumber, commentId, body
}: {
  installationToken: string
  owner: string
  repo: string
  prNumber: number
  commentId: number
  body: string
}) {
  console.log('[GITHUB] Attempting to reply to comment:', { owner, repo, prNumber, commentId })

  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const common = {
    method: 'POST',
    headers: {
      // IMPORTANT: installation tokens prefer 'token', not 'Bearer'
      Authorization: `token ${installationToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Colby-GitHub-Bot/1.0',
      'Content-Type': 'application/json',
    },
  };

  // 1) Is it a pull_request_review_comment?
  console.log('[GITHUB] Checking if comment is a review comment...')
  const reviewGet = await fetch(`${base}/pulls/comments/${commentId}`, {
    headers: { ...common.headers, method: undefined as any }
  });

  if (reviewGet.ok) {
    console.log('[GITHUB] Comment is a review comment, trying replies endpoint...')
    // 2) Try the replies endpoint
    const r = await fetch(`${base}/pulls/comments/${commentId}/replies`, {
      ...common,
      body: JSON.stringify({ body }),
    });

    if (r.ok) {
      console.log('[GITHUB] Successfully replied via REST replies endpoint')
      return await r.json();
    }

    console.log('[GITHUB] REST replies failed, falling back to GraphQL...')
    // 3) If it still fails (e.g., nested reply quirk), use GraphQL as a fallback
    const reviewJson = await reviewGet.json() as { node_id: string };
    const nodeId = reviewJson.node_id;
    const gql = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: common.headers,
      body: JSON.stringify({
        query: `
          mutation Reply($input: AddPullRequestReviewCommentInput!) {
            addPullRequestReviewComment(input: $input) {
              comment { id body replyTo { id } }
            }
          }
        `,
        variables: { input: { inReplyTo: nodeId, body } },
      }),
    });

    if (gql.ok) {
      const gqlResult = await gql.json() as {
        data?: {
          addPullRequestReviewComment?: {
            comment?: any
          }
        }
      };
      if (gqlResult.data?.addPullRequestReviewComment?.comment) {
        console.log('[GITHUB] Successfully replied via GraphQL fallback')
        return gqlResult.data.addPullRequestReviewComment.comment;
      }
    }

    const txt = await r.text();
    throw new Error(`Reply via REST failed (${r.status}). GraphQL failed too. REST: ${txt}`);
  }

  // 4) Maybe it's an issue comment on the PR body (no threads)
  console.log('[GITHUB] Not a review comment, checking if it\'s an issue comment...')
  const issueGet = await fetch(`${base}/issues/comments/${commentId}`, {
    headers: { ...common.headers, method: undefined as any }
  });

  if (issueGet.ok) {
    console.log('[GITHUB] Comment is an issue comment, posting to PR conversation...')
    const r = await fetch(`${base}/issues/${prNumber}/comments`, {
      ...common,
      body: JSON.stringify({ body }),
    });

    if (r.ok) {
      console.log('[GITHUB] Successfully posted to PR conversation')
      return await r.json();
    }

    const errorText = await r.text();
    throw new Error(`Posting PR issue comment failed: ${r.status} ${errorText}`);
  }

  // 5) Not found either way
  throw new Error(
    `Comment ${commentId} not found as review or issue comment (404). ` +
    `Verify id/repo/permissions.`
  );
}

export async function addReactionToComment({
  installationToken, owner, repo, commentId, content
}: {
  installationToken: string
  owner: string
  repo: string
  commentId: number
  content: string
}) {
  console.log('[GITHUB] Adding reaction to comment:', { owner, repo, commentId, content })

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`, {
    method: 'POST',
    headers: {
      Authorization: `token ${installationToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Colby-GitHub-Bot/1.0',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to add reaction: ${response.status} ${errorText}`)
  }

  console.log('[GITHUB] Successfully added reaction to comment')
  return await response.json()
}
