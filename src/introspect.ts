import { createAgentGateway, type AgentGateway, type RepoSummary, type RepoSummaryRequest } from "./agents";
import { GitHubClient, type GitHubEnv } from "./github";
import { createLogger, type Logger, type RepositoryTarget } from "./util";

const MAX_FILES = 25;
const MAX_FILE_SIZE = 256 * 1024;

const PRIORITY_FILES = [
  ".bot/disable",
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "requirements.txt",
  "pyproject.toml",
  "poetry.lock",
  "Pipfile",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "Gemfile",
  "Gemfile.lock",
  "pom.xml",
  "Makefile",
  "Dockerfile",
  "README.md",
  "README",
  "LICENSE",
  "wrangler.toml",
  "wrangler.json",
  "wrangler.jsonc",
  "docs/agent.md",
  "agent.md",
  "cursor-agent.md",
  "copilot.md",
  "gemini.md",
  ".gemini/config.yaml",
  ".gemini/styleguide.md",
];

const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".svg",
  ".webp",
  ".ttf",
  ".woff",
  ".woff2",
  ".pdf",
  ".zip",
  ".tar",
]);

function shouldSkipPath(path: string, size?: number): boolean {
  if (size && size > MAX_FILE_SIZE) {
    return true;
  }
  const lower = path.toLowerCase();
  if (lower.startsWith(".git")) {
    return true;
  }
  for (const ext of SKIP_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

function pickRepresentativePaths(paths: string[]): string[] {
  const selected: string[] = [];
  for (const priority of PRIORITY_FILES) {
    if (paths.includes(priority)) {
      selected.push(priority);
    }
  }
  for (const path of paths) {
    if (selected.length >= MAX_FILES) {
      break;
    }
    if (!selected.includes(path) && !shouldSkipPath(path)) {
      selected.push(path);
    }
  }
  return selected.slice(0, MAX_FILES);
}

interface IntrospectDependencies {
  githubClient?: GitHubClient;
  agentGateway?: AgentGateway;
  logger?: Logger;
}

export interface IntrospectEnv extends GitHubEnv {
  AI?: any;
  SUMMARY_CF_MODEL?: string;
}

export interface IntrospectResult extends RepoSummary {
  sampledFiles: { path: string; content: string }[];
  hasOptOutFile: boolean;
}

export async function introspectRepository(
  env: IntrospectEnv,
  target: RepositoryTarget,
  defaultBranch: string,
  dependencies: IntrospectDependencies = {}
): Promise<IntrospectResult> {
  const logger = dependencies.logger ?? createLogger("repo-introspect", { owner: target.owner, repo: target.repo });
  const github = dependencies.githubClient ?? new GitHubClient({ env, logger });
  const agentGateway =
    dependencies.agentGateway ?? createAgentGateway({ AI: (env as any).AI, SUMMARY_CF_MODEL: env.SUMMARY_CF_MODEL }, logger);

  logger.debug("Fetching repository tree for introspection", { defaultBranch });
  const branchSha = await github.getBranchSha(target, defaultBranch);
  const tree = await github.listTree(target, branchSha, true);
  const filePaths = tree
    .filter((item) => item.type === "blob" && !shouldSkipPath(item.path, item.size))
    .map((item) => item.path);

  const hasOptOutFile = tree.some((item) => item.path === ".bot/disable");
  const selectedPaths = pickRepresentativePaths(filePaths);
  const snippets: { path: string; content: string }[] = [];

  for (const path of selectedPaths) {
    const treeItem = tree.find((item) => item.path === path);
    if (!treeItem) continue;
    if (treeItem.type !== "blob" || shouldSkipPath(treeItem.path, treeItem.size)) {
      continue;
    }
    const content = await github.getBlob(target, treeItem.sha);
    snippets.push({ path: treeItem.path, content: content.slice(0, 2000) });
  }

  const agentInput: RepoSummaryRequest = {
    owner: target.owner,
    repo: target.repo,
    defaultBranch,
    snippets,
  };

  const summary = await agentGateway.runRepoSummaryAgent(agentInput);

  const result: IntrospectResult = {
    ...summary,
    sampledFiles: snippets,
    hasOptOutFile,
  };

  return result;
}
