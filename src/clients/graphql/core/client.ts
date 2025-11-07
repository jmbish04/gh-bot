import { GitHubGraphQLError, GitHubHttpError } from '../../errors';
import { safeParseJSON } from '../../rest/core/response';
import { composeGraphQLHeaders, graphqlEndpoint } from './request';
import type { GraphQLClientOptions, GraphQLResponse, InternalGraphQLClientOptions } from './types';

export class GraphQLHttpClient {
  private readonly options: InternalGraphQLClientOptions;

  constructor(options: GraphQLClientOptions) {
    const baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.options = { ...options, baseUrl };
  }

  public async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const result = await this.execute<T>(query, variables);
    if (result.errors?.length) {
      throw new GitHubGraphQLError(
        'GitHub GraphQL request returned errors.',
        result.errors,
        result.response.headers.get('x-github-request-id')
      );
    }
    return result.data;
  }

  public async execute<T>(
    query: string,
    variables?: Record<string, unknown>,
    init?: RequestInit
  ): Promise<GraphQLResponse<T>> {
    const url = graphqlEndpoint(this.options);
    const controller = this.options.timeoutMs ? new AbortController() : undefined;
    const timeout = this.options.timeoutMs
      ? setTimeout(() => controller?.abort(), this.options.timeoutMs)
      : undefined;

    try {
      const response = await fetch(url, {
        ...init,
        method: 'POST',
        signal: controller?.signal ?? init?.signal,
        headers: composeGraphQLHeaders(this.options, init?.headers),
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        const text = await response.text();
        const body = text ? safeParseJSON(text) : undefined;
        throw new GitHubHttpError(
          `GitHub request failed with status ${response.status}`,
          response.status,
          response.url,
          body,
          response.headers
        );
      }

      const text = await response.text();
      const parsed = text ? safeParseJSON<{ data: T; errors?: GraphQLErrorPayload[] }>(text) : { data: undefined as T };
      return { data: parsed.data, errors: parsed.errors, response };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}
