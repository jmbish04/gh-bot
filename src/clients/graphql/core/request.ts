import type { InternalGraphQLClientOptions } from './types';

export function composeGraphQLHeaders(
  options: InternalGraphQLClientOptions,
  input?: HeadersInit
): Headers {
  const headers = new Headers(input ?? {});
  const previews = options.previews?.length ? `${options.previews.join('+')}` : '';
  const accept = ['application/vnd.github+json'];
  if (previews) {
    accept.unshift(`application/vnd.github.${previews}-preview+json`);
  }
  headers.set('accept', accept.join(', '));
  headers.set('content-type', 'application/json');
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

export function graphqlEndpoint(options: InternalGraphQLClientOptions): URL {
  const base = new URL(`${options.baseUrl}/`);
  if (/\/api\/v3\/?$/.test(base.pathname)) {
    base.pathname = base.pathname.replace(/\/api\/v3\/?$/, '/api/graphql');
    return base;
  }

  base.pathname = `${base.pathname.replace(/\/$/, '')}/graphql`;
  return base;
}
