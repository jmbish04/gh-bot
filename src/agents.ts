import type { Logger } from "./util";

export interface AgentSnippet {
  path: string;
  content: string;
}

export interface RepoSummary {
  owner: string;
  repo: string;
  defaultBranch: string;
  languages: string[];
  frameworks: string[];
  purpose: string;
  keyFiles: string[];
  build?: string;
  test?: string;
  lint?: string;
  format?: string;
  existingAgentFiles: { path: string; content: string; score: number; findings: string[] }[];
  needsAgentFiles: boolean;
  needsUpdates: boolean;
  recommendations: string[];
  optOut?: boolean;
}

export interface RepoSummaryRequest {
  owner: string;
  repo: string;
  defaultBranch: string;
  snippets: AgentSnippet[];
}

export interface AgentGateway {
  runRepoSummaryAgent(input: RepoSummaryRequest): Promise<RepoSummary>;
}

interface AgentEnv {
  AI?: { run: (model: string, input: Record<string, unknown>) => Promise<any> };
  SUMMARY_CF_MODEL?: string;
}

export function createAgentGateway(env: AgentEnv, logger: Logger): AgentGateway {
  const model = env.SUMMARY_CF_MODEL ?? "@cf/meta/llama-3.1-8b-instruct";
  return {
    async runRepoSummaryAgent(input: RepoSummaryRequest): Promise<RepoSummary> {
      if (!env.AI || typeof env.AI.run !== "function") {
        logger.warn("AI binding not configured; returning heuristic summary");
        return {
          owner: input.owner,
          repo: input.repo,
          defaultBranch: input.defaultBranch,
          languages: [],
          frameworks: [],
          purpose: "", 
          keyFiles: input.snippets.slice(0, 5).map((snippet) => snippet.path),
          existingAgentFiles: [],
          needsAgentFiles: true,
          needsUpdates: true,
          recommendations: ["Configure AI binding to enable rich repo summaries."],
        };
      }

      const prompt = {
        role: "system",
        content: `You are RepoSummaryAgent. Produce a strict JSON object matching the RepoSummary schema.
Return deterministic, concise answers. Score existing agent files (0-1) and include findings array.
Respond with JSON only.`,
      };

      const userContent = {
        role: "user",
        content: {
          owner: input.owner,
          repo: input.repo,
          defaultBranch: input.defaultBranch,
          snippets: input.snippets.map((snippet) => ({
            path: snippet.path,
            content: snippet.content.slice(0, 2000),
          })),
        },
      };

      try {
        const result = await env.AI.run(model, {
          messages: [prompt, userContent],
          max_output_tokens: 2048,
        });
        if (!result || typeof result !== "object") {
          throw new Error("Agent result missing");
        }
        const rawText = typeof result.response === 'string' ? result.response : JSON.stringify(result.response);
        const json = JSON.parse(rawText.replace(/```json\n?|```/g, '').trim()) as RepoSummary;
        return json;
      } catch (error) {
        logger.error("Agent summarization failed", { error: error instanceof Error ? error.message : String(error) });
        return {
          owner: input.owner,
          repo: input.repo,
          defaultBranch: input.defaultBranch,
          languages: [],
          frameworks: [],
          purpose: "",
          keyFiles: input.snippets.slice(0, 5).map((snippet) => snippet.path),
          existingAgentFiles: [],
          needsAgentFiles: true,
          needsUpdates: true,
          recommendations: ["Agent summarization failed; using fallback."],
        };
      }
    },
  };
}
