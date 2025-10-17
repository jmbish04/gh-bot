/// <reference types="@cloudflare/workers-types" />
// src/modules/github_commit_service.ts
import { ghREST } from '../github'

type Env = {
  DB: D1Database
  GITHUB_APP_ID: string
  GITHUB_PRIVATE_KEY: string
}

interface FileToCommit {
  path: string
  content: string
  encoding?: 'utf-8' | 'base64'
}

interface CommitOptions {
  message: string
  description?: string
  branch?: string
  author?: {
    name: string
    email: string
  }
  committer?: {
    name: string
    email: string
  }
  createPullRequest?: boolean
  pullRequestOptions?: {
    title: string
    body: string
    base?: string
  }
}

interface CommitResult {
  commitSha: string
  commitUrl: string
  pullRequestUrl?: string
  pullRequestNumber?: number
  filesCommitted: string[]
  branch: string
}

interface BranchInfo {
  name: string
  sha: string
  protected: boolean
}

/**
 * GitHub Commit Service for managing file commits to repositories
 */
export class GitHubCommitService {
  private env: Env
  private token: string
  private repo: string
  private owner: string

  constructor(env: Env, token: string, repo: string) {
    this.env = env
    this.token = token
    this.repo = repo

    const [owner, repoName] = repo.split('/')
    if (!owner || !repoName) {
      throw new Error(`Invalid repository format: ${repo}. Expected format: owner/repo`)
    }
    this.owner = owner
    this.repo = repoName
  }

  /**
   * Commits multiple files to the repository
   */
  async commitFiles(
    files: FileToCommit[],
    options: CommitOptions
  ): Promise<CommitResult> {
    console.log(`[GITHUB_COMMIT] Starting commit process for ${files.length} files to ${this.owner}/${this.repo}`)

    const {
      message,
      description,
      branch = 'main',
      author = {
        name: 'Colby Bot',
        email: 'colby-bot@users.noreply.github.com'
      },
      committer = author,
      createPullRequest = false,
      pullRequestOptions
    } = options

    try {
      // Get current branch info
      const branchInfo = await this.getBranchInfo(branch)
      let targetBranch = branch
      let baseSha = branchInfo.sha

      // If creating a pull request or branch is protected, create a new branch
      if (createPullRequest || branchInfo.protected) {
        const timestamp = Date.now()
        const newBranchName = `colby/agent-assets-${timestamp}`

        await this.createBranch(newBranchName, baseSha)
        targetBranch = newBranchName

        console.log(`[GITHUB_COMMIT] Created new branch: ${newBranchName}`)
      }

      // Create blobs for all files
      const tree: any[] = []
      const committedFiles: string[] = []

      for (const file of files) {
        console.log(`[GITHUB_COMMIT] Processing file: ${file.path}`)

        const blob = await this.createBlob(file.content, file.encoding || 'utf-8')

        tree.push({
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: blob.sha
        })

        committedFiles.push(file.path)
      }

      // Create tree
      const treeResponse = await ghREST(this.token, 'POST', `/repos/${this.owner}/${this.repo}/git/trees`, {
        base_tree: baseSha,
        tree
      })

      // Prepare commit message with description if provided
      const fullMessage = description ? `${message}\n\n${description}` : message

      // Create commit
      const commitResponse = await ghREST(this.token, 'POST', `/repos/${this.owner}/${this.repo}/git/commits`, {
        message: fullMessage,
        tree: (treeResponse as any).sha,
        parents: [baseSha],
        author,
        committer
      })

      const commitSha = (commitResponse as any).sha
      const commitUrl = (commitResponse as any).html_url

      // Update branch reference
      await ghREST(this.token, 'PATCH', `/repos/${this.owner}/${this.repo}/git/refs/heads/${targetBranch}`, {
        sha: commitSha
      })

      console.log(`[GITHUB_COMMIT] Files committed successfully to branch ${targetBranch}:`, committedFiles)

      const result: CommitResult = {
        commitSha,
        commitUrl,
        filesCommitted: committedFiles,
        branch: targetBranch
      }

      // Create pull request if requested
      if (createPullRequest && pullRequestOptions) {
        const prResult = await this.createPullRequest({
          ...pullRequestOptions,
          head: targetBranch,
          base: pullRequestOptions.base || branch
        })

        result.pullRequestUrl = prResult.html_url
        result.pullRequestNumber = prResult.number

        console.log(`[GITHUB_COMMIT] Pull request created: #${prResult.number}`)
      }

      // Log commit to database
      await this.logCommitToDatabase(result, options)

      return result
    } catch (error) {
      console.error('[GITHUB_COMMIT] Commit failed:', error)
      throw new Error(`Failed to commit files to ${this.owner}/${this.repo}: ${error}`)
    }
  }

  /**
   * Commits agent assets specifically
   */
  async commitAgentAssets(
    assets: {
      agentMd: string
      promptMd: string
      prdMd: string
      projectTasksJson: any
    },
    options: Omit<CommitOptions, 'message'> & { customMessage?: string } = {}
  ): Promise<CommitResult> {
    const files: FileToCommit[] = [
      {
        path: '.agents/AGENT.md',
        content: assets.agentMd
      },
      {
        path: '.agents/prompt.md',
        content: assets.promptMd
      },
      {
        path: '.agents/PRD.md',
        content: assets.prdMd
      },
      {
        path: '.agents/project_tasks.json',
        content: JSON.stringify(assets.projectTasksJson, null, 2)
      }
    ]

    const defaultMessage = '🤖 Generated agent configuration assets'
    const defaultDescription = `Added .agents/ folder with:
- AGENT.md: Agent overview and capabilities
- prompt.md: AI agent instructions
- PRD.md: Product requirements
- project_tasks.json: Project task breakdown`

    return await this.commitFiles(files, {
      message: options.customMessage || defaultMessage,
      description: defaultDescription,
      ...options
    })
  }

  /**
   * Commits infrastructure guidance documentation
   */
  async commitInfrastructureGuidance(
    guidance: {
      infraType: string
      recommendations: string
      implementationGuide: string
    },
    options: Omit<CommitOptions, 'message'> & { customMessage?: string } = {}
  ): Promise<CommitResult> {
    const files: FileToCommit[] = [
      {
        path: '.colby/infrastructure-guidance.md',
        content: guidance.recommendations
      },
      {
        path: '.colby/implementation-guide.md',
        content: guidance.implementationGuide
      }
    ]

    const defaultMessage = `📋 Infrastructure guidance for ${guidance.infraType}`
    const defaultDescription = `Generated infrastructure recommendations and implementation guide for ${guidance.infraType} deployment.`

    return await this.commitFiles(files, {
      message: options.customMessage || defaultMessage,
      description: defaultDescription,
      ...options
    })
  }

  /**
   * Updates existing files or creates them if they don't exist
   */
  async updateFiles(
    files: FileToCommit[],
    options: CommitOptions
  ): Promise<CommitResult> {
    console.log(`[GITHUB_COMMIT] Updating ${files.length} files`)

    // Check which files already exist
    const existingFiles = new Map<string, string>()

    for (const file of files) {
      try {
        const existingFile = await ghREST(
          this.token,
          'GET',
          `/repos/${this.owner}/${this.repo}/contents/${file.path}`
        ) as any

        if (existingFile.sha) {
          existingFiles.set(file.path, existingFile.sha)
          console.log(`[GITHUB_COMMIT] Found existing file: ${file.path}`)
        }
      } catch (error) {
        // File doesn't exist, will be created
        console.log(`[GITHUB_COMMIT] File will be created: ${file.path}`)
      }
    }

    // Commit files (this handles both creation and updates)
    return await this.commitFiles(files, options)
  }

  /**
   * Creates a new branch from the specified base
   */
  async createBranch(branchName: string, baseSha: string): Promise<void> {
    try {
      await ghREST(this.token, 'POST', `/repos/${this.owner}/${this.repo}/git/refs`, {
        ref: `refs/heads/${branchName}`,
        sha: baseSha
      })

      console.log(`[GITHUB_COMMIT] Branch created: ${branchName}`)
    } catch (error) {
      console.error('[GITHUB_COMMIT] Failed to create branch:', error)
      throw new Error(`Failed to create branch ${branchName}: ${error}`)
    }
  }

  /**
   * Gets information about a branch
   */
  async getBranchInfo(branchName: string): Promise<BranchInfo> {
    try {
      const branchResponse = await ghREST(
        this.token,
        'GET',
        `/repos/${this.owner}/${this.repo}/branches/${branchName}`
      ) as any

      return {
        name: branchResponse.name,
        sha: branchResponse.commit.sha,
        protected: branchResponse.protected || false
      }
    } catch (error) {
      console.error(`[GITHUB_COMMIT] Failed to get branch info for ${branchName}:`, error)
      throw new Error(`Failed to get branch info for ${branchName}: ${error}`)
    }
  }

  /**
   * Creates a blob for file content
   */
  private async createBlob(content: string, encoding: 'utf-8' | 'base64' = 'utf-8'): Promise<{ sha: string }> {
    const blobData = encoding === 'base64'
      ? { content, encoding: 'base64' }
      : { content: Buffer.from(content).toString('base64'), encoding: 'base64' }

    const blob = await ghREST(
      this.token,
      'POST',
      `/repos/${this.owner}/${this.repo}/git/blobs`,
      blobData
    ) as any

    return { sha: blob.sha }
  }

  /**
   * Creates a pull request
   */
  private async createPullRequest(options: {
    title: string
    body: string
    head: string
    base: string
  }): Promise<{ html_url: string; number: number }> {
    try {
      const pr = await ghREST(
        this.token,
        'POST',
        `/repos/${this.owner}/${this.repo}/pulls`,
        options
      ) as any

      return {
        html_url: pr.html_url,
        number: pr.number
      }
    } catch (error) {
      console.error('[GITHUB_COMMIT] Failed to create pull request:', error)
      throw new Error(`Failed to create pull request: ${error}`)
    }
  }

  /**
   * Logs commit information to database
   */
  private async logCommitToDatabase(result: CommitResult, options: CommitOptions): Promise<void> {
    try {
      const logData = {
        repo: `${this.owner}/${this.repo}`,
        commit_sha: result.commitSha,
        commit_url: result.commitUrl,
        branch: result.branch,
        files_committed: JSON.stringify(result.filesCommitted),
        commit_message: options.message,
        pull_request_number: result.pullRequestNumber,
        pull_request_url: result.pullRequestUrl,
        created_at: Date.now()
      }

      await this.env.DB.prepare(`
        INSERT INTO github_commits
        (repo, commit_sha, commit_url, branch, files_committed, commit_message,
         pull_request_number, pull_request_url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        logData.repo,
        logData.commit_sha,
        logData.commit_url,
        logData.branch,
        logData.files_committed,
        logData.commit_message,
        logData.pull_request_number,
        logData.pull_request_url,
        logData.created_at
      ).run()

      console.log('[GITHUB_COMMIT] Commit logged to database')
    } catch (error) {
      // Don't fail the commit if logging fails
      console.warn('[GITHUB_COMMIT] Failed to log commit to database:', error)
    }
  }
}

/**
 * Factory function to create a GitHubCommitService instance
 */
export function createGitHubCommitService(env: Env, token: string, repo: string): GitHubCommitService {
  return new GitHubCommitService(env, token, repo)
}

/**
 * Convenience function for committing agent assets
 */
export async function commitAgentAssetsToGitHub(
  env: Env,
  assets: {
    agentMd: string
    promptMd: string
    prdMd: string
    projectTasksJson: any
  },
  repo: string,
  token: string,
  options: {
    branch?: string
    customMessage?: string
    createPullRequest?: boolean
    pullRequestTitle?: string
  } = {}
): Promise<CommitResult> {
  const commitService = createGitHubCommitService(env, token, repo)

  const commitOptions: Parameters<typeof commitService.commitAgentAssets>[1] = {
    branch: options.branch || 'main',
    customMessage: options.customMessage,
    createPullRequest: options.createPullRequest || false
  }

  if (options.createPullRequest && options.pullRequestTitle) {
    commitOptions.pullRequestOptions = {
      title: options.pullRequestTitle,
      body: 'Generated agent configuration assets via Colby bot.\n\nPlease review the generated files and merge if everything looks correct.'
    }
  }

  return await commitService.commitAgentAssets(assets, commitOptions)
}

/**
 * Convenience function for committing infrastructure guidance
 */
export async function commitInfrastructureGuidanceToGitHub(
  env: Env,
  guidance: {
    infraType: string
    recommendations: string
    implementationGuide: string
  },
  repo: string,
  token: string,
  options: {
    branch?: string
    customMessage?: string
    createPullRequest?: boolean
    pullRequestTitle?: string
  } = {}
): Promise<CommitResult> {
  const commitService = createGitHubCommitService(env, token, repo)

  const commitOptions: Parameters<typeof commitService.commitInfrastructureGuidance>[1] = {
    branch: options.branch || 'main',
    customMessage: options.customMessage,
    createPullRequest: options.createPullRequest || false
  }

  if (options.createPullRequest && options.pullRequestTitle) {
    commitOptions.pullRequestOptions = {
      title: options.pullRequestTitle,
      body: `Infrastructure guidance for ${guidance.infraType} generated by Colby bot.\n\nThis includes recommendations and implementation steps for deploying with ${guidance.infraType}.`
    }
  }

  return await commitService.commitInfrastructureGuidance(guidance, commitOptions)
}

/**
 * Gets the GitHub installation token for a repository
 */
export async function getInstallationToken(env: Env, installationId: number): Promise<string> {
  try {
    // This would typically use the GitHub App's private key to generate a JWT
    // and then exchange it for an installation token
    // For now, this is a placeholder that would need to be implemented
    // based on the existing GitHub App authentication in the codebase

    console.log(`[GITHUB_COMMIT] Getting installation token for installation: ${installationId}`)

    // This should use the existing GitHub App authentication logic
    // from the codebase to get the installation token
    throw new Error('GitHub installation token generation not yet implemented - needs integration with existing auth')
  } catch (error) {
    console.error('[GITHUB_COMMIT] Failed to get installation token:', error)
    throw error
  }
}
