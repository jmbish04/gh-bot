import type { RestClient } from '../core/client';
import type { RepositoryIdentifier } from './repos';

export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

export async function listTree<T = TreeEntry>(
  client: RestClient,
  params: RepositoryIdentifier & { sha: string; recursive?: boolean }
): Promise<T[]> {
  const { owner, repo, sha, recursive } = params;
  const query = recursive ? '?recursive=1' : '';
  const response = await client.request<{ tree: T[] }>(
    `/repos/${owner}/${repo}/git/trees/${sha}${query}`
  );
  return response.tree;
}
