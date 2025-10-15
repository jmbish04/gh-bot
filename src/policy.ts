import type { RepoSummary } from "./agents";

const CANONICAL_FILENAMES = ["agent.md", "gemini.md", "cursor-agent.md", "copilot.md"];

function formatList(values: string[] | undefined, fallback = "Not specified"): string {
  if (!values || values.length === 0) {
    return fallback;
  }
  return values.join(", ");
}

function sanitize(content: string): string {
  return content.replace(/\s+$/gm, "").trim() + "\n";
}

export function renderAgentContent(summary: RepoSummary): string {
  const build = summary.build ?? "Document build commands in package scripts.";
  const test = summary.test ?? "Document how to run the full test suite.";
  const lint = summary.lint ?? "Document linting and formatting commands.";
  const formatHint = summary.format ?? lint;

  const sections = [
    "# Project Snapshot",
    `- Purpose: ${summary.purpose || "Update purpose via RepoSummary."}`,
    `- Key files: ${summary.keyFiles?.join(", ") || "Identify the primary entry points."}`,
    `- Languages: ${formatList(summary.languages, "Unknown")}`,
    `- Frameworks: ${formatList(summary.frameworks, "Unknown")}`,
    `- Default branch: ${summary.defaultBranch}`,
    `- Build: ${build}`,
    `- Test: ${test}`,
    `- Lint/Format: ${lint}`,
    "",
    "## Source of Truth & Boundaries",
    "- Respect existing architecture decisions. Avoid removing modules without review.",
    "- Follow the repo's CONTRIBUTING guidelines and maintainers' instructions.",
    "- Keep changes behind PRs; never push directly to protected branches.",
    "",
    "## Coding Standards",
    "- Enforce linting and formatting before submitting patches.",
    `- Formatting: ${formatHint}.`,
    "- Always add or update docstrings and module headers when touching files.",
    "- Use dependency injection for testability and modularity.",
    "- Maintain exhaustive error handling and surface actionable messages.",
    "",
    "## Architecture Map",
    "- Describe modules and services in documentation updates accompanying changes.",
    "- Prefer cohesive modules with narrow responsibilities.",
    "- Isolate side-effects from pure logic; move shared utilities into dedicated modules.",
    "- Ensure Cloudflare Worker routes stay slim and delegate to domain modules.",
    "",
    "## Tasks & Autonomy",
    "- Open PRs with Conventional Commit-style titles and detailed summaries.",
    "- Include Before/After tables and test plans in every PR.",
    "- Seek reviewer approval for schema changes, migrations, or infra updates.",
    "",
    "## Security & Secrets",
    "- Never log or commit secrets, tokens, or keys.",
    "- Use Workers KV / Secrets for credentials; reference via bindings only.",
    "- Validate inbound webhook signatures and sanitize outbound data.",
    "",
    "## AI Usage & Hallucination Guards",
    "- Provide deterministic prompts with explicit schemas for agent workflows.",
    "- Reject speculative changes without citations or test evidence.",
    "- Require tool results before asserting repository facts.",
    "",
    "## Repo-Specific Playbooks",
    `- Build: ${build}`,
    `- Test: ${test}`,
    `- Lint: ${lint}`,
    "- Deployment: Document deployment pipeline updates in PR descriptions.",
    "- Rollback: Maintain a rollback plan for production-impacting deployments.",
    "",
    "## Checklists",
    "- Feature work: docstrings updated, logs instrumented, tests covering new paths.",
    "- Bugfix: regression test reproduced, failing test added, root cause documented.",
    "- Migration: data backfilled, monitoring toggles added, rollback plan defined.",
    "- Release: changelog updated, release checklist completed, monitors green.",
    "",
    "## Appendix",
    "- Glossary: keep definitions for domain-specific terms current.",
    "- Links: README, CONTRIBUTING, Onboarding docs.",
    "",
    "### Modularization Mandate",
    "- Decompose large files into cohesive modules.",
    "- Keep functions focused; extract helpers when logic exceeds ~40 lines.",
    "- Route side-effects (I/O, network, storage) through dedicated adapters.",
    "",
    "### Verbose Logging Mandate",
    "- Emit structured logs with correlation IDs and key parameters.",
    "- Default log level: DEBUG in development, INFO in CI.",
    "- Sanitize log payloads to prevent secret leakage.",
  ];

  return sanitize(sections.join("\n"));
}

function findExistingDirectory(summary: RepoSummary): string {
  const existingPaths = summary.existingAgentFiles?.map((file) => file.path) ?? [];
  const directories = existingPaths
    .map((path) => path.split("/").slice(0, -1).join("/").trim())
    .filter(Boolean);
  if (directories.length === 0) {
    return "";
  }
  directories.sort((a, b) => (a.length === b.length ? a.localeCompare(b) : a.length - b.length));
  return directories[0];
}

export function renderAgentBundle(summary: RepoSummary): Map<string, string> {
  const content = renderAgentContent(summary);
  const directory = findExistingDirectory(summary);
  const map = new Map<string, string>();
  for (const filename of CANONICAL_FILENAMES) {
    const path = directory ? `${directory}/${filename}` : filename;
    map.set(path, content);
  }
  return map;
}
