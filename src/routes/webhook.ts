// src/routes/webhook.ts
import { verify as verifySignature } from '@octokit/webhooks-methods'
import { ensureRepoMcpTools } from '../modules/mcp_tools'
import {
  ghREST,
  GitHubHttpError,
  createInstallationClient,
  GitHubClient,
  checkUserHasPushAccess,
  postPRComment,
  getPRBranchDetails,
} from '../github'
import type { MergeConflictTrigger } from '../types/merge_conflicts'

export const CONFLICT_MENTION_PATTERN = /(?:@colby|colby)[,:]?\s+(?:please\s+)?fix(?:\s+(?:the\s+)?code)?\s+conflicts?/i

export type { Env }
export type { WebhookData }

/**
 * Helper function to handle MCP tools setup for any repository event
 */
async function handleMcpToolsForRepo(db: D1Database, repo: string, eventType: string): Promise<void> {
  try {
    const mcpResult = await ensureRepoMcpTools(db, repo, eventType)
    if (mcpResult.action === 'setup' && mcpResult.toolsAdded) {
      console.log(`[WEBHOOK] Set up ${mcpResult.toolsAdded.length} default MCP tools for repository ${repo}:`, mcpResult.toolsAdded)
    } else if (mcpResult.action === 'skip' && mcpResult.toolsFound) {
      console.log(`[WEBHOOK] Repository ${repo} already has ${mcpResult.toolsFound.length} MCP tools configured`)
    }
    if (mcpResult.error) {
      console.error(`[WEBHOOK] Error setting up MCP tools for repository ${repo}:`, mcpResult.error)
    }
  } catch (error) {
    console.error(`[WEBHOOK] Failed to process MCP tools for repository ${repo}:`, error)
  }
}

type Env = {
  DB: D1Database
  GITHUB_WEBHOOK_SECRET: string
  PR_WORKFLOWS: DurableObjectNamespace
  REPO_SETUP: DurableObjectNamespace
  RESEARCH_ORCH?: DurableObjectNamespace
  AI?: any
  GITHUB_TOKEN?: string
  GITHUB_APP_ID?: string
  GITHUB_APP_PRIVATE_KEY?: string
  GITHUB_INSTALLATION_ID?: string
  GITHUB_REPO_DEFAULT_BRANCH_FALLBACK?: string
  AGENT_DEBOUNCE?: KVNamespace
  REPO_MEMORY?: KVNamespace
  CF_BINDINGS_MCP_URL?: string
  CONFLICT_RESOLVER?: DurableObjectNamespace
  Sandbox?: Fetcher
}

type WebhookData = {
  delivery: string
  event: string
  signature: string
  bodyText: string
  headers: Record<string, string>
}

const MAX_CONTEXT_TEXT_LENGTH = 4000

export function truncateText(value: unknown, limit: number = MAX_CONTEXT_TEXT_LENGTH): string | undefined {
  if (typeof value !== 'string') {
    return typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined
  }

  if (value.length <= limit) {
    return value
  }

  return value.slice(0, limit) + '…'
}

export function simplifyUser(user: any) {
  if (!user) return undefined
  return {
    login: user.login,
    id: user.id,
    type: user.type,
    avatar_url: user.avatar_url,
    html_url: user.html_url
  }
}

export function simplifyRepository(repo: any) {
  if (!repo) return undefined
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    default_branch: repo.default_branch,
    private: repo.private,
    html_url: repo.html_url,
    owner: simplifyUser(repo.owner)
  }
}

export function extractRelevantData(eventType: string, payload: any) {
  const relevant: Record<string, any> = {
    event_type: eventType,
    action: payload?.action,
    repository: simplifyRepository(payload?.repository),
    sender: simplifyUser(payload?.sender),
    installation: payload?.installation ? { id: payload.installation.id } : undefined,
    organization: payload?.organization
      ? { id: payload.organization.id, login: payload.organization.login }
      : undefined
  }

  switch (eventType) {
    case 'pull_request': {
      const pr = payload?.pull_request
      relevant.pull_request = pr
        ? {
            id: pr.id,
            number: pr.number,
            title: truncateText(pr.title, 512),
            state: pr.state,
            merged: pr.merged,
            draft: pr.draft,
            mergeable: pr.mergeable,
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            merged_at: pr.merged_at,
            base: pr.base
              ? {
                  ref: pr.base.ref,
                  sha: pr.base.sha,
                  repo: simplifyRepository(pr.base.repo)
                }
              : undefined,
            head: pr.head
              ? {
                  ref: pr.head.ref,
                  sha: pr.head.sha,
                  repo: simplifyRepository(pr.head.repo)
                }
              : undefined,
            user: simplifyUser(pr.user),
            body: truncateText(pr.body)
          }
        : undefined
      break
    }
    case 'pull_request_review': {
      relevant.review = payload?.review
        ? {
            id: payload.review.id,
            state: payload.review.state,
            submitted_at: payload.review.submitted_at,
            body: truncateText(payload.review.body)
          }
        : undefined
      relevant.pull_request = payload?.pull_request
        ? {
            number: payload.pull_request.number,
            title: truncateText(payload.pull_request.title, 512),
            state: payload.pull_request.state,
            user: simplifyUser(payload.pull_request.user)
          }
        : undefined
      break
    }
    case 'pull_request_review_comment': {
      const comment = payload?.comment
      relevant.comment = comment
        ? {
            id: comment.id,
            body: truncateText(comment.body),
            diff_hunk: truncateText(comment.diff_hunk),
            path: comment.path,
            line: comment.line,
            start_line: comment.start_line,
            side: comment.side,
            in_reply_to_id: comment.in_reply_to_id,
            user: simplifyUser(comment.user),
            html_url: comment.html_url,
            created_at: comment.created_at,
            updated_at: comment.updated_at
          }
        : undefined
      relevant.pull_request = payload?.pull_request
        ? {
            number: payload.pull_request.number,
            title: truncateText(payload.pull_request.title, 512),
            state: payload.pull_request.state,
            user: simplifyUser(payload.pull_request.user),
            head: payload.pull_request.head
              ? {
                  ref: payload.pull_request.head.ref,
                  sha: payload.pull_request.head.sha
                }
              : undefined,
            base: payload.pull_request.base
              ? {
                  ref: payload.pull_request.base.ref,
                  sha: payload.pull_request.base.sha
                }
              : undefined
          }
        : undefined
      break
    }
    case 'issue_comment': {
      relevant.issue = payload?.issue
        ? {
            id: payload.issue.id,
            number: payload.issue.number,
            title: truncateText(payload.issue.title, 512),
            state: payload.issue.state,
            user: simplifyUser(payload.issue.user),
            pull_request: payload.issue.pull_request
              ? {
                  url: payload.issue.pull_request.url,
                  merged_at: payload.issue.pull_request.merged_at
                }
              : undefined
          }
        : undefined
      relevant.comment = payload?.comment
        ? {
            id: payload.comment.id,
            body: truncateText(payload.comment.body),
            user: simplifyUser(payload.comment.user),
            html_url: payload.comment.html_url,
            created_at: payload.comment.created_at,
            updated_at: payload.comment.updated_at,
            in_reply_to_id: payload.comment.in_reply_to_id
          }
        : undefined
      break
    }
    case 'issues': {
      relevant.issue = payload?.issue
        ? {
            id: payload.issue.id,
            number: payload.issue.number,
            title: truncateText(payload.issue.title, 512),
            state: payload.issue.state,
            user: simplifyUser(payload.issue.user),
            body: truncateText(payload.issue.body)
          }
        : undefined
      break
    }
    case 'repository': {
      relevant.repository_event = payload?.repository
        ? {
            id: payload.repository.id,
            name: payload.repository.name,
            full_name: payload.repository.full_name,
            private: payload.repository.private,
            default_branch: payload.repository.default_branch,
            created_at: payload.repository.created_at
          }
        : undefined
      break
    }
    default: {
      if (payload?.pull_request) {
        relevant.pull_request = {
          number: payload.pull_request.number,
          title: truncateText(payload.pull_request.title, 512),
          state: payload.pull_request.state,
          user: simplifyUser(payload.pull_request.user)
        }
      }
      break
    }
  }

  return relevant
}

/**
 * Checks if a duplicate delivery should be allowed to reprocess
 */
export async function checkRecentDuplicate(env: Env, delivery: string, isCommentEvent: boolean): Promise<boolean> {
  try {
    // For comment events, allow reprocessing if it's been more than 5 minutes
    // For other events, be more strict (30 minutes)
    const timeThreshold = isCommentEvent ? 5 * 60 * 1000 : 30 * 60 * 1000

    const result = await env.DB.prepare(
      'SELECT received_at FROM github_webhook_events WHERE delivery_id = ?'
    ).bind(delivery).first()

    if (!result) {
      return false // No existing record, allow processing
    }

    const receivedAt = result.received_at as string | number | null | undefined
    const lastProcessed =
      typeof receivedAt === 'number'
        ? receivedAt
        : receivedAt
        ? Date.parse(receivedAt)
        : NaN

    if (!Number.isFinite(lastProcessed)) {
      return false
    }

    const timeSinceLastProcessed = Date.now() - lastProcessed

    // Allow reprocessing if enough time has passed
    return timeSinceLastProcessed > timeThreshold
  } catch (error) {
    console.error('[WEBHOOK] Error checking recent duplicate:', error)
    return false // On error, don't allow reprocessing
  }
}

/**
 * Checks if a repository is new (not in the projects table)
 */
export async function isNewRepository(env: Env, repo: string): Promise<boolean> {
  try {
    const result = await env.DB.prepare(
      'SELECT 1 FROM projects WHERE repo = ? LIMIT 1'
    ).bind(repo).first()
    
    return !result // If no result, it's a new repository
  } catch (error) {
    console.error('[WEBHOOK] Error checking if repository is new:', error)
    return true // On error, assume it's new to be safe
  }
}

/**
 * Triggers a research sweep for a specific repository
 */

async function triggerRepositorySetup(env: Env, repo: string, owner: string, defaultBranch: string | undefined, installationId: number | undefined, eventType: string) {
  if (!env.REPO_SETUP) {
    console.log('[WEBHOOK] Repository setup durable object not configured, skipping bootstrap');
    return;
  }

  try {
    const doId = env.REPO_SETUP.idFromName(repo);
    const stub = env.REPO_SETUP.get(doId);
    const body = { owner, repo: repo.split('/')[1], eventType, installationId, defaultBranch };
    await stub.fetch('https://repo-setup/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log('[WEBHOOK] Repository setup workflow triggered', { repo, eventType });
  } catch (error) {
    console.error('[WEBHOOK] Failed to trigger repository setup workflow', { repo, error });
  }
}
async function triggerResearchSweep(env: Env, repo: string): Promise<void> {
  if (!env.RESEARCH_ORCH) {
    console.log('[WEBHOOK] Research orchestrator not available, skipping research sweep')
    return
  }

  try {
    console.log('[WEBHOOK] Triggering research sweep for repository:', repo)
    
    const doId = env.RESEARCH_ORCH.idFromName('global')
    const stub = env.RESEARCH_ORCH.get(doId)
    
    // Trigger research sweep with specific queries for this repository and related accounts
    const [owner, repoName] = repo.split('/')
                    const queries = [
                      `repo:${repo}`,
                      `user:${owner}`,
                      `org:${owner}`,
                      `user:${owner} "wrangler.toml"`,
                      `org:${owner} "wrangler.toml"`,
                      `user:${owner} "DurableObject"`,
                      `org:${owner} "DurableObject"`,
                      // Add specific queries for known accounts
                      'user:jmbish04',
                      'user:jmbish04 "wrangler.toml"',
                      'user:jmbish04 "DurableObject"'
                    ]
    
    const response = await stub.fetch('https://do/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queries,
        categories: ['cloudflare', 'workers']
      })
    })
    
    if (response.ok) {
      console.log('[WEBHOOK] Research sweep triggered successfully for:', repo)
    } else {
      console.error('[WEBHOOK] Failed to trigger research sweep for:', repo, 'Status:', response.status)
    }
  } catch (error) {
    console.error('[WEBHOOK] Error triggering research sweep for:', repo, error)
  }
}

/**
 * Handles incoming GitHub webhook events.
 * Verifies the webhook signature, ensures idempotency, and routes events to appropriate handlers.
 *
 * @param webhookData - The webhook data containing headers and body.
 * @param env - The environment bindings, including database and secrets.
 * @returns A Response object indicating the result of the webhook handling.
 */
export async function handleWebhook(webhookData: WebhookData, env: Env) {
  console.log('[WEBHOOK] Starting webhook processing', {
    delivery: webhookData.delivery,
    event: webhookData.event,
    bodyLength: webhookData.bodyText?.length || 0,
    hasSignature: !!webhookData.signature,
    timestamp: new Date().toISOString()
  })

  const { delivery, event, signature, bodyText } = webhookData

  // GitHub health check
  if (event === 'ping') {
    console.log('[WEBHOOK] Ping received, responding with pong')
    return new Response('pong', { status: 200 })
  }

  // Handle signature verification with proper error handling
  try {
    console.log('[WEBHOOK] Starting signature verification', {
      hasSecret: !!env.GITHUB_WEBHOOK_SECRET,
      hasSignature: !!signature,
      signatureStart: signature?.substring(0, 10) + '...'
    })

    if (!env.GITHUB_WEBHOOK_SECRET) {
      console.log('[WEBHOOK] ERROR: webhook secret not configured')
      return new Response('webhook secret not configured', { status: 401 })
    }

    if (!signature) {
      console.log('[WEBHOOK] ERROR: missing signature')
      return new Response('missing signature', { status: 401 })
    }

    const ok = await verifySignature(env.GITHUB_WEBHOOK_SECRET, bodyText, signature)
    console.log('[WEBHOOK] Signature verification result:', ok)

    if (!ok) {
      console.log('[WEBHOOK] ERROR: bad signature')
      return new Response('bad signature', { status: 401 })
    }
  } catch (error) {
    console.error('[WEBHOOK] Signature verification error:', error)
    return new Response('signature verification failed', { status: 401 })
  }

  console.log('[WEBHOOK] Parsing JSON payload...')
  let payload
  try {
    payload = JSON.parse(bodyText)
    console.log('[WEBHOOK] JSON parsed successfully, payload keys:', Object.keys(payload))
  } catch (parseError) {
    console.error('[WEBHOOK] JSON parse error:', parseError)
    return new Response('invalid JSON payload', { status: 400 })
  }
  const startTime = Date.now()
  const payloadJson = JSON.stringify(payload)
  const relevantPayload = extractRelevantData(event, payload)
  let aiContextPayloadJson = '{}'
  try {
    aiContextPayloadJson = JSON.stringify(relevantPayload)
  } catch (error) {
    console.warn('[WEBHOOK] Failed to stringify AI context payload', error)
  }
  const action = typeof payload.action === 'string' ? payload.action : null
  const repo = payload.repository?.full_name ?? null
  const author =
    payload.sender?.login ??
    payload.comment?.user?.login ??
    payload.review?.user?.login ??
    payload.pull_request?.user?.login ??
    payload.issue?.user?.login ??
    null

  let associatedNumber: number | null = null
  if (typeof payload.pull_request?.number === 'number') {
    associatedNumber = payload.pull_request.number
  } else if (typeof payload.issue?.number === 'number') {
    associatedNumber = payload.issue.number
  } else if (typeof payload.number === 'number') {
    associatedNumber = payload.number
  }

  const receivedAt = new Date(startTime).toISOString()
  let webhookEventId: number | null = null

  // Idempotency: skip if we've seen this delivery already
  console.log('[WEBHOOK] Checking for duplicate delivery:', delivery)
  try {
    // First, try to insert the event with normalized metadata
    const insertResult = await env.DB.prepare(
      `INSERT INTO github_webhook_events (delivery_id, event_type, action, repo_full_name, author_login, associated_number, received_at, full_payload_json, ai_context_payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(delivery, event, action, repo, author, associatedNumber, receivedAt, payloadJson, aiContextPayloadJson)
      .run()

    webhookEventId = insertResult?.meta?.last_row_id ?? null
    console.log('[WEBHOOK] Event recorded in database with normalized schema')
  } catch (dbError) {
    // Check if this is a comment event that we should allow reprocessing
    const isCommentEvent = event === 'pull_request_review_comment' || event === 'issue_comment'
    const isRecentDuplicate = await checkRecentDuplicate(env, delivery, isCommentEvent)

    if (isRecentDuplicate) {
      console.log('[WEBHOOK] Recent duplicate delivery detected, allowing reprocessing:', delivery)
      // Update the existing record with new timestamp, payload, and metadata
      await env.DB.prepare(
        `UPDATE github_webhook_events
         SET received_at = ?, full_payload_json = ?, ai_context_payload_json = ?, action = ?, repo_full_name = ?, author_login = ?, associated_number = ?
         WHERE delivery_id = ?`
      )
        .bind(receivedAt, payloadJson, aiContextPayloadJson, action, repo, author, associatedNumber, delivery)
        .run()

      const existing = await env.DB.prepare(
        'SELECT id FROM github_webhook_events WHERE delivery_id = ?'
      )
        .bind(delivery)
        .first()

      webhookEventId = (existing?.id as number | undefined) ?? null
    } else {
      console.log('[WEBHOOK] Duplicate delivery detected:', delivery)
      return new Response('duplicate', { status: 200 })
    }
  }

  if (webhookEventId) {
    await recordWebhookDetails(env, webhookEventId, event, payload, associatedNumber)
  }

  // Process event with enhanced logging
  let response: Response
  let responseStatus = 'success'
  let responseMessage = ''
  let errorDetails = ''

  console.log('[WEBHOOK] Processing event type:', event)
  console.log('[WEBHOOK] Event details:', {
    event,
    hasComment: !!payload.comment,
    hasReview: !!payload.review,
    hasPullRequest: !!payload.pull_request,
    hasIssue: !!payload.issue,
    commentId: payload.comment?.id,
    reviewId: payload.review?.id,
    prNumber: payload.pull_request?.number || payload.issue?.number
  })

  // AI-powered event analysis for intelligent processing
  let aiAnalysis = null
  try {
    if (env.AI && (event === 'pull_request_review_comment' || event === 'issue_comment')) {
      console.log('[WEBHOOK] Running AI analysis for comment event')
      const commentBody = payload.comment?.body || payload.review?.body || ''
      // Send full payload to AI for comprehensive analysis
      const context = {
        event,
        action: payload.action,
        payload: relevantPayload,
        commentBody: commentBody,
        repo: payload.repository?.full_name,
        prNumber: payload.pull_request?.number,
        issueNumber: payload.issue?.number,
        author: payload.comment?.user?.login || payload.review?.user?.login,
        commentId: payload.comment?.id || payload.review?.id,
        isReviewComment: event === 'pull_request_review_comment',
        hasColbyCommand: commentBody.includes('/colby')
      }

      console.log('[WEBHOOK] AI context (truncated payload):', {
        event,
        action: payload.action,
        repo: payload.repository?.full_name,
        prNumber: payload.pull_request?.number,
        commentId: payload.comment?.id || payload.review?.id,
        hasColbyCommand: commentBody.includes('/colby'),
        fullPayloadSize: payloadJson.length,
        aiContextSize: aiContextPayloadJson.length
      })
      
      const aiResponse = await (env.AI as any).run('@cf/meta/llama-4-scout-17b-16e-instruct', {
        messages: [{
          role: 'system',
          content: `Analyze this GitHub webhook event and determine the best action. You have access to the full webhook payload for comprehensive analysis.
          
          Available actions:
          - process_colby_command: If the comment contains a /colby command (like /colby implement, /colby help, etc.)
          - extract_suggestions: If the comment contains code suggestions but no /colby command
          - group_comments: If the comment should be grouped with others
          - ignore: If no action is needed
          
          Analyze the full payload including:
          - comment.body: The comment text content
          - comment.diff_hunk: Code changes in review comments
          - comment.path: File path for review comments
          - pull_request: PR details and context
          - repository: Repository information
          
          Look for these patterns:
          - "/colby implement" -> process_colby_command
          - "/colby help" -> process_colby_command  
          - "/colby create issue" -> process_colby_command
          - Any other "/colby" command -> process_colby_command
          - Code blocks with suggestions but no /colby -> extract_suggestions
          - diff_hunk with code changes -> extract_suggestions`
        }, {
          role: 'user',
          content: `Event: ${JSON.stringify(context)}`
        }],
        response_format: {
          type: "json_schema",
          json_schema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["process_colby_command", "extract_suggestions", "group_comments", "ignore"],
                description: "The action to take based on the webhook event"
              },
              reason: {
                type: "string",
                description: "Explanation of why this action was chosen"
              },
              confidence: {
                type: "number",
                minimum: 0,
                maximum: 1,
                description: "Confidence level in the decision (0-1)"
              }
            },
            required: ["action", "reason", "confidence"]
          }
        },
        temperature: 0.1,
        max_tokens: 512
      })
      
      // Parse the structured JSON response
      try {
        if (aiResponse.response) {
          // For structured responses, the response should already be parsed JSON
          aiAnalysis = typeof aiResponse.response === 'string' 
            ? JSON.parse(aiResponse.response) 
            : aiResponse.response
        } else {
          // Fallback for non-structured responses
          const responseText = typeof aiResponse === 'string' ? aiResponse : JSON.stringify(aiResponse)
          const jsonMatch = responseText.match(/\{.*\}/s)
          if (jsonMatch) {
            aiAnalysis = JSON.parse(jsonMatch[0])
          } else {
            throw new Error('No JSON found in response')
          }
        }
        
        // Validate the response structure
        if (!aiAnalysis.action || !aiAnalysis.reason || typeof aiAnalysis.confidence !== 'number') {
          throw new Error('Invalid response structure')
        }
        
        console.log('[WEBHOOK] AI analysis result:', aiAnalysis)
      } catch (error) {
        console.log('[WEBHOOK] Could not parse AI response:', error)
        aiAnalysis = { action: 'ignore', reason: 'Could not parse AI response', confidence: 0 }
      }
    }
  } catch (error) {
    console.log('[WEBHOOK] AI analysis failed, proceeding with standard processing:', error)
  }

  try {
    if (event === 'pull_request_review_comment') {
      console.log('[WEBHOOK] Handling pull_request_review_comment')
      response = await onReviewComment(env, delivery, payload, startTime)
    } else if (event === 'pull_request_review') {
      console.log('[WEBHOOK] Handling pull_request_review')
      response = await onPRReview(env, delivery, payload, startTime)
    } else if (event === 'issue_comment' && payload.issue?.pull_request) {
      console.log('[WEBHOOK] Handling issue_comment on PR')
      response = await onIssueComment(env, delivery, payload, startTime)
    } else if (event === 'pull_request') {
      console.log('[WEBHOOK] Handling pull_request event')
      response = await onPullRequest(env, delivery, payload, startTime)
    } else {
      console.log('[WEBHOOK] Event type not handled, ignoring:', event)
      response = new Response('ignored', { status: 200 })
      responseMessage = 'Event type not handled'
    }

    console.log('[WEBHOOK] Handler completed, status:', response.status)

    // Don't consume response body - just use status code for logging
    if (response.status >= 200 && response.status < 300) {
      responseMessage = 'Success'
    } else if (response.status >= 400 && response.status < 500) {
      responseMessage = 'Client error'
    } else if (response.status >= 500) {
      responseMessage = 'Server error'
    } else {
      responseMessage = 'Processed'
    }

    console.log('[WEBHOOK] Response logged without consuming body:', responseMessage)
  } catch (error: any) {
    console.error('[WEBHOOK] Processing error:', error)
    responseStatus = 'error'
    errorDetails = error?.message || String(error)
    responseMessage = 'Processing failed'
    response = new Response('error', { status: 500 })
  }

  // Update event record with processing results
  try {
    const processingTime = Date.now() - startTime
    await env.DB.prepare(`
      UPDATE github_webhook_events
      SET response_status = ?, response_message = ?, processing_time_ms = ?, error_details = ?
      WHERE delivery_id = ?
    `).bind(responseStatus, responseMessage, processingTime, errorDetails, delivery).run()
  } catch (dbError) {
    console.log('Failed to update event log:', dbError)
  }

  return response
}

// ---------- Handlers ----------

/**
 * Processes a pull request review comment event.
 * Extracts suggestions and triggers from the comment body and forwards the event to a Durable Object.
 *
 * @param env - The environment bindings, including database and Durable Object namespace.
 * @param delivery - The unique delivery ID of the webhook event.
 * @param p - The parsed payload of the webhook event.
 * @param startTime - The start time for processing tracking.
 * @returns A Response object indicating the result of the processing.
 */
async function onReviewComment(env: Env, delivery: string, p: any, startTime: number) {
  const repo = `${p.repository.owner.login}/${p.repository.name}`
  const prNumber = p.pull_request.number
  const author = p.comment.user.login
  const action = p.action
  if (p.comment.user.type === 'Bot') return new Response('bot ignored', { status: 200 })

  await updateEventMeta(env, delivery, repo, prNumber, author, action)

  const body: string = p.comment.body || ''
  const suggestions = extractSuggestions(body)
  const triggers = parseTriggers(body)

  console.log('[WEBHOOK] Review comment processing details:', {
    repo,
    prNumber,
    author,
    action,
    hasBody: !!body,
    bodyLength: body.length,
    bodyPreview: body.substring(0, 100),
    suggestionsCount: suggestions.length,
    triggersCount: triggers.length,
    triggers: triggers,
    commentId: p.comment.id,
    filePath: p.comment.path,
    line: p.comment.line,
    side: p.comment.side
  })

  // Don't exit early - let the DO decide what to do
  const doId = env.PR_WORKFLOWS.idFromName(`${repo}#${prNumber}`)
  const stub = env.PR_WORKFLOWS.get(doId)

  const eventData = {
    kind: 'review_comment',
    delivery,
    repo,
    prNumber,
    headRef: p.pull_request.head.ref,
    headSha: p.pull_request.head.sha,
    installationId: p.installation?.id,
    author,
    action,
    suggestions,
    triggers,
    // Comment ID for replying to specific comment thread
    commentId: p.comment.id,
    // file context for patching
    filePath: p.comment.path || null,
    diffHunk: p.comment.diff_hunk || null,
    line: p.comment.line ?? null,
    start_line: p.comment.start_line ?? null,
    side: p.comment.side || null
  }

  console.log('[WEBHOOK] Sending event data to Durable Object:', {
    eventKind: eventData.kind,
    hasFilePath: !!eventData.filePath,
    hasLine: eventData.line !== null,
    hasCommentId: !!eventData.commentId,
    triggersCount: eventData.triggers.length
  })

  const res = await stub.fetch('https://do/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(eventData)
  })

  console.log('[WEBHOOK] Durable Object response status:', res.status)

  // Don't consume response body to avoid "Body has already been used" error
  return new Response('review-comment-processed', { status: res.status })
}

/**
 * Processes a pull request review event.
 * Extracts suggestions and triggers from the review body and forwards the event to a Durable Object.
 *
 * @param env - The environment bindings, including database and Durable Object namespace.
 * @param delivery - The unique delivery ID of the webhook event.
 * @param p - The parsed payload of the webhook event.
 * @param startTime - The start time for processing tracking.
 * @returns A Response object indicating the result of the processing.
 */
async function onPRReview(env: Env, delivery: string, p: any, startTime: number) {
  const repo = `${p.repository.owner.login}/${p.repository.name}`
  const prNumber = p.pull_request.number
  const author = p.review.user.login
  const action = p.action
  if (p.review.user.type === 'Bot') return new Response('bot ignored', { status: 200 })

  await updateEventMeta(env, delivery, repo, prNumber, author, action)

  const body: string = p.review.body || ''
  const suggestions = extractSuggestions(body)
  const triggers = parseTriggers(body)

  // Don't exit early - let the DO decide what to do
  const doId = env.PR_WORKFLOWS.idFromName(`${repo}#${prNumber}`)
  const stub = env.PR_WORKFLOWS.get(doId)

  const res = await stub.fetch('https://do/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'pr_review',
      delivery,
      repo,
      prNumber,
      headRef: p.pull_request.head.ref,
      headSha: p.pull_request.head.sha,
      installationId: p.installation?.id,
      author,
      action,
      suggestions,
      triggers
    })
  })
  // Don't consume response body to avoid "Body has already been used" error
  return new Response('pr-review-processed', { status: res.status })
}

/**
 * Processes an issue comment event on a pull request.
 * Extracts triggers from the comment body and forwards the event to a Durable Object.
 *
 * @param env - The environment bindings, including database and Durable Object namespace.
 * @param delivery - The unique delivery ID of the webhook event.
 * @param p - The parsed payload of the webhook event.
 * @param startTime - The start time for processing tracking.
 * @returns A Response object indicating the result of the processing.
 */
async function onIssueComment(env: Env, delivery: string, p: any, startTime: number) {
  const repo = `${p.repository.owner.login}/${p.repository.name}`
  const prNumber = p.issue.number
  const author = p.comment.user.login
  const action = p.action
  if (p.comment.user.type === 'Bot') return new Response('bot ignored', { status: 200 })

  await updateEventMeta(env, delivery, repo, prNumber, author, action)

  const body: string = p.comment.body || ''
  const triggers = parseTriggers(body)

  if (p.action === 'created' && body && CONFLICT_MENTION_PATTERN.test(body)) {
    await maybeTriggerConflictResolution(env, p).catch((error) => {
      console.error('[WEBHOOK] Failed to trigger conflict resolver workflow', error)
    })
  }

  // Don't exit early - let the DO decide what to do
  const doId = env.PR_WORKFLOWS.idFromName(`${repo}#${prNumber}`)
  const stub = env.PR_WORKFLOWS.get(doId)

  const res = await stub.fetch('https://do/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'issue_comment',
      delivery,
      repo,
      prNumber,
      // For issue comments on PRs, we need to fetch PR details or pass what we have
      headRef: p.issue.pull_request?.head?.ref || null,
      headSha: p.issue.pull_request?.head?.sha || null,
      installationId: p.installation?.id,
      author,
      action,
      triggers,
      commentId: p.comment.id
    })
  })
  // Don't consume response body to avoid "Body has already been used" error
  return new Response('issue-comment-processed', { status: res.status })
}

async function maybeTriggerConflictResolution(env: Env, payload: any): Promise<void> {
  if (!env.CONFLICT_RESOLVER) {
    console.warn('[WEBHOOK] Conflict resolver durable object is not configured; skipping merge assistance')
    return
  }

  const repoOwner = payload.repository.owner.login
  const repoName = payload.repository.name
  const prNumber = payload.issue.number
  const commenter = payload.comment.user.login
  const commentId = payload.comment.id

  const alreadyProcessed = await env.DB.prepare(
    'SELECT id FROM merge_operations WHERE trigger_comment_id = ? LIMIT 1',
  )
    .bind(commentId)
    .first()

  if (alreadyProcessed) {
    console.log('[WEBHOOK] Merge conflict resolution already triggered for comment', commentId)
    return
  }

  const recentlyTriggered = await hasRecentMergeOperation(env, repoOwner, repoName, prNumber)
  if (recentlyTriggered) {
    console.log('[WEBHOOK] Merge conflict resolution deduplicated for PR', { repoOwner, repoName, prNumber })
    return
  }

  const githubClient = await getGitHubClientForEvent(env, payload.installation?.id)
  const hasAccess = await checkUserHasPushAccess(githubClient, repoOwner, repoName, commenter)
  if (!hasAccess) {
    await postPRComment(
      githubClient,
      repoOwner,
      repoName,
      prNumber,
      "❌ You don't have push access to this branch. Ask a maintainer to trigger me instead.",
    )
    return
  }

  const branchDetails = await getPRBranchDetails(githubClient, repoOwner, repoName, prNumber)

  const operationId = generateOperationId()
  const projectRow = await env.DB.prepare(
    'SELECT repo_id FROM projects WHERE full_name = ? LIMIT 1',
  )
    .bind(`${repoOwner}/${repoName}`)
    .first()

  await env.DB.prepare(
    `INSERT INTO merge_operations (id, pr_id, pr_number, repo, repo_owner, triggered_by, trigger_comment_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
  )
    .bind(
      operationId,
      projectRow?.repo_id ?? null,
      prNumber,
      repoName,
      repoOwner,
      commenter,
      commentId,
    )
    .run()

  const trigger: MergeConflictTrigger = {
    owner: repoOwner,
    repo: repoName,
    prNumber,
    prTitle: payload.issue.title ?? '',
    prDescription: payload.issue.body ?? '',
    triggeredBy: commenter,
    commentId,
    commentBody: payload.comment.body ?? '',
    headBranch: branchDetails.headBranch,
    baseBranch: branchDetails.baseBranch,
    repoUrl: payload.repository.html_url ?? '',
    cloneUrl: payload.repository.clone_url ?? payload.repository.git_url ?? '',
  }

  const resolverId = env.CONFLICT_RESOLVER.idFromName(`${repoOwner}/${repoName}/${prNumber}`)
  const resolver = env.CONFLICT_RESOLVER.get(resolverId)
  await resolver.fetch('https://conflict-resolver/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationId, trigger, installationId: payload.installation?.id ?? null }),
  })

  await postPRComment(
    githubClient,
    repoOwner,
    repoName,
    prNumber,
    '🔄 Analyzing merge conflicts... I will share my suggestions shortly.',
  )
}

async function hasRecentMergeOperation(env: Env, owner: string, repo: string, prNumber: number): Promise<boolean> {
  const recent = await env.DB.prepare(
    `SELECT id FROM merge_operations
     WHERE repo_owner = ? AND repo = ? AND pr_number = ?
       AND datetime(created_at) >= datetime('now', '-5 minutes')
     ORDER BY created_at DESC
     LIMIT 1`,
  )
    .bind(owner, repo, prNumber)
    .first()

  return Boolean(recent)
}

async function getGitHubClientForEvent(env: Env, installationId?: number | null): Promise<GitHubClient> {
  if (installationId) {
    return createInstallationClient(env, installationId)
  }

  if (env.GITHUB_TOKEN) {
    return new GitHubClient({ personalAccessToken: env.GITHUB_TOKEN, env })
  }

  throw new Error('GitHub credentials are required to trigger conflict resolution')
}

function generateOperationId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)
}

/**
 * Processes a pull request event.
 * Handles specific actions such as opening, closing, or labeling a pull request and forwards the event to a Durable Object.
 *
 * @param env - The environment bindings, including database and Durable Object namespace.
 * @param delivery - The unique delivery ID of the webhook event.
 * @param p - The parsed payload of the webhook event.
 * @param startTime - The start time for processing tracking.
 * @returns A Response object indicating the result of the processing.
 */
async function onPullRequest(env: Env, delivery: string, p: any, startTime: number) {
  const repo = `${p.repository.owner.login}/${p.repository.name}`
  const prNumber = p.number
  const author = p.sender?.login || 'system'
  const action = p.action

  await updateEventMeta(env, delivery, repo, prNumber, author, action)

  const interesting = new Set([
    'opened', 'reopened', 'ready_for_review', 'synchronize', 'labeled', 'unlabeled', 'closed'
  ])
  if (!interesting.has(action)) return new Response('ignored', { status: 200 })

  const doId = env.PR_WORKFLOWS.idFromName(`${repo}#${prNumber}`)
  const stub = env.PR_WORKFLOWS.get(doId)

  const res = await stub.fetch('https://do/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'pull_request',
      delivery,
      repo,
      prNumber,
      headRef: p.pull_request?.head?.ref,
      headSha: p.pull_request?.head?.sha,
      installationId: p.installation?.id,
      author,
      action,
      labels: p.pull_request?.labels?.map((l: any) => l.name) || []
    })
  })
  // Don't consume response body to avoid "Body has already been used" error
  return new Response('pull-request-processed', { status: res.status })
}

/**
 * Processes a repository creation event.
 * Automatically creates LLMs documentation if the repository contains wrangler files.
 *
 * @param env - The environment bindings, including database and Durable Object namespace.
 * @param delivery - The unique delivery ID of the webhook event.
 * @param p - The parsed payload of the webhook event.
 * @param startTime - The start time for processing tracking.
 * @returns A Response object indicating the result of the processing.
 */
async function onRepositoryCreated(env: Env, delivery: string, p: any, startTime: number) {
  const repo = `${p.repository.owner.login}/${p.repository.name}`
  const author = p.sender?.login || 'system'
  const action = p.action;

  await updateEventMeta(env, delivery, repo, null, author, action);

  console.log('[WEBHOOK] Repository created:', {
    repo,
    author,
    action,
    repositoryId: p.repository.id,
    repositoryName: p.repository.name,
    owner: p.repository.owner.login
  })

  // Check and setup MCP tools for the repository
  await handleMcpToolsForRepo(env.DB, repo, 'repository_created')

  // Trigger automated repository setup tasks
  triggerRepositorySetup(env, repo, p.repository.owner.login, p.repository.default_branch, p.installation?.id, 'repository_created').catch((error) => {
    console.error('[WEBHOOK] Repository setup trigger failed', error)
  })

  // Check if this is a new repository and trigger research sweep
  const isNew = await isNewRepository(env, repo)
  if (isNew) {
    console.log('[WEBHOOK] New repository detected, triggering research sweep:', repo)
    // Trigger research sweep asynchronously (don't wait for it)
    triggerResearchSweep(env, repo).catch(error => {
      console.error('[WEBHOOK] Failed to trigger research sweep for new repository:', repo, error)
    })
  } else {
    console.log('[WEBHOOK] Repository already exists in projects table, skipping research sweep:', repo)
  }

  // Check if repository contains wrangler files (indicating it's a Cloudflare project)
  const [owner, repoName] = repo.split('/')

  const authToken = env.GITHUB_TOKEN
  if (!authToken) {
    console.warn('[WEBHOOK] Missing GitHub token to inspect repository contents for wrangler files')
    return new Response('repository-created-missing-token', { status: 202 })
  }

  try {
    let hasWranglerFile = false
    try {
      await ghREST(authToken, 'GET', `/repos/${owner}/${repoName}/contents/wrangler.jsonc`)
      hasWranglerFile = true
      console.log('[WEBHOOK] Found wrangler.jsonc in new repository')
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) {
        console.log('[WEBHOOK] wrangler.jsonc not found, checking for wrangler.toml')
      } else {
        throw error
      }
    }

    if (!hasWranglerFile) {
      try {
        await ghREST(authToken, 'GET', `/repos/${owner}/${repoName}/contents/wrangler.toml`)
        hasWranglerFile = true
        console.log('[WEBHOOK] Found wrangler.toml in new repository')
      } catch (error) {
        if (error instanceof GitHubHttpError && error.status === 404) {
          console.log('[WEBHOOK] wrangler.toml not found either')
        } else {
          throw error
        }
      }
    }

    if (hasWranglerFile) {
      console.log('[WEBHOOK] Cloudflare repository detected, triggering LLMs documentation and worker optimization')

      const syntheticEvent = {
        kind: 'repository_created',
        delivery,
        repo,
        author,
        installationId: p.installation?.id,
        prNumber: null,
        filePath: null,
        line: null,
        side: null,
        diffHunk: null,
        headRef: null,
        headSha: null
      }

      const doId = env.PR_WORKFLOWS.idFromName(`repo-${repo}`)
      const stub = env.PR_WORKFLOWS.get(doId)

      await stub.fetch('https://do/create-llms-docs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(syntheticEvent)
      })

      await stub.fetch('https://do/optimize-worker', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(syntheticEvent)
      })

      console.log('[WEBHOOK] LLMs documentation and worker optimization triggered for new Cloudflare repository')
      return new Response('repository-created-optimized', { status: 200 })
    }

    console.log('[WEBHOOK] Repository created but no wrangler files found, skipping LLMs docs creation')
    return new Response('repository-created-no-wrangler', { status: 200 })
  } catch (error: any) {
    console.log('[WEBHOOK] Error processing repository creation:', error)
    return new Response('repository-created-error', { status: 500 })
  }
}

// ---------- helpers ----------

async function recordWebhookDetails(
  env: Env,
  webhookEventId: number,
  eventType: string,
  payload: any,
  associatedNumber: number | null
) {
  try {
    switch (eventType) {
      case 'pull_request': {
        const pr = payload.pull_request
        if (!pr) return

        await env.DB.prepare(
          `INSERT INTO pull_request_details (
            webhook_event_id, pr_github_id, pr_number, pr_title, pr_state, pr_merged,
            pr_created_at, pr_updated_at, pr_closed_at, pr_merged_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(pr_github_id) DO UPDATE SET
            webhook_event_id=excluded.webhook_event_id,
            pr_number=excluded.pr_number,
            pr_title=excluded.pr_title,
            pr_state=excluded.pr_state,
            pr_merged=excluded.pr_merged,
            pr_created_at=excluded.pr_created_at,
            pr_updated_at=excluded.pr_updated_at,
            pr_closed_at=excluded.pr_closed_at,
            pr_merged_at=excluded.pr_merged_at`
        )
          .bind(
            webhookEventId,
            pr.id,
            pr.number,
            pr.title,
            pr.state,
            pr.merged ? 1 : 0,
            pr.created_at,
            pr.updated_at,
            pr.closed_at,
            pr.merged_at
          )
          .run()
        break
      }
      case 'pull_request_review': {
        const review = payload.review
        const prNumber =
          typeof associatedNumber === 'number'
            ? associatedNumber
            : typeof payload.pull_request?.number === 'number'
            ? payload.pull_request.number
            : null

        if (!review || typeof prNumber !== 'number') return

        await env.DB.prepare(
          `INSERT INTO pull_request_review_details (
            webhook_event_id, review_github_id, pr_number, review_state, submitted_at, review_body
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(review_github_id) DO UPDATE SET
            webhook_event_id=excluded.webhook_event_id,
            pr_number=excluded.pr_number,
            review_state=excluded.review_state,
            submitted_at=excluded.submitted_at,
            review_body=excluded.review_body`
        )
          .bind(
            webhookEventId,
            review.id,
            prNumber,
            review.state,
            review.submitted_at,
            review.body
          )
          .run()
        break
      }
      case 'issue_comment':
      case 'pull_request_review_comment': {
        const comment = payload.comment
        const issueNumber =
          typeof associatedNumber === 'number'
            ? associatedNumber
            : typeof payload.issue?.number === 'number'
            ? payload.issue.number
            : typeof payload.pull_request?.number === 'number'
            ? payload.pull_request.number
            : null

        if (!comment || typeof issueNumber !== 'number') return

        const commentType = eventType === 'issue_comment' ? 'issue' : 'pull_request_review'

        await env.DB.prepare(
          `INSERT INTO comment_details (
            webhook_event_id, comment_github_id, issue_number, comment_type, comment_body, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(comment_github_id) DO UPDATE SET
            webhook_event_id=excluded.webhook_event_id,
            issue_number=excluded.issue_number,
            comment_type=excluded.comment_type,
            comment_body=excluded.comment_body,
            created_at=excluded.created_at,
            updated_at=excluded.updated_at`
        )
          .bind(
            webhookEventId,
            comment.id,
            issueNumber,
            commentType,
            comment.body,
            comment.created_at,
            comment.updated_at
          )
          .run()
        break
      }
      default:
        break
    }
  } catch (error) {
    console.error(`[WEBHOOK] Failed to record detailed data for webhook ${webhookEventId}:`, error)
  }
}

/**
 * Updates metadata for a GitHub event in the database.
 *
 * @param env - The environment bindings, including the database.
 * @param delivery - The unique delivery ID of the webhook event.
 * @param repo - The repository name in the format "owner/repo".
 * @param pr - The pull request or issue number associated with the event.
 * @param author - The author of the event.
 * @param action - The action performed in the event.
 */
async function updateEventMeta(
  env: Env,
  delivery: string,
  repo: string,
  pr: number | null,
  author: string | null,
  action: string | null
) {
  await env.DB.prepare(
    `UPDATE github_webhook_events SET repo_full_name=?, associated_number=?, author_login=?, action=? WHERE delivery_id=?`
  ).bind(repo, pr, author ?? null, action ?? null, delivery).run()
}

/**
 * Extracts code suggestions from a text body.
 *
 * @param text - The text body containing potential code suggestions.
 * @returns An array of code suggestions extracted from the text.
 */
export function extractSuggestions(text: string): string[] {
  const out: string[] = []
  const re = /```suggestion\s*\n([\s\S]*?)```/g
  let m
  while ((m = re.exec(text)) !== null) out.push(m[1])
  return out
}

/**
 * Parses trigger commands from a text body.
 *
 * @param text - The text body containing potential trigger commands.
 * @returns An array of trigger commands extracted from the text.
 */
export function parseTriggers(text: string): string[] {
  const out: string[] = []

  // Original commands
  const originalRe = /^\s*\/(apply|fix|summarize|lint|test)\b.*$/gmi
  let m
  while ((m = originalRe.exec(text)) !== null) out.push(m[0].trim())

  // Colby commands
  const colbyRe = /^\s*\/colby\s+(implement|create\s+issue(?:\s+and\s+assign\s+to\s+copilot)?|bookmark\s+this\s+suggestion|extract\s+suggestions|help|configure\s+agent|provide\s+\w+\s+guidance|provide\s+guidance|llm-full)\b.*$/gmi
  while ((m = colbyRe.exec(text)) !== null) out.push(m[0].trim())

  return out
}
