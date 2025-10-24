import type { InternalRestClientOptions } from './types';

export function resolveUrl(options: InternalRestClientOptions, path: string): URL {
  try {
    return new URL(path);
  } catch {
    const base = `${options.baseUrl.replace(/\/$/, '')}/`;
    const url = new URL(path.replace(/^[#?]/, ''), base);
    return url;
  }
}

export function resolveGraphqlUrl(options: InternalRestClientOptions): URL {
  const base = new URL(`${options.baseUrl}/`);
  if (/\/api\/v3\/?$/.test(base.pathname)) {
    base.pathname = base.pathname.replace(/\/api\/v3\/?$/, '/api/graphql');
    return base;
  }

  base.pathname = `${base.pathname.replace(/\/$/, '')}/graphql`;
  return base;
}

export function composeHeaders(options: InternalRestClientOptions, input?: HeadersInit): Headers {
  const headers = new Headers(input ?? {});
  headers.set('accept', 'application/vnd.github+json');
  if (!headers.has('authorization')) {
    headers.set('authorization', `Bearer ${options.token}`);
  }
  if (options.requestTag) {
    headers.set('x-request-tag', options.requestTag);
  }
  if (!headers.has('user-agent')) {
    headers.set('user-agent', 'gh-bot-client');
  }
  return headers;
}
