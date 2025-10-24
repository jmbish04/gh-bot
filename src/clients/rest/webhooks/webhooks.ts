import type { RestClient } from '../core/client';
import type { RepositoryIdentifier } from '../repos/repos';

export function listRepoWebhooks<T = unknown>(client: RestClient, params: RepositoryIdentifier): Promise<T> {
  const { owner, repo } = params;
  return client.request<T>(`/repos/${owner}/${repo}/hooks`);
}

export function createRepoWebhook<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & { config: Record<string, unknown>; events?: string[]; active?: boolean }
): Promise<T> {
  const { owner, repo, ...body } = params;
  return client.rest('POST', `/repos/${owner}/${repo}/hooks`, body);
}
