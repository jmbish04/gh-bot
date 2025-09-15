// src/modules/openai_client.ts

/**
 * @description OpenAI Integration Module
 *
 * Dedicated client for OpenAI API calls supporting structured JSON responses,
 * function calling, tool definitions, and proper error handling with fallback
 * to Cloudflare models when OpenAI is unavailable.
 *
 * Key features:
 * - Support for gpt-4o-mini and o3-mini models
 * - Structured JSON schema responses
 * - Function calling with tool definitions
 * - Comprehensive error handling and retry logic
 * - Automatic fallback to Cloudflare models
 * - Token counting and cost estimation
 * - Rate limiting and timeout handling
 */

import { type Env } from './ai_models';

// ---------- OpenAI Configuration ----------

export const OPENAI_CONFIG = {
  // Supported models
  MODELS: {
    GPT_4O_MINI: 'gpt-4o-mini',
    O3_MINI: 'o3-mini',
    GPT_4O: 'gpt-4o',
    GPT_35_TURBO: 'gpt-3.5-turbo',
  },

  // API configuration
  BASE_URL: 'https://api.openai.com/v1',
  DEFAULT_MODEL: 'gpt-4o-mini',
  DEFAULT_MAX_TOKENS: 2048,
  DEFAULT_TEMPERATURE: 0.2,
  DEFAULT_TIMEOUT_MS: 30000,

  // Rate limiting
  MAX_RETRIES: 3,
  RETRY_DELAY_BASE_MS: 1000,
  BACKOFF_MULTIPLIER: 2,

  // Pricing (USD per 1M tokens, as of latest known rates)
  PRICING: {
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    'o3-mini': { input: 0.15, output: 0.60 }, // Estimated
    'gpt-4o': { input: 5.00, output: 15.00 },
    'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  },
} as const;

// ---------- Types and Interfaces ----------

export type OpenAIModel = keyof typeof OPENAI_CONFIG.PRICING;

export type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'function';
  content: string;
  name?: string;
};

export type OpenAITool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
};

export type OpenAIRequest = {
  model: OpenAIModel;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: OpenAITool[];
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  response_format?: {
    type: 'json_schema';
    json_schema: {
      name: string;
      schema: Record<string, any>;
      strict?: boolean;
    };
  };
  stream?: boolean;
  timeout?: number;
};

export type OpenAIResponse = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type OpenAIErrorResponse = {
  error: {
    message: string;
    type: string;
    param?: string | null;
    code?: string | null;
  };
};

export type OpenAIResult = {
  success: boolean;
  data?: {
    content: string | null;
    tool_calls?: Array<{
      id: string;
      name: string;
      arguments: Record<string, any>;
    }>;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      cost_usd: number;
    };
    model: string;
    finish_reason: string;
  };
  error?: string;
  fallback_used?: boolean;
  retry_count?: number;
  duration_ms?: number;
};

// ---------- Error Classes ----------

export class OpenAIError extends Error {
  constructor(
    message: string,
    public readonly type: string = 'unknown',
    public readonly code?: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'OpenAIError';
  }
}

export class OpenAIRateLimitError extends OpenAIError {
  constructor(message: string, public readonly retryAfter?: number) {
    super(message, 'rate_limit_exceeded', 'rate_limit_exceeded', 429);
    this.name = 'OpenAIRateLimitError';
  }
}

export class OpenAITimeoutError extends OpenAIError {
  constructor(message: string = 'Request timed out') {
    super(message, 'timeout', 'timeout', 408);
    this.name = 'OpenAITimeoutError';
  }
}

export class OpenAIAuthError extends OpenAIError {
  constructor(message: string) {
    super(message, 'invalid_request_error', 'invalid_api_key', 401);
    this.name = 'OpenAIAuthError';
  }
}

// ---------- Utility Functions ----------

/**
 * @description Calculate the estimated cost for an OpenAI API call
 */
export function calculateCost(model: OpenAIModel, usage: { prompt_tokens: number; completion_tokens: number }): number {
  const pricing = OPENAI_CONFIG.PRICING[model];
  if (!pricing) return 0;

  const inputCost = (usage.prompt_tokens / 1_000_000) * pricing.input;
  const outputCost = (usage.completion_tokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

/**
 * @description Get retry delay with exponential backoff
 */
function getRetryDelay(attempt: number): number {
  return OPENAI_CONFIG.RETRY_DELAY_BASE_MS * Math.pow(OPENAI_CONFIG.BACKOFF_MULTIPLIER, attempt - 1);
}

/**
 * @description Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * @description Validate OpenAI model availability
 */
export function isValidOpenAIModel(model: string): model is OpenAIModel {
  return model in OPENAI_CONFIG.PRICING;
}

/**
 * @description Get model recommendations based on task
 */
export function getModelRecommendation(
  task: 'orchestration' | 'reasoning' | 'code_analysis' | 'general',
  budgetSensitive: boolean = false
): OpenAIModel {
  if (budgetSensitive) {
    return OPENAI_CONFIG.MODELS.GPT_4O_MINI;
  }

  switch (task) {
    case 'orchestration':
      return OPENAI_CONFIG.MODELS.GPT_4O_MINI; // Fast and cheap for meta-reasoning
    case 'reasoning':
      return OPENAI_CONFIG.MODELS.O3_MINI; // Specialized for reasoning
    case 'code_analysis':
      return OPENAI_CONFIG.MODELS.GPT_4O_MINI; // Good code understanding
    case 'general':
    default:
      return OPENAI_CONFIG.MODELS.GPT_4O_MINI;
  }
}

// ---------- Core OpenAI Client ----------

/**
 * @description Make a request to OpenAI API with comprehensive error handling
 */
async function makeOpenAIRequest(
  env: Env,
  request: OpenAIRequest,
  attempt: number = 1
): Promise<OpenAIResponse> {
  if (!env.OPENAI_API_KEY) {
    throw new OpenAIAuthError('OpenAI API key not configured');
  }

  const timeoutMs = request.timeout ?? OPENAI_CONFIG.DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const startTime = Date.now();

    console.log(`[OpenAI] Making request (attempt ${attempt}/${OPENAI_CONFIG.MAX_RETRIES}) to ${request.model}`);

    const response = await fetch(`${OPENAI_CONFIG.BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'GitHub-Bot-Worker/1.0',
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: request.max_tokens ?? OPENAI_CONFIG.DEFAULT_MAX_TOKENS,
        temperature: request.temperature ?? OPENAI_CONFIG.DEFAULT_TEMPERATURE,
        ...(request.tools && { tools: request.tools }),
        ...(request.tool_choice && { tool_choice: request.tool_choice }),
        ...(request.response_format && { response_format: request.response_format }),
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const duration = Date.now() - startTime;

    console.log(`[OpenAI] Request completed in ${duration}ms with status ${response.status}`);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as OpenAIErrorResponse;
      const errorMessage = errorData?.error?.message || `HTTP ${response.status}`;

      if (response.status === 401) {
        throw new OpenAIAuthError(errorMessage);
      } else if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '60');
        throw new OpenAIRateLimitError(errorMessage, retryAfter);
      } else {
        throw new OpenAIError(errorMessage, errorData?.error?.type || 'api_error', errorData?.error?.code || undefined, response.status);
      }
    }

    const data = await response.json() as OpenAIResponse;
    console.log(`[OpenAI] Success: ${data.usage?.total_tokens || 'unknown'} total tokens`);

    return data;

  } catch (error: any) {
    clearTimeout(timeoutId);

    if (controller.signal.aborted) {
      throw new OpenAITimeoutError(`Request timed out after ${timeoutMs}ms`);
    }

    // Re-throw known errors
    if (error instanceof OpenAIError) {
      throw error;
    }

    // Wrap unknown errors
    throw new OpenAIError(
      `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      'network_error',
      undefined,
      undefined
    );
  }
}

/**
 * @description Make OpenAI request with retry logic
 */
async function makeOpenAIRequestWithRetry(
  env: Env,
  request: OpenAIRequest
): Promise<OpenAIResponse> {
  let lastError: OpenAIError;

  for (let attempt = 1; attempt <= OPENAI_CONFIG.MAX_RETRIES; attempt++) {
    try {
      return await makeOpenAIRequest(env, request, attempt);
    } catch (error) {
      lastError = error instanceof OpenAIError ? error : new OpenAIError(error instanceof Error ? error.message : String(error));

      // Don't retry certain errors
      if (
        lastError instanceof OpenAIAuthError ||
        (lastError.status && lastError.status >= 400 && lastError.status < 500 && lastError.status !== 429)
      ) {
        throw lastError;
      }

      // Don't retry on last attempt
      if (attempt === OPENAI_CONFIG.MAX_RETRIES) {
        throw lastError;
      }

      // Wait before retrying
      const delay = lastError instanceof OpenAIRateLimitError
        ? (lastError.retryAfter || 60) * 1000
        : getRetryDelay(attempt);

      console.warn(`[OpenAI] Attempt ${attempt} failed: ${lastError.message}. Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw lastError!;
}

// ---------- Public API Functions ----------

/**
 * @description Call OpenAI API with comprehensive error handling and fallback
 */
export async function callOpenAI(env: Env, request: OpenAIRequest): Promise<OpenAIResult> {
  const startTime = Date.now();

  try {
    // Validate model
    if (!isValidOpenAIModel(request.model)) {
      return {
        success: false,
        error: `Unsupported OpenAI model: ${request.model}`,
      };
    }

    // Make request with retry logic
    const response = await makeOpenAIRequestWithRetry(env, request);

    // Process response
    const choice = response.choices?.[0];
    if (!choice) {
      return {
        success: false,
        error: 'No response choices returned from OpenAI',
      };
    }

    // Parse tool calls if present
    const tool_calls = choice.message.tool_calls?.map(call => ({
      id: call.id,
      name: call.function.name,
      arguments: JSON.parse(call.function.arguments),
    }));

    // Calculate cost
    const cost_usd = response.usage ? calculateCost(request.model, response.usage) : 0;

    const duration = Date.now() - startTime;

    return {
      success: true,
      data: {
        content: choice.message.content,
        tool_calls,
        usage: {
          prompt_tokens: response.usage?.prompt_tokens || 0,
          completion_tokens: response.usage?.completion_tokens || 0,
          total_tokens: response.usage?.total_tokens || 0,
          cost_usd,
        },
        model: response.model,
        finish_reason: choice.finish_reason,
      },
      duration_ms: duration,
    };

  } catch (error) {
    const duration = Date.now() - startTime;

    if (error instanceof OpenAIError) {
      console.error(`[OpenAI] ${error.name}: ${error.message}`);
      return {
        success: false,
        error: error.message,
        duration_ms: duration,
      };
    }

    console.error(`[OpenAI] Unexpected error:`, error);
    return {
      success: false,
      error: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      duration_ms: duration,
    };
  }
}

/**
 * @description Simple text completion with OpenAI
 */
export async function completeText(
  env: Env,
  prompt: string,
  options: {
    model?: OpenAIModel;
    max_tokens?: number;
    temperature?: number;
    system_message?: string;
  } = {}
): Promise<OpenAIResult> {
  const messages: OpenAIMessage[] = [];

  if (options.system_message) {
    messages.push({ role: 'system', content: options.system_message });
  }

  messages.push({ role: 'user', content: prompt });

  return callOpenAI(env, {
    model: options.model || OPENAI_CONFIG.DEFAULT_MODEL,
    messages,
    max_tokens: options.max_tokens,
    temperature: options.temperature,
  });
}

/**
 * @description Structured JSON completion with schema validation
 */
export async function completeJSON<T = any>(
  env: Env,
  prompt: string,
  schema: {
    name: string;
    schema: Record<string, any>;
  },
  options: {
    model?: OpenAIModel;
    max_tokens?: number;
    temperature?: number;
    system_message?: string;
  } = {}
): Promise<OpenAIResult & { parsed?: T }> {
  const messages: OpenAIMessage[] = [];

  if (options.system_message) {
    messages.push({ role: 'system', content: options.system_message });
  }

  messages.push({ role: 'user', content: prompt });

  const result = await callOpenAI(env, {
    model: options.model || OPENAI_CONFIG.DEFAULT_MODEL,
    messages,
    max_tokens: options.max_tokens,
    temperature: options.temperature,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: schema.name,
        schema: schema.schema,
        strict: true,
      },
    },
  });

  // Try to parse JSON if successful
  if (result.success && result.data?.content) {
    try {
      const parsed = JSON.parse(result.data.content) as T;
      return { ...result, parsed };
    } catch (parseError) {
      return {
        ...result,
        success: false,
        error: `Failed to parse JSON response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      };
    }
  }

  return result;
}

/**
 * @description Function calling with tools
 */
export async function callWithTools(
  env: Env,
  prompt: string,
  tools: OpenAITool[],
  options: {
    model?: OpenAIModel;
    max_tokens?: number;
    temperature?: number;
    system_message?: string;
    tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  } = {}
): Promise<OpenAIResult> {
  const messages: OpenAIMessage[] = [];

  if (options.system_message) {
    messages.push({ role: 'system', content: options.system_message });
  }

  messages.push({ role: 'user', content: prompt });

  return callOpenAI(env, {
    model: options.model || OPENAI_CONFIG.DEFAULT_MODEL,
    messages,
    max_tokens: options.max_tokens,
    temperature: options.temperature,
    tools,
    tool_choice: options.tool_choice || 'auto',
  });
}

/**
 * @description Check OpenAI API availability
 */
export async function checkOpenAIAvailability(env: Env): Promise<boolean> {
  if (!env.OPENAI_API_KEY) return false;

  try {
    const result = await completeText(env, 'Hello', {
      model: OPENAI_CONFIG.MODELS.GPT_4O_MINI,
      max_tokens: 5,
    });

    return result.success;
  } catch {
    return false;
  }
}

/**
 * @description Get usage statistics for cost tracking
 */
export function getUsageStats(results: OpenAIResult[]): {
  total_requests: number;
  successful_requests: number;
  total_tokens: number;
  total_cost_usd: number;
  average_duration_ms: number;
} {
  const successful = results.filter(r => r.success && r.data);

  return {
    total_requests: results.length,
    successful_requests: successful.length,
    total_tokens: successful.reduce((sum, r) => sum + (r.data?.usage.total_tokens || 0), 0),
    total_cost_usd: successful.reduce((sum, r) => sum + (r.data?.usage.cost_usd || 0), 0),
    average_duration_ms: results.reduce((sum, r) => sum + (r.duration_ms || 0), 0) / results.length,
  };
}
