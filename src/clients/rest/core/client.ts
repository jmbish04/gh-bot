import { requestJson } from './http';
import { collectPaginated } from './pagination';
import { resolveUrl } from './request';
import type { InternalRestClientOptions, PaginationOptions, RestRequestInit, RestResponse } from './types';

export class RestClient {
  public readonly options: InternalRestClientOptions;

  constructor(options: InternalRestClientOptions) {
    this.options = options;
  }

  public async request<T>(path: string, init?: RestRequestInit): Promise<T> {
    const url = resolveUrl(this.options, path);
    const { data } = await requestJson<T>(url, this.options, init);
    return data;
  }

  public async requestWithResponse<T>(path: string, init?: RestRequestInit): Promise<RestResponse<T>> {
    const url = resolveUrl(this.options, path);
    return requestJson<T>(url, this.options, init);
  }

  public async rest<T>(method: string, path: string, body?: unknown, init?: RestRequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    let requestBody = init?.body;

    if (body !== undefined) {
      headers.set('content-type', 'application/json');
      requestBody = JSON.stringify(body);
    }

    return this.request<T>(path, {
      ...init,
      method,
      headers,
      body: requestBody,
    });
  }

  public async restWithResponse<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: RestRequestInit
  ): Promise<RestResponse<T>> {
    const headers = new Headers(init?.headers);
    let requestBody = init?.body;

    if (body !== undefined) {
      headers.set('content-type', 'application/json');
      requestBody = JSON.stringify(body);
    }

    return this.requestWithResponse<T>(path, {
      ...init,
      method,
      headers,
      body: requestBody,
    });
  }

  public collectPaginated<T>(path: string, pagination?: PaginationOptions): Promise<T[]> {
    return collectPaginated<T>(this.options, path, pagination);
  }
}
