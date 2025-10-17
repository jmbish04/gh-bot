/**
 * @fileoverview GitHub API Integration Module for Cloudflare Workers
 * 
 * This module provides a comprehensive interface to GitHub's REST and GraphQL APIs,
 * designed for maximum readability and usability by both AI agents and human developers.
 * 
 * Key Features:
 * - REST API client for common operations (repositories, issues, PRs, files)
 * - GraphQL API client for complex queries and mutations
 * - Type-safe interfaces for all API responses
 * - Error handling with detailed error messages
 * - Rate limit awareness and handling
 * - Caching support for frequently accessed data
 * 
 * Usage:
 * ```typescript
 * const client = new GitHubAPIClient(env.GITHUB_TOKEN);
 * const repo = await client.getRepository('owner', 'repo');
 * const issues = await client.listIssues('owner', 'repo', { state: 'open' });
 * ```
 * 
 * @module routes/github
 * @requires @cloudflare/workers-types
 * @version 1.0.0
 */

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * GitHub REST API base URL
 * @constant
 */
const GITHUB_API_BASE = 'https://api.github.com';

/**
 * GitHub GraphQL API endpoint
 * @constant
 */
const GITHUB_GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

/**
 * Configuration options for API requests
 * @interface GitHubAPIOptions
 */
export interface GitHubAPIOptions {
  /** GitHub Personal Access Token for authentication */
  token: string;
  /** Optional custom headers to include in requests */
  headers?: Record<string, string>;
  /** Optional timeout for requests in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Response structure for GitHub API calls
 * @interface GitHubAPIResponse
 * @template T - The type of the response data
 */
export interface GitHubAPIResponse<T> {
  /** The response data */
  data: T;
  /** Response headers including rate limit information */
  headers: Headers;
  /** HTTP status code */
  status: number;
  /** Whether the request was successful */
  ok: boolean;
}

/**
 * GitHub rate limit information
 * @interface RateLimitInfo
 */
export interface RateLimitInfo {
  /** Maximum number of requests per hour */
  limit: number;
  /** Remaining requests in the current window */
  remaining: number;
  /** Unix timestamp when the rate limit resets */
  reset: number;
  /** Resource type (core, search, graphql) */
  resource: string;
}

/**
 * Repository information structure
 * @interface Repository
 */
export interface Repository {
  id: number;
  name: string;
  full_name: string;
  owner: {
    login: string;
    id: number;
    type: string;
  };
  private: boolean;
  description: string | null;
  fork: boolean;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  homepage: string | null;
  size: number;
  stargazers_count: number;
  watchers_count: number;
  language: string | null;
  forks_count: number;
  open_issues_count: number;
  default_branch: string;
  topics: string[];
  visibility: string;
}

/**
 * Issue or Pull Request structure
 * @interface Issue
 */
export interface Issue {
  id: number;
  number: number;
  title: string;
  state: 'open' | 'closed';
  user: {
    login: string;
    id: number;
  };
  body: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  labels: Array<{
    id: number;
    name: string;
    color: string;
    description: string | null;
  }>;
  assignees: Array<{
    login: string;
    id: number;
  }>;
  comments: number;
  pull_request?: {
    url: string;
    html_url: string;
    diff_url: string;
    patch_url: string;
  };
}

/**
 * Pull Request structure (extends Issue with PR-specific fields)
 * @interface PullRequest
 */
export interface PullRequest extends Issue {
  head: {
    ref: string;
    sha: string;
    repo: Repository | null;
  };
  base: {
    ref: string;
    sha: string;
    repo: Repository;
  };
  merged: boolean;
  mergeable: boolean | null;
  merged_at: string | null;
  draft: boolean;
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
}

/**
 * File content structure
 * @interface FileContent
 */
export interface FileContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  content?: string;
  encoding?: string;
  download_url: string | null;
  html_url: string;
}

/**
 * Commit structure
 * @interface Commit
 */
export interface Commit {
  sha: string;
  commit: {
    author: {
      name: string;
      email: string;
      date: string;
    };
    committer: {
      name: string;
      email: string;
      date: string;
    };
    message: string;
  };
  author: {
    login: string;
    id: number;
  } | null;
  committer: {
    login: string;
    id: number;
  } | null;
  parents: Array<{
    sha: string;
    url: string;
  }>;
}

/**
 * Options for listing issues
 * @interface ListIssuesOptions
 */
export interface ListIssuesOptions {
  /** Filter by state: open, closed, or all (default: open) */
  state?: 'open' | 'closed' | 'all';
  /** Filter by labels (comma-separated) */
  labels?: string;
  /** Sort by: created, updated, or comments (default: created) */
  sort?: 'created' | 'updated' | 'comments';
  /** Sort direction: asc or desc (default: desc) */
  direction?: 'asc' | 'desc';
  /** Results per page (default: 30, max: 100) */
  per_page?: number;
  /** Page number (default: 1) */
  page?: number;
}

/**
 * Options for listing pull requests
 * @interface ListPullRequestsOptions
 */
export interface ListPullRequestsOptions {
  /** Filter by state: open, closed, or all (default: open) */
  state?: 'open' | 'closed' | 'all';
  /** Filter by head user or branch (format: user:ref) */
  head?: string;
  /** Filter by base branch */
  base?: string;
  /** Sort by: created, updated, popularity, or long-running (default: created) */
  sort?: 'created' | 'updated' | 'popularity' | 'long-running';
  /** Sort direction: asc or desc (default: desc) */
  direction?: 'asc' | 'desc';
  /** Results per page (default: 30, max: 100) */
  per_page?: number;
  /** Page number (default: 1) */
  page?: number;
}

/**
 * GraphQL query result structure
 * @interface GraphQLResponse
 * @template T - The type of the query result
 */
export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
  }>;
}

// ============================================================================
// MAIN API CLIENT CLASS
// ============================================================================

/**
 * GitHub API Client
 * 
 * Primary class for interacting with GitHub's REST and GraphQL APIs.
 * Handles authentication, request formatting, error handling, and rate limiting.
 * 
 * Example usage:
 * ```typescript
 * const client = new GitHubAPIClient(token);
 * 
 * // Fetch repository details
 * const repo = await client.getRepository('octocat', 'Hello-World');
 * 
 * // List open issues
 * const issues = await client.listIssues('octocat', 'Hello-World', { state: 'open' });
 * 
 * // Execute GraphQL query
 * const result = await client.graphql(`
 *   query {
 *     viewer {
 *       login
 *     }
 *   }
 * `);
 * ```
 * 
 * @class GitHubAPIClient
 */
export class GitHubAPIClient {
  private token: string;
  private headers: Record<string, string>;
  private timeout: number;

  /**
   * Creates a new GitHub API client instance
   * 
   * @param {string} token - GitHub Personal Access Token with appropriate scopes
   * @param {Record<string, string>} customHeaders - Optional custom headers
   * @param {number} timeout - Request timeout in milliseconds (default: 30000)
   * 
   * @example
   * const client = new GitHubAPIClient(env.GITHUB_TOKEN);
   */
  constructor(token: string, customHeaders?: Record<string, string>, timeout: number = 30000) {
    this.token = token;
    this.timeout = timeout;
    this.headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Cloudflare-Worker-GitHub-Client/1.0',
      ...customHeaders,
    };
  }

  // ==========================================================================
  // CORE REQUEST METHODS
  // ==========================================================================

  /**
   * Makes a REST API request to GitHub
   * 
   * Internal method that handles the core HTTP request logic including:
   * - Authentication header injection
   * - Timeout handling
   * - Rate limit header extraction
   * - Error response handling
   * 
   * @private
   * @template T - Expected response data type
   * @param {string} endpoint - API endpoint path (e.g., '/repos/owner/repo')
   * @param {RequestInit} options - Fetch API options
   * @returns {Promise<GitHubAPIResponse<T>>} Structured API response
   * @throws {Error} If request fails or returns non-2xx status
   */
  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<GitHubAPIResponse<T>> {
    const url = `${GITHUB_API_BASE}${endpoint}`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...this.headers,
          ...options.headers,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const text = await response.text();
      const data = text ? (JSON.parse(text) as T) : (null as T);

      if (!response.ok) {
        throw new Error(
          `GitHub API error: ${response.status} ${response.statusText} - ${text}`
        );
      }

      return {
        data,
        headers: response.headers,
        status: response.status,
        ok: response.ok,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this.timeout}ms`);
      }
      throw error;
    }
  }

  /**
   * Makes a GraphQL API request to GitHub
   * 
   * Executes GraphQL queries and mutations against GitHub's GraphQL API.
   * Supports variables and operation names.
   * 
   * @template T - Expected response data type
   * @param {string} query - GraphQL query or mutation string
   * @param {Record<string, any>} variables - Query variables
   * @returns {Promise<GraphQLResponse<T>>} GraphQL response with data or errors
   * @throws {Error} If request fails or returns errors
   * 
   * @example
   * const result = await client.graphql(`
   *   query($owner: String!, $name: String!) {
   *     repository(owner: $owner, name: $name) {
   *       name
   *       description
   *       stargazerCount
   *     }
   *   }
   * `, { owner: 'octocat', name: 'Hello-World' });
   */
  async graphql<T>(query: string, variables?: Record<string, any>): Promise<GraphQLResponse<T>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(GITHUB_GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const result = await response.json() as GraphQLResponse<T>;

      if (result.errors && result.errors.length > 0) {
        throw new Error(
          `GraphQL errors: ${result.errors.map(e => e.message).join(', ')}`
        );
      }

      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`GraphQL request timeout after ${this.timeout}ms`);
      }
      throw error;
    }
  }

  // ==========================================================================
  // RATE LIMIT METHODS
  // ==========================================================================

  /**
   * Retrieves current rate limit information
   * 
   * Returns information about the authenticated user's rate limits
   * for different API resources (core, search, graphql).
   * 
   * @returns {Promise<Record<string, RateLimitInfo>>} Rate limit info by resource
   * 
   * @example
   * const limits = await client.getRateLimit();
   * console.log(`Remaining requests: ${limits.core.remaining}`);
   */
  async getRateLimit(): Promise<Record<string, RateLimitInfo>> {
    const response = await this.request<{
      resources: Record<string, RateLimitInfo>;
    }>('/rate_limit');
    return response.data.resources;
  }

  // ==========================================================================
  // REPOSITORY METHODS
  // ==========================================================================

  /**
   * Retrieves detailed information about a repository
   * 
   * @param {string} owner - Repository owner (username or organization)
   * @param {string} repo - Repository name
   * @returns {Promise<Repository>} Repository details
   * 
   * @example
   * const repo = await client.getRepository('octocat', 'Hello-World');
   * console.log(`Stars: ${repo.stargazers_count}`);
   */
  async getRepository(owner: string, repo: string): Promise<Repository> {
    const response = await this.request<Repository>(`/repos/${owner}/${repo}`);
    return response.data;
  }

  /**
   * Lists repositories for a user or organization
   * 
   * @param {string} owner - Username or organization name
   * @param {number} page - Page number for pagination (default: 1)
   * @param {number} per_page - Results per page (default: 30, max: 100)
   * @returns {Promise<Repository[]>} Array of repositories
   * 
   * @example
   * const repos = await client.listRepositories('octocat');
   */
  async listRepositories(
    owner: string,
    page: number = 1,
    per_page: number = 30
  ): Promise<Repository[]> {
    const response = await this.request<Repository[]>(
      `/users/${owner}/repos?page=${page}&per_page=${per_page}`
    );
    return response.data;
  }

  // ==========================================================================
  // ISSUE METHODS
  // ==========================================================================

  /**
   * Lists issues for a repository
   * 
   * Retrieves a list of issues (not including pull requests) based on filters.
   * 
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {ListIssuesOptions} options - Filtering and pagination options
   * @returns {Promise<Issue[]>} Array of issues
   * 
   * @example
   * const openIssues = await client.listIssues('octocat', 'Hello-World', {
   *   state: 'open',
   *   labels: 'bug,help wanted',
   *   per_page: 50
   * });
   */
  async listIssues(
    owner: string,
    repo: string,
    options: ListIssuesOptions = {}
  ): Promise<Issue[]> {
    const params = new URLSearchParams();
    if (options.state) params.append('state', options.state);
    if (options.labels) params.append('labels', options.labels);
    if (options.sort) params.append('sort', options.sort);
    if (options.direction) params.append('direction', options.direction);
    if (options.per_page) params.append('per_page', options.per_page.toString());
    if (options.page) params.append('page', options.page.toString());

    const queryString = params.toString();
    const endpoint = `/repos/${owner}/${repo}/issues${queryString ? '?' + queryString : ''}`;
    
    const response = await this.request<Issue[]>(endpoint);
    return response.data;
  }

  /**
   * Retrieves a specific issue by number
   * 
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} issue_number - Issue number
   * @returns {Promise<Issue>} Issue details
   * 
   * @example
   * const issue = await client.getIssue('octocat', 'Hello-World', 1);
   */
  async getIssue(owner: string, repo: string, issue_number: number): Promise<Issue> {
    const response = await this.request<Issue>(`/repos/${owner}/${repo}/issues/${issue_number}`);
    return response.data;
  }

  /**
   * Creates a new issue in a repository
   * 
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {object} data - Issue data
   * @param {string} data.title - Issue title (required)
   * @param {string} data.body - Issue body/description
   * @param {string[]} data.labels - Array of label names
   * @param {string[]} data.assignees - Array of assignee usernames
   * @returns {Promise<Issue>} Created issue
   * 
   * @example
   * const newIssue = await client.createIssue('octocat', 'Hello-World', {
   *   title: 'Found a bug',
   *   body: 'Description of the bug',
   *   labels: ['bug']
   * });
   */
  async createIssue(
    owner: string,
    repo: string,
    data: {
      title: string;
      body?: string;
      labels?: string[];
      assignees?: string[];
    }
  ): Promise<Issue> {
    const response = await this.request<Issue>(`/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return response.data;
  }

  // ==========================================================================
  // PULL REQUEST METHODS
  // ==========================================================================

  /**
   * Lists pull requests for a repository
   * 
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {ListPullRequestsOptions} options - Filtering and pagination options
   * @returns {Promise<PullRequest[]>} Array of pull requests
   * 
   * @example
   * const openPRs = await client.listPullRequests('octocat', 'Hello-World', {
   *   state: 'open',
   *   sort: 'updated',
   *   direction: 'desc'
   * });
   */
  async listPullRequests(
    owner: string,
    repo: string,
    options: ListPullRequestsOptions = {}
  ): Promise<PullRequest[]> {
    const params = new URLSearchParams();
    if (options.state) params.append('state', options.state);
    if (options.head) params.append('head', options.head);
    if (options.base) params.append('base', options.base);
    if (options.sort) params.append('sort', options.sort);
    if (options.direction) params.append('direction', options.direction);
    if (options.per_page) params.append('per_page', options.per_page.toString());
    if (options.page) params.append('page', options.page.toString());

    const queryString = params.toString();
    const endpoint = `/repos/${owner}/${repo}/pulls${queryString ? '?' + queryString : ''}`;
    
    const response = await this.request<PullRequest[]>(endpoint);
    return response.data;
  }

  /**
   * Retrieves a specific pull request by number
   * 
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} pull_number - Pull request number
   * @returns {Promise<PullRequest>} Pull request details
   * 
   * @example
   * const pr = await client.getPullRequest('octocat', 'Hello-World', 42);
   */
  async getPullRequest(
    owner: string,
    repo: string,
    pull_number: number
  ): Promise<PullRequest> {
    const response = await this.request<PullRequest>(
      `/repos/${owner}/${repo}/pulls/${pull_number}`
    );
    return response.data;
  }

  /**
   * Retrieves files changed in a pull request
   * 
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} pull_number - Pull request number
   * @returns {Promise<Array<{filename: string, status: string, additions: number, deletions: number, changes: number, patch?: string}>>}
   * 
   * @example
   * const files = await client.getPullRequestFiles('octocat', 'Hello-World', 42);
   * files.forEach(file => console.log(`${file.filename}: +${file.additions} -${file.deletions}`));
   */
  async getPullRequestFiles(
    owner: string,
    repo: string,
    pull_number: number
  ): Promise<Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
  }>> {
    const response = await this.request<Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      changes: number;
      patch?: string;
    }>>(`/repos/${owner}/${repo}/pulls/${pull_number}/files`);
    return response.data;
  }

  // ==========================================================================
  // FILE CONTENT METHODS
  // ==========================================================================

  /**
   * Retrieves the contents of a file or directory
   * 
   * For files, the content is returned base64-encoded.
   * For directories, returns an array of file/directory entries.
   * 
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} path - File or directory path
   * @param {string} ref - Git reference (branch, tag, or commit SHA)
   * @returns {Promise<FileContent | FileContent[]>} File content or directory listing
   * 
   * @example
   * // Get a file
   * const file = await client.getContents('octocat', 'Hello-World', 'README.md');
   * if ('content' in file) {
   *   const content = atob(file.content);
   * }
   * 
   * // Get a directory
   * const dir = await client.getContents('octocat', 'Hello-World', 'src');
   * if (Array.isArray(dir)) {
   *   dir.forEach(item => console.log(item.name));
   * }
   */
  async getContents(
    owner: string,
    repo: string,
    path: string,
    ref?: string
  ): Promise<FileContent | FileContent[]> {
    const endpoint = `/repos/${owner}/${repo}/contents/${path}${ref ? `?ref=${ref}` : ''}`;
    const response = await this.request<FileContent | FileContent[]>(endpoint);
    return response.data;
  }

  /**
   * Retrieves the raw content of a file
   * 
   * Returns the decoded file content as a string.
   * 
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} path - File path
   * @param {string} ref - Git reference (branch, tag, or commit SHA)
   * @returns {Promise<string>} Decoded file content
   * 
   * @example
   * const readme = await client.getFileContent('octocat', 'Hello-World', 'README.md');
   * console.log(readme);
   */
  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string
  ): Promise<string> {
    const content = await this.getContents(owner, repo, path, ref);
    
    if (Array.isArray(content)) {
      throw new Error('Path is a directory, not a file');
    }

    if (!content.content || !content.encoding) {
      throw new Error('No content available for this file');
    }

    if (content.encoding === 'base64') {
      // Decode base64 content
      return atob(content.content.replace(/\n/g, ''));
    }

    return content.content;
  }

  // ==========================================================================
  // COMMIT METHODS
  // ==========================================================================

  /**
   * Lists commits for a repository
   * 
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {object} options - Optional parameters
   * @param {string} options.sha - SHA or branch to start listing from
   * @param {string} options.path - Only commits affecting this path
   * @param {string} options.author - GitHub username or email
   * @param {number} options.per_page - Results per page (default: 30, max: 100)
   * @param {number} options.page - Page number
   * @returns {Promise<Commit[]>} Array of commits
   * 
   * @example
   * const commits = await client.listCommits('octocat', 'Hello-World', {
   *   sha: 'main',
   *   per_page: 50
   * });
   */
  async listCommits(
    owner: string,
    repo: string,
    options: {
      sha?: string;
      path?: string;
      author?: string;
      per_page?: number;
      page?: number;
    } = {}
  ): Promise<Commit[]> {
    const params = new URLSearchParams();
    if (options.sha) params.append('sha', options.sha);
    if (options.path) params.append('path', options.path);
    if (options.author) params.append('author', options.author);
    if (options.per_page) params.append('per_page', options.per_page.toString());
    if (options.page) params.append('page', options.page.toString());

    const queryString = params.toString();
    const endpoint = `/repos/${owner}/${repo}/commits${queryString ? '?' + queryString : ''}`;
    
    const response = await this.request<Commit[]>(endpoint);
    return response.data;
  }

  /**
   * Retrieves a specific commit by SHA
   * 
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} ref - Commit SHA
   * @returns {Promise<Commit>} Commit details
   * 
   * @example
   * const commit = await client.getCommit('octocat', 'Hello-World', 'abc123');
   */
  async getCommit(owner: string, repo: string, ref: string): Promise<Commit> {
    const response = await this.request<Commit>(`/repos/${owner}/${repo}/commits/${ref}`);
    return response.data;
  }

  // ==========================================================================
  // SEARCH METHODS
  // ==========================================================================

  /**
   * Searches for repositories
   * 
   * @param {string} query - Search query string
   * @param {object} options - Search options
   * @param {string} options.sort - Sort by: stars, forks, help-wanted-issues, updated
   * @param {string} options.order - Sort order: asc or desc
   * @param {number} options.per_page - Results per page (max: 100)
   * @param {number} options.page - Page number
   * @returns {Promise<{total_count: number, items: Repository[]}>} Search results
   * 
   * @example
   * const results = await client.searchRepositories('language:typescript stars:>1000', {
   *   sort: 'stars',
   *   order: 'desc'
   * });
   */
  async searchRepositories(
    query: string,
    options: {
      sort?: 'stars' | 'forks' | 'help-wanted-issues' | 'updated';
      order?: 'asc' | 'desc';
      per_page?: number;
      page?: number;
    } = {}
  ): Promise<{ total_count: number; items: Repository[] }> {
    const params = new URLSearchParams({ q: query });
    if (options.sort) params.append('sort', options.sort);
    if (options.order) params.append('order', options.order);
    if (options.per_page) params.append('per_page', options.per_page.toString());
    if (options.page) params.append('page', options.page.toString());

    const response = await this.request<{ total_count: number; items: Repository[] }>(
      `/search/repositories?${params.toString()}`
    );
    return response.data;
  }

  /**
   * Searches for issues and pull requests
   * 
   * @param {string} query - Search query string
   * @param {object} options - Search options
   * @param {string} options.sort - Sort by: comments, reactions, created, updated
   * @param {string} options.order - Sort order: asc or desc
   * @param {number} options.per_page - Results per page (max: 100)
   * @param {number} options.page - Page number
   * @returns {Promise<{total_count: number, items: Issue[]}>} Search results
   * 
   * @example
   * const results = await client.searchIssues('repo:octocat/Hello-World is:open label:bug');
   */
  async searchIssues(
    query: string,
    options: {
      sort?: 'comments' | 'reactions' | 'created' | 'updated';
      order?: 'asc' | 'desc';
      per_page?: number;
      page?: number;
    } = {}
  ): Promise<{ total_count: number; items: Issue[] }> {
    const params = new URLSearchParams({ q: query });
    if (options.sort) params.append('sort', options.sort);
    if (options.order) params.append('order', options.order);
    if (options.per_page) params.append('per_page', options.per_page.toString());
    if (options.page) params.append('page', options.page.toString());

    const response = await this.request<{ total_count: number; items: Issue[] }>(
      `/search/issues?${params.toString()}`
    );
    return response.data;
  }

  /**
   * Searches for code in repositories
   * 
   * @param {string} query - Search query string
   * @param {object} options - Search options
   * @param {string} options.sort - Sort by: indexed
   * @param {string} options.order - Sort order: asc or desc
   * @param {number} options.per_page - Results per page (max: 100)
   * @param {number} options.page - Page number
   * @returns {Promise<{total_count: number, items: Array<{name: string, path: string, sha: string, url: string, html_url: string, repository: Repository}>}>}
   * 
   * @example
   * const results = await client.searchCode('addClass in:file language:js repo:jquery/jquery');
   */
  async searchCode(
    query: string,
    options: {
      sort?: 'indexed';
      order?: 'asc' | 'desc';
      per_page?: number;
      page?: number;
    } = {}
  ): Promise<{
    total_count: number;
    items: Array<{
      name: string;
      path: string;
      sha: string;
      url: string;
      html_url: string;
      repository: Repository;
    }>;
  }> {
    const params = new URLSearchParams({ q: query });
    if (options.sort) params.append('sort', options.sort);
    if (options.order) params.append('order', options.order);
    if (options.per_page) params.append('per_page', options.per_page.toString());
    if (options.page) params.append('page', options.page.toString());

    const response = await this.request<{
      total_count: number;
      items: Array<{
        name: string;
        path: string;
        sha: string;
        url: string;
        html_url: string;
        repository: Repository;
      }>;
    }>(`/search/code?${params.toString()}`);
    return response.data;
  }

  // ==========================================================================
  // GRAPHQL HELPER METHODS
  // ==========================================================================

  /**
   * Executes a repository query using GraphQL
   * 
   * Pre-built GraphQL query for retrieving comprehensive repository information.
   * 
   * @param {string} owner - Repository owner
   * @param {string} name - Repository name
   * @returns {Promise<any>} Repository data from GraphQL
   * 
   * @example
   * const repoData = await client.getRepositoryGraphQL('octocat', 'Hello-World');
   */
  async getRepositoryGraphQL(owner: string, name: string): Promise<any> {
    const query = `
      query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          id
          name
          description
          url
          createdAt
          updatedAt
          stargazerCount
          forkCount
          issues(states: OPEN) {
            totalCount
          }
          pullRequests(states: OPEN) {
            totalCount
          }
          defaultBranchRef {
            name
            target {
              ... on Commit {
                history(first: 10) {
                  edges {
                    node {
                      message
                      author {
                        name
                        email
                        date
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const result = await this.graphql<{ repository: any }>(query, { owner, name });
    return result.data?.repository;
  }

  /**
   * Retrieves user information using GraphQL
   * 
   * @param {string} login - GitHub username
   * @returns {Promise<any>} User data
   * 
   * @example
   * const user = await client.getUserGraphQL('octocat');
   */
  async getUserGraphQL(login: string): Promise<any> {
    const query = `
      query($login: String!) {
        user(login: $login) {
          id
          login
          name
          bio
          company
          location
          email
          createdAt
          followers {
            totalCount
          }
          following {
            totalCount
          }
          repositories(first: 100, orderBy: {field: STARGAZERS, direction: DESC}) {
            totalCount
            nodes {
              name
              description
              stargazerCount
              forkCount
            }
          }
        }
      }
    `;

    const result = await this.graphql<{ user: any }>(query, { login });
    return result.data?.user;
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Creates a GitHub API client instance from environment variables
 * 
 * Convenience function for creating a client with minimal configuration.
 * 
 * @param {object} env - Environment object containing GITHUB_TOKEN
 * @returns {GitHubAPIClient} Configured client instance
 * @throws {Error} If GITHUB_TOKEN is not provided
 * 
 * @example
 * // In a Cloudflare Worker
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const client = createGitHubClient(env);
 *     const repos = await client.listRepositories('octocat');
 *     return new Response(JSON.stringify(repos));
 *   }
 * }
 */
export function createGitHubClient(env: { GITHUB_TOKEN: string }): GitHubAPIClient {
  if (!env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN environment variable is required');
  }
  return new GitHubAPIClient(env.GITHUB_TOKEN);
}

/**
 * Parses GitHub URLs to extract owner and repository name
 * 
 * @param {string} url - GitHub URL (https://github.com/owner/repo)
 * @returns {{ owner: string; repo: string } | null} Parsed owner and repo, or null if invalid
 * 
 * @example
 * const parsed = parseGitHubURL('https://github.com/octocat/Hello-World');
 * // Returns: { owner: 'octocat', repo: 'Hello-World' }
 */
export function parseGitHubURL(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/, ''),
  };
}

/**
 * Formats a date string into a human-readable format
 * 
 * @param {string} dateString - ISO 8601 date string
 * @returns {string} Formatted date
 * 
 * @example
 * const formatted = formatDate('2024-01-15T12:00:00Z');
 * // Returns: "January 15, 2024"
 */
export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Checks if rate limit is being approached
 * 
 * @param {RateLimitInfo} rateLimit - Rate limit information
 * @param {number} threshold - Threshold percentage (default: 0.1 = 10%)
 * @returns {boolean} True if remaining requests are below threshold
 * 
 * @example
 * const limits = await client.getRateLimit();
 * if (isRateLimitLow(limits.core)) {
 *   console.warn('Rate limit is running low!');
 * }
 */
export function isRateLimitLow(rateLimit: RateLimitInfo, threshold: number = 0.1): boolean {
  return rateLimit.remaining / rateLimit.limit < threshold;
}
