import type { RestClient } from '../core/client';
import type { RepositoryIdentifier } from './repos';

export function getBranch<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & { branch: string }
): Promise<T> {
  const { owner, repo, branch } = params;
  return client.request<T>(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
}

export async function getBranchSha(
  client: RestClient,
  params: RepositoryIdentifier & { branch: string }
): Promise<string> {
  const data = await getBranch<{ commit?: { sha?: string } }>(client, params);
  const sha = data?.commit?.sha;
  if (!sha) {
    throw new Error(`Branch ${params.branch} did not include a commit SHA.`);
  }
  return sha;
}

export function createBranch<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & { ref: string; sha: string }
): Promise<T> {
  const { owner, repo, ...body } = params;
  return client.rest('POST', `/repos/${owner}/${repo}/git/refs`, body);
}

export function updateRef<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & { ref: string; sha: string; force?: boolean }
): Promise<T> {
  const { owner, repo, ref, ...body } = params;
  const normalizedRef = ref.replace(/^refs\//, '');
  return client.rest('PATCH', `/repos/${owner}/${repo}/git/refs/${encodeURIComponent(normalizedRef)}`, body);
}
