import { describe, expect, it } from "vitest";
import { renderAgentBundle, renderAgentContent } from "../src/policy";
import type { RepoSummary } from "../src/agents";

const summary: RepoSummary = {
  owner: "acme",
  repo: "widgets",
  defaultBranch: "main",
  languages: ["TypeScript"],
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

describe("policy rendering", () => {
  it("renders content with modularization and logging mandates", () => {
    const content = renderAgentContent(summary);
    expect(content).toMatch(/Modularization Mandate/);
    expect(content).toMatch(/Verbose Logging Mandate/);
    expect(content).toMatch(/Always add or update docstrings/);
  });

  it("renders synchronized bundle for all agent files", () => {
    const bundle = renderAgentBundle(summary);
    expect(bundle.size).toBe(4);
    const contents = new Set(bundle.values());
    expect(contents.size).toBe(1);
    expect([...bundle.keys()]).toEqual([
      "agent.md",
      "gemini.md",
      "cursor-agent.md",
      "copilot.md",
    ]);
  });
});
