import type { SandboxConflictResult } from './sandbox_executor'

export interface ConflictAnalysisPrompt {
  filePath: string
  fileType: string
  conflictRegions: SandboxConflictRegion[]
  beforeContext?: string
  afterContext?: string
  prTitle?: string
  prDescription?: string
}

export interface AISuggestion {
  filePath: string
  confidence: number
  reasoning: string
  suggestedResolution: string
  alternatives?: string[]
  riskLevel: 'low' | 'medium' | 'high'
}

interface Env {
  AI?: {
    run: (model: string, payload: unknown) => Promise<any>
  }
  MERGE_CONFLICT_MODEL?: string
}

interface AIResponseShape {
  reasoning?: string
  suggestedResolution?: string
  confidence?: number
  riskLevel?: 'low' | 'medium' | 'high'
  alternatives?: string[]
}

const DEFAULT_MODEL = '@cf/meta/llama-3.1-70b-instruct'

/**
 * Formats the conflict payload into a conversational prompt suitable for Workers AI. The
 * suggestion is requested in JSON to simplify downstream parsing.
 */
function buildPrompt(payload: ConflictAnalysisPrompt): string {
  const baseContext = [
    `You are a merge conflict resolution expert. Analyze the provided git conflict and produce a JSON response following the schema.`,
    `File: ${payload.filePath}`,
    `Language: ${payload.fileType}`,
  ]

  if (payload.prTitle || payload.prDescription) {
    baseContext.push('Pull Request Context:')
    if (payload.prTitle) {
      baseContext.push(`Title: ${payload.prTitle}`)
    }
    if (payload.prDescription) {
      baseContext.push(`Description: ${payload.prDescription}`)
    }
  }

  for (const region of payload.conflictRegions) {
    baseContext.push('CONFLICT REGION:')
    baseContext.push('<<<<<<< CURRENT BRANCH')
    baseContext.push(region.currentContent)
    baseContext.push('=======')
    baseContext.push(region.incomingContent)
    baseContext.push('>>>>>>> INCOMING BRANCH')
  }

  baseContext.push('Respond strictly in JSON:')
  baseContext.push(`{
  "reasoning": "Why this is the likely correct resolution",
  "suggestedResolution": "The merged code that resolves the conflict",
  "confidence": 0.0,
  "riskLevel": "low",
  "alternatives": []
}`)

  return baseContext.join('\n\n')
}

/**
 * Invokes Workers AI to generate conflict resolution suggestions for each conflicted file.
 *
 * @param env - Worker environment including the AI binding.
 * @param conflicts - Structured conflict data returned from the sandbox executor.
 * @param prContext - Contextual information about the pull request.
 * @returns List of AI generated suggestions.
 */
export async function analyzeConflicts(
  env: Env,
  conflicts: SandboxConflictResult,
  prContext: { title: string; description: string }
): Promise<AISuggestion[]> {
  if (!env.AI || typeof env.AI.run !== 'function') {
    throw new Error('Workers AI binding (env.AI) is required for conflict analysis')
  }

  const suggestions: AISuggestion[] = []
  const model = env.MERGE_CONFLICT_MODEL ?? DEFAULT_MODEL

  for (const file of conflicts.conflictFiles) {
    const prompt = buildPrompt({
      filePath: file.path,
      fileType: inferLanguage(file.path),
      conflictRegions: file.conflicts,
      prTitle: prContext.title,
      prDescription: prContext.description,
    })

    const result = await env.AI.run(model, {
      messages: [
        { role: 'system', content: 'You help GitHub users resolve merge conflicts safely.' },
        { role: 'user', content: prompt },
      ],
    })

    const aiPayload = normaliseAIResponse(result)

    suggestions.push({
      filePath: file.path,
      confidence: clamp(aiPayload.confidence ?? 0.5),
      reasoning: aiPayload.reasoning ?? 'No reasoning provided',
      suggestedResolution: aiPayload.suggestedResolution ?? '',
      alternatives: aiPayload.alternatives ?? [],
      riskLevel: aiPayload.riskLevel ?? 'medium',
    })
  }

  return suggestions
}

function inferLanguage(path: string): string {
  const extension = path.split('.').pop() ?? ''
  return extension.toLowerCase()
}

function clamp(value: number): number {
  if (Number.isNaN(value)) {
    return 0
  }
  return Math.min(1, Math.max(0, value))
}

function normaliseAIResponse(result: any): AIResponseShape {
  if (!result) {
    return {}
  }

  if (typeof result === 'string') {
    return parseJson(result)
  }

  if (result.response) {
    return parseJson(result.response)
  }

  if (result.result) {
    return parseJson(result.result)
  }

  if (Array.isArray(result) && result.length > 0) {
    return normaliseAIResponse(result[0])
  }

  if (result.output) {
    return parseJson(result.output)
  }

  return {}
}

function parseJson(value: string): AIResponseShape {
  try {
    return JSON.parse(value) as AIResponseShape
  } catch (error) {
    console.warn('[AI] Failed to parse AI response as JSON', error)
    return {}
  }
}
