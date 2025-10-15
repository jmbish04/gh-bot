import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { mergeGeminiConfig, renderGeminiConfig, renderStyleguide } from "../src/gemini";
import type { RepoSummary } from "../src/agents";

const baseSummary: RepoSummary = {
  owner: "acme",
  repo: "widgets",
  defaultBranch: "main",
  languages: ["TypeScript", "Python"],
  frameworks: ["Hono"],
  purpose: "Automates widget workflows",
  keyFiles: ["src/index.ts"],
  build: "pnpm build",
  test: "pnpm test",
  lint: "pnpm lint",
  format: "pnpm format",
  existingAgentFiles: [],
  needsAgentFiles: true,
  needsUpdates: true,
  recommendations: [],
};

describe("gemini config", () => {
  it("merges without downgrading strict settings", () => {
    const generated = renderGeminiConfig(baseSummary);
    const existing = `
$schema: http://json-schema.org/draft-07/schema#
title: acme/widgets
type: object
ignore_patterns:
  - custom/**
code_review:
  disable: false
  comment_severity_threshold: HIGH
  max_review_comments: 5
  pull_request_opened:
    help: true
    summary: true
    code_review: true
    include_drafts: false
`;

    const mergedYaml = mergeGeminiConfig(existing, generated);
    const merged = YAML.parse(mergedYaml);

    expect(merged.ignore_patterns).toContain("custom/**");
    expect(merged.ignore_patterns).toContain("node_modules/**");
    expect(merged.code_review.comment_severity_threshold).toBe("HIGH");
    expect(merged.code_review.max_review_comments).toBe(5);
    expect(merged.code_review.pull_request_opened.include_drafts).toBe(true);
  });

  it("ensures styleguide mandates docstrings, modularization, logging, and tri-option reviews", () => {
    const existing = "# Legacy Guidance\n\nPlease retain legacy guidance.";
    const rendered = renderStyleguide(baseSummary, existing);

    expect(rendered).toContain("# acme/widgets – Gemini Code Assist Style Guide");
    expect(rendered).toMatch(/Always propose docstring patches/);
    expect(rendered).toMatch(/Enforce modularization/);
    expect(rendered).toMatch(/verbose, structured logging/);
    expect(rendered).toMatch(/three paths/);
    expect(rendered).toContain("Please retain legacy guidance.");
  });
});
