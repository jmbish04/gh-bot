import type { Logger } from '../../../util';

export interface GitHubAppRequestOptions {
  baseUrl?: string;
  requestTag?: string;
  logger?: Logger;
}
