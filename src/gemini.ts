import YAML from "yaml";
import type { RepoSummary } from "./agents";

const BASE_IGNORE_PATTERNS = [
  "node_modules/**",
  "dist/**",
  "build/**",
  ".next/**",
  ".turbo/**",
  "coverage/**",
  ".venv/**",
  "__pycache__/**",
  "*.lock",
  "*.min.*",
  "*.map",
  "*.svg",
  "*.png",
  "*.jpg",
  "*.ico",
  ".git/**",
  ".github/**",
];

const LANGUAGE_SPECIFIC_IGNORES: Record<string, string[]> = {
  python: [".mypy_cache/**", ".pytest_cache/**", ".ruff_cache/**", "*.egg-info/**"],
  go: ["bin/**"],
  rust: ["target/**"],
  java: [".gradle/**", "build/**"],
};

const SEVERITY_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

type GeminiConfig = {
  $schema: string;
  title: string;
  type: string;
  have_fun: boolean;
  ignore_patterns: string[];
  code_review: {
    disable: boolean;
    comment_severity_threshold: (typeof SEVERITY_ORDER)[number];
    max_review_comments: number;
    pull_request_opened: {
      help: boolean;
      summary: boolean;
      code_review: boolean;
      include_drafts: boolean;
    };
  };
} & Record<string, unknown>;

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function deriveLanguageKeys(summary: RepoSummary): string[] {
  return (summary.languages || []).map((language) => language.toLowerCase());
}

export function renderGeminiConfig(summary: RepoSummary): string {
  const ignores = new Set<string>(BASE_IGNORE_PATTERNS);
  for (const key of deriveLanguageKeys(summary)) {
    const extra = LANGUAGE_SPECIFIC_IGNORES[key];
    if (extra) {
      for (const pattern of extra) {
        ignores.add(pattern);
      }
    }
  }

  const config: GeminiConfig = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: `${summary.owner}/${summary.repo}`,
    type: "object",
    have_fun: false,
    ignore_patterns: Array.from(ignores).sort(),
    code_review: {
      disable: false,
      comment_severity_threshold: "MEDIUM",
      max_review_comments: -1,
      pull_request_opened: {
        help: false,
        summary: true,
        code_review: true,
        include_drafts: true,
      },
    },
  };

  return YAML.stringify(config, { sortMapEntries: true });
}

function pickStricterSeverity(existing: string, incoming: string): string {
  const existingIndex = SEVERITY_ORDER.indexOf(existing as any);
  const incomingIndex = SEVERITY_ORDER.indexOf(incoming as any);
  if (existingIndex === -1) {
    return incoming;
  }
  if (incomingIndex === -1) {
    return existing;
  }
  return incomingIndex > existingIndex ? incoming : existing;
}

function mergePullRequestSettings(existing: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const result = { ...incoming, ...existing };
  for (const key of Object.keys(incoming)) {
    if (typeof incoming[key] === "boolean" && typeof existing[key] === "boolean") {
      // Preserve stricter truthy values.
      result[key] = existing[key] || incoming[key];
    }
  }
  return result;
}

export function mergeGeminiConfig(existingYaml: string | null | undefined, generatedYaml: string): string {
  if (!existingYaml) {
    return generatedYaml;
  }
  const existing = YAML.parse(existingYaml) ?? {};
  const incoming = YAML.parse(generatedYaml) ?? {};

  const merged: Record<string, any> = { ...incoming, ...existing };

  // Merge ignore patterns
  const existingIgnores: string[] = Array.isArray(existing.ignore_patterns) ? existing.ignore_patterns : [];
  const incomingIgnores: string[] = Array.isArray(incoming.ignore_patterns) ? incoming.ignore_patterns : [];
  merged.ignore_patterns = unique([...incomingIgnores, ...existingIgnores]).sort();

  // Merge code_review object
  const existingReview = existing.code_review ?? {};
  const incomingReview = incoming.code_review ?? {};
  const review: Record<string, any> = { ...incomingReview, ...existingReview };

  if (typeof existingReview.disable === "boolean" || typeof incomingReview.disable === "boolean") {
    review.disable = existingReview.disable ?? incomingReview.disable ?? false;
  }

  const incomingSeverity = incomingReview.comment_severity_threshold ?? "MEDIUM";
  const existingSeverity = existingReview.comment_severity_threshold ?? incomingSeverity;
  review.comment_severity_threshold = pickStricterSeverity(existingSeverity, incomingSeverity);

  const incomingMax = typeof incomingReview.max_review_comments === "number" ? incomingReview.max_review_comments : -1;
  const existingMax = typeof existingReview.max_review_comments === "number" ? existingReview.max_review_comments : incomingMax;
  if (existingMax < 0 && incomingMax < 0) {
    review.max_review_comments = -1;
  } else if (existingMax < 0) {
    review.max_review_comments = incomingMax;
  } else if (incomingMax < 0) {
    review.max_review_comments = existingMax;
  } else {
    review.max_review_comments = Math.min(existingMax, incomingMax);
  }

  const existingOpened = existingReview.pull_request_opened ?? {};
  const incomingOpened = incomingReview.pull_request_opened ?? {};
  review.pull_request_opened = mergePullRequestSettings(existingOpened, incomingOpened);

  merged.code_review = review;

  return YAML.stringify(merged, { sortMapEntries: true });
}

function renderTemplate(summary: RepoSummary): string {
  const languages = summary.languages?.length ? summary.languages.join(", ") : "Unknown";
  const frameworks = summary.frameworks?.length ? summary.frameworks.join(", ") : "Unknown";
  const build = summary.build ?? "Document build commands.";
  const test = summary.test ?? "Document test commands.";
  const lint = summary.lint ?? "Document lint commands.";

  return `# ${summary.owner}/${summary.repo} – Gemini Code Assist Style Guide

## Review Ground Rules
- Always propose docstring patches:
  - Add/repair module-level docstring at top of file.
  - Add/repair docstrings for every public function/class.
  - Docstrings optimized for AI agents: purpose, inputs/outputs/types, side-effects, errors, invariants.
- Enforce modularization: prefer small, single-responsibility functions; extract mixed-concern logic.
- Enforce verbose, structured logging: include context; no secrets; DEBUG in dev, INFO in CI; consistent prefixes.
- For any suggested change, provide **three paths**: Easiest / Moderate / Advanced.

## Stack Snapshot
- Languages: ${languages}
- Frameworks: ${frameworks}
- Purpose: ${summary.purpose || "Add a concise purpose statement."}

## Build / Test / Lint
- Build: ${build}
- Test: ${test}
- Lint/Format: ${lint}

## Security Focus
- Input validation, authz boundaries, dependency risk, secret hygiene.

## PR Expectations
- Small diffs; meaningful commit messages (Conventional Commits recommended); tests updated.
`;
}

export function renderStyleguide(summary: RepoSummary, existing?: string | null): string {
  const template = renderTemplate(summary);
  const canonicalHeader = `# ${summary.owner}/${summary.repo} – Gemini Code Assist Style Guide`;
  if (!existing || existing.trim().length === 0) {
    return template.trim() + "\n";
  }

  const sections = new Map<string, string>();
  sections.set("# ", canonicalHeader);
  sections.set("## Review Ground Rules", template.split("## Review Ground Rules")[1].split("## Stack Snapshot")[0].trim());
  sections.set("## Stack Snapshot", template.split("## Stack Snapshot")[1].split("## Build / Test / Lint")[0].trim());
  sections.set("## Build / Test / Lint", template.split("## Build / Test / Lint")[1].split("## Security Focus")[0].trim());
  sections.set("## Security Focus", template.split("## Security Focus")[1].split("## PR Expectations")[0].trim());
  sections.set("## PR Expectations", template.split("## PR Expectations")[1].trim());

  let output = existing.trim();
  if (!output.includes(canonicalHeader)) {
    output = `${canonicalHeader}\n\n${output}`;
  }

  for (const [heading, content] of sections) {
    if (heading === "# ") continue;
    if (!output.includes(heading)) {
      output += `\n\n${heading}\n${content}`;
    }
  }

  return output.trim() + "\n";
}

export interface GeminiModel {
  generateContent(prompt: string): Promise<{ response: { text(): string } }>;
}

export interface GeminiEnv {
  AI?: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };
  SUMMARY_CF_MODEL?: string;
}

const DEFAULT_GEMINI_MODEL = "@cf/google/gemini-1.5-flash";

/**
 * Creates a lightweight Gemini model wrapper backed by the Workers AI binding.
 *
 * @param env - The environment containing the Workers AI binding and optional model override.
 * @returns A helper exposing a `generateContent` method compatible with existing call sites.
 * @throws {Error} When the Workers AI binding is missing or invalid.
 * @example
 * ```ts
 * const model = getGeminiModel(env);
 * const result = await model.generateContent('Summarize this repository.');
 * console.log(result.response.text());
 * ```
 */
export function getGeminiModel(env: GeminiEnv): GeminiModel {
  if (!env.AI || typeof env.AI.run !== "function") {
    throw new Error("Workers AI binding (env.AI) is required to use getGeminiModel.");
  }

  const model = env.SUMMARY_CF_MODEL ?? DEFAULT_GEMINI_MODEL;

  return {
    async generateContent(prompt: string) {
      const result = await env.AI.run(model, {
        messages: [
          { role: "system", content: "You are a meticulous GitHub research assistant." },
          { role: "user", content: prompt },
        ],
        max_output_tokens: 2048,
      });

      let text: string;
      if (typeof result === "string") {
        text = result;
      } else if (result && typeof (result as any).response === "string") {
        text = (result as any).response;
      } else if (result && typeof (result as any).response?.text === "function") {
        text = (result as any).response.text();
      } else if (Array.isArray((result as any)?.messages)) {
        const messages = (result as any).messages;
        const last = messages[messages.length - 1];
        text = typeof last?.content === "string" ? last.content : JSON.stringify(result);
      } else {
        text = JSON.stringify(result);
      }

      return {
        response: {
          text: () => text,
        },
      };
    },
  };
}
