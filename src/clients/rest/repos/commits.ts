import type { RestClient } from '../core/client';
import type { RepositoryIdentifier } from './repos';

export function getCommit<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & { sha: string }
): Promise<T> {
  const { owner, repo, sha } = params;
  return client.request<T>(`/repos/${owner}/${repo}/git/commits/${sha}`);
}

export function createCommit<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & { message: string; tree: string; parents: string[] }
): Promise<T> {
  const { owner, repo, ...body } = params;
  return client.rest('POST', `/repos/${owner}/${repo}/git/commits`, body);
}
