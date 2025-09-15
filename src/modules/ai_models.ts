// src/modules/ai_models.ts

import {
    runAIOrchestrator,
    shouldUseOrchestrator,
    type OrchestratorTaskKind
} from './ai_orchestrator';

// ---------- Policy (Enhanced with Orchestration) ----------
export const POLICY = {
  SMALL_PR_LINES: 300,
  LARGE_PR_FILES: 5,
  AI_TIMEOUT_MS: 20000,

  // Orchestration settings
  USE_AI_ORCHESTRATOR: true,  // Can be overridden by environment variable
  ORCHESTRATOR_FALLBACK_TO_RULES: true,  // Fall back to rule-based selection if orchestrator fails
  ORCHESTRATOR_CACHE_TTL_MS: 300000,  // 5 minutes cache for similar requests

  // Known async_queue models (latency-prone in CF)
  ASYNC_QUEUE_MODELS: new Set<string>([
    '@cf/meta/llama-4-scout-17b-16e-instruct',
    '@cf/openai/gpt-oss-120b',
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  ]),
  // Models with >= 120k effective context
  VERY_LONG_CTX_MODELS: [
    '@cf/meta/llama-4-scout-17b-16e-instruct', // 131k
    '@cf/openai/gpt-oss-120b',                 // 128k
    '@cf/meta/llama-3.2-3b-instruct',          // 128k per catalog
  ],
} as const

// ---------- Model Metadata ----------
type Pricing = { input?: number; output?: number } // $ per 1M tokens
type ModelMeta = {
  id: string
  use_cases: string[]
  prompt_design: string
  supports_json: boolean            // true only if you've validated structured outputs
  supports_function_calling: boolean
  context_window?: number           // tokens
  pricing?: Pricing                 // rough list pricing for policy decisions
  async_queue?: boolean             // latency-prone (explicit flag complements POLICY list)
  notes?: string                    // tag assumptions / caveats
}

// Primary LLMs
export const MODELS: Record<string, ModelMeta> = {
  // DEFAULT mainline for GitHub code eval
  DEFAULT: {
    id: '@cf/qwen/qwen2.5-coder-32b-instruct',
    use_cases: ['code-diff-review', 'refactoring', 'test-writing', 'explain-diffs'],
    prompt_design:
      'Code-specialized, strong editor/refactor/test gen. Best general choice for PR reviews.',
    supports_json: true, // ✅ validated in practice
    supports_function_calling: false,
    context_window: 32_768,
    pricing: { input: 0.66, output: 1.00 },
    async_queue: false,
    notes: 'Primary; reliable JSON-ish adherence with strict format instructions.',
  },

  QWEN_CODER_32B: {
    id: '@cf/qwen/qwen2.5-coder-32b-instruct',
    use_cases: ['code-diff-review', 'refactoring', 'test-writing', 'inline-review'],
    prompt_design:
      'Great for refactors, explaining diffs, writing tests, inline reviews.',
    supports_json: true, // ✅ tested
    supports_function_calling: false,
    context_window: 32_768,
    pricing: { input: 0.66, output: 1.00 },
    async_queue: false,
  },

  DEEPSEEK_R1_32B: {
    id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    use_cases: ['deep-audit', 'step-by-step-reasoning', 'security-audit'],
    prompt_design:
      'SOTA distilled reasoning; use for final pass or tricky logic/security audits.',
    supports_json: true, // ✅ tested to follow schemas with strong instructions
    supports_function_calling: false,
    context_window: 80_000,
    pricing: { input: 0.50, output: 4.88 },
    async_queue: false,
    notes: 'Output tokens are pricey—keep generations tight.',
  },

  LLAMA4_SCOUT_17B: {
    id: '@cf/meta/llama-4-scout-17b-16e-instruct',
    use_cases: ['repo-wide-synthesis', 'architecture-review', 'mixed-media-analysis'],
    prompt_design:
      'MoE; strong repo-level reasoning; good for issues/docs/diagrams synthesis.',
    supports_json: true, // ✅ tested
    supports_function_calling: true,
    context_window: 131_000,
    pricing: { input: 0.27, output: 0.85 },
    async_queue: true, // ⚠️ latency-prone
    notes: 'Prefer when you truly need long context or multimodal summaries.',
  },

  LLAMA32_3B: {
    id: '@cf/meta/llama-3.2-3b-instruct',
    use_cases: ['fast-triage', 'first-pass', 'summarization'],
    prompt_design: 'Fast/cheap first pass for batch triage.',
    supports_json: true, // ✅ generally follows JSON with short outputs
    supports_function_calling: false,
    context_window: 128_000,
    pricing: { input: 0.051, output: 0.34 },
    async_queue: false,
  },

  MISTRAL_7B_V01: {
    id: '@cf/mistral/mistral-7b-instruct-v0.1',
    use_cases: ['budget-sensitive-review', 'simple-diff-review'],
    prompt_design: 'Small, fast, and budget-friendly.',
    supports_json: false, // ❌ not reliable without heavy constraints
    supports_function_calling: false,
    context_window: 2_824,
    pricing: { input: 0.11, output: 0.19 },
    async_queue: false,
    notes: 'Keep prompts short; good for small diffs.',
  },

  GPT_OSS_120B: {
    id: '@cf/openai/gpt-oss-120b',
    use_cases: ['high-reasoning-tasks', 'agentic-workflows', 'long-context-analysis'],
    prompt_design:
      'Broad reasoning + 128k ctx; powerful generalist for complex tasks.',
    supports_json: true, // ⚠️ mark as true only if you've validated; adjust if needed
    supports_function_calling: false,
    context_window: 128_000,
    pricing: { input: 0.35, output: 0.75 },
    async_queue: true, // ⚠️ may queue
    notes: 'Use when others don\'t fit; watch latency.',
  },
} as const

// Aux models (kept separate to avoid routing chat to them by mistake)
export const AUX_MODELS = {
  M2M100_1_2B: <ModelMeta>{
    id: '@cf/meta/m2m100-1.2b',
    use_cases: ['translation'],
    prompt_design: 'Many-to-many translation.',
    supports_json: false,
    supports_function_calling: false,
    context_window: 4_096,
    async_queue: false,
  },
  EMBED_BGE_M3: <ModelMeta>{
    id: '@cf/baai/bge-m3',
    use_cases: ['text-embeddings'],
    prompt_design: 'Multilingual, multi-granularity embeddings.',
    supports_json: false,
    supports_function_calling: false,
  },
  RERANK_BGE_BASE: <ModelMeta>{
    id: '@cf/baai/bge-reranker-base',
    use_cases: ['embedding-rerank'],
    prompt_design: 'Query–passage scoring for better retrieval.',
    supports_json: false,
    supports_function_calling: false,
  },
} as const

// ---------- Selection Types ----------
export type TaskKind =
  | 'triage_many_prs'        // batch triage queue
  | 'review_pr'              // typical PR review
  | 'deep_audit'             // security/correctness deep dive
  | 'repo_summarize'         // repo-wide synthesis/architecture read
  | 'fallback_general'       // catch-all / high ceiling

export type PickInputs = {
  task: TaskKind
  diffLinesChanged?: number
  filesChanged?: number
  hasDesignDocsOrImages?: boolean
  needsVeryLongContext?: boolean
  needReasoningDepth?: boolean
  budgetSensitive?: boolean
  lowLatencyPreferred?: boolean
}

export type PickResult = {
  primary: string
  fallback?: string
  embeddings: string
  reranker: string
  rationale: string
}

// ---------- Enhanced Types for Orchestration ----------

export type EnhancedPickInputs = PickInputs & {
  description?: string;           // Description of the analysis task
  content_sample?: string;        // Sample content for language detection
  use_orchestrator?: boolean;     // Override orchestrator usage
  prompt_requirements?: string[];  // Additional prompt requirements
}

export type EnhancedPickResult = PickResult & {
  generated_prompt?: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    max_tokens: number;
    temperature: number;
    stop?: string[];
  };
  translation_needed?: {
    needs_translation: boolean;
    detected_language: string;
    translation_model?: string;
    confidence: number;
  };
  orchestrator_used?: boolean;
  cost_estimate?: string;
}

// ---------- Simple cache for orchestrator results ----------
const orchestratorCache = new Map<string, { result: EnhancedPickResult; timestamp: number }>();

function getCacheKey(inputs: EnhancedPickInputs): string {
  const key = {
    task: inputs.task,
    diffLinesChanged: inputs.diffLinesChanged,
    filesChanged: inputs.filesChanged,
    hasDesignDocsOrImages: inputs.hasDesignDocsOrImages,
    needsVeryLongContext: inputs.needsVeryLongContext,
    needReasoningDepth: inputs.needReasoningDepth,
    budgetSensitive: inputs.budgetSensitive,
    lowLatencyPreferred: inputs.lowLatencyPreferred,
  };
  return JSON.stringify(key);
}

function getCachedResult(inputs: EnhancedPickInputs): EnhancedPickResult | null {
  const cacheKey = getCacheKey(inputs);
  const cached = orchestratorCache.get(cacheKey);

  if (!cached) return null;

  const now = Date.now();
  if (now - cached.timestamp > POLICY.ORCHESTRATOR_CACHE_TTL_MS) {
    orchestratorCache.delete(cacheKey);
    return null;
  }

  return cached.result;
}

function setCachedResult(inputs: EnhancedPickInputs, result: EnhancedPickResult): void {
  const cacheKey = getCacheKey(inputs);
  orchestratorCache.set(cacheKey, {
    result,
    timestamp: Date.now()
  });
}

// ---------- Selection Helpers ----------
function isAsyncQueue(modelId: string) {
  return POLICY.ASYNC_QUEUE_MODELS.has(modelId) ||
         Object.values(MODELS).some(m => m.id === modelId && m.async_queue)
}

function pickVeryLongCtxPreferred(): string {
  // Prefer Scout → GPT-OSS-120B → Llama-3.2-3B (as in POLICY)
  for (const id of POLICY.VERY_LONG_CTX_MODELS) {
    // ensure it exists in our catalog
    const ok = Object.values(MODELS).some(m => m.id === id)
    if (ok) return id
  }
  return MODELS.DEFAULT.id
}

// ---------- Main Selector ----------
export function pickModelForTask(i: PickInputs): PickResult {
  const {
    task,
    diffLinesChanged = 0,
    filesChanged = 0,
    hasDesignDocsOrImages = false,
    needsVeryLongContext = false,
    needReasoningDepth = false,
    budgetSensitive = false,
    lowLatencyPreferred = false,
  } = i

  const smallPR = diffLinesChanged > 0 && diffLinesChanged < POLICY.SMALL_PR_LINES
  const largeOrMulti =
    (!smallPR && (diffLinesChanged >= POLICY.SMALL_PR_LINES || filesChanged >= POLICY.LARGE_PR_FILES)) ||
    hasDesignDocsOrImages ||
    needsVeryLongContext

  let primary = MODELS.DEFAULT.id
  let fallback: string | undefined

  switch (task) {
    case 'triage_many_prs':
      primary = MODELS.LLAMA32_3B.id
      fallback = MODELS.QWEN_CODER_32B.id
      break

    case 'review_pr':
      if (needsVeryLongContext || largeOrMulti) {
        primary = needsVeryLongContext ? pickVeryLongCtxPreferred() : MODELS.LLAMA4_SCOUT_17B.id
        fallback = MODELS.QWEN_CODER_32B.id
      } else if (smallPR && budgetSensitive) {
        primary = MODELS.MISTRAL_7B_V01.id
        fallback = MODELS.QWEN_CODER_32B.id
      } else {
        primary = MODELS.QWEN_CODER_32B.id
        fallback = MODELS.LLAMA4_SCOUT_17B.id
      }
      break

    case 'deep_audit':
      primary = MODELS.QWEN_CODER_32B.id
      fallback = MODELS.DEEPSEEK_R1_32B.id
      if (needReasoningDepth) {
        primary = MODELS.DEEPSEEK_R1_32B.id
        fallback = MODELS.QWEN_CODER_32B.id
      }
      if (needsVeryLongContext) {
        // If long ctx is also requested, ensure fallback gives you that
        fallback = pickVeryLongCtxPreferred()
      }
      break

    case 'repo_summarize':
      primary = needsVeryLongContext ? pickVeryLongCtxPreferred() : MODELS.LLAMA4_SCOUT_17B.id
      fallback = MODELS.QWEN_CODER_32B.id
      break

    case 'fallback_general':
    default:
      primary = needsVeryLongContext ? MODELS.GPT_OSS_120B.id : MODELS.GPT_OSS_120B.id
      fallback = MODELS.QWEN_CODER_32B.id
      break
  }

  // Budget/latency nudges—do not undo explicit long-context requests unless necessary
  if (budgetSensitive) {
    if (primary === MODELS.LLAMA4_SCOUT_17B.id || primary === MODELS.GPT_OSS_120B.id) {
      primary = MODELS.QWEN_CODER_32B.id
    }
  }
  if (lowLatencyPreferred && isAsyncQueue(primary)) {
    // step down to fast alternative aligned with intent
    if (task === 'repo_summarize' || needsVeryLongContext) {
      primary = MODELS.QWEN_CODER_32B.id
    } else {
      primary = MODELS.QWEN_CODER_32B.id
    }
  }

  const embeddings = AUX_MODELS.EMBED_BGE_M3.id
  const reranker = AUX_MODELS.RERANK_BGE_BASE.id

  const reasons: string[] = []
  if (task === 'triage_many_prs') reasons.push('batch triage: cheap first-pass, escalate top 10%')
  if (task === 'review_pr') reasons.push(needsVeryLongContext || largeOrMulti ? 'large/multi-file or mixed inputs' : smallPR ? 'small diff' : 'standard review')
  if (task === 'deep_audit') reasons.push(needReasoningDepth ? 'max reasoning depth' : 'code-specialized + reasoning fallback')
  if (task === 'repo_summarize') reasons.push(needsVeryLongContext ? 'very long context' : 'repo-wide synthesis/vision-capable')
  if (budgetSensitive) reasons.push('budget-sensitive')
  if (lowLatencyPreferred) reasons.push('low-latency preference')
  if (hasDesignDocsOrImages) reasons.push('images/diagrams present')

  return { primary, fallback, embeddings, reranker, rationale: reasons.join(' | ') || 'default policy' }
}

// ---------- Enhanced Model Selection with Orchestration ----------

/**
 * @description Enhanced model selection that optionally uses AI orchestration for intelligent decisions
 */
export async function pickModelForTaskEnhanced(env: Env, inputs: EnhancedPickInputs): Promise<EnhancedPickResult> {
  console.log(`[ModelSelection] Enhanced selection for task: ${inputs.task}`);

  // Check cache first
  const cached = getCachedResult(inputs);
  if (cached) {
    console.log(`[ModelSelection] Using cached result for task: ${inputs.task}`);
    return cached;
  }

  // Determine whether to use orchestrator
  const useOrchestrator = inputs.use_orchestrator !== false &&
                         POLICY.USE_AI_ORCHESTRATOR &&
                         shouldUseOrchestrator({
                           task: inputs.task as OrchestratorTaskKind,
                           description: inputs.description || '',
                           signals: {
                             diffLinesChanged: inputs.diffLinesChanged,
                             filesChanged: inputs.filesChanged,
                             hasDesignDocsOrImages: inputs.hasDesignDocsOrImages,
                             needsVeryLongContext: inputs.needsVeryLongContext,
                             needReasoningDepth: inputs.needReasoningDepth,
                             budgetSensitive: inputs.budgetSensitive,
                             lowLatencyPreferred: inputs.lowLatencyPreferred,
                           }
                         });

  let result: EnhancedPickResult;

  if (useOrchestrator && env.OPENAI_API_KEY) {
    console.log(`[ModelSelection] Using AI orchestrator for task: ${inputs.task}`);
    try {
      const orchestratorResult = await runAIOrchestrator(env, {
        task: inputs.task as OrchestratorTaskKind,
        description: inputs.description || `${inputs.task} analysis`,
        content_sample: inputs.content_sample,
        signals: {
          diffLinesChanged: inputs.diffLinesChanged,
          filesChanged: inputs.filesChanged,
          hasDesignDocsOrImages: inputs.hasDesignDocsOrImages,
          needsVeryLongContext: inputs.needsVeryLongContext,
          needReasoningDepth: inputs.needReasoningDepth,
          budgetSensitive: inputs.budgetSensitive,
          lowLatencyPreferred: inputs.lowLatencyPreferred,
        }
      });

      if (orchestratorResult.success && orchestratorResult.data) {
        result = {
          primary: orchestratorResult.data.model.primary,
          fallback: orchestratorResult.data.model.fallback,
          embeddings: orchestratorResult.data.model.embeddings,
          reranker: orchestratorResult.data.model.reranker,
          rationale: `AI Orchestrated: ${orchestratorResult.data.rationale.policy_decision}`,
          generated_prompt: orchestratorResult.data.prompt,
          translation_needed: orchestratorResult.data.translation,
          orchestrator_used: true,
          cost_estimate: orchestratorResult.data.rationale.cost_estimate,
        };

        console.log(`[ModelSelection] Orchestrator selected: ${result.primary} | ${result.rationale}`);
      } else {
        console.warn(`[ModelSelection] Orchestrator failed: ${orchestratorResult.error}, falling back to rules`);
        throw new Error(orchestratorResult.error || 'Orchestrator failed');
      }
    } catch (error) {
      console.warn(`[ModelSelection] Orchestration error: ${error instanceof Error ? error.message : String(error)}`);

      if (POLICY.ORCHESTRATOR_FALLBACK_TO_RULES) {
        console.log(`[ModelSelection] Falling back to rule-based selection`);
        const baseResult = pickModelForTask(inputs);
        result = {
          ...baseResult,
          orchestrator_used: false,
          translation_needed: inputs.content_sample ? {
            needs_translation: looksNonEnglish(inputs.content_sample),
            detected_language: looksNonEnglish(inputs.content_sample) ? 'non-english' : 'english',
            confidence: 0.8,
          } : undefined,
        };
      } else {
        throw error;
      }
    }
  } else {
    console.log(`[ModelSelection] Using rule-based selection for task: ${inputs.task}`);
    const baseResult = pickModelForTask(inputs);
    result = {
      ...baseResult,
      orchestrator_used: false,
      translation_needed: inputs.content_sample ? {
        needs_translation: looksNonEnglish(inputs.content_sample),
        detected_language: looksNonEnglish(inputs.content_sample) ? 'non-english' : 'english',
        confidence: 0.8,
      } : undefined,
    };
  }

  // Cache the result
  setCachedResult(inputs, result);

  return result;
}

/**
 * @description Environment variable helper to check if orchestrator should be used
 */
export function shouldUseOrchestratorForEnv(): boolean {
  // In a real Cloudflare Worker, you'd access environment variables
  // For now, use the policy default
  return POLICY.USE_AI_ORCHESTRATOR;
}

/**
 * @description Convert TaskKind to OrchestratorTaskKind
 */
function mapTaskKind(task: TaskKind): OrchestratorTaskKind {
  switch (task) {
    case 'triage_many_prs': return 'triage_many_prs';
    case 'review_pr': return 'review_pr';
    case 'deep_audit': return 'deep_audit';
    case 'repo_summarize': return 'repo_summarize';
    case 'fallback_general': return 'fallback_general';
    default: return 'fallback_general';
  }
}

/**
 * @description Generate optimized prompts using orchestrator or fallback templates
 */
export async function generateOptimizedPrompt(
  env: Env,
  inputs: EnhancedPickInputs,
  basePrompt: string
): Promise<{
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  max_tokens: number;
  temperature: number;
  stop?: string[];
}> {
  console.log(`[PromptGeneration] Generating optimized prompt for task: ${inputs.task}`);

  // Try to use orchestrator for prompt generation
  if (inputs.use_orchestrator !== false && POLICY.USE_AI_ORCHESTRATOR && env.OPENAI_API_KEY) {
    try {
      const orchestratorResult = await runAIOrchestrator(env, {
        task: mapTaskKind(inputs.task),
        description: inputs.description || `Generate optimized prompt for ${inputs.task}`,
        content_sample: inputs.content_sample,
        signals: {
          diffLinesChanged: inputs.diffLinesChanged,
          filesChanged: inputs.filesChanged,
          hasDesignDocsOrImages: inputs.hasDesignDocsOrImages,
          needsVeryLongContext: inputs.needsVeryLongContext,
          needReasoningDepth: inputs.needReasoningDepth,
          budgetSensitive: inputs.budgetSensitive,
          lowLatencyPreferred: inputs.lowLatencyPreferred,
        }
      });

      if (orchestratorResult.success && orchestratorResult.data?.prompt) {
        console.log(`[PromptGeneration] Using orchestrator-generated prompt`);
        return orchestratorResult.data.prompt;
      }
    } catch (error) {
      console.warn(`[PromptGeneration] Orchestrator failed, using fallback: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Fallback to template-based prompt generation
  console.log(`[PromptGeneration] Using template-based prompt generation`);
  return generateTemplatePrompt(inputs.task, basePrompt, inputs);
}

/**
 * @description Template-based prompt generation for fallback
 */
function generateTemplatePrompt(
  task: TaskKind,
  basePrompt: string,
  inputs: EnhancedPickInputs
): {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  max_tokens: number;
  temperature: number;
  stop?: string[];
} {
  const systemPrompts: Record<TaskKind, string> = {
    'review_pr': `You are an expert code reviewer. Analyze the provided code changes and provide constructive feedback focusing on code quality, potential bugs, security issues, and best practices.`,

    'deep_audit': `You are a senior security engineer conducting a thorough code audit. Focus on identifying security vulnerabilities, potential exploits, data handling issues, and architectural security concerns.`,

    'repo_summarize': `You are an experienced software architect analyzing a repository. Provide a comprehensive overview of the codebase structure, key components, technologies used, and architectural patterns.`,

    'triage_many_prs': `You are a project maintainer triaging pull requests. Quickly assess each PR for complexity, risk level, and priority. Provide brief summaries to help with prioritization.`,

    'fallback_general': `You are an AI assistant helping with code analysis. Provide accurate, helpful, and actionable insights based on the provided content.`
  };

  const maxTokens: Record<TaskKind, number> = {
    'review_pr': inputs.needReasoningDepth ? 3000 : 2000,
    'deep_audit': 4000,
    'repo_summarize': inputs.needsVeryLongContext ? 8000 : 4000,
    'triage_many_prs': 1000,
    'fallback_general': 2048,
  };

  const temperature: Record<TaskKind, number> = {
    'review_pr': 0.1,
    'deep_audit': 0.05,
    'repo_summarize': 0.2,
    'triage_many_prs': 0.1,
    'fallback_general': 0.2,
  };

  let systemPrompt = systemPrompts[task];

  // Add constraints based on inputs
  if (inputs.budgetSensitive) {
    systemPrompt += '\n\nKeep responses concise and focused to minimize token usage.';
  }

  if (inputs.needReasoningDepth) {
    systemPrompt += '\n\nProvide step-by-step reasoning for your analysis and conclusions.';
  }

  if (inputs.prompt_requirements) {
    systemPrompt += `\n\nAdditional requirements: ${inputs.prompt_requirements.join(', ')}`;
  }

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: basePrompt }
    ],
    max_tokens: maxTokens[task],
    temperature: temperature[task],
    stop: task === 'triage_many_prs' ? ['---', '###'] : undefined,
  };
}

// ---------- Environment Types ----------

/**
 * @description Defines the environment variables and bindings available to the Worker.
 */
export type Env = {
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  OPENAI_API_KEY?: string;  // Optional OpenAI API key for orchestrator
  DB: D1Database;
  AI: any;
};

/**
 * @description Defines the structure for the body of a request to the Cloudflare AI model.
 */
export type CFRunBody = {
  messages?: Array<{ role: 'user' | 'system' | 'assistant'; content: string }>;
  prompt?: string;
  max_tokens?: number;
  response_format?: {
    type: string;
    json_schema: object;
  };
};

// ---------- AI Model Interaction (Primary Logic) ----------

/**
 * @description Extracts the text response from a Cloudflare AI model result.
 * Cleans common wrappers like ```json ... ```.
 */
function extractCFText(result: any): string {
  const raw =
    result?.response ??
    result?.output_text ??
    result?.content ??
    (typeof result === 'string' ? result : '');

  let text: string;
  if (raw == null) return '';
  if (typeof raw === 'object') {
    try { text = JSON.stringify(raw); } catch { text = String(raw); }
  } else {
    text = String(raw);
  }

  // Strip Markdown fences like ```json ... ```
  text = text.trim();
  if (text.startsWith("```")) {
    // Remove leading fence
    text = text.replace(/^```[a-zA-Z0-9]*\n?/, '');
    // Remove trailing fence
    text = text.replace(/```$/, '');
  }

  return text.trim();
}

/**
 * @description Runs a specified Cloudflare AI model, prioritizing the `env.AI` binding and falling back to the REST API.
 */
async function runCFModel(env: Env, model: string, body: CFRunBody): Promise<string> {
  console.log(`[AI] Running model '${model}'...`);

  if (env.AI) {
    try {
      console.log(`[AI] Attempting to use 'env.AI.run' binding for model ${model}.`);
      const res = await env.AI.run(model, body);
      const text = extractCFText(res);
      if (text) {
        console.log(`[AI] Successfully received response from 'env.AI.run' binding.`);
        return text;
      }
      console.warn(`[AI] 'env.AI.run' returned an empty response. Falling back to REST API.`);
    } catch (e: any) {
      console.error(`[AI] 'env.AI.run' binding failed: ${e.message}. Falling back to REST API.`);
    }
  } else {
    console.log(`[AI] 'env.AI' binding not found. Using REST API directly.`);
  }

  console.log(`[AI] Attempting to use Cloudflare REST API for model ${model}.`);
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${model}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const errorText = await r.text();
    console.error(`[AI] REST API call failed with status ${r.status}: ${errorText}`);
    throw new Error(`AI API failed: ${r.status}`);
  }

  console.log(`[AI] Successfully received response from REST API.`);
  const j: any = await r.json();
  return extractCFText(j?.result);
}

/**
 * @description High-level function to invoke a specific AI model with a given prompt string.
 */
export async function callModel(env: Env, model: string, prompt: string, schema?: object): Promise<string> {
    console.log(`[AI] Calling model ${model} with prompt of length: ${prompt.length}`);
    const body: CFRunBody = {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2048,
    };
    if (schema) {
        body.response_format = {
            type: 'json_schema',
            json_schema: schema,
        };
    }
    return runCFModel(env, model, body);
}

/**
 * @description Checks if a given text appears to contain non-English content.
 */
export function looksNonEnglish(s: string): boolean {
  return /[^\x00-\x7F]/.test(s);
}

/**
 * @description Translates non-English content to English using the M2M100 model.
 */
export async function translateToEnglish(env: Env, text: string): Promise<string> {
  if (!looksNonEnglish(text)) return text;

  console.log(`[Translate] Non-English text detected. Attempting to translate with model ${AUX_MODELS.M2M100_1_2B.id}.`);
  const prompt = `Translate to English: ${text}`;
  const out = (await runCFModel(env, AUX_MODELS.M2M100_1_2B.id, { prompt, max_tokens: 800 })).trim();

  if (out) {
    console.log('[Translate] Successfully translated content.');
    return out;
  } else {
    console.warn('[Translate] Translation returned an empty result.');
    return text;
  }
}
