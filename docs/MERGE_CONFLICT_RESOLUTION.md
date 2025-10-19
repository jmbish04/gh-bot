# Merge Conflict Resolution Workflow

This document outlines the Phase 1 MVP implementation for the automated merge conflict resolution workflow handled by the `ConflictResolver` Durable Object.

## Architecture Overview

1. **Trigger** – Maintainers comment on a pull request with phrases such as `@colby please fix conflicts`. The webhook handler validates the request and records a new merge operation in D1.
2. **Durable Object** – `ConflictResolver` receives the trigger, orchestrates sandbox execution, invokes Workers AI for analysis, and posts suggestions back to GitHub.
3. **Sandbox** – A Cloudflare Sandbox service binding clones the repository, attempts a merge, and returns conflict metadata for analysis.
4. **Workers AI** – The conflict analyzer prompts Workers AI to generate JSON-formatted resolution suggestions per conflicted file.
5. **Persistence** – All operations are stored in the `merge_operations` table with status transitions, timestamps, AI output, and error metadata.

## API Endpoints

- `POST /api/merge-operations/status/:operationId` – Fetches the latest Durable Object state for a merge operation.
- `GET /api/merge-operations/:operationId` – Returns the stored D1 record including AI suggestions and conflict file metadata.

## Durable Object States

`ConflictResolver` progresses through the following states:

1. `pending` – Operation has been recorded.
2. `detecting` – Sandbox analysis is underway.
3. `analyzing` – Workers AI is reviewing conflicts.
4. `suggestion_posted` – Suggestions are published to GitHub.
5. `completed` or `failed` – Terminal state after posting or encountering an error.

## Security & Safeguards

- Comment authors must have push permissions to trigger the workflow.
- Duplicate triggers within five minutes are ignored to prevent spam.
- Unauthorized requests receive a GitHub comment explaining the access requirement.
- Sandbox binding is required; failures are logged and surfaced through D1 and Durable Object status.

## Troubleshooting

| Symptom | Likely Cause | Resolution |
| --- | --- | --- |
| `404 Operation not found` | Unknown ID | Verify the recorded operation ID from logs or comments. |
| `502` from status endpoint | Durable Object unavailable | Inspect worker logs for runtime exceptions. |
| No GitHub comment posted | Missing AI binding or sandbox failure | Check D1 `merge_operations.error_message` and worker logs. |

## Deployment Notes

- Add the `CONFLICT_RESOLVER` Durable Object and `Sandbox` service binding in `wrangler.jsonc`.
- Apply migration `0013_merge_conflict_operations.sql` before deploying.
- Ensure `MERGE_CONFLICT_MODEL` (optional) points to a suitable Workers AI model for code analysis.

