import { Actor, Persist } from "@cloudflare/actors";
import { GitHubClient, getInstallationToken } from "../github";

export type PullRequestStatus = "open" | "closed" | "merged";
export type WorkflowStatus = "pending" | "running_checks" | "approved" | "failed";

interface Env {
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_TOKEN?: string;
}

interface PullRequestAlarmPayload {
  type: "checks";
}

export class PullRequestActor extends Actor<Env> {
  @Persist
  private repoName: string | null = null;

  @Persist
  private prNumber: number | null = null;

  @Persist
  private status: PullRequestStatus = "open";

  @Persist
  private workflowStatus: WorkflowStatus = "pending";

  @Persist
  private checkResults: Record<string, unknown> | null = null;

  @Persist
  private installationId: number | null = null;

  async handleWebhookEvent(event: any) {
    const repo = event.repository?.full_name as string | undefined;
    const prNumber = event.pull_request?.number ?? event.issue?.number;

    if (repo && typeof repo === "string") {
      this.repoName = repo;
    }

    if (typeof prNumber === "number") {
      this.prNumber = prNumber;
    }

    if (event.installation?.id) {
      this.installationId = event.installation.id;
    }

    if (event.pull_request?.state) {
      this.status = event.pull_request.state as PullRequestStatus;
    }

    if (event.action === "closed" && event.pull_request?.merged) {
      this.status = "merged";
    }

    if (event.action === "synchronize" || event.action === "opened" || event.action === "ready_for_review") {
      await this.runAutomatedChecks();
    }

    if (event.comment && event.action === "created") {
      await this.runAutomatedChecks();
    }

    return this.getStatus();
  }

  async runAutomatedChecks() {
    if (!this.repoName || !this.prNumber) {
      throw new Error("PR context has not been initialized");
    }

    if (this.workflowStatus === "running_checks") {
      return this.getStatus();
    }

    this.workflowStatus = "running_checks";
    await this.alarms.schedule(1, "processWorkflowAlarm", { type: "checks" });
    return this.getStatus();
  }

  async postComment(body: string) {
    if (!this.repoName || !this.prNumber) {
      throw new Error("Cannot post comment without repository context");
    }

    const [owner, repo] = this.repoName.split("/");
    const token = await this.getGitHubToken();
    if (!token) {
      throw new Error("Unable to resolve GitHub credentials");
    }

    const client = new GitHubClient({ personalAccessToken: token });
    await client.rest.issues.createComment({ owner, repo, issue_number: this.prNumber, body });
  }

  async getStatus() {
    return {
      repoName: this.repoName,
      prNumber: this.prNumber,
      status: this.status,
      workflowStatus: this.workflowStatus,
      checkResults: this.checkResults,
    };
  }

  protected override async onRequest(request: Request): Promise<Response> {
    if (request.method === "GET") {
      return Response.json(await this.getStatus());
    }

    if (request.method === "POST") {
      const { method, params } = (await request.json()) as { method: string; params?: unknown[] };
      const target = (this as Record<string, unknown>)[method];
      if (typeof target !== "function") {
        return new Response("Unknown method", { status: 404 });
      }

      const result = await (target as (...args: unknown[]) => unknown).apply(this, params ?? []);
      return Response.json(result ?? null);
    }

    return new Response("Method not allowed", { status: 405 });
  }

  private async executeChecks() {
    if (!this.repoName || !this.prNumber) {
      this.workflowStatus = "failed";
      return;
    }

    try {
      const [owner, repo] = this.repoName.split("/");
      const token = await this.getGitHubToken();
      if (!token) {
        throw new Error("Missing GitHub token");
      }

      const client = new GitHubClient({ personalAccessToken: token });
      const pr = await client.rest.pulls.get({ owner, repo, pull_number: this.prNumber });

      this.status = (pr.data.merged_at ? "merged" : (pr.data.state as PullRequestStatus)) ?? "open";
      this.checkResults = {
        headSha: pr.data.head.sha,
        baseSha: pr.data.base.sha,
        updatedAt: new Date().toISOString(),
      };
      this.workflowStatus = "approved";
    } catch (error) {
      console.error("[PullRequestActor] Automated checks failed", error);
      this.workflowStatus = "failed";
      this.checkResults = {
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  private async processWorkflowAlarm(payload: PullRequestAlarmPayload) {
    switch (payload.type) {
      case "checks":
        await this.executeChecks();
        break;
      default:
        throw new Error(`Unsupported workflow alarm type: ${payload.type}`);
    }
  }

  private async getGitHubToken(): Promise<string | null> {
    if (this.installationId) {
      try {
        return await getInstallationToken(this.env, this.installationId);
      } catch (error) {
        console.warn("[PullRequestActor] Failed to mint installation token", error);
      }
    }

    return this.env.GITHUB_TOKEN ?? null;
  }
}

export default PullRequestActor;
