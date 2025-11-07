import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { generateObject } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import z from "zod";

type RepoEvalEnv = {
    AI: Fetcher;
    REPO_EVAL_KV: KVNamespace;
};

const aggregatorSchema = z.object({
    finalReport: z.string(),
});

export class AggregatorWorkflow extends WorkflowEntrypoint<RepoEvalEnv, any> {
    async run(event: WorkflowEvent<any>, step: WorkflowStep) {
        const { responses } = event.payload;

        const workersai = createWorkersAI({ binding: this.env.AI });
        const bigModel = workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast");

        const aggregatorPrompt = `Synthesize the following analyses from different agents into a single, comprehensive repository evaluation report:\n\n${responses
            .map((r: { agent: string; analysis: string }) => `### ${r.agent} Analysis\n${r.analysis}`)
            .join("\n\n")}`;

        const { object } = await generateObject({
            model: bigModel,
            schema: aggregatorSchema,
            prompt: aggregatorPrompt,
        });

        await this.env.REPO_EVAL_KV.put(`${event.instanceId}:final`, object.finalReport);

        return { finalReport: object.finalReport };
    }
}
