import type { AISuggestion as AnalyzerSuggestion } from '../modules/ai_conflict_analyzer'
import type { ConflictRegion as SandboxConflictRegion } from '../modules/sandbox_executor'

/**
 * Metadata describing the input payload sent to the merge conflict workflow when a user
 * requests automated assistance on a pull request.
 */
export interface MergeConflictTrigger {
  owner: string
  repo: string
  prNumber: number
  prTitle: string
  prDescription: string
  triggeredBy: string
  commentId: number
  commentBody: string
  headBranch: string
  baseBranch: string
  repoUrl: string
  cloneUrl: string
}

/**
 * Detailed representation of a file that currently contains merge conflicts. The structure
 * mirrors the parsed git conflict markers returned by the sandbox executor.
 */
export interface ConflictedFile {
  path: string
  language: string
  hasConflicts: boolean
  conflicts: ConflictRegion[]
}

/**
 * Represents a single conflict region within a file including the branch markers, content
 * segments, and positional metadata for diagnostics.
 */
export interface ConflictRegion extends SandboxConflictRegion {
  lineCount: number
  separator: string
}

/**
 * Summary of a merge conflict resolution attempt. Primarily used when returning status to
 * clients polling the Durable Object workflow.
 */
export interface MergeOperationResult {
  operationId: string
  status: 'success' | 'partial' | 'failed'
  conflictsDetected: number
  filesAffected: string[]
  suggestions: AISuggestion[]
  suggestionsPostedAt?: Date
  errors?: string[]
}

/**
 * AI powered suggestion describing a potential merge resolution. This shape mirrors the
 * Workers AI module output while ensuring timestamps are attached for logging and auditing.
 */
export interface AISuggestion extends AnalyzerSuggestion {
  id: string
  timestamp: Date
}
