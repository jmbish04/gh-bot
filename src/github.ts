// TODO(ch2): integrate methods and app refactors in next chunk
/**
 * A thin, centralized GitHub API client used across the worker runtime.
 *
 * The client wraps GitHub's REST and GraphQL endpoints to provide consistent
 * error handling, pagination support, and authorization. Authentication favors
 * GitHub App installation tokens when provided because they offer scoped,
 * ephemeral credentials. If an installation token is absent, a personal access
 * token can be used instead. All outgoing requests include the appropriate
 * Authorization header and default to GitHub's canonical REST base URL unless a
 * custom Enterprise Server origin is supplied.
 */

export interface GitHubClientOptions {
  installationToken?: string;
  personalAccessToken?: string;
  baseUrl?: string;
  defaultPerPage?: number;
  paginationSoftLimit?: number;
  timeoutMs?: number;
  requestTag?: string;
}

interface InternalGitHubClientOptions extends GitHubClientOptions {
  baseUrl: string;
  token: string;
}

/**
 * Error thrown when a GitHub REST request resolves with a non-2xx status code.
 */
export class GitHubHttpError extends Error {
  public readonly status: number;
  public readonly url: string;
  public readonly body: unknown;
  public readonly rateLimit: {
    limit?: number;
    remaining?: number;
    reset?: number;
    used?: number;
  };
  public readonly requestId?: string | null;

  constructor(
    message: string,
    status: number,
    url: string,
    body: unknown,
    headers: Headers
  ) {
    super(message);
    this.name = 'GitHubHttpError';
    this.status = status;
    this.url = url;
    this.body = body;
    this.rateLimit = {
      limit: parseHeaderInt(headers.get('x-ratelimit-limit')),
      remaining: parseHeaderInt(headers.get('x-ratelimit-remaining')),
      reset: parseHeaderInt(headers.get('x-ratelimit-reset')),
      used: parseHeaderInt(headers.get('x-ratelimit-used')),
    };
    this.requestId = headers.get('x-github-request-id');
  }
}

export interface GraphQLErrorPayload {
  message: string;
  [key: string]: unknown;
}

/**
 * Error thrown when GitHub's GraphQL API returns an `errors` payload.
 */
export class GitHubGraphQLError extends Error {
  public readonly errors: GraphQLErrorPayload[];
  public readonly requestId?: string | null;

  constructor(message: string, errors: GraphQLErrorPayload[], requestId?: string | null) {
    super(message);
    this.name = 'GitHubGraphQLError';
    this.errors = errors;
    this.requestId = requestId;
  }
}

/**
 * A reusable client for GitHub REST and GraphQL APIs.
 */
export class GitHubClient {
  private readonly options: InternalGitHubClientOptions;

  constructor(options: GitHubClientOptions = {}) {
    const token = selectToken(options);
    if (!token) {
      throw new Error('GitHubClient requires an installationToken or personalAccessToken.');
    }

    const baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/$/, '');

    this.options = {
      ...options,
      baseUrl,
      token,
    };
  }

  /**
   * Executes a REST request against GitHub and returns the parsed JSON payload.
   *
   * @param path - The API path or absolute URL to request.
   * @param init - Optional request initialization overrides.
   * @returns A promise resolving with the parsed JSON response body.
   * @throws {GitHubHttpError} If GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const client = new GitHubClient({ installationToken });
   * const repo = await client.request<{ default_branch: string }>(`/repos/org/repo`);
   * ```
   */
  public async request<T>(path: string, init?: RequestInit): Promise<T> {
    const { data } = await this.fetchJson<T>(this.buildUrl(path), init);
    return data;
  }

  /**
   * Fetches all results from a paginated GitHub REST resource.
   *
   * @param path - The API path or absolute URL to request.
   * @param searchParams - Optional initial search parameters to include.
   * @param cap - Optional maximum number of items to return (defaults to paginationSoftLimit).
   * @returns A promise resolving with the concatenated items from each page.
   * @throws {GitHubHttpError} If any page returns a non-success status code.
   * @example
   * ```ts
   * const issues = await client.requestPaginated<Issue>(`/repos/org/repo/issues`);
   * ```
   */
  public async requestPaginated<T>(
    path: string,
    searchParams?: URLSearchParams,
    cap?: number
  ): Promise<T[]> {
    const limit = cap ?? this.options.paginationSoftLimit ?? Number.POSITIVE_INFINITY;
    const collected: T[] = [];

    let nextUrl = this.buildUrl(path);
    const params = new URLSearchParams(searchParams ?? '');
    if (!params.has('per_page') && this.options.defaultPerPage) {
      params.set('per_page', String(this.options.defaultPerPage));
    }
    if (params.toString()) {
      nextUrl.search = params.toString();
    }

    while (nextUrl && collected.length < limit) {
      const { data, response } = await this.fetchJson<unknown>(nextUrl, undefined);
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

  /**
   * Executes a GitHub GraphQL request using the configured authentication.
   *
   * @param query - The GraphQL query document string.
   * @param variables - Optional variables to supply with the query.
   * @returns A promise resolving with the `data` field of the GraphQL response.
   * @throws {GitHubGraphQLError} If the response contains GraphQL errors.
   * @throws {GitHubHttpError} If the HTTP status code is not successful.
   * @example
   * ```ts
   * const data = await client.graphql<{ viewer: { login: string } }>(`query { viewer { login } }`);
   * ```
   */
  public async graphql<T>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    const graphqlUrl = this.buildGraphqlUrl();
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    };

    const { data, response } = await this.fetchJson<{
      data: T;
      errors?: GraphQLErrorPayload[];
    }>(graphqlUrl, init);
    if (data.errors && data.errors.length > 0) {
      throw new GitHubGraphQLError(
        'GitHub GraphQL request returned errors.',
        data.errors,
        response.headers.get('x-github-request-id')
      );
    }

    return data.data;
  }

  private buildUrl(path: string): URL {
    try {
      return new URL(path);
    } catch {
      const url = new URL(path.replace(/^[#?]/, ''), `${this.options.baseUrl}/`);
      return url;
    }
  }

  private buildGraphqlUrl(): URL {
    const base = new URL(`${this.options.baseUrl}/`);
    if (/\/api\/v3\/?$/.test(base.pathname)) {
      base.pathname = base.pathname.replace(/\/api\/v3\/?$/, '/api/graphql');
      return base;
    }

    base.pathname = `${base.pathname.replace(/\/$/, '')}/graphql`;
    return base;
  }

  private async fetchJson<T>(url: URL, init?: RequestInit): Promise<{ data: T; response: Response }> {
    const controller = this.options.timeoutMs ? new AbortController() : undefined;
    const timeout = this.options.timeoutMs
      ? setTimeout(() => controller?.abort(), this.options.timeoutMs)
      : undefined;

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller?.signal ?? init?.signal,
        headers: this.composeHeaders(init?.headers),
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

      if (response.status === 204 || response.status === 205) {
        return { data: undefined as T, response };
      }

      const text = await response.text();
      const data = (text ? (safeParseJSON<T>(text) as T) : (undefined as T));
      return { data, response };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private composeHeaders(input?: HeadersInit): Headers {
    const headers = new Headers(input ?? {});
    headers.set('accept', 'application/vnd.github+json');
    if (!headers.has('authorization')) {
      headers.set('authorization', `Bearer ${this.options.token}`);
    }
    if (this.options.requestTag) {
      headers.set('x-request-tag', this.options.requestTag);
    }
    if (!headers.has('user-agent')) {
      headers.set('user-agent', 'gh-bot-client');
    }
    return headers;
  }
}

function selectToken(options: GitHubClientOptions): string | undefined {
  return options.installationToken ?? options.personalAccessToken;
}

function parseHeaderInt(value: string | null): number | undefined {
  if (value == null) {
    return undefined;
  }
  const num = Number.parseInt(value, 10);
  return Number.isNaN(num) ? undefined : num;
}

export function safeParseJSON<T = unknown>(text: string): T | string {
  try {
    return JSON.parse(text) as T;
  } catch {
    return text;
  }
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
