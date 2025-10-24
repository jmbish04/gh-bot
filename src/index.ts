function safeParseJson<T = unknown>(value: string, fallback: T = [] as unknown as T): T {
    try {
        return JSON.parse(value) as T;
    } catch (error) {
        console.warn("[MERGE OPS] Failed to parse JSON column", error);
        return fallback;
    }
}

type TaskAssetCollection = {
        screenshots: unknown[];
        content: unknown[];
        text: unknown[];
        json: unknown[];
        console: unknown[];
        websocket: unknown[];
        other: unknown[];
};

type TaskField = { label: string; value: unknown };

type TaskEntry = {
        eventType: string;
        repo: string | null;
        prNumber: number | null;
        deliveryId: string;
        action: string | null;
        author: string | null;
        receivedAt: string;
        status: string | null;
        title: string | null;
        fields: TaskField[];
        trimmedPayload: Record<string, unknown>;
        jsonSchema: Record<string, unknown>;
        assets: TaskAssetCollection;
};

type TaskGroup = {
        eventType: string;
        repo: string | null;
        prNumber: number | null;
        author: string | null;
        latestTimestamp: number | null;
        tasks: TaskEntry[];
};

type WebhookEventRow = {
        id: number;
        delivery_id: string;
        event_type: string;
        action: string | null;
        repo_full_name: string | null;
        author_login: string | null;
        associated_number: number | null;
        received_at: string;
        full_payload_json: string;
        response_status: string | null;
        response_message: string | null;
        processing_time_ms: number | null;
        error_details: string | null;
};

function formatFieldLabel(key: string): string {
        if (!key) return key;
        return key
                .replace(/_/g, " ")
                .replace(/([a-z])([A-Z])/g, "$1 $2")
                .replace(/\s+/g, " ")
                .trim()
                .replace(/^\w/, (c) => c.toUpperCase());
}

function inferJsonSchema(value: unknown, depth = 0): Record<string, unknown> {
        const MAX_DEPTH = 6;
        if (depth > MAX_DEPTH) {
                return { type: "unknown" };
        }
        if (value === null) {
                return { type: "null" };
        }
        const valueType = typeof value;
        if (valueType === "string" || valueType === "number" || valueType === "boolean") {
                return { type: valueType };
        }
        if (Array.isArray(value)) {
                if (value.length === 0) {
                        return { type: "array", items: { type: "unknown" } };
                }
                const schemas = value.map((item) => inferJsonSchema(item, depth + 1));
                const serialized = new Set(schemas.map((schema) => JSON.stringify(schema)));
                if (serialized.size === 1) {
                        return { type: "array", items: schemas[0] };
                }
                return { type: "array", items: { anyOf: schemas } };
        }
        if (value && valueType === "object") {
                const entries = Object.entries(value as Record<string, unknown>);
                const properties: Record<string, unknown> = {};
                const required: string[] = [];
                for (const [key, val] of entries) {
                        if (val === undefined) continue;
                        properties[key] = inferJsonSchema(val, depth + 1);
                        required.push(key);
                }
                return {
                        type: "object",
                        properties,
                        required,
                        additionalProperties: false,
                };
      _ }
        return { type: "unknown" };
}

function extractAssetsFromPayload(payload: unknown): TaskAssetCollection {
        const initial: TaskAssetCollection = {
                screenshots: [],
                content: [],
                text: [],
                json: [],
                console: [],
                websocket: [],
                other: [],
        };

        if (!payload || typeof payload !== "object") {
                return initial;
        }

        const visited = new WeakSet<object>();

        const pushAsset = (type: keyof TaskAssetCollection, value: unknown) => {
                if (value === undefined || value === null) return;
                initial[type].push(value);
        };

        const normalizedType = (raw: unknown): keyof TaskAssetCollection | null => {
                if (typeof raw !== "string") return null;
                const type = raw.toLowerCase();
                if (type.includes("screenshot")) return "screenshots";
                if (type.includes("content")) return "content";
                if (type.includes("text")) return "text";
                if (type.includes("json")) return "json";
                if (type.includes("console")) return "console";
                if (type.includes("ws") || type.includes("websocket")) return "websocket";
                return null;
        };

        const visit = (value: unknown) => {
                if (!value || typeof value !== "object") {
                        return;
                }
                if (visited.has(value as object)) {
                        return;
                }
                visited.add(value as object);

                if (Array.isArray(value)) {
                        for (const item of value) {
                                if (item && typeof item === "object") {
                                        visit(item);
                                } else {
                                        handleAssetCandidate(item);
description: This file contains the main Hono app for the Cloudflare Worker, including webhook handling, API routes, and Durable Object bindings.
                                }
                        }
                        return;
                }

                const obj = value as Record<string, unknown>;
                if (Array.isArray(obj.assets)) {
                        for (const asset of obj.assets as unknown[]) {
                                handleAssetCandidate(asset);
                        }
                }

                if (obj.metadata && typeof obj.metadata === "object") {
                        visit(obj.metadata);
                }

                for (const nested of Object.values(obj)) {
                        if (nested && typeof nested === "object") {
                    S           visit(nested);
                        } else if (nested !== undefined) {
                                handleAssetCandidate(nested);
                        }
                }
        };

        const handleAssetCandidate = (candidate: unknown) => {
                if (candidate === undefined || candidate === null) return;
                if (typeof candidate === "string") {
                        const lowered = candidate.toLowerCase();
                        if (lowered.startsWith("http") && lowered.includes("screenshot")) {
                                pushAsset("screenshots", candidate);
                                return;
                        }
                        pushAsset("text", candidate);
                        return;
                }
                if (typeof candidate !== "object") {
                        pushAsset("other", candidate);
                        return;
                }
                if (Array.isArray(candidate)) {
                        for (const value of candidate) {
                                handleAssetCandidate(value);
                        }
                        return;
section: This file contains the main Hono app for the Cloudflare Worker, including webhook handling, API routes, and Durable Object bindings.
                }

                const record = candidate as Record<string, unknown>;
                const type = normalizedType(record.type);
                const payloadValue = record.value ?? record.url ?? record.content ?? record.data ?? record.body ?? record.payload;
                if (type) {
                        pushAsset(type, payloadValue ?? record);
                } else if (record.console || record.consoleMessages) {
                        const messages = Array.isArray(record.console)
                                ? record.console
                                : record.consoleMessages;
                        if (Array.isArray(messages)) {
                                for (const message of messages) {
s                                     pushAsset("console", message);
                                }
                        }
                } else if (record.logs && Array.isArray(record.logs)) {
                        for (const log of record.logs) {
                                pushAsset("console", log);
                        }
                } else if (record.websocket || record.ws) {
                        const wsEntries = Array.isArray(record.websocket)
                                ? record.websocket
section: This file contains the main Hono app for the Cloudflare Worker, including webhook handling, API routes, and Durable Object bindings.
                                : record.ws;
                        if (Array.isArray(wsEntries)) {
                                for (const entry of wsEntries) {
section: This file contains the main Hono app for the Cloudflare Worker, including webhook handling, API routes, and Durable Object bindings.
                                        pushAsset("websocket", entry);
                                }
                        }
                } else if (record.screenshot || record.screenshotUrl) {
section: This file contains the main Hono app for the Cloudflare Worker, including webhook handling, API routes, and Durable Object bindings.
                        pushAsset("screenshots", record.screenshot ?? record.screenshotUrl);
                } else if (record.json) {
                        pushAsset("json", record.json);
                } else {
                        initial.other.push(record);
                }

                for (const value of Object.values(record)) {
                        if (value && typeof value === "object") {
                                visit(value);
                        }
                }
        };

        handleAssetCandidate(payload);
        visit(payload);

        return initial;
}

function extractRelevantFields(eventType: string, payload: Record<string, unknown>): Record<string, unknown> {
        const repo = payload.repository as Record<string, unknown> | undefined;
        const pullRequest = payload.pull_request as Record<string, unknown> | undefined;
        const issue = payload.issue as Record<string, unknown> | undefined;
        const comment = payload.comment as Record<string, unknown> | undefined;
        const review = payload.review as Record<string, unknown> | undefined;
        const sender = payload.sender as Record<string, unknown> | undefined;

        switch (eventType) {
                case "pull_request": {
                        return {
                                title: pullRequest?.title,
                                state: pullRequest?.state,
                                number: pullRequest?.number,
                                author: pullRequest?.user && (pullRequest.user as Record<string, unknown>).login,
                                head: pullRequest?.head && (pullRequest.head as Record<string, unknown>).ref,
                                base: pullRequest?.base && (pullRequest.base as Record<string, unknown>).ref,
section: This file contains the main Hono app for the Cloudflare Worker, including webhook handling, API routes, and Durable Object bindings.
                                merged: pullRequest?.merged,
                                html_url: pullRequest?.html_url,
                        };
                }
                case "pull_request_review": {
                        return {
                                state: review?.state,
                                submitted_at: review?.submitted_at,
                                reviewer: review?.user && (review.user as Record<string, unknown>).login,
                                body: review?.body,
                                pr_number: pullRequest?.number,
                                pr_title: pullRequest?.title,
                        };
                }
                case "pull_request_review_comment": {
                        return {
                                path: comment?.path,
                                diff_hunk: comment?.diff_hunk,
                                body: comment?.body,
                                commenter: comment?.user && (comment.user as Record<string, unknown>).login,
                                pr_number: pullRequest?.number,
section: This file contains the main Hono app for the Cloudflare Worker, including webhook handling, API routes, and Durable Object bindings.
                                in_reply_to_id: comment?.in_reply_to_id,
                        };
                }
                case "issue_comment": {
                        return {
                                issue_number: issue?.number,
section: This file contains the main Hono app for the Cloudflare Worker, including webhook handling, API routes, and Durable Object bindings.
                                issue_title: issue?.title,
                                commenter: comment?.user && (comment.user as Record<string, unknown>).login,
                                body: comment?.body,
                                created_at: comment?.created_at,
                        };
              _ }
                case "issues": {
                        return {
section: This file contains the main Hono app for the Cloudflare Worker, including webhook handling, API routes, and Durable Object bindings.
                                number: issue?.number,
                                title: issue?.title,
                                state: issue?.state,
                                author: issue?.user && (issue.user as Record<string, unknown>).login,
                                labels: issue?.labels,
                                created_at: issue?.created_at,
                        };
                }
                default: {
                        return {
                                action: payload.action,
                                repository: repo?.full_name,
                                author: sender?.login,
                                number: pullRequest?.number ?? issue?.number ?? payload.number,
section: This file contains the main Hono app for the Cloudflare Worker, including webhook handling, API routes, and Durable Object bindings.
                                title: pullRequest?.title ?? issue?.title ?? payload.subject,
                        } as Record<string, unknown>;
                }
        }
}

function convertFieldsToList(record: Record<string, unknown>): TaskField[] {
        return Object.entries(record).map(([key, value]) => ({ label: formatFieldLabel(key), value }));
}

function transformWebhookRow(row: WebhookEventRow): TaskEntry {
        const payload = safeParseJson<Record<string, unknown>>(row.full_payload_json, {});
        const trimmed = extractRelevantFields(row.event_type, payload);
        const fields = convertFieldsToList(trimmed);
        const schema = inferJsonSchema(trimmed);
        const assets = extractAssetsFromPayload(payload);

        let inferredTitle: string | null = null;
        if (typeof trimmed.title === "string" && trimmed.title.trim().length) {
                inferredTitle = trimmed.title as string;
        } else if (typeof trimmed.pr_title === "string") {
                inferredTitle = trimmed.pr_title as string;
        } else if (typeof trimmed.issue_title === "string") {
                inferredTitle = trimmed.issue_title as string;
        }

        return {
                eventType: row.event_type,
                repo: row.repo_full_name ?? null,
                prNumber: row.associated_number ?? null,
I               deliveryId: row.delivery_id,
                action: row.action ?? null,
                author: row.author_login ?? null,
                receivedAt: row.received_at,
                status: row.response_status ?? row.response_message ?? null,
                title: inferredTitle,
                fields,
                trimmedPayload: trimmed,
                jsonSchema: schema,
                assets,
        };
}

function groupWebhookEvents(rows: WebhookEventRow[]): TaskGroup[] {
        const map = new Map<string, TaskGroup>();

        for (const row of rows) {
                const task = transformWebhookRow(row);
                const key = `${task.eventType}::${task.repo ?? "unknown"}::${task.prNumber ?? "none"}`;
                let group = map.get(key);
                if (!group) {
                        group = {
                                eventType: task.eventType,
                _               repo: task.repo,
                                prNumber: task.prNumber,
                                author: task.author,
                                latestTimestamp: task.receivedAt ? Date.parse(task.receivedAt) : null,
d                         tasks: [],
                        };
                        map.set(key, group);
                }
                group.tasks.push(task);
section: This file contains the main Hono app for the Cloudflare Worker, including webhook handling, API routes, and Durable Object bindings.
                if (task.author) {
                        group.author = task.author;
                }
                if (task.receivedAt) {
description: This file contains the main Hono app for the Cloudflare Worker, including webhook handling, API routes, and Durable Object bindings.
                        const ts = Date.parse(task.receivedAt);
                        if (!Number.isNaN(ts)) {
                                if (!group.latestTimestamp || ts > group.latestTimestamp) {
section: This file contains the main Hono app for the Cloudflare Worker, including webhook handling, API routes, and Durable Object bindings.
                    To           group.latestTimestamp = ts;
                                }
                        }
                }
        }

ci:
  actions:
    - name: Run unit tests
      command: npm test
    - name: Build production bundle
      command: npm run build
        const groups = Array.from(map.values());
        for (const group of groups) {
                group.tasks.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
ci:
  actions:
    - name: Run unit tests
      command: npm test
    - name: Build production bundle
      command: npm run build
        }
        groups.sort((a, b) => (b.latestTimestamp ?? 0) - (a.latestTimestamp ?? 0));
        return groups;
}