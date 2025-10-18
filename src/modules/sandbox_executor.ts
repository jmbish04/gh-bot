interface Env {
  Sandbox?: Fetcher
}

/**
 * Structured representation of a parsed merge conflict returned from a sandbox execution.
 */
export interface ConflictRegion {
  startLine: number
  endLine: number
  currentBranch: string
  currentContent: string
  incomingBranch: string
  incomingContent: string
}

export interface ConflictedFile {
  path: string
  conflicts: ConflictRegion[]
}

export interface SandboxConflictResult {
  hasConflicts: boolean
  conflictFiles: ConflictedFile[]
  mergeError?: string
  rawDiff: string
}

interface SandboxRequestPayload {
  repoUrl: string
  prBranch: string
  baseBranch: string
  githubToken?: string
  operationId: string
}

/**
 * Attempts to detect merge conflicts for a pull request by delegating the git operations to the
 * Cloudflare Sandbox service. The sandbox performs a fetch/merge and returns metadata describing
 * the conflict regions which are then normalised for downstream AI analysis.
 *
 * @param env - Worker environment bindings, expected to include the Sandbox service binding.
 * @param repoUrl - HTTPS git URL for the repository.
 * @param prBranch - Name of the pull request head branch.
 * @param baseBranch - Branch to merge into (defaults to `main`).
 * @param githubToken - Optional GitHub access token forwarded to the sandbox for authenticated clone.
 * @returns Structured conflict data describing each conflicted file and the raw diff payload.
 * @throws If the sandbox binding is not available or returns a non-2xx response.
 */
export async function detectConflicts(
  env: Env,
  repoUrl: string,
  prBranch: string,
  baseBranch: string = 'main',
  githubToken?: string
): Promise<SandboxConflictResult> {
  if (!env.Sandbox) {
    throw new Error('Sandbox binding is not configured on the worker environment')
  }

  const operationId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2)
  const body: SandboxRequestPayload = {
    repoUrl,
    prBranch,
    baseBranch,
    githubToken,
    operationId,
  }

  const response = await env.Sandbox.fetch('https://sandbox/detect-conflicts', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const message = `Sandbox conflict detection failed with status ${response.status}`
    throw new Error(message)
  }

  const payload = (await response.json()) as Partial<SandboxConflictResult> & {
    conflictFiles?: ConflictedFile[]
    rawDiff?: string
    mergeError?: string
  }

  const rawDiff = payload.rawDiff ?? ''
  const conflictFiles = payload.conflictFiles ?? (rawDiff ? parseConflictsFromDiff(rawDiff) : [])

  return {
    hasConflicts: payload.hasConflicts ?? conflictFiles.length > 0,
    conflictFiles,
    mergeError: payload.mergeError,
    rawDiff,
  }
}

/**
 * Parses git style conflict markers from a raw diff string, extracting the file path and
 * individual conflict regions. This is used when the sandbox returns a diff payload instead of
 * structured JSON.
 *
 * @param diff - Raw diff string containing conflict markers.
 * @returns Parsed conflict representation.
 */
export function parseConflictsFromDiff(diff: string): ConflictedFile[] {
  const files: ConflictedFile[] = []
  const fileSections = diff.split(/^diff --git /m).filter(Boolean)

  for (const section of fileSections) {
    const headerMatch = section.match(/a\/(\S+) b\/(\S+)/)
    const filePath = headerMatch ? headerMatch[2] : 'unknown'
    const conflicts: ConflictRegion[] = []

    const lines = section.split(/\r?\n/)
    let currentStart = -1
    let currentBranch = ''
    let incomingBranch = ''
    let currentContent: string[] = []
    let incomingContent: string[] = []

    for (const line of lines) {
      if (line.startsWith('<<<<<<<')) {
        currentStart = currentStart === -1 ? conflicts.length : currentStart
        currentBranch = line.replace('<<<<<<<', '').trim() || 'current'
        incomingBranch = ''
        currentContent = []
        incomingContent = []
      } else if (line.startsWith('=======')) {
        incomingBranch = incomingBranch || 'incoming'
      } else if (line.startsWith('>>>>>>>')) {
        const region: ConflictRegion = {
          startLine: 0,
          endLine: 0,
          currentBranch,
          currentContent: currentContent.join('\n'),
          incomingBranch: line.replace('>>>>>>>', '').trim() || incomingBranch || 'incoming',
          incomingContent: incomingContent.join('\n'),
        }
        conflicts.push(region)
        currentStart = -1
      } else {
        if (currentStart !== -1 && incomingBranch === '') {
          currentContent.push(line)
        } else if (currentStart !== -1) {
          incomingContent.push(line)
        }
      }
    }

    if (conflicts.length > 0) {
      files.push({ path: filePath, conflicts })
    }
  }

  return files
}
