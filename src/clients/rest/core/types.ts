import type { Logger } from '../../../util';

export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  reset?: number;
  used?: number;
}

export interface RestClientOptions {
  baseUrl?: string;
  token: string;
  defaultPerPage?: number;
  paginationSoftLimit?: number;
  timeoutMs?: number;
  requestTag?: string;
  logger?: Logger;
}

export interface InternalRestClientOptions extends RestClientOptions {
  baseUrl: string;
}

export interface RestRequestInit extends RequestInit {
  retry?: boolean;
}

export interface RestResponse<T> {
  data: T;
  response: Response;
}

export interface PaginationOptions {
  searchParams?: URLSearchParams;
  limit?: number;
}
