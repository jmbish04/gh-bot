import type { Logger } from '../../../util';
import type { GraphQLErrorPayload } from '../../errors';

export interface GraphQLClientOptions {
  baseUrl?: string;
  token: string;
  timeoutMs?: number;
  requestTag?: string;
  logger?: Logger;
  previews?: string[];
}

export interface InternalGraphQLClientOptions extends GraphQLClientOptions {
  baseUrl: string;
}

export interface GraphQLResponse<T> {
  data: T;
  errors?: GraphQLErrorPayload[];
  response: Response;
}
