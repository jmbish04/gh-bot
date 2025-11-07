import { composeHeaders } from './request';
import { ensureOk, safeParseJSON } from './response';
import type { InternalRestClientOptions, RestRequestInit, RestResponse } from './types';

export async function requestJson<T>(
  url: URL,
  options: InternalRestClientOptions,
  init?: RestRequestInit
): Promise<RestResponse<T>> {
  const controller = options.timeoutMs ? new AbortController() : undefined;
  const timeout = options.timeoutMs ? setTimeout(() => controller?.abort(), options.timeoutMs) : undefined;

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller?.signal ?? init?.signal,
      headers: composeHeaders(options, init?.headers),
    });

    await ensureOk(response, url.toString());

    if (response.status === 204 || response.status === 205) {
      return { data: undefined as T, response };
    }

    const text = await response.text();
    const data = text ? (safeParseJSON<T>(text) as T) : (undefined as T);
    return { data, response };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
