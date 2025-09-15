// src/modules/ai_orchestrator.ts

/**
 * @description AI Orchestrator System - "AI choosing AI"
 *
 * Uses OpenAI gpt-4o-mini as a lightweight orchestrator (~$0.0005 per run) to make
 * intelligent decisions about which Cloudflare model to use and how to prompt it.
 * The orchestrator handles the meta-reasoning while CF models do the heavy computational work.
 *
 * Key features:
 * - Policy-driven model selection with cost optimization
 * - Dynamic prompt engineering per model and task
 * - Non-English content detection and translation workflow
 * - OpenAI orchestrator with CF fallback
 * - Structured JSON responses with schema validation
 */

import { MODELS, AUX_MODELS, type Env } from './ai_models';
import { looksNonEnglish } from './ai_processing';

// ---------- Enhanced Model Catalog for Orchestrator ----------

export const MODEL_CATALOG = {
  // Primary models for analysis work
  QWEN_CODER_32B: {
    id: '@cf/qwen/qwen2.5-coder-32b-instruct',
    use_cases: ['code-diff-review', 'refactoring', 'test-writing', 'inline-review'],
    prompt_design: 'Code-specialized, strong editor/refactor/test gen. Best general choice for PR reviews.',
    supports_json: true,
    supports_function_calling: false,
    context_window: 32_768,
    pricing: { input: 0.66, output: 1.00 },
    async_queue: false,
    notes: 'Primary; reliable JSON-ish adherence with strict format instructions.',
  },

  DEEPSEEK_R1_32B: {
    id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    use_cases: ['deep-audit', 'step-by-step-reasoning', 'security-audit'],
    prompt_design: 'SOTA distilled reasoning; use for final pass or tricky logic/security audits.',
    supports_json: true,
    supports_function_calling: false,
    context_window: 80_000,
    pricing: { input: 0.50, output: 4.88 },
    async_queue: false,
    notes: 'Output tokens are pricey—keep generations tight.',
  },

  LLAMA4_SCOUT_17B: {
    id: '@cf/meta/llama-4-scout-17b-16e-instruct',
    use_cases: ['repo-wide-synthesis', 'architecture-review', 'mixed-media-analysis'],
    prompt_design: 'MoE; strong repo-level reasoning; good for issues/docs/diagrams synthesis.',
    supports_json: true,
    supports_function_calling: true,
    context_window: 131_000,
    pricing: { input: 0.27, output: 0.85 },
    async_queue: true,
    notes: 'Prefer when you truly need long context or multimodal summaries.',
  },

  LLAMA32_3B: {
    id: '@cf/meta/llama-3.2-3b-instruct',
    use_cases: ['fast-triage', 'first-pass', 'summarization'],
    prompt_design: 'Fast/cheap first pass for batch triage.',
    supports_json: true,
    supports_function_calling: false,
    context_window: 128_000,
    pricing: { input: 0.051, output: 0.34 },
    async_queue: false,
  },

  MISTRAL_7B_V01: {
    id: '@cf/mistral/mistral-7b-instruct-v0.1',
    use_cases: ['budget-sensitive-review', 'simple-diff-review'],
    prompt_design: 'Small, fast, and budget-friendly.',
    supports_json: false,
    supports_function_calling: false,
    context_window: 2_824,
    pricing: { input: 0.11, output: 0.19 },
    async_queue: false,
    notes: 'Keep prompts short; good for small diffs.',
  },

  GPT_OSS_120B: {
    id: '@cf/openai/gpt-oss-120b',
    use_cases: ['high-reasoning-tasks', 'agentic-workflows', 'long-context-analysis'],
    prompt_design: 'Broad reasoning + 128k ctx; powerful generalist for complex tasks.',
    supports_json: true,
    supports_function_calling: false,
    context_window: 128_000,
    pricing: { input: 0.35, output: 0.75 },
    async_queue: true,
    notes: 'Use when others don\'t fit; watch latency.',
  },

  // Auxiliary models
  M2M100_1_2B: {
    id: '@cf/meta/m2m100-1.2b',
    use_cases: ['translation'],
    prompt_design: 'Many-to-many translation.',
    supports_json: false,
    supports_function_calling: false,
    context_window: 4_096,
    async_queue: false,
  },

  EMBED_BGE_M3: {
    id: '@cf/baai/bge-m3',
    use_cases: ['text-embeddings'],
    prompt_design: 'Multilingual, multi-granularity embeddings.',
    supports_json: false,
    supports_function_calling: false,
  },

  RERANK_BGE_BASE: {
    id: '@cf/baai/bge-reranker-base',
    use_cases: ['embedding-rerank'],
    prompt_design: 'Query–passage scoring for better retrieval.',
    supports_json: false,
    supports_function_calling: false,
  },
} as const;

// ---------- Enhanced Policy Configuration ----------

export const ORCHESTRATOR_POLICY = {
  SMALL_PR_LINES: 300,
  LARGE_PR_FILES: 5,
  AI_TIMEOUT_MS: 20000,

  // OpenAI orchestrator settings
  ORCHESTRATOR_MODEL: 'gpt-4o-mini', // Cheapest good default
  ORCHESTRATOR_FALLBACK: '@cf/meta/llama-4-scout-17b-16e-instruct',
  ORCHESTRATOR_TIMEOUT: 15000,
  ORCHESTRATOR_MAX_TOKENS: 1200,

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
} as const;

// ---------- Structured Response Schema ----------

export const ORCHESTRATOR_SCHEMA = {
  name: 'OrchestratorResponse',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['model', 'prompt', 'rationale', 'translation'],
    properties: {
      model: {
        type: 'object',
        additionalProperties: false,
        required: ['primary'],
        properties: {
          primary: { type: 'string' },
          fallback: { type: 'string' },
          embeddings: { type: 'string' },
          reranker: { type: 'string' },
        }
      },
      prompt: {
        type: 'object',
        additionalProperties: false,
        required: ['target_kind', 'messages'],
        properties: {
          target_kind: {
            type: 'string',
            enum: ['review_pr', 'deep_audit', 'repo_summarize', 'triage_many_prs', 'fallback_general']
          },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['role', 'content'],
              properties: {
                role: { type: 'string', enum: ['system', 'user', 'assistant'] },
                content: { type: 'string' }
              }
            },
            minItems: 1,
          },
          max_tokens: { type: 'integer', minimum: 128, maximum: 8192 },
          temperature: { type: 'number', minimum: 0, maximum: 2 },
          stop: { type: 'array', items: { type: 'string' } }
        }
      },
      rationale: {
        type: 'object',
        additionalProperties: false,
        required: ['policy_decision', 'cost_estimate', 'latency_notes'],
        properties: {
          policy_decision: { type: 'string' },
          cost_estimate: { type: 'string' },
          latency_notes: { type: 'string' },
        }
      },
      translation: {
        type: 'object',
        additionalProperties: false,
        required: ['needs_translation', 'detected_language'],
        properties: {
          needs_translation: { type: 'boolean' },
          detected_language: { type: 'string' },
          translation_model: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        }
      }
    }
  }
} as const;

// ---------- Function Tools for Orchestrator ----------

export const ORCHESTRATOR_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'select_model',
      description: 'Choose the best Cloudflare Workers AI model given repo/PR signals and policy constraints.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['primary', 'fallback', 'embeddings', 'reranker'],
        properties: {
          primary: { type: 'string', description: 'Model ID for first attempt' },
          fallback: { type: 'string', description: 'Model ID for fallback if primary fails' },
          embeddings: { type: 'string', description: 'Embeddings model for retrieval tasks' },
          reranker: { type: 'string', description: 'Reranker model for retrieval tasks' },
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_prompt',
      description: 'Craft an optimized prompt/messages array for the chosen model and task type.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target_kind', 'messages', 'max_tokens', 'temperature'],
        properties: {
          target_kind: {
            type: 'string',
            enum: ['review_pr', 'deep_audit', 'repo_summarize', 'triage_many_prs', 'fallback_general']
          },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              required: ['role', 'content'],
              properties: {
                role: { type: 'string', enum: ['system', 'user', 'assistant'] },
                content: { type: 'string' }
              }
            }
          },
          max_tokens: { type: 'integer', minimum: 128, maximum: 8192 },
          temperature: { type: 'number', minimum: 0, maximum: 2 },
          stop: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'detect_translation_needs',
      description: 'Analyze content for non-English text and determine translation requirements.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['needs_translation', 'detected_language'],
        properties: {
          needs_translation: { type: 'boolean' },
          detected_language: { type: 'string' },
          translation_model: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        }
      }
    }
  }
] as const;

// ---------- Orchestrator System Prompt ----------

const ORCHESTRATOR_SYSTEM_PROMPT = `
You are an AI Orchestrator for GitHub repository analysis. Your job is to intelligently select the best Cloudflare Workers AI model and craft optimal prompts for different analysis tasks.

AVAILABLE CLOUDFLARE MODELS:
${JSON.stringify(MODEL_CATALOG, null, 2)}

POLICY RULES:
- Small PR (<${ORCHESTRATOR_POLICY.SMALL_PR_LINES} lines): prefer @cf/qwen/qwen2.5-coder-32b-instruct
- Large PR or multi-file change (>=${ORCHESTRATOR_POLICY.SMALL_PR_LINES} lines or >=${ORCHESTRATOR_POLICY.LARGE_PR_FILES} files), or mixed media/docs: @cf/meta/llama-4-scout-17b-16e-instruct
- Deep security/correctness audits: use @cf/deepseek-ai/deepseek-r1-distill-qwen-32b (for reasoning depth)
- Batch triage: start with @cf/meta/llama-3.2-3b-instruct; escalate to Qwen Coder 32B
- Very long context needed: prefer Scout 17B or GPT-OSS-120B (both ~128k+)
- Budget-sensitive: avoid Scout/GPT-OSS; prefer Qwen Coder 32B or Mistral-7B
- Low-latency: avoid async-queue models (Scout 17B, GPT-OSS-120B)

PROMPT ENGINEERING GUIDELINES:
- Tailor prompt style to model: concise for small models (3B/7B), structured sections for long-context models
- For code analysis: include specific instructions for the model's strengths
- For reasoning tasks (DeepSeek R1): encourage step-by-step thinking
- For multimodal (Scout 17B): leverage its ability to process mixed content
- Always include clear output format requirements

TRANSLATION DETECTION:
- Check for non-English content in input text
- If detected, flag for translation and recommend M2M100 model
- Estimate confidence of language detection

OUTPUT REQUIREMENTS:
- ALWAYS output valid JSON matching the provided schema
- Include rationale explaining your model choice and cost/latency considerations
- Provide concrete cost estimates based on model pricing
- Never include extra text outside the JSON response

You have access to these conceptual functions: select_model, create_prompt, detect_translation_needs.
Use your understanding of these to generate the final structured response.
`.trim();

// ---------- Task and Signal Types ----------

export type OrchestratorTaskKind =
  | 'triage_many_prs'        // batch triage queue
  | 'review_pr'              // typical PR review
  | 'deep_audit'             // security/correctness deep dive
  | 'repo_summarize'         // repo-wide synthesis/architecture read
  | 'fallback_general';      // catch-all / high ceiling

export type OrchestratorInputs = {
  task: OrchestratorTaskKind;
  description: string;
  content_sample?: string;        // Sample of content to analyze for language detection
  signals?: {
    diffLinesChanged?: number;
    filesChanged?: number;
    hasDesignDocsOrImages?: boolean;
    needsVeryLongContext?: boolean;
    needReasoningDepth?: boolean;
    budgetSensitive?: boolean;
    lowLatencyPreferred?: boolean;
  };
};

export type OrchestratorResult = {
  success: boolean;
  data?: {
    model: {
      primary: string;
      fallback?: string;
      embeddings: string;
      reranker: string;
    };
    prompt: {
      target_kind: OrchestratorTaskKind;
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      max_tokens: number;
      temperature: number;
      stop?: string[];
    };
    rationale: {
      policy_decision: string;
      cost_estimate: string;
      latency_notes: string;
    };
    translation: {
      needs_translation: boolean;
      detected_language: string;
      translation_model?: string;
      confidence: number;
    };
  };
  error?: string;
  raw?: string;
  fallback_used?: boolean;
};

// ---------- API Response Types ----------

type OpenAIResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type CloudflareAIResponse = {
  result?: {
    response?: string;
    output_text?: string;
    content?: string;
  };
};

// ---------- OpenAI API Client ----------

async function callOpenAIOrchestrator(env: Env, inputs: OrchestratorInputs): Promise<string> {
  if (!env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const userPrompt = `
TASK: ${inputs.task}
DESCRIPTION: ${inputs.description}

RUNTIME SIGNALS:
${JSON.stringify(inputs.signals || {}, null, 2)}

CONTENT SAMPLE (for language detection):
${inputs.content_sample ? inputs.content_sample.slice(0, 1000) : 'No sample provided'}

Please analyze this request and return a JSON response with your model selection, prompt engineering, and translation analysis.
`.trim();

  const requestBody = {
    model: ORCHESTRATOR_POLICY.ORCHESTRATOR_MODEL,
    messages: [
      { role: 'system', content: ORCHESTRATOR_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: ORCHESTRATOR_SCHEMA
    },
    tools: ORCHESTRATOR_TOOLS,
    tool_choice: 'none',
    temperature: 0.2,
    max_tokens: ORCHESTRATOR_POLICY.ORCHESTRATOR_MAX_TOKENS,
  };

  console.log(`[Orchestrator] Calling OpenAI ${ORCHESTRATOR_POLICY.ORCHESTRATOR_MODEL} for task: ${inputs.task}`);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as OpenAIResponse;
  return data?.choices?.[0]?.message?.content || '';
}

// ---------- Cloudflare Fallback Orchestrator ----------

async function callCFOrchestrator(env: Env, inputs: OrchestratorInputs): Promise<string> {
  console.log(`[Orchestrator] Using CF fallback model: ${ORCHESTRATOR_POLICY.ORCHESTRATOR_FALLBACK}`);

  const userPrompt = `
TASK: ${inputs.task}
DESCRIPTION: ${inputs.description}

RUNTIME SIGNALS:
${JSON.stringify(inputs.signals || {}, null, 2)}

CONTENT SAMPLE:
${inputs.content_sample ? inputs.content_sample.slice(0, 1000) : 'No sample provided'}

Return a JSON response following the schema for model selection and prompt engineering.
`.trim();

  const requestBody = {
    messages: [
      { role: 'system', content: ORCHESTRATOR_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    response_format: { type: 'json_schema', json_schema: ORCHESTRATOR_SCHEMA },
    max_tokens: ORCHESTRATOR_POLICY.ORCHESTRATOR_MAX_TOKENS,
    temperature: 0.2,
  };

  // Try binding first
  if (env.AI) {
    try {
      const result = await env.AI.run(ORCHESTRATOR_POLICY.ORCHESTRATOR_FALLBACK, requestBody);
      const text = result?.response ?? result?.output_text ?? result?.content ?? '';
      if (text) return text;
    } catch (e) {
      console.warn(`[Orchestrator] CF binding failed: ${e}`);
    }
  }

  // REST API fallback
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${ORCHESTRATOR_POLICY.ORCHESTRATOR_FALLBACK}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`CF AI API failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as CloudflareAIResponse;
  return data?.result?.response ?? data?.result?.output_text ?? data?.result?.content ?? '';
}

// ---------- Main Orchestrator Function ----------

export async function runAIOrchestrator(env: Env, inputs: OrchestratorInputs): Promise<OrchestratorResult> {
  console.log(`[Orchestrator] Starting orchestration for task: ${inputs.task}`);

  // Add non-English detection to content sample if provided
  if (inputs.content_sample && looksNonEnglish(inputs.content_sample)) {
    console.log(`[Orchestrator] Non-English content detected in sample`);
  }

  let rawResponse = '';
  let fallbackUsed = false;

  try {
    // Try OpenAI orchestrator first
    rawResponse = await callOpenAIOrchestrator(env, inputs);
  } catch (e: any) {
    console.warn(`[Orchestrator] OpenAI failed, trying CF fallback: ${e.message}`);
    try {
      rawResponse = await callCFOrchestrator(env, inputs);
      fallbackUsed = true;
    } catch (fallbackError: any) {
      console.error(`[Orchestrator] Both orchestrators failed`);
      return {
        success: false,
        error: `Orchestration failed: OpenAI (${e.message}), CF (${fallbackError.message})`,
      };
    }
  }

  // Parse the JSON response
  try {
    // Extract JSON from response if it's wrapped in markdown or other text
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : rawResponse;

    const parsed = JSON.parse(jsonText);

    // Basic validation
    if (!parsed?.model?.primary || !parsed?.prompt?.messages) {
      return {
        success: false,
        error: 'Invalid orchestrator response structure',
        raw: rawResponse,
      };
    }

    console.log(`[Orchestrator] Successfully orchestrated: ${parsed.model.primary} for ${inputs.task}`);
    console.log(`[Orchestrator] Cost estimate: ${parsed.rationale?.cost_estimate}`);
    console.log(`[Orchestrator] Translation needed: ${parsed.translation?.needs_translation}`);

    return {
      success: true,
      data: parsed,
      fallback_used: fallbackUsed,
    };

  } catch (parseError: any) {
    console.error(`[Orchestrator] Failed to parse response: ${parseError.message}`);
    return {
      success: false,
      error: `Failed to parse orchestrator response: ${parseError.message}`,
      raw: rawResponse,
    };
  }
}

// ---------- Utility Functions ----------

/**
 * @description Get estimated cost for orchestrator call
 */
export function getOrchestratorCost(inputTokens: number = 2000, outputTokens: number = 400): number {
  // gpt-4o-mini pricing: ~$0.15/M in, ~$0.60/M out
  const inputCost = (inputTokens / 1_000_000) * 0.15;
  const outputCost = (outputTokens / 1_000_000) * 0.60;
  return inputCost + outputCost;
}

/**
 * @description Check if orchestration is beneficial for this task
 */
export function shouldUseOrchestrator(inputs: OrchestratorInputs): boolean {
  const signals = inputs.signals || {};

  // Always use orchestrator for complex scenarios
  if (
    signals.needsVeryLongContext ||
    signals.hasDesignDocsOrImages ||
    (signals.diffLinesChanged && signals.diffLinesChanged > 1000) ||
    inputs.task === 'deep_audit' ||
    inputs.task === 'repo_summarize'
  ) {
    return true;
  }

  // Skip for simple, small tasks where rule-based selection is sufficient
  if (
    inputs.task === 'triage_many_prs' ||
    (signals.diffLinesChanged && signals.diffLinesChanged < 100)
  ) {
    return false;
  }

  return true; // Default to using orchestrator
}
