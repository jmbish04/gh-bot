// filepath: src/types/db.ts
// Types for database module

export interface ToolCallDetails<TRequest = any, TResponse = any> {
  request: TRequest
  response: TResponse
}

export interface RecentQuery {
  id: number
  text: string
  response: string
  queried_at: number | string
}

export interface TrendingUser {
  username: string
  search_count: number
  last_searched: number | string
  avatar_url?: string
}

export interface UserQuery {
  userMessage: string
  assistantReply: string
  toolCalls: Array<ToolCallDetails>
}
