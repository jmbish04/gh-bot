import { requestJson } from './http';
import { resolveUrl } from './request';
import type { InternalRestClientOptions, PaginationOptions, RestResponse } from './types';

export async function collectPaginated<T>(
  options: InternalRestClientOptions,
  path: string,
  pagination: PaginationOptions = {}
): Promise<T[]> {
  const limit = pagination.limit ?? options.paginationSoftLimit ?? Number.POSITIVE_INFINITY;
  const collected: T[] = [];

  let nextUrl = resolveUrl(options, path);
  const params = new URLSearchParams(pagination.searchParams ?? '');
  if (!params.has('per_page') && options.defaultPerPage) {
    params.set('per_page', String(options.defaultPerPage));
  }
  if (params.toString()) {
    nextUrl.search = params.toString();
  }

  while (nextUrl && collected.length < limit) {
    const { data, response } = await requestJson<unknown>(nextUrl, options);
    if (!Array.isArray(data)) {
      throw new TypeError('Paginated GitHub responses must be arrays.');
    }

    for (const item of data as T[]) {
      collected.push(item);
      if (collected.length >= limit) {
        break;
      }
    }

    if (collected.length >= limit) {
      break;
    }

    const linkHeader = response.headers.get('link');
    const nextLink = parseLinkHeaderNext(linkHeader);
    nextUrl = nextLink ? new URL(nextLink) : null;
  }

  return collected.slice(0, limit);
}

export function parseLinkHeaderNext(header: string | null): string | null {
  if (!header) {
    return null;
  }

  const parts = header.split(',');
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match && match[2] === 'next') {
      return match[1];
    }
  }
  return null;
}

export async function paginate<T>(
  options: InternalRestClientOptions,
  path: string,
  init?: RequestInit
): Promise<RestResponse<T>> {
  const url = resolveUrl(options, path);
  return requestJson<T>(url, options, init);
}
