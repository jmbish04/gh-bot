import { GitHubHttpError } from '../../errors';
import type { RestClient } from '../core/client';
import type { RepositoryIdentifier } from '../repos/repos';

export function getPullRequest<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & { pull_number: number }
): Promise<T> {
  const { owner, repo, pull_number } = params;
  return client.request<T>(`/repos/${owner}/${repo}/pulls/${pull_number}`);
}

export function listPullRequestFiles<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & { pull_number: number }
): Promise<T[]> {
  const { owner, repo, pull_number } = params;
  return client.collectPaginated<T>(`/repos/${owner}/${repo}/pulls/${pull_number}/files`);
}

export function listPullRequestReviewComments<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & { pull_number: number }
): Promise<T[]> {
  const { owner, repo, pull_number } = params;
  return client.collectPaginated<T>(`/repos/${owner}/${repo}/pulls/${pull_number}/comments`);
}

export function getPullRequestReviewComment<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & { comment_id: number }
): Promise<T> {
  const { owner, repo, comment_id } = params;
  return client.request<T>(`/repos/${owner}/${repo}/pulls/comments/${comment_id}`);
}

export async function tryGetPullRequestReviewComment(
  client: RestClient,
  params: RepositoryIdentifier & { comment_id: number }
): Promise<{ node_id?: string } | null> {
  try {
    return await client.rest<{ node_id?: string }>('GET', `/repos/${params.owner}/${params.repo}/pulls/comments/${params.comment_id}`);
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export function replyToPullRequestReviewComment<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & { pull_number: number; in_reply_to: number; body: string }
): Promise<T> {
  const { owner, repo, pull_number, ...body } = params;
  return client.rest('POST', `/repos/${owner}/${repo}/pulls/${pull_number}/comments`, body);
}

export function replyToPullRequestReviewThread<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & { comment_id: number; body: string }
): Promise<T> {
  const { owner, repo, comment_id, body } = params;
  return client.rest('POST', `/repos/${owner}/${repo}/pulls/comments/${comment_id}/replies`, { body });
}

export async function ensureIssueCommentExists(
  client: RestClient,
  params: RepositoryIdentifier & { comment_id: number }
): Promise<void> {
  const { owner, repo, comment_id } = params;
  await client.rest('GET', `/repos/${owner}/${repo}/issues/comments/${comment_id}`);
}

export function replyToIssueComment<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & { pull_number: number; body: string }
): Promise<T> {
  const { owner, repo, pull_number, body } = params;
  return client.rest('POST', `/repos/${owner}/${repo}/issues/${pull_number}/comments`, { body });
}

export function addReactionToComment<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & { comment_id: number; content: string }
): Promise<T> {
  const { owner, repo, comment_id, content } = params;
  return client.rest(
    'POST',
    `/repos/${owner}/${repo}/issues/comments/${comment_id}/reactions`,
    { content },
    { headers: { accept: 'application/vnd.github+json' } }
  );
}

export function findOpenStandardizationPr(
  client: RestClient,
  params: RepositoryIdentifier
): Promise<Array<{ number: number; head: { ref: string }; body?: string | null }>> {
  const { owner, repo } = params;
  return client.request(`/repos/${owner}/${repo}/pulls?state=open&per_page=50`);
}
