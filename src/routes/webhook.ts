// src/routes/webhook.ts
import { verify as verifySignature } from '@octokit/webhooks-methods'

type Env = {
  DB: D1Database
  GITHUB_WEBHOOK_SECRET: string
  PR_WORKFLOWS: DurableObjectNamespace
  RESEARCH_ORCH?: DurableObjectNamespace
  AI?: any
}

type WebhookData = {
  delivery: string
  event: string
  signature: string
  bodyText: string
  headers: Record<string, string>
}

/**
 * Checks if a duplicate delivery should be allowed to reprocess
 */
async function checkRecentDuplicate(env: Env, delivery: string, isCommentEvent: boolean): Promise<boolean> {
  try {
    // For comment events, allow reprocessing if it's been more than 5 minutes
    // For other events, be more strict (30 minutes)
    const timeThreshold = isCommentEvent ? 5 * 60 * 1000 : 30 * 60 * 1000
    const cutoffTime = Date.now() - timeThreshold
    
    const result = await env.DB.prepare(
      'SELECT created_at FROM gh_events WHERE delivery_id = ?'
    ).bind(delivery).first()
    
    if (!result) {
      return false // No existing record, allow processing
    }
    
    const lastProcessed = result.created_at as number
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
async function isNewRepository(env: Env, repo: string): Promise<boolean> {
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

  // Idempotency: check if we've seen this delivery recently
  console.log('[WEBHOOK] Checking for duplicate delivery:', delivery)
  try {
    // First, try to insert the event
    await env.DB.prepare(
      'INSERT INTO gh_events (delivery_id, event, repo, pr_number, author, action, created_at, payload_json) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(delivery, event, '-', null, '-', '-', startTime, bodyText).run()
    console.log('[WEBHOOK] Event recorded in database')
  } catch (dbError) {
    // Check if this is a comment event that we should allow reprocessing
    const isCommentEvent = event === 'pull_request_review_comment' || event === 'issue_comment'
    const isRecentDuplicate = await checkRecentDuplicate(env, delivery, isCommentEvent)
    
    if (isRecentDuplicate) {
      console.log('[WEBHOOK] Recent duplicate delivery detected, allowing reprocessing:', delivery)
      // Update the existing record with new timestamp and payload
      await env.DB.prepare(
        'UPDATE gh_events SET created_at = ?, payload_json = ? WHERE delivery_id = ?'
      ).bind(startTime, bodyText, delivery).run()
    } else {
      console.log('[WEBHOOK] Duplicate delivery detected:', delivery)
      return new Response('duplicate', { status: 200 })
    }
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
        fullPayload: payload,
        commentBody: commentBody,
        repo: payload.repository?.full_name,
        prNumber: payload.pull_request?.number,
        issueNumber: payload.issue?.number,
        author: payload.comment?.user?.login || payload.review?.user?.login,
        commentId: payload.comment?.id || payload.review?.id,
        isReviewComment: event === 'pull_request_review_comment',
        hasColbyCommand: commentBody.includes('/colby')
      }
      
      console.log('[WEBHOOK] AI context (full payload):', {
        event,
        action: payload.action,
        repo: payload.repository?.full_name,
        prNumber: payload.pull_request?.number,
        commentId: payload.comment?.id || payload.review?.id,
        hasColbyCommand: commentBody.includes('/colby'),
        payloadSize: JSON.stringify(payload).length
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
    } else if (event === 'issues' && payload.action === 'opened') {
      console.log('[WEBHOOK] Handling issues event')
      response = await onIssueOpened(env, delivery, payload, startTime)
    } else if (event === 'issue_comment' && payload.issue?.pull_request) {
      console.log('[WEBHOOK] Handling issue_comment on PR')
      response = await onIssueComment(env, delivery, payload, startTime)
    } else if (event === 'pull_request') {
      console.log('[WEBHOOK] Handling pull_request event')
      response = await onPullRequest(env, delivery, payload, startTime)
    } else if (event === 'repository' && payload.action === 'created') {
      console.log('[WEBHOOK] Handling repository creation')
      response = await onRepositoryCreated(env, delivery, payload, startTime)
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

  // Check if this is a new repository and trigger research sweep
  const isNew = await isNewRepository(env, repo)
  if (isNew) {
    console.log('[WEBHOOK] New repository detected in review comment, triggering research sweep:', repo)
    // Trigger research sweep asynchronously (don't wait for it)
    triggerResearchSweep(env, repo).catch(error => {
      console.error('[WEBHOOK] Failed to trigger research sweep for new repository:', repo, error)
    })
  }

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
 * Processes an issues opened event.
 * Extracts triggers from the issue body and forwards the event to a Durable Object.
 *
 * @param env - The environment bindings, including database and Durable Object namespace.
 * @param delivery - The unique delivery ID of the webhook event.
 * @param p - The parsed payload of the webhook event.
 * @param startTime - The start time for processing tracking.
 * @returns A Response object indicating the result of the processing.
 */
async function onIssueOpened(env: Env, delivery: string, p: any, startTime: number) {
  const repo = `${p.repository.owner.login}/${p.repository.name}`
  const issueNumber = p.issue.number
  const author = p.issue.user.login
  const action = p.action
  if (p.issue.user.type === 'Bot') return new Response('bot ignored', { status: 200 })

  await updateEventMeta(env, delivery, repo, null, author, action)

  const body: string = p.issue.body || ''
  const suggestions = extractSuggestions(body)
  const triggers = parseTriggers(body)

  console.log('[WEBHOOK] Issue opened processing details:', {
    repo,
    issueNumber,
    author,
    action,
    hasBody: !!body,
    bodyLength: body.length,
    bodyPreview: body.substring(0, 100),
    suggestionsCount: suggestions.length,
    triggersCount: triggers.length,
    triggers: triggers,
    installationId: p.installation?.id
  })

  // Don't exit early - let the DO decide what to do
  const doId = env.PR_WORKFLOWS.idFromName(`${repo}#${issueNumber}`)
  const stub = env.PR_WORKFLOWS.get(doId)

  const res = await stub.fetch('https://do/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'issue_opened',
      delivery,
      repo,
      prNumber: null, // No PR number for issues
      issueNumber,
      headRef: p.repository.default_branch,
      headSha: null, // Issues don't have headSha like PRs
      installationId: p.installation?.id,
      author,
      action,
      suggestions,
      triggers,
      // For issues, we don't have a specific commentId
      commentId: null
    })
  })
  // Don't consume response body to avoid "Body has already been used" error
  return new Response('issue-opened-processed', { status: res.status })
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
  
  console.log('[WEBHOOK] onIssueComment called:', {
    repo,
    prNumber,
    author,
    action,
    commentId: p.comment.id,
    isBot: p.comment.user.type === 'Bot',
    hasPullRequest: !!p.issue.pull_request,
    bodyPreview: p.comment.body?.substring(0, 100)
  })
  
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

  // Check if this is a new repository and trigger research sweep
  const isNew = await isNewRepository(env, repo)
  if (isNew) {
    console.log('[WEBHOOK] New repository detected in PR event, triggering research sweep:', repo)
    // Trigger research sweep asynchronously (don't wait for it)
    triggerResearchSweep(env, repo).catch(error => {
      console.error('[WEBHOOK] Failed to trigger research sweep for new repository:', repo, error)
    })
  }

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

  try {
    // Check for wrangler.jsonc first
    let hasWranglerFile = false
    try {
      const wranglerJsonc = await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/wrangler.jsonc`, {
        headers: {
          'Authorization': `token ${env.GITHUB_WEBHOOK_SECRET}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'Colby-GitHub-Bot/1.0'
        }
      })
      if (wranglerJsonc.ok) {
        hasWranglerFile = true
        console.log('[WEBHOOK] Found wrangler.jsonc in new repository')
      }
    } catch (error) {
      console.log('[WEBHOOK] wrangler.jsonc not found, checking for wrangler.toml')
    }

    // If no wrangler.jsonc, check for wrangler.toml
    if (!hasWranglerFile) {
      try {
        const wranglerToml = await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/wrangler.toml`, {
          headers: {
            'Authorization': `token ${env.GITHUB_WEBHOOK_SECRET}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'Colby-GitHub-Bot/1.0'
          }
        })
        if (wranglerToml.ok) {
          hasWranglerFile = true
          console.log('[WEBHOOK] Found wrangler.toml in new repository')
        }
      } catch (error) {
        console.log('[WEBHOOK] wrangler.toml not found either')
      }
    }

    if (hasWranglerFile) {
      console.log('[WEBHOOK] Cloudflare repository detected, triggering LLMs documentation and worker optimization')

      // Create a synthetic event to trigger LLMs documentation creation
      const syntheticEvent = {
        kind: 'repository_created',
        delivery,
        repo,
        author,
        installationId: p.installation?.id,
        // Add other necessary fields for the LLMs docs creation
        prNumber: null,
        filePath: null,
        line: null,
        side: null,
        diffHunk: null,
        headRef: null,
        headSha: null
      }

      // Get the PR_WORKFLOWS durable object and trigger LLMs docs creation
      const doId = env.PR_WORKFLOWS.idFromName(`repo-${repo}`)
      const stub = env.PR_WORKFLOWS.get(doId)

      // Trigger LLMs documentation creation
      const llmsRes = await stub.fetch('https://do/create-llms-docs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(syntheticEvent)
      })

      // Also trigger worker optimization
      const optimizeRes = await stub.fetch('https://do/optimize-worker', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(syntheticEvent)
      })

      console.log('[WEBHOOK] LLMs documentation and worker optimization triggered for new Cloudflare repository')
      return new Response('repository-created-optimized', { status: 200 })
    } else {
      console.log('[WEBHOOK] Repository created but no wrangler files found, skipping LLMs docs creation')
      return new Response('repository-created-no-wrangler', { status: 200 })
    }

  } catch (error: any) {
    console.log('[WEBHOOK] Error processing repository creation:', error)
    return new Response('repository-created-error', { status: 500 })
  }
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
  pr: number | null,
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
  
  // Pattern 1: Standard ```suggestion blocks
  const suggestionRe = /```suggestion\s*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = suggestionRe.exec(text)) !== null) {
    out.push(m[1])
  }
  
  // Pattern 2: Gemini CLI format - ```typescript or ```javascript blocks with suggestions
  const codeBlockRe = /```(?:typescript|javascript|ts|js|python|py|java|cpp|c|go|rust|php|ruby|swift|kotlin|scala|r|sql|html|css|json|yaml|xml|markdown|md|bash|sh|powershell|ps1|dockerfile|docker|yaml|yml|toml|ini|conf|config|txt|text|plain|diff|patch)\s*\n([\s\S]*?)```/g
  while ((m = codeBlockRe.exec(text)) !== null) {
    const code = m[1].trim()
    // Only include if it looks like a suggestion (not just a code example)
    if (code.length > 10 && !code.includes('// Example') && !code.includes('// Sample')) {
      out.push(code)
    }
  }
  
  // Pattern 3: Lines starting with + (diff-style suggestions)
  const diffRe = /^\+.*$/gm
  const diffMatches = text.match(diffRe)
  if (diffMatches && diffMatches.length > 0) {
    const diffSuggestion = diffMatches.map(line => line.substring(1)).join('\n')
    if (diffSuggestion.trim().length > 0) {
      out.push(diffSuggestion.trim())
    }
  }
  
  // Pattern 4: AI Code Assist suggestions (specific format from Gemini/Codex)
  // Look for code blocks that are clearly suggestions, not just examples
  const aiSuggestionRe = /```(?:typescript|javascript|ts|js|python|py|java|cpp|c|go|rust|php|ruby|swift|kotlin|scala|r|sql|html|css|json|yaml|xml|markdown|md|bash|sh|powershell|ps1|dockerfile|docker|yaml|yml|toml|ini|conf|config|txt|text|plain|diff|patch)\s*\n([\s\S]*?)```/g
  let aiMatch: RegExpExecArray | null
  while ((aiMatch = aiSuggestionRe.exec(text)) !== null) {
    const code = aiMatch[1].trim()
    // More aggressive detection for AI suggestions
    if (code.length > 5 && 
        (code.includes('function') || code.includes('const') || code.includes('let') || code.includes('var') || 
         code.includes('class') || code.includes('interface') || code.includes('type') || 
         code.includes('import') || code.includes('export') || code.includes('return') ||
         code.includes('if') || code.includes('for') || code.includes('while') ||
         code.includes('{') || code.includes('}') || code.includes('(') || code.includes(')') ||
         code.includes('=') || code.includes('=>') || code.includes(';'))) {
      out.push(code)
    }
  }
  
  // Pattern 5: Inline code suggestions (backticks with code)
  const inlineCodeRe = /`([^`\n]{10,})`/g
  while ((m = inlineCodeRe.exec(text)) !== null) {
    const code = m[1].trim()
    if (code.length > 10 && 
        (code.includes('function') || code.includes('const') || code.includes('let') || code.includes('var') || 
         code.includes('class') || code.includes('interface') || code.includes('type') || 
         code.includes('import') || code.includes('export') || code.includes('return') ||
         code.includes('if') || code.includes('for') || code.includes('while') ||
         code.includes('{') || code.includes('}') || code.includes('(') || code.includes(')') ||
         code.includes('=') || code.includes('=>') || code.includes(';'))) {
      out.push(code)
    }
  }
  
  // Pattern 6: Lines that look like code suggestions (indented or with specific keywords)
  const suggestionKeywords = ['suggest', 'recommend', 'propose', 'improve', 'fix', 'update', 'change', 'modify', 'should', 'could', 'would']
  const lines = text.split('\n')
  let currentSuggestion = ''
  let inSuggestion = false
  
  for (const line of lines) {
    const lowerLine = line.toLowerCase()
    if (suggestionKeywords.some(keyword => lowerLine.includes(keyword)) && 
        (line.includes('```') || line.trim().startsWith('function') || line.trim().startsWith('const') || line.trim().startsWith('let') || line.trim().startsWith('var'))) {
      inSuggestion = true
      currentSuggestion = line
    } else if (inSuggestion && (line.trim() === '' || line.startsWith(' ') || line.startsWith('\t') || line.includes('```'))) {
      if (line.includes('```')) {
        inSuggestion = false
        if (currentSuggestion.trim().length > 0) {
          out.push(currentSuggestion.trim())
          currentSuggestion = ''
        }
      } else {
        currentSuggestion += '\n' + line
      }
    } else if (inSuggestion && line.trim() !== '') {
      currentSuggestion += '\n' + line
    }
  }
  
  // Add any remaining suggestion
  if (currentSuggestion.trim().length > 0) {
    out.push(currentSuggestion.trim())
  }
  
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
  const colbyRe = /^\s*\/colby\s+(implement|create\s+issue(?:\s+and\s+assign\s+to\s+copilot)?|bookmark\s+this\s+suggestion|extract\s+suggestions(?:\s+to\s+issues?)?|help|configure\s+agent|provide\s+\w+\s+guidance|provide\s+guidance|llm-full|resolve\s+conflicts?|clear\s+conflicts?|create\s+llms?\s+docs?|fetch\s+llms?\s+docs?|optimize\s+worker|setup\s+worker)\b.*$/gmi
  while ((m = colbyRe.exec(text)) !== null) out.push(m[0].trim())

  return out
}
