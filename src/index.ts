import { Hono } from 'hono'
import { handleWebhook } from './routes/webhook'

type Env = {
  DB: D1Database
  GITHUB_WEBHOOK_SECRET: string
  PR_WORKFLOWS: DurableObjectNamespace
  REPO_SETUP: DurableObjectNamespace
  RESEARCH_ORCH?: DurableObjectNamespace
  AI?: unknown
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

type TaskAssetCollection = {
  screenshots: unknown[]
  content: unknown[]
  text: unknown[]
  json: unknown[]
  console: unknown[]
  websocket: unknown[]
  other: unknown[]
}

type TaskField = { label: string; value: unknown }

type TaskEntry = {
  eventType: string
  repo: string | null
  prNumber: number | null
  deliveryId: string
  action: string | null
  author: string | null
  receivedAt: string
  status: string | null
  title: string | null
  fields: TaskField[]
  trimmedPayload: Record<string, unknown>
  jsonSchema: Record<string, unknown>
  assets: TaskAssetCollection
}

type TaskGroup = {
  eventType: string
  repo: string | null
  prNumber: number | null
  author: string | null
  latestTimestamp: number | null
  tasks: TaskEntry[]
}

type WebhookEventRow = {
  id: number
  delivery_id: string
  event_type: string
  action: string | null
  repo_full_name: string | null
  author_login: string | null
  associated_number: number | null
  received_at: string
  full_payload_json: string
  response_status: string | null
  response_message: string | null
  processing_time_ms: number | null
  error_details: string | null
}

const app = new Hono<{ Bindings: Env }>({ strict: false })

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
}

app.use('*', async (c, next) => {
  await next()

  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    c.res.headers.set(key, value)
  }

  if (!c.res.headers.get('Content-Type')) {
    c.res.headers.set('Content-Type', 'application/json')
  }
})

app.options('*', () =>
  new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json'
    }
  })
)

app.get('/health', async (c) => {
  const { getLatestTestResult } = await import('./modules/test_runner')
  const latestTest = await getLatestTestResult(c.env)
  
  if (!latestTest) {
    return c.json({ 
      ok: true, 
      status: 'healthy',
      message: 'No test results available yet',
      timestamp: new Date().toISOString()
    })
  }

  const isHealthy = latestTest.status === 'passed' && latestTest.failedTests === 0
  const healthStatus = isHealthy ? 'healthy' : latestTest.status === 'failed' ? 'degraded' : 'unhealthy'

  return c.json({
    ok: isHealthy,
    status: healthStatus,
    testResults: {
      suite: latestTest.testSuite,
      totalTests: latestTest.totalTests,
      passedTests: latestTest.passedTests,
      failedTests: latestTest.failedTests,
      skippedTests: latestTest.skippedTests,
      durationMs: latestTest.durationMs,
      status: latestTest.status,
      triggeredBy: latestTest.triggeredBy,
      createdAt: latestTest.testDetails ? new Date().toISOString() : undefined,
    },
    timestamp: new Date().toISOString()
  })
})

app.get('/api/health', async (c) => {
  const { getLatestTestResult } = await import('./modules/test_runner')
  const latestTest = await getLatestTestResult(c.env)
  
  if (!latestTest) {
    return c.json({ 
      status: 'healthy', 
      message: 'No test results available yet',
      timestamp: new Date().toISOString() 
    })
  }

  const isHealthy = latestTest.status === 'passed' && latestTest.failedTests === 0
  const healthStatus = isHealthy ? 'healthy' : latestTest.status === 'failed' ? 'degraded' : 'unhealthy'

  return c.json({ 
    status: healthStatus,
    testResults: {
      suite: latestTest.testSuite,
      totalTests: latestTest.totalTests,
      passedTests: latestTest.passedTests,
      failedTests: latestTest.failedTests,
      skippedTests: latestTest.skippedTests,
      durationMs: latestTest.durationMs,
      status: latestTest.status,
      triggeredBy: latestTest.triggeredBy,
    },
    timestamp: new Date().toISOString() 
  })
})

app.get('/api/status', async (c) => {
  const stats = await fetchStats(c.env)
  return c.json({ status: 'ok', timestamp: new Date().toISOString(), stats })
})

app.get('/api/stats', async (c) => c.json(await fetchStats(c.env)))

app.get('/api/research/status', async (c) => {
  if (!c.env.RESEARCH_ORCH) {
    return c.json(
      {
        status: 'error',
        progress: 0,
        current_operation: 'Research orchestrator unavailable'
      },
      500
    )
  }

  try {
    const stub = c.env.RESEARCH_ORCH.get(c.env.RESEARCH_ORCH.idFromName('global'))
    const res = await stub.fetch('https://do/status')

    if (!res.ok) {
      return c.json(
        {
          status: 'error',
          progress: 0,
          current_operation: `${res.status} ${res.statusText}`
        },
        res.status as 500
      )
    }

    const data = (await res.json()) as Record<string, unknown>
    return c.json({
      status: (data.status as string) ?? 'idle',
      progress: (data.progress as number | undefined) ?? 0,
      current_operation: (data.current_operation as string) ?? ''
    })
  } catch (error) {
    console.error('[API] Failed to fetch research status', error)
    return c.json(
      {
        status: 'error',
        progress: 0,
        current_operation: 'Failed to fetch status'
      },
      500
    )
  }
})

app.get('/api/operations', async (c) => {
  const operations = await fetchMergeOperations(c.env)
  return c.json({ operations })
})

app.get('/api/recent-activity', async (c) => {
  const limitParam = c.req.query('limit')
  const limit = Number.parseInt(limitParam ?? '', 10)
  const groups = await fetchRecentActivity(c.env, Number.isFinite(limit) && limit > 0 ? limit : 50)
  return c.json({ activity: groups })
})

app.post('/github/webhook', async (c) => {
  const delivery = c.req.header('x-github-delivery') ?? ''
  const event = c.req.header('x-github-event') ?? ''
  const signature = c.req.header('x-hub-signature-256') ?? ''
  const bodyText = await c.req.text()
  const headers = (c.req.header() ?? {}) as Record<string, string>

  return await handleWebhook(
    {
      delivery,
      event,
      signature,
      bodyText,
      headers
    },
    c.env
  )
})

app.post('/tests/run', async (c) => {
  try {
    const { runWebhookTests, saveTestResults } = await import('./modules/test_runner')
    const triggeredBy = (c.req.query('trigger') as 'cron' | 'manual' | 'api') || 'manual'
    
    console.log(`[TESTS] Running test suite (triggered by: ${triggeredBy})`)
    const result = await runWebhookTests(c.env)
    result.triggeredBy = triggeredBy
    
    const testId = await saveTestResults(c.env, result)
    
    return c.json({
      success: true,
      testId,
      result: {
        suite: result.testSuite,
        totalTests: result.totalTests,
        passedTests: result.passedTests,
        failedTests: result.failedTests,
        skippedTests: result.skippedTests,
        durationMs: result.durationMs,
        status: result.status,
        triggeredBy: result.triggeredBy,
      },
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    console.error('[TESTS] Failed to run tests:', error)
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    }, 500)
  }
})

app.get('/tests/results', async (c) => {
  try {
    const limit = Number.parseInt(c.req.query('limit') || '10', 10)
    const { results } = await c.env.DB.prepare(
      `SELECT 
        id, test_suite, total_tests, passed_tests, failed_tests, skipped_tests,
        duration_ms, status, error_message, triggered_by, created_at
      FROM test_results
      ORDER BY created_at DESC
      LIMIT ?`
    ).bind(limit).all<{
      id: number
      test_suite: string
      total_tests: number
      passed_tests: number
      failed_tests: number
      skipped_tests: number
      duration_ms: number
      status: string
      error_message: string | null
      triggered_by: string
      created_at: string
    }>()

    return c.json({
      results: (results || []).map((row) => ({
        id: row.id,
        suite: row.test_suite,
        totalTests: row.total_tests,
        passedTests: row.passed_tests,
        failedTests: row.failed_tests,
        skippedTests: row.skipped_tests,
        durationMs: row.duration_ms,
        status: row.status,
        errorMessage: row.error_message,
        triggeredBy: row.triggered_by,
        createdAt: row.created_at,
      })),
      count: results?.length || 0
    })
  } catch (error) {
    console.error('[TESTS] Failed to get test results:', error)
    return c.json({
      error: error instanceof Error ? error.message : String(error)
    }, 500)
  }
})

app.notFound((c) => c.json({ error: 'Not Found' }, 404))

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx)
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Handle cron triggers
    if (event.cron === '0 2 * * *') {
      // Daily at 2 AM - run tests
      console.log('[CRON] Running daily test suite')
      try {
        const { runWebhookTests, saveTestResults } = await import('./modules/test_runner')
        const result = await runWebhookTests(env)
        result.triggeredBy = 'cron'
        await saveTestResults(env, result)
        console.log(`[CRON] Test suite completed: ${result.status} (${result.passedTests}/${result.totalTests} passed)`)
      } catch (error) {
        console.error('[CRON] Failed to run test suite:', error)
      }
    }
  }
}

async function fetchStats(env: Env) {
  const [repoCount, commandCount, practiceCount, analysisCount, operationCount] = await Promise.all([
    queryCount(env, 'SELECT COUNT(*) as count FROM repos'),
    queryCount(env, 'SELECT COUNT(*) as count FROM colby_commands'),
    queryCount(env, 'SELECT COUNT(*) as count FROM best_practices'),
    queryCount(env, 'SELECT COUNT(*) as count FROM repo_analysis'),
    queryCount(env, 'SELECT COUNT(*) as count FROM merge_operations')
  ])

  return {
    projects: repoCount,
    commands: commandCount,
    practices: practiceCount,
    analyses: analysisCount,
    operations: operationCount,
    repositories: repoCount
  }
}

async function fetchMergeOperations(env: Env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, repo, pr_number, status, triggered_by, created_at, completed_at, error_message
         FROM merge_operations
         ORDER BY datetime(created_at) DESC
         LIMIT 25`
    ).all<{
      id: string
      repo: string
      pr_number: number
      status: string
      triggered_by: string
      created_at: string
      completed_at: string | null
      error_message: string | null
    }>()

    return (results ?? []).map((row) => ({
      id: row.id,
      repo: row.repo,
      prNumber: row.pr_number,
      status: row.status,
      triggeredBy: row.triggered_by,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      errorMessage: row.error_message
    }))
  } catch (error) {
    console.warn('[API] Failed to load merge operations', error)
    return []
  }
}

async function fetchRecentActivity(env: Env, limit: number) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, delivery_id, event_type, action, repo_full_name, author_login, associated_number,
              received_at, full_payload_json, response_status, response_message, processing_time_ms, error_details
         FROM github_webhook_events
         ORDER BY datetime(received_at) DESC
         LIMIT ?`
    )
      .bind(limit)
      .all<WebhookEventRow>()

    const rows = (results ?? []) as WebhookEventRow[]
    return groupWebhookEvents(rows)
  } catch (error) {
    console.warn('[API] Failed to load recent activity', error)
    return []
  }
}

async function queryCount(env: Env, sql: string): Promise<number> {
  try {
    const row = await env.DB.prepare(sql).first<{ count: number }>()
    const value = row?.count
    return typeof value === 'number' ? value : Number(value ?? 0)
  } catch (error) {
    console.warn(`[API] Failed to execute count query: ${sql}`, error)
    return 0
  }
}

function safeParseJson<T = unknown>(value: string, fallback: T = [] as unknown as T): T {
  try {
    return JSON.parse(value) as T
  } catch (error) {
    console.warn('[MERGE OPS] Failed to parse JSON column', error)
    return fallback
  }
}

function formatFieldLabel(key: string): string {
  if (!key) return key
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase())
}

function inferJsonSchema(value: unknown, depth = 0): Record<string, unknown> {
  const MAX_DEPTH = 6
  if (depth > MAX_DEPTH) {
    return { type: 'unknown' }
  }
  if (value === null) {
    return { type: 'null' }
  }
  const valueType = typeof value
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
    return { type: valueType }
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { type: 'array', items: { type: 'unknown' } }
    }
    const schemas = value.map((item) => inferJsonSchema(item, depth + 1))
    const serialized = new Set(schemas.map((schema) => JSON.stringify(schema)))
    if (serialized.size === 1) {
      return { type: 'array', items: schemas[0] }
    }
    return { type: 'array', items: { anyOf: schemas } }
  }
  if (value && valueType === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [key, val] of entries) {
      if (val === undefined) continue
      properties[key] = inferJsonSchema(val, depth + 1)
      required.push(key)
    }
    return {
      type: 'object',
      properties,
      required,
      additionalProperties: false
    }
  }
  return { type: 'unknown' }
}

function extractAssetsFromPayload(payload: unknown): TaskAssetCollection {
  const initial: TaskAssetCollection = {
    screenshots: [],
    content: [],
    text: [],
    json: [],
    console: [],
    websocket: [],
    other: []
  }

  if (!payload || typeof payload !== 'object') {
    return initial
  }

  const visited = new WeakSet<object>()

  const pushAsset = (type: keyof TaskAssetCollection, value: unknown) => {
    if (value === undefined || value === null) return
    initial[type].push(value)
  }

  const normalizedType = (raw: unknown): keyof TaskAssetCollection | null => {
    if (typeof raw !== 'string') return null
    const type = raw.toLowerCase()
    if (type.includes('screenshot')) return 'screenshots'
    if (type.includes('content')) return 'content'
    if (type.includes('text')) return 'text'
    if (type.includes('json')) return 'json'
    if (type.includes('console')) return 'console'
    if (type.includes('ws') || type.includes('websocket')) return 'websocket'
    return null
  }

  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') {
      return
    }
    if (visited.has(value as object)) {
      return
    }
    visited.add(value as object)

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          visit(item)
        } else {
          handleAssetCandidate(item)
        }
      }
      return
    }

    const obj = value as Record<string, unknown>
    if (Array.isArray(obj.assets)) {
      for (const asset of obj.assets as unknown[]) {
        handleAssetCandidate(asset)
      }
    }

    if (obj.metadata && typeof obj.metadata === 'object') {
      visit(obj.metadata)
    }

    for (const nested of Object.values(obj)) {
      if (nested && typeof nested === 'object') {
        visit(nested)
      } else if (nested !== undefined) {
        handleAssetCandidate(nested)
      }
    }
  }

  const handleAssetCandidate = (candidate: unknown) => {
    if (candidate === undefined || candidate === null) return
    if (typeof candidate === 'string') {
      const lowered = candidate.toLowerCase()
      if (lowered.startsWith('http') && lowered.includes('screenshot')) {
        pushAsset('screenshots', candidate)
        return
      }
      pushAsset('text', candidate)
      return
    }
    if (typeof candidate !== 'object') {
      pushAsset('other', candidate)
      return
    }
    if (Array.isArray(candidate)) {
      for (const value of candidate) {
        handleAssetCandidate(value)
      }
      return
    }

    const record = candidate as Record<string, unknown>
    const type = normalizedType(record.type)
    const payloadValue =
      record.value ??
      record.url ??
      record.content ??
      record.data ??
      record.body ??
      record.payload
    if (type) {
      pushAsset(type, payloadValue ?? record)
    } else if (record.console || record.consoleMessages) {
      const messages = Array.isArray(record.console) ? record.console : record.consoleMessages
      if (Array.isArray(messages)) {
        for (const message of messages) {
          pushAsset('console', message)
        }
      }
    } else if (record.logs && Array.isArray(record.logs)) {
      for (const log of record.logs) {
        pushAsset('console', log)
      }
    } else if (record.websocket || record.ws) {
      const wsEntries = Array.isArray(record.websocket) ? record.websocket : record.ws
      if (Array.isArray(wsEntries)) {
        for (const entry of wsEntries) {
          pushAsset('websocket', entry)
        }
      }
    } else if (record.screenshot || record.screenshotUrl) {
      pushAsset('screenshots', record.screenshot ?? record.screenshotUrl)
    } else if (record.json) {
      pushAsset('json', record.json)
    } else {
      initial.other.push(record)
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') {
        visit(value)
      }
    }
  }

  handleAssetCandidate(payload)
  visit(payload)

  return initial
}

function extractRelevantFields(eventType: string, payload: Record<string, unknown>): Record<string, unknown> {
  const repo = payload.repository as Record<string, unknown> | undefined
  const pullRequest = payload.pull_request as Record<string, unknown> | undefined
  const issue = payload.issue as Record<string, unknown> | undefined
  const comment = payload.comment as Record<string, unknown> | undefined
  const review = payload.review as Record<string, unknown> | undefined
  const sender = payload.sender as Record<string, unknown> | undefined

  switch (eventType) {
    case 'pull_request': {
      return {
        title: pullRequest?.title,
        state: pullRequest?.state,
        number: pullRequest?.number,
        author: pullRequest?.user && (pullRequest.user as Record<string, unknown>).login,
        head: pullRequest?.head && (pullRequest.head as Record<string, unknown>).ref,
        base: pullRequest?.base && (pullRequest.base as Record<string, unknown>).ref,
        merged: pullRequest?.merged,
        html_url: pullRequest?.html_url
      }
    }
    case 'pull_request_review': {
      return {
        state: review?.state,
        submitted_at: review?.submitted_at,
        reviewer: review?.user && (review.user as Record<string, unknown>).login,
        body: review?.body,
        pr_number: pullRequest?.number,
        pr_title: pullRequest?.title
      }
    }
    case 'pull_request_review_comment': {
      return {
        path: comment?.path,
        diff_hunk: comment?.diff_hunk,
        body: comment?.body,
        commenter: comment?.user && (comment.user as Record<string, unknown>).login,
        pr_number: pullRequest?.number,
        in_reply_to_id: comment?.in_reply_to_id
      }
    }
    case 'issue_comment': {
      return {
        issue_number: issue?.number,
        issue_title: issue?.title,
        commenter: comment?.user && (comment.user as Record<string, unknown>).login,
        body: comment?.body,
        created_at: comment?.created_at
      }
    }
    case 'issues': {
      return {
        number: issue?.number,
        title: issue?.title,
        state: issue?.state,
        author: issue?.user && (issue.user as Record<string, unknown>).login,
        labels: issue?.labels,
        created_at: issue?.created_at
      }
    }
    default: {
      return {
        action: payload.action,
        repository: repo?.full_name,
        author: sender?.login,
        number: pullRequest?.number ?? issue?.number ?? payload.number,
        title: pullRequest?.title ?? issue?.title ?? payload.subject
      } as Record<string, unknown>
    }
  }
}

function convertFieldsToList(record: Record<string, unknown>): TaskField[] {
  return Object.entries(record).map(([key, value]) => ({ label: formatFieldLabel(key), value }))
}

function transformWebhookRow(row: WebhookEventRow): TaskEntry {
  const payload = safeParseJson<Record<string, unknown>>(row.full_payload_json, {})
  const trimmed = extractRelevantFields(row.event_type, payload)
  const fields = convertFieldsToList(trimmed)
  const schema = inferJsonSchema(trimmed)
  const assets = extractAssetsFromPayload(payload)

  let inferredTitle: string | null = null
  if (typeof trimmed.title === 'string' && trimmed.title.trim().length) {
    inferredTitle = trimmed.title as string
  } else if (typeof trimmed.pr_title === 'string') {
    inferredTitle = trimmed.pr_title as string
  } else if (typeof trimmed.issue_title === 'string') {
    inferredTitle = trimmed.issue_title as string
  }

  return {
    eventType: row.event_type,
    repo: row.repo_full_name ?? null,
    prNumber: row.associated_number ?? null,
    deliveryId: row.delivery_id,
    action: row.action ?? null,
    author: row.author_login ?? null,
    receivedAt: row.received_at,
    status: row.response_status ?? row.response_message ?? null,
    title: inferredTitle,
    fields,
    trimmedPayload: trimmed,
    jsonSchema: schema,
    assets
  }
}

function groupWebhookEvents(rows: WebhookEventRow[]): TaskGroup[] {
  const map = new Map<string, TaskGroup>()

  for (const row of rows) {
    const task = transformWebhookRow(row)
    const key = `${task.eventType}::${task.repo ?? 'unknown'}::${task.prNumber ?? 'none'}`
    let group = map.get(key)
    if (!group) {
      group = {
        eventType: task.eventType,
        repo: task.repo,
        prNumber: task.prNumber,
        author: task.author,
        latestTimestamp: task.receivedAt ? Date.parse(task.receivedAt) : null,
        tasks: []
      }
      map.set(key, group)
    }
    group.tasks.push(task)
    if (task.author) {
      group.author = task.author
    }
    if (task.receivedAt) {
      const ts = Date.parse(task.receivedAt)
      if (!Number.isNaN(ts)) {
        if (!group.latestTimestamp || ts > group.latestTimestamp) {
          group.latestTimestamp = ts
        }
      }
    }
  }

  const groups = Array.from(map.values())
  for (const group of groups) {
    group.tasks.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
  }
  groups.sort((a, b) => (b.latestTimestamp ?? 0) - (a.latestTimestamp ?? 0))
  return groups
}

// Export Durable Object classes
export { RepositoryActor } from './actors/RepositoryActor'
export { PullRequestActor } from './actors/PullRequestActor'
export { ResearchActor } from './actors/ResearchActor'
export { ConflictResolver } from './do_conflict_resolver'
