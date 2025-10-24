import type { RestClient } from '../core/client';
import type { RepositoryIdentifier } from '../repos/repos';

export function listIssues<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & { state?: 'open' | 'closed' | 'all' }
): Promise<T[]> {
  const { owner, repo, state } = params;
  const searchParams = new URLSearchParams();
  if (state) {
    searchParams.set('state', state);
  }
  const query = searchParams.toString();
  const path = `/repos/${owner}/${repo}/issues${query ? `?${query}` : ''}`;
  return client.collectPaginated<T>(path);
}

export function getIssue<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & { issue_number: number }
): Promise<T> {
  const { owner, repo, issue_number } = params;
  return client.request<T>(`/repos/${owner}/${repo}/issues/${issue_number}`);
}

export function createIssue<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & { title: string; body?: string; labels?: string[] }
): Promise<T> {
  const { owner, repo, ...body } = params;
  return client.rest('POST', `/repos/${owner}/${repo}/issues`, body);
}

export function listIssueComments<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & { issue_number: number }
): Promise<T[]> {
  const { owner, repo, issue_number } = params;
  return client.collectPaginated<T>(`/repos/${owner}/${repo}/issues/${issue_number}/comments`);
}
