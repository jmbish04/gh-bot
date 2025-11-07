import { decodeBase64, encodePath } from '../core/utils';
import type { RestClient } from '../core/client';
import type { RepositoryIdentifier } from './repos';

export interface FileContentResponse {
  content: string;
  encoding: string;
  sha: string;
  path: string;
}

export function getContents<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & { path: string; ref?: string }
): Promise<T> {
  const { owner, repo, path, ref } = params;
  const encodedPath = encodePath(path);
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  return client.request<T>(`/repos/${owner}/${repo}/contents/${encodedPath}${query}`);
}

export async function getFile(
  client: RestClient,
  params: RepositoryIdentifier & { path: string; ref: string }
): Promise<{ content: string | null; sha?: string } | null> {
  try {
    const file = await getContents<FileContentResponse>(client, params);
    if (file.encoding !== 'base64') {
      return { content: String(file.content ?? ''), sha: file.sha };
    }
    return { content: decodeBase64(file.content), sha: file.sha };
  } catch (error) {
    if ((error as Error).name === 'GitHubHttpError' && (error as any).status === 404) {
      return null;
    }
    throw error;
  }
}

export function updateFile<T = unknown>(
  client: RestClient,
  params: RepositoryIdentifier & {
    path: string;
    message: string;
    content: string;
    sha?: string;
    branch?: string;
  }
): Promise<T> {
  const { owner, repo, path, ...body } = params;
  return client.rest('PUT', `/repos/${owner}/${repo}/contents/${encodePath(path)}`, body);
}
