import type { RestClient } from '../core/client';
import type { RepositoryIdentifier } from '../repos/repos';

export function listWorkflows<T = unknown>(client: RestClient, params: RepositoryIdentifier): Promise<T> {
  const { owner, repo } = params;
  return client.request<T>(`/repos/${owner}/${repo}/actions/workflows`);
}
