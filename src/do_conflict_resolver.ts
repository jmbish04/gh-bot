import { DurableObject } from 'cloudflare:workers'
import { analyzeConflicts, type AISuggestion } from './modules/ai_conflict_analyzer'
import { detectConflicts, type SandboxConflictResult } from './modules/sandbox_executor'
import { OperationLogger } from './modules/operation_logger'
import {
  createInstallationClient,
  GitHubClient,
  type GitHubEnv,
  postPRComment,
  getPRBranchDetails,
} from './github'
import type { MergeConflictTrigger } from './types/merge_conflicts'

interface ConflictResolverEnv extends GitHubEnv {
  DB: D1Database
  AI?: any
  Sandbox?: Fetcher
}

interface ResolveRequestBody {
  operationId: string
  trigger: MergeConflictTrigger
  installationId?: number
}

interface StoredOperationState {
  status: (typeof STATUS)[keyof typeof STATUS]
  conflicts?: SandboxConflictResult
  suggestions?: AISuggestion[]
  updatedAt: number
}

const STATUS = {
  pending: 'pending',
  cloning: 'cloning',
  detecting: 'detecting',
  analyzing: 'analyzing',
  suggestionPosted: 'suggestion_posted',
  completed: 'completed',
  failed: 'failed',
} as const

/**
 * Durable Object responsible for orchestrating merge conflict detection and AI suggestion
 * generation inside an isolated Cloudflare Sandbox container.
 */
export class ConflictResolver extends DurableObject {
  private readonly env: ConflictResolverEnv
  private readonly state: DurableObjectState

  constructor(state: DurableObjectState, env: ConflictResolverEnv) {
    super(state, env)
    this.state = state
    this.env = env
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    switch (url.pathname) {
      case '/resolve':
        return this.handleMergeConflictResolution(request)
      case '/status':
        return this.handleStatus()
      default:
        return new Response('Not found', { status: 404 })
    }
  }

  private async handleStatus(): Promise<Response> {
    const state = (await this.state.storage.get<StoredOperationState>('operation')) ?? null
    return new Response(JSON.stringify(state ?? { status: STATUS.pending }), {
      headers: { 'content-type': 'application/json' },
    })
  }

  /**
   * Entrypoint invoked by the webhook handler when a merge conflict resolution flow should begin.
   */
  private async handleMergeConflictResolution(request: Request): Promise<Response> {
    const body = (await request.json()) as ResolveRequestBody
    const { operationId, trigger, installationId } = body

    if (!operationId || !trigger) {
      return new Response('Invalid payload', { status: 400 })
    }

    const logger = new OperationLogger({ DB: this.env.DB }, operationId)
    await logger.info('Conflict resolution workflow triggered', { trigger })

    await this.updateState({ status: STATUS.pending })
    await this.updateDb(operationId, { status: STATUS.cloning })

    try {
      const githubClient = await this.getGitHubClient(installationId)
      const branchDetails = await getPRBranchDetails(
        githubClient,
        trigger.owner,
        trigger.repo,
        trigger.prNumber,
      )

      await this.updateDb(operationId, {
        status: STATUS.detecting,
        head_branch: branchDetails.headBranch,
        base_branch: branchDetails.baseBranch,
      })

      const conflicts = await detectConflicts(
        this.env,
        trigger.cloneUrl || trigger.repoUrl,
        branchDetails.headBranch,
        branchDetails.baseBranch,
        this.env.GITHUB_TOKEN,
      )

      await logger.info('Sandbox merge conflict detection complete', { conflicts })
      await this.updateState({ status: STATUS.detecting, conflicts })
      await this.updateDb(operationId, {
        conflict_files: JSON.stringify(conflicts.conflictFiles ?? []),
        conflicts_detected: conflicts.conflictFiles.length,
      })

      if (!conflicts.hasConflicts) {
        await postPRComment(
          githubClient,
          trigger.owner,
          trigger.repo,
          trigger.prNumber,
          '✅ No merge conflicts detected. The pull request merges cleanly into the base branch.',
        )
        await this.updateDb(operationId, {
          status: STATUS.completed,
          conflicts_detected: 0,
          conflict_files: JSON.stringify([]),
          suggestion_comment_id: null,
          suggestion_posted_at: new Date().toISOString(),
        })
        await this.updateState({ status: STATUS.completed })
        return new Response(JSON.stringify({ status: STATUS.completed }), {
          headers: { 'content-type': 'application/json' },
        })
      }

      await this.updateDb(operationId, {
        status: STATUS.analyzing,
        conflicts_detected: conflicts.conflictFiles.length,
      })

      const suggestions = await analyzeConflicts(this.env, conflicts, {
        title: trigger.prTitle,
        description: trigger.prDescription,
      })

      await logger.info('AI analysis completed', { suggestions })
      await this.updateState({ status: STATUS.analyzing, conflicts, suggestions })

      const commentBody = this.buildSuggestionComment(trigger, suggestions)
      const comment = await postPRComment(
        githubClient,
        trigger.owner,
        trigger.repo,
        trigger.prNumber,
        commentBody,
      )

      await this.updateDb(operationId, {
        status: STATUS.suggestionPosted,
        ai_analysis: JSON.stringify(suggestions),
        suggestion_comment_id: comment.comment_id ?? null,
        suggestion_posted_at: new Date().toISOString(),
      })

      await this.updateState({ status: STATUS.suggestionPosted, suggestions })
      await logger.info('Posted merge conflict suggestions to pull request', { comment })

      return new Response(JSON.stringify({ status: STATUS.suggestionPosted, comment }), {
        headers: { 'content-type': 'application/json' },
      })
    } catch (error) {
      await logger.error('Conflict resolution workflow failed', {
        message: (error as Error).message,
        stack: (error as Error).stack,
      })
      await this.updateDb(operationId, {
        status: STATUS.failed,
        error_message: (error as Error).message,
      })
      await this.updateState({ status: STATUS.failed })
      return new Response('Internal Server Error', { status: 500 })
    }
  }

  private async getGitHubClient(installationId?: number): Promise<GitHubClient> {
    if (installationId) {
      return createInstallationClient(this.env, installationId)
    }

    if (this.env.GITHUB_TOKEN) {
      return new GitHubClient({ personalAccessToken: this.env.GITHUB_TOKEN, env: this.env })
    }

    throw new Error('No GitHub credentials available for conflict resolution workflow')
  }

  private buildSuggestionComment(trigger: MergeConflictTrigger, suggestions: AISuggestion[]): string {
    const header = `🤖 Detected merge conflicts for #${trigger.prNumber}. Here are my suggestions:`
    const sections = suggestions.map((suggestion) => {
      const altText = suggestion.alternatives && suggestion.alternatives.length > 0
        ? `\n\n**Alternatives:**\n${suggestion.alternatives.map((alt) => `- ${alt}`).join('\n')}`
        : ''

      return [
        `### ${suggestion.filePath}`,
        `**Confidence:** ${(suggestion.confidence * 100).toFixed(0)}%`,
        `**Risk:** ${suggestion.riskLevel}`,
        `**Reasoning:** ${suggestion.reasoning}`,
        '\n```suggestion\n' + suggestion.suggestedResolution.trim() + '\n```',
        altText,
      ].join('\n')
    })

    return [header, ...sections, '\n_I will wait for a maintainer to review and apply the resolution._'].join('\n\n')
  }

  private async updateState(patch: Partial<StoredOperationState>): Promise<void> {
    const current = ((await this.state.storage.get<StoredOperationState>('operation')) ?? {
      status: STATUS.pending,
      updatedAt: Date.now(),
    }) as StoredOperationState

    const next: StoredOperationState = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    }

    await this.state.storage.put('operation', next)
  }

  private async updateDb(operationId: string, fields: Record<string, unknown>): Promise<void> {
    const columns = Object.keys(fields)
    if (columns.length === 0) {
      return
    }

    const assignments = columns.map((column) => `${column} = ?`).join(', ')
    const values = Object.values(fields)

    await this.env.DB.prepare(
      `UPDATE merge_operations SET ${assignments} WHERE id = ?`,
    )
      .bind(...values, operationId)
      .run()
  }
}
