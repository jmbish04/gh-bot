import { createHash } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
};

const LOG_METHODS: LogLevel[] = ["debug", "info", "warn", "error"];

export function createLogger(scope: string, baseContext: Record<string, unknown> = {}): Logger {
  const log = (level: LogLevel, message: string, context?: Record<string, unknown>) => {
    const payload = {
      scope,
      level,
      message,
      timestamp: new Date().toISOString(),
      ...baseContext,
      ...(context ?? {}),
    };
    const serialized = JSON.stringify(payload);
    switch (level) {
      case "debug":
        console.debug(serialized);
        break;
      case "info":
        console.info(serialized);
        break;
      case "warn":
        console.warn(serialized);
        break;
      default:
        console.error(serialized);
        break;
    }
  };

  return LOG_METHODS.reduce((acc, level) => {
    acc[level] = (message: string, context?: Record<string, unknown>) => log(level, message, context);
    return acc;
  }, {} as Record<LogLevel, (message: string, context?: Record<string, unknown>) => void>) as Logger;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.keys(val as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = (val as Record<string, unknown>)[key];
          return acc;
        }, {});
    }
    return val;
  });
}

export async function hashContent(content: string): Promise<string> {
  if (typeof crypto !== "undefined" && "subtle" in crypto) {
    const data = new TextEncoder().encode(content);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  return createHash("sha256").update(content).digest("hex");
}

export async function withRetries<T>(
  fn: () => Promise<T>,
  options: { retries?: number; delayMs?: number; onRetry?: (error: unknown, attempt: number) => void } = {}
): Promise<T> {
  const retries = options.retries ?? 3;
  const delayMs = options.delayMs ?? 500;

  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retries) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        break;
      }
      options.onRetry?.(error, attempt + 1);
      const timeout = delayMs * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, timeout));
      attempt += 1;
    }
  }

  throw lastError ?? new Error("Retry attempts exhausted");
}

export function formatTimestamp(date: Date = new Date()): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

export type RepositoryTarget = { owner: string; repo: string };

export function normalizeRepositoryTarget(payload: any): RepositoryTarget | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const repo = payload.repository ?? payload.repo;
  if (!repo) {
    return null;
  }

  if (typeof repo.full_name === "string") {
    const [owner, repoName] = repo.full_name.split("/");
    if (owner && repoName) {
      return { owner: owner.toLowerCase(), repo: repoName.toLowerCase() };
    }
  }

  if (typeof repo.owner?.login === "string" && typeof repo.name === "string") {
    return { owner: repo.owner.login.toLowerCase(), repo: repo.name.toLowerCase() };
  }

  if (typeof payload.organization?.login === "string" && typeof payload.repository?.name === "string") {
    return { owner: payload.organization.login.toLowerCase(), repo: payload.repository.name.toLowerCase() };
  }

  return null;
}

export function hasNoBotAgentsLabel(payload: any): boolean {
  const labels = payload?.repository?.topics ?? payload?.repository?.labels;
  if (Array.isArray(labels)) {
    return labels.some((topic) => {
      if (typeof topic === "string") {
        return topic.toLowerCase() === "no-bot-agents";
      }
      if (topic && typeof topic === "object" && typeof topic.name === "string") {
        return topic.name.toLowerCase() === "no-bot-agents";
      }
      return false;
    });
  }
  return false;
}

export async function debounceRepo(
  kv: KVNamespace | undefined,
  target: RepositoryTarget,
  ttlSeconds: number,
  logger: Logger
): Promise<boolean> {
  if (!kv) {
    return true;
  }
  const key = `debounce:${target.owner}/${target.repo}`;
  try {
    const existing = await kv.get(key);
    if (existing) {
      logger.debug("Debounce hit, skipping", { key });
      return false;
    }
    await kv.put(key, "1", { expirationTtl: ttlSeconds });
    return true;
  } catch (error) {
    logger.warn("Failed to set debounce key", { key, error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}
