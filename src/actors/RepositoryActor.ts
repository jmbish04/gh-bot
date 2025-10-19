import { Actor, Persist } from "@cloudflare/actors";
import type { AlarmInvocationInfo } from "@cloudflare/workers-types";

export type RepositoryAnalysisStatus = "pending" | "in_progress" | "complete" | "failed";

export interface RepositoryAnalysisSnapshot {
  completedAt: string;
  notes: string;
}

export interface RepositorySetupConfig {
  owner: string;
  repo: string;
  defaultBranch?: string;
  installationId?: number;
  eventType?: string;
}

type RepositoryAlarmPayload =
  | { type: "setup"; config: RepositorySetupConfig }
  | { type: "analysis" };

type Env = {
  DB: D1Database;
};

export class RepositoryActor extends Actor<Env> {
  @Persist
  private repoName: string | null = null;

  @Persist
  private analysisStatus: RepositoryAnalysisStatus = "pending";

  @Persist
  private analysisResults: RepositoryAnalysisSnapshot | null = null;

  @Persist
  private isSetupComplete = false;

  async initialize(name: string) {
    await super.setName(name);
  }

  async setupRepository(config: RepositorySetupConfig) {
    this.repoName = `${config.owner}/${config.repo}`;
    this.analysisStatus = "pending";
    this.analysisResults = null;
    this.isSetupComplete = false;

    await this.alarms.schedule(1, "processRepositoryAlarm", { type: "setup", config });

    return this.getStatus();
  }

  async analyzeRepo() {
    if (!this.repoName) {
      throw new Error("Repository has not been configured for analysis");
    }

    if (this.analysisStatus === "in_progress") {
      return this.getStatus();
    }

    this.analysisStatus = "pending";
    await this.alarms.schedule(1, "processRepositoryAlarm", { type: "analysis" });

    return this.getStatus();
  }

  async getStatus() {
    return {
      repoName: this.repoName,
      analysisStatus: this.analysisStatus,
      analysisResults: this.analysisResults,
      isSetupComplete: this.isSetupComplete,
    };
  }

  protected override async onRequest(request: Request): Promise<Response> {
    if (request.method === "GET") {
      return Response.json(await this.getStatus());
    }

    if (request.method === "POST") {
      const { method, params } = (await request.json()) as { method: string; params?: unknown[] };

      const allowedMethods: Record<string, (...args: unknown[]) => Promise<unknown>> = {
        initialize: async (name: unknown) => {
          if (typeof name !== "string") {
            throw new Error("Actor name must be a string");
          }
          await this.initialize(name);
        },
        setupRepository: async (config: unknown) => {
          if (!config || typeof config !== "object") {
            throw new Error("Repository configuration must be an object");
          }
          return this.setupRepository(config as RepositorySetupConfig);
        },
        analyzeRepo: async () => this.analyzeRepo(),
        getStatus: async () => this.getStatus(),
      };

      const target = allowedMethods[method];
      if (!target) {
        return new Response("Unknown or disallowed method", { status: 404 });
      }

      const result = await target(...(params ?? []));
      return Response.json(result ?? null);
    }

    return new Response("Method not allowed", { status: 405 });
  }

  protected override async onAlarm(alarmInfo?: AlarmInvocationInfo) {
    const payload = alarmInfo?.state?.payload as RepositoryAlarmPayload | undefined;
    if (!payload) {
      return;
    }
    await this.processRepositoryAlarm(payload);
  }

  private async processRepositoryAlarm(payload: RepositoryAlarmPayload) {
    switch (payload.type) {
      case "setup":
        await this.executeSetup(payload.config);
        break;
      case "analysis":
        await this.executeAnalysis();
        break;
      default:
        const _exhaustiveCheck: never = payload;
        throw new Error(`Unhandled repository alarm payload: ${JSON.stringify(_exhaustiveCheck)}`);
    }
  }

  private async executeSetup(config: RepositorySetupConfig) {
    this.analysisStatus = "in_progress";

    try {
      await this.logAction("start", config);
      await this.storage.put("lastSetupConfig", config);
      this.isSetupComplete = true;
      await this.executeAnalysis();
      await this.logAction("complete", config);
    } catch (error) {
      this.analysisStatus = "failed";
      await this.logAction("failed", config, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async executeAnalysis() {
    this.analysisStatus = "in_progress";

    try {
      const notes = `Automated repository analysis finished for ${this.repoName ?? "unknown"}`;
      const snapshot: RepositoryAnalysisSnapshot = {
        completedAt: new Date().toISOString(),
        notes,
      };
      this.analysisResults = snapshot;
      this.analysisStatus = "complete";
      await this.storage.put("lastAnalysis", snapshot);
    } catch (error) {
      this.analysisStatus = "failed";
      await this.storage.delete("lastAnalysis");
      throw error;
    }
  }

  private async logAction(action: string, config: RepositorySetupConfig, error?: string) {
    const repo = `${config.owner}/${config.repo}`;
    const details = {
      repo,
      defaultBranch: config.defaultBranch ?? null,
      installationId: config.installationId ?? null,
      action,
      timestamp: new Date().toISOString(),
      error: error ?? null,
    };

    try {
      await this.env.DB.prepare(
        `INSERT INTO repo_setup_logs (repo, event_type, action, status, details_json) VALUES (?, ?, ?, ?, ?)`
      )
        .bind(repo, config.eventType ?? "repository_setup", action, error ? "error" : "success", JSON.stringify(details))
        .run();
    } catch (dbError) {
      console.warn("[RepositoryActor] Failed to persist log", dbError);
    }
  }
}

export default RepositoryActor;
