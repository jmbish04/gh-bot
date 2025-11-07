import type { Logger, RepositoryTarget } from './util';
import type { GitHubEnv } from './types/github-env';
import { GitHubGraphQLError, GitHubHttpError } from './clients/errors';
import type { GraphQLErrorPayload } from './clients/errors';
import { RestClient } from './clients/rest/core/client';
import type { InternalRestClientOptions } from './clients/rest/core/types';
import { safeParseJSON } from './clients/rest/core/response';
import { parseLinkHeaderNext } from './clients/rest/core/pagination';
import { decodeBase64, encodePath } from './clients/rest/core/utils';
import * as restRepos from './clients/rest/repos/repos';
import * as restTrees from './clients/rest/repos/trees';
import * as restBlobs from './clients/rest/repos/blobs';
import * as restBranches from './clients/rest/repos/branches';
import * as restCommits from './clients/rest/repos/commits';
import * as restContents from './clients/rest/repos/contents';
import * as restPulls from './clients/rest/pulls/pulls';
import * as restIssues from './clients/rest/issues/issues';
import * as restSearch from './clients/rest/search/search';
import * as restUsers from './clients/rest/users/users';
import * as restOrgs from './clients/rest/orgs/orgs';
import * as restApps from './clients/rest/apps/apps';
import type { GitHubAppRequestOptions } from './clients/rest/apps/types';
import { GraphQLHttpClient } from './clients/graphql/core/client';

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

interface InternalGitHubClientOptions extends GitHubClientOptions {
  baseUrl: string;
  token: string;
}

export type { GitHubAppRequestOptions };

export type GitHubSearchParams = restSearch.SearchParams;

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

const ADD_PULL_REQUEST_REVIEW_COMMENT = `mutation Reply($input: AddPullRequestReviewCommentInput!) {
  addPullRequestReviewComment(input: $input) {
    comment { id body }
  }
}`;

export class GitHubClient {
  private readonly options: InternalGitHubClientOptions;
  private readonly restClient: RestClient;
  private readonly graphqlClient: GraphQLHttpClient;

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

    const restOptions: InternalRestClientOptions = {
      baseUrl,
      token,
      defaultPerPage: options.defaultPerPage,
      paginationSoftLimit: options.paginationSoftLimit,
      timeoutMs: options.timeoutMs,
      requestTag: options.requestTag,
      logger: options.logger,
    };

    this.restClient = new RestClient(restOptions);
    this.graphqlClient = new GraphQLHttpClient({
      baseUrl,
      token,
      timeoutMs: options.timeoutMs,
      requestTag: options.requestTag,
      logger: options.logger,
    });
  }

  public async request<T>(path: string, init?: RequestInit): Promise<T> {
    const { data } = await this.restClient.requestWithResponse<T>(path, init);
    return data;
  }

  public rest<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
    return this.restClient.rest<T>(method, path, body, init);
  }

  public restWithResponse<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: RequestInit
  ): Promise<{ data: T; response: Response }> {
    return this.restClient.restWithResponse<T>(method, path, body, init);
  }

  public requestWithResponse<T>(path: string, init?: RequestInit): Promise<{ data: T; response: Response }> {
    return this.restClient.requestWithResponse<T>(path, init);
  }

  public requestPaginated<T>(path: string, searchParams?: URLSearchParams, cap?: number): Promise<T[]> {
    return this.restClient.collectPaginated<T>(path, { searchParams, limit: cap });
  }

  public async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    return this.graphqlClient.request<T>(query, variables);
  }

  public async getDefaultBranch(target: RepositoryTarget, fallback = 'main'): Promise<string> {
    const repo = await this.getRepository<{ default_branch?: string }>({ owner: target.owner, repo: target.repo });
    return repo.default_branch ?? fallback;
  }

  public async getBranchSha(target: RepositoryTarget, branch: string): Promise<string> {
    return restBranches.getBranchSha(this.restClient, { owner: target.owner, repo: target.repo, branch });
  }

  public getCommit<T = { sha: string; tree: { sha: string } }>(target: RepositoryTarget, sha: string): Promise<T> {
    return restCommits.getCommit<T>(this.restClient, { owner: target.owner, repo: target.repo, sha });
  }

  public listTree<T = restTrees.TreeEntry>(target: RepositoryTarget, sha: string, recursive = false): Promise<T[]> {
    return restTrees.listTree<T>(this.restClient, { owner: target.owner, repo: target.repo, sha, recursive });
  }

  public async getBlob(target: RepositoryTarget, sha: string): Promise<string> {
    const blob = await restBlobs.getBlob<{ content: string; encoding: string }>(this.restClient, {
      owner: target.owner,
      repo: target.repo,
      sha,
    });
    if (blob.encoding !== 'base64') {
      throw new Error(`Unsupported blob encoding: ${blob.encoding}`);
    }
    return decodeBase64(blob.content);
  }

  public async getFile(
    target: RepositoryTarget,
    path: string,
    ref: string
  ): Promise<{ content: string; sha: string } | null> {
    const file = await restContents.getFile(this.restClient, {
      owner: target.owner,
      repo: target.repo,
      path,
      ref,
    });
    if (!file) {
      return null;
    }
    if (file.content == null) {
      return null;
    }
    return { content: file.content, sha: file.sha ?? '' };
  }

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

  public async findOpenStandardizationPr(target: RepositoryTarget): Promise<PullRequestSummary | null> {
    const pulls = await restPulls.findOpenStandardizationPr(this.restClient, {
      owner: target.owner,
      repo: target.repo,
    });
    return pulls.find((pr) => pr.head.ref.startsWith('auto/standardize-agents-')) ?? null;
  }

  public getRepository<T = unknown>({ owner, repo }: { owner: string; repo: string }): Promise<T> {
    return restRepos.getRepository<T>(this.restClient, { owner, repo });
  }

  public listRepositoriesForInstallation<T = unknown>(): Promise<{
    total_count: number;
    repositories: T[];
  }> {
    return restRepos.listRepositoriesForInstallation<T>(this.restClient);
  }

  public getPullRequest<T = unknown>({
    owner,
    repo,
    pull_number,
  }: {
    owner: string;
    repo: string;
    pull_number: number;
  }): Promise<T> {
    return restPulls.getPullRequest<T>(this.restClient, { owner, repo, pull_number });
  }

  public listPullRequestFiles<T = unknown>({
    owner,
    repo,
    pull_number,
  }: {
    owner: string;
    repo: string;
    pull_number: number;
  }): Promise<T[]> {
    return restPulls.listPullRequestFiles<T>(this.restClient, { owner, repo, pull_number });
  }

  public listPullRequestReviewComments<T = unknown>({
    owner,
    repo,
    pull_number,
  }: {
    owner: string;
    repo: string;
    pull_number: number;
  }): Promise<T[]> {
    return restPulls.listPullRequestReviewComments<T>(this.restClient, { owner, repo, pull_number });
  }

  public getPullRequestReviewComment<T = unknown>({
    owner,
    repo,
    comment_id,
  }: {
    owner: string;
    repo: string;
    comment_id: number;
  }): Promise<T> {
    return restPulls.getPullRequestReviewComment<T>(this.restClient, { owner, repo, comment_id });
  }

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
    return restPulls.replyToPullRequestReviewComment<T>(this.restClient, {
      owner,
      repo,
      pull_number,
      in_reply_to,
      body,
    });
  }

  public async replyToComment<T = unknown>({
    owner,
    repo,
    pull_number,
    comment_id,
    body,
  }: ReplyToCommentParams): Promise<T> {
    const reviewComment = await restPulls.tryGetPullRequestReviewComment(this.restClient, {
      owner,
      repo,
      comment_id,
    });

    if (reviewComment) {
      try {
        return await restPulls.replyToPullRequestReviewThread<T>(this.restClient, { owner, repo, comment_id, body });
      } catch (error) {
        if (error instanceof GitHubHttpError && reviewComment.node_id) {
          const result = await this.graphql<{ addPullRequestReviewComment?: { comment?: T } }>(
            ADD_PULL_REQUEST_REVIEW_COMMENT,
            {
              input: {
                inReplyTo: reviewComment.node_id,
                body,
              },
            }
          );
          const comment = result.addPullRequestReviewComment?.comment;
          if (comment) {
            return comment;
          }
        }
        throw error;
      }
    }

    try {
      await restPulls.ensureIssueCommentExists(this.restClient, { owner, repo, comment_id });
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) {
        throw new Error(
          `Comment ${comment_id} not found as a pull request review or issue comment. Verify repository and permissions.`
        );
      }
      throw error;
    }

    return restPulls.replyToIssueComment<T>(this.restClient, { owner, repo, pull_number, body });
  }

  public addReactionToComment<T = unknown>({ owner, repo, comment_id, content }: ReactionParams): Promise<T> {
    return restPulls.addReactionToComment<T>(this.restClient, { owner, repo, comment_id, content });
  }

  public listIssues<T = unknown>({
    owner,
    repo,
    state,
  }: {
    owner: string;
    repo: string;
    state?: 'open' | 'closed' | 'all';
  }): Promise<T[]> {
    return restIssues.listIssues<T>(this.restClient, { owner, repo, state });
  }

  public getIssue<T = unknown>({
    owner,
    repo,
    issue_number,
  }: {
    owner: string;
    repo: string;
    issue_number: number;
  }): Promise<T> {
    return restIssues.getIssue<T>(this.restClient, { owner, repo, issue_number });
  }

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
    return restIssues.createIssue<T>(this.restClient, { owner, repo, title, body, labels });
  }

  public listIssueComments<T = unknown>({
    owner,
    repo,
    issue_number,
  }: {
    owner: string;
    repo: string;
    issue_number: number;
  }): Promise<T[]> {
    return restIssues.listIssueComments<T>(this.restClient, { owner, repo, issue_number });
  }

  public search<T = unknown>(
    endpoint: 'code' | 'commits' | 'issues' | 'repositories' | 'users',
    query: string,
    params: GitHubSearchParams = {}
  ): Promise<T> {
    return restSearch.search<T>(this.restClient, endpoint, query, params);
  }

  public searchRepositories<T = unknown>(query: string, params: GitHubSearchParams = {}): Promise<T> {
    return restSearch.searchRepositories<T>(this.restClient, query, params);
  }

  public searchCode<T = unknown>(query: string, params: GitHubSearchParams = {}): Promise<T> {
    return restSearch.searchCode<T>(this.restClient, query, params);
  }

  public searchIssues<T = unknown>(query: string, params: GitHubSearchParams = {}): Promise<T> {
    return restSearch.searchIssues<T>(this.restClient, query, params);
  }

  public searchUsers<T = unknown>(query: string, params: GitHubSearchParams = {}): Promise<T> {
    return restSearch.searchUsers<T>(this.restClient, query, params);
  }

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
    return restContents.getContents<T>(this.restClient, { owner, repo, path, ref });
  }

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
    sha?: string;
    branch?: string;
  }): Promise<T> {
    return restContents.updateFile<T>(this.restClient, { owner, repo, path, message, content, sha, branch });
  }

  public createCommit<T = unknown>({
    owner,
    repo,
    message,
    tree,
    parents,
  }: {
    owner: string;
    repo: string;
    message: string;
    tree: string;
    parents: string[];
  }): Promise<T> {
    return restCommits.createCommit<T>(this.restClient, { owner, repo, message, tree, parents });
  }

  public getBranch<T = unknown>({
    owner,
    repo,
    branch,
  }: {
    owner: string;
    repo: string;
    branch: string;
  }): Promise<T> {
    return restBranches.getBranch<T>(this.restClient, { owner, repo, branch });
  }

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
    return restBranches.createBranch<T>(this.restClient, { owner, repo, ref, sha });
  }

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
    return restBranches.updateRef<T>(this.restClient, { owner, repo, ref, sha, force });
  }

  public getUser<T = unknown>({ username }: { username: string }): Promise<T> {
    return restUsers.getUser<T>(this.restClient, username);
  }

  public getOrg<T = unknown>({ org }: { org: string }): Promise<T> {
    return restOrgs.getOrg<T>(this.restClient, org);
  }

  public createTree(
    owner: string,
    repo: string,
    baseTree: string,
    files: CommitFile[]
  ): Promise<{ sha: string }> {
    return restRepos.createTree(this.restClient, {
      owner,
      repo,
      base_tree: baseTree,
      tree: files.map((file) => ({
        path: file.path,
        mode: file.mode ?? '100644',
        type: 'blob',
        content: file.content,
      })),
    });
  }
}

export async function createGitHubAppJwt(env: GitHubEnv): Promise<string> {
  return restApps.createGitHubAppJwt(env);
}

export async function listInstallations<T = unknown>(
  env: GitHubEnv,
  options: GitHubAppRequestOptions = {}
): Promise<T> {
  return restApps.listInstallations<T>(env, options);
}

export async function getInstallationToken(
  env: GitHubEnv,
  installationId: number,
  options: GitHubAppRequestOptions = {}
): Promise<string> {
  return restApps.getInstallationToken(env, installationId, options);
}

export async function createInstallationClient(
  env: GitHubEnv,
  installationId: number,
  options: Omit<GitHubClientOptions, 'installationToken' | 'personalAccessToken'> = {}
): Promise<GitHubClient> {
  const token = await getInstallationToken(env, installationId, options);
  options.logger?.debug('Created installation client', { installationId });
  return new GitHubClient({ ...options, env, installationToken: token });
}

export async function checkUserHasPushAccess(
  client: GitHubClient,
  owner: string,
  repo: string,
  username: string
): Promise<boolean> {
  try {
    const permission = await client.rest<{ permission?: string }>(
      'GET',
      `/repos/${owner}/${repo}/collaborators/${username}/permission`
    );
    const level = permission?.permission ?? 'read';
    return level === 'admin' || level === 'maintain' || level === 'write';
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status === 404) {
      return false;
    }
    throw error;
  }
}

export async function postPRComment(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<{ comment_id: number; url: string }> {
  const comment = await client.rest<{ id: number; html_url: string }>('POST', `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    body,
  });
  return { comment_id: comment.id, url: comment.html_url };
}

export async function getPRBranchDetails(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ headBranch: string; headSha: string; baseBranch: string; baseSha: string }> {
  const pull = await client.rest<{ head: { ref: string; sha: string }; base: { ref: string; sha: string } }>(
    'GET',
    `/repos/${owner}/${repo}/pulls/${prNumber}`
  );
  return {
    headBranch: pull.head.ref,
    headSha: pull.head.sha,
    baseBranch: pull.base.ref,
    baseSha: pull.base.sha,
  };
}

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

export function replyToGitHubComment<T = unknown>(args: ReplyToGitHubCommentArgs): Promise<T> {
  const { installationToken, client, options, ...rest } = args;
  const resolvedClient = client ?? ensureClient(installationToken ?? '', options);
  return resolvedClient.replyToComment(rest);
}

export function addReactionToComment<T = unknown>(args: ReactionRequestArgs): Promise<T> {
  const { installationToken, client, options, ...rest } = args;
  const resolvedClient = client ?? ensureClient(installationToken ?? '', options);
  return resolvedClient.addReactionToComment(rest);
}

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
    description: repo.description,
    topics: repo.topics ?? [],
    owner: repo.owner,
  }));
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

export async function ensurePullRequestWithCommit(params: EnsurePullRequestParams): Promise<PullRequestSummary> {
  const { client, target, baseBranch, branch, commitMessage, files, logger, prBody, existingPr } = params;
  if (!files.length) {
    throw new Error('No files to commit');
  }

  const branchSha = await client.getBranchSha(target, branch);
  const baseCommit = await client.getCommit<{ tree: { sha: string } }>(target, branchSha);
  const treeResponse = await client.createTree(target.owner, target.repo, baseCommit.tree.sha, files);

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
    await client.rest('PATCH', `/repos/${target.owner}/${target.repo}/pulls/${existingPr.number}`, { body: prBody });
    return existingPr;
  }

  logger.info('Creating new pull request', { branch });
  const pr = await client.rest<PullRequestSummary>('POST', `/repos/${target.owner}/${target.repo}/pulls`, {
    title: commitMessage,
    head: branch,
    base: baseBranch,
    body: prBody,
  });

  return pr;
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

function selectToken(options: GitHubClientOptions): string | undefined {
  return options.installationToken ?? options.personalAccessToken ?? options.env?.GITHUB_TOKEN;
}

export { safeParseJSON, parseLinkHeaderNext, encodePath as encodeGitHubPath, decodeBase64 };
export { GitHubHttpError, GitHubGraphQLError } from './clients/errors';
export type { GraphQLErrorPayload } from './clients/errors';
export type { GitHubEnv } from './types/github-env';
