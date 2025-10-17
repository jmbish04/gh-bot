import jwt from '@tsndr/cloudflare-worker-jwt';
import type { Logger, RepositoryTarget } from './util';
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
 *
 * ## How to use
 *
 * ```ts
 * import { createInstallationClient } from './github';
 *
 * const client = await createInstallationClient(env, installationId, { logger });
 * const comments = await client.listPullRequestReviewComments({
 *   owner: 'octocat',
 *   repo: 'hello-world',
 *   pull_number: 42,
 * });
 *
 * await client.replyToComment({
 *   owner: 'octocat',
 *   repo: 'hello-world',
 *   pull_number: 42,
 *   comment_id: comments[0]?.id ?? 0,
 *   body: 'Thanks for the review!'
 * });
 * ```
 */

export interface GitHubEnv {
  GITHUB_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_PRIVATE_KEY?: string;
  GITHUB_INSTALLATION_ID?: string;
  GITHUB_REPO_DEFAULT_BRANCH_FALLBACK?: string;
}

export interface GitHubClientOptions {
  installationToken?: string;
  personalAccessToken?: string;
  env?: GitHubEnv;
  logger?: Logger;
  baseUrl?: string;
  defaultPerPage?: number;
  paginationSoftLimit?: number;
  timeoutMs?: number;
  requestTag?: string;
}

export type GitHubAppRequestOptions = Pick<GitHubClientOptions, 'baseUrl' | 'requestTag' | 'logger'>;

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

export interface PullRequestSummary {
  number: number;
  head: { ref: string };
  body?: string | null;
}

export interface CommitFile {
  path: string;
  content: string;
  mode?: '100644' | '100755' | '040000' | '160000' | '120000';
}

export interface GitHubSearchParams {
  per_page?: number;
  page?: number;
  sort?: string;
  order?: 'asc' | 'desc';
}

export interface ReplyToCommentParams {
  owner: string;
  repo: string;
  pull_number: number;
  comment_id: number;
  body: string;
}

export interface ReactionParams {
  owner: string;
  repo: string;
  comment_id: number;
  content: string;
}

export interface ReplyToGitHubCommentArgs extends ReplyToCommentParams {
  installationToken?: string;
  client?: GitHubClient;
  options?: GitHubClientOptions;
}

export interface ReactionRequestArgs extends ReactionParams {
  installationToken?: string;
  client?: GitHubClient;
  options?: GitHubClientOptions;
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
   * Executes a REST request with an explicit HTTP method and optional JSON body.
   *
   * @param method - The HTTP method to use (e.g. `GET`, `POST`).
   * @param path - The API path or absolute URL to request.
   * @param body - Optional JSON-serialisable payload included in the request body.
   * @param init - Additional fetch options, such as custom headers.
   * @returns A promise resolving with the parsed JSON response body.
   * @throws {GitHubHttpError} If GitHub responds with a non-success status code.
   * @example
   * ```ts
   * await client.rest('POST', `/repos/${owner}/${repo}/issues`, { title: 'Hello', body: 'World' });
   * ```
   */
  public async rest<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
    const url = this.buildUrl(path);
    const headers = new Headers(init?.headers);
    let requestBody = init?.body;

    if (body !== undefined) {
      headers.set('content-type', 'application/json');
      requestBody = JSON.stringify(body);
    }

    const { data } = await this.fetchJson<T>(url, {
      ...init,
      method,
      headers,
      body: requestBody,
    });
    return data;
  }

  /**
   * Executes a REST request and returns both the parsed JSON body and the raw response metadata.
   *
   * @param method - The HTTP method to invoke.
   * @param path - The REST API path to call.
   * @param body - Optional JSON payload to include in the request body.
   * @param init - Additional fetch options, such as custom headers.
   * @returns A promise resolving with the parsed JSON body and originating response object.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const { data, response } = await client.restWithResponse('GET', `/rate_limit`);
   * console.log(response.headers.get('x-ratelimit-remaining'));
   * ```
   */
  public async restWithResponse<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: RequestInit
  ): Promise<{ data: T; response: Response }> {
    const url = this.buildUrl(path);
    const headers = new Headers(init?.headers);
    let requestBody = init?.body;

    if (body !== undefined) {
      headers.set('content-type', 'application/json');
      requestBody = JSON.stringify(body);
    }

    return this.fetchJson<T>(url, {
      ...init,
      method,
      headers,
      body: requestBody,
    });
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
        authorization: `Bearer ${this.options.token}`,
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

  /**
   * Resolves the default branch for a repository, falling back to a provided branch name when GitHub lacks the metadata.
   *
   * @param target - The repository coordinates to inspect.
   * @param fallback - Optional branch name used when the API response omits a default branch (defaults to `main`).
   * @returns The default branch name reported by GitHub or the provided fallback value.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const branch = await client.getDefaultBranch({ owner: 'octocat', repo: 'hello-world' }, 'main');
   * console.log(branch);
   * ```
   */
  public async getDefaultBranch(target: RepositoryTarget, fallback = 'main'): Promise<string> {
    const repo = await this.getRepository<{ default_branch?: string }>({ owner: target.owner, repo: target.repo });
    return repo.default_branch ?? fallback;
  }

  /**
   * Fetches the commit SHA that the provided branch currently points to.
   *
   * @param target - The repository coordinates to inspect.
   * @param branch - The branch name to resolve.
   * @returns The commit SHA for the requested branch.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const sha = await client.getBranchSha({ owner: 'octocat', repo: 'hello-world' }, 'main');
   * console.log(sha);
   * ```
   */
  public async getBranchSha(target: RepositoryTarget, branch: string): Promise<string> {
    const data = await this.getBranch<{ commit: { sha: string } }>({ owner: target.owner, repo: target.repo, branch });
    if (!data?.commit?.sha) {
      throw new Error(`Branch ${branch} did not include a commit SHA.`);
    }
    return data.commit.sha;
  }

  /**
   * Retrieves a Git commit payload, including parent references and tree information.
   *
   * @param target - The repository coordinates for the commit.
   * @param sha - The commit SHA to fetch.
   * @returns The Git commit payload returned by GitHub.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const commit = await client.getCommit({ owner: 'octocat', repo: 'hello-world' }, 'abc123');
   * console.log(commit.tree.sha);
   * ```
   */
  public getCommit<T = { sha: string; tree: { sha: string } }>(
    target: RepositoryTarget,
    sha: string
  ): Promise<T> {
    return this.request<T>(`/repos/${target.owner}/${target.repo}/git/commits/${sha}`);
  }

  /**
   * Lists tree entries for a commit or tree SHA, optionally traversing recursively.
   *
   * @param target - The repository coordinates to query.
   * @param sha - The tree or commit SHA to expand.
   * @param recursive - When true, GitHub returns the complete recursive tree.
   * @returns An array of tree entries.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const tree = await client.listTree({ owner: 'octocat', repo: 'hello-world' }, 'abc123', true);
   * console.log(tree.length);
   * ```
   */
  public async listTree<T = { path: string; mode: string; type: string; sha: string; size?: number }>(
    target: RepositoryTarget,
    sha: string,
    recursive = false
  ): Promise<T[]> {
    const query = recursive ? '?recursive=1' : '';
    const response = await this.request<{ tree: T[] }>(
      `/repos/${target.owner}/${target.repo}/git/trees/${sha}${query}`
    );
    return response.tree;
  }

  /**
   * Downloads and decodes a Git blob as UTF-8 text.
   *
   * @param target - The repository coordinates that contain the blob.
   * @param sha - The blob SHA to fetch.
   * @returns The decoded blob content as a UTF-8 string.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const text = await client.getBlob({ owner: 'octocat', repo: 'hello-world' }, 'blobSha');
   * console.log(text.slice(0, 80));
   * ```
   */
  public async getBlob(target: RepositoryTarget, sha: string): Promise<string> {
    const blob = await this.request<{ content: string; encoding: string }>(
      `/repos/${target.owner}/${target.repo}/git/blobs/${sha}`
    );
    if (blob.encoding !== 'base64') {
      throw new Error(`Unsupported blob encoding: ${blob.encoding}`);
    }
    return decodeBase64(blob.content);
  }

  /**
   * Reads a file from a repository and decodes it into UTF-8 text when present.
   *
   * @param target - The repository coordinates to query.
   * @param path - The file path to read.
   * @param ref - The branch, tag, or commit SHA to read from.
   * @returns The decoded file contents and associated blob SHA, or null when the file is absent.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code other than 404.
   * @example
   * ```ts
   * const file = await client.getFile({ owner: 'octocat', repo: 'hello-world' }, 'README.md', 'main');
   * console.log(file?.sha);
   * ```
   */
  public async getFile(
    target: RepositoryTarget,
    path: string,
    ref: string
  ): Promise<{ content: string; sha: string } | null> {
    try {
      const file = await this.request<{ content: string; encoding: string; sha: string }>(
        `/repos/${target.owner}/${target.repo}/contents/${encodeGitHubPath(path)}` + `?ref=${encodeURIComponent(ref)}`
      );
      if (file.encoding !== 'base64') {
        throw new Error(`Unsupported encoding for file ${path}`);
      }
      return { content: decodeBase64(file.content), sha: file.sha };
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Reads a file at a specific ref and returns the decoded UTF-8 contents when present.
   *
   * @param params - The repository target, file path, and ref to read.
   * @returns The decoded file contents or null when the file is absent.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code other than 404.
   * @example
   * ```ts
   * const text = await client.getFileAtRef({ target: { owner: 'octocat', repo: 'hello-world' }, path: 'README.md', ref: 'main' });
   * console.log(text?.slice(0, 40));
   * ```
   */
  public async getFileAtRef({
    target,
    path,
    ref,
  }: {
    target: RepositoryTarget;
    path: string;
    ref: string;
  }): Promise<string | null> {
    const file = await this.getFile(target, path, ref);
    return file?.content ?? null;
  }

  /**
   * Finds the existing open standardization pull request created by this worker, if any.
   *
   * @param target - The repository coordinates to inspect.
   * @returns The first matching pull request summary or null when none exist.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const pr = await client.findOpenStandardizationPr({ owner: 'octocat', repo: 'hello-world' });
   * console.log(pr?.number);
   * ```
   */
  public async findOpenStandardizationPr(target: RepositoryTarget): Promise<PullRequestSummary | null> {
    const pulls = await this.request<PullRequestSummary[]>(
      `/repos/${target.owner}/${target.repo}/pulls?state=open&per_page=50`
    );
    return pulls.find((pr) => pr.head.ref.startsWith('auto/standardize-agents-')) ?? null;
  }

  /**
   * Fetches metadata for a specific repository so callers can inspect settings such as default branches or permissions.
   *
   * @param params - The owner and repository name to query.
   * @returns A promise resolving with the repository payload returned by GitHub.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const gh = new GitHubClient({ installationToken });
   * const repo = await gh.getRepository({ owner: 'octocat', repo: 'hello-world' });
   * console.log(repo.default_branch);
   * ```
   */
  public getRepository<T = unknown>({ owner, repo }: { owner: string; repo: string }): Promise<T> {
    return this.request<T>(`/repos/${owner}/${repo}`);
  }

  /**
   * Lists repositories the current installation can access, enabling automation to iterate over every connected repo.
   *
   * @returns A promise resolving with the paginated installation repositories payload from GitHub.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const gh = new GitHubClient({ installationToken });
   * const { repositories } = await gh.listRepositoriesForInstallation();
   * console.log(repositories.map((repo) => repo.full_name));
   * ```
   */
  public listRepositoriesForInstallation<T = unknown>(): Promise<{
    total_count: number;
    repositories: T[];
  }> {
    return this.request<{ total_count: number; repositories: T[] }>(`/installation/repositories`);
  }

  /**
   * Retrieves a pull request's latest metadata such as title, branch refs, and mergeability.
   *
   * @param params - The owner, repository, and pull request number to read.
   * @returns A promise resolving with the pull request payload.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const gh = new GitHubClient({ installationToken });
   * const pr = await gh.getPullRequest({ owner: 'octocat', repo: 'hello-world', pull_number: 42 });
   * console.log(pr.state);
   * ```
   */
  public getPullRequest<T = unknown>({
    owner,
    repo,
    pull_number,
  }: {
    owner: string;
    repo: string;
    pull_number: number;
  }): Promise<T> {
    return this.request<T>(`/repos/${owner}/${repo}/pulls/${pull_number}`);
  }

  /**
   * Lists the files touched by a pull request to support diff inspection or validation workflows.
   *
   * @param params - The owner, repository, and pull request number to inspect.
   * @returns A promise resolving with every file item across all pages.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const gh = new GitHubClient({ installationToken });
   * const files = await gh.listPullRequestFiles({ owner: 'octocat', repo: 'hello-world', pull_number: 42 });
   * console.log(files.length);
   * ```
   */
  public listPullRequestFiles<T = unknown>({
    owner,
    repo,
    pull_number,
  }: {
    owner: string;
    repo: string;
    pull_number: number;
  }): Promise<T[]> {
    return this.requestPaginated<T>(`/repos/${owner}/${repo}/pulls/${pull_number}/files`);
  }

  /**
   * Retrieves every review comment on a pull request, automatically traversing pagination to avoid missing feedback.
   *
   * @param params - The owner, repository, and pull request number to gather comments for.
   * @returns A promise resolving with all review comments across every page.
   * @throws {GitHubHttpError} When any page responds with a non-success status code.
   * @example
   * ```ts
   * const gh = new GitHubClient({ installationToken });
   * const comments = await gh.listPullRequestReviewComments({ owner: 'octocat', repo: 'hello-world', pull_number: 42 });
   * console.log(comments.map((comment) => comment.id));
   * ```
   */
  public listPullRequestReviewComments<T = unknown>({
    owner,
    repo,
    pull_number,
  }: {
    owner: string;
    repo: string;
    pull_number: number;
  }): Promise<T[]> {
    return this.requestPaginated<T>(`/repos/${owner}/${repo}/pulls/${pull_number}/comments`);
  }

  /**
   * Retrieves a single pull request review comment so callers can inspect or react to a specific thread entry.
   *
   * @param params - The owner, repository, and review comment identifier to fetch.
   * @returns A promise resolving with the requested review comment payload.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const gh = new GitHubClient({ installationToken });
   * const comment = await gh.getPullRequestReviewComment({ owner: 'octocat', repo: 'hello-world', comment_id: 123 });
   * console.log(comment.body);
   * ```
   */
  public getPullRequestReviewComment<T = unknown>({
    owner,
    repo,
    comment_id,
  }: {
    owner: string;
    repo: string;
    comment_id: number;
  }): Promise<T> {
    return this.request<T>(`/repos/${owner}/${repo}/pulls/comments/${comment_id}`);
  }

  /**
   * Replies to an existing pull request review comment thread, enabling conversational feedback loops.
   *
   * @param params - The owner, repository, pull request number, target comment ID, and markdown body.
   * @returns A promise resolving with the newly created review comment payload.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const gh = new GitHubClient({ installationToken });
   * await gh.replyToPullRequestReviewComment({
   *   owner: 'octocat',
   *   repo: 'hello-world',
   *   pull_number: 42,
   *   in_reply_to: 123,
   *   body: 'Thanks for the suggestion!'
   * });
   * ```
   */
  public replyToPullRequestReviewComment<T = unknown>({
    owner,
    repo,
    pull_number,
    in_reply_to,
    body,
  }: {
    owner: string;
    repo: string;
    pull_number: number;
    in_reply_to: number;
    body: string;
  }): Promise<T> {
    return this.request<T>(`/repos/${owner}/${repo}/pulls/${pull_number}/comments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ in_reply_to, body }),
    });
  }

  /**
   * Replies to a review or issue comment, automatically routing to the correct endpoint and falling back to GraphQL when necessary.
   *
   * @param params - The owner, repository, pull request number, target comment ID, and markdown body.
   * @returns A promise resolving with the created comment payload.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * await client.replyToComment({ owner: 'octocat', repo: 'hello-world', pull_number: 42, comment_id: 123, body: 'Thanks!' });
   * ```
   */
  public async replyToComment<T = unknown>({
    owner,
    repo,
    pull_number,
    comment_id,
    body,
  }: ReplyToCommentParams): Promise<T> {
    const base = `/repos/${owner}/${repo}`;
    let reviewComment: { node_id?: string } | null = null;

    try {
      reviewComment = await this.rest<{ node_id?: string }>('GET', `${base}/pulls/comments/${comment_id}`);
    } catch (error) {
      if (!(error instanceof GitHubHttpError && error.status === 404)) {
        throw error;
      }
    }

    if (reviewComment) {
      try {
        return await this.rest<T>('POST', `${base}/pulls/comments/${comment_id}/replies`, { body });
      } catch (error) {
        if (!(error instanceof GitHubHttpError)) {
          throw error;
        }
        if (!reviewComment.node_id) {
          throw error;
        }
        const result = await this.graphql<{ addPullRequestReviewComment?: { comment?: T } }>(
          `mutation Reply($input: AddPullRequestReviewCommentInput!) {
            addPullRequestReviewComment(input: $input) {
              comment { id body }
            }
          }`,
          { input: { inReplyTo: reviewComment.node_id, body } }
        );
        const comment = result.addPullRequestReviewComment?.comment;
        if (comment) {
          return comment;
        }
        throw error;
      }
    }

    try {
      await this.rest('GET', `${base}/issues/comments/${comment_id}`);
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) {
        throw new Error(
          `Comment ${comment_id} not found as a pull request review or issue comment. Verify repository and permissions.`
        );
      }
      throw error;
    }

    return this.rest<T>('POST', `${base}/issues/${pull_number}/comments`, { body });
  }

  /**
   * Adds a reaction to an issue or pull request comment.
   *
   * @param params - The owner, repository, comment identifier, and reaction content (e.g. `+1`).
   * @returns A promise resolving with the created reaction payload.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * await client.addReactionToComment({ owner: 'octocat', repo: 'hello-world', comment_id: 123, content: '+1' });
   * ```
   */
  public addReactionToComment<T = unknown>({ owner, repo, comment_id, content }: ReactionParams): Promise<T> {
    return this.rest<T>(
      'POST',
      `/repos/${owner}/${repo}/issues/comments/${comment_id}/reactions`,
      { content },
      { headers: { accept: 'application/vnd.github+json' } }
    );
  }

  /**
   * Lists issues (and pull requests) for a repository, supporting optional state filtering for dashboards.
   *
   * @param params - The owner, repository, and optional issue state filter.
   * @returns A promise resolving with every issue returned by the GitHub API.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const gh = new GitHubClient({ installationToken });
   * const issues = await gh.listIssues({ owner: 'octocat', repo: 'hello-world', state: 'open' });
   * console.log(issues.length);
   * ```
   */
  public listIssues<T = unknown>({
    owner,
    repo,
    state,
  }: {
    owner: string;
    repo: string;
    state?: 'open' | 'closed' | 'all';
  }): Promise<T[]> {
    const params = new URLSearchParams();
    if (state) {
      params.set('state', state);
    }
    return this.requestPaginated<T>(`/repos/${owner}/${repo}/issues`, params);
  }

  /**
   * Retrieves a single issue (or pull request) by number to access its body, labels, or status.
   *
   * @param params - The owner, repository, and issue number to fetch.
   * @returns A promise resolving with the issue payload from GitHub.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const gh = new GitHubClient({ installationToken });
   * const issue = await gh.getIssue({ owner: 'octocat', repo: 'hello-world', issue_number: 101 });
   * console.log(issue.title);
   * ```
   */
  public getIssue<T = unknown>({
    owner,
    repo,
    issue_number,
  }: {
    owner: string;
    repo: string;
    issue_number: number;
  }): Promise<T> {
    return this.request<T>(`/repos/${owner}/${repo}/issues/${issue_number}`);
  }

  /**
   * Creates a new GitHub issue to capture tasks, bug reports, or AI-generated follow-ups.
   *
   * @param params - The owner, repository, issue title, body, and optional labels payload.
   * @returns A promise resolving with the created issue resource.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const gh = new GitHubClient({ installationToken });
   * await gh.createIssue({ owner: 'octocat', repo: 'hello-world', title: 'Bug report', body: 'Steps to reproduce' });
   * ```
   */
  public createIssue<T = unknown>({
    owner,
    repo,
    title,
    body,
    labels,
  }: {
    owner: string;
    repo: string;
    title: string;
    body?: string;
    labels?: string[];
  }): Promise<T> {
    return this.request<T>(`/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title, body, labels }),
    });
  }

  /**
   * Lists comments on a specific issue to support summarization or follow-up automation.
   *
   * @param params - The owner, repository, and issue number to inspect.
   * @returns A promise resolving with every comment returned by the GitHub API.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const gh = new GitHubClient({ installationToken });
   * const comments = await gh.listIssueComments({ owner: 'octocat', repo: 'hello-world', issue_number: 101 });
   * console.log(comments.length);
   * ```
   */
  public listIssueComments<T = unknown>({
    owner,
    repo,
    issue_number,
  }: {
    owner: string;
    repo: string;
    issue_number: number;
  }): Promise<T[]> {
    return this.requestPaginated<T>(`/repos/${owner}/${repo}/issues/${issue_number}/comments`);
  }

  /**
   * Performs a GitHub search request across a REST search endpoint.
   *
   * @param endpoint - The search resource to query (e.g. `repositories`, `code`).
   * @param query - The GitHub search query string.
   * @param params - Optional pagination and sorting parameters.
   * @returns A promise resolving with the raw search response payload.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const repos = await client.search('repositories', 'topic:workers language:typescript', { per_page: 5 });
   * console.log(repos.items?.length ?? 0);
   * ```
   */
  public search<T = unknown>(
    endpoint: 'code' | 'commits' | 'issues' | 'repositories' | 'users',
    query: string,
    params: GitHubSearchParams = {}
  ): Promise<T> {
    const searchParams = buildSearchParams(query, params);
    return this.request<T>(`/search/${endpoint}?${searchParams.toString()}`);
  }

  /**
   * Searches GitHub repositories using the REST search API.
   *
   * @param query - The GitHub search query string.
   * @param params - Optional pagination and sorting parameters.
   * @returns A promise resolving with the repository search response payload.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const results = await client.searchRepositories('topic:workers', { per_page: 10 });
   * console.log(results.items.length);
   * ```
   */
  public searchRepositories<T = unknown>(query: string, params: GitHubSearchParams = {}): Promise<T> {
    return this.search<T>('repositories', query, params);
  }

  /**
   * Searches GitHub code results using the REST search API.
   *
   * @param query - The GitHub code search query string.
   * @param params - Optional pagination and sorting parameters.
   * @returns A promise resolving with the code search response payload.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const code = await client.searchCode('repo:octocat/hello-world path:/ README', { per_page: 5 });
   * console.log(code.items.length);
   * ```
   */
  public searchCode<T = unknown>(query: string, params: GitHubSearchParams = {}): Promise<T> {
    return this.search<T>('code', query, params);
  }

  /**
   * Searches GitHub issues and pull requests using the REST search API.
   *
   * @param query - The GitHub issues search query string.
   * @param params - Optional pagination and sorting parameters.
   * @returns A promise resolving with the issues search response payload.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const issues = await client.searchIssues('repo:octocat/hello-world is:issue', { per_page: 3 });
   * console.log(issues.total_count);
   * ```
   */
  public searchIssues<T = unknown>(query: string, params: GitHubSearchParams = {}): Promise<T> {
    return this.search<T>('issues', query, params);
  }

  /**
   * Searches GitHub users using the REST search API.
   *
   * @param query - The GitHub users search query string.
   * @param params - Optional pagination and sorting parameters.
   * @returns A promise resolving with the users search response payload.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const users = await client.searchUsers('type:user location:berlin');
   * console.log(users.items.map((user: any) => user.login));
   * ```
   */
  public searchUsers<T = unknown>(query: string, params: GitHubSearchParams = {}): Promise<T> {
    return this.search<T>('users', query, params);
  }

  /**
   * Retrieves the contents of a repository path, enabling bots to download README files or workflows.
   *
   * @param params - The owner, repository, file path, and optional ref to read.
   * @returns A promise resolving with the content payload from GitHub.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const gh = new GitHubClient({ installationToken });
   * const file = await gh.getContents({ owner: 'octocat', repo: 'hello-world', path: 'README.md' });
   * console.log(file.encoding);
   * ```
   */
  public getContents<T = unknown>({
    owner,
    repo,
    path,
    ref,
  }: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
  }): Promise<T> {
    const encodedPath = encodeGitHubPath(path);
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    return this.request<T>(`/repos/${owner}/${repo}/contents/${encodedPath}${query}`);
  }

  /**
   * Updates or creates a file on a branch by committing new Base64-encoded contents.
   *
   * @param params - The owner, repository, file path, commit message, Base64 content, blob SHA, and optional branch name.
   * @returns A promise resolving with the GitHub API response describing the commit.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const gh = new GitHubClient({ installationToken });
   * await gh.updateFile({
   *   owner: 'octocat',
   *   repo: 'hello-world',
   *   path: 'README.md',
   *   message: 'Update README',
   *   content: btoa('# Hello world'),
   *   sha: 'abc123'
   * });
   * ```
   */
  public updateFile<T = unknown>({
    owner,
    repo,
    path,
    message,
    content,
    sha,
    branch,
  }: {
    owner: string;
    repo: string;
    path: string;
    message: string;
    content: string;
    sha: string;
    branch?: string;
  }): Promise<T> {
    const encodedPath = encodeGitHubPath(path);
    return this.request<T>(`/repos/${owner}/${repo}/contents/${encodedPath}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message, content, sha, branch }),
    });
  }

  /**
   * Creates a Git commit object, typically used after constructing a tree for advanced workflows.
   *
   * @param params - The owner, repository, commit message, tree SHA, parent SHAs, and optional author/committer identities.
   * @returns A promise resolving with the created commit payload.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const gh = new GitHubClient({ installationToken });
   * const commit = await gh.createCommit({
   *   owner: 'octocat',
   *   repo: 'hello-world',
   *   message: 'Automated commit',
   *   tree: 'treeSha',
   *   parents: ['parentSha']
   * });
   * console.log(commit.sha);
   * ```
   */
  public createCommit<T = unknown>({
    owner,
    repo,
    message,
    tree,
    parents,
    author,
    committer,
  }: {
    owner: string;
    repo: string;
    message: string;
    tree: string;
    parents: string[];
    author?: Record<string, unknown>;
    committer?: Record<string, unknown>;
  }): Promise<T> {
    return this.request<T>(`/repos/${owner}/${repo}/git/commits`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message, tree, parents, author, committer }),
    });
  }

  /**
   * Fetches metadata for a named branch, including its latest commit SHA, to support branch-aware logic.
   *
   * @param params - The owner, repository, and branch name to inspect.
   * @returns A promise resolving with the branch payload from GitHub.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const gh = new GitHubClient({ installationToken });
   * const branch = await gh.getBranch({ owner: 'octocat', repo: 'hello-world', branch: 'main' });
   * console.log(branch.commit.sha);
   * ```
   */
  public getBranch<T = unknown>({
    owner,
    repo,
    branch,
  }: {
    owner: string;
    repo: string;
    branch: string;
  }): Promise<T> {
    const encodedBranch = encodeGitHubPath(branch);
    return this.request<T>(`/repos/${owner}/${repo}/branches/${encodedBranch}`);
  }

  /**
   * Creates a new branch (Git ref) pointing at a specific commit SHA.
   *
   * @param params - The owner, repository, fully-qualified ref name, and commit SHA.
   * @returns A promise resolving with the newly created ref payload.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const gh = new GitHubClient({ installationToken });
   * await gh.createBranch({ owner: 'octocat', repo: 'hello-world', ref: 'refs/heads/feature', sha: 'abc123' });
   * ```
   */
  public createBranch<T = unknown>({
    owner,
    repo,
    ref,
    sha,
  }: {
    owner: string;
    repo: string;
    ref: string;
    sha: string;
  }): Promise<T> {
    return this.request<T>(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ref, sha }),
    });
  }

  /**
   * Updates an existing Git ref, typically used to fast-forward or force-move branches.
   *
   * @param params - The owner, repository, ref path (without leading refs/), new commit SHA, and optional force flag.
   * @returns A promise resolving with the updated ref payload.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const gh = new GitHubClient({ installationToken });
   * await gh.updateRef({ owner: 'octocat', repo: 'hello-world', ref: 'heads/main', sha: 'abc123', force: true });
   * ```
   */
  public updateRef<T = unknown>({
    owner,
    repo,
    ref,
    sha,
    force,
  }: {
    owner: string;
    repo: string;
    ref: string;
    sha: string;
    force?: boolean;
  }): Promise<T> {
    const normalizedRef = ref.replace(/^refs\//, '');
    const encodedRef = encodeGitHubPath(normalizedRef);
    return this.request<T>(`/repos/${owner}/${repo}/git/refs/${encodedRef}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sha, force }),
    });
  }

  /**
   * Retrieves metadata for a GitHub user, enabling attribution or permission checks.
   *
   * @param params - The username to look up.
   * @returns A promise resolving with the user payload from GitHub.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const gh = new GitHubClient({ installationToken });
   * const user = await gh.getUser({ username: 'octocat' });
   * console.log(user.id);
   * ```
   */
  public getUser<T = unknown>({ username }: { username: string }): Promise<T> {
    return this.request<T>(`/users/${username}`);
  }

  /**
   * Retrieves metadata for a GitHub organization such as members-only visibility or plan details.
   *
   * @param params - The organization login to inspect.
   * @returns A promise resolving with the organization payload from GitHub.
   * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
   * @example
   * ```ts
   * const gh = new GitHubClient({ installationToken });
   * const org = await gh.getOrg({ org: 'github' });
   * console.log(org.billing_email);
   * ```
   */
  public getOrg<T = unknown>({ org }: { org: string }): Promise<T> {
    return this.request<T>(`/orgs/${org}`);
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
      headers.set('authorization', `token ${this.options.token}`);
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

/**
 * Creates a signed JSON Web Token that authenticates as the configured GitHub App.
 *
 * @param env - The environment containing GitHub App credentials.
 * @returns A promise resolving with the signed JWT string.
 * @throws {Error} When required GitHub App credentials are missing.
 * @example
 * ```ts
 * const jwtToken = await createGitHubAppJwt(env);
 * ```
 */
export async function createGitHubAppJwt(env: GitHubEnv): Promise<string> {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY ?? env.GITHUB_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new Error('GitHub App credentials are required to mint an app JWT.');
  }

  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iat: now - 60, exp: now + 9 * 60, iss: appId },
    privateKey,
    { algorithm: 'RS256' }
  );
}

/**
 * Lists installations for the configured GitHub App.
 *
 * @param env - The environment containing GitHub App credentials.
 * @param options - Optional request overrides such as base URL or request tag.
 * @returns A promise resolving with the installations payload from GitHub.
 * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
 * @example
 * ```ts
 * const installations = await listInstallations(env);
 * console.log(installations.length);
 * ```
 */
export async function listInstallations<T = unknown>(
  env: GitHubEnv,
  options: GitHubAppRequestOptions = {}
): Promise<T> {
  const appJwt = await createGitHubAppJwt(env);
  const url = new URL('/app/installations', `${resolveBaseUrl(options.baseUrl)}/`);
  const response = await fetch(url, {
    headers: buildAppHeaders(appJwt, options),
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

  const text = await response.text();
  return text ? (safeParseJSON<T>(text) as T) : (([] as unknown) as T);
}

/**
 * Retrieves an installation token for a specific GitHub App installation.
 *
 * @param env - The environment containing GitHub App credentials.
 * @param installationId - The GitHub App installation identifier.
 * @param options - Optional request overrides such as base URL or request tag.
 * @returns A promise resolving with the installation access token.
 * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
 * @throws {Error} When the response body does not include an access token.
 * @example
 * ```ts
 * const token = await getInstallationToken(env, installationId);
 * ```
 */
export async function getInstallationToken(
  env: GitHubEnv,
  installationId: number,
  options: GitHubAppRequestOptions = {}
): Promise<string> {
  const appJwt = await createGitHubAppJwt(env);
  const url = new URL(
    `/app/installations/${installationId}/access_tokens`,
    `${resolveBaseUrl(options.baseUrl)}/`
  );

  const headers = buildAppHeaders(appJwt, options);
  headers.set('content-type', 'application/json');

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
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

  const text = await response.text();
  const data = text ? safeParseJSON<{ token?: string }>(text) : {};
  if (typeof data === 'object' && data && typeof data.token === 'string') {
    return data.token;
  }
  throw new Error('GitHub installation token response did not include a token.');
}

/**
 * Convenience helper that mints an installation token and returns an authenticated GitHub client.
 *
 * @param env - The environment containing GitHub App credentials.
 * @param installationId - The GitHub App installation identifier.
 * @param options - Additional client configuration overrides.
 * @returns A promise resolving with a GitHub client authenticated as the installation.
 * @throws {GitHubHttpError} When GitHub responds with a non-success status code while minting the token.
 * @example
 * ```ts
 * const client = await createInstallationClient(env, installationId, { logger });
 * ```
 */
export async function createInstallationClient(
  env: GitHubEnv,
  installationId: number,
  options: Omit<GitHubClientOptions, 'installationToken' | 'personalAccessToken'> = {}
): Promise<GitHubClient> {
  const token = await getInstallationToken(env, installationId, options);
  options.logger?.debug('Created installation client', { installationId });
  return new GitHubClient({ ...options, env, installationToken: token });
}

/**
 * Executes a GitHub REST request using either an existing client or a token string.
 *
 * @param input - A GitHub client instance or installation token string.
 * @param method - The HTTP method to invoke.
 * @param path - The REST API path to call.
 * @param body - Optional JSON payload to include in the request body.
 * @param options - Optional client configuration when providing a token.
 * @returns The parsed JSON response body from GitHub.
 * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
 * @example
 * ```ts
 * const data = await ghREST(token, 'GET', `/repos/${owner}/${repo}`);
 * ```
 */
export function ghREST(
  input: GitHubClient | string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  options?: GitHubClientOptions
): Promise<unknown> {
  const client = ensureClient(input, options);
  return client.rest(method, path, body);
}

/**
 * Executes a GitHub GraphQL request and returns the raw data/errors payload.
 *
 * @param input - A GitHub client instance or installation token string.
 * @param query - The GraphQL document string to execute.
 * @param variables - Optional GraphQL variables.
 * @param options - Optional client configuration when providing a token.
 * @returns An object containing the `data` property and optional `errors` array.
 * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
 * @example
 * ```ts
 * const result = await ghGraphQL(token, 'query { viewer { login } }');
 * console.log(result.data?.viewer?.login);
 * ```
 */
export async function ghGraphQL<T = unknown>(
  input: GitHubClient | string,
  query: string,
  variables?: Record<string, unknown>,
  options?: GitHubClientOptions
): Promise<{ data?: T; errors?: GraphQLErrorPayload[] }> {
  const client = ensureClient(input, options);
  try {
    const data = await client.graphql<T>(query, variables);
    return { data };
  } catch (error) {
    if (error instanceof GitHubGraphQLError) {
      return { errors: error.errors };
    }
    throw error;
  }
}

/**
 * Replies to a GitHub review or issue comment using either an existing client or token.
 *
 * @param args - Complete reply configuration including repository coordinates and body.
 * @returns A promise resolving with the created comment payload.
 * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
 * @example
 * ```ts
 * await replyToGitHubComment({ installationToken: token, owner, repo, pull_number: 1, comment_id: 2, body: 'Thanks!' });
 * ```
 */
export function replyToGitHubComment<T = unknown>(args: ReplyToGitHubCommentArgs): Promise<T> {
  const { installationToken, client, options, ...rest } = args;
  const resolvedClient = client ?? ensureClient(installationToken ?? '', options);
  return resolvedClient.replyToComment(rest);
}

/**
 * Adds a reaction to an issue or pull request comment using either an existing client or token.
 *
 * @param args - Reaction configuration including the comment identifier and emoji content.
 * @returns A promise resolving with the created reaction payload.
 * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
 * @example
 * ```ts
 * await addReactionToComment({ installationToken: token, owner, repo, comment_id: 123, content: '+1' });
 * ```
 */
export function addReactionToComment<T = unknown>(args: ReactionRequestArgs): Promise<T> {
  const { installationToken, client, options, ...rest } = args;
  const resolvedClient = client ?? ensureClient(installationToken ?? '', options);
  return resolvedClient.addReactionToComment(rest);
}

/**
 * Reads a file at a specific ref using either an existing client or token.
 *
 * @param input - A GitHub client instance or installation token string.
 * @param owner - The repository owner login.
 * @param repo - The repository name.
 * @param path - The file path to read.
 * @param ref - The branch, tag, or commit ref.
 * @param options - Optional client configuration when providing a token.
 * @returns The decoded file contents or null when the file does not exist.
 * @throws {GitHubHttpError} When GitHub responds with a non-success status code other than 404.
 * @example
 * ```ts
 * const readme = await getFileAtRef(token, 'octocat', 'hello-world', 'README.md', 'main');
 * ```
 */
export function getFileAtRef(
  input: GitHubClient | string,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  options?: GitHubClientOptions
): Promise<string | null> {
  const client = ensureClient(input, options);
  return client.getFileAtRef({ target: { owner, repo }, path, ref });
}

/**
 * Lists repositories accessible to the provided installation token or client and returns a simplified payload.
 *
 * @param input - A GitHub client instance or installation token string.
 * @param options - Optional client configuration when providing a token.
 * @returns An array of repository descriptors including id, name, and owner login.
 * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
 * @example
 * ```ts
 * const repos = await listReposForInstallation(token);
 * ```
 */
export async function listReposForInstallation(
  input: GitHubClient | string,
  options?: GitHubClientOptions
): Promise<
  Array<{
    id: number;
    full_name: string;
    default_branch: string;
    visibility: string;
    description: string | null;
    topics: string[];
    owner: { login: string };
  }>
> {
  const client = ensureClient(input, options);
  const response = await client.listRepositoriesForInstallation<{
    id: number;
    full_name: string;
    default_branch: string;
    visibility: string;
    description: string | null;
    topics?: string[];
    owner: { login: string };
  }>();
  return (response.repositories ?? []).map((repo) => ({
    id: repo.id,
    full_name: repo.full_name,
    default_branch: repo.default_branch,
    visibility: repo.visibility,
    description: repo.description ?? null,
    topics: repo.topics ?? [],
    owner: { login: repo.owner.login },
  }));
}

/**
 * Performs a GitHub search using either an existing client or token.
 *
 * @param input - A GitHub client instance or installation token string.
 * @param endpoint - The GitHub search endpoint to query.
 * @param q - The GitHub search query string.
 * @param extra - Optional extra search parameters such as pagination.
 * @param options - Optional client configuration when providing a token.
 * @returns The raw search response payload from GitHub.
 * @throws {GitHubHttpError} When GitHub responds with a non-success status code.
 * @example
 * ```ts
 * const results = await searchGithub(token, 'repositories', 'topic:workers', { per_page: 5 });
 * ```
 */
export function searchGithub(
  input: GitHubClient | string,
  endpoint: 'issues' | 'commits' | 'repositories' | 'users',
  q: string,
  extra: Record<string, unknown> = {},
  options?: GitHubClientOptions
): Promise<unknown> {
  const client = ensureClient(input, options);
  const params: GitHubSearchParams = {};
  if (typeof extra.per_page === 'number') {
    params.per_page = extra.per_page;
  }
  if (typeof extra.page === 'number') {
    params.page = extra.page;
  }
  if (typeof extra.sort === 'string') {
    params.sort = extra.sort;
  }
  if (typeof extra.order === 'string' && (extra.order === 'asc' || extra.order === 'desc')) {
    params.order = extra.order;
  }

  if (endpoint === 'repositories') {
    return client.searchRepositories(q, params);
  }
  if (endpoint === 'issues') {
    return client.searchIssues(q, params);
  }
  if (endpoint === 'users') {
    return client.searchUsers(q, params);
  }
  return client.search(endpoint, q, params);
}

function ensureClient(input: GitHubClient | string | undefined, options?: GitHubClientOptions): GitHubClient {
  if (input instanceof GitHubClient) {
    return input;
  }
  if (!input) {
    throw new Error('A GitHub installation token or client must be provided.');
  }
  return new GitHubClient({ ...options, installationToken: input });
}

function resolveBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
}

function buildAppHeaders(appJwt: string, options: GitHubAppRequestOptions): Headers {
  const headers = new Headers();
  headers.set('accept', 'application/vnd.github+json');
  headers.set('authorization', `Bearer ${appJwt}`);
  headers.set('user-agent', 'gh-bot-client');
  if (options.requestTag) {
    headers.set('x-request-tag', options.requestTag);
  }
  return headers;
}

function buildSearchParams(query: string, params: GitHubSearchParams): URLSearchParams {
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

function encodeGitHubPath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function decodeBase64(content: string): string {
  if (typeof atob === 'function') {
    const binary = atob(content);
    const length = binary.length;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  }
  return Buffer.from(content, 'base64').toString('utf-8');
}

function selectToken(options: GitHubClientOptions): string | undefined {
  return options.installationToken ?? options.personalAccessToken ?? options.env?.GITHUB_TOKEN;
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

export interface EnsurePullRequestParams {
  client: GitHubClient;
  target: RepositoryTarget;
  baseBranch: string;
  branch: string;
  commitMessage: string;
  files: CommitFile[];
  logger: Logger;
  prBody: string;
  existingPr?: PullRequestSummary | null;
}

/**
 * Ensures a working branch exists for standardization tasks, creating it when missing.
 *
 * @param client - The GitHub client used for API interactions.
 * @param target - The repository coordinates to manage.
 * @param desiredBranch - The branch name to ensure.
 * @param baseBranch - The branch the work branch should fork from when created.
 * @param logger - Logger used for structured debug output.
 * @returns The SHA of the branch head after ensuring it exists.
 * @throws {GitHubHttpError} When GitHub responds with an unexpected error code.
 * @example
 * ```ts
 * const sha = await ensureBranchExists(client, { owner: 'octocat', repo: 'hello-world' }, 'auto/work', 'main', logger);
 * console.log(sha);
 * ```
 */
export async function ensureBranchExists(
  client: GitHubClient,
  target: RepositoryTarget,
  desiredBranch: string,
  baseBranch: string,
  logger: Logger
): Promise<string> {
  try {
    const sha = await client.getBranchSha(target, desiredBranch);
    logger.debug('Reusing existing work branch', { desiredBranch, sha });
    return sha;
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status !== 404) {
      throw error;
    }
    logger.info('Creating work branch', { desiredBranch });
    const baseSha = await client.getBranchSha(target, baseBranch);
    await client.createBranch({
      owner: target.owner,
      repo: target.repo,
      ref: `refs/heads/${desiredBranch}`,
      sha: baseSha,
    });
    return baseSha;
  }
}

/**
 * Creates or updates a standardization pull request with a freshly committed tree.
 *
 * @param params - Complete configuration for the commit and PR workflow.
 * @returns The pull request summary representing the ensured PR.
 * @throws {GitHubHttpError} When GitHub responds with an unexpected error code.
 * @example
 * ```ts
 * const pr = await ensurePullRequestWithCommit({
 *   client,
 *   target: { owner: 'octocat', repo: 'hello-world' },
 *   baseBranch: 'main',
 *   branch: 'auto/work',
 *   commitMessage: 'chore: sync files',
 *   files: [{ path: 'README.md', content: '# Hello' }],
 *   logger,
 *   prBody: 'Automated update',
 * })
 * ```
 */
export async function ensurePullRequestWithCommit(params: EnsurePullRequestParams): Promise<PullRequestSummary> {
  const { client, target, baseBranch, branch, commitMessage, files, logger, prBody, existingPr } = params;
  if (!files.length) {
    throw new Error('No files to commit');
  }

  const branchSha = await client.getBranchSha(target, branch);
  const baseCommit = await client.getCommit<{ tree: { sha: string } }>(target, branchSha);
  const treeResponse = await client.request<{ sha: string }>(`/repos/${target.owner}/${target.repo}/git/trees`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      base_tree: baseCommit.tree.sha,
      tree: files.map((file) => ({
        path: file.path,
        mode: file.mode ?? '100644',
        type: 'blob',
        content: file.content,
      })),
    }),
  });

  const commit = await client.createCommit<{ sha: string }>({
    owner: target.owner,
    repo: target.repo,
    message: commitMessage,
    tree: treeResponse.sha,
    parents: [branchSha],
  });

  await client.updateRef({
    owner: target.owner,
    repo: target.repo,
    ref: `heads/${branch}`,
    sha: commit.sha,
    force: false,
  });

  if (existingPr) {
    logger.info('Updating existing PR with new commit', { number: existingPr.number });
    await client.request(`/repos/${target.owner}/${target.repo}/pulls/${existingPr.number}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ body: prBody }),
    });
    return existingPr;
  }

  logger.info('Creating new pull request', { branch });
  const pr = await client.request<PullRequestSummary>(`/repos/${target.owner}/${target.repo}/pulls`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title: prTitle,
      head: branch,
      base: baseBranch,
      body: prBody,
    }),
  });

  return pr;
}
