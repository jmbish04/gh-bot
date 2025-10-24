import type { RestClient } from '../core/client';

export function getUser<T = unknown>(client: RestClient, username: string): Promise<T> {
  return client.request<T>(`/users/${username}`);
}
