import { withRetries, type Logger, type RepositoryTarget } from "./util";

export interface GitHubEnv {
  GITHUB_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_INSTALLATION_ID?: string;
  GITHUB_REPO_DEFAULT_BRANCH_FALLBACK?: string;
}

export interface FileContent {
  path: string;
  sha: string | null;
  content: string;
  encoding: "utf-8";
}

export interface GitHubRepository {
  default_branch: string;
  name: string;
  full_name: string;
  owner: { login: string };
}

export interface PullRequestSummary {
  number: number;
  head: { ref: string };
  body?: string | null;
}

export interface GitHubClientOptions {
  env: GitHubEnv;
  logger: Logger;
}

export interface CommitFile {
  path: string;
  content: string;
  mode?: "100644" | "100755" | "040000" | "160000" | "120000";
}

interface TreeItem {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  size?: number;
  sha: string;
  url: string;
}

interface Commit {
  sha: string;
  tree: { sha: string };
  parents: { sha: string }[];
}

const API_BASE = "https://api.github.com";

export class GitHubClient {
  private readonly env: GitHubEnv;
  private readonly logger: Logger;

  constructor(options: GitHubClientOptions) {
    this.env = options.env;
    this.logger = options.logger;
  }

  private getAuthToken(): string {
    if (this.env.GITHUB_TOKEN) {
      return this.env.GITHUB_TOKEN;
    }
    if (this.env.GITHUB_APP_PRIVATE_KEY) {
      throw new Error("GitHub App authentication not yet implemented; provide GITHUB_TOKEN for now.");
    }
    throw new Error("No GitHub credentials configured");
  }

  private async request<T>(path: string, init: RequestInit & { method: string; query?: Record<string, string> }): Promise<T> {
    const url = new URL(`${API_BASE}${path}`);
    if (init.query) {
      for (const [key, value] of Object.entries(init.query)) {
        url.searchParams.set(key, value);
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.getAuthToken()}`,
      "User-Agent": "cf-worker-agent-standardizer",
    };

    const response = await withRetries(async () => {
      const res = await fetch(url.toString(), {
        ...init,
        headers: { ...headers, ...(init.headers ?? {}) },
      });

      if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        const delay = Math.max(0, reset * 1000 - Date.now());
        this.logger.warn("GitHub rate limit hit", { delay });
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        throw new Error("GitHub rate limit");
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub request failed: ${res.status} ${res.statusText} - ${text}`);
      }
      if (res.status === 204) {
        return null as T;
      }
      const data = (await res.json()) as T;
      return data;
    });

    return response;
  }

  async getRepository(target: RepositoryTarget): Promise<GitHubRepository> {
    return this.request<GitHubRepository>(`/repos/${target.owner}/${target.repo}`, { method: "GET" });
  }

  async getDefaultBranch(target: RepositoryTarget, fallback: string = "main"): Promise<string> {
    try {
      const repo = await this.getRepository(target);
      return repo.default_branch ?? fallback;
    } catch (error) {
      this.logger.warn("Failed to load repository metadata, using fallback default branch", {
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }

  async getBranchSha(target: RepositoryTarget, branch: string): Promise<string> {
    const ref = await this.request<{ object: { sha: string } }>(
      `/repos/${target.owner}/${target.repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      { method: "GET" }
    );
    return ref.object.sha;
  }

  async getCommit(target: RepositoryTarget, sha: string): Promise<Commit> {
    return this.request<Commit>(`/repos/${target.owner}/${target.repo}/git/commits/${sha}`, { method: "GET" });
  }

  async listTree(target: RepositoryTarget, sha: string, recursive = false): Promise<TreeItem[]> {
    const tree = await this.request<{ tree: TreeItem[] }>(
      `/repos/${target.owner}/${target.repo}/git/trees/${sha}`,
      { method: "GET", query: recursive ? { recursive: "1" } : undefined }
    );
    return tree.tree;
  }

  async getBlob(target: RepositoryTarget, sha: string): Promise<string> {
    const blob = await this.request<{ content: string; encoding: string }>(
      `/repos/${target.owner}/${target.repo}/git/blobs/${sha}`,
      { method: "GET" }
    );
    if (blob.encoding !== "base64") {
      throw new Error(`Unsupported blob encoding: ${blob.encoding}`);
    }
    return Buffer.from(blob.content, "base64").toString("utf-8");
  }

  async getFile(target: RepositoryTarget, path: string, ref: string): Promise<{ content: string; sha: string } | null> {
    try {
      const file = await this.request<{ content: string; encoding: string; sha: string }>(
        `/repos/${target.owner}/${target.repo}/contents/${encodeURIComponent(path)}`,
        { method: "GET", query: { ref } }
      );
      if (file.encoding !== "base64") {
        throw new Error(`Unsupported encoding for file ${path}`);
      }
      return { content: Buffer.from(file.content, "base64").toString("utf-8"), sha: file.sha };
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) {
        return null;
      }
      throw error;
    }
  }

  async findOpenStandardizationPr(target: RepositoryTarget): Promise<PullRequestSummary | null> {
    const pulls = await this.request<PullRequestSummary[]>(
      `/repos/${target.owner}/${target.repo}/pulls`,
      { method: "GET", query: { state: "open", per_page: "50" } }
    );
    const match = pulls.find((pr) => pr.head.ref.startsWith("auto/standardize-agents-"));
    return match ?? null;
  }

  async createBranch(target: RepositoryTarget, newBranch: string, baseSha: string): Promise<void> {
    await this.request(`/repos/${target.owner}/${target.repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({
        ref: `refs/heads/${newBranch}`,
        sha: baseSha,
      }),
      headers: { "Content-Type": "application/json" },
    });
  }

  async updateBranch(target: RepositoryTarget, branch: string, sha: string): Promise<void> {
    await this.request(`/repos/${target.owner}/${target.repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "PATCH",
      body: JSON.stringify({ sha, force: false }),
      headers: { "Content-Type": "application/json" },
    });
  }

  async createTree(target: RepositoryTarget, baseTree: string, files: CommitFile[]): Promise<string> {
    const tree = await this.request<{ sha: string }>(
      `/repos/${target.owner}/${target.repo}/git/trees`,
      {
        method: "POST",
        body: JSON.stringify({
          base_tree: baseTree,
          tree: files.map((file) => ({
            path: file.path,
            mode: file.mode ?? "100644",
            type: "blob",
            content: file.content,
          })),
        }),
        headers: { "Content-Type": "application/json" },
      }
    );
    return tree.sha;
  }

  async createCommit(target: RepositoryTarget, params: { message: string; tree: string; parents: string[] }): Promise<string> {
    const commit = await this.request<{ sha: string }>(
      `/repos/${target.owner}/${target.repo}/git/commits`,
      {
        method: "POST",
        body: JSON.stringify(params),
        headers: { "Content-Type": "application/json" },
      }
    );
    return commit.sha;
  }

  async createPullRequest(target: RepositoryTarget, params: { title: string; head: string; base: string; body: string }): Promise<PullRequestSummary> {
    const pr = await this.request<PullRequestSummary & { url: string }>(
      `/repos/${target.owner}/${target.repo}/pulls`,
      {
        method: "POST",
        body: JSON.stringify(params),
        headers: { "Content-Type": "application/json" },
      }
    );
    return pr;
  }

  async updatePullRequest(target: RepositoryTarget, number: number, body: string): Promise<void> {
    await this.request(`/repos/${target.owner}/${target.repo}/pulls/${number}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
      headers: { "Content-Type": "application/json" },
    });
  }
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
    logger.debug("Reusing existing work branch", { desiredBranch, sha });
    return sha;
  } catch (error) {
    logger.info("Creating work branch", { desiredBranch });
    const baseSha = await client.getBranchSha(target, baseBranch);
    await client.createBranch(target, desiredBranch, baseSha);
    return baseSha;
  }
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

export async function ensurePullRequestWithCommit(params: EnsurePullRequestParams): Promise<PullRequestSummary> {
  const { client, target, baseBranch, branch, commitMessage, files, logger, prBody, existingPr } = params;
  if (!files.length) {
    throw new Error("No files to commit");
  }
  const baseSha = await client.getBranchSha(target, branch);
  const baseCommit = await client.getCommit(target, baseSha);
  const treeSha = await client.createTree(target, baseCommit.tree.sha, files);
  const commitSha = await client.createCommit(target, {
    message: commitMessage,
    tree: treeSha,
    parents: [baseSha],
  });
  await client.updateBranch(target, branch, commitSha);
  if (existingPr) {
    logger.info("Updating existing PR with new commit", { number: existingPr.number });
    await client.updatePullRequest(target, existingPr.number, prBody);
    return existingPr;
  }
  logger.info("Creating new pull request", { branch });
  const title = "chore(agents): add/standardize agent instruction files + gemini config";
  return client.createPullRequest(target, {
    title,
    head: branch,
    base: baseBranch,
    body: prBody,
  });
}
