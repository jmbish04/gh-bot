/// <reference types="@cloudflare/workers-types" />
// src/modules/r2_service.ts

type Env = {
  R2?: R2Bucket
  R2_PUBLIC_URL?: string
  CF_ACCOUNT_ID: string
  CF_API_TOKEN: string
}

interface R2UploadResult {
  key: string
  url: string
  size: number
}

interface R2UploadBatch {
  files: { [filename: string]: string }
  totalSize: number
  uploadedCount: number
  errors: string[]
}

/**
 * R2 Storage Service for handling file uploads and URL generation
 */
export class R2Service {
  private env: Env
  private bucketName: string

  constructor(env: Env, bucketName: string = 'agent-assets') {
    this.env = env
    this.bucketName = bucketName
  }

  /**
   * Uploads a single file to R2 bucket
   */
  async uploadFile(
    key: string,
    content: string | ArrayBuffer | ReadableStream,
    options: {
      contentType?: string
      metadata?: Record<string, string>
      cacheTtl?: number
    } = {}
  ): Promise<R2UploadResult> {
    if (!this.env.R2) {
      throw new Error('R2 bucket not configured - please add R2 binding to wrangler.toml')
    }

    const {
      contentType = this.detectContentType(key),
      metadata = {},
      cacheTtl = 3600 // 1 hour default cache
    } = options

    try {
      console.log('[R2_SERVICE] Uploading file:', key, 'type:', contentType)

      // Add timestamp and project metadata
      const enrichedMetadata = {
        ...metadata,
        uploadedAt: new Date().toISOString(),
        contentType,
        cacheTtl: cacheTtl.toString()
      }

      await this.env.R2.put(key, content, {
        httpMetadata: {
          contentType,
          cacheControl: `public, max-age=${cacheTtl}`,
          contentDisposition: `attachment; filename="${this.extractFilename(key)}"`
        },
        customMetadata: enrichedMetadata
      })

      const url = this.generatePublicUrl(key)
      const size = typeof content === 'string' ? content.length : 0

      console.log('[R2_SERVICE] File uploaded successfully:', { key, url, size })

      return {
        key,
        url,
        size
      }
    } catch (error) {
      console.error('[R2_SERVICE] Upload failed:', error)
      throw new Error(`Failed to upload file ${key}: ${error}`)
    }
  }

  /**
   * Uploads multiple files as a batch operation
   */
  async uploadBatch(
    files: { key: string; content: string; contentType?: string }[],
    options: {
      prefix?: string
      metadata?: Record<string, string>
      cacheTtl?: number
    } = {}
  ): Promise<R2UploadBatch> {
    const { prefix = '', metadata = {}, cacheTtl = 3600 } = options

    const result: R2UploadBatch = {
      files: {},
      totalSize: 0,
      uploadedCount: 0,
      errors: []
    }

    // Add batch metadata
    const batchMetadata = {
      ...metadata,
      batchId: crypto.randomUUID(),
      batchSize: files.length.toString()
    }

    for (const file of files) {
      try {
        const key = prefix ? `${prefix}/${file.key}` : file.key
        const uploadResult = await this.uploadFile(key, file.content, {
          contentType: file.contentType,
          metadata: batchMetadata,
          cacheTtl
        })

        const filename = this.extractFilename(file.key)
        result.files[filename] = uploadResult.url
        result.totalSize += uploadResult.size
        result.uploadedCount++

        console.log('[R2_SERVICE] Batch upload progress:', `${result.uploadedCount}/${files.length}`)
      } catch (error) {
        const errorMsg = `Failed to upload ${file.key}: ${error}`
        console.error('[R2_SERVICE]', errorMsg)
        result.errors.push(errorMsg)
      }
    }

    console.log('[R2_SERVICE] Batch upload completed:', result)
    return result
  }

  /**
   * Generates a presigned URL for temporary access to a file
   */
  async generatePresignedUrl(
    key: string,
    expirationSeconds: number = 3600 // 1 hour default
  ): Promise<string> {
    if (!this.env.R2) {
      throw new Error('R2 bucket not configured')
    }

    try {
      // Note: As of now, Cloudflare R2 doesn't support presigned URLs through the Workers API
      // This is a placeholder for future implementation when the feature becomes available
      // For now, we'll return the public URL
      console.log('[R2_SERVICE] Presigned URLs not yet supported, returning public URL for:', key)
      return this.generatePublicUrl(key)
    } catch (error) {
      console.error('[R2_SERVICE] Failed to generate presigned URL:', error)
      throw error
    }
  }

  /**
   * Generates a public URL for accessing a file
   */
  generatePublicUrl(key: string): string {
    // If R2_PUBLIC_URL is configured, use it
    if (this.env.R2_PUBLIC_URL) {
      return `${this.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`
    }

    // Otherwise, construct URL using R2's default public URL format
    // This assumes the bucket has public access configured
    const domain = this.getBucketPublicDomain()
    return `${domain}/${key}`
  }

  /**
   * Lists files in the R2 bucket with optional prefix filtering
   */
  async listFiles(options: {
    prefix?: string
    limit?: number
    cursor?: string
  } = {}): Promise<{
    files: Array<{
      key: string
      size: number
      modified: Date
      url: string
    }>
    cursor?: string
    hasMore: boolean
  }> {
    if (!this.env.R2) {
      throw new Error('R2 bucket not configured')
    }

    const { prefix, limit = 100, cursor } = options

    try {
      const listResult = await this.env.R2.list({
        prefix,
        limit,
        cursor
      })

      const files = listResult.objects.map(obj => ({
        key: obj.key,
        size: obj.size,
        modified: obj.uploaded,
        url: this.generatePublicUrl(obj.key)
      }))

      return {
        files,
        cursor: listResult.truncated ? 'has_more' : undefined,
        hasMore: listResult.truncated
      }
    } catch (error) {
      console.error('[R2_SERVICE] Failed to list files:', error)
      throw error
    }
  }

  /**
   * Deletes a file from the R2 bucket
   */
  async deleteFile(key: string): Promise<void> {
    if (!this.env.R2) {
      throw new Error('R2 bucket not configured')
    }

    try {
      await this.env.R2.delete(key)
      console.log('[R2_SERVICE] File deleted successfully:', key)
    } catch (error) {
      console.error('[R2_SERVICE] Failed to delete file:', error)
      throw error
    }
  }

  /**
   * Deletes multiple files from the R2 bucket
   */
  async deleteBatch(keys: string[]): Promise<{ deleted: number; errors: string[] }> {
    if (!this.env.R2) {
      throw new Error('R2 bucket not configured')
    }

    const result = { deleted: 0, errors: [] as string[] }

    for (const key of keys) {
      try {
        await this.deleteFile(key)
        result.deleted++
      } catch (error) {
        const errorMsg = `Failed to delete ${key}: ${error}`
        console.error('[R2_SERVICE]', errorMsg)
        result.errors.push(errorMsg)
      }
    }

    return result
  }

  /**
   * Gets metadata for a file in the R2 bucket
   */
  async getFileMetadata(key: string): Promise<{
    exists: boolean
    size?: number
    modified?: Date
    contentType?: string
    metadata?: Record<string, string>
  }> {
    if (!this.env.R2) {
      throw new Error('R2 bucket not configured')
    }

    try {
      const obj = await this.env.R2.head(key)

      if (!obj) {
        return { exists: false }
      }

      return {
        exists: true,
        size: obj.size,
        modified: obj.uploaded,
        contentType: obj.httpMetadata?.contentType,
        metadata: obj.customMetadata
      }
    } catch (error) {
      console.error('[R2_SERVICE] Failed to get file metadata:', error)
      return { exists: false }
    }
  }

  // Private helper methods

  private detectContentType(key: string): string {
    const extension = key.split('.').pop()?.toLowerCase()

    const contentTypes: { [key: string]: string } = {
      'json': 'application/json',
      'md': 'text/markdown',
      'txt': 'text/plain',
      'html': 'text/html',
      'css': 'text/css',
      'js': 'application/javascript',
      'ts': 'application/typescript',
      'xml': 'application/xml',
      'pdf': 'application/pdf',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'svg': 'image/svg+xml'
    }

    return contentTypes[extension || ''] || 'application/octet-stream'
  }

  private extractFilename(key: string): string {
    return key.split('/').pop() || key
  }

  private getBucketPublicDomain(): string {
    // This would need to be configured based on your R2 setup
    // Format: https://<bucket-name>.<account-id>.r2.cloudflarestorage.com
    // or custom domain if configured
    if (this.env.CF_ACCOUNT_ID) {
      return `https://${this.bucketName}.${this.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`
    }

    // Fallback - this would need to be replaced with actual configuration
    return `https://r2-bucket-url-not-configured.com`
  }
}

/**
 * Creates and configures an R2 service instance
 */
export function createR2Service(env: Env, bucketName?: string): R2Service {
  return new R2Service(env, bucketName)
}

/**
 * Convenience function for uploading agent assets to R2
 */
export async function uploadAgentAssets(
  env: Env,
  assets: {
    agentMd: string
    promptMd: string
    prdMd: string
    projectTasksJson: any
  },
  repo: string
): Promise<{ [filename: string]: string }> {
  const r2Service = createR2Service(env)

  // Create a unique folder for this asset generation
  const timestamp = Date.now()
  const repoSafe = repo.replace(/[^a-zA-Z0-9-]/g, '_')
  const prefix = `agent-assets/${repoSafe}/${timestamp}`

  const files = [
    {
      key: 'AGENT.md',
      content: assets.agentMd,
      contentType: 'text/markdown'
    },
    {
      key: 'prompt.md',
      content: assets.promptMd,
      contentType: 'text/markdown'
    },
    {
      key: 'PRD.md',
      content: assets.prdMd,
      contentType: 'text/markdown'
    },
    {
      key: 'project_tasks.json',
      content: JSON.stringify(assets.projectTasksJson, null, 2),
      contentType: 'application/json'
    }
  ]

  const batchResult = await r2Service.uploadBatch(files, {
    prefix,
    metadata: {
      repo,
      generatedAt: new Date().toISOString(),
      assetType: 'agent-configuration'
    },
    cacheTtl: 86400 // 24 hours cache for agent assets
  })

  if (batchResult.errors.length > 0) {
    console.warn('[R2_SERVICE] Some uploads failed:', batchResult.errors)
  }

  console.log(`[R2_SERVICE] Uploaded ${batchResult.uploadedCount} agent assets for ${repo}`)

  return batchResult.files
}

/**
 * Convenience function for cleaning up old agent assets
 */
export async function cleanupOldAgentAssets(
  env: Env,
  repo: string,
  keepRecentCount: number = 5
): Promise<{ deleted: number; errors: string[] }> {
  const r2Service = createR2Service(env)
  const repoSafe = repo.replace(/[^a-zA-Z0-9-]/g, '_')
  const prefix = `agent-assets/${repoSafe}/`

  // List all assets for this repo
  const listResult = await r2Service.listFiles({ prefix, limit: 1000 })

  // Group by timestamp (folder) and sort by timestamp descending
  const folders = new Map<string, string[]>()

  for (const file of listResult.files) {
    const pathParts = file.key.split('/')
    if (pathParts.length >= 3) {
      const timestamp = pathParts[2] // agent-assets/repo/timestamp/file
      if (!folders.has(timestamp)) {
        folders.set(timestamp, [])
      }
      folders.get(timestamp)!.push(file.key)
    }
  }

  // Sort folders by timestamp (descending) and keep only the most recent ones
  const sortedFolders = Array.from(folders.entries())
    .sort((a, b) => parseInt(b[0]) - parseInt(a[0]))
    .slice(keepRecentCount)

  // Delete files from old folders
  const keysToDelete: string[] = []
  for (const [, files] of sortedFolders) {
    keysToDelete.push(...files)
  }

  if (keysToDelete.length === 0) {
    console.log(`[R2_SERVICE] No old assets to clean up for ${repo}`)
    return { deleted: 0, errors: [] }
  }

  console.log(`[R2_SERVICE] Cleaning up ${keysToDelete.length} old assets for ${repo}`)
  return await r2Service.deleteBatch(keysToDelete)
}
