import type { RestClient } from '../core/client';

export function getOrg<T = unknown>(client: RestClient, org: string): Promise<T> {
  return client.request<T>(`/orgs/${org}`);
}
