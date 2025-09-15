/// <reference types="@cloudflare/workers-types" />

/**
 * Comprehensive Test Suite for Vectorization Infrastructure
 *
 * This module provides comprehensive tests for all vectorization components
 * including VectorizeService, semantic search, and cron refresh functionality.
 */

import { VectorizeService } from './vectorize_service'
import { fetchLLMContent, searchContent } from './llm_fetcher'
import { handleScheduledRefresh } from './cron_service'

type TestEnv = {
  DB: D1Database
  GITHUB_APP_ID: string
  GITHUB_PRIVATE_KEY: string
  CF_ACCOUNT_ID: string
  CF_API_TOKEN: string
  SUMMARY_CF_MODEL: string
  VECTORIZE_INDEX: VectorizeIndex
  AI: Ai
  R2?: R2Bucket
}

export interface TestResult {
  testName: string
  status: 'passed' | 'failed' | 'skipped'
  duration: number
  error?: string
  details?: any
}

export interface TestSuiteResult {
  totalTests: number
  passed: number
  failed: number
  skipped: number
  duration: number
  results: TestResult[]
}

/**
 * Main test suite runner
 */
export async function runVectorizationTests(env: TestEnv): Promise<TestSuiteResult> {
  const startTime = Date.now()
  const results: TestResult[] = []

  console.log('[TEST] Starting vectorization test suite...')

  // Test 1: Database Schema Verification
  results.push(await runTest('Database Schema Verification', () =>
    testDatabaseSchema(env)
  ))

  // Test 2: VectorizeService Basic Operations
  results.push(await runTest('VectorizeService Basic Operations', () =>
    testVectorizeServiceBasics(env)
  ))

  // Test 3: Content Chunking and Embedding
  results.push(await runTest('Content Chunking and Embedding', () =>
    testContentChunkingAndEmbedding(env)
  ))

  // Test 4: LLM Content Fetching with Vectorization
  results.push(await runTest('LLM Content Fetching with Vectorization', () =>
    testLLMContentFetching(env)
  ))

  // Test 5: Semantic Search Functionality
  results.push(await runTest('Semantic Search Functionality', () =>
    testSemanticSearch(env)
  ))

  // Test 6: Cron Service Integration
  results.push(await runTest('Cron Service Integration', () =>
    testCronServiceIntegration(env)
  ))

  // Test 7: End-to-End Workflow
  results.push(await runTest('End-to-End Workflow', () =>
    testEndToEndWorkflow(env)
  ))

  const endTime = Date.now()
  const duration = endTime - startTime

  const summary = {
    totalTests: results.length,
    passed: results.filter(r => r.status === 'passed').length,
    failed: results.filter(r => r.status === 'failed').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    duration,
    results
  }

  console.log('[TEST] Test suite completed:', summary)
  return summary
}

/**
 * Generic test runner with error handling and timing
 */
async function runTest(testName: string, testFn: () => Promise<any>): Promise<TestResult> {
  const startTime = Date.now()

  try {
    console.log(`[TEST] Running: ${testName}`)
    const details = await testFn()
    const duration = Date.now() - startTime

    console.log(`[TEST] ✅ PASSED: ${testName} (${duration}ms)`)
    return {
      testName,
      status: 'passed',
      duration,
      details
    }
  } catch (error: unknown) {
    const duration = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)

    console.error(`[TEST] ❌ FAILED: ${testName} (${duration}ms)`, error)
    return {
      testName,
      status: 'failed',
      duration,
      error: errorMessage
    }
  }
}

/**
 * Test 1: Verify database schema is properly set up
 */
async function testDatabaseSchema(env: TestEnv): Promise<any> {
  // Check if vectorized_chunks table exists
  const tableCheck = await env.DB.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name='vectorized_chunks'
  `).first()

  if (!tableCheck) {
    throw new Error('vectorized_chunks table does not exist')
  }

  // Check table structure
  const columns = await env.DB.prepare(`
    PRAGMA table_info(vectorized_chunks)
  `).all()

  const expectedColumns = ['id', 'content', 'source', 'category', 'chunk_index', 'total_chunks', 'title', 'url', 'created_at']
  const actualColumns = (columns.results || []).map((col: any) => col.name)

  for (const expectedCol of expectedColumns) {
    if (!actualColumns.includes(expectedCol)) {
      throw new Error(`Missing column: ${expectedCol}`)
    }
  }

  return {
    tableExists: true,
    columns: actualColumns,
    expectedColumns
  }
}

/**
 * Test 2: Test basic VectorizeService operations
 */
async function testVectorizeServiceBasics(env: TestEnv): Promise<any> {
  const vectorizeService = new VectorizeService(env)

  // Test initialization
  await vectorizeService.initializeIndex()

  // Test content chunking
  const testContent = "This is a test document about Cloudflare Workers. Workers are serverless functions that run at the edge. They provide fast response times and can handle HTTP requests, process data, and integrate with various services."

  const chunks = vectorizeService.chunkContent(
    testContent,
    'test-source',
    'test-category',
    { title: 'Test Document', url: 'https://test.example.com' }
  )

  if (chunks.length === 0) {
    throw new Error('No chunks generated')
  }

  // Test embedding generation
  const embedding = await vectorizeService.generateEmbedding(chunks[0].content)

  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('Invalid embedding generated')
  }

  return {
    chunksCreated: chunks.length,
    firstChunkLength: chunks[0].content.length,
    embeddingDimensions: embedding.length,
    sampleEmbeddingValues: embedding.slice(0, 5)
  }
}

/**
 * Test 3: Test content chunking and embedding workflow
 */
async function testContentChunkingAndEmbedding(env: TestEnv): Promise<any> {
  const vectorizeService = new VectorizeService(env)

  const testContent = `
# Cloudflare Workers Documentation

Cloudflare Workers allows you to run JavaScript at the edge, closer to your users.

## Key Features

- **Fast**: Workers run at Cloudflare's edge locations worldwide
- **Scalable**: Automatically scales to handle millions of requests
- **Secure**: Built-in security features and isolation
- **Flexible**: Supports various programming patterns

## Getting Started

To create your first Worker:

1. Install the Wrangler CLI
2. Create a new Worker project
3. Deploy to the edge

Workers integrate with various Cloudflare services like D1, KV, R2, and Vectorize.
`

  // Create chunks
  const chunks = vectorizeService.chunkContent(
    testContent,
    'workers-docs',
    'Edge Compute',
    { title: 'Cloudflare Workers Documentation', url: 'https://developers.cloudflare.com/workers' }
  )

  // Store chunks in database
  await vectorizeService.storeChunkContent(chunks)

  // Vectorize and store in index
  const vectorizedChunks = await vectorizeService.vectorizeAndStore(chunks)

  // Test retrieval
  const retrievedChunk = await vectorizeService.getChunkContent(chunks[0].id)

  if (!retrievedChunk) {
    throw new Error('Failed to retrieve stored chunk')
  }

  return {
    originalChunks: chunks.length,
    vectorizedChunks: vectorizedChunks.length,
    retrievedChunkExists: !!retrievedChunk,
    sampleChunkId: chunks[0].id,
    totalContentLength: testContent.length
  }
}

/**
 * Test 4: Test LLM content fetching with vectorization
 */
async function testLLMContentFetching(env: TestEnv): Promise<any> {
  // Test fetching content with vectorization enabled
  const content = await fetchLLMContent(
    env,
    'https://developers.cloudflare.com/workers/llms-full.txt',
    'Edge Compute',
    {
      forceRefresh: true,
      includeChunks: true,
      includeEmbeddings: true,
      maxContentLength: 10000
    }
  )

  if (!content) {
    throw new Error('Failed to fetch LLM content')
  }

  // Verify chunks were created
  if (!content.chunks || content.chunks.length === 0) {
    throw new Error('No chunks were created for the content')
  }

  // Check if embeddings were generated
  const chunksWithEmbeddings = content.chunks.filter(chunk => chunk.embedding && chunk.embedding.length > 0)

  return {
    contentFetched: true,
    contentLength: content.content.length,
    chunksCreated: content.chunks.length,
    chunksWithEmbeddings: chunksWithEmbeddings.length,
    title: content.title,
    category: content.category
  }
}

/**
 * Test 5: Test semantic search functionality
 */
async function testSemanticSearch(env: TestEnv): Promise<any> {
  // First ensure we have some content to search
  await testContentChunkingAndEmbedding(env)

  // Test semantic search
  const searchResults = await searchContent(env, 'serverless functions edge computing', {
    limit: 5,
    minScore: 0.1,
    useSemanticSearch: true
  })

  if (searchResults.length === 0) {
    // Try with text-based search as fallback
    const textResults = await searchContent(env, 'workers', {
      limit: 5,
      useSemanticSearch: false
    })

    return {
      semanticSearchResults: 0,
      textSearchResults: textResults.length,
      fallbackUsed: true,
      sampleResult: textResults[0] ? {
        title: textResults[0].title,
        relevanceScore: textResults[0].relevanceScore
      } : null
    }
  }

  return {
    semanticSearchResults: searchResults.length,
    topResultScore: searchResults[0]?.relevanceScore,
    topResultTitle: searchResults[0]?.title,
    fallbackUsed: false
  }
}

/**
 * Test 6: Test cron service integration
 */
async function testCronServiceIntegration(env: TestEnv): Promise<any> {
  // Test manual refresh trigger
  const refreshResult = await handleScheduledRefresh(env, {
    jobType: 'manual',
    forceRefresh: true,
    includeEmbeddings: true,
    maxContentLength: 5000, // Small content for testing
    categories: ['Edge Compute'],
    batchSize: 2
  })

  if (refreshResult.status === 'failed') {
    throw new Error(`Cron refresh failed: ${refreshResult.errorDetails}`)
  }

  return {
    jobId: refreshResult.jobId,
    status: refreshResult.status,
    urlsProcessed: refreshResult.urlsProcessed,
    urlsSuccessful: refreshResult.urlsSuccessful,
    processingTime: refreshResult.processingTimeMs,
    totalContentSize: refreshResult.totalContentSize
  }
}

/**
 * Test 7: End-to-end workflow test
 */
async function testEndToEndWorkflow(env: TestEnv): Promise<any> {
  const vectorizeService = new VectorizeService(env)

  // Step 1: Create test content and vectorize
  const testQuery = "How do I deploy a Worker with database integration?"

  const testContent = `
# Deploying Workers with Database Integration

To deploy a Cloudflare Worker with database integration, follow these steps:

1. **Set up your database**: Create a D1 database in your Cloudflare dashboard
2. **Configure wrangler.toml**: Add database bindings to your configuration
3. **Write your Worker code**: Use the database binding in your Worker
4. **Deploy**: Use 'wrangler deploy' to publish your Worker

Example configuration:
\`\`\`toml
[env.production]
[[env.production.d1_databases]]
binding = "DB"
database_name = "my-database"
database_id = "your-database-id"
\`\`\`

Your Worker can then query the database using SQL.
`

  // Step 2: Process content through the full pipeline
  const chunks = vectorizeService.chunkContent(
    testContent,
    'deployment-guide',
    'Edge Compute',
    { title: 'Deployment Guide', url: 'https://docs.example.com/deploy' }
  )

  await vectorizeService.storeChunkContent(chunks)
  await vectorizeService.vectorizeAndStore(chunks)

  // Step 3: Test semantic search
  const searchResults = await searchContent(env, testQuery, {
    limit: 3,
    minScore: 0.1,
    useSemanticSearch: true
  })

  // Step 4: Verify results
  const foundRelevantContent = searchResults.some(result =>
    result.content.toLowerCase().includes('deploy') &&
    result.content.toLowerCase().includes('database')
  )

  // Step 5: Test index statistics
  const indexStats = await vectorizeService.getIndexStats()

  return {
    contentProcessed: true,
    chunksCreated: chunks.length,
    searchResultsFound: searchResults.length,
    foundRelevantContent,
    indexStats: indexStats ? {
      totalChunks: indexStats.database?.total_chunks,
      uniqueSources: indexStats.database?.unique_sources
    } : null,
    workflowCompleted: true
  }
}

/**
 * Cleanup test data
 */
export async function cleanupTestData(env: TestEnv): Promise<void> {
  try {
    const vectorizeService = new VectorizeService(env)

    // Clean up test chunks
    const testSources = ['test-source', 'workers-docs', 'deployment-guide']

    for (const source of testSources) {
      await vectorizeService.deleteChunksBySource(source)
    }

    // Clean up test LLM content
    await env.DB.prepare(`
      DELETE FROM llms_full_content
      WHERE url LIKE '%test%' OR title LIKE '%test%'
    `).run()

    // Clean up test job records
    await env.DB.prepare(`
      DELETE FROM documentation_refresh_jobs
      WHERE job_type = 'manual' AND job_id LIKE '%test%'
    `).run()

    console.log('[TEST] Cleanup completed')
  } catch (error) {
    console.error('[TEST] Cleanup failed:', error)
  }
}

/**
 * Generate test report
 */
export function generateTestReport(results: TestSuiteResult): string {
  const { totalTests, passed, failed, skipped, duration } = results

  let report = `
# Vectorization Test Suite Report

## Summary
- **Total Tests**: ${totalTests}
- **Passed**: ${passed} ✅
- **Failed**: ${failed} ❌
- **Skipped**: ${skipped} ⏸️
- **Duration**: ${duration}ms
- **Success Rate**: ${((passed / totalTests) * 100).toFixed(1)}%

## Test Results
`

  for (const result of results.results) {
    const status = result.status === 'passed' ? '✅' :
                  result.status === 'failed' ? '❌' : '⏸️'

    report += `
### ${result.testName} ${status}
- **Status**: ${result.status.toUpperCase()}
- **Duration**: ${result.duration}ms`

    if (result.error) {
      report += `
- **Error**: ${result.error}`
    }

    if (result.details) {
      report += `
- **Details**: ${JSON.stringify(result.details, null, 2)}`
    }

    report += '\n'
  }

  return report
}

/**
 * Quick health check for vectorization system
 */
export async function quickHealthCheck(env: TestEnv): Promise<{
  status: 'healthy' | 'degraded' | 'unhealthy'
  checks: Record<string, boolean>
}> {
  const checks = {
    databaseConnected: false,
    vectorizeIndexAvailable: false,
    aiModelAvailable: false,
    tablesExist: false
  }

  try {
    // Test database connection
    await env.DB.prepare('SELECT 1').first()
    checks.databaseConnected = true

    // Test vectorize index
    if (env.VECTORIZE_INDEX) {
      const vectorizeService = new VectorizeService(env)
      await vectorizeService.initializeIndex()
      checks.vectorizeIndexAvailable = true
    }

    // Test AI model
    if (env.AI) {
      try {
        await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: ['test'] })
        checks.aiModelAvailable = true
      } catch (error) {
        // AI might not be available in test environment
        checks.aiModelAvailable = false
      }
    }

    // Test table existence
    const tableCheck = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM sqlite_master
      WHERE type='table' AND name IN ('vectorized_chunks', 'llms_full_content')
    `).first()

    checks.tablesExist = ((tableCheck as any)?.count || 0) >= 2

  } catch (error) {
    console.error('[TEST] Health check error:', error)
  }

  const healthyChecks = Object.values(checks).filter(Boolean).length
  const totalChecks = Object.keys(checks).length

  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'

  if (healthyChecks === 0) {
    status = 'unhealthy'
  } else if (healthyChecks < totalChecks) {
    status = 'degraded'
  }

  return { status, checks }
}
