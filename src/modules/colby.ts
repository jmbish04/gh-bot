// src/modules/colby.ts
import { ghREST } from './github_helpers'

type Env = {
  DB: D1Database
  GITHUB_APP_ID: string
  GITHUB_PRIVATE_KEY: string
  CF_ACCOUNT_ID: string
  CF_API_TOKEN: string
  SUMMARY_CF_MODEL: string
  AI?: unknown
}

type ColbyCommand = {
  id?: number
  deliveryId: string
  repo: string
  prNumber?: number
  author: string
  command: string
  commandArgs?: Record<string, unknown>
  status: 'queued' | 'working' | 'completed' | 'failed'
  promptGenerated?: string
  resultData?: Record<string, unknown>
  errorMessage?: string
}

/**
 * Creates a new colby command record in the database
 */
export async function createColbyCommand(env: Env, cmd: Omit<ColbyCommand, 'id'>): Promise<number> {
  try {
    const result = await env.DB.prepare(`
      INSERT INTO colby_commands
      (delivery_id, repo, pr_number, author, command, command_args, status, prompt_generated, result_data, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      cmd.deliveryId,
      cmd.repo,
      cmd.prNumber || null,
      cmd.author,
      cmd.command,
      cmd.commandArgs ? JSON.stringify(cmd.commandArgs) : null,
      cmd.status,
      cmd.promptGenerated || null,
      cmd.resultData ? JSON.stringify(cmd.resultData) : null,
      cmd.errorMessage || null
    ).run()

    return result.meta?.last_row_id as number
  } catch (error) {
    console.log('Failed to create colby command (table may not exist):', error)
    // Return a dummy ID to allow the flow to continue
    return Date.now()
  }
}

/**
 * Updates a colby command status and result
 */
export async function updateColbyCommand(env: Env, id: number, updates: Partial<ColbyCommand>): Promise<void> {
  try {
    const fields: string[] = []
    const values: (string | number | null)[] = []

    if (updates.status) {
      fields.push('status = ?')
      values.push(updates.status)
    }
    if (updates.promptGenerated) {
      fields.push('prompt_generated = ?')
      values.push(updates.promptGenerated)
    }
    if (updates.resultData) {
      fields.push('result_data = ?')
      values.push(JSON.stringify(updates.resultData))
    }
    if (updates.errorMessage) {
      fields.push('error_message = ?')
      values.push(updates.errorMessage)
    }
    if (updates.status === 'completed' || updates.status === 'failed') {
      fields.push('completed_at = ?')
      values.push(Date.now())
    }

    if (fields.length > 0) {
      values.push(id)
      await env.DB.prepare(`
        UPDATE colby_commands SET ${fields.join(', ')} WHERE id = ?
      `).bind(...values).run()
    }
  } catch (error) {
    console.log('Failed to update colby command (table may not exist):', error)
  }
}

/**
 * Creates an operation progress record for real-time tracking
 */
export async function createOperationProgress(env: Env, operationId: string, type: string, repo: string, prNumber?: number): Promise<void> {
  try {
    await env.DB.prepare(`
      INSERT INTO operation_progress (operation_id, operation_type, repo, pr_number, status, current_step)
      VALUES (?, ?, ?, ?, 'started', 'Initializing...')
    `).bind(operationId, type, repo, prNumber || null).run()
  } catch (error) {
    console.log('Failed to create operation progress (table may not exist):', error)
  }
}

/**
 * Updates operation progress
 */
export async function updateOperationProgress(
  env: Env,
  operationId: string,
  updates: {
    status?: string
    progressPercent?: number
    currentStep?: string
    stepsCompleted?: number
    stepsTotal?: number
    resultData?: Record<string, unknown>
    errorMessage?: string
  }
): Promise<void> {
  try {
    const fields: string[] = []
    const values: (string | number | null)[] = []

    Object.entries(updates).forEach(([key, value]) => {
      if (value !== undefined) {
        const dbField = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
        if (key === 'resultData') {
          fields.push('result_data = ?')
          values.push(JSON.stringify(value))
        } else {
          fields.push(`${dbField} = ?`)
          values.push(typeof value === 'object' ? JSON.stringify(value) : value)
        }
      }
    })

    fields.push('updated_at = ?')
    values.push(Date.now())
    values.push(operationId)

    await env.DB.prepare(`
      UPDATE operation_progress SET ${fields.join(', ')} WHERE operation_id = ?
    `).bind(...values).run()
  } catch (error) {
    console.log('Failed to update operation progress (table may not exist):', error)
  }
}

/**
 * Parses colby command type and arguments from trigger text
 */
export function parseColbyCommand(trigger: string): { command: string; args: Record<string, unknown> } {
  const cleanTrigger = trigger.replace(/^\/colby\s+/, '').trim()

  if (cleanTrigger === 'implement') {
    return { command: 'implement', args: {} }
  }

  if (cleanTrigger === 'create issue') {
    return { command: 'create_issue', args: { assignToCopilot: false } }
  }

  if (cleanTrigger.startsWith('create issue and assign to copilot')) {
    return { command: 'create_issue', args: { assignToCopilot: true } }
  }

  if (cleanTrigger === 'bookmark this suggestion') {
    return { command: 'bookmark_suggestion', args: {} }
  }

  if (cleanTrigger === 'extract suggestions') {
    return { command: 'extract_suggestions', args: {} }
  }

  if (cleanTrigger === 'extract suggestions to issues' || cleanTrigger === 'extract suggestions to issue') {
    return { command: 'extract_suggestions_to_issues', args: {} }
  }

  if (cleanTrigger === 'create llms docs' || cleanTrigger === 'create llm docs' ||
      cleanTrigger === 'fetch llms docs' || cleanTrigger === 'fetch llm docs') {
    return { command: 'create_llms_docs', args: {} }
  }

  if (cleanTrigger === 'optimize worker' || cleanTrigger === 'setup worker') {
    return { command: 'optimize_worker', args: {} }
  }

  if (cleanTrigger === 'group comments by file' || cleanTrigger === 'group comments') {
    return { command: 'group_comments_by_file', args: {} }
  }

  if (cleanTrigger === 'resolve conflicts' || cleanTrigger === 'clear conflicts') {
    return { command: 'resolve_conflicts', args: {} }
  }

  if (cleanTrigger === 'help') {
    return { command: 'help', args: {} }
  }

  return { command: 'unknown', args: {} }
}

/**
 * Generates AI-powered title for GitHub issue with enhanced context
 */
export async function generateIssueTitle(env: Env, context: {
  repo: string;
  prTitle?: string;
  prBody?: string;
  commentBody?: string;
  filePath?: string;
  line?: number;
  suggestions?: string[];
  conversationContext?: string;
}): Promise<string> {
  const prompt = `Analyze this code review context and generate a specific, actionable GitHub issue title:

Repository: ${context.repo}
${context.prTitle ? `PR Title: ${context.prTitle}` : ''}
${context.filePath ? `File: ${context.filePath}${context.line ? ` (line ${context.line})` : ''}` : ''}

${context.suggestions && context.suggestions.length > 0 ? `Code Suggestions:\n${context.suggestions.slice(0, 2).map(s => `- ${s.slice(0, 200)}...`).join('\n')}` : ''}

${context.conversationContext ? `Conversation Context:\n${context.conversationContext.slice(0, 600)}...` : ''}

${context.commentBody ? `Original Comment:\n${context.commentBody}` : ''}

Generate a specific, actionable GitHub issue title that captures the main problem/suggestion from the comment. The title should be:
- Clear and descriptive (50-60 characters max)
- Action-oriented (use verbs like "Fix", "Add", "Improve", "Refactor")
- Specific to the code/file being discussed
- Professional and concise

Examples:
- "Fix authentication bug in user login flow"
- "Add error handling to API endpoints in auth.ts"
- "Improve type safety in user validation"
- "Refactor database connection logic"
- "Implement caching for database queries"
- "Optimize performance in file upload component"

Respond with only the title (no quotes, no extra text). Maximum 72 characters.`

  try {
    console.log('[AI] Generating issue title with context:', {
      repo: context.repo,
      filePath: context.filePath,
      line: context.line,
      hasCommentBody: !!context.commentBody,
      hasSuggestions: !!context.suggestions?.length,
      hasConversationContext: !!context.conversationContext
    })

    const result = await (env.AI as any).run(env.SUMMARY_CF_MODEL, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000
    })

    console.log('[AI] Title generation result:', {
      hasResult: !!result,
      resultType: typeof result,
      response: result?.response,
      content: result?.content,
      fullResult: result
    })

    const title = result?.response || result?.content || 'Implement suggestion from code review'
    const cleanedTitle = title.replace(/["\n\r]/g, '').slice(0, 72).trim()

    console.log('[AI] Final title:', cleanedTitle)
    return cleanedTitle
  } catch (error) {
    console.error('Failed to generate issue title:', error)
    console.error('Error details:', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    })
    return 'Implement suggestion from code review'
  }
}

/**
 * Generates AI-powered rich issue body with full context
 */
export async function generateIssueBody(env: Env, context: {
  repo: string;
  prNumber: number;
  prTitle?: string;
  prBody?: string;
  author: string;
  commentBody?: string;
  filePath?: string;
  line?: number;
  diffHunk?: string;
  suggestions?: string[];
  conversationContext?: string;
  originalComment?: Record<string, unknown>;
}): Promise<string> {
  const prompt = `Generate a comprehensive GitHub issue description based on this code review context:

Repository: ${context.repo}
PR: #${context.prNumber} - ${context.prTitle || 'Pull Request'}
Author: @${context.author}
${context.filePath ? `File: ${context.filePath}${context.line ? ` (line ${context.line})` : ''}` : ''}

${context.conversationContext ? `## Discussion Context\n${context.conversationContext}\n\n` : ''}

${context.commentBody ? `## Original Comment\n> ${context.commentBody}\n\n` : ''}

${context.suggestions && context.suggestions.length > 0 ? `## Code Suggestions\n${context.suggestions.map((s, i) => `### Suggestion ${i + 1}\n\`\`\`\n${s}\n\`\`\`\n`).join('\n')}\n` : ''}

${context.diffHunk ? `## Code Context\n\`\`\`diff\n${context.diffHunk}\n\`\`\`\n\n` : ''}

Generate a structured issue description that includes:
1. **Problem Statement**: Clear description of the issue or improvement needed
2. **Context**: Background information and why this matters
3. **Proposed Solution**: Specific steps or approach to address the issue
4. **Code References**: Specific files, functions, or lines that need attention
5. **Acceptance Criteria**: Clear definition of what "done" looks like

Format the response as proper GitHub markdown with clear sections and bullet points.`

  try {
    const result = await (env.AI as any).run(env.SUMMARY_CF_MODEL, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000
    })

    const aiBody = result?.response || result?.content || ''

    // Create structured issue body with AI content and context
    let issueBody = aiBody

    // Add metadata section
    issueBody += `

---

## Issue Metadata
- **Created from:** [PR #${context.prNumber}](../pull/${context.prNumber}) code review
- **Requested by:** @${context.author}
${context.filePath ? `- **File:** \`${context.filePath}\`` : ''}
${context.line ? `- **Line:** ${context.line}` : ''}

## Original Discussion Context
${context.commentBody || 'From code review comment'}

${context.suggestions && context.suggestions.length > 0 ? `\n## Code Suggestions\n${context.suggestions.map((s, i) => `<details>\n<summary>Suggestion ${i + 1}</summary>\n\n\`\`\`\n${s}\n\`\`\`\n</details>`).join('\n\n')}\n` : ''}

---
_This issue was automatically created by Colby from a code review discussion._`

    return issueBody
  } catch (error) {
    console.error('Failed to generate issue body:', error)

    // Fallback to structured manual body
    return `This issue was created from a code review discussion.

## Context
- **PR:** #${context.prNumber} - ${context.prTitle || 'Pull Request'}
- **Author:** @${context.author}
${context.filePath ? `- **File:** \`${context.filePath}\`` : ''}
${context.line ? `- **Line:** ${context.line}` : ''}

## Discussion
${context.commentBody || 'From code review comment'}

${context.suggestions && context.suggestions.length > 0 ? `\n## Suggestions\n${context.suggestions.map((s, i) => `${i + 1}. \`\`\`\n${s}\n\`\`\``).join('\n\n')}\n` : ''}

${context.diffHunk ? `\n## Code Context\n\`\`\`diff\n${context.diffHunk}\n\`\`\`\n` : ''}

---
_This issue was automatically created by Colby._`
  }
}

/**
 * Gathers conversation context from a comment thread
 */
export async function gatherConversationContext(
  env: Env,
  token: string,
  repo: string,
  commentId: number,
  eventKind: string
): Promise<string> {
  try {
    const [owner, repoName] = repo.split('/')
    let conversationText = ''

    if (eventKind === 'review_comment') {
      // For review comments, try to get the review and related comments
      try {
        const reviewComment = await ghREST(token, 'GET', `/repos/${owner}/${repoName}/pulls/comments/${commentId}`)
        const reviewId = (reviewComment as any)?.pull_request_review_id

        if (reviewId) {
          // Get the full review
          const review = await ghREST(token, 'GET', `/repos/${owner}/${repoName}/pulls/reviews/${reviewId}`)

          if ((review as any)?.body) {
            conversationText += `**Review Summary:**\n${(review as any).body}\n\n`
          }

          // Get all comments in this review
          const reviewComments = await ghREST(token, 'GET', `/repos/${owner}/${repoName}/pulls/reviews/${reviewId}/comments`) as any[]

          if (Array.isArray(reviewComments) && reviewComments.length > 1) {
            conversationText += `**Review Comments:**\n`
            reviewComments
              .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
              .forEach((comment, i) => {
                if (comment.id !== commentId) {
                  conversationText += `${i + 1}. **@${comment.user.login}** (${comment.path}:${comment.line}):\n${comment.body}\n\n`
                }
              })
          }
        }
      } catch (error) {
        console.log('Could not fetch review context:', error)
      }
    } else if (eventKind === 'issue_comment') {
      // For issue comments, try to get recent comments on the PR
      try {
        const comments = await ghREST(token, 'GET', `/repos/${owner}/${repoName}/issues/comments`) as any[]

        if (Array.isArray(comments)) {
          const recentComments = comments
            .filter(c => c.id !== commentId)
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
            .slice(0, 3)

          if (recentComments.length > 0) {
            conversationText += `**Recent Discussion:**\n`
            recentComments.reverse().forEach((comment, i) => {
              conversationText += `${i + 1}. **@${comment.user.login}**:\n${comment.body.slice(0, 300)}${comment.body.length > 300 ? '...' : ''}\n\n`
            })
          }
        }
      } catch (error) {
        console.log('Could not fetch issue comments:', error)
      }
    }

    return conversationText.trim()
  } catch (error) {
    console.error('Failed to gather conversation context:', error)
    return ''
  }
}

/**
 * Creates a GitHub issue
 */
export async function createGitHubIssue(
  env: Env,
  token: string,
  repo: string,
  title: string,
  body: string,
  assignee?: string,
  labels?: string[]
): Promise<{ issueNumber: number; issueId: number; url: string }> {
  const [owner, repoName] = repo.split('/')

  const issueData: {
    title: string;
    body: string;
    assignees?: string[];
    labels?: string[];
  } = {
    title,
    body
  }

  if (assignee) {
    issueData.assignees = [assignee]
  }

  if (labels && labels.length > 0) {
    issueData.labels = labels
  }

  const issue = await ghREST(token, 'POST', `/repos/${owner}/${repoName}/issues`, issueData)

  if (!issue || typeof issue !== 'object' || !('number' in issue)) {
    throw new Error('Failed to create GitHub issue')
  }

  return {
    issueNumber: (issue as any).number,
    issueId: (issue as any).id,
    url: (issue as any).html_url
  }
}

/**
 * Bookmarks a suggestion as a best practice
 */
export async function bookmarkSuggestion(
  env: Env,
  suggestion: {
    text: string
    contextRepo: string
    contextPr?: number
    contextFile?: string
    bookmarkedBy: string
  }
): Promise<number> {
  try {
    // Generate AI tags for categorization
    const tags = await generateSuggestionTags(env, suggestion.text, suggestion.contextRepo)

    const result = await env.DB.prepare(`
      INSERT INTO best_practices
      (suggestion_text, context_repo, context_pr, context_file, ai_tags, category, subcategory, confidence, bookmarked_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      suggestion.text,
      suggestion.contextRepo,
      suggestion.contextPr || null,
      suggestion.contextFile || null,
      JSON.stringify(tags.tags),
      tags.category,
      tags.subcategory,
      tags.confidence,
      suggestion.bookmarkedBy
    ).run()

    return result.meta?.last_row_id as number
  } catch (error) {
    console.log('Failed to bookmark suggestion (table may not exist):', error)
    // Return a dummy ID to allow the flow to continue
    return Date.now()
  }
}

/**
 * Generates AI tags for suggestion categorization
 */
async function generateSuggestionTags(env: Env, suggestionText: string, repo: string): Promise<{
  tags: string[]
  category: string
  subcategory: string
  confidence: number
}> {
  const prompt = `Analyze this code suggestion and generate categorization tags:

Repository: ${repo}
Suggestion: ${suggestionText}

Respond with valid JSON only:
{
  "tags": ["tag1", "tag2", "tag3"],
  "category": "infrastructure|framework|security|performance|testing|documentation",
  "subcategory": "workers|appscript|python|react|vue|tailwind|shadcn|typescript|etc",
  "confidence": 0.8
}

Focus on technical categorization based on the suggestion content.`

  try {
    const result = await (env.AI as any).run(env.SUMMARY_CF_MODEL, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200
    })

    const content = result?.response || result?.content || '{}'

    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    const jsonStr = jsonMatch ? jsonMatch[0] : '{}'

    try {
      const parsed = JSON.parse(jsonStr)
      return {
        tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 10) : ['general'],
        category: parsed.category || 'infrastructure',
        subcategory: parsed.subcategory || 'general',
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5))
      }
    } catch {
      return {
        tags: ['general'],
        category: 'infrastructure',
        subcategory: 'general',
        confidence: 0.3
      }
    }
  } catch (error) {
    console.error('Failed to generate suggestion tags:', error)
    return {
      tags: ['general'],
      category: 'infrastructure',
      subcategory: 'general',
      confidence: 0.3
    }
  }
}

/**
 * Generates a unique operation ID
 */
export function generateOperationId(): string {
  return `op_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}
