import type { RestClient } from '../core/client';

export interface SearchParams {
  per_page?: number;
  page?: number;
  sort?: string;
  order?: 'asc' | 'desc';
}

function buildSearchParams(query: string, params: SearchParams): URLSearchParams {
  const searchParams = new URLSearchParams();
  searchParams.set('q', query);
  if (params.per_page != null) {
    searchParams.set('per_page', String(params.per_page));
  }
  if (params.page != null) {
    searchParams.set('page', String(params.page));
  }
  if (params.sort) {
    searchParams.set('sort', params.sort);
  }
  if (params.order) {
    searchParams.set('order', params.order);
  }
  return searchParams;
}

export function search<T = unknown>(
  client: RestClient,
  endpoint: 'code' | 'commits' | 'issues' | 'repositories' | 'users',
  query: string,
  params: SearchParams = {}
): Promise<T> {
  const searchParams = buildSearchParams(query, params);
  return client.request<T>(`/search/${endpoint}?${searchParams.toString()}`);
}

export function searchRepositories<T = unknown>(
  client: RestClient,
  query: string,
  params: SearchParams = {}
): Promise<T> {
  return search<T>(client, 'repositories', query, params);
}

export function searchCode<T = unknown>(client: RestClient, query: string, params: SearchParams = {}): Promise<T> {
  return search<T>(client, 'code', query, params);
}

export function searchIssues<T = unknown>(client: RestClient, query: string, params: SearchParams = {}): Promise<T> {
  return search<T>(client, 'issues', query, params);
}

export function searchUsers<T = unknown>(client: RestClient, query: string, params: SearchParams = {}): Promise<T> {
  return search<T>(client, 'users', query, params);
}
