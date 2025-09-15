/// <reference types="@cloudflare/workers-types" />
// src/modules/infra_guidance.ts
import { fetchRelevantLLMContent, type ContentRelevanceResult } from './llm_fetcher'
import { analyzeRepoStructure, type RepoStructure } from './agent_generator'

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

interface InfrastructureContext {
  repo: string
  infraType: string
  projectGoals?: string
  currentStack?: string[]
  requirements?: string
  constraints?: string
  repoStructure?: RepoStructure
}

interface InfrastructureRecommendation {
  category: string
  recommendation: string
  reasoning: string
  priority: 'high' | 'medium' | 'low'
  difficulty: 'easy' | 'medium' | 'hard'
  estimatedTime: string
  prerequisites: string[]
  steps: InfrastructureStep[]
  alternatives: Alternative[]
  warnings: string[]
  benefits: string[]
  relevantDocs: DocumentationLink[]
}

interface InfrastructureStep {
  title: string
  description: string
  command?: string
  code?: string
  configFile?: string
  configContent?: string
  verificationStep?: string
}

interface Alternative {
  name: string
  description: string
  pros: string[]
  cons: string[]
  useCase: string
}

interface DocumentationLink {
  title: string
  url: string
  relevance: string
  section?: string
}

interface GuidanceResponse {
  infraType: string
  analysisContext: string
  recommendations: InfrastructureRecommendation[]
  overallStrategy: string
  nextSteps: string[]
  estimatedComplexity: 'low' | 'medium' | 'high'
  totalEstimatedTime: string
  keyConsiderations: string[]
}

/**
 * Infrastructure type mappings and their characteristics
 */
const INFRASTRUCTURE_TYPES = {
  'cloudflare-workers': {
    name: 'Cloudflare Workers',
    description: 'Edge-first serverless compute platform',
    categories: ['Edge Compute', 'Stateful Services', 'Developer Tools & Platform'],
    defaultStack: ['workers', 'wrangler', 'typescript'],
    commonPatterns: ['api', 'middleware', 'edge-functions']
  },
  'cloudflare-pages': {
    name: 'Cloudflare Pages',
    description: 'JAMstack deployment platform with edge functions',
    categories: ['Application Hosting / Full Stack', 'Edge Compute'],
    defaultStack: ['pages', 'functions', 'frontend'],
    commonPatterns: ['static-site', 'spa', 'jamstack']
  },
  'nextjs-cloudflare': {
    name: 'Next.js on Cloudflare',
    description: 'Next.js applications deployed to Cloudflare infrastructure',
    categories: ['Application Hosting / Full Stack', 'Edge Compute'],
    defaultStack: ['nextjs', '@cloudflare/next-on-pages', 'pages'],
    commonPatterns: ['ssr', 'static-generation', 'api-routes']
  },
  'full-stack': {
    name: 'Full Stack Application',
    description: 'Complete application with frontend and backend components',
    categories: ['Application Hosting / Full Stack', 'Edge Compute', 'Stateful Services'],
    defaultStack: ['frontend', 'api', 'database', 'storage'],
    commonPatterns: ['mvc', 'microservices', 'monolith']
  },
  'api-backend': {
    name: 'API Backend',
    description: 'Backend API services and microservices',
    categories: ['Edge Compute', 'Stateful Services'],
    defaultStack: ['workers', 'd1', 'kv', 'queues'],
    commonPatterns: ['rest-api', 'graphql', 'microservices']
  },
  'static-site': {
    name: 'Static Website',
    description: 'Static websites with optional dynamic features',
    categories: ['Application Hosting / Full Stack'],
    defaultStack: ['pages', 'html', 'css', 'javascript'],
    commonPatterns: ['blog', 'portfolio', 'documentation']
  },
  'ai-application': {
    name: 'AI Application',
    description: 'Applications leveraging AI and ML capabilities',
    categories: ['AI & Agents', 'Edge Compute', 'Stateful Services'],
    defaultStack: ['workers-ai', 'vectorize', 'ai-gateway'],
    commonPatterns: ['llm-integration', 'embeddings', 'rag']
  },
  'realtime': {
    name: 'Real-time Application',
    description: 'Applications requiring real-time communication',
    categories: ['Stateful Services', 'Edge Compute'],
    defaultStack: ['durable-objects', 'websockets', 'pub-sub'],
    commonPatterns: ['chat', 'collaboration', 'gaming']
  }
}

/**
 * Generates infrastructure guidance based on context and requirements
 */
export async function generateInfrastructureGuidance(
  env: Env,
  context: InfrastructureContext
): Promise<GuidanceResponse> {
  console.log('[INFRA_GUIDANCE] Starting guidance generation for:', context.repo, 'type:', context.infraType)

  // Analyze repository structure if not provided
  if (!context.repoStructure) {
    context.repoStructure = await analyzeRepoStructure(env, context.repo)
  }

  // Get relevant documentation content
  const llmContext = {
    repo: context.repo,
    repoStructure: context.repoStructure,
    goals: context.projectGoals,
    context: `Infrastructure type: ${context.infraType}. Current stack: ${context.currentStack?.join(', ') || 'unknown'}. Requirements: ${context.requirements || 'not specified'}`
  }

  const relevantContent = await fetchRelevantLLMContent(env, llmContext)
  console.log('[INFRA_GUIDANCE] Retrieved', relevantContent.length, 'relevant documentation sources')

  // Generate recommendations based on infrastructure type
  const recommendations = await generateRecommendations(env, context, relevantContent)

  // Generate overall strategy and analysis
  const analysis = await generateOverallAnalysis(env, context, recommendations)

  return {
    infraType: context.infraType,
    analysisContext: analysis.context,
    recommendations,
    overallStrategy: analysis.strategy,
    nextSteps: analysis.nextSteps,
    estimatedComplexity: analysis.complexity,
    totalEstimatedTime: analysis.totalTime,
    keyConsiderations: analysis.considerations
  }
}

/**
 * Generates specific infrastructure recommendations
 */
async function generateRecommendations(
  env: Env,
  context: InfrastructureContext,
  relevantContent: ContentRelevanceResult[]
): Promise<InfrastructureRecommendation[]> {
  const infraConfig = INFRASTRUCTURE_TYPES[context.infraType as keyof typeof INFRASTRUCTURE_TYPES]
  if (!infraConfig) {
    throw new Error(`Unknown infrastructure type: ${context.infraType}`)
  }

  const recommendations: InfrastructureRecommendation[] = []

  // Generate category-specific recommendations
  for (const category of infraConfig.categories) {
    const categoryContent = relevantContent.filter(c =>
      c.content.category === category ||
      c.matchedKeywords.some(k => infraConfig.defaultStack.includes(k.toLowerCase()))
    )

    if (categoryContent.length > 0) {
      const recommendation = await generateCategoryRecommendation(
        env,
        context,
        category,
        categoryContent,
        infraConfig
      )
      if (recommendation) {
        recommendations.push(recommendation)
      }
    }
  }

  // Add infrastructure-specific recommendations
  const specificRecommendations = await generateInfraSpecificRecommendations(env, context, infraConfig, relevantContent)
  recommendations.push(...specificRecommendations)

  return recommendations
}

/**
 * Generates recommendation for a specific category
 */
async function generateCategoryRecommendation(
  env: Env,
  context: InfrastructureContext,
  category: string,
  content: ContentRelevanceResult[],
  infraConfig: any
): Promise<InfrastructureRecommendation | null> {
  const contentSummary = content.slice(0, 3).map(c =>
    `${c.content.title}: ${c.content.content.substring(0, 500)}...`
  ).join('\n\n')

  const prompt = `Generate infrastructure recommendation for ${category} in a ${context.infraType} project.

Project Context:
- Repository: ${context.repo}
- Infrastructure Type: ${context.infraType}
- Goals: ${context.projectGoals || 'Not specified'}
- Current Stack: ${context.currentStack?.join(', ') || 'Unknown'}
- Requirements: ${context.requirements || 'Not specified'}
- Constraints: ${context.constraints || 'None specified'}

Relevant Documentation:
${contentSummary}

Generate a JSON response with this exact structure:
{
  "category": "${category}",
  "recommendation": "Clear, specific recommendation",
  "reasoning": "Why this approach is recommended",
  "priority": "high|medium|low",
  "difficulty": "easy|medium|hard",
  "estimatedTime": "Time estimate (e.g., '2-4 hours')",
  "prerequisites": ["prerequisite1", "prerequisite2"],
  "steps": [
    {
      "title": "Step name",
      "description": "What to do",
      "command": "CLI command (optional)",
      "configFile": "filename (optional)",
      "configContent": "file content (optional)",
      "verificationStep": "How to verify (optional)"
    }
  ],
  "alternatives": [
    {
      "name": "Alternative approach",
      "description": "Brief description",
      "pros": ["advantage1", "advantage2"],
      "cons": ["disadvantage1", "disadvantage2"],
      "useCase": "When to use this alternative"
    }
  ],
  "warnings": ["warning1", "warning2"],
  "benefits": ["benefit1", "benefit2"],
  "relevantDocs": [
    {
      "title": "Documentation title",
      "url": "URL from the provided content",
      "relevance": "Why this doc is relevant"
    }
  ]
}

Focus on Cloudflare-specific solutions. Be practical and actionable.
Return ONLY valid JSON, no additional text.`

  try {
    const response = await generateAIContent(env, prompt)
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return parsed as InfrastructureRecommendation
    }
  } catch (error) {
    console.error('[INFRA_GUIDANCE] Failed to generate category recommendation:', category, error)
  }

  return null
}

/**
 * Generates infrastructure-specific recommendations
 */
async function generateInfraSpecificRecommendations(
  env: Env,
  context: InfrastructureContext,
  infraConfig: any,
  relevantContent: ContentRelevanceResult[]
): Promise<InfrastructureRecommendation[]> {
  const recommendations: InfrastructureRecommendation[] = []

  switch (context.infraType) {
    case 'nextjs-cloudflare':
      recommendations.push(...await generateNextJSRecommendations(env, context, relevantContent))
      break
    case 'ai-application':
      recommendations.push(...await generateAIRecommendations(env, context, relevantContent))
      break
    case 'realtime':
      recommendations.push(...await generateRealtimeRecommendations(env, context, relevantContent))
      break
    case 'full-stack':
      recommendations.push(...await generateFullStackRecommendations(env, context, relevantContent))
      break
    default:
      recommendations.push(...await generateGenericRecommendations(env, context, infraConfig, relevantContent))
  }

  return recommendations
}

/**
 * Generates Next.js specific recommendations
 */
async function generateNextJSRecommendations(
  env: Env,
  context: InfrastructureContext,
  relevantContent: ContentRelevanceResult[]
): Promise<InfrastructureRecommendation[]> {
  const recommendation: InfrastructureRecommendation = {
    category: 'Next.js Configuration',
    recommendation: 'Configure Next.js for Cloudflare Pages deployment using @cloudflare/next-on-pages',
    reasoning: 'Next.js requires specific configuration to work properly on Cloudflare\'s edge runtime',
    priority: 'high',
    difficulty: 'medium',
    estimatedTime: '1-2 hours',
    prerequisites: ['Next.js project', 'Node.js installed', 'Cloudflare account'],
    steps: [
      {
        title: 'Install @cloudflare/next-on-pages',
        description: 'Install the adapter for Next.js on Cloudflare Pages',
        command: 'npm install --save-dev @cloudflare/next-on-pages'
      },
      {
        title: 'Update package.json build script',
        description: 'Configure the build script to use next-on-pages',
        configFile: 'package.json',
        configContent: JSON.stringify({
          scripts: {
            build: "next-on-pages",
            preview: "wrangler pages dev .vercel/output/static --compatibility-date=2024-01-01"
          }
        }, null, 2)
      },
      {
        title: 'Configure next.config.js',
        description: 'Add Cloudflare-specific configuration',
        configFile: 'next.config.js',
        configContent: `/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    runtime: 'edge'
  }
}

module.exports = nextConfig`
      },
      {
        title: 'Set up environment variables',
        description: 'Configure environment variables for Cloudflare Pages',
        verificationStep: 'Check Cloudflare Pages dashboard for environment variables'
      }
    ],
    alternatives: [
      {
        name: 'Static Export',
        description: 'Export Next.js as static files',
        pros: ['Simpler deployment', 'Better performance for static content'],
        cons: ['No server-side features', 'Limited dynamic functionality'],
        useCase: 'When your Next.js app is primarily static content'
      }
    ],
    warnings: [
      'Some Next.js features may not work on edge runtime',
      'API routes need to be compatible with Cloudflare Workers'
    ],
    benefits: [
      'Global edge deployment',
      'Automatic scaling',
      'Integrated with Cloudflare security features'
    ],
    relevantDocs: [
      {
        title: 'Cloudflare Pages Framework Guide',
        url: 'https://developers.cloudflare.com/pages/',
        relevance: 'Complete guide for deploying frameworks to Pages'
      }
    ]
  }

  return [recommendation]
}

/**
 * Generates AI application recommendations
 */
async function generateAIRecommendations(
  env: Env,
  context: InfrastructureContext,
  relevantContent: ContentRelevanceResult[]
): Promise<InfrastructureRecommendation[]> {
  const recommendations: InfrastructureRecommendation[] = [
    {
      category: 'Workers AI Integration',
      recommendation: 'Integrate Cloudflare Workers AI for LLM processing',
      reasoning: 'Workers AI provides edge-native AI inference with built-in models',
      priority: 'high',
      difficulty: 'medium',
      estimatedTime: '2-4 hours',
      prerequisites: ['Cloudflare Workers project', 'AI binding in wrangler.toml'],
      steps: [
        {
          title: 'Add AI binding to wrangler.toml',
          description: 'Configure the AI binding for your worker',
          configFile: 'wrangler.toml',
          configContent: `[ai]
binding = "AI"`
        },
        {
          title: 'Implement AI function',
          description: 'Create a function to interact with Workers AI',
          code: `export default {
  async fetch(request, env) {
    const response = await env.AI.run('@cf/meta/llama-2-7b-chat-int8', {
      messages: [{ role: 'user', content: 'Hello!' }]
    })
    return Response.json(response)
  }
}`
        }
      ],
      alternatives: [
        {
          name: 'AI Gateway',
          description: 'Use AI Gateway for external AI services',
          pros: ['Support for multiple AI providers', 'Caching and rate limiting'],
          cons: ['Additional configuration', 'External API dependencies'],
          useCase: 'When you need specific models not available in Workers AI'
        }
      ],
      warnings: ['Workers AI has usage limits', 'Some models may have specific requirements'],
      benefits: ['Low latency inference', 'No cold starts', 'Integrated billing'],
      relevantDocs: [
        {
          title: 'Workers AI Documentation',
          url: 'https://developers.cloudflare.com/workers-ai/',
          relevance: 'Complete guide for AI integration'
        }
      ]
    },
    {
      category: 'Vector Database',
      recommendation: 'Use Cloudflare Vectorize for embeddings and similarity search',
      reasoning: 'Vectorize provides native vector database capabilities for RAG applications',
      priority: 'medium',
      difficulty: 'medium',
      estimatedTime: '3-5 hours',
      prerequisites: ['Understanding of embeddings', 'Vectorize binding setup'],
      steps: [
        {
          title: 'Create Vectorize index',
          description: 'Create a vector index for your embeddings',
          command: 'wrangler vectorize create my-index --dimensions=768 --metric=cosine'
        },
        {
          title: 'Add Vectorize binding',
          description: 'Configure the binding in wrangler.toml',
          configFile: 'wrangler.toml',
          configContent: `[[vectorize]]
binding = "VECTORIZE"
index_name = "my-index"`
        }
      ],
      alternatives: [],
      warnings: ['Vectorize is in beta', 'Consider embedding model dimensions'],
      benefits: ['Native vector operations', 'Integrated with Workers', 'Automatic scaling'],
      relevantDocs: [
        {
          title: 'Vectorize Documentation',
          url: 'https://developers.cloudflare.com/vectorize/',
          relevance: 'Vector database setup and usage'
        }
      ]
    }
  ]

  return recommendations
}

/**
 * Generates real-time application recommendations
 */
async function generateRealtimeRecommendations(
  env: Env,
  context: InfrastructureContext,
  relevantContent: ContentRelevanceResult[]
): Promise<InfrastructureRecommendation[]> {
  const recommendation: InfrastructureRecommendation = {
    category: 'Real-time Communication',
    recommendation: 'Implement WebSockets with Durable Objects for real-time features',
    reasoning: 'Durable Objects provide stateful, globally distributed WebSocket handling',
    priority: 'high',
    difficulty: 'hard',
    estimatedTime: '4-8 hours',
    prerequisites: ['Understanding of WebSockets', 'Durable Objects knowledge'],
    steps: [
      {
        title: 'Create Durable Object class',
        description: 'Implement a Durable Object to handle WebSocket connections',
        code: `export class ChatRoom {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.sessions = new Set()
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 400 })
    }

    const { 0: client, 1: server } = new WebSocketPair()
    server.accept()

    this.sessions.add(server)

    server.addEventListener('message', event => {
      this.broadcast(event.data, server)
    })

    return new Response(null, { status: 101, webSocket: client })
  }

  broadcast(message, sender) {
    for (const session of this.sessions) {
      if (session !== sender) {
        session.send(message)
      }
    }
  }
}`
      },
      {
        title: 'Configure Durable Object binding',
        description: 'Add the Durable Object binding to wrangler.toml',
        configFile: 'wrangler.toml',
        configContent: `[durable_objects]
bindings = [
  { name = "CHAT_ROOM", class_name = "ChatRoom" }
]`
      }
    ],
    alternatives: [
      {
        name: 'Pub/Sub',
        description: 'Use Cloudflare Pub/Sub for message distribution',
        pros: ['Simpler implementation', 'Built-in scaling'],
        cons: ['Less control over connections', 'Additional service dependency'],
        useCase: 'When you need simple message broadcasting without complex state'
      }
    ],
    warnings: [
      'WebSocket connections count against Durable Object limits',
      'Consider connection cleanup and error handling'
    ],
    benefits: [
      'Globally distributed state',
      'Automatic failover',
      'Integrated with Workers ecosystem'
    ],
    relevantDocs: [
      {
        title: 'Durable Objects Documentation',
        url: 'https://developers.cloudflare.com/durable-objects/',
        relevance: 'Stateful object implementation guide'
      }
    ]
  }

  return [recommendation]
}

/**
 * Generates full-stack application recommendations
 */
async function generateFullStackRecommendations(
  env: Env,
  context: InfrastructureContext,
  relevantContent: ContentRelevanceResult[]
): Promise<InfrastructureRecommendation[]> {
  return [
    {
      category: 'Database Setup',
      recommendation: 'Use Cloudflare D1 for relational data storage',
      reasoning: 'D1 provides SQLite-compatible database with global replication',
      priority: 'high',
      difficulty: 'easy',
      estimatedTime: '1-2 hours',
      prerequisites: ['Basic SQL knowledge'],
      steps: [
        {
          title: 'Create D1 database',
          description: 'Create a new D1 database instance',
          command: 'wrangler d1 create my-database'
        },
        {
          title: 'Add D1 binding',
          description: 'Configure the database binding',
          configFile: 'wrangler.toml',
          configContent: `[[d1_databases]]
binding = "DB"
database_name = "my-database"
database_id = "your-database-id"`
        }
      ],
      alternatives: [
        {
          name: 'External Database',
          description: 'Use external database with Hyperdrive',
          pros: ['More features', 'Existing database compatibility'],
          cons: ['Additional latency', 'More complex setup'],
          useCase: 'When you need features not available in D1'
        }
      ],
      warnings: ['D1 has size limitations', 'Consider data migration strategies'],
      benefits: ['Global replication', 'SQLite compatibility', 'Integrated billing'],
      relevantDocs: [
        {
          title: 'D1 Database Documentation',
          url: 'https://developers.cloudflare.com/d1/',
          relevance: 'Database setup and usage guide'
        }
      ]
    }
  ]
}

/**
 * Generates generic recommendations for any infrastructure type
 */
async function generateGenericRecommendations(
  env: Env,
  context: InfrastructureContext,
  infraConfig: any,
  relevantContent: ContentRelevanceResult[]
): Promise<InfrastructureRecommendation[]> {
  const recommendation: InfrastructureRecommendation = {
    category: 'Basic Setup',
    recommendation: `Set up ${infraConfig.name} with recommended configuration`,
    reasoning: `Standard setup for ${infraConfig.description}`,
    priority: 'high',
    difficulty: 'easy',
    estimatedTime: '30-60 minutes',
    prerequisites: ['Cloudflare account', 'Wrangler CLI installed'],
    steps: [
      {
        title: 'Initialize project',
        description: 'Create a new Cloudflare project',
        command: 'wrangler init my-project'
      },
      {
        title: 'Configure wrangler.toml',
        description: 'Set up basic configuration',
        configFile: 'wrangler.toml',
        configContent: `name = "my-project"
compatibility_date = "2024-01-01"`
      }
    ],
    alternatives: [],
    warnings: ['Ensure compatibility date is current'],
    benefits: ['Quick deployment', 'Global distribution'],
    relevantDocs: [
      {
        title: 'Getting Started Guide',
        url: 'https://developers.cloudflare.com/workers/',
        relevance: 'Basic setup instructions'
      }
    ]
  }

  return [recommendation]
}

/**
 * Generates overall analysis and strategy
 */
async function generateOverallAnalysis(
  env: Env,
  context: InfrastructureContext,
  recommendations: InfrastructureRecommendation[]
): Promise<{
  context: string
  strategy: string
  nextSteps: string[]
  complexity: 'low' | 'medium' | 'high'
  totalTime: string
  considerations: string[]
}> {
  const prompt = `Analyze the infrastructure recommendations and provide overall guidance.

Infrastructure Type: ${context.infraType}
Repository: ${context.repo}
Goals: ${context.projectGoals || 'Not specified'}
Requirements: ${context.requirements || 'Not specified'}

Recommendations Summary:
${recommendations.map((r, i) => `${i + 1}. ${r.category}: ${r.recommendation} (Priority: ${r.priority}, Difficulty: ${r.difficulty})`).join('\n')}

Generate a JSON response with:
{
  "context": "Brief analysis of the project context and requirements",
  "strategy": "Overall implementation strategy and approach",
  "nextSteps": ["step1", "step2", "step3"],
  "complexity": "low|medium|high",
  "totalTime": "Total estimated time",
  "considerations": ["consideration1", "consideration2"]
}

Focus on practical guidance and implementation order.
Return ONLY valid JSON.`

  try {
    const response = await generateAIContent(env, prompt)
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0])
    }
  } catch (error) {
    console.error('[INFRA_GUIDANCE] Failed to generate overall analysis:', error)
  }

  // Fallback analysis
  const totalTimeMinutes = recommendations.reduce((acc, r) => {
    const timeMatch = r.estimatedTime.match(/(\d+)/)
    return acc + (timeMatch ? parseInt(timeMatch[1]) * 60 : 120)
  }, 0)

  const complexity = recommendations.some(r => r.difficulty === 'hard') ? 'high' :
                    recommendations.some(r => r.difficulty === 'medium') ? 'medium' : 'low'

  return {
    context: `${context.infraType} project requiring ${recommendations.length} infrastructure components`,
    strategy: `Implement high-priority recommendations first, focusing on core infrastructure setup`,
    nextSteps: recommendations
      .sort((a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1))
      .slice(0, 3)
      .map(r => `Set up ${r.category}`),
    complexity,
    totalTime: `${Math.round(totalTimeMinutes / 60)} hours`,
    considerations: [
      'Consider Cloudflare service limits and quotas',
      'Plan for proper error handling and monitoring',
      'Set up development and production environments'
    ]
  }
}

/**
 * Generates AI content using Cloudflare AI
 */
async function generateAIContent(env: Env, prompt: string): Promise<string> {
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${env.SUMMARY_CF_MODEL}`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000
      })
    })

    if (!response.ok) {
      throw new Error(`AI API failed: ${response.status}`)
    }

    const result = await response.json() as any
    return result?.result?.response || result?.result?.content || 'Failed to generate content'
  } catch (error) {
    console.error('[INFRA_GUIDANCE] AI content generation failed:', error)
    return 'Error generating AI content'
  }
}

/**
 * Gets infrastructure guidance for a specific type
 */
export async function getInfrastructureGuidance(
  env: Env,
  infraType: string,
  repo: string,
  options: {
    projectGoals?: string
    currentStack?: string[]
    requirements?: string
    constraints?: string
  } = {}
): Promise<GuidanceResponse> {
  const context: InfrastructureContext = {
    repo,
    infraType,
    projectGoals: options.projectGoals,
    currentStack: options.currentStack,
    requirements: options.requirements,
    constraints: options.constraints
  }

  return await generateInfrastructureGuidance(env, context)
}

/**
 * Lists available infrastructure types
 */
export function listInfrastructureTypes(): Array<{
  id: string
  name: string
  description: string
  commonPatterns: string[]
}> {
  return Object.entries(INFRASTRUCTURE_TYPES).map(([id, config]) => ({
    id,
    name: config.name,
    description: config.description,
    commonPatterns: config.commonPatterns
  }))
}

/**
 * Validates infrastructure type
 */
export function validateInfrastructureType(infraType: string): boolean {
  return infraType in INFRASTRUCTURE_TYPES
}
