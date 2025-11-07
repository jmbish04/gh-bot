import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import {
  parseTriggers,
  extractSuggestions,
  truncateText,
  simplifyUser,
  simplifyRepository,
  extractRelevantData,
  checkRecentDuplicate,
  isNewRepository,
  handleWebhook,
  CONFLICT_MENTION_PATTERN,
  type Env,
  type WebhookData,
} from "../src/routes/webhook";
import { verify as verifySignature } from "@octokit/webhooks-methods";

// Mock dependencies
vi.mock("@octokit/webhooks-methods", () => ({
  verify: vi.fn(),
}));

vi.mock("../src/modules/mcp_tools", () => ({
  ensureRepoMcpTools: vi.fn(),
}));

vi.mock("../src/github", () => ({
  ghREST: vi.fn(),
  GitHubHttpError: class extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  createInstallationClient: vi.fn(),
  GitHubClient: vi.fn(),
  checkUserHasPushAccess: vi.fn(),
  postPRComment: vi.fn(),
  getPRBranchDetails: vi.fn(),
}));

// Helper to create mock D1Database
function createMockDB() {
  const queries: any[] = [];
  const results: Map<string, any> = new Map();

  return {
    prepare: vi.fn((query: string) => {
      queries.push(query);
      return {
        bind: vi.fn((...args: any[]) => ({
          first: vi.fn(async () => {
            const key = `${query}:${JSON.stringify(args)}`;
            return results.get(key) ?? null;
          }),
          run: vi.fn(async () => {
            const key = `${query}:${JSON.stringify(args)}`;
            return {
              meta: {
                last_row_id: results.size + 1,
              },
              success: true,
            };
          }),
        })),
      };
    }),
    _setResult: (query: string, args: any[], result: any) => {
      const key = `${query}:${JSON.stringify(args)}`;
      results.set(key, result);
    },
    _getQueries: () => queries,
  };
}

// Helper to create mock DurableObjectNamespace
function createMockDurableObjectNamespace() {
  const stubs = new Map<string, any>();

  return {
    idFromName: vi.fn((name: string) => {
      return { toString: () => name } as any;
    }),
    get: vi.fn((id: any) => {
      const key = id.toString();
      if (!stubs.has(key)) {
        stubs.set(key, {
          fetch: vi.fn(async () => new Response("ok", { status: 200 })),
        });
      }
      return stubs.get(key);
    }),
    _getStub: (name: string) => stubs.get(name),
  };
}

// Helper to create mock Env
function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: createMockDB() as any,
    GITHUB_WEBHOOK_SECRET: "test-secret",
    PR_WORKFLOWS: createMockDurableObjectNamespace() as any,
    REPO_SETUP: createMockDurableObjectNamespace() as any,
    ...overrides,
  } as Env;
}

describe("webhook utilities", () => {
  describe("parseTriggers", () => {
    it("parses /apply command", () => {
      expect(parseTriggers("/apply")).toEqual(["/apply"]);
    });

    it("parses /colby implement command", () => {
      expect(parseTriggers("/colby implement")).toEqual(["/colby implement"]);
    });

    it("parses multiple commands", () => {
      const result = parseTriggers("/apply\n/colby help");
      expect(result).toContain("/apply");
      expect(result).toContain("/colby help");
    });
  });

  describe("extractSuggestions", () => {
    it("extracts code suggestions from text", () => {
      const text = "```suggestion\nconst x = 1;\n```";
      expect(extractSuggestions(text)).toEqual(["const x = 1;\n"]);
    });

    it("extracts multiple suggestions", () => {
      const text =
        "```suggestion\nconst x = 1;\n```\n```suggestion\nconst y = 2;\n```";
      const result = extractSuggestions(text);
      expect(result).toHaveLength(2);
      expect(result[0]).toContain("const x = 1");
      expect(result[1]).toContain("const y = 2");
    });

    it("returns empty array when no suggestions", () => {
      expect(extractSuggestions("No suggestions here")).toEqual([]);
    });
  });

  describe("truncateText", () => {
    it("returns string unchanged if under limit", () => {
      expect(truncateText("short text")).toBe("short text");
    });

    it("truncates long strings", () => {
      const longText = "a".repeat(5000);
      const result = truncateText(longText, 100);
      expect(result?.length).toBe(101); // 100 + ellipsis
      expect(result).toEndWith("…");
    });

    it("converts numbers to strings", () => {
      expect(truncateText(123)).toBe("123");
    });

    it("converts booleans to strings", () => {
      expect(truncateText(true)).toBe("true");
      expect(truncateText(false)).toBe("false");
    });

    it("returns undefined for objects", () => {
      expect(truncateText({ key: "value" })).toBeUndefined();
    });

    it("uses default limit of 4000", () => {
      const longText = "a".repeat(5000);
      const result = truncateText(longText);
      expect(result?.length).toBe(4001);
    });
  });

  describe("simplifyUser", () => {
    it("simplifies user object", () => {
      const user = {
        login: "testuser",
        id: 123,
        type: "User",
        avatar_url: "https://example.com/avatar",
        html_url: "https://github.com/testuser",
        extra: "should be removed",
      };
      const result = simplifyUser(user);
      expect(result).toEqual({
        login: "testuser",
        id: 123,
        type: "User",
        avatar_url: "https://example.com/avatar",
        html_url: "https://github.com/testuser",
      });
      expect(result).not.toHaveProperty("extra");
    });

    it("returns undefined for null/undefined", () => {
      expect(simplifyUser(null)).toBeUndefined();
      expect(simplifyUser(undefined)).toBeUndefined();
    });
  });

  describe("simplifyRepository", () => {
    it("simplifies repository object", () => {
      const repo = {
        id: 456,
        name: "test-repo",
        full_name: "owner/test-repo",
        default_branch: "main",
        private: false,
        html_url: "https://github.com/owner/test-repo",
        owner: {
          login: "owner",
          id: 789,
        },
        extra: "should be removed",
      };
      const result = simplifyRepository(repo);
      expect(result).toMatchObject({
        id: 456,
        name: "test-repo",
        full_name: "owner/test-repo",
        default_branch: "main",
        private: false,
        html_url: "https://github.com/owner/test-repo",
      });
      expect(result?.owner).toBeDefined();
      expect(result).not.toHaveProperty("extra");
    });

    it("returns undefined for null/undefined", () => {
      expect(simplifyRepository(null)).toBeUndefined();
      expect(simplifyRepository(undefined)).toBeUndefined();
    });
  });

  describe("extractRelevantData", () => {
    it("extracts pull_request event data", () => {
      const payload = {
        action: "opened",
        repository: {
          id: 1,
          name: "repo",
          full_name: "owner/repo",
          owner: { login: "owner" },
        },
        pull_request: {
          id: 100,
          number: 1,
          title: "Test PR",
          state: "open",
          merged: false,
          draft: false,
          mergeable: true,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          user: { login: "author" },
          body: "PR body",
        },
      };
      const result = extractRelevantData("pull_request", payload);
      expect(result.event_type).toBe("pull_request");
      expect(result.action).toBe("opened");
      expect(result.pull_request?.number).toBe(1);
      expect(result.pull_request?.title).toBe("Test PR");
    });

    it("extracts issue_comment event data", () => {
      const payload = {
        action: "created",
        repository: {
          id: 1,
          name: "repo",
          full_name: "owner/repo",
        },
        issue: {
          id: 200,
          number: 2,
          title: "Test Issue",
          state: "open",
          user: { login: "user" },
        },
        comment: {
          id: 300,
          body: "Comment text",
          user: { login: "commenter" },
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        },
      };
      const result = extractRelevantData("issue_comment", payload);
      expect(result.event_type).toBe("issue_comment");
      expect(result.comment?.id).toBe(300);
      expect(result.issue?.number).toBe(2);
    });

    it("handles missing optional fields", () => {
      const payload = {
        action: "opened",
        repository: null,
      };
      const result = extractRelevantData("pull_request", payload);
      expect(result.event_type).toBe("pull_request");
      expect(result.repository).toBeUndefined();
    });

    it("truncates long titles", () => {
      const longTitle = "a".repeat(600);
      const payload = {
        pull_request: {
          number: 1,
          title: longTitle,
          state: "open",
        },
      };
      const result = extractRelevantData("pull_request", payload);
      expect(result.pull_request?.title?.length).toBeLessThanOrEqual(515); // 512 + ellipsis
    });
  });

  describe("checkRecentDuplicate", () => {
    it("returns false for new delivery", async () => {
      const env = createMockEnv();
      const result = await checkRecentDuplicate(env, "new-delivery", false);
      expect(result).toBe(false);
    });

    it("allows reprocessing comment events after 5 minutes", async () => {
      const env = createMockEnv();
      const db = env.DB as any;
      const fiveMinutesAgo = Date.now() - 6 * 60 * 1000; // 6 minutes ago
      db._setResult(
        "SELECT received_at FROM github_webhook_events WHERE delivery_id = ?",
        ["test-delivery"],
        { received_at: new Date(fiveMinutesAgo).toISOString() }
      );
      const result = await checkRecentDuplicate(env, "test-delivery", true);
      expect(result).toBe(true);
    });

    it("prevents reprocessing recent comment events", async () => {
      const env = createMockEnv();
      const db = env.DB as any;
      const twoMinutesAgo = Date.now() - 2 * 60 * 1000;
      db._setResult(
        "SELECT received_at FROM github_webhook_events WHERE delivery_id = ?",
        ["test-delivery"],
        { received_at: new Date(twoMinutesAgo).toISOString() }
      );
      const result = await checkRecentDuplicate(env, "test-delivery", true);
      expect(result).toBe(false);
    });

    it("handles database errors gracefully", async () => {
      const env = createMockEnv();
      const db = env.DB as any;
      db.prepare = vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(() => Promise.reject(new Error("DB error"))),
        })),
      }));
      const result = await checkRecentDuplicate(env, "test-delivery", false);
      expect(result).toBe(false);
    });
  });

  describe("isNewRepository", () => {
    it("returns true for new repository", async () => {
      const env = createMockEnv();
      const result = await isNewRepository(env, "owner/new-repo");
      expect(result).toBe(true);
    });

    it("returns false for existing repository", async () => {
      const env = createMockEnv();
      const db = env.DB as any;
      db._setResult("SELECT 1 FROM projects WHERE repo = ? LIMIT 1", ["owner/existing-repo"], {
        "1": 1,
      });
      const result = await isNewRepository(env, "owner/existing-repo");
      expect(result).toBe(false);
    });

    it("handles database errors by assuming new", async () => {
      const env = createMockEnv();
      const db = env.DB as any;
      db.prepare = vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(() => Promise.reject(new Error("DB error"))),
        })),
      }));
      const result = await isNewRepository(env, "owner/repo");
      expect(result).toBe(true);
    });
  });

  describe("handleWebhook", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("handles ping events", async () => {
      const env = createMockEnv();
      const webhookData: WebhookData = {
        delivery: "ping-123",
        event: "ping",
        signature: "sig",
        bodyText: "{}",
        headers: {},
      };
      const response = await handleWebhook(webhookData, env);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toBe("pong");
    });

    it("rejects requests without webhook secret", async () => {
      const env = createMockEnv({ GITHUB_WEBHOOK_SECRET: "" });
      const webhookData: WebhookData = {
        delivery: "test-123",
        event: "pull_request",
        signature: "sig",
        bodyText: JSON.stringify({ action: "opened" }),
        headers: {},
      };
      const response = await handleWebhook(webhookData, env);
      expect(response.status).toBe(401);
      const text = await response.text();
      expect(text).toContain("webhook secret not configured");
    });

    it("rejects requests without signature", async () => {
      const env = createMockEnv();
      const webhookData: WebhookData = {
        delivery: "test-123",
        event: "pull_request",
        signature: "",
        bodyText: JSON.stringify({ action: "opened" }),
        headers: {},
      };
      const response = await handleWebhook(webhookData, env);
      expect(response.status).toBe(401);
      const text = await response.text();
      expect(text).toContain("missing signature");
    });

    it("rejects invalid signatures", async () => {
      const env = createMockEnv();
      (verifySignature as Mock).mockResolvedValue(false);
      const webhookData: WebhookData = {
        delivery: "test-123",
        event: "pull_request",
        signature: "invalid-sig",
        bodyText: JSON.stringify({ action: "opened" }),
        headers: {},
      };
      const response = await handleWebhook(webhookData, env);
      expect(response.status).toBe(401);
      const text = await response.text();
      expect(text).toContain("bad signature");
    });

    it("rejects invalid JSON payloads", async () => {
      const env = createMockEnv();
      (verifySignature as Mock).mockResolvedValue(true);
      const webhookData: WebhookData = {
        delivery: "test-123",
        event: "pull_request",
        signature: "valid-sig",
        bodyText: "invalid json{",
        headers: {},
      };
      const response = await handleWebhook(webhookData, env);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("invalid JSON payload");
    });

    it("processes valid pull_request event", async () => {
      const env = createMockEnv();
      (verifySignature as Mock).mockResolvedValue(true);
      const payload = {
        action: "opened",
        repository: {
          owner: { login: "owner" },
          name: "repo",
          full_name: "owner/repo",
        },
        pull_request: {
          number: 1,
          head: { ref: "feature", sha: "abc123" },
        },
        sender: { login: "author" },
      };
      const webhookData: WebhookData = {
        delivery: "test-123",
        event: "pull_request",
        signature: "valid-sig",
        bodyText: JSON.stringify(payload),
        headers: {},
      };
      const response = await handleWebhook(webhookData, env);
      // Should process successfully (status depends on DO response)
      expect([200, 202]).toContain(response.status);
    });

    it("handles duplicate deliveries", async () => {
      const env = createMockEnv();
      (verifySignature as Mock).mockResolvedValue(true);
      const db = env.DB as any;
      // Simulate duplicate by making insert fail
      db.prepare = vi.fn((query: string) => {
        if (query.includes("INSERT INTO github_webhook_events")) {
          return {
            bind: vi.fn(() => ({
              run: vi.fn(() => Promise.reject(new Error("UNIQUE constraint"))),
            })),
          };
        }
        // For checkRecentDuplicate
        return {
          bind: vi.fn(() => ({
            first: vi.fn(() =>
              Promise.resolve({
                received_at: new Date(Date.now() - 1000).toISOString(),
              })
            ),
          })),
        };
      });

      const payload = {
        action: "opened",
        repository: { owner: { login: "owner" }, name: "repo" },
      };
      const webhookData: WebhookData = {
        delivery: "duplicate-123",
        event: "pull_request",
        signature: "valid-sig",
        bodyText: JSON.stringify(payload),
        headers: {},
      };
      const response = await handleWebhook(webhookData, env);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toBe("duplicate");
    });
  });

  describe("CONFLICT_MENTION_PATTERN", () => {
    it("matches @colby please fix conflicts", () => {
      expect(CONFLICT_MENTION_PATTERN.test("@colby please fix conflicts")).toBe(true);
    });

    it("matches colby, fix the code conflicts", () => {
      expect(CONFLICT_MENTION_PATTERN.test("colby, fix the code conflicts")).toBe(true);
    });

    it("does not match unrelated text", () => {
      expect(CONFLICT_MENTION_PATTERN.test("This is a regular comment")).toBe(false);
    });
  });
});
