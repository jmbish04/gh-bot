import jwt from '@tsndr/cloudflare-worker-jwt';
import { GitHubHttpError } from '../../errors';
import { safeParseJSON } from '../core/response';
import type { GitHubEnv } from '../../../types/github-env';
import type { GitHubAppRequestOptions } from './types';

export async function createGitHubAppJwt(env: GitHubEnv): Promise<string> {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY ?? env.GITHUB_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new Error('GitHub App credentials are required to mint an app JWT.');
  }

  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iat: now - 60, exp: now + 9 * 60, iss: appId }, privateKey, { algorithm: 'RS256' });
}

export async function listInstallations<T = unknown>(
  env: GitHubEnv,
  options: GitHubAppRequestOptions = {}
): Promise<T> {
  const appJwt = await createGitHubAppJwt(env);
  const url = new URL('/app/installations', `${resolveBaseUrl(options.baseUrl)}/`);
  const response = await fetch(url, {
    headers: buildAppHeaders(appJwt, options),
  });

  if (!response.ok) {
    const text = await response.text();
    const parsed = text ? safeParseJSON(text) : undefined;
    throw new GitHubHttpError(
      `GitHub request failed with status ${response.status}`,
      response.status,
      response.url,
      parsed,
      response.headers
    );
  }

  const text = await response.text();
  return text ? (safeParseJSON<T>(text) as T) : (([] as unknown) as T);
}

export async function getInstallationToken(
  env: GitHubEnv,
  installationId: number,
  options: GitHubAppRequestOptions = {}
): Promise<string> {
  const appJwt = await createGitHubAppJwt(env);
  const url = new URL(`/app/installations/${installationId}/access_tokens`, `${resolveBaseUrl(options.baseUrl)}/`);

  const headers = buildAppHeaders(appJwt, options);
  headers.set('content-type', 'application/json');

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const text = await response.text();
    const parsed = text ? safeParseJSON(text) : undefined;
    throw new GitHubHttpError(
      `GitHub request failed with status ${response.status}`,
      response.status,
      response.url,
      parsed,
      response.headers
    );
  }

  const text = await response.text();
  const data = text ? safeParseJSON<{ token?: string }>(text) : {};
  if (typeof data === 'object' && data && typeof (data as any).token === 'string') {
    return (data as any).token as string;
  }
  throw new Error('GitHub installation token response did not include a token.');
}

function resolveBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
}

function buildAppHeaders(appJwt: string, options: GitHubAppRequestOptions): Headers {
  const headers = new Headers();
  headers.set('accept', 'application/vnd.github+json');
  headers.set('authorization', `Bearer ${appJwt}`);
  headers.set('user-agent', 'gh-bot-client');
  if (options.requestTag) {
    headers.set('x-request-tag', options.requestTag);
  }
  return headers;
}
