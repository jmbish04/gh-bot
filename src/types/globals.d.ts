/// <reference types="@cloudflare/workers-types" />

declare global {
  const DB: D1Database;

  interface Env {
    CONFLICT_RESOLVER: DurableObjectNamespace;
    Sandbox?: Fetcher;
  }
}

export { };
