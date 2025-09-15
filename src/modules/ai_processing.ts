// src/modules/ai_processing.ts

import { POLICY, AUX_MODELS, type Env, type CFRunBody } from './ai_models';

/**
 * @description Enhanced AI processing module with timeout handling, improved error handling,
 * and structured response processing. Provides a unified interface for AI model interaction.
 */

// ---------- Response Processing ----------

/**
 * @description Extracts the text response from a Cloudflare AI model result with improved error handling.
 */
export function extractCFText(result: any): string {
  // Handle multiple possible response formats
  const response = result?.response ??
    result?.output_text ??
    result?.content ??
    result?.result?.response ??
    result?.result?.output_text ??
    '';

  if (typeof response === 'object') {
    try {
      return JSON.stringify(response, null, 2);
    } catch (e) {
      console.warn('[AI] Failed to stringify object response:', e);
      return String(response);
    }
  }

  return String(response || '').trim();
}

/**
 * @description Validates and processes structured JSON responses from AI models.
 */
export function processStructuredResponse<T = any>(
  rawResponse: string,
  schema?: object,
  fallbackValue?: T
): T | string {
  if (!rawResponse.trim()) {
    console.warn('[AI] Empty response received');
    return fallbackValue ?? rawResponse;
  }

  // Try to parse as JSON if it looks like JSON
  const trimmed = rawResponse.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);

      // Basic schema validation if provided
      if (schema && typeof parsed === 'object' && parsed !== null) {
        // Simple validation - check if required fields exist
        const schemaProps = (schema as any)?.properties;
        const required = (schema as any)?.required || [];

        for (const field of required) {
          if (!(field in parsed)) {
            console.warn(`[AI] Missing required field in response: ${field}`);
          }
        }
      }

      return parsed as T;
    } catch (e) {
      console.warn('[AI] Failed to parse JSON response, returning as string:', e);
    }
  }

  return rawResponse;
}

// ---------- Enhanced Model Runner with Timeout & Error Handling ----------

/**
 * @description Enhanced model runner with timeout handling and comprehensive error recovery.
 */
export async function runCFModelWithTimeout(
  env: Env,
  model: string,
  body: CFRunBody,
  options: {
    timeout?: number;
    retries?: number;
    fallbackToRest?: boolean;
  } = {}
): Promise<string> {
  const {
    timeout = POLICY.AI_TIMEOUT_MS,
    retries = 1,
    fallbackToRest = true
  } = options;

  console.log(`[AI] Running model '${model}' with timeout ${timeout}ms...`);

  // Create timeout promise
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`AI request timeout after ${timeout}ms`)), timeout);
  });

  let lastError: Error | null = null;

  // Try with binding first if available
  if (env.AI && fallbackToRest !== false) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        console.log(`[AI] Attempt ${attempt + 1}: Using 'env.AI.run' binding for model ${model}.`);

        const aiPromise = env.AI.run(model, body);
        const res = await Promise.race([aiPromise, timeoutPromise]);

        const text = extractCFText(res);
        if (text) {
          console.log(`[AI] Successfully received response from 'env.AI.run' binding.`);
          return text;
        }

        const warning = `[AI] 'env.AI.run' returned empty response on attempt ${attempt + 1}`;
        console.warn(warning);
        lastError = new Error(warning);

      } catch (e: any) {
        lastError = e;
        const isTimeout = e.message?.includes('timeout');
        console.error(`[AI] 'env.AI.run' binding failed on attempt ${attempt + 1}: ${e.message}`);

        if (isTimeout || attempt === retries) {
          break; // Don't retry timeouts or on final attempt
        }

        // Brief delay before retry
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  // Fallback to REST API if binding failed or not available
  if (fallbackToRest) {
    console.log(`[AI] Falling back to Cloudflare REST API for model ${model}.`);

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${model}`;

        const fetchPromise = fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.CF_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        const response = await Promise.race([fetchPromise, timeoutPromise]);

        if (!response.ok) {
          const errorText = await response.text();
          const error = new Error(`AI REST API failed: ${response.status} - ${errorText}`);
          console.error(`[AI] REST API call failed on attempt ${attempt + 1}: ${error.message}`);
          lastError = error;

          if (response.status >= 500 && attempt < retries) {
            // Retry server errors
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
          }

          throw error;
        }

        const data: any = await response.json();
        const text = extractCFText(data?.result);

        if (text) {
          console.log(`[AI] Successfully received response from REST API.`);
          return text;
        }

        const warning = `REST API returned empty result on attempt ${attempt + 1}`;
        console.warn(`[AI] ${warning}`);
        lastError = new Error(warning);

      } catch (e: any) {
        lastError = e;
        const isTimeout = e.message?.includes('timeout');
        console.error(`[AI] REST API failed on attempt ${attempt + 1}: ${e.message}`);

        if (isTimeout || attempt === retries) {
          break;
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  // If we get here, all attempts failed
  const finalError = lastError || new Error('All AI model attempts failed');
  console.error(`[AI] Final failure for model ${model}:`, finalError.message);
  throw finalError;
}

/**
 * @description Legacy wrapper for backward compatibility.
 */
export async function runCFModel(env: Env, model: string, body: CFRunBody): Promise<string> {
  return runCFModelWithTimeout(env, model, body);
}

// ---------- Enhanced High-Level API ----------

/**
 * @description Enhanced callModel with automatic model selection, structured responses, and error handling.
 */
export async function callModel(
  env: Env,
  model: string,
  prompt: string,
  options: {
    schema?: object;
    maxTokens?: number;
    timeout?: number;
    retries?: number;
    structured?: boolean;
  } = {}
): Promise<string> {
  const {
    schema,
    maxTokens = 2048,
    timeout = POLICY.AI_TIMEOUT_MS,
    retries = 1,
    structured = false
  } = options;

  console.log(`[AI] Calling model ${model} with prompt of length: ${prompt.length}`);

  const body: CFRunBody = {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
  };

  if (schema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: schema,
    };
  }

  const rawResponse = await runCFModelWithTimeout(env, model, body, {
    timeout,
    retries
  });

  // Process structured response if requested
  if (structured && (schema || rawResponse.trim().startsWith('{'))) {
    try {
      const processed = processStructuredResponse(rawResponse, schema);
      return typeof processed === 'string' ? processed : JSON.stringify(processed, null, 2);
    } catch (e) {
      console.warn('[AI] Failed to process structured response:', e);
    }
  }

  return rawResponse;
}

/**
 * @description Specialized function for calling models with automatic fallback logic.
 */
export async function callModelWithFallback(
  env: Env,
  primary: string,
  fallback: string | undefined,
  prompt: string,
  options: {
    schema?: object;
    maxTokens?: number;
    timeout?: number;
    structured?: boolean;
  } = {}
): Promise<{ result: string; modelUsed: string }> {

  try {
    console.log(`[AI] Attempting primary model: ${primary}`);
    const result = await callModel(env, primary, prompt, options);
    return { result, modelUsed: primary };
  } catch (e: any) {
    console.error(`[AI] Primary model failed: ${e.message}`);

    if (fallback) {
      console.log(`[AI] Attempting fallback model: ${fallback}`);
      try {
        const result = await callModel(env, fallback, prompt, options);
        return { result, modelUsed: fallback };
      } catch (fallbackError: any) {
        console.error(`[AI] Fallback model also failed: ${fallbackError.message}`);
        throw new Error(`Both primary (${primary}) and fallback (${fallback}) models failed. Last error: ${fallbackError.message}`);
      }
    } else {
      console.error(`[AI] No fallback model available for ${primary}`);
      throw e;
    }
  }
}

// ---------- Translation and Language Processing ----------

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

  try {
    const prompt = `Translate to English: ${text}`;
    const out = await runCFModelWithTimeout(env, AUX_MODELS.M2M100_1_2B.id, {
      prompt,
      max_tokens: 800
    }, {
      timeout: 15000, // Shorter timeout for translation
      retries: 2
    });

    if (out?.trim()) {
      console.log('[Translate] Successfully translated content.');
      return out.trim();
    } else {
      console.warn('[Translate] Translation returned empty result.');
      return text;
    }
  } catch (e: any) {
    console.error('[Translate] Translation failed:', e.message);
    return text; // Return original text on failure
  }
}

// ---------- Utility Functions ----------

/**
 * @description Estimates token count for prompt sizing (rough approximation).
 */
export function estimateTokenCount(text: string): number {
  // Rough approximation: ~4 characters per token for English text
  return Math.ceil(text.length / 4);
}

/**
 * @description Truncates text to fit within token limits while preserving structure.
 */
export function truncateToTokenLimit(text: string, maxTokens: number): string {
  const estimatedTokens = estimateTokenCount(text);

  if (estimatedTokens <= maxTokens) {
    return text;
  }

  const targetLength = Math.floor(maxTokens * 4 * 0.9); // 90% of limit for safety

  if (text.length <= targetLength) {
    return text;
  }

  // Try to truncate at a natural break point
  const truncated = text.substring(0, targetLength);
  const lastNewline = truncated.lastIndexOf('\n');
  const lastPeriod = truncated.lastIndexOf('.');
  const lastSpace = truncated.lastIndexOf(' ');

  // Choose the best break point
  const breakPoint = lastNewline > targetLength * 0.8 ? lastNewline :
                    lastPeriod > targetLength * 0.8 ? lastPeriod + 1 :
                    lastSpace > targetLength * 0.8 ? lastSpace :
                    targetLength;

  return text.substring(0, breakPoint) + (breakPoint < text.length ? '...' : '');
}
