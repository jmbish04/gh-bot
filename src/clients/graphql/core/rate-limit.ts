export interface GraphQLRateLimit {
  cost?: number;
  remaining?: number;
  resetAt?: string;
}

export function extractRateLimit(result: { rateLimit?: GraphQLRateLimit }): GraphQLRateLimit {
  return result.rateLimit ?? {};
}
