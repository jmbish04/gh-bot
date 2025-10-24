import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { generateObject } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { getRepoReadme, getRepoFileList } from "../github";
import z from "zod";

type RepoEvalEnv = {
    AI: Fetcher;
    REPO_EVAL_KV: KVNamespace;
};

export type OrchestratorWorkflowParams = {
    repoUrl: string;
};

const orchestratorSchema = z.object({
    tasks: z.array(z.object({
        agent: z.enum(["dependency", "security", "docs"]),
        prompt: z.string(),
    })),
});

const workerOutputSchema = z.object({
    analysis: z.string(),
});

export class OrchestratorWorkflow extends WorkflowEntrypoint<RepoEvalEnv, OrchestratorWorkflowParams> {
    async run(event: WorkflowEvent<OrchestratorWorkflowParams>, step: WorkflowStep) {
        const { repoUrl } = event.payload;

        const workersai = createWorkersAI({ binding: this.env.AI });
        const bigModel = workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
        const smallModel = workersai("@cf/meta/llama-3.1-8b-instruct");

        const [readme, fileList] = await Promise.all([
            getRepoReadme(repoUrl),
            getRepoFileList(repoUrl),
        ]);

        const orchestratorResult = await step.do("generate subtasks", async () => {
            const orchestratorPrompt = `Given the following repository information, break down the evaluation into a list of subtasks for specialized agents (dependency, security, docs).\n\nREADME:\n${readme}\n\nFile List:\n- ${fileList.join("\n- ")}\n\nReturn your answer as a JSON object.`;
            const { object } = await generateObject({
                model: bigModel,
                schema: orchestratorSchema,
                prompt: orchestratorPrompt,
            });
            return object;
        });

        const workerResponses = await step.do("execute subtasks", async () => {
            const workerPromises = orchestratorResult.tasks.map(async (task) => {
                const { object } = await generateObject({
                    model: smallModel,
                    schema: workerOutputSchema,
                    prompt: task.prompt,
                });
                await this.env.REPO_EVAL_KV.put(`${event.instanceId}:${task.agent}`, object.analysis);
                return { agent: task.agent, analysis: object.analysis };
            });
            return Promise.all(workerPromises);
        });

        const finalResult = await step.run("aggregator", {
            instanceId: event.instanceId,
            responses: workerResponses,
        });

        return finalResult;
    }
}
