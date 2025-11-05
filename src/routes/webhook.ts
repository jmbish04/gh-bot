// src/routes/webhook.ts
import { verify as verifySignature } from '@octokit/webhooks-methods'

type Env = {
  DB: D1Database
  GITHUB_WEBHOOK_SECRET: string
  PR_WORKFLOWS: DurableObjectNamespace
}

type WebhookData = {
  delivery: string
  event: string
  signature: string
  bodyText: string
  headers: Record<string, string>
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

  // Idempotency: skip if we've seen this delivery already
  console.log('[WEBHOOK] Checking for duplicate delivery:', delivery)
  try {
    await env.DB.prepare(
      'INSERT INTO gh_events (delivery_id, event, repo, pr_number, author, action, created_at, payload_json) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(delivery, event, '-', null, '-', '-', startTime, bodyText).run()
    console.log('[WEBHOOK] Event recorded in database')
  } catch (dbError) {
    console.log('[WEBHOOK] Duplicate delivery detected:', delivery)
    return new Response('duplicate', { status: 200 })
  }

  // Process event with enhanced logging
  let response: Response
  let responseStatus = 'success'
  let responseMessage = ''
  let errorDetails = ''

  console.log('[WEBHOOK] Processing event type:', event)

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
      UPDATE gh_events
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

// ---------- helpers ----------

/**
 * Updates metadata for a GitHub event in the database.
 *
 * @param env - The environment bindings, including the database.
 * @param delivery - The unique delivery ID of the webhook event.
 * @param repo - The repository name in the format "owner/repo".
 * @param pr - The pull request number associated with the event.
 * @param author - The author of the event.
 * @param action - The action performed in the event.
 */
async function updateEventMeta(
  env: Env,
  delivery: string,
  repo: string,
  pr: number,
  author: string,
  action: string
) {
  await env.DB.prepare(
    `UPDATE gh_events SET repo=?, pr_number=?, author=?, action=? WHERE delivery_id=?`
  ).bind(repo, pr, author, action, delivery).run()
}

/**
 * Extracts code suggestions from a text body.
 *
 * @param text - The text body containing potential code suggestions.
 * @returns An array of code suggestions extracted from the text.
 */
function extractSuggestions(text: string): string[] {
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
function parseTriggers(text: string): string[] {
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
