import type { RateLimitInfo } from './types';
import { parseRateLimit } from './response';

export function readRateLimit(headers: Headers): RateLimitInfo {
  return parseRateLimit(headers);
}
