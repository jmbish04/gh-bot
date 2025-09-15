/// <reference types="@cloudflare/workers-types" />
import { summarizePRWithAI } from './modules/ai_summary'
import {
  bookmarkSuggestion,
  createColbyCommand,
  createGitHubIssue,
  createOperationProgress,
  gatherConversationContext,
  generateIssueBody,
  generateIssueTitle,
  generateOperationId,
  parseColbyCommand,
  updateColbyCommand,
  updateOperationProgress
} from './modules/colby'
import { getInstallationToken, ghGraphQL, ghREST, replyToGitHubComment, addReactionToComment } from './modules/github_helpers'
import { buildFileChangesFromSuggestions } from './modules/patcher'

interface GitHubComment {
  id: number
  body: string
  path?: string
  diff_hunk?: string
  line?: number
  user?: {
    type: string
  }
}

interface PREvent {
  kind: string
  repo: string
  prNumber?: number
  issueNumber?: number
  author: string
  suggestions?: string[]
  triggers?: string[]
  installationId?: number
  installation?: { id: number }
  commentId?: number
  commentBody?: string
  filePath?: string
  line?: number
  side?: string
  diffHunk?: string
  headRef?: string
  headSha?: string
  delivery?: string
}

interface ColbyCommandArgs {
  assignToCopilot?: boolean
}

type Env = {
  DB: D1Database
  PR_WORKFLOWS: DurableObjectNamespace
  GITHUB_APP_ID: string
  GITHUB_PRIVATE_KEY: string
  CF_ACCOUNT_ID: string
  CF_API_TOKEN: string
  SUMMARY_CF_MODEL: string
  AI?: unknown
}

/**
 * Durable Object class for managing pull request workflows.
 *
 * This class handles events related to pull requests, such as summarizing PRs,
 * applying suggestions, and interacting with GitHub APIs.
 */
export class PrWorkflow {
  state: DurableObjectState
  env: Env
  constructor(state: DurableObjectState, env: Env) { this.state = state; this.env = env }

  /**
   * Handles incoming HTTP requests to the Durable Object.
   *
   * @param req - The incoming HTTP request.
   * @returns A Response object indicating the result of the request handling.
   */
  async fetch(req: Request) {
    const url = new URL(req.url)
    if (url.pathname === '/event' && req.method === 'POST') {
      const evt = await req.json() as PREvent
      // serialize per PR
      return await this.state.blockConcurrencyWhile(async () => this.handleEvent(evt))
    } else if (url.pathname === '/create-llms-docs' && req.method === 'POST') {
      const evt = await req.json() as PREvent
      // Handle automatic LLMs documentation creation for new repositories
      return await this.state.blockConcurrencyWhile(async () => this.handleAutoLlmDocsCreation(evt))
    } else if (url.pathname === '/optimize-worker' && req.method === 'POST') {
      const evt = await req.json() as PREvent
      // Handle automatic worker optimization for new repositories
      return await this.state.blockConcurrencyWhile(async () => this.handleAutoWorkerOptimization(evt))
    }
    return new Response('not found', { status: 404 })
  }

  private async handleEvent(evt: PREvent) {
    const startTime = Date.now()

    console.log('[DO] Event received with full context:', {
      kind: evt.kind,
      repo: evt.repo,
      prNumber: evt.prNumber,
      author: evt.author,
      hasSuggestions: Array.isArray(evt.suggestions) && evt.suggestions.length > 0,
      suggestionsCount: evt.suggestions?.length || 0,
      triggers: evt.triggers || [],
      installationId: evt.installationId,
      // Context data for comment targeting
      commentId: evt.commentId,
      filePath: evt.filePath,
      line: evt.line,
      side: evt.side,
      diffHunk: evt.diffHunk ? 'present' : 'none',
      headRef: evt.headRef,
      headSha: evt.headSha
    })

    try {
      // Basic validation for anything that touches GitHub
      const [owner, repo] = (evt.repo || '').split('/')
      if (!owner || !repo) {
        console.log('[DO] ERROR: Invalid repo format:', evt.repo)
        return new Response('invalid repo format', { status: 400 })
      }

      const needsAuth = ['review_comment','pr_review','issue_comment','issue_opened','pull_request'].includes(evt.kind)
      if (needsAuth && !evt.installationId) {
        console.log('[DO] ERROR: Missing installationId for event type:', evt.kind)
        return new Response('missing installationId', { status: 400 })
      }

      const hasSuggestions = Array.isArray(evt.suggestions) && evt.suggestions.length > 0
      const triggers = Array.isArray(evt.triggers) ? evt.triggers.map((t: any) => String(t).toLowerCase()) : []

      // Log webhook command details for analysis
      await this.logWebhookCommands(evt, triggers, startTime)

      // ---- Commands first (explicit instructions win) ----
      if (triggers.length) {
        // Provide immediate feedback for any commands
        await this.sendImmediateFeedback(evt, triggers)

        // Handle /colby commands
        const colbyTriggers = triggers.filter((t: any) => String(t).startsWith('/colby'))
        if (colbyTriggers.length > 0) {
          return await this.handleColbyCommands(evt, colbyTriggers)
        }

        // /apply applies suggestions if present; otherwise it tries to harvest from the related review/comment
        if (triggers.some((t: any) => String(t).startsWith('/apply'))) {
          if (!hasSuggestions && (evt.kind === 'issue_comment')) {
            // No suggestions in issue comments; tell user how to use it
            await this.commentOnPR(evt, `ℹ️ No \`\`\`suggestion\`\`\` blocks found to apply. Add a review comment with a \`\`\`suggestion\`\`\` fence and re-run /apply.`)
            return new Response('no-suggestions', { status: 200 })
          }
          const res = await this.applySuggestionsCommit(evt)
          return new Response(res, { status: 200 })
        }

        if (triggers.some((t: any) => String(t).startsWith('/summarize'))) {
          await this.postPRSummary(evt)
          return new Response('summarized', { status: 200 })
        }

        // TODO: /fix, /lint, /test hooks here
      }

      // ---- Implicit behavior: auto-apply when suggestions exist ----
      if ((evt.kind === 'review_comment' || evt.kind === 'pr_review') && hasSuggestions && evt.suggestions) {
        console.log('[DO] Auto-applying suggestions:', {
          kind: evt.kind,
          suggestionsCount: evt.suggestions.length,
          repo: evt.repo,
          prNumber: evt.prNumber
        })

        // Optional: cap the number to avoid huge commits
        if (evt.suggestions.length > 50) {
          await this.commentOnPR(evt, `⚠️ Found ${evt.suggestions.length} suggestions; capping at 50. Use multiple /apply runs if needed.`)
          evt.suggestions = evt.suggestions.slice(0, 50)
        }

        try {
          const res = await this.applySuggestionsCommit(evt)
          console.log('[DO] Auto-apply result:', res)
          return new Response(res, { status: 200 })
        } catch (applyError) {
          console.log('[DO] ERROR in auto-apply:', applyError)
          throw applyError
        }
      }

      // PR lifecycle events (future: label gates, synchronize hooks, etc.)
      if (evt.kind === 'pull_request') {
        return new Response('pr-event-ack', { status: 200 })
      }

      return new Response('ok', { status: 200 })
    } catch (err: any) {
      console.log('[DO] ERROR in handleEvent:', {
        error: err?.message || String(err),
        stack: err?.stack,
        event: {
          kind: evt?.kind,
          repo: evt?.repo,
          prNumber: evt?.prNumber,
          author: evt?.author
        }
      })

      // Immediate error feedback to user
      const errorMsg = `❌ **Command Failed**: ${err?.message || 'Unknown error occurred'}`
      try {
        await this.commentOnPR(evt, errorMsg)
      } catch (commentErr) {
        console.log('Failed to post error comment:', commentErr)
      }

      // Log the command failure
      await this.logCommandFailure(evt, err, startTime)

      // Distinguish race vs. generic error (useful if you add requeue-on-409 later)
      const msg = (err?.message || '').toLowerCase()
      const code = msg.includes('409') || msg.includes('expectedheadoid')
        ? 409 : 500
      return new Response('error', { status: code })
    }
  }

  private async applySuggestionsCommit(evt: PREvent) {
    const [owner, repo] = evt.repo.split('/')
    const installationId = evt.installationId || evt.installation?.id

    // Validate required fields
    if (!installationId) {
      throw new Error('Missing installationId - cannot authenticate with GitHub')
    }
    if (!evt.headRef) {
      throw new Error('Missing headRef - cannot determine target branch')
    }
    if (!evt.headSha) {
      throw new Error('Missing headSha - cannot create commit safely')
    }

    const token = await getInstallationToken(this.env, installationId)

    // If we have suggestions directly, use them
    let filesMap: Record<string, string> = {}

    if (evt.suggestions && evt.suggestions.length > 0 && evt.filePath && evt.diffHunk) {
      // 1) Build file changes from suggestions using the file's HEAD content + diff context
      filesMap = await buildFileChangesFromSuggestions({
        token,
        owner,
        repo,
        headSha: evt.headSha!,
        filePath: evt.filePath!,
        diffHunk: evt.diffHunk!,
        suggestions: evt.suggestions
      })
    } else {
      // 2) For /apply without suggestions, try to harvest from PR review comments
      if (!evt.prNumber || !evt.headSha) {
        console.log('[DO] Missing required PR data for harvesting suggestions:', {
          prNumber: evt.prNumber,
          headSha: evt.headSha
        })
        return 'no-applicable-suggestions'
      }
      filesMap = await this.harvestSuggestionsFromPR(token, owner, repo, evt.prNumber, evt.headSha)
    }

    if (!filesMap || Object.keys(filesMap).length === 0) {
      return 'no-applicable-suggestions'
    }

    // 2) Commit via GraphQL createCommitOnBranch
    const input = {
      branch: { repositoryNameWithOwner: evt.repo, branchName: evt.headRef },
      expectedHeadOid: evt.headSha,
      message: { headline: `chore: apply ${Object.keys(filesMap).length} suggestion(s)` },
      fileChanges: {
        additions: Object.entries(filesMap).map(([path, contents]) => ({ path, contents }))
      }
    }

    try {
      const r = await ghGraphQL(token, `
        mutation Commit($input: CreateCommitOnBranchInput!) {
          createCommitOnBranch(input: $input) { commit { oid url } }
        }`, { input }
      )

      if (!r?.data?.createCommitOnBranch?.commit?.oid) {
        // Check for specific GitHub API errors
        if (r?.errors) {
          const errorMsg = r.errors.map((e: any) => e.message).join('; ')
          if (errorMsg.toLowerCase().includes('expectedheadoid') || errorMsg.toLowerCase().includes('expected head oid')) {
            throw new Error(`Head moved: ${errorMsg}`)
          }
          throw new Error(`GitHub API error: ${errorMsg}`)
        }
        throw new Error('createCommitOnBranch failed: ' + JSON.stringify(r))
      }

      // 3) Comment back with success
      await ghREST(token, 'POST',
        `/repos/${owner}/${repo}/issues/${evt.prNumber}/comments`,
        { body: `✅ Applied ${Object.keys(filesMap).length} suggestion(s). Commit: ${r.data.createCommitOnBranch.commit.url}` }
      )

      return 'committed'
    } catch (err: any) {
      // Handle specific error types
      const errorMsg = err?.message || String(err)
      if (errorMsg.toLowerCase().includes('expectedheadoid') || errorMsg.toLowerCase().includes('head moved')) {
        // This is a 409-style conflict - head has moved since we started
        throw new Error(`409: ${errorMsg}`)
      }
      throw err
    }
  }

  private async postPRSummary(evt: PREvent) {
    const [owner, repo] = evt.repo.split('/')
    const installationId = evt.installationId || evt.installation?.id
    if (!installationId) {
      throw new Error('Missing installationId for PR summary')
    }
    const token = await getInstallationToken(this.env, installationId)

    // Collect PR metadata + changed files
    const pr = await ghREST(token, 'GET', `/repos/${owner}/${repo}/pulls/${evt.prNumber}`)
    const files = await ghREST(token, 'GET', `/repos/${owner}/${repo}/pulls/${evt.prNumber}/files?per_page=100`)

    const summary = await summarizePRWithAI(this.env, { pr, files })

    await ghREST(token, 'POST',
      `/repos/${owner}/${repo}/issues/${evt.prNumber}/comments`,
      { body: `🧠 **PR Summary**\n\n${summary}` }
    )
  }

  private async commentOnPR(evt: PREvent, body: string) {
    // For issue_opened events, we use issueNumber instead of prNumber
    const issueOrPrNumber = evt.prNumber || (evt as any).issueNumber

    console.log('[DO] commentOnPR called with:', {
      kind: evt.kind,
      commentId: evt.commentId,
      prNumber: evt.prNumber,
      issueNumber: (evt as any).issueNumber,
      issueOrPrNumber
    })

    console.log('[DO] Attempting to comment on PR/Issue:', {
      hasEvent: !!evt,
      hasInstallationId: !!evt?.installationId,
      hasRepo: !!evt?.repo,
      hasPrNumber: !!evt?.prNumber,
      hasIssueNumber: !!(evt as any).issueNumber,
      issueOrPrNumber: issueOrPrNumber,
      repo: evt?.repo,
      bodyLength: body?.length,
      eventKind: evt?.kind,
      filePath: evt?.filePath,
      line: evt?.line,
      hasCommentId: !!evt?.commentId,
      commentId: evt?.commentId
    })

    if (!evt || !evt.installationId || !evt.repo || !issueOrPrNumber) {
      console.log('[DO] ERROR: Missing required fields for commenting')
      return
    }

    const [owner, repo] = evt.repo.split('/')
    console.log('[DO] Getting token for comment...', { owner, repo, issueOrPrNumber })

    try {
      const token = await getInstallationToken(this.env, evt.installationId)
      console.log('[DO] Token obtained, posting comment...')

      let response

      // For comments with commentId (review comments or replies to review comments), use the robust reply handler
      if (evt.commentId) {
        console.log('[DO] Using robust comment reply handler for comment:', {
          kind: evt.kind,
          commentId: evt.commentId
        })

        try {
          response = await replyToGitHubComment({
            installationToken: token,
            owner,
            repo,
            prNumber: issueOrPrNumber,
            commentId: evt.commentId,
            body
          })
          console.log('[DO] Successfully posted reply via robust handler')
        } catch (replyError) {
          console.log('[DO] Robust reply handler failed, falling back to main PR/issue thread:', replyError)
          // Final fallback to main PR/issue thread
          response = await ghREST(token, 'POST', `/repos/${owner}/${repo}/issues/${issueOrPrNumber}/comments`, { body })
        }
      } else {
        // For other comment types (general PR/issue comments without specific commentId), post to main PR/issue thread
        console.log('[DO] Posting comment to main PR/issue thread')
        response = await ghREST(token, 'POST', `/repos/${owner}/${repo}/issues/${issueOrPrNumber}/comments`, { body })
      }

      console.log('[DO] Comment posted successfully:', {
        responseKeys: Object.keys(response || {}),
        hasResponse: !!response
      })
    } catch (error) {
      console.log('[DO] ERROR posting comment:', error)
      throw error
    }
  }

  private async harvestSuggestionsFromPR(token: string, owner: string, repo: string, prNumber: number, headSha: string): Promise<Record<string, string>> {
    try {
      // Get all review comments for this PR
      const reviewComments = await ghREST(token, 'GET', `/repos/${owner}/${repo}/pulls/${prNumber}/comments`)
      
      // Also get general PR comments (issue comments on the PR)
      const issueComments = await ghREST(token, 'GET', `/repos/${owner}/${repo}/issues/${prNumber}/comments`)

      // Get the PR diff to look for code suggestions in the actual code changes
      const prDiff = await ghREST(token, 'GET', `/repos/${owner}/${repo}/pulls/${prNumber}`) as any
      const diffUrl = prDiff?.diff_url
      let diffContent = ''
      if (diffUrl) {
        try {
          const diffResponse = await fetch(diffUrl)
          diffContent = await diffResponse.text()
        } catch (error) {
          console.log('[DO] Could not fetch PR diff:', error)
        }
      }

      console.log(`[DO] Found ${Array.isArray(reviewComments) ? reviewComments.length : 0} review comments and ${Array.isArray(issueComments) ? issueComments.length : 0} issue comments`)
      console.log(`[DO] PR diff length: ${diffContent.length} characters`)

      if ((!Array.isArray(reviewComments) || reviewComments.length === 0) && 
          (!Array.isArray(issueComments) || issueComments.length === 0) &&
          diffContent.length === 0) {
        return {}
      }

      // Group suggestions by file path
      const suggestionsByFile: Record<string, Array<{suggestions: string[], diffHunk: string}>> = {}

      // Process PR diff content for code suggestions
      if (diffContent) {
        console.log('[DO] Processing PR diff for code suggestions')
        const diffSuggestions = this.extractSuggestions(diffContent)
        if (diffSuggestions.length > 0) {
          console.log(`[DO] Found ${diffSuggestions.length} suggestions in PR diff`)
          // Extract file path from diff (look for +++ b/path/to/file)
          const fileMatch = diffContent.match(/\+\+\+ b\/(.+)/)
          const filePath = fileMatch ? fileMatch[1] : 'unknown'
          if (!suggestionsByFile[filePath]) {
            suggestionsByFile[filePath] = []
          }
          suggestionsByFile[filePath].push({
            suggestions: diffSuggestions,
            diffHunk: diffContent.substring(0, 500) // First 500 chars of diff
          })
        }
      }

      // Process review comments (line-specific comments)
      if (Array.isArray(reviewComments)) {
        for (const comment of reviewComments) {
          if (!comment.body || !comment.path) continue

          console.log(`[DO] Processing review comment ${comment.id}:`, {
            body: comment.body.substring(0, 200) + '...',
            path: comment.path,
            hasDiffHunk: !!comment.diff_hunk
          })

          // First, try to extract suggestions from the comment body
          let suggestions = this.extractSuggestions(comment.body)
          console.log(`[DO] Extracted ${suggestions.length} suggestions from comment body ${comment.id}`)
          
          // If no suggestions in body, but we have a diff_hunk, treat the diff_hunk as suggestions
          if (suggestions.length === 0 && comment.diff_hunk) {
            console.log(`[DO] No suggestions in body, treating diff_hunk as suggestions for comment ${comment.id}`)
            // Extract the added lines from the diff hunk as suggestions
            const addedLines = comment.diff_hunk
              .split('\n')
              .filter((line: string) => line.startsWith('+') && !line.startsWith('+++'))
              .map((line: string) => line.substring(1)) // Remove the + prefix
              .filter((line: string) => line.trim().length > 0)
            
            if (addedLines.length > 0) {
              suggestions = addedLines
              console.log(`[DO] Extracted ${suggestions.length} suggestions from diff_hunk for comment ${comment.id}`)
            }
          }

          if (suggestions.length === 0) continue

          console.log(`[DO] Found ${suggestions.length} suggestions in review comment on ${comment.path}`)

          if (!suggestionsByFile[comment.path]) {
            suggestionsByFile[comment.path] = []
          }

          suggestionsByFile[comment.path].push({
            suggestions,
            diffHunk: comment.diff_hunk || comment.body.substring(0, 500)
          })
        }
      }

      // Process issue comments (general PR comments) - these might contain suggestions without specific file paths
      if (Array.isArray(issueComments)) {
        for (const comment of issueComments) {
          if (!comment.body) continue

          const suggestions = this.extractSuggestions(comment.body)
          if (suggestions.length === 0) continue

          console.log(`[DO] Found ${suggestions.length} suggestions in issue comment`)

          // For issue comments, we need to try to determine the file path from the comment content
          // Look for file references in the comment
          const filePathMatch = comment.body.match(/(?:file|path):\s*([^\s\n]+)/i) || 
                               comment.body.match(/`([^`]+\.(?:ts|js|tsx|jsx|py|java|cpp|c|go|rust|php|rb|swift|kt|scala|r|sql|html|css|json|yaml|xml|md|sh|ps1|dockerfile|toml|ini|conf))`/i)
          
          const filePath = filePathMatch ? filePathMatch[1] : 'general'
          
          if (!suggestionsByFile[filePath]) {
            suggestionsByFile[filePath] = []
          }

          suggestionsByFile[filePath].push({
            suggestions,
            diffHunk: '' // No diff hunk for general comments
          })
        }
      }

      // Apply suggestions for each file
      const allFilesMap: Record<string, string> = {}

      for (const [filePath, commentGroups] of Object.entries(suggestionsByFile)) {
        for (const group of commentGroups) {
          const fileMap = await buildFileChangesFromSuggestions({
            token,
            owner,
            repo,
            headSha,
            filePath,
            diffHunk: group.diffHunk,
            suggestions: group.suggestions
          })

          // Merge file changes (later changes override earlier ones for same file)
          Object.assign(allFilesMap, fileMap)
        }
      }

      return allFilesMap
    } catch (err) {
      // console.error is not available in Workers, use console.log for basic logging
      console.log('Failed to harvest suggestions from PR:', err)
      return {}
    }
  }

  private extractSuggestions(text: string): string[] {
    const out: string[] = []
    
    console.log(`[DO] Extracting suggestions from text: ${text.substring(0, 200)}...`)
    
    // Pattern 1: Standard ```suggestion blocks
    const suggestionRe = /```suggestion\s*\n([\s\S]*?)```/g
    let m: RegExpExecArray | null
    while ((m = suggestionRe.exec(text)) !== null) {
      out.push(m[1])
    }
    
    // Pattern 2: Gemini CLI format - ```typescript or ```javascript blocks with suggestions
    const codeBlockRe = /```(?:typescript|javascript|ts|js|python|py|java|cpp|c|go|rust|php|ruby|swift|kotlin|scala|r|sql|html|css|json|yaml|xml|markdown|md|bash|sh|powershell|ps1|dockerfile|docker|yaml|yml|toml|ini|conf|config|txt|text|plain|diff|patch)\s*\n([\s\S]*?)```/g
    while ((m = codeBlockRe.exec(text)) !== null) {
      const code = m[1].trim()
      // Only include if it looks like a suggestion (not just a code example)
      if (code.length > 10 && !code.includes('// Example') && !code.includes('// Sample')) {
        out.push(code)
      }
    }
    
    // Pattern 3: Lines starting with + (diff-style suggestions)
    const diffRe = /^\+.*$/gm
    const diffMatches = text.match(diffRe)
    if (diffMatches && diffMatches.length > 0) {
      const diffSuggestion = diffMatches.map(line => line.substring(1)).join('\n')
      if (diffSuggestion.trim().length > 0) {
        out.push(diffSuggestion.trim())
      }
    }
    
    // Pattern 4: AI Code Assist suggestions (specific format from Gemini/Codex)
    // Look for code blocks that are clearly suggestions, not just examples
    const aiSuggestionRe = /```(?:typescript|javascript|ts|js|python|py|java|cpp|c|go|rust|php|ruby|swift|kotlin|scala|r|sql|html|css|json|yaml|xml|markdown|md|bash|sh|powershell|ps1|dockerfile|docker|yaml|yml|toml|ini|conf|config|txt|text|plain|diff|patch)\s*\n([\s\S]*?)```/g
    let aiMatch: RegExpExecArray | null
    while ((aiMatch = aiSuggestionRe.exec(text)) !== null) {
      const code = aiMatch[1].trim()
      // More aggressive detection for AI suggestions
      if (code.length > 5 && 
          (code.includes('function') || code.includes('const') || code.includes('let') || code.includes('var') || 
           code.includes('class') || code.includes('interface') || code.includes('type') || 
           code.includes('import') || code.includes('export') || code.includes('return') ||
           code.includes('if') || code.includes('for') || code.includes('while') ||
           code.includes('{') || code.includes('}') || code.includes('(') || code.includes(')') ||
           code.includes('=') || code.includes('=>') || code.includes(';'))) {
        out.push(code)
      }
    }
    
    // Pattern 5: Gemini Code Assist specific patterns
    // Look for code blocks that might be suggestions from Gemini Code Assist
    const geminiPatterns = [
      // Code blocks with specific language tags
      /```(?:typescript|javascript|ts|js|python|py|java|cpp|c|go|rust|php|ruby|swift|kotlin|scala|r|sql|html|css|json|yaml|xml|markdown|md|bash|sh|powershell|ps1|dockerfile|docker|yaml|yml|toml|ini|conf|config|txt|text|plain|diff|patch)\s*\n([\s\S]*?)```/g,
      // Code blocks without language tags but with code content
      /```\s*\n([\s\S]*?)```/g
    ]
    
    for (const pattern of geminiPatterns) {
      let match: RegExpExecArray | null
      while ((match = pattern.exec(text)) !== null) {
        const code = match[1].trim()
        // Check if it looks like actual code (not just text)
        if (code.length > 10 && 
            (code.includes('function') || code.includes('const') || code.includes('let') || code.includes('var') || 
             code.includes('class') || code.includes('interface') || code.includes('type') || 
             code.includes('import') || code.includes('export') || code.includes('return') ||
             code.includes('if') || code.includes('for') || code.includes('while') ||
             code.includes('{') || code.includes('}') || code.includes('(') || code.includes(')') ||
             code.includes('=') || code.includes('=>') || code.includes(';') ||
             code.includes('def ') || code.includes('class ') || code.includes('import ') ||
             code.includes('public ') || code.includes('private ') || code.includes('protected '))) {
          out.push(code)
        }
      }
    }
    
    // Pattern 6: Inline code suggestions (backticks with code)
    const inlineCodeRe = /`([^`\n]{10,})`/g
    while ((m = inlineCodeRe.exec(text)) !== null) {
      const code = m[1].trim()
      if (code.length > 10 && 
          (code.includes('function') || code.includes('const') || code.includes('let') || code.includes('var') || 
           code.includes('class') || code.includes('interface') || code.includes('type') || 
           code.includes('import') || code.includes('export') || code.includes('return') ||
           code.includes('if') || code.includes('for') || code.includes('while') ||
           code.includes('{') || code.includes('}') || code.includes('(') || code.includes(')') ||
           code.includes('=') || code.includes('=>') || code.includes(';'))) {
        out.push(code)
      }
    }
    
    // Pattern 7: Lines that look like code suggestions (indented or with specific keywords)
    const suggestionKeywords = ['suggest', 'recommend', 'propose', 'improve', 'fix', 'update', 'change', 'modify', 'should', 'could', 'would']
    const lines = text.split('\n')
    let currentSuggestion = ''
    let inSuggestion = false
    
    for (const line of lines) {
      const lowerLine = line.toLowerCase()
      if (suggestionKeywords.some(keyword => lowerLine.includes(keyword)) && 
          (line.includes('```') || line.trim().startsWith('function') || line.trim().startsWith('const') || line.trim().startsWith('let') || line.trim().startsWith('var'))) {
        inSuggestion = true
        currentSuggestion = line
      } else if (inSuggestion && (line.trim() === '' || line.startsWith(' ') || line.startsWith('\t') || line.includes('```'))) {
        if (line.includes('```')) {
          inSuggestion = false
          if (currentSuggestion.trim().length > 0) {
            out.push(currentSuggestion.trim())
            currentSuggestion = ''
          }
        } else {
          currentSuggestion += '\n' + line
        }
      } else if (inSuggestion && line.trim() !== '') {
        currentSuggestion += '\n' + line
      }
    }
    
    // Add any remaining suggestion
    if (currentSuggestion.trim().length > 0) {
      out.push(currentSuggestion.trim())
    }
    
    console.log(`[DO] Extracted ${out.length} suggestions:`, out.map(s => s.substring(0, 50) + '...'))
    
    return out
  }

  private async handleColbyCommands(evt: PREvent, colbyTriggers: string[]) {
    // Heart reaction was already added in sendImmediateFeedback, process commands
    for (const trigger of colbyTriggers) {
      const { command, args } = parseColbyCommand(trigger)
      const operationId = generateOperationId()

      // Create command record
      const commandId = await createColbyCommand(this.env, {
        deliveryId: evt.delivery || 'unknown',
        repo: evt.repo,
        prNumber: evt.prNumber,
        author: evt.author,
        command,
        commandArgs: args,
        status: 'working'
      })

      // Create progress tracking
      await createOperationProgress(this.env, operationId, command, evt.repo, evt.prNumber)

      try {
        switch (command) {
          case 'implement':
            await this.handleImplementCommand(evt, commandId, operationId, args)
            break
          case 'create_issue':
            await this.handleCreateIssueCommand(evt, commandId, operationId, args)
            break
          case 'bookmark_suggestion':
            await this.handleBookmarkSuggestionCommand(evt, commandId, operationId, args)
            break
          case 'extract_suggestions':
            await this.handleExtractSuggestionsCommand(evt, commandId, operationId, args)
            break
          case 'extract_suggestions_to_issues':
            await this.handleExtractSuggestionsToIssuesCommand(evt, commandId, operationId, args)
            break
          case 'group_comments_by_file':
            await this.handleGroupCommentsByFileCommand(evt, commandId, operationId, args)
            break
          case 'create_llms_docs':
            await this.handleCreateLlmDocsCommand(evt, commandId, operationId, args)
            break
          case 'optimize_worker':
            await this.handleOptimizeWorkerCommand(evt, commandId, operationId, args)
            break
          case 'help':
            await this.handleHelpCommand(evt, commandId, operationId, args)
            break
          case 'resolve_conflicts':
          case 'clear_conflicts':
            await this.handleResolveConflictsCommand(evt, commandId, operationId, args)
            break
          default:
            await this.commentOnPR(evt, `❌ Unknown colby command: ${command}`)
            await updateColbyCommand(this.env, commandId, {
              status: 'failed',
              errorMessage: `Unknown command: ${command}`
            })
        }
      } catch (error: any) {
        await this.commentOnPR(evt, `❌ Error executing ${command}: ${error.message}`)
        await updateColbyCommand(this.env, commandId, {
          status: 'failed',
          errorMessage: error.message
        })
        await updateOperationProgress(this.env, operationId, {
          status: 'failed',
          errorMessage: error.message
        })
      }
    }

    return new Response('colby-commands-processed', { status: 200 })
  }

  private async handleImplementCommand(evt: PREvent, commandId: number, operationId: string, args: ColbyCommandArgs) {
    const [owner, repo] = evt.repo.split('/')
    if (!evt.installationId) {
      throw new Error('Missing installationId for implement command')
    }
    const token = await getInstallationToken(this.env, evt.installationId)

    console.log('[DO] handleImplementCommand called with:', {
      kind: evt.kind,
      commentId: evt.commentId,
      hasSuggestions: !!evt.suggestions?.length,
      suggestions: evt.suggestions,
      filePath: evt.filePath,
      line: evt.line
    })

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Analyzing suggestions...',
      progressPercent: 25
    })

    // For implement command, we apply suggestions similar to /apply but with enhanced feedback
    let hasSuggestions = Array.isArray(evt.suggestions) && evt.suggestions.length > 0
    let suggestionsToApply: string[] = evt.suggestions || []

    // If no suggestions in current comment and this is a PR comment, try to harvest from review comments
    if (!hasSuggestions && evt.kind === 'issue_comment' && evt.prNumber) {
      await updateOperationProgress(this.env, operationId, {
        currentStep: 'Searching for suggestions in review comments...',
        progressPercent: 30
      })

      try {
        const harvestedSuggestions = await this.harvestSuggestionsFromPR(token, owner, repo, evt.prNumber, evt.headSha!)
        if (harvestedSuggestions && Object.keys(harvestedSuggestions).length > 0) {
          // Convert harvested suggestions to the format expected by applySuggestionsCommit
          suggestionsToApply = Object.values(harvestedSuggestions)
          hasSuggestions = true
          
          await updateOperationProgress(this.env, operationId, {
            currentStep: `Found ${suggestionsToApply.length} suggestion(s) from review comments`,
            progressPercent: 50
          })
        }
      } catch (error) {
        console.log('[DO] Failed to harvest suggestions from review comments:', error)
      }
    }

    if (!hasSuggestions) {
      let helpMessage = ''

      if (evt.kind === 'review_comment') {
        helpMessage = `ℹ️ No code suggestions found in this review comment. To use \`/colby implement\`:

1. **Add suggestions in your comment** using \`\`\`suggestion\` blocks:
   \`\`\`suggestion
   // Your improved code here
   \`\`\`

2. **Or try other commands**:
   - \`/colby help\` - See all available commands
   - \`/colby create issue\` - Create an issue from this comment`
      } else {
        helpMessage = `ℹ️ No code suggestions found. To use \`/colby implement\`:

1. **Comment on a specific line** with \`\`\`suggestion\` blocks
2. **Use \`/colby help\`** to see all available commands
3. **Try \`/colby extract suggestions\`** to find suggestions from AI reviewers`
      }

      await this.commentOnPR(evt, helpMessage)
      await updateColbyCommand(this.env, commandId, {
        status: 'completed',
        resultData: { message: 'No suggestions to implement' }
      })
      await updateOperationProgress(this.env, operationId, {
        status: 'completed',
        progressPercent: 100,
        currentStep: 'No suggestions found'
      })
      return
    }

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Applying suggestions...',
      progressPercent: 50
    })

    // Create a modified event object with the suggestions to apply
    const modifiedEvt = {
      ...evt,
      suggestions: suggestionsToApply
    }

    const result = await this.applySuggestionsCommit(modifiedEvt)

    const suggestionsCount = suggestionsToApply.length
    await updateColbyCommand(this.env, commandId, {
      status: 'completed',
      resultData: { implementResult: result, suggestionsCount }
    })

    await updateOperationProgress(this.env, operationId, {
      status: 'completed',
      progressPercent: 100,
      currentStep: `Applied ${suggestionsCount} suggestion(s)`,
      resultData: { result }
    })
  }

  private async handleCreateIssueCommand(evt: PREvent, commandId: number, operationId: string, args: ColbyCommandArgs) {
    const [owner, repo] = evt.repo.split('/')
    if (!evt.installationId) {
      throw new Error('Missing installationId for create issue command')
    }
    if (!evt.prNumber) {
      throw new Error('Missing prNumber for create issue command')
    }
    const token = await getInstallationToken(this.env, evt.installationId)

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Gathering conversation context...',
      progressPercent: 15
    })

    // Gather rich conversation context
    let conversationContext = ''
    if (evt.commentId) {
      conversationContext = await gatherConversationContext(
        this.env,
        token,
        evt.repo,
        evt.commentId,
        evt.kind
      )
    }

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Analyzing content and generating title...',
      progressPercent: 35
    })

    // Get PR details for context
    const pr = await ghREST(token, 'GET', `/repos/${owner}/${repo}/pulls/${evt.prNumber}`)

    // Get the original comment body for better context
    let originalComment = ''
    if (evt.kind === 'issue_comment' || evt.kind === 'review_comment') {
      // Try to get the actual comment content from the webhook event
      if (evt.commentBody) {
        originalComment = evt.commentBody
      } else if (Array.isArray(evt.suggestions) && evt.suggestions.length > 0) {
        originalComment = evt.suggestions.join('\n\n')
      } else {
        originalComment = 'From code review comment'
      }
    } else {
      originalComment = 'From PR review'
    }

    // Enhanced comment body that includes both original comment and suggestions
    const commentBody = originalComment

    // Enhanced title generation with rich context
    const title = await generateIssueTitle(this.env, {
      repo: evt.repo,
      prTitle: (pr as any)?.title,
      prBody: (pr as any)?.body,
      commentBody,
      filePath: evt.filePath,
      line: evt.line,
      suggestions: evt.suggestions,
      conversationContext
    })

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Creating comprehensive issue description...',
      progressPercent: 60
    })

    // Generate rich issue body with AI
    const issueBody = await generateIssueBody(this.env, {
      repo: evt.repo,
      prNumber: evt.prNumber,
      prTitle: (pr as any)?.title,
      prBody: (pr as any)?.body,
      author: evt.author,
      commentBody,
      filePath: evt.filePath,
      line: evt.line,
      diffHunk: evt.diffHunk,
      suggestions: evt.suggestions,
      conversationContext
    })

    // Add footer with link back to original PR and comment
    const prUrl = `https://github.com/${evt.repo}/pull/${evt.prNumber}`
    const commentUrl = evt.commentId ? `${prUrl}#issuecomment-${evt.commentId}` : prUrl
    
    const enhancedIssueBody = `${issueBody}

---

**Created from**: [PR #${evt.prNumber}](${prUrl})${evt.commentId ? ` - [Comment #${evt.commentId}](${commentUrl})` : ''}
**Original Author**: @${evt.author}
**File**: ${evt.filePath ? `\`${evt.filePath}\`` : 'N/A'}${evt.line ? ` (line ${evt.line})` : ''}`

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Creating GitHub issue...',
      progressPercent: 80
    })

    const assignee = args.assignToCopilot ? 'copilot' : undefined
    const labels = ['enhancement', 'from-review']

    // Add smart labels based on context
    if (evt.filePath) {
      const fileExt = evt.filePath.split('.').pop()?.toLowerCase()
      if (fileExt === 'ts' || fileExt === 'js') labels.push('typescript', 'javascript')
      if (fileExt === 'py') labels.push('python')
      if (fileExt === 'md') labels.push('documentation')
      if (evt.filePath.includes('test')) labels.push('testing')
    }

    if (evt.suggestions && evt.suggestions.length > 0) {
      labels.push('code-suggestion')
    }

    const issue = await createGitHubIssue(
      this.env,
      token,
      evt.repo,
      title,
      enhancedIssueBody,
      assignee,
      labels
    )

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Saving issue record...',
      progressPercent: 90
    })

    // Save to colby_issues table
    try {
      await this.env.DB.prepare(`
        INSERT INTO colby_issues (colby_command_id, repo, issue_number, github_issue_id, title, body, assignee, labels)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        commandId,
        evt.repo,
        issue.issueNumber,
        issue.issueId,
        title,
        issueBody,
        assignee || null,
        JSON.stringify(labels)
      ).run()
    } catch (error) {
      console.log('Failed to save issue to database (table may not exist):', error)
    }

    await updateColbyCommand(this.env, commandId, {
      status: 'completed',
      resultData: {
        issueNumber: issue.issueNumber,
        issueUrl: issue.url,
        title,
        contextGathered: !!conversationContext,
        labelsApplied: labels
      }
    })

    await updateOperationProgress(this.env, operationId, {
      status: 'completed',
      progressPercent: 100,
      currentStep: 'Issue created successfully',
      resultData: {
        issueNumber: issue.issueNumber,
        issueUrl: issue.url,
        title: title,
        hasContext: !!conversationContext
      }
    })

    const assigneeText = args.assignToCopilot ? ' and assigned to @copilot' : ''
    const contextText = conversationContext ? ' with conversation context' : ''
    await this.commentOnPR(evt, `✅ Created issue [#${issue.issueNumber}](${issue.url})${assigneeText}${contextText}

**Title:** ${title}`)
  }

  private async handleBookmarkSuggestionCommand(evt: PREvent, commandId: number, operationId: string, args: ColbyCommandArgs) {
    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Extracting suggestions...',
      progressPercent: 25
    })

    const hasSuggestions = Array.isArray(evt.suggestions) && evt.suggestions.length > 0

    if (!hasSuggestions) {
      await this.commentOnPR(evt, `ℹ️ No code suggestions found to bookmark. Please add \`\`\`suggestion\`\`\` blocks with the practices you'd like to save.`)
      await updateColbyCommand(this.env, commandId, {
        status: 'completed',
        resultData: { message: 'No suggestions to bookmark' }
      })
      await updateOperationProgress(this.env, operationId, {
        status: 'completed',
        progressPercent: 100,
        currentStep: 'No suggestions found'
      })
      return
    }

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Analyzing and categorizing suggestions...',
      progressPercent: 50
    })

    const bookmarkIds: number[] = []
    const suggestions = evt.suggestions || []

    for (const suggestion of suggestions) {
      const bookmarkId = await bookmarkSuggestion(this.env, {
        text: suggestion,
        contextRepo: evt.repo,
        contextPr: evt.prNumber,
        contextFile: evt.filePath,
        bookmarkedBy: evt.author
      })
      bookmarkIds.push(bookmarkId)
    }

    await updateColbyCommand(this.env, commandId, {
      status: 'completed',
      resultData: {
        bookmarkIds,
        suggestionsCount: suggestions.length
      }
    })

    await updateOperationProgress(this.env, operationId, {
      status: 'completed',
      progressPercent: 100,
      currentStep: `Bookmarked ${suggestions.length} suggestion(s)`,
      resultData: { bookmarkIds, count: suggestions.length }
    })

    await this.commentOnPR(evt, `✅ Bookmarked ${suggestions.length} suggestion(s) as best practice(s). They've been categorized and added to the knowledge base.`)
  }

  private async handleExtractSuggestionsCommand(evt: PREvent, commandId: number, operationId: string, args: ColbyCommandArgs) {
    const [owner, repo] = evt.repo.split('/')
    if (!evt.installationId) {
      throw new Error('Missing installationId for extract suggestions command')
    }
    const token = await getInstallationToken(this.env, evt.installationId)

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Fetching PR review comments...',
      progressPercent: 20
    })

    // Get all review comments for this PR
    const reviewComments = await ghREST(token, 'GET', `/repos/${owner}/${repo}/pulls/${evt.prNumber}/comments`)

    if (!Array.isArray(reviewComments)) {
      throw new Error('Failed to fetch review comments')
    }

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Analyzing comments for suggestions...',
      progressPercent: 40
    })

    const extractedSuggestions: any[] = []

    // Look for Gemini/AI-generated comments (typically have specific patterns)
    for (const comment of reviewComments) {
      if (!comment.body || comment.user?.type !== 'Bot') continue

      // Extract suggestion blocks or actionable feedback
      const suggestions = this.extractSuggestions(comment.body)

      if (suggestions.length > 0) {
        for (const suggestion of suggestions) {
          // Generate codex prompt for this suggestion
          const codexPrompt = await this.generateCodexPrompt(evt.repo, comment, suggestion)

          try {
            const result = await this.env.DB.prepare(`
              INSERT INTO extracted_suggestions
              (repo, pr_number, extraction_command_id, gemini_comment_id, suggestion_text, target_file, codex_prompt)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).bind(
              evt.repo,
              evt.prNumber,
              commandId,
              comment.id?.toString() || null,
              suggestion,
              comment.path || null,
              codexPrompt
            ).run()

            extractedSuggestions.push({
              id: result.meta?.last_row_id,
              suggestion,
              file: comment.path,
              codexPrompt
            })
          } catch (error) {
            console.log('Failed to save extracted suggestion (table may not exist):', error)
            // Still add to extractedSuggestions with dummy ID for processing
            extractedSuggestions.push({
              id: Date.now(),
              suggestion,
              file: comment.path,
              codexPrompt
            })
          }
        }
      }
    }

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Generating codex prompts...',
      progressPercent: 80
    })

    // TODO: Submit to codex if available
    // For now, we just save the prompts for manual review

    await updateColbyCommand(this.env, commandId, {
      status: 'completed',
      resultData: {
        extractedCount: extractedSuggestions.length,
        suggestions: extractedSuggestions
      }
    })

    await updateOperationProgress(this.env, operationId, {
      status: 'completed',
      progressPercent: 100,
      currentStep: `Extracted ${extractedSuggestions.length} suggestion(s)`,
      resultData: { count: extractedSuggestions.length }
    })

    await this.commentOnPR(evt, `✅ Extracted ${extractedSuggestions.length} suggestion(s) from review comments. Codex prompts have been generated and saved for processing.`)
  }

  private async handleExtractSuggestionsToIssuesCommand(evt: PREvent, commandId: number, operationId: string, args: ColbyCommandArgs) {
    const [owner, repo] = evt.repo.split('/')
    if (!evt.installationId) {
      throw new Error('Missing installationId for extract suggestions to issues command')
    }
    if (!evt.prNumber) {
      throw new Error('Missing prNumber for extract suggestions to issues command')
    }
    const token = await getInstallationToken(this.env, evt.installationId)

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Fetching PR details...',
      progressPercent: 10
    })

    // Get PR details for context
    const pr = await ghREST(token, 'GET', `/repos/${owner}/${repo}/pulls/${evt.prNumber}`)

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Scanning all review comments for suggestions...',
      progressPercent: 25
    })

    // Get all review comments for this PR
    const reviewComments = await ghREST(token, 'GET', `/repos/${owner}/${repo}/pulls/${evt.prNumber}/comments`)

    if (!Array.isArray(reviewComments)) {
      throw new Error('Failed to fetch review comments')
    }

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Analyzing comments and extracting suggestions...',
      progressPercent: 40
    })

    // Group suggestions by filename
    const suggestionsByFile: Record<string, Array<{
      suggestion: string
      commentId: number
      line?: number
      path?: string
      user: string
      commentBody: string
    }>> = {}

    // Look for Gemini/AI-generated comments (typically have specific patterns)
    for (const comment of reviewComments) {
      if (!comment.body || comment.user?.type !== 'Bot') continue

      // Extract suggestion blocks
      const suggestions = this.extractSuggestions(comment.body)

      if (suggestions.length > 0) {
        for (const suggestion of suggestions) {
          const filePath = comment.path || 'general'

          if (!suggestionsByFile[filePath]) {
            suggestionsByFile[filePath] = []
          }

          suggestionsByFile[filePath].push({
            suggestion,
            commentId: comment.id,
            line: comment.line,
            path: comment.path,
            user: comment.user.login,
            commentBody: comment.body
          })
        }
      }
    }

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Grouping suggestions by filename...',
      progressPercent: 60
    })

    // Check if we found any suggestions
    const totalFiles = Object.keys(suggestionsByFile).length
    const totalSuggestions = Object.values(suggestionsByFile).reduce((sum, suggestions) => sum + suggestions.length, 0)

    if (totalSuggestions === 0) {
      await updateOperationProgress(this.env, operationId, {
        currentStep: 'No suggestions found',
        progressPercent: 100
      })

      await updateColbyCommand(this.env, commandId, {
        status: 'completed',
        resultData: { message: 'No suggestions found to extract' }
      })

      await this.commentOnPR(evt, `ℹ️ **No code suggestions found**\n\nI couldn't find any code suggestions in the review comments. Make sure the suggestions are in properly formatted \`\`\`suggestion\` blocks within review comments.`)
      return
    }

    await updateOperationProgress(this.env, operationId, {
      currentStep: `Creating ${totalFiles} issue(s) for ${totalSuggestions} suggestion(s)...`,
      progressPercent: 75
    })

    // Create issues for each file
    const createdIssues: Array<{
      filePath: string
      issueNumber: number
      issueUrl: string
      suggestionsCount: number
    }> = []

    for (const [filePath, suggestions] of Object.entries(suggestionsByFile)) {
      try {
        const issue = await this.createIssueForFileSuggestions(
          token,
          owner,
          repo,
          evt.prNumber,
          filePath,
          suggestions,
          pr
        )

        createdIssues.push({
          filePath,
          issueNumber: issue.issueNumber,
          issueUrl: issue.url,
          suggestionsCount: suggestions.length
        })
      } catch (error: any) {
        console.log(`Failed to create issue for ${filePath}:`, error)
        // Continue with other files
      }
    }

    await updateOperationProgress(this.env, operationId, {
      status: 'completed',
      progressPercent: 100,
      currentStep: `Created ${createdIssues.length} issue(s)`,
      resultData: {
        totalSuggestions,
        totalFiles,
        createdIssuesCount: createdIssues.length,
        createdIssues
      }
    })

    await updateColbyCommand(this.env, commandId, {
      status: 'completed',
      resultData: {
        totalSuggestions,
        totalFiles,
        createdIssuesCount: createdIssues.length,
        createdIssues
      }
    })

    // Format the response
    let response = `✅ **Created ${createdIssues.length} issue(s) from ${totalSuggestions} suggestion(s)**\n\n`

    if (createdIssues.length > 0) {
      response += '**Issues Created:**\n'
      for (const issue of createdIssues) {
        response += `• **${issue.filePath}**: [#${issue.issueNumber}](${issue.issueUrl}) (${issue.suggestionsCount} suggestion(s))\n`
      }
      response += '\n'
    }

    response += `**Summary:** Found suggestions in ${totalFiles} file(s) across ${totalSuggestions} review comments.`

    await this.commentOnPR(evt, response)
  }

  private async handleGroupCommentsByFileCommand(evt: PREvent, commandId: number, operationId: string, args: ColbyCommandArgs) {
    const [owner, repo] = evt.repo.split('/')
    if (!evt.installationId) {
      throw new Error('Missing installationId for group comments by file command')
    }
    if (!evt.prNumber) {
      throw new Error('Missing prNumber for group comments by file command')
    }
    const token = await getInstallationToken(this.env, evt.installationId)

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Fetching PR details...',
      progressPercent: 10
    })

    // Get PR details for context
    const pr = await ghREST(token, 'GET', `/repos/${owner}/${repo}/pulls/${evt.prNumber}`)

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Scanning all review comments...',
      progressPercent: 25
    })

    // Get all review comments for this PR
    const reviewComments = await ghREST(token, 'GET', `/repos/${owner}/${repo}/pulls/${evt.prNumber}/comments`)

    if (!Array.isArray(reviewComments)) {
      throw new Error('Failed to fetch review comments')
    }

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Grouping comments by file path...',
      progressPercent: 40
    })

    // Group comments by file path
    const commentsByFile: Record<string, Array<{
      id: number
      body: string
      user: { login: string }
      created_at: string
      path: string
      line?: number
      side?: string
      diff_hunk?: string
    }>> = {}

    for (const comment of reviewComments) {
      if (comment.path && comment.body && comment.user) {
        const filePath = comment.path
        if (!commentsByFile[filePath]) {
          commentsByFile[filePath] = []
        }
        commentsByFile[filePath].push({
          id: comment.id,
          body: comment.body,
          user: comment.user,
          created_at: comment.created_at,
          path: comment.path,
          line: comment.line,
          side: comment.side,
          diff_hunk: comment.diff_hunk
        })
      }
    }

    // Filter out files with no comments
    const filesWithComments = Object.entries(commentsByFile).filter(([_, comments]) => comments.length > 0)

    if (filesWithComments.length === 0) {
      await updateOperationProgress(this.env, operationId, {
        status: 'completed',
        progressPercent: 100,
        currentStep: 'No comments found to group'
      })

      await this.commentOnPR(evt, 'ℹ️ No review comments found to group by file.')
      return
    }

    await updateOperationProgress(this.env, operationId, {
      currentStep: `Creating issues for ${filesWithComments.length} file(s)...`,
      progressPercent: 60
    })

    const createdIssues: Array<{
      filePath: string
      issueNumber: number
      issueUrl: string
      commentsCount: number
    }> = []

    // Create one issue per file
    for (const [filePath, comments] of filesWithComments) {
      try {
        const issue = await this.createGroupedIssueForFile(
          token,
          owner,
          repo,
          evt.prNumber,
          filePath,
          comments,
          pr,
          evt.author
        )

        createdIssues.push({
          filePath,
          issueNumber: issue.issueNumber,
          issueUrl: issue.url,
          commentsCount: comments.length
        })
      } catch (error: any) {
        console.log(`Failed to create grouped issue for ${filePath}:`, error)
        // Continue with other files
      }
    }

    await updateOperationProgress(this.env, operationId, {
      status: 'completed',
      progressPercent: 100,
      currentStep: `Created ${createdIssues.length} grouped issue(s)`,
      resultData: {
        totalComments: Object.values(commentsByFile).reduce((sum, comments) => sum + comments.length, 0),
        totalFiles: filesWithComments.length,
        createdIssuesCount: createdIssues.length,
        createdIssues
      }
    })

    await updateColbyCommand(this.env, commandId, {
      status: 'completed',
      resultData: {
        totalComments: Object.values(commentsByFile).reduce((sum, comments) => sum + comments.length, 0),
        totalFiles: filesWithComments.length,
        createdIssuesCount: createdIssues.length,
        createdIssues
      }
    })

    // Format the response
    let response = `✅ **Created ${createdIssues.length} grouped issue(s) from ${Object.values(commentsByFile).reduce((sum, comments) => sum + comments.length, 0)} comment(s)**\n\n`

    if (createdIssues.length > 0) {
      response += '**Issues Created:**\n'
      for (const issue of createdIssues) {
        response += `• **${issue.filePath}**: [#${issue.issueNumber}](${issue.issueUrl}) (${issue.commentsCount} comment(s))\n`
      }
      response += '\n'
    }

    response += `**Summary:** Grouped comments from ${filesWithComments.length} file(s) into consolidated issues for easier assignment.`

    await this.commentOnPR(evt, response)
  }

  private async createIssueForFileSuggestions(
    token: string,
    owner: string,
    repo: string,
    prNumber: number,
    filePath: string,
    suggestions: Array<{
      suggestion: string
      commentId: number
      line?: number
      path?: string
      user: string
      commentBody: string
    }>,
    pr: any
  ) {
    const title = `Implement suggestions for ${filePath}`

    // Build comprehensive issue body
    let body = `## 📋 Code Suggestions for \`${filePath}\`\n\n`
    body += `**Pull Request:** [#${prNumber}](${pr.html_url})\n`
    body += `**PR Title:** ${pr.title}\n`
    body += `**Branch:** ${pr.head?.ref} → ${pr.base?.ref}\n\n`

    body += `### 📝 Suggestions to Implement (${suggestions.length})\n\n`

    for (let i = 0; i < suggestions.length; i++) {
      const suggestion = suggestions[i]
      body += `#### ${i + 1}. Suggestion ${suggestion.line ? `(Line ${suggestion.line})` : ''}\n\n`
      body += `**From:** ${suggestion.user} in [comment](https://github.com/${owner}/${repo}/pull/${prNumber}#discussion_r${suggestion.commentId})\n\n`
      body += '```suggestion\n'
      body += suggestion.suggestion
      body += '\n```\n\n'

      // Add some context from the original comment
      const contextPreview = suggestion.commentBody.replace(/```suggestion[\s\S]*?```/g, '').trim()
      if (contextPreview.length > 0) {
        body += `**Context:** ${contextPreview.substring(0, 200)}${contextPreview.length > 200 ? '...' : ''}\n\n`
      }

      body += '---\n\n'
    }

    body += `### ✅ Implementation Checklist\n\n`
    body += `- [ ] Review all suggestions above\n`
    body += `- [ ] Test changes locally\n`
    body += `- [ ] Ensure code follows project conventions\n`
    body += `- [ ] Update tests if necessary\n`
    body += `- [ ] Verify functionality works as expected\n\n`

    body += `### 🔗 Related\n\n`
    body += `- **PR:** [#${prNumber}](${pr.html_url})\n`
    body += `- **File:** \`${filePath}\`\n\n`

    body += `*This issue was automatically created by Colby bot from code review suggestions.*`

    const labels = ['enhancement', 'code-suggestion', 'auto-generated']
    if (filePath.includes('test')) labels.push('testing')
    if (filePath.endsWith('.ts') || filePath.endsWith('.js')) labels.push('javascript', 'typescript')
    if (filePath.endsWith('.py')) labels.push('python')

    // Use the existing createGitHubIssue function
    return await createGitHubIssue(
      this.env,
      token,
      `${owner}/${repo}`,
      title,
      body,
      undefined, // No assignee for now
      labels
    )
  }

  private async createGroupedIssueForFile(
    token: string,
    owner: string,
    repo: string,
    prNumber: number,
    filePath: string,
    comments: Array<{
      id: number
      body: string
      user: { login: string }
      created_at: string
      path: string
      line?: number
      side?: string
      diff_hunk?: string
    }>,
    pr: any,
    author: string
  ) {
    // Generate AI-powered title for the grouped comments
    const title = await generateIssueTitle(this.env, {
      repo: `${owner}/${repo}`,
      prTitle: pr?.title,
      prBody: pr?.body,
      commentBody: comments.map(c => c.body).join('\n\n---\n\n'),
      filePath,
      line: comments[0]?.line,
      suggestions: comments.map(c => c.body),
      conversationContext: `Multiple review comments on ${filePath}`
    })

    // Generate AI-optimized issue body with clear action items
    const optimizedIssueBody = await this.generateOptimizedGroupedIssueBody(
      filePath,
      comments,
      pr,
      author,
      `${owner}/${repo}`,
      prNumber
    )

    // Add footer with all comment details
    const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`
    
    const enhancedIssueBody = `${optimizedIssueBody}

---

## 📝 Original Comments on \`${filePath}\`

${comments.map((comment, index) => `### Comment ${index + 1} by @${comment.user.login}
> ${comment.body}

**Line**: ${comment.line ? `Line ${comment.line}` : 'General comment'}  
**Side**: ${comment.side || 'N/A'}  
**Date**: ${new Date(comment.created_at).toLocaleDateString()}  
**Link**: [Comment #${comment.id}](${prUrl}#issuecomment-${comment.id})

---`).join('\n\n')}

**Created from**: [PR #${prNumber}](${prUrl})  
**Original Author**: @${author}  
**File**: \`${filePath}\`  
**Total Comments**: ${comments.length}`

    // Smart labels based on file and content
    const labels = ['enhancement', 'code-review', 'grouped-comments', 'auto-generated']
    if (filePath.includes('test')) labels.push('testing')
    if (filePath.endsWith('.ts') || filePath.endsWith('.js')) labels.push('javascript', 'typescript')
    if (filePath.endsWith('.py')) labels.push('python')
    if (filePath.endsWith('.md')) labels.push('documentation')

    // Use the existing createGitHubIssue function
    return await createGitHubIssue(
      this.env,
      token,
      `${owner}/${repo}`,
      title,
      enhancedIssueBody,
      undefined, // No assignee for now
      labels
    )
  }

  private async generateOptimizedGroupedIssueBody(
    filePath: string,
    comments: Array<{
      id: number
      body: string
      user: { login: string }
      created_at: string
      path: string
      line?: number
      side?: string
      diff_hunk?: string
    }>,
    pr: any,
    author: string,
    repo: string,
    prNumber: number
  ): Promise<string> {
    // Prepare comment data for AI analysis
    const commentData = comments.map((comment, index) => ({
      index: index + 1,
      author: comment.user.login,
      body: comment.body,
      line: comment.line,
      side: comment.side,
      date: comment.created_at,
      diffHunk: comment.diff_hunk
    }))

    const prompt = `Analyze these ${comments.length} review comments on file \`${filePath}\` and create an optimized, actionable GitHub issue body.

**File**: ${filePath}
**PR**: #${prNumber} - ${pr?.title || 'Pull Request'}
**Repository**: ${repo}
**Total Comments**: ${comments.length}

**Comments to Analyze:**
${commentData.map(c => `
### Comment ${c.index} by @${c.author}
${c.line ? `**Line ${c.line}** (${c.side || 'N/A'}):` : '**General comment:**'}
${c.body}

${c.diffHunk ? `**Code Context:**\n\`\`\`diff\n${c.diffHunk}\n\`\`\`` : ''}
---`).join('\n')}

**Instructions:**
1. **Analyze all comments** to identify common themes, patterns, and priorities
2. **Group related feedback** into logical categories (e.g., "Performance Issues", "Code Quality", "Security Concerns")
3. **Extract specific action items** with clear, implementable tasks
4. **Prioritize issues** by severity/importance
5. **Create a clear implementation plan** with step-by-step instructions
6. **Identify dependencies** between different fixes
7. **Suggest testing approaches** for each fix

**Output Format:**
Create a comprehensive GitHub issue body with these sections:

## 🎯 **Summary**
Brief overview of what needs to be addressed in this file

## 🔍 **Analysis**
AI analysis of the feedback patterns and common themes

## 📋 **Action Items**
Prioritized list of specific tasks to implement

## 🚀 **Implementation Plan**
Step-by-step approach to address all issues

## ✅ **Acceptance Criteria**
Clear definition of what "done" looks like

## 🧪 **Testing Strategy**
How to verify each fix works correctly

## 📚 **Additional Context**
Any relevant background information or dependencies

Make the issue body clear, actionable, and easy for a developer (or AI assistant) to follow. Focus on specific, implementable tasks rather than vague suggestions.`

    try {
      const result = await (this.env.AI as any).run(this.env.SUMMARY_CF_MODEL, {
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 2000,
        temperature: 0.3
      }) as any

      return result?.response || result?.content || 'Failed to generate optimized issue body'
    } catch (error) {
      console.error('Error generating optimized issue body:', error)
      // Fallback to basic issue body if AI fails
      return await generateIssueBody(this.env, {
        repo,
        prNumber,
        prTitle: pr?.title,
        prBody: pr?.body,
        author,
        commentBody: comments.map(c => c.body).join('\n\n---\n\n'),
        filePath,
        line: comments[0]?.line,
        diffHunk: comments[0]?.diff_hunk,
        suggestions: comments.map(c => c.body),
        conversationContext: `Multiple review comments on ${filePath}`
      })
    }
  }

  private async handleCreateLlmDocsCommand(evt: PREvent, commandId: number, operationId: string, args: ColbyCommandArgs) {
    const [owner, repo] = evt.repo.split('/')
    if (!evt.installationId) {
      throw new Error('Missing installationId for create LLMs docs command')
    }
    const token = await getInstallationToken(this.env, evt.installationId)

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Initializing LLMs documentation creation...',
      progressPercent: 5
    })

    // Define the LLMs documentation structure
    const llmsDocumentationConfig = {
      "llms_txt_categorized": [
        {
          "category": "Application Hosting / Full Stack",
          "urls": [
            "https://developers.cloudflare.com/pages/llms-full.txt",
            "https://developers.cloudflare.com/containers/llms-full.txt",
            "https://developers.cloudflare.com/developer-platform/llms-full.txt"
          ]
        },
        {
          "category": "AI & Agents",
          "urls": [
            "https://developers.cloudflare.com/agents/llms-full.txt",
            "https://developers.cloudflare.com/ai-gateway/llms-full.txt",
            "https://developers.cloudflare.com/workers-ai/llms-full.txt",
            "https://developers.cloudflare.com/autorag/llms-full.txt"
          ]
        },
        {
          "category": "Edge Compute",
          "urls": [
            "https://developers.cloudflare.com/workers/llms-full.txt",
            "https://developers.cloudflare.com/workflows/llms-full.txt"
          ]
        },
        {
          "category": "Stateful Services (Databases, Storage, Messaging, Realtime)",
          "urls": [
            "https://developers.cloudflare.com/kv/llms-full.txt",
            "https://developers.cloudflare.com/durable-objects/llms-full.txt",
            "https://developers.cloudflare.com/d1/llms-full.txt",
            "https://developers.cloudflare.com/r2/llms-full.txt",
            "https://developers.cloudflare.com/queues/llms-full.txt",
            "https://developers.cloudflare.com/vectorize/llms-full.txt",
            "https://developers.cloudflare.com/pipelines/llms-full.txt",
            "https://developers.cloudflare.com/email-routing/llms-full.txt",
            "https://developers.cloudflare.com/pub-sub/llms-full.txt",
            "https://developers.cloudflare.com/hyperdrive/llms-full.txt",
            "https://developers.cloudflare.com/realtime/llms-full.txt"
          ]
        },
        {
          "category": "Developer Tools & Platform",
          "urls": [
            "https://developers.cloudflare.com/logs/llms-full.txt",
            "https://developers.cloudflare.com/developer-spotlight/llms-full.txt"
          ]
        },
        {
          "category": "Browser/Rendering/Images/Media",
          "urls": [
            "https://developers.cloudflare.com/browser-rendering/llms-full.txt",
            "https://developers.cloudflare.com/images/llms-full.txt",
            "https://developers.cloudflare.com/stream/llms-full.txt"
          ]
        },
        {
          "category": "Other/General",
          "urls": [
            "https://developers.cloudflare.com/llms.txt",
            "https://developers.cloudflare.com/workers/prompt.txt",
            "https://developers.cloudflare.com/zaraz/llms-full.txt"
          ]
        }
      ]
    }

    // Calculate total URLs to fetch
    const totalUrls = llmsDocumentationConfig.llms_txt_categorized.reduce(
      (sum, category) => sum + category.urls.length, 0
    )

    await updateOperationProgress(this.env, operationId, {
      currentStep: `Found ${llmsDocumentationConfig.llms_txt_categorized.length} categories with ${totalUrls} total URLs to fetch`,
      progressPercent: 10
    })

    const results: {
      category: string
      successCount: number
      failCount: number
      files: Array<{ url: string; filename: string; success: boolean; error?: string }>
    }[] = []

    let processedUrls = 0
    const baseProgress = 10
    const progressPerUrl = (90 - baseProgress) / totalUrls

    // Process each category
    for (const category of llmsDocumentationConfig.llms_txt_categorized) {
      const categoryResults = {
        category: category.category,
        successCount: 0,
        failCount: 0,
        files: [] as Array<{ url: string; filename: string; success: boolean; error?: string }>
      }

      await updateOperationProgress(this.env, operationId, {
        currentStep: `Processing category: ${category.category} (${category.urls.length} URLs)`,
        progressPercent: Math.round(baseProgress + (processedUrls * progressPerUrl))
      })

      // Process each URL in the category
      for (const url of category.urls) {
        try {
          const filename = this.extractFilenameFromUrl(url)
          const content = await this.fetchUrlContent(url)

          // Save to GitHub repository
          const filePath = `.agents/llms/${this.sanitizeCategoryName(category.category)}/${filename}`

          await this.createFileInRepo(token, owner, repo, filePath, content, `Add ${filename} documentation`)

          categoryResults.files.push({
            url,
            filename,
            success: true
          })
          categoryResults.successCount++

        } catch (error: any) {
          console.log(`Failed to fetch ${url}:`, error)
          categoryResults.files.push({
            url,
            filename: this.extractFilenameFromUrl(url),
            success: false,
            error: error.message
          })
          categoryResults.failCount++
        }

        processedUrls++
        await updateOperationProgress(this.env, operationId, {
          currentStep: `Fetched ${processedUrls}/${totalUrls} URLs`,
          progressPercent: Math.round(baseProgress + (processedUrls * progressPerUrl))
        })
      }

      results.push(categoryResults)
    }

    await updateOperationProgress(this.env, operationId, {
      status: 'completed',
      progressPercent: 100,
      currentStep: `Completed fetching ${totalUrls} documentation files`,
      resultData: { results, totalUrls }
    })

    await updateColbyCommand(this.env, commandId, {
      status: 'completed',
      resultData: { results, totalUrls }
    })

    // Format the response
    let response = `✅ **LLMs Documentation Created Successfully!**\n\n`

    const totalSuccess = results.reduce((sum, cat) => sum + cat.successCount, 0)
    const totalFail = results.reduce((sum, cat) => sum + cat.failCount, 0)

    response += `**Summary:** ${totalSuccess}/${totalUrls} files created successfully`

    if (totalFail > 0) {
      response += ` (${totalFail} failed)`
    }

    response += '\n\n'

    if (results.length > 0) {
      response += '**Categories Created:**\n'
      for (const result of results) {
        const status = result.failCount > 0
          ? `${result.successCount}/${result.successCount + result.failCount} ✅`
          : `${result.successCount} ✅`

        response += `• **${result.category}**: ${status}\n`
      }
      response += '\n'
    }

    response += '**File Structure:**\n'
    response += '```\n'
    response += '.agents/llms/\n'
    for (const result of results) {
      const categoryPath = this.sanitizeCategoryName(result.category)
      response += `├── ${categoryPath}/\n`
      for (const file of result.files.slice(0, 2)) { // Show first 2 files per category
        response += `│   └── ${file.filename}\n`
      }
      if (result.files.length > 2) {
        response += `│   └── ... (${result.files.length - 2} more files)\n`
      }
    }
    response += '```\n\n'

    response += '*All documentation files have been committed to your repository.*'

    await this.commentOnPR(evt, response)
  }

  private async handleOptimizeWorkerCommand(evt: PREvent, commandId: number, operationId: string, args: ColbyCommandArgs) {
    const [owner, repo] = evt.repo.split('/')
    if (!evt.installationId) {
      throw new Error('Missing installationId for optimize worker command')
    }
    const token = await getInstallationToken(this.env, evt.installationId)

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Starting worker optimization...',
      progressPercent: 10
    })

    let optimizationsApplied = 0
    const optimizationResults: string[] = []

    // 1. Check and update Wrangler version
    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Checking Wrangler version...',
      progressPercent: 20
    })

    try {
      const wranglerUpdate = await this.updateWranglerVersion(token, owner, repo)
      if (wranglerUpdate.updated) {
        optimizationsApplied++
        optimizationResults.push(`✅ Updated Wrangler from ${wranglerUpdate.oldVersion} to ${wranglerUpdate.newVersion}`)
      } else {
        optimizationResults.push(`✅ Wrangler is already up to date (${wranglerUpdate.currentVersion})`)
      }
    } catch (error: any) {
      optimizationResults.push(`❌ Failed to update Wrangler: ${error.message}`)
    }

    // 2. Ensure observability configuration
    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Ensuring observability configuration...',
      progressPercent: 40
    })

    try {
      const observabilityResult = await this.ensureObservabilityConfig(token, owner, repo)
      if (observabilityResult.added) {
        optimizationsApplied++
        optimizationResults.push(`✅ Added observability configuration`)
      } else {
        optimizationResults.push(`✅ Observability already configured`)
      }
    } catch (error: any) {
      optimizationResults.push(`❌ Failed to configure observability: ${error.message}`)
    }

    // 3. Ensure package.json scripts
    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Ensuring package.json scripts...',
      progressPercent: 60
    })

    try {
      const scriptsResult = await this.ensurePackageScripts(token, owner, repo)
      if (scriptsResult.added > 0) {
        optimizationsApplied++
        optimizationResults.push(`✅ Added ${scriptsResult.added} package.json scripts`)
      } else {
        optimizationResults.push(`✅ Package.json scripts already optimized`)
      }
    } catch (error: any) {
      optimizationResults.push(`❌ Failed to update package.json scripts: ${error.message}`)
    }

    // 4. Additional optimizations
    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Applying additional optimizations...',
      progressPercent: 80
    })

    try {
      const additionalResult = await this.applyAdditionalOptimizations(token, owner, repo)
      if (additionalResult.applied > 0) {
        optimizationsApplied += additionalResult.applied
        optimizationResults.push(...additionalResult.messages)
      }
    } catch (error: any) {
      optimizationResults.push(`❌ Failed to apply additional optimizations: ${error.message}`)
    }

    await updateOperationProgress(this.env, operationId, {
      status: 'completed',
      progressPercent: 100,
      currentStep: `Worker optimization completed`,
      resultData: { optimizationsApplied, optimizationResults }
    })

    await updateColbyCommand(this.env, commandId, {
      status: 'completed',
      resultData: { optimizationsApplied, optimizationResults }
    })

    // Format the response
    let response = `✅ **Worker Optimization Completed!**\n\n`
    response += `**Optimizations Applied:** ${optimizationsApplied}\n\n`

    if (optimizationResults.length > 0) {
      response += '**Results:**\n'
      for (const result of optimizationResults) {
        response += `${result}\n`
      }
      response += '\n'
    }

    response += '**Next Steps:**\n'
    response += '• Run `pnpm install` to install updated dependencies\n'
    response += '• Run `pnpm typecheck` to verify TypeScript setup\n'
    response += '• Run `pnpm dev` for local development\n'
    response += '• Run `pnpm deploy` when ready to deploy\n\n'

    response += '*Your Cloudflare Worker is now optimized with best practices!*'

    await this.commentOnPR(evt, response)
  }

  private async updateWranglerVersion(token: string, owner: string, repo: string) {
    // Check current package.json for wrangler version
    const packageJsonContent = await this.getFileContent(token, owner, repo, 'package.json')
    if (!packageJsonContent) {
      throw new Error('package.json not found')
    }

    const packageJson = JSON.parse(packageJsonContent)
    const currentVersion = packageJson.dependencies?.wrangler || packageJson.devDependencies?.wrangler

    if (!currentVersion) {
      throw new Error('Wrangler not found in package.json')
    }

    // Get latest wrangler version from npm
    const latestVersion = await this.getLatestWranglerVersion()

    if (currentVersion === latestVersion || currentVersion === `^${latestVersion}`) {
      return { updated: false, currentVersion }
    }

    // Update package.json
    const updatedPackageJson = { ...packageJson }

    if (updatedPackageJson.dependencies?.wrangler) {
      updatedPackageJson.dependencies.wrangler = `^${latestVersion}`
    } else if (updatedPackageJson.devDependencies?.wrangler) {
      updatedPackageJson.devDependencies.wrangler = `^${latestVersion}`
    }

    await this.updateFileContent(token, owner, repo, 'package.json', JSON.stringify(updatedPackageJson, null, 2),
      `Update Wrangler to latest version ${latestVersion}`)

    return {
      updated: true,
      oldVersion: currentVersion,
      newVersion: latestVersion
    }
  }

  private async getLatestWranglerVersion(): Promise<string> {
    try {
      const response = await fetch('https://registry.npmjs.org/wrangler/latest')
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const data = await response.json() as { version: string }
      return data.version
    } catch (error) {
      console.log('Failed to fetch latest wrangler version, using fallback')
      return '3.114.14' // fallback to known recent version
    }
  }

  private async ensureObservabilityConfig(token: string, owner: string, repo: string) {
    // Check for wrangler.toml first
    let configPath = 'wrangler.toml'
    let configContent = await this.getFileContent(token, owner, repo, configPath)

    if (!configContent) {
      // Check for wrangler.jsonc
      configPath = 'wrangler.jsonc'
      configContent = await this.getFileContent(token, owner, repo, configPath)
    }

    if (!configContent) {
      throw new Error('No wrangler configuration file found')
    }

    let updated = false
    let updatedContent = configContent

    if (configPath.endsWith('.toml')) {
      // Handle TOML format
      if (!configContent.includes('[observability]')) {
        updatedContent += '\n\n[observability]\nenabled = true\n'
        updated = true
      } else if (!configContent.includes('enabled = true') && configContent.includes('[observability]')) {
        // Update existing observability section
        updatedContent = configContent.replace(
          /\[observability\][^\[]*/,
          (match) => match + '\nenabled = true\n'
        )
        updated = true
      }
    } else {
      // Handle JSONC format
      const jsonConfig = JSON.parse(configContent)
      if (!jsonConfig.observability) {
        jsonConfig.observability = { enabled: true }
        updatedContent = JSON.stringify(jsonConfig, null, 2)
        updated = true
      } else if (!jsonConfig.observability.enabled) {
        jsonConfig.observability.enabled = true
        updatedContent = JSON.stringify(jsonConfig, null, 2)
        updated = true
      }
    }

    if (updated) {
      await this.updateFileContent(token, owner, repo, configPath, updatedContent,
        'Add observability configuration for better logging')
    }

    return { added: updated, configPath }
  }

  private async ensurePackageScripts(token: string, owner: string, repo: string) {
    const packageJsonContent = await this.getFileContent(token, owner, repo, 'package.json')
    if (!packageJsonContent) {
      throw new Error('package.json not found')
    }

    const packageJson = JSON.parse(packageJsonContent)
    const currentScripts = packageJson.scripts || {}

    const optimalScripts = {
      "generate-types": "wrangler types",
      "typecheck": "pnpm generate-types && tsc -p tsconfig.json",
      "build": "pnpm generate-types && wrangler build",
      "dev": "pnpm migrate:local && wrangler dev",
      "migrate:local": "pnpm wrangler d1 migrations apply JOB_SCRAPER_DB --local",
      "migrate:remote": "pnpm wrangler d1 migrations apply JOB_SCRAPER_DB --remote",
      "deploy": "pnpm build && pnpm migrate:remote && pnpm wrangler deploy"
    }

    let scriptsAdded = 0
    const updatedScripts = { ...currentScripts }

    for (const [scriptName, scriptCommand] of Object.entries(optimalScripts)) {
      if (!updatedScripts[scriptName]) {
        updatedScripts[scriptName] = scriptCommand
        scriptsAdded++
      }
    }

    if (scriptsAdded > 0) {
      const updatedPackageJson = {
        ...packageJson,
        scripts: updatedScripts
      }

      await this.updateFileContent(token, owner, repo, 'package.json',
        JSON.stringify(updatedPackageJson, null, 2),
        `Add ${scriptsAdded} optimized package.json scripts`)
    }

    return { added: scriptsAdded, total: Object.keys(updatedScripts).length }
  }

  private async applyAdditionalOptimizations(token: string, owner: string, repo: string) {
    const optimizations = []
    let applied = 0

    // Check for .gitignore and add wrangler-specific entries
    try {
      const gitignoreContent = await this.getFileContent(token, owner, repo, '.gitignore')
      if (gitignoreContent && !gitignoreContent.includes('wrangler.toml')) {
        const updatedGitignore = gitignoreContent + '\n\n# Wrangler\n.wrangler/\n'
        await this.updateFileContent(token, owner, repo, '.gitignore', updatedGitignore,
          'Add wrangler-specific .gitignore entries')
        optimizations.push('✅ Added wrangler-specific .gitignore entries')
        applied++
      }
    } catch (error) {
      // .gitignore doesn't exist or other error, skip
    }

    // Check for .env.example file
    try {
      const envExampleExists = await this.getFileContent(token, owner, repo, '.env.example')
      if (!envExampleExists) {
        const envExampleContent = `# Environment variables for Cloudflare Worker
# Copy this file to .env and fill in your values

# Wrangler configuration
CLOUDFLARE_API_TOKEN=your_api_token_here
CLOUDFLARE_ACCOUNT_ID=your_account_id_here

# Database (if using D1)
DATABASE_ID=your_database_id_here

# AI (if using Workers AI)
AI_API_TOKEN=your_ai_token_here

# Other service tokens as needed
`
        await this.updateFileContent(token, owner, repo, '.env.example', envExampleContent,
          'Add .env.example file for environment variable template')
        optimizations.push('✅ Added .env.example file')
        applied++
      }
    } catch (error) {
      // Skip if file exists or other error
    }

    return { applied, messages: optimizations }
  }

  private async getFileContent(token: string, owner: string, repo: string, path: string): Promise<string | null> {
    try {
      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Colby-GitHub-Bot/1.0'
        }
      })

      if (!response.ok) {
        return null
      }

      const data = await response.json() as { content?: string; encoding?: string }
      if (data.content && data.encoding === 'base64') {
        return atob(data.content)
      }

      return null
    } catch (error) {
      return null
    }
  }

  private async updateFileContent(token: string, owner: string, repo: string, path: string, content: string, message: string) {
    // Get current file SHA if it exists
    let sha: string | undefined
    try {
      const existingFile = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Colby-GitHub-Bot/1.0'
        }
      })

      if (existingFile.ok) {
        const fileData = await existingFile.json() as { sha?: string }
        sha = fileData.sha
      }
    } catch (error) {
      // File doesn't exist, which is fine for new files
    }

    // Create/update the file
    const updateData = {
      message,
      content: btoa(content),
      ...(sha && { sha })
    }

    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Colby-GitHub-Bot/1.0',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updateData)
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Failed to update ${path}: ${response.status} ${errorText}`)
    }
  }

  private async handleAutoLlmDocsCreation(evt: PREvent) {
    const [owner, repo] = evt.repo.split('/')
    if (!evt.installationId) {
      console.log('[DO] Missing installationId for auto LLMs docs creation')
      return new Response('missing installation id', { status: 400 })
    }

    console.log('[DO] Starting automatic LLMs documentation creation for repository:', evt.repo)

    try {
      const token = await getInstallationToken(this.env, evt.installationId)

      // Use the existing LLMs documentation creation logic but without progress updates
      const llmsDocumentationConfig = {
        "llms_txt_categorized": [
          {
            "category": "Application Hosting / Full Stack",
            "urls": [
              "https://developers.cloudflare.com/pages/llms-full.txt",
              "https://developers.cloudflare.com/containers/llms-full.txt",
              "https://developers.cloudflare.com/developer-platform/llms-full.txt"
            ]
          },
          {
            "category": "AI & Agents",
            "urls": [
              "https://developers.cloudflare.com/agents/llms-full.txt",
              "https://developers.cloudflare.com/ai-gateway/llms-full.txt",
              "https://developers.cloudflare.com/workers-ai/llms-full.txt",
              "https://developers.cloudflare.com/autorag/llms-full.txt"
            ]
          },
          {
            "category": "Edge Compute",
            "urls": [
              "https://developers.cloudflare.com/workers/llms-full.txt",
              "https://developers.cloudflare.com/workflows/llms-full.txt"
            ]
          },
          {
            "category": "Stateful Services (Databases, Storage, Messaging, Realtime)",
            "urls": [
              "https://developers.cloudflare.com/kv/llms-full.txt",
              "https://developers.cloudflare.com/durable-objects/llms-full.txt",
              "https://developers.cloudflare.com/d1/llms-full.txt",
              "https://developers.cloudflare.com/r2/llms-full.txt",
              "https://developers.cloudflare.com/queues/llms-full.txt",
              "https://developers.cloudflare.com/vectorize/llms-full.txt",
              "https://developers.cloudflare.com/pipelines/llms-full.txt",
              "https://developers.cloudflare.com/email-routing/llms-full.txt",
              "https://developers.cloudflare.com/pub-sub/llms-full.txt",
              "https://developers.cloudflare.com/hyperdrive/llms-full.txt",
              "https://developers.cloudflare.com/realtime/llms-full.txt"
            ]
          },
          {
            "category": "Developer Tools & Platform",
            "urls": [
              "https://developers.cloudflare.com/logs/llms-full.txt",
              "https://developers.cloudflare.com/developer-spotlight/llms-full.txt"
            ]
          },
          {
            "category": "Browser/Rendering/Images/Media",
            "urls": [
              "https://developers.cloudflare.com/browser-rendering/llms-full.txt",
              "https://developers.cloudflare.com/images/llms-full.txt",
              "https://developers.cloudflare.com/stream/llms-full.txt"
            ]
          },
          {
            "category": "Other/General",
            "urls": [
              "https://developers.cloudflare.com/llms.txt",
              "https://developers.cloudflare.com/workers/prompt.txt",
              "https://developers.cloudflare.com/zaraz/llms-full.txt"
            ]
          }
        ]
      }

      const totalUrls = llmsDocumentationConfig.llms_txt_categorized.reduce(
        (sum, category) => sum + category.urls.length, 0
      )

      console.log(`[DO] Creating LLMs docs for ${evt.repo}: ${totalUrls} URLs across ${llmsDocumentationConfig.llms_txt_categorized.length} categories`)

      let totalSuccess = 0
      let totalFail = 0

      // Process each category
      for (const category of llmsDocumentationConfig.llms_txt_categorized) {
        console.log(`[DO] Processing category: ${category.category}`)

        // Process each URL in the category
        for (const url of category.urls) {
          try {
            const filename = this.extractFilenameFromUrl(url)
            const content = await this.fetchUrlContent(url)

            // Save to GitHub repository
            const filePath = `.agents/llms/${this.sanitizeCategoryName(category.category)}/${filename}`

            await this.createFileInRepo(token, owner, repo, filePath, content, `Auto-add ${filename} documentation`)

            totalSuccess++
            console.log(`[DO] Successfully created ${filePath}`)

          } catch (error: any) {
            console.log(`[DO] Failed to create documentation for ${url}:`, error.message)
            totalFail++
          }
        }
      }

      console.log(`[DO] LLMs documentation creation completed for ${evt.repo}: ${totalSuccess} success, ${totalFail} failed`)

      // Log the automatic creation in the database
      try {
        await this.env.DB.prepare(`
          INSERT INTO auto_llms_creations (repo, total_urls, success_count, fail_count, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).bind(evt.repo, totalUrls, totalSuccess, totalFail, Date.now()).run()
      } catch (dbError) {
        console.log('[DO] Failed to log auto LLMs creation (table may not exist):', dbError)
      }

      return new Response(`auto-llms-created-${totalSuccess}-${totalFail}`, { status: 200 })

    } catch (error: any) {
      console.log('[DO] Error in automatic LLMs documentation creation:', error)
      return new Response('auto-llms-error', { status: 500 })
    }
  }

  private async handleAutoWorkerOptimization(evt: PREvent) {
    const [owner, repo] = evt.repo.split('/')
    if (!evt.installationId) {
      console.log('[DO] Missing installationId for auto worker optimization')
      return new Response('missing installation id', { status: 400 })
    }

    console.log('[DO] Starting automatic worker optimization for repository:', evt.repo)

    try {
      const token = await getInstallationToken(this.env, evt.installationId)

      let totalOptimizations = 0

      // 1. Update Wrangler version (silent)
      try {
        const wranglerUpdate = await this.updateWranglerVersion(token, owner, repo)
        if (wranglerUpdate.updated) {
          totalOptimizations++
          console.log(`[DO] Updated Wrangler from ${wranglerUpdate.oldVersion} to ${wranglerUpdate.newVersion}`)
        }
      } catch (error: any) {
        console.log(`[DO] Failed to update Wrangler: ${error.message}`)
      }

      // 2. Ensure observability configuration (silent)
      try {
        const observabilityResult = await this.ensureObservabilityConfig(token, owner, repo)
        if (observabilityResult.added) {
          totalOptimizations++
          console.log(`[DO] Added observability configuration`)
        }
      } catch (error: any) {
        console.log(`[DO] Failed to configure observability: ${error.message}`)
      }

      // 3. Ensure package.json scripts (silent)
      try {
        const scriptsResult = await this.ensurePackageScripts(token, owner, repo)
        if (scriptsResult.added > 0) {
          totalOptimizations++
          console.log(`[DO] Added ${scriptsResult.added} package.json scripts`)
        }
      } catch (error: any) {
        console.log(`[DO] Failed to update package.json scripts: ${error.message}`)
      }

      // 4. Apply additional optimizations (silent)
      try {
        const additionalResult = await this.applyAdditionalOptimizations(token, owner, repo)
        totalOptimizations += additionalResult.applied
        if (additionalResult.applied > 0) {
          console.log(`[DO] Applied ${additionalResult.applied} additional optimizations`)
        }
      } catch (error: any) {
        console.log(`[DO] Failed to apply additional optimizations: ${error.message}`)
      }

      console.log(`[DO] Worker optimization completed for ${evt.repo}: ${totalOptimizations} optimizations applied`)

      // Log the automatic optimization
      try {
        await this.env.DB.prepare(`
          INSERT INTO auto_optimizations (repo, optimizations_applied, created_at)
          VALUES (?, ?, ?)
        `).bind(evt.repo, totalOptimizations, Date.now()).run()
      } catch (dbError) {
        console.log('[DO] Failed to log auto optimization (table may not exist):', dbError)
      }

      return new Response(`auto-optimized-${totalOptimizations}`, { status: 200 })

    } catch (error: any) {
      console.log('[DO] Error in automatic worker optimization:', error)
      return new Response('auto-optimize-error', { status: 500 })
    }
  }

  private extractFilenameFromUrl(url: string): string {
    try {
      const urlObj = new URL(url)
      const pathname = urlObj.pathname
      // Extract filename from path (e.g., "/pages/llms-full.txt" -> "pages-llms-full.txt")
      const pathParts = pathname.split('/').filter(p => p.length > 0)
      if (pathParts.length >= 2) {
        const category = pathParts[0]
        const filename = pathParts[pathParts.length - 1]
        return `${category}-${filename}`
      }
      return pathname.split('/').pop() || 'unknown.txt'
    } catch {
      return 'unknown.txt'
    }
  }

  private sanitizeCategoryName(category: string): string {
    // Replace characters that are invalid in directory names
    return category
      .replace(/[<>:"/\\|?*]/g, '') // Remove invalid characters
      .replace(/\s+/g, ' ') // Normalize spaces
      .trim()
  }

  private async fetchUrlContent(url: string): Promise<string> {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Colby-GitHub-Bot/1.0'
      }
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    return await response.text()
  }

  private async createFileInRepo(token: string, owner: string, repo: string, filePath: string, content: string, commitMessage: string) {
    // Get the current file (if it exists) to get the SHA
    let fileSha: string | undefined

    try {
      const existingFile = await ghREST(token, 'GET', `/repos/${owner}/${repo}/contents/${filePath}`)
      if (existingFile && typeof existingFile === 'object' && 'sha' in existingFile) {
        fileSha = (existingFile as any).sha
      }
    } catch (error) {
      // File doesn't exist, which is fine for creating new files
    }

    // Create or update the file
    const fileData = {
      message: commitMessage,
      content: btoa(content), // Base64 encode the content
      ...(fileSha && { sha: fileSha }) // Include SHA if updating existing file
    }

    await ghREST(token, 'PUT', `/repos/${owner}/${repo}/contents/${filePath}`, fileData)
  }

  private async handleHelpCommand(evt: PREvent, commandId: number, operationId: string, args: ColbyCommandArgs) {
    const helpText = `## 🤖 Colby Commands

### PR Comment Commands
- \`/colby implement\` - Apply code suggestions from review comments
- \`/colby create issue\` - Create a GitHub issue from this comment
- \`/colby create issue and assign to copilot\` - Create issue and assign to @copilot
- \`/colby bookmark this suggestion\` - Save suggestions as best practices

### PR-Level Commands
- \`/colby extract suggestions\` - Extract all suggestions from Gemini reviews
- \`/colby extract suggestions to issues\` - Extract all suggestions and create issues grouped by filename
- \`/colby group comments by file\` - Group all open review comments by file path and create consolidated issues
- \`/colby optimize worker\` - Optimize Cloudflare Worker with latest Wrangler, observability, and scripts
- \`/colby resolve conflicts\` - Automatically resolve merge conflicts by merging base branch
- \`/colby clear conflicts\` - Same as resolve conflicts
- \`/colby create llms docs\` - Fetch and organize Cloudflare documentation for LLMs

### Global Commands
- \`/colby help\` - Show this help message

### Legacy Commands (still supported)
- \`/apply\` - Apply code suggestions
- \`/summarize\` - Generate PR summary
- \`/fix\`, \`/lint\`, \`/test\` - Coming soon

---
📖 [Full Documentation](https://gh-bot.hacolby.workers.dev/help) | 🌐 [Dashboard](https://gh-bot.hacolby.workers.dev/)`

    await this.commentOnPR(evt, helpText)

    await updateColbyCommand(this.env, commandId, {
      status: 'completed',
      resultData: { message: 'Help displayed' }
    })

    await updateOperationProgress(this.env, operationId, {
      status: 'completed',
      progressPercent: 100,
      currentStep: 'Help displayed'
    })
  }

  private async handleResolveConflictsCommand(evt: PREvent, commandId: number, operationId: string, args: ColbyCommandArgs) {
    const [owner, repo] = evt.repo.split('/')
    if (!evt.installationId) {
      throw new Error('Missing installationId for resolve conflicts command')
    }
    if (!evt.prNumber) {
      throw new Error('Missing prNumber for resolve conflicts command')
    }
    const token = await getInstallationToken(this.env, evt.installationId)

    await updateOperationProgress(this.env, operationId, {
      currentStep: 'Checking for merge conflicts...',
      progressPercent: 25
    })

    // Get PR details to check merge status
    const pr = await ghREST(token, 'GET', `/repos/${owner}/${repo}/pulls/${evt.prNumber}`)

    if (!pr || typeof pr !== 'object') {
      throw new Error('Failed to fetch PR details')
    }

    const mergeableState = (pr as any).mergeable_state
    const mergeable = (pr as any).mergeable
    const headSha = (pr as any).head?.sha
    const baseSha = (pr as any).base?.sha

    console.log('[DO] PR merge status:', {
      mergeable,
      mergeableState,
      headSha: headSha?.substring(0, 8),
      baseSha: baseSha?.substring(0, 8)
    })

    // Check if there are conflicts
    if (mergeable === false || mergeableState === 'dirty') {
      await updateOperationProgress(this.env, operationId, {
        currentStep: 'Conflicts detected, attempting to resolve...',
        progressPercent: 50
      })

      // Try to merge the base branch into the head branch to resolve conflicts
      try {
        const mergeResult = await this.mergeBaseIntoHead(token, owner, repo, evt.prNumber, headSha!, baseSha!)

        await updateOperationProgress(this.env, operationId, {
          currentStep: 'Merge conflicts resolved successfully',
          progressPercent: 90
        })

        await updateColbyCommand(this.env, commandId, {
          status: 'completed',
          resultData: {
            action: 'resolved_conflicts',
            mergeResult,
            headSha: headSha?.substring(0, 8),
            baseSha: baseSha?.substring(0, 8)
          }
        })

        await updateOperationProgress(this.env, operationId, {
          status: 'completed',
          progressPercent: 100,
          currentStep: 'Conflicts resolved and PR updated',
          resultData: { mergeResult }
        })

        await this.commentOnPR(evt, `✅ **Merge conflicts resolved!**\n\nSuccessfully merged the latest changes from \`${(pr as any).base?.ref}\` into the PR branch. The conflicts have been resolved and the PR is ready for review.\n\n**Updated branch:** ${(pr as any).head?.ref}\n**Latest commit:** \`${headSha?.substring(0, 8)}\``)

      } catch (mergeError: any) {
        console.log('[DO] Failed to resolve conflicts:', mergeError)

        await updateColbyCommand(this.env, commandId, {
          status: 'failed',
          errorMessage: `Failed to resolve conflicts: ${mergeError.message}`
        })

        await updateOperationProgress(this.env, operationId, {
          status: 'failed',
          progressPercent: 100,
          currentStep: 'Failed to resolve conflicts',
          errorMessage: mergeError.message
        })

        await this.commentOnPR(evt, `❌ **Failed to resolve merge conflicts**\n\n${mergeError.message}\n\nYou may need to manually resolve the conflicts by:\n1. Updating your branch with the latest changes from \`${(pr as any).base?.ref}\`\n2. Resolving any remaining conflicts\n3. Pushing the updated branch`)
      }

    } else if (mergeable === true && mergeableState === 'clean') {
      // No conflicts to resolve
      await updateOperationProgress(this.env, operationId, {
        currentStep: 'No conflicts detected',
        progressPercent: 100
      })

      await updateColbyCommand(this.env, commandId, {
        status: 'completed',
        resultData: { message: 'No conflicts to resolve' }
      })

      await this.commentOnPR(evt, `ℹ️ **No merge conflicts detected**\n\nThis PR can be merged without any conflicts. The branch is up to date with the base branch \`${(pr as any).base?.ref}\`.`)

    } else {
      // Unknown state or checking in progress
      await updateOperationProgress(this.env, operationId, {
        currentStep: 'Checking merge status...',
        progressPercent: 50
      })

      await updateColbyCommand(this.env, commandId, {
        status: 'completed',
        resultData: {
          message: 'Merge status unknown',
          mergeableState,
          mergeable
        }
      })

      await this.commentOnPR(evt, `⏳ **Checking merge conflicts...**\n\nThe merge status is currently \`${mergeableState}\`. This usually means GitHub is still determining if there are conflicts. Please try again in a moment.`)
    }
  }

  private async mergeBaseIntoHead(token: string, owner: string, repo: string, prNumber: number, headSha: string, baseSha: string) {
    // Get the PR details to find branch information
    const pr = await ghREST(token, 'GET', `/repos/${owner}/${repo}/pulls/${prNumber}`)

    if (!pr || typeof pr !== 'object') {
      throw new Error('Failed to fetch PR details for merge')
    }

    const headRef = (pr as any).head?.ref
    const baseRef = (pr as any).base?.ref

    if (!headRef || !baseRef) {
      throw new Error('Missing branch information for merge')
    }

    // Try to merge the base branch into the head branch
    // First, get the latest commit from base branch
    const baseBranch = await ghREST(token, 'GET', `/repos/${owner}/${repo}/branches/${baseRef}`)

    if (!baseBranch || typeof baseBranch !== 'object') {
      throw new Error('Failed to fetch base branch information')
    }

    const latestBaseSha = (baseBranch as any).commit?.sha

    if (!latestBaseSha) {
      throw new Error('Failed to get latest commit from base branch')
    }

    // Create a merge commit
    const mergeCommit = await ghGraphQL(token, `
      mutation MergeBranches($input: MergeBranchInput!) {
        mergeBranch(input: $input) {
          mergeCommit {
            oid
            message
            url
          }
        }
      }`, {
      input: {
        repositoryId: (pr as any).base?.repo?.id,
        base: headRef,
        head: baseRef,
        commitMessage: `Merge branch '${baseRef}' into ${headRef}`,
        authorEmail: 'colby-gh-bot@users.noreply.github.com'
      }
    })

    if (!mergeCommit?.data?.mergeBranch?.mergeCommit) {
      throw new Error('Failed to create merge commit')
    }

    return {
      success: true,
      mergeCommit: mergeCommit.data.mergeBranch.mergeCommit,
      headRef,
      baseRef,
      latestBaseSha: latestBaseSha.substring(0, 8)
    }
  }

  private async generateCodexPrompt(repo: string, comment: GitHubComment, suggestion: string): Promise<string> {
    return `Repository: ${repo}
File: ${comment.path || 'unknown'}
Line: ${comment.line || 'unknown'}

Original Comment Context:
${comment.body?.slice(0, 500)}

Specific Suggestion:
${suggestion}

Task: Implement this suggestion in the codebase. Analyze the context and provide the necessary code changes.`
  }

  private async logWebhookCommands(evt: PREvent, triggers: string[], startTime: number) {
    if (triggers.length === 0) return

    try {
      for (const trigger of triggers) {
        await this.env.DB.prepare(`
          INSERT INTO webhook_command_log
          (delivery_id, command_text, command_type, execution_status, started_at)
          VALUES (?, ?, ?, 'started', ?)
        `).bind(
          evt.delivery,
          trigger,
          trigger.startsWith('/colby') ? 'colby_command' : 'legacy_command',
          startTime
        ).run()
      }
    } catch (error) {
      console.log('Failed to log webhook commands (table may not exist):', error)
    }
  }

  private async sendImmediateFeedback(evt: PREvent, triggers: string[]) {
    if (triggers.length === 0) return

    try {
      // Add heart emoji reaction to acknowledge receipt of commands
      await this.addHeartReaction(evt)
    } catch (error) {
      console.log('Failed to add heart reaction:', error)
    }
  }

  private async addHeartReaction(evt: PREvent) {
    if (!evt || !evt.installationId || !evt.commentId) {
      console.log('[DO] Missing required fields for heart reaction')
      return
    }

    const [owner, repo] = evt.repo.split('/')
    console.log('[DO] Adding heart reaction to comment:', { owner, repo, commentId: evt.commentId })

    try {
      const token = await getInstallationToken(this.env, evt.installationId)
      await addReactionToComment({
        installationToken: token,
        owner,
        repo,
        commentId: evt.commentId,
        content: 'heart'
      })
      console.log('[DO] Successfully added heart reaction')
    } catch (error) {
      console.log('[DO] Failed to add heart reaction:', error)
    }
  }

  private async logCommandFailure(evt: any, error: any, startTime: number) {
    try {
      const processingTime = Date.now() - startTime
      const errorDetails = error?.message || String(error)

      await this.env.DB.prepare(`
        UPDATE webhook_command_log
        SET execution_status = 'failed', execution_result = ?, completed_at = ?
        WHERE delivery_id = ?
      `).bind(
        errorDetails,
        Date.now(),
        evt.delivery
      ).run()
    } catch (dbError) {
      console.log('Failed to log command failure (table may not exist):', dbError)
    }
  }
}
