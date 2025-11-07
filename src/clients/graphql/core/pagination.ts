export interface PageInfo {
  hasNextPage: boolean;
  endCursor?: string | null;
}

export function hasNext(pageInfo?: PageInfo | null): boolean {
  return Boolean(pageInfo?.hasNextPage && pageInfo?.endCursor);
}

export function cursor(pageInfo?: PageInfo | null): string | null {
  return pageInfo?.endCursor ?? null;
}
