/// <reference types="@cloudflare/workers-types" />
// src/modules/agent_generator.ts
import { ghREST } from '../github'

type Env = {
  DB: D1Database
  GITHUB_APP_ID: string
  GITHUB_PRIVATE_KEY: string
  CF_ACCOUNT_ID: string
  CF_API_TOKEN: string
  SUMMARY_CF_MODEL: string
  VECTORIZE?: Vectorize
  R2?: R2Bucket
}

interface ProjectContext {
  repo: string
  description?: string
  goals?: string
  outcome?: string
  context?: string
  repoStructure?: RepoStructure
  llmContent?: LLMContent[]
}

export interface RepoStructure {
  hasWrangler: boolean
  hasNextConfig: boolean
  hasPackageJson: boolean
  hasClaspJson: boolean
  hasAppsScriptJson: boolean
  hasPythonFiles: boolean
  projectType: 'cloudflare-worker' | 'cloudflare-pages' | 'nextjs-pages' | 'apps-script' | 'python' | 'unknown'
  dependencies: string[]
  devDependencies: string[]
}

interface LLMContent {
  category: string
  url: string
  content: string
  relevanceScore: number
}

interface AgentAssets {
  agentMd: string
  promptMd: string
  prdMd: string
  projectTasksJson: ProjectTasksSchema
}

interface ProjectTasksSchema {
  epics: Epic[]
}

interface Epic {
  title: string
  description: string
  tasks: Task[]
}

interface Task {
  title: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'on_hold'
  steps: string[]
  success_criteria: string
  unit_test_criteria: string
  dependencies: Dependency[]
  dependents: Dependency[]
}

interface Dependency {
  worker: string
  task: string
}

/**
 * LLMs.txt categorized URLs for Cloudflare documentation
 */
const LLMS_TXT_CATEGORIZED = {
  "Application Hosting / Full Stack": [
    "https://developers.cloudflare.com/pages/llms-full.txt",
    "https://developers.cloudflare.com/containers/llms-full.txt",
    "https://developers.cloudflare.com/developer-platform/llms-full.txt"
  ],
  "AI & Agents": [
    "https://developers.cloudflare.com/agents/llms-full.txt",
    "https://developers.cloudflare.com/ai-gateway/llms-full.txt",
    "https://developers.cloudflare.com/workers-ai/llms-full.txt",
    "https://developers.cloudflare.com/autorag/llms-full.txt"
  ],
  "Edge Compute": [
    "https://developers.cloudflare.com/workers/llms-full.txt",
    "https://developers.cloudflare.com/workflows/llms-full.txt"
  ],
  "Stateful Services (Databases, Storage, Messaging, Realtime)": [
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
  "Developer Tools & Platform": [
    "https://developers.cloudflare.com/logs/llms-full.txt",
    "https://developers.cloudflare.com/developer-spotlight/llms-full.txt"
  ],
  "Browser/Rendering/Images/Media": [
    "https://developers.cloudflare.com/browser-rendering/llms-full.txt",
    "https://developers.cloudflare.com/images/llms-full.txt",
    "https://developers.cloudflare.com/stream/llms-full.txt"
  ],
  "Other/General": [
    "https://developers.cloudflare.com/llms.txt",
    "https://developers.cloudflare.com/workers/prompt.txt",
    "https://developers.cloudflare.com/zaraz/llms-full.txt"
  ]
}

/**
 * Generates complete agent configuration assets for a project
 */
export async function generateAgentAssets(
  env: Env,
  context: ProjectContext
): Promise<AgentAssets> {
  console.log('[AGENT_GEN] Starting agent asset generation for:', context.repo)

  // Analyze repo structure if not provided
  if (!context.repoStructure) {
    context.repoStructure = await analyzeRepoStructure(env, context.repo)
  }

  // Fetch relevant LLM content
  if (!context.llmContent) {
    context.llmContent = await fetchRelevantLLMContent(env, context)
  }

  console.log('[AGENT_GEN] Project type detected:', context.repoStructure.projectType)
  console.log('[AGENT_GEN] LLM content sources:', context.llmContent.length)

  // Generate all assets using AI
  const [agentMd, promptMd, prdMd, projectTasksJson] = await Promise.all([
    generateAgentMd(env, context),
    generatePromptMd(env, context),
    generatePRDMd(env, context),
    generateProjectTasksJson(env, context)
  ])

  return {
    agentMd,
    promptMd,
    prdMd,
    projectTasksJson
  }
}

/**
 * Analyzes repository structure to determine project type and dependencies
 */
export async function analyzeRepoStructure(env: Env, repo: string): Promise<RepoStructure> {
  console.log('[AGENT_GEN] Analyzing repo structure for:', repo)

  // This would typically fetch from GitHub API to analyze files
  // For now, return a default structure - this will be enhanced in task-82
  return {
    hasWrangler: true, // Default assumption for Cloudflare Workers
    hasNextConfig: false,
    hasPackageJson: true,
    hasClaspJson: false,
    hasAppsScriptJson: false,
    hasPythonFiles: false,
    projectType: 'cloudflare-worker',
    dependencies: ['@cloudflare/workers-types', 'hono'],
    devDependencies: ['wrangler', 'typescript']
  }
}

/**
 * Fetches relevant LLM content based on project context
 */
export async function fetchRelevantLLMContent(env: Env, context: ProjectContext): Promise<LLMContent[]> {
  console.log('[AGENT_GEN] Fetching relevant LLM content')

  const relevantCategories = determineRelevantCategories(context.repoStructure!)
  const llmContent: LLMContent[] = []

  for (const category of relevantCategories) {
    const urls = LLMS_TXT_CATEGORIZED[category as keyof typeof LLMS_TXT_CATEGORIZED]
    if (!urls) continue

    for (const url of urls) {
      try {
        console.log('[AGENT_GEN] Fetching:', url)
        const response = await fetch(url)
        if (response.ok) {
          const content = await response.text()
          llmContent.push({
            category,
            url,
            content: content.slice(0, 10000), // Limit content size
            relevanceScore: 0.8 // Will be enhanced with vectorization
          })
        }
      } catch (error) {
        console.error('[AGENT_GEN] Failed to fetch:', url, error)
      }
    }
  }

  return llmContent
}

/**
 * Determines which LLM content categories are relevant based on project type
 */
function determineRelevantCategories(repoStructure: RepoStructure): string[] {
  const categories: string[] = []

  switch (repoStructure.projectType) {
    case 'cloudflare-worker':
      categories.push('Edge Compute', 'Stateful Services (Databases, Storage, Messaging, Realtime)')
      if (repoStructure.hasNextConfig) {
        categories.push('Application Hosting / Full Stack')
      }
      break
    case 'cloudflare-pages':
      categories.push('Application Hosting / Full Stack', 'Edge Compute')
      break
    case 'nextjs-pages':
      categories.push('Application Hosting / Full Stack')
      break
    case 'apps-script':
      // Apps Script doesn't use Cloudflare docs, but we'll add general
      categories.push('Other/General')
      break
    case 'python':
      categories.push('Other/General')
      break
    default:
      categories.push('Other/General', 'Edge Compute')
  }

  // Always include AI & Agents for agent-related projects
  categories.push('AI & Agents')
  categories.push('Developer Tools & Platform')

  return Array.from(new Set(categories)) // Remove duplicates
}

/**
 * Generates AGENT.md file content
 */
async function generateAgentMd(env: Env, context: ProjectContext): Promise<string> {
  const prompt = `Generate a comprehensive AGENT.md file for a ${context.repoStructure?.projectType} project.

Repository: ${context.repo}
Project Type: ${context.repoStructure?.projectType}
Description: ${context.description || 'Not provided'}
Goals: ${context.goals || 'Not specified'}
Outcome: ${context.outcome || 'Not specified'}

Dependencies: ${context.repoStructure?.dependencies.join(', ') || 'None listed'}

The AGENT.md should include:
- Project overview and purpose
- Agent capabilities and scope
- Technical architecture overview
- Key integrations and dependencies
- Deployment and configuration notes
- Usage examples

Focus on Cloudflare Workers + Pages context where applicable.
Write in clear, technical markdown format.`

  return await generateAIContent(env, prompt)
}

/**
 * Generates prompt.md file content
 */
async function generatePromptMd(env: Env, context: ProjectContext): Promise<string> {
  const prompt = `Generate a detailed prompt.md file for an AI agent working on a ${context.repoStructure?.projectType} project.

Repository: ${context.repo}
Project Type: ${context.repoStructure?.projectType}
Context: ${context.context || 'Not provided'}

The prompt.md should include:
- Clear agent role and responsibilities
- Technical constraints and guardrails
- Code style and best practices
- Cloudflare-specific development patterns
- Error handling guidelines
- Testing and deployment procedures

Make it specific to ${context.repoStructure?.projectType} development with Cloudflare infrastructure.
Write in clear markdown format with actionable directives.`

  return await generateAIContent(env, prompt)
}

/**
 * Generates PRD.md (Product Requirements Document) content
 */
async function generatePRDMd(env: Env, context: ProjectContext): Promise<string> {
  const prompt = `Generate a Product Requirements Document (PRD.md) for a ${context.repoStructure?.projectType} project.

Repository: ${context.repo}
Project Type: ${context.repoStructure?.projectType}
Description: ${context.description || 'Not provided'}
Goals: ${context.goals || 'Not specified'}
Expected Outcome: ${context.outcome || 'Not specified'}

The PRD.md should include:
- Vision and overview
- Goals and objectives
- Technical requirements
- Functional requirements
- Non-functional requirements (performance, scalability)
- Guardrails and constraints
- Success criteria and metrics
- Deployment and rollout plan

Focus on Cloudflare Workers + Pages capabilities and limitations.
Include specific technical considerations for edge computing.
Write in structured markdown format.`

  return await generateAIContent(env, prompt)
}

/**
 * Generates project_tasks.json following the OpenAPI schema
 */
async function generateProjectTasksJson(env: Env, context: ProjectContext): Promise<ProjectTasksSchema> {
  const llmContextSummary = context.llmContent?.map(c => `${c.category}: ${c.url}`).join('\n') || 'No LLM content available'

  const prompt = `Generate a comprehensive project_tasks.json for a ${context.repoStructure?.projectType} project using Cloudflare Workers + Pages.

Repository: ${context.repo}
Project Type: ${context.repoStructure?.projectType}
Goals: ${context.goals || 'Not specified'}
Has Next.js: ${context.repoStructure?.hasNextConfig}
Has Wrangler: ${context.repoStructure?.hasWrangler}

Available Cloudflare Documentation:
${llmContextSummary}

Generate a JSON structure with epics and tasks following this exact schema:
{
  "epics": [
    {
      "title": "Epic Name",
      "description": "Epic description",
      "tasks": [
        {
          "title": "Task Name",
          "description": "User story format: As a developer, I need...",
          "status": "pending",
          "steps": ["Step 1", "Step 2", "Step 3"],
          "success_criteria": "Conditions for success",
          "unit_test_criteria": "How to validate with tests",
          "dependencies": [],
          "dependents": []
        }
      ]
    }
  ]
}

Create epics for:
1. Project Setup & Configuration
2. Core Development
3. Cloudflare Integration
4. Deployment & Configuration
5. Testing & Quality Assurance

For Cloudflare Workers + Pages projects, include tasks for:
- Installing and configuring @cloudflare/next-on-pages if Next.js detected
- Setting up wrangler.toml configuration
- Environment variable management
- D1 database setup if applicable
- R2 storage integration if applicable
- Deployment to Cloudflare Pages

Make tasks specific, actionable, and include proper success criteria.
Return ONLY valid JSON, no additional text.`

  const jsonResponse = await generateAIContent(env, prompt)

  try {
    // Extract JSON from response if it's wrapped in markdown or other text
    const jsonMatch = jsonResponse.match(/\{[\s\S]*\}/)
    const jsonStr = jsonMatch ? jsonMatch[0] : jsonResponse

    const parsed = JSON.parse(jsonStr) as ProjectTasksSchema

    // Validate basic structure
    if (!parsed.epics || !Array.isArray(parsed.epics)) {
      throw new Error('Invalid epics structure')
    }

    return parsed
  } catch (error) {
    console.error('[AGENT_GEN] Failed to parse project tasks JSON:', error)

    // Return fallback structure
    return {
      epics: [
        {
          title: "Project Setup & Configuration",
          description: "Set up the basic project structure and configuration for Cloudflare deployment",
          tasks: [
            {
              title: "Configure Cloudflare Pages Deployment",
              description: "As a developer, I need the project to be configured for seamless deployment to Cloudflare Pages to automate our CI/CD pipeline.",
              status: "pending",
              steps: [
                "Install and configure @cloudflare/next-on-pages if Next.js is detected",
                "Update package.json build script to use next-on-pages",
                "Set up environment variable handling for backend API URLs",
                "Create wrangler.toml file for local development",
                "Document deployment process and required environment variables"
              ],
              success_criteria: "The project can be successfully built using the next-on-pages command and deployed to Cloudflare Pages with functional API connections.",
              unit_test_criteria: "This is a configuration task, validated by successful build and deployment to Cloudflare Pages environment.",
              dependencies: [],
              dependents: []
            }
          ]
        }
      ]
    }
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
    console.error('[AGENT_GEN] AI content generation failed:', error)
    return `# Error\n\nFailed to generate content: ${error}\n\nPlease try again or contact support.`
  }
}

/**
 * Saves generated assets to R2 bucket (for API requests)
 * @deprecated Use uploadAgentAssets from r2_service.ts instead
 */
export async function saveAssetsToR2(
  env: Env,
  assets: AgentAssets,
  repo: string
): Promise<{ [key: string]: string }> {
  // Import the new R2 service
  const { uploadAgentAssets } = await import('./r2_service')
  return await uploadAgentAssets(env, assets, repo)
}

/**
 * Creates GitHub commits for generated assets (for slash commands)
 */
export async function commitAssetsToGitHub(
  env: Env,
  assets: AgentAssets,
  repo: string,
  token: string,
  branch: string = 'main'
): Promise<{ commitSha: string; commitUrl: string }> {
  console.log('[AGENT_GEN] Committing assets to GitHub:', repo)

  const [owner, repoName] = repo.split('/')

  try {
    // Get current branch SHA
    const branchInfo = await ghREST(token, 'GET', `/repos/${owner}/${repoName}/branches/${branch}`)
    const currentSha = (branchInfo as any).commit.sha

    // Create blob for each file
    const files = [
      { path: '.agents/AGENT.md', content: assets.agentMd },
      { path: '.agents/prompt.md', content: assets.promptMd },
      { path: '.agents/PRD.md', content: assets.prdMd },
      { path: '.agents/project_tasks.json', content: JSON.stringify(assets.projectTasksJson, null, 2) }
    ]

    const tree: any[] = []

    for (const file of files) {
      const blob = await ghREST(token, 'POST', `/repos/${owner}/${repoName}/git/blobs`, {
        content: Buffer.from(file.content).toString('base64'),
        encoding: 'base64'
      })

      tree.push({
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: (blob as any).sha
      })
    }

    // Create tree
    const treeResponse = await ghREST(token, 'POST', `/repos/${owner}/${repoName}/git/trees`, {
      base_tree: currentSha,
      tree
    })

    // Create commit
    const commit = await ghREST(token, 'POST', `/repos/${owner}/${repoName}/git/commits`, {
      message: '🤖 Generated agent configuration assets\n\nAdded .agents/ folder with:\n- AGENT.md: Agent overview and capabilities\n- prompt.md: AI agent instructions\n- PRD.md: Product requirements\n- project_tasks.json: Project task breakdown',
      tree: (treeResponse as any).sha,
      parents: [currentSha]
    })

    // Update branch reference
    await ghREST(token, 'PATCH', `/repos/${owner}/${repoName}/git/refs/heads/${branch}`, {
      sha: (commit as any).sha
    })

    console.log('[AGENT_GEN] Assets committed successfully:', (commit as any).sha)

    return {
      commitSha: (commit as any).sha,
      commitUrl: (commit as any).html_url
    }
  } catch (error) {
    console.error('[AGENT_GEN] Failed to commit assets to GitHub:', error)
    throw error
  }
}
