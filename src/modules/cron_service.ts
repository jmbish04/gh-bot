/// <reference types="@cloudflare/workers-types" />

/**
 * Cron Service for Scheduled Documentation Refresh
 *
 * This module handles scheduled refresh of LLM documentation content
 * and maintains the documentation cache freshness.
 */

import { refreshAllContent } from './llm_fetcher'
import { VectorizeService } from './vectorize_service'

// Define FetchOptions locally since it's not exported from llm_fetcher
interface FetchOptions {
  forceRefresh?: boolean
  maxAge?: number // milliseconds
  includeChunks?: boolean
  maxContentLength?: number
  includeEmbeddings?: boolean
}

type Env = {
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

export interface CronJobConfig {
  jobType?: 'scheduled' | 'manual' | 'triggered'
  forceRefresh?: boolean
  includeEmbeddings?: boolean
  maxContentLength?: number
  categories?: string[]
  batchSize?: number
  delayBetweenBatches?: number
}

export interface CronJobResult {
  jobId: string
  status: 'completed' | 'failed' | 'partial'
  urlsProcessed: number
  urlsSuccessful: number
  urlsFailed: number
  totalContentSize: number
  processingTimeMs: number
  errorDetails?: string
  startTime: number
  endTime: number
}

/**
 * Main cron job handler for scheduled documentation refresh
 */
export async function handleScheduledRefresh(
  env: Env,
  config: CronJobConfig = {}
): Promise<CronJobResult> {
  const jobId = generateJobId()
  const startTime = Date.now()

  console.log('[CRON] Starting scheduled documentation refresh:', jobId)

  // Create job record
  const jobRecord = await createJobRecord(env, jobId, config.jobType || 'scheduled')

  try {
    // Update job status to running
    await updateJobStatus(env, jobId, 'running', startTime)

    // Perform content refresh with retries and batching
    const refreshResult = await performBatchedRefresh(env, config)

    const endTime = Date.now()
    const processingTimeMs = endTime - startTime

    // Update vectorization if enabled
    if (config.includeEmbeddings && refreshResult.results.length > 0) {
      try {
        await updateVectorization(env, refreshResult.results)
        console.log('[CRON] Updated vectorization for', refreshResult.results.length, 'documents')
      } catch (vectorizeError) {
        console.error('[CRON] Vectorization update failed:', vectorizeError)
        // Continue even if vectorization fails
      }
    }

    // Determine final status
    const status = refreshResult.failed === 0 ? 'completed' :
                  refreshResult.success > 0 ? 'partial' : 'failed'

    // Update job completion
    await updateJobCompletion(env, jobId, {
      status,
      urlsProcessed: refreshResult.success + refreshResult.failed,
      urlsSuccessful: refreshResult.success,
      urlsFailed: refreshResult.failed,
      totalContentSize: calculateTotalContentSize(refreshResult.results),
      processingTimeMs,
      completedAt: endTime
    })

    const result: CronJobResult = {
      jobId,
      status,
      urlsProcessed: refreshResult.success + refreshResult.failed,
      urlsSuccessful: refreshResult.success,
      urlsFailed: refreshResult.failed,
      totalContentSize: calculateTotalContentSize(refreshResult.results),
      processingTimeMs,
      startTime,
      endTime
    }

    console.log('[CRON] Refresh job completed:', result)
    return result

  } catch (error: unknown) {
    const endTime = Date.now()
    const errorMessage = error instanceof Error ? error.message : String(error)

    console.error('[CRON] Refresh job failed:', error)

    // Update job with failure
    await updateJobStatus(env, jobId, 'failed', undefined, errorMessage)

    return {
      jobId,
      status: 'failed',
      urlsProcessed: 0,
      urlsSuccessful: 0,
      urlsFailed: 0,
      totalContentSize: 0,
      processingTimeMs: endTime - startTime,
      errorDetails: errorMessage,
      startTime,
      endTime
    }
  }
}

/**
 * Performs batched refresh to avoid overwhelming external services
 */
async function performBatchedRefresh(
  env: Env,
  config: CronJobConfig
): Promise<{ success: number; failed: number; results: any[] }> {
  const fetchOptions: FetchOptions = {
    forceRefresh: config.forceRefresh ?? true,
    includeChunks: config.includeEmbeddings ?? true,
    maxContentLength: config.maxContentLength ?? 50000,
    includeEmbeddings: config.includeEmbeddings ?? false
  }

  // Use the existing refreshAllContent function with enhancements
  const result = await refreshAllContent(env, fetchOptions)

  // Add delay between batches if specified
  if (config.delayBetweenBatches && config.delayBetweenBatches > 0) {
    console.log('[CRON] Applying delay between batches:', config.delayBetweenBatches, 'ms')
    await new Promise(resolve => setTimeout(resolve, config.delayBetweenBatches))
  }

  return result
}

/**
 * Updates vectorization for refreshed content
 */
async function updateVectorization(env: Env, refreshedContent: any[]): Promise<void> {
  if (!env.VECTORIZE_INDEX || refreshedContent.length === 0) {
    return
  }

  const vectorizeService = new VectorizeService(env)

  for (const content of refreshedContent) {
    try {
      // Delete existing chunks for this source
      await vectorizeService.deleteChunksBySource(content.url)

      // Create new chunks and vectorize
      const chunks = vectorizeService.chunkContent(
        content.content,
        content.url,
        content.category,
        {
          title: content.title,
          url: content.url
        }
      )

      // Store chunks in database
      await vectorizeService.storeChunkContent(chunks)

      // Vectorize and store in index
      await vectorizeService.vectorizeAndStore(chunks)

      console.log('[CRON] Updated vectorization for:', content.url)

    } catch (error) {
      console.error('[CRON] Failed to update vectorization for:', content.url, error)
      // Continue with other content
    }
  }
}

/**
 * Database operations for job tracking
 */
async function createJobRecord(
  env: Env,
  jobId: string,
  jobType: string
): Promise<void> {
  try {
    await env.DB.prepare(`
      INSERT INTO documentation_refresh_jobs
      (job_id, job_type, status, created_at)
      VALUES (?, ?, 'pending', ?)
    `).bind(jobId, jobType, Date.now()).run()
  } catch (error) {
    console.error('[CRON] Failed to create job record:', error)
    throw error
  }
}

async function updateJobStatus(
  env: Env,
  jobId: string,
  status: string,
  startedAt?: number,
  errorDetails?: string
): Promise<void> {
  try {
    const updates: any[] = [status]
    let sql = 'UPDATE documentation_refresh_jobs SET status = ?'

    if (startedAt !== undefined) {
      sql += ', started_at = ?'
      updates.push(startedAt)
    }

    if (errorDetails) {
      sql += ', error_details = ?'
      updates.push(errorDetails)
    }

    sql += ' WHERE job_id = ?'
    updates.push(jobId)

    await env.DB.prepare(sql).bind(...updates).run()
  } catch (error) {
    console.error('[CRON] Failed to update job status:', error)
  }
}

async function updateJobCompletion(
  env: Env,
  jobId: string,
  completion: {
    status: string
    urlsProcessed: number
    urlsSuccessful: number
    urlsFailed: number
    totalContentSize: number
    processingTimeMs: number
    completedAt: number
  }
): Promise<void> {
  try {
    await env.DB.prepare(`
      UPDATE documentation_refresh_jobs
      SET status = ?, urls_processed = ?, urls_successful = ?, urls_failed = ?,
          total_content_size = ?, processing_time_ms = ?, completed_at = ?
      WHERE job_id = ?
    `).bind(
      completion.status,
      completion.urlsProcessed,
      completion.urlsSuccessful,
      completion.urlsFailed,
      completion.totalContentSize,
      completion.processingTimeMs,
      completion.completedAt,
      jobId
    ).run()
  } catch (error) {
    console.error('[CRON] Failed to update job completion:', error)
  }
}

/**
 * Manual refresh trigger (can be called via API)
 */
export async function triggerManualRefresh(
  env: Env,
  config: Partial<CronJobConfig> = {}
): Promise<CronJobResult> {
  console.log('[CRON] Manual refresh triggered')
  return handleScheduledRefresh(env, {
    ...config,
    jobType: 'manual'
  })
}

/**
 * Get refresh job status and history
 */
export async function getRefreshJobStatus(
  env: Env,
  jobId?: string,
  limit: number = 20
): Promise<any[]> {
  try {
    let sql = `
      SELECT job_id, job_type, status, urls_processed, urls_successful, urls_failed,
             total_content_size, processing_time_ms, error_details,
             created_at, started_at, completed_at
      FROM documentation_refresh_jobs
    `
    const params: any[] = []

    if (jobId) {
      sql += ' WHERE job_id = ?'
      params.push(jobId)
    }

    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit)

    const result = await env.DB.prepare(sql).bind(...params).all()

    return result.results || []
  } catch (error) {
    console.error('[CRON] Failed to get job status:', error)
    return []
  }
}

/**
 * Clean up old job records
 */
export async function cleanupOldJobs(
  env: Env,
  retentionDays: number = 30
): Promise<number> {
  try {
    const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000)

    const result = await env.DB.prepare(`
      DELETE FROM documentation_refresh_jobs
      WHERE created_at < ?
    `).bind(cutoffTime).run()

    const deletedCount = result.meta?.changes || 0
    console.log('[CRON] Cleaned up', deletedCount, 'old job records')

    return deletedCount
  } catch (error) {
    console.error('[CRON] Failed to cleanup old jobs:', error)
    return 0
  }
}

/**
 * Get documentation freshness statistics
 */
export async function getDocumentationStats(env: Env): Promise<any> {
  try {
    const stats = await env.DB.prepare(`
      SELECT
        category,
        COUNT(*) as doc_count,
        AVG(last_fetched) as avg_last_fetched,
        MIN(last_fetched) as oldest_fetch,
        MAX(last_fetched) as newest_fetch,
        AVG(content_length) as avg_content_length,
        SUM(content_length) as total_content_length
      FROM llms_full_content
      WHERE is_active = 1
      GROUP BY category
      ORDER BY doc_count DESC
    `).all()

    const overall = await env.DB.prepare(`
      SELECT
        COUNT(*) as total_docs,
        AVG(last_fetched) as avg_last_fetched,
        SUM(content_length) as total_content_length,
        MAX(last_fetched) as most_recent_fetch,
        MIN(last_fetched) as oldest_fetch
      FROM llms_full_content
      WHERE is_active = 1
    `).first()

    const recentJobs = await env.DB.prepare(`
      SELECT job_type, status, COUNT(*) as count
      FROM documentation_refresh_jobs
      WHERE created_at > ?
      GROUP BY job_type, status
    `).bind(Date.now() - (7 * 24 * 60 * 60 * 1000)).all() // Last 7 days

    return {
      overall: overall || {},
      byCategory: stats.results || [],
      recentJobs: recentJobs.results || []
    }
  } catch (error) {
    console.error('[CRON] Failed to get documentation stats:', error)
    return {
      overall: {},
      byCategory: [],
      recentJobs: []
    }
  }
}

/**
 * Utility functions
 */
function generateJobId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 8)
  return `refresh_${timestamp}_${random}`
}

function calculateTotalContentSize(results: any[]): number {
  return results.reduce((total, content) => total + (content.contentLength || 0), 0)
}

/**
 * Configuration for different refresh intervals
 */
export const REFRESH_SCHEDULES = {
  // Every 6 hours for critical documentation
  CRITICAL: {
    schedule: '0 */6 * * *',
    config: {
      forceRefresh: true,
      includeEmbeddings: true,
      categories: ['Edge Compute', 'Application Hosting / Full Stack'],
      batchSize: 5,
      delayBetweenBatches: 1000
    }
  },

  // Daily for all documentation
  DAILY: {
    schedule: '0 2 * * *', // 2 AM daily
    config: {
      forceRefresh: true,
      includeEmbeddings: true,
      batchSize: 10,
      delayBetweenBatches: 500
    }
  },

  // Weekly for comprehensive refresh
  WEEKLY: {
    schedule: '0 1 * * 0', // 1 AM on Sundays
    config: {
      forceRefresh: true,
      includeEmbeddings: true,
      maxContentLength: 100000, // Allow larger content
      batchSize: 20,
      delayBetweenBatches: 200
    }
  }
}

/**
 * Health check for refresh system
 */
export async function healthCheck(env: Env): Promise<{
  status: 'healthy' | 'degraded' | 'unhealthy'
  details: any
}> {
  try {
    const stats = await getDocumentationStats(env)
    const now = Date.now()
    const oneDayAgo = now - (24 * 60 * 60 * 1000)
    const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000)

    // Check if any content was refreshed in the last 24 hours
    const recentRefreshes = await env.DB.prepare(`
      SELECT COUNT(*) as count
      FROM llms_full_content
      WHERE last_fetched > ? AND is_active = 1
    `).bind(oneDayAgo).first()

    // Check for failed jobs in the last week
    const recentFailures = await env.DB.prepare(`
      SELECT COUNT(*) as count
      FROM documentation_refresh_jobs
      WHERE created_at > ? AND status = 'failed'
    `).bind(oneWeekAgo).first()

    const hasRecentRefreshes = ((recentRefreshes as any)?.count || 0) > 0
    const hasRecentFailures = ((recentFailures as any)?.count || 0) > 0
    const totalDocs = (stats.overall as any)?.total_docs || 0

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'

    if (totalDocs === 0) {
      status = 'unhealthy'
    } else if (!hasRecentRefreshes || hasRecentFailures) {
      status = 'degraded'
    }

    return {
      status,
      details: {
        totalDocuments: totalDocs,
        hasRecentRefreshes,
        recentFailures: recentFailures?.count || 0,
        averageAge: now - (stats.overall.avg_last_fetched || 0),
        oldestDocument: now - (stats.overall.oldest_fetch || 0),
        categories: stats.byCategory.length
      }
    }
  } catch (error) {
    console.error('[CRON] Health check failed:', error)
    return {
      status: 'unhealthy',
      details: { error: error instanceof Error ? error.message : String(error) }
    }
  }
}
