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

  constructor(message: string, status: number, url: string, body: unknown, headers: Headers) {
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

function parseHeaderInt(value: string | null): number | undefined {
  if (value == null) {
    return undefined;
  }
  const num = Number.parseInt(value, 10);
  return Number.isNaN(num) ? undefined : num;
}
