import type { RestClient } from '../core/client';

export interface RepositoryIdentifier {
  owner: string;
  repo: string;
}

export function getRepository<T = unknown>(client: RestClient, { owner, repo }: RepositoryIdentifier): Promise<T> {
  return client.request<T>(`/repos/${owner}/${repo}`);
}

export function listRepositoriesForInstallation<T = unknown>(
  client: RestClient
): Promise<{ total_count: number; repositories: T[] }> {
  return client.request<{ total_count: number; repositories: T[] }>(`/installation/repositories`);
}

export function updatePullRequest(
  client: RestClient,
  params: RepositoryIdentifier & { pull_number: number; body?: string; title?: string }
): Promise<any> {
  const { owner, repo, pull_number, ...rest } = params;
  return client.rest('PATCH', `/repos/${owner}/${repo}/pulls/${pull_number}`, rest);
}

export function createPullRequest(
  client: RestClient,
  params: RepositoryIdentifier & { title: string; head: string; base: string; body?: string }
): Promise<any> {
  const { owner, repo, ...body } = params;
  return client.rest('POST', `/repos/${owner}/${repo}/pulls`, body);
}

export function createTree(
  client: RestClient,
  params: RepositoryIdentifier & {
    base_tree: string;
    tree: Array<{ path: string; mode: string; type: string; content: string }>;
  }
): Promise<{ sha: string }> {
  const { owner, repo, ...body } = params;
  return client.rest('POST', `/repos/${owner}/${repo}/git/trees`, body);
}
