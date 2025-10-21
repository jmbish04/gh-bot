import { Hono } from "hono";
import { AggregatorWorkflow } from "./agents/aggregator";
import { OrchestratorWorkflow } from "./agents/orchestrator";

type RepoEvalEnv = {
    AI: Fetcher;
    REPO_EVAL_KV: KVNamespace;
    ORCHESTRATOR_WORKFLOW: any;
};

const app = new Hono<{ Bindings: RepoEvalEnv }>();

app.post("/", async (c) => {
    const { repoUrl } = await c.req.json<{ repoUrl: string }>();
    if (!repoUrl) {
        return c.json({ error: "repoUrl is required" }, 400);
    }

    const instance = await c.env.ORCHESTRATOR_WORKFLOW.create({
        params: { repoUrl },
    });
    const status = await instance.status();

    return c.json({ id: instance.id, status });
});

app.get("/:id", async (c) => {
    const instanceId = c.req.param("id");
    const instance = await c.env.ORCHESTRATOR_WORKFLOW.get(instanceId);
    const status = await instance.status();

    if (status.status === "complete" && status.output) {
        return c.json({ status, result: status.output });
    }

    const finalReport = await c.env.REPO_EVAL_KV.get(`${instanceId}:final`);
    if (finalReport) {
        return c.json({ status: "complete", result: finalReport });
    }

    return c.json({ status });
});

app.get("/ws", (c) => {
    return c.json({ error: "WebSocket endpoint not implemented in scaffold." }, 501);
});

export default {
    fetch: app.fetch,
};

export { OrchestratorWorkflow, AggregatorWorkflow };
