import { Hono } from "hono";
import { verify as verifySignature } from "@octokit/webhooks-methods";

type Env = {
  GITHUB_WEBHOOK_SECRET: string;
  RepositoryActor: DurableObjectNamespace;
  PullRequestActor: DurableObjectNamespace;
  ResearchActor: DurableObjectNamespace;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true }));

app.post("/api/webhook", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") ?? "";
  const eventName = c.req.header("x-github-event") ?? "unknown";

  const isValid = await verifySignature(c.env.GITHUB_WEBHOOK_SECRET, rawBody, signature).catch(() => false);
  if (!isValid) {
    return c.json({ error: "invalid signature" }, 401);
  }

  const payload = JSON.parse(rawBody);
  const repoName = payload.repository?.full_name as string | undefined;
  const prNumber = payload.pull_request?.number ?? payload.issue?.number;

  if (repoName && typeof prNumber === "number") {
    const actorId = `${repoName}/${prNumber}`;
    const stub = await prepareActorStub(c.env.PullRequestActor, actorId);
    await invokeActor(stub, "handleWebhookEvent", [payload]);
  }

  if (repoName && payload.action === "repository_created") {
    const [owner, repo] = repoName.split("/");
    const stub = await prepareActorStub(c.env.RepositoryActor, repoName);
    await invokeActor(stub, "setupRepository", [{ owner, repo }]);
  }

  return c.json({ status: "accepted", event: eventName }, 202);
});

app.post("/api/repositories/:owner/:repo/setup", async (c) => {
  const { owner, repo } = c.req.param();
  const config = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const stub = await prepareActorStub(c.env.RepositoryActor, `${owner}/${repo}`);
  const result = await invokeActor(stub, "setupRepository", [
    {
      owner,
      repo,
      defaultBranch: typeof config.defaultBranch === "string" ? config.defaultBranch : undefined,
      installationId: typeof config.installationId === "number" ? config.installationId : undefined,
      eventType: "manual_setup",
    },
  ]);
  return c.json(result, 202);
});

app.post("/api/repositories/:owner/:repo/analyze", async (c) => {
  const { owner, repo } = c.req.param();
  const stub = await prepareActorStub(c.env.RepositoryActor, `${owner}/${repo}`);
  const result = await invokeActor(stub, "analyzeRepo");
  return c.json(result);
});

app.get("/api/repositories/:owner/:repo/status", async (c) => {
  const { owner, repo } = c.req.param();
  const stub = await prepareActorStub(c.env.RepositoryActor, `${owner}/${repo}`);
  const status = await invokeActor(stub, "getStatus");
  return c.json(status ?? {});
});

app.post("/api/research", async (c) => {
  const body = await c.req.json<{ query: string; id?: string }>();
  const id = body.id ?? crypto.randomUUID();
  const stub = await prepareActorStub(c.env.ResearchActor, id);
  const result = await invokeActor(stub, "startResearch", [body.query]);
  return c.json({ id, ...result });
});

app.get("/api/research/:id", async (c) => {
  const { id } = c.req.param();
  const stub = await prepareActorStub(c.env.ResearchActor, id);
  const result = await invokeActor(stub, "getResults");
  return c.json(result ?? {});
});

async function invokeActor<T>(stub: DurableObjectStub, method: string, params: unknown[] = []): Promise<T> {
  const response = await stub.fetch("https://actor/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Actor invocation failed: ${errorText}`);
  }

  if (response.headers.get("content-type")?.includes("application/json")) {
    return (await response.json()) as T;
  }

  return undefined as T;
}

async function prepareActorStub(namespace: DurableObjectNamespace, id: string) {
  const stub = namespace.get(namespace.idFromName(id));
  await invokeActor(stub, "initialize", [id]);
  return stub;
}

export default app;

export { RepositoryActor } from "./actors/RepositoryActor";
export { PullRequestActor } from "./actors/PullRequestActor";
export { ResearchActor } from "./actors/ResearchActor";
