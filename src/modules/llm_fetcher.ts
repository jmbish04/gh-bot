/// <reference types="@cloudflare/workers-types" />

// src/modules/llm_fetcher.ts
import { analyzeRepoStructure, type RepoStructure } from './agent_generator'
import { VectorizeService, type ContentChunk as VectorizeContentChunk, type SimilaritySearchResult } from './vectorize_service'

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

interface LLMContent {
  id: string
  category: string
  url: string
  title: string
  content: string
  contentHash: string
  lastFetched: number
  contentLength: number
  relevanceScore: number
  chunks?: ContentChunk[]
  metadata: ContentMetadata
}

interface ContentChunk {
  id: string
  content: string
  startIndex: number
  endIndex: number
  relevanceScore: number
  embedding?: number[]
}

interface ContentMetadata {
  language: string
  contentType: 'documentation' | 'tutorial' | 'reference' | 'guide' | 'api'
  tags: string[]
  difficulty: 'beginner' | 'intermediate' | 'advanced'
  lastModified?: string
  wordCount: number
}

interface FetchOptions {
  forceRefresh?: boolean
  maxAge?: number // milliseconds
  includeChunks?: boolean
  maxContentLength?: number
  includeEmbeddings?: boolean
}

interface ProjectAnalysisContext {
  repo: string
  repoStructure: RepoStructure
  goals?: string
  context?: string
  searchQuery?: string
}

export interface ContentRelevanceResult {
  content: LLMContent
  relevanceScore: number
  relevanceReasons: string[]
  matchedKeywords: string[]
}

/**
 * Comprehensive LLM documentation URLs with enhanced categorization
 */
const LLMS_TXT_CATEGORIZED_ENHANCED = {
  "Application Hosting / Full Stack": {
    urls: [
      "https://developers.cloudflare.com/pages/llms-full.txt",
      "https://developers.cloudflare.com/containers/llms-full.txt",
      "https://developers.cloudflare.com/developer-platform/llms-full.txt"
    ],
    keywords: ["pages", "hosting", "deployment", "fullstack", "nextjs", "react", "vue", "frontend"],
    priority: 1
  },
  "AI & Agents": {
    urls: [
      "https://developers.cloudflare.com/agents/llms-full.txt",
      "https://developers.cloudflare.com/ai-gateway/llms-full.txt",
      "https://developers.cloudflare.com/workers-ai/llms-full.txt",
      "https://developers.cloudflare.com/autorag/llms-full.txt"
    ],
    keywords: ["ai", "agents", "ml", "llm", "gpt", "embedding", "vector", "intelligence"],
    priority: 2
  },
  "Edge Compute": {
    urls: [
      "https://developers.cloudflare.com/workers/llms-full.txt",
      "https://developers.cloudflare.com/workflows/llms-full.txt"
    ],
    keywords: ["workers", "edge", "serverless", "compute", "api", "functions", "runtime"],
    priority: 1
  },
  "Stateful Services": {
    urls: [
      "https://developers.cloudflare.com/kv/llms-full.txt",
      "https://developers.cloudflare.com/durable-objects/llms-full.txt",
      "https://developers.cloudflare.com/d1/llms-full.txt",
      "https://developers.cloudflare.com/r2/llms-full.txt",
      "https://developers.cloudflare.com/queues/llms-full.txt",
      "https://developers.cloudflare.com/vectorize/llms-full.txt",
      "https://developers.cloudflare.com/pipelines/llms-full.txt",
      "https://developers.cloudflare.com/email-routing/llms-full.txt",
      "https://developers.cloudflare.com/pub-sub/llms-full.txt",
      "https://developers.cloudflare.com/hyperdrive/llms-full.txt",
      "https://developers.cloudflare.com/realtime/llms-full.txt"
    ],
    keywords: ["database", "storage", "kv", "d1", "r2", "queue", "durable", "state", "persistence"],
    priority: 2
  },
  "Developer Tools & Platform": {
    urls: [
      "https://developers.cloudflare.com/logs/llms-full.txt",
      "https://developers.cloudflare.com/developer-spotlight/llms-full.txt"
    ],
    keywords: ["wrangler", "cli", "logs", "debugging", "tools", "development", "deployment"],
    priority: 3
  },
  "Browser/Rendering/Images/Media": {
    urls: [
      "https://developers.cloudflare.com/browser-rendering/llms-full.txt",
      "https://developers.cloudflare.com/images/llms-full.txt",
      "https://developers.cloudflare.com/stream/llms-full.txt"
    ],
    keywords: ["images", "media", "rendering", "browser", "puppeteer", "stream", "video"],
    priority: 3
  },
  "Other/General": {
    urls: [
      "https://developers.cloudflare.com/llms.txt",
      "https://developers.cloudflare.com/workers/prompt.txt",
      "https://developers.cloudflare.com/zaraz/llms-full.txt"
    ],
    keywords: ["general", "overview", "getting-started", "basics"],
    priority: 3
  }
}

/**
 * Additional documentation sources for comprehensive coverage
 */
const ADDITIONAL_DOCS = {
  "Google Apps Script": {
    urls: [
      "https://developers.google.com/apps-script/guides/overview",
      "https://developers.google.com/apps-script/reference"
    ],
    keywords: ["appsscript", "google", "sheets", "docs", "drive", "gmail"],
    priority: 2
  }
}

/**
 * Fetches and analyzes LLM content based on project context
 */
export async function fetchRelevantLLMContent(
  env: Env,
  context: ProjectAnalysisContext,
  options: FetchOptions = {}
): Promise<ContentRelevanceResult[]> {
  console.log('[LLM_FETCH] Starting content fetch for:', context.repo)

  const relevantCategories = await determineRelevantCategories(context)
  const contentResults: ContentRelevanceResult[] = []

  for (const category of relevantCategories) {
    const categoryConfig = LLMS_TXT_CATEGORIZED_ENHANCED[category as keyof typeof LLMS_TXT_CATEGORIZED_ENHANCED]
    if (!categoryConfig) continue

    console.log('[LLM_FETCH] Processing category:', category)

    for (const url of categoryConfig.urls) {
      try {
        const content = await fetchLLMContent(env, url, category, options)
        if (content) {
          const relevanceScore = await calculateRelevanceScore(content, context, categoryConfig)
          const relevanceReasons = await analyzeRelevanceReasons(content, context)
          const matchedKeywords = findMatchedKeywords(content, categoryConfig.keywords, context)

          contentResults.push({
            content,
            relevanceScore,
            relevanceReasons,
            matchedKeywords
          })
        }
      } catch (error) {
        console.error('[LLM_FETCH] Failed to fetch:', url, error)
      }
    }
  }

  // Sort by relevance score (descending)
  contentResults.sort((a, b) => b.relevanceScore - a.relevanceScore)

  console.log('[LLM_FETCH] Fetched and analyzed', contentResults.length, 'content sources')
  return contentResults
}

/**
 * Fetches individual LLM content from URL with caching and error handling
 */
export async function fetchLLMContent(
  env: Env,
  url: string,
  category: string,
  options: FetchOptions = {}
): Promise<LLMContent | null> {
  const {
    forceRefresh = false,
    maxAge = 24 * 60 * 60 * 1000, // 24 hours
    includeChunks = true,
    maxContentLength = 50000,
    includeEmbeddings = false
  } = options

  const contentId = generateContentId(url)

  // Check cache first (unless force refresh)
  if (!forceRefresh) {
    const cachedContent = await getCachedContent(env, contentId)
    if (cachedContent && (Date.now() - cachedContent.lastFetched) < maxAge) {
      console.log('[LLM_FETCH] Using cached content for:', url)
      return cachedContent
    }
  }

  console.log('[LLM_FETCH] Fetching fresh content from:', url)

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Cloudflare-Worker-LLM-Fetcher/1.0',
        'Accept': 'text/plain, text/markdown, */*'
      }
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    let rawContent = await response.text()

    // Truncate if too long
    if (rawContent.length > maxContentLength) {
      rawContent = rawContent.substring(0, maxContentLength) + '\n\n[Content truncated...]'
    }

    // Extract title from content or URL
    const title = extractTitle(rawContent) || extractTitleFromUrl(url)

    // Generate content hash for change detection
    const contentHash = await generateContentHash(rawContent)

    // Analyze content metadata
    const metadata = await analyzeContentMetadata(rawContent, url)

    const content: LLMContent = {
      id: contentId,
      category,
      url,
      title,
      content: rawContent,
      contentHash,
      lastFetched: Date.now(),
      contentLength: rawContent.length,
      relevanceScore: 0, // Will be calculated later
      metadata
    }

    // Create content chunks if requested
    if (includeChunks) {
      content.chunks = await createContentChunks(
        rawContent,
        includeEmbeddings ? env : undefined,
        url,
        category
      )
    }

    // Cache the content
    await cacheContent(env, content)

    return content
  } catch (error) {
    console.error('[LLM_FETCH] Failed to fetch content:', url, error)
    return null
  }
}

/**
 * Determines relevant categories based on project context
 */
async function determineRelevantCategories(context: ProjectAnalysisContext): Promise<string[]> {
  const categories: string[] = []
  const { repoStructure, goals, context: projectContext, searchQuery } = context

  // Primary categories based on project type
  switch (repoStructure.projectType) {
    case 'cloudflare-worker':
      categories.push('Edge Compute', 'Stateful Services')
      if (repoStructure.hasNextConfig) {
        categories.push('Application Hosting / Full Stack')
      }
      break
    case 'cloudflare-pages':
    case 'nextjs-pages':
      categories.push('Application Hosting / Full Stack', 'Edge Compute')
      break
    case 'apps-script':
      // Apps Script projects get different treatment
      return ['Other/General']
    default:
      categories.push('Edge Compute', 'Other/General')
  }

  // Add AI & Agents if context suggests AI usage
  if (goals?.toLowerCase().includes('ai') ||
      goals?.toLowerCase().includes('agent') ||
      projectContext?.toLowerCase().includes('ai') ||
      searchQuery?.toLowerCase().includes('ai')) {
    categories.push('AI & Agents')
  }

  // Add Developer Tools for all projects
  categories.push('Developer Tools & Platform')

  // Add specialized categories based on dependencies
  if (repoStructure.dependencies.some((dep: string) =>
    dep.includes('image') || dep.includes('media') || dep.includes('puppeteer'))) {
    categories.push('Browser/Rendering/Images/Media')
  }

  return Array.from(new Set(categories)) // Remove duplicates
}

/**
 * Calculates relevance score for content based on project context
 */
async function calculateRelevanceScore(
  content: LLMContent,
  context: ProjectAnalysisContext,
  categoryConfig: any
): Promise<number> {
  let score = 0

  // Base score from category priority
  score += (4 - categoryConfig.priority) * 20 // 60, 40, 20

  // Keyword matching in content
  const contentLower = content.content.toLowerCase()
  const projectKeywords = extractProjectKeywords(context)

  for (const keyword of projectKeywords) {
    if (contentLower.includes(keyword.toLowerCase())) {
      score += 15
    }
  }

  // Category keyword matching
  for (const keyword of categoryConfig.keywords) {
    if (contentLower.includes(keyword.toLowerCase())) {
      score += 10
    }
  }

  // Project type specific bonuses
  if (context.repoStructure.projectType === 'cloudflare-worker' &&
      content.url.includes('workers')) {
    score += 30
  }

  if (context.repoStructure.projectType === 'cloudflare-pages' &&
      content.url.includes('pages')) {
    score += 30
  }

  // Content quality factors
  score += Math.min(content.metadata.wordCount / 100, 20) // Up to 20 for length

  if (content.metadata.contentType === 'documentation') score += 15
  if (content.metadata.contentType === 'reference') score += 10
  if (content.metadata.contentType === 'guide') score += 5

  // Normalize to 0-1 range
  return Math.min(score / 100, 1)
}

/**
 * Analyzes reasons for content relevance
 */
async function analyzeRelevanceReasons(
  content: LLMContent,
  context: ProjectAnalysisContext
): Promise<string[]> {
  const reasons: string[] = []

  // Check for project type relevance
  if (content.url.includes('workers') &&
      ['cloudflare-worker', 'cloudflare-pages'].includes(context.repoStructure.projectType)) {
    reasons.push('Relevant to Cloudflare Workers development')
  }

  if (content.url.includes('pages') &&
      ['cloudflare-pages', 'nextjs-pages'].includes(context.repoStructure.projectType)) {
    reasons.push('Relevant to Cloudflare Pages deployment')
  }

  // Check for technology stack matches
  if (context.repoStructure.hasNextConfig &&
      (content.content.toLowerCase().includes('next') ||
       content.content.toLowerCase().includes('react'))) {
    reasons.push('Contains Next.js/React specific guidance')
  }

  // Check for goal alignment
  if (context.goals) {
    const goalsLower = context.goals.toLowerCase()
    if (goalsLower.includes('ai') && content.category === 'AI & Agents') {
      reasons.push('Matches AI/ML project goals')
    }
    if (goalsLower.includes('database') && content.url.includes('d1')) {
      reasons.push('Relevant to database requirements')
    }
  }

  return reasons
}

/**
 * Finds matched keywords between content and context
 */
function findMatchedKeywords(
  content: LLMContent,
  categoryKeywords: string[],
  context: ProjectAnalysisContext
): string[] {
  const matched: string[] = []
  const contentLower = content.content.toLowerCase()
  const projectKeywords = extractProjectKeywords(context)

  // Check category keywords
  for (const keyword of categoryKeywords) {
    if (contentLower.includes(keyword.toLowerCase())) {
      matched.push(keyword)
    }
  }

  // Check project keywords
  for (const keyword of projectKeywords) {
    if (contentLower.includes(keyword.toLowerCase()) && !matched.includes(keyword)) {
      matched.push(keyword)
    }
  }

  return matched
}

/**
 * Extracts keywords from project context
 */
function extractProjectKeywords(context: ProjectAnalysisContext): string[] {
  const keywords: string[] = []

  // Add dependencies as keywords
  keywords.push(...context.repoStructure.dependencies)
  keywords.push(...context.repoStructure.devDependencies)

  // Extract from goals and context
  if (context.goals) {
    keywords.push(...context.goals.split(/\s+/).filter(w => w.length > 3))
  }
  if (context.context) {
    keywords.push(...context.context.split(/\s+/).filter(w => w.length > 3))
  }

  // Add project type keywords
  switch (context.repoStructure.projectType) {
    case 'cloudflare-worker':
      keywords.push('worker', 'serverless', 'edge', 'api')
      break
    case 'cloudflare-pages':
      keywords.push('pages', 'frontend', 'static', 'jamstack')
      break
    case 'nextjs-pages':
      keywords.push('nextjs', 'react', 'ssr', 'static')
      break
  }

  return Array.from(new Set(keywords.map((k: string) => k.toLowerCase())))
}

/**
 * Creates content chunks for better processing and vectorization
 */
async function createContentChunks(
  content: string,
  env?: Env,
  source?: string,
  category?: string
): Promise<ContentChunk[]> {
  if (!env || !source || !category) {
    // Fallback to simple chunking without vectorization
    return createSimpleChunks(content)
  }

  try {
    const vectorizeService = new VectorizeService(env)

    // Use VectorizeService to create chunks with proper metadata
    const vectorizeChunks = vectorizeService.chunkContent(content, source, category, {
      url: source,
      title: extractTitle(content) || extractTitleFromUrl(source)
    })

    // Convert VectorizeContentChunk to ContentChunk format
    const chunks: ContentChunk[] = vectorizeChunks.map((vChunk, index) => ({
      id: vChunk.id,
      content: vChunk.content,
      startIndex: index * 800, // Approximate start index
      endIndex: index * 800 + vChunk.content.length,
      relevanceScore: 0,
      embedding: undefined // Will be populated during vectorization
    }))

    // Store chunks in database for retrieval
    await vectorizeService.storeChunkContent(vectorizeChunks)

    // Generate embeddings and store in Vectorize index
    try {
      const vectorizedChunks = await vectorizeService.vectorizeAndStore(vectorizeChunks)

      // Update chunks with embedding data
      vectorizedChunks.forEach((vChunk, index) => {
        if (chunks[index]) {
          chunks[index].embedding = vChunk.vector
        }
      })
    } catch (vectorizeError) {
      console.error('[LLM_FETCH] Failed to vectorize chunks:', vectorizeError)
      // Continue without embeddings
    }

    return chunks
  } catch (error) {
    console.error('[LLM_FETCH] Failed to create vectorized chunks:', error)
    return createSimpleChunks(content)
  }
}

/**
 * Fallback simple chunking without vectorization
 */
function createSimpleChunks(content: string): ContentChunk[] {
  const chunks: ContentChunk[] = []
  const chunkSize = 1000 // Characters per chunk
  const overlap = 200 // Overlap between chunks

  for (let i = 0; i < content.length; i += chunkSize - overlap) {
    const chunkContent = content.substring(i, i + chunkSize)
    const chunk: ContentChunk = {
      id: `chunk_${i}`,
      content: chunkContent,
      startIndex: i,
      endIndex: i + chunkContent.length,
      relevanceScore: 0
    }
    chunks.push(chunk)
  }

  return chunks
}

/**
 * Analyzes content metadata
 */
async function analyzeContentMetadata(content: string, url: string): Promise<ContentMetadata> {
  const wordCount = content.split(/\s+/).length

  // Determine content type from URL and content
  let contentType: ContentMetadata['contentType'] = 'documentation'
  if (url.includes('tutorial')) contentType = 'tutorial'
  else if (url.includes('reference') || url.includes('api')) contentType = 'reference'
  else if (url.includes('guide')) contentType = 'guide'

  // Extract tags from content (simple approach)
  const tags: string[] = []
  const commonTags = ['cloudflare', 'workers', 'pages', 'api', 'database', 'storage', 'ai', 'javascript', 'typescript']
  for (const tag of commonTags) {
    if (content.toLowerCase().includes(tag)) {
      tags.push(tag)
    }
  }

  // Determine difficulty (basic heuristic)
  let difficulty: ContentMetadata['difficulty'] = 'intermediate'
  if (content.toLowerCase().includes('getting started') ||
      content.toLowerCase().includes('introduction')) {
    difficulty = 'beginner'
  } else if (content.toLowerCase().includes('advanced') ||
             content.toLowerCase().includes('optimization')) {
    difficulty = 'advanced'
  }

  return {
    language: 'en', // Assume English
    contentType,
    tags,
    difficulty,
    wordCount
  }
}

/**
 * Generates embedding for content chunk using VectorizeService
 */
async function generateEmbedding(env: Env, content: string): Promise<number[]> {
  try {
    const vectorizeService = new VectorizeService(env)
    return await vectorizeService.generateEmbedding(content)
  } catch (error) {
    console.error('[LLM_FETCH] Failed to generate embedding:', error)
    return []
  }
}

/**
 * Utility functions
 */
function generateContentId(url: string): string {
  return Buffer.from(url).toString('base64').replace(/[^a-zA-Z0-9]/g, '_')
}

function extractTitle(content: string): string | null {
  // Try to find title in markdown or HTML format
  const titleMatch = content.match(/^#\s+(.+)$/m) ||
                    content.match(/<title>(.+)<\/title>/i) ||
                    content.match(/^(.+)\n[=]+$/m)
  return titleMatch ? titleMatch[1].trim() : null
}

function extractTitleFromUrl(url: string): string {
  const parts = url.split('/')
  const lastPart = parts[parts.length - 1] || parts[parts.length - 2]
  return lastPart.replace(/[-_]/g, ' ').replace('.txt', '').trim()
}

async function generateContentHash(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Content caching functions
 */
async function getCachedContent(env: Env, contentId: string): Promise<LLMContent | null> {
  try {
    const result = await env.DB.prepare(
      'SELECT * FROM llms_full_content WHERE content_id = ? AND is_active = 1'
    ).bind(contentId).first()

    if (result) {
      return {
        id: result.content_id as string,
        category: result.category as string,
        url: result.url as string,
        title: result.title as string,
        content: result.content as string,
        contentHash: result.content_hash as string,
        lastFetched: result.last_fetched as number,
        contentLength: result.content_length as number,
        relevanceScore: 0,
        chunks: result.chunks ? JSON.parse(result.chunks as string) : undefined,
        metadata: JSON.parse(result.metadata as string)
      }
    }
  } catch (error) {
    console.error('[LLM_FETCH] Failed to get cached content:', error)
  }
  return null
}

async function cacheContent(env: Env, content: LLMContent): Promise<void> {
  try {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO llms_full_content
      (content_id, category, url, title, content, content_hash, last_fetched,
       content_length, chunks, metadata, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).bind(
      content.id,
      content.category,
      content.url,
      content.title,
      content.content,
      content.contentHash,
      content.lastFetched,
      content.contentLength,
      content.chunks ? JSON.stringify(content.chunks) : null,
      JSON.stringify(content.metadata),
      Date.now(),
      Date.now()
    ).run()
  } catch (error) {
    console.error('[LLM_FETCH] Failed to cache content:', error)
  }
}

/**
 * Searches cached content with vector similarity and text-based fallback
 */
export async function searchContent(
  env: Env,
  query: string,
  options: {
    limit?: number
    minScore?: number
    categories?: string[]
    useSemanticSearch?: boolean
  } = {}
): Promise<LLMContent[]> {
  const { limit = 10, minScore = 0.3, categories, useSemanticSearch = true } = options

  // Try semantic search first if vectorization is available
  if (useSemanticSearch && env.VECTORIZE_INDEX) {
    try {
      const semanticResults = await performSemanticSearch(env, query, options)
      if (semanticResults.length > 0) {
        console.log('[LLM_FETCH] Found', semanticResults.length, 'semantic search results')
        return semanticResults
      }
    } catch (error) {
      console.error('[LLM_FETCH] Semantic search failed, falling back to text search:', error)
    }
  }

  // Fallback to text-based search
  return performTextSearch(env, query, options)
}

/**
 * Performs semantic search using VectorizeService
 */
export async function performSemanticSearch(
  env: Env,
  query: string,
  options: {
    limit?: number
    minScore?: number
    categories?: string[]
  } = {}
): Promise<LLMContent[]> {
  const { limit = 10, minScore = 0.7, categories } = options

  try {
    const vectorizeService = new VectorizeService(env)

    // Build filter for categories
    const filter: Record<string, any> = {}
    if (categories && categories.length > 0) {
      filter.category = categories
    }

    // Perform semantic search
    const searchResults = await vectorizeService.semanticSearch(query, {
      topK: limit * 2, // Get more results to filter and rank
      threshold: minScore,
      filter
    })

    console.log('[LLM_FETCH] Semantic search found', searchResults.length, 'chunk matches')

    // Group results by source and get full content
    const contentMap = new Map<string, {
      content: LLMContent | null
      chunks: SimilaritySearchResult[]
      maxScore: number
    }>()

    for (const result of searchResults) {
      const source = result.chunk.metadata.source

      if (!contentMap.has(source)) {
        contentMap.set(source, {
          content: null,
          chunks: [],
          maxScore: result.score
        })
      }

      const entry = contentMap.get(source)!
      entry.chunks.push(result)
      entry.maxScore = Math.max(entry.maxScore, result.score)
    }

    // Retrieve full content for each source
    const contentResults: LLMContent[] = []

    for (const [source, entry] of contentMap.entries()) {
      try {
        // Try to get from cache first
        const contentId = generateContentId(source)
        const cachedContent = await getCachedContent(env, contentId)

        if (cachedContent) {
          // Set relevance score based on best matching chunk
          cachedContent.relevanceScore = entry.maxScore
          contentResults.push(cachedContent)
        } else {
          // If not in cache, try to reconstruct from chunks
          const reconstructedContent = await reconstructContentFromChunks(env, entry.chunks)
          if (reconstructedContent) {
            reconstructedContent.relevanceScore = entry.maxScore
            contentResults.push(reconstructedContent)
          }
        }
      } catch (error) {
        console.error('[LLM_FETCH] Failed to retrieve content for source:', source, error)
      }
    }

    // Sort by relevance score and limit results
    contentResults.sort((a, b) => b.relevanceScore - a.relevanceScore)
    return contentResults.slice(0, limit)

  } catch (error) {
    console.error('[LLM_FETCH] Semantic search error:', error)
    throw error
  }
}

/**
 * Fallback text-based search
 */
async function performTextSearch(
  env: Env,
  query: string,
  options: {
    limit?: number
    minScore?: number
    categories?: string[]
  } = {}
): Promise<LLMContent[]> {
  const { limit = 10, categories } = options

  try {
    let sql = `
      SELECT * FROM llms_full_content
      WHERE is_active = 1
      AND (content LIKE ? OR title LIKE ?)
    `
    const params = [`%${query}%`, `%${query}%`]

    if (categories && categories.length > 0) {
      sql += ` AND category IN (${categories.map(() => '?').join(', ')})`
      params.push(...categories)
    }

    sql += ` ORDER BY last_fetched DESC LIMIT ?`
    params.push(limit.toString())

    const results = await env.DB.prepare(sql).bind(...params).all()

    return (results.results || []).map((row: any) => ({
      id: row.content_id,
      category: row.category,
      url: row.url,
      title: row.title,
      content: row.content,
      contentHash: row.content_hash,
      lastFetched: row.last_fetched,
      contentLength: row.content_length,
      relevanceScore: calculateTextRelevance(query, row.title, row.content),
      chunks: row.chunks ? JSON.parse(row.chunks) : undefined,
      metadata: JSON.parse(row.metadata)
    }))
  } catch (error) {
    console.error('[LLM_FETCH] Text search failed:', error)
    return []
  }
}

/**
 * Reconstructs content from search result chunks
 */
async function reconstructContentFromChunks(
  env: Env,
  chunks: SimilaritySearchResult[]
): Promise<LLMContent | null> {
  if (chunks.length === 0) return null

  try {
    // Get the first chunk's metadata to identify the content
    const firstChunk = chunks[0].chunk
    const source = firstChunk.metadata.source
    const category = firstChunk.metadata.category

    // Try to get full content from vectorized_chunks table
    const vectorizeService = new VectorizeService(env)
    const fullChunkContent = await vectorizeService.getChunkContent(firstChunk.id)

    if (fullChunkContent) {
      // Create a simplified LLMContent object
      return {
        id: generateContentId(source),
        category,
        url: source,
        title: firstChunk.metadata.title || extractTitleFromUrl(source),
        content: fullChunkContent.content,
        contentHash: '',
        lastFetched: Date.now(),
        contentLength: fullChunkContent.content.length,
        relevanceScore: chunks[0].score,
        metadata: {
          language: 'en',
          contentType: 'documentation' as const,
          tags: [category.toLowerCase()],
          difficulty: 'intermediate' as const,
          wordCount: fullChunkContent.content.split(/\s+/).length
        }
      }
    }

    return null
  } catch (error) {
    console.error('[LLM_FETCH] Failed to reconstruct content from chunks:', error)
    return null
  }
}

/**
 * Calculates text-based relevance score
 */
function calculateTextRelevance(query: string, title: string, content: string): number {
  const queryLower = query.toLowerCase()
  const titleLower = title.toLowerCase()
  const contentLower = content.toLowerCase()

  let score = 0

  // Title matches are weighted higher
  if (titleLower.includes(queryLower)) score += 0.5

  // Count occurrences in content
  const matches = (contentLower.match(new RegExp(queryLower, 'g')) || []).length
  score += Math.min(matches * 0.1, 0.4)

  // Word-based matching
  const queryWords = queryLower.split(/\s+/)
  for (const word of queryWords) {
    if (word.length > 2) {
      if (titleLower.includes(word)) score += 0.2
      if (contentLower.includes(word)) score += 0.1
    }
  }

  return Math.min(score, 1.0)
}

/**
 * Batch refresh content from all URLs
 */
export async function refreshAllContent(
  env: Env,
  options: FetchOptions = {}
): Promise<{ success: number; failed: number; results: LLMContent[] }> {
  const results: LLMContent[] = []
  let success = 0
  let failed = 0

  for (const [category, config] of Object.entries(LLMS_TXT_CATEGORIZED_ENHANCED)) {
    for (const url of config.urls) {
      try {
        const content = await fetchLLMContent(env, url, category, { ...options, forceRefresh: true })
        if (content) {
          results.push(content)
          success++
        } else {
          failed++
        }
      } catch (error) {
        console.error('[LLM_FETCH] Failed to refresh:', url, error)
        failed++
      }
    }
  }

  console.log('[LLM_FETCH] Batch refresh completed:', { success, failed })
  return { success, failed, results }
}
