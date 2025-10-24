import { GitHubHttpError } from '../../errors';
import type { RateLimitInfo } from './types';

export function parseRateLimit(headers: Headers): RateLimitInfo {
  return {
    limit: parseHeaderInt(headers.get('x-ratelimit-limit')),
    remaining: parseHeaderInt(headers.get('x-ratelimit-remaining')),
    reset: parseHeaderInt(headers.get('x-ratelimit-reset')),
    used: parseHeaderInt(headers.get('x-ratelimit-used')),
  };
}

export async function ensureOk(response: Response, requestUrl: string): Promise<void> {
  if (response.ok) {
    return;
  }

  const text = await response.text();
  const body = text ? safeParseJSON(text) : undefined;
  throw new GitHubHttpError(
    `GitHub request failed with status ${response.status}`,
    response.status,
    requestUrl,
    body,
    response.headers
  );
}

export function safeParseJSON<T = unknown>(text: string): T | string {
  try {
    return JSON.parse(text) as T;
  } catch {
    return text;
  }
}

function parseHeaderInt(value: string | null): number | undefined {
  if (value == null) {
    return undefined;
  }
  const num = Number.parseInt(value, 10);
  return Number.isNaN(num) ? undefined : num;
}
