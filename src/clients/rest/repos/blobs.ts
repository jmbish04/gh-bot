import type { RestClient } from '../core/client';
import type { RepositoryIdentifier } from './repos';

export interface BlobResponse {
  content: string;
  encoding: string;
}

export function getBlob<T = BlobResponse>(
  client: RestClient,
  params: RepositoryIdentifier & { sha: string }
): Promise<T> {
  const { owner, repo, sha } = params;
  return client.request<T>(`/repos/${owner}/${repo}/git/blobs/${sha}`);
}
