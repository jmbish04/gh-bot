import { Actor, Persist } from "@cloudflare/actors";

export type ResearchStatus = "pending" | "researching" | "complete" | "failed";

interface ResearchAlarmPayload {
  step: number;
}

type Env = Record<string, never>;

export class ResearchActor extends Actor<Env> {
  @Persist
  private query: string | null = null;

  @Persist
  private status: ResearchStatus = "pending";

  @Persist
  private results: string | null = null;

  @Persist
  private step = 0;

  async startResearch(query: string) {
    if (!query) {
      throw new Error("Research query cannot be empty");
    }

    this.query = query;
    this.status = "researching";
    this.results = null;
    this.step = 0;

    await this.alarms.schedule(1, "performResearchStep", { step: 1 });
    return { id: this.name, status: this.status };
  }

  async getResults() {
    return {
      query: this.query,
      status: this.status,
      results: this.results,
      step: this.step,
    };
  }

  protected override async onRequest(request: Request): Promise<Response> {
    if (request.method === "GET") {
      return Response.json(await this.getResults());
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

  private async performResearchStep(payload: ResearchAlarmPayload) {
    if (!this.query) {
      this.status = "failed";
      return;
    }

    this.step = payload.step;

    try {
      const summary = `Research step ${payload.step} for "${this.query}" completed at ${new Date().toISOString()}`;
      const existing = this.results ? `${this.results}\n${summary}` : summary;
      this.results = existing;

      if (payload.step >= 3) {
        this.status = "complete";
        return;
      }

      await this.alarms.schedule(1, "performResearchStep", { step: payload.step + 1 });
    } catch (error) {
      console.error("[ResearchActor] Failed research step", error);
      this.status = "failed";
    }
  }
}

export default ResearchActor;
