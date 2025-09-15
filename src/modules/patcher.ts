import { getFileAtRef } from './github_helpers'

type BuildArgs = {
  token: string
  owner: string
  repo: string
  headSha: string
  filePath: string
  diffHunk: string
  suggestions: string[] // the raw suggestion bodies
}

/**
 * Builds file changes from suggestions by applying patches to the original file content.
 *
 * @param args - An object containing details about the repository, file, and suggestions.
 * @returns A record of file paths and their new contents after applying suggestions.
 */
export async function buildFileChangesFromSuggestions(args: BuildArgs): Promise<Record<string,string>> {
  const { token, owner, repo, headSha, filePath, diffHunk, suggestions } = args
  const original = await getFileAtRef(token, owner, repo, filePath, headSha)
  if (!original) return {}

  const beforeSpan = extractBeforeSpanFromHunk(diffHunk)
  if (!beforeSpan) return {}

  let updated = original
  let applied = 0

  for (const suggestion of suggestions) {
    // Normalize newlines
    const cleanBefore = beforeSpan.replace(/\r\n/g, '\n').trimEnd()
    const cleanSuggestion = suggestion.replace(/\r\n/g, '\n').replace(/\n$/, '') // GitHub suggestions often end with newline

    // Try exact match first
    if (updated.includes(cleanBefore)) {
      updated = updated.replace(cleanBefore, cleanSuggestion)
      applied++
      continue
    }
    // Fallback: looser match on whitespace
    const loose = collapseWs(cleanBefore)
    const updatedLoose = collapseWs(updated)
    const idx = updatedLoose.indexOf(loose)
    if (idx >= 0) {
      // Too messy to splice accurately in loose form; skip to avoid corruption
      continue
    }
  }

  if (applied > 0 && updated !== original) {
    return { [filePath]: updated }
  }
  return {}
}

function collapseWs(s: string) {
  return s.replace(/[ \t]+/g, ' ').replace(/\r\n/g, '\n')
}

/**
 * Very small parser: from a unified diff hunk, extract the "before" text block
 * we're commenting on (lines starting with ' ' or '-' only, stripped of markers).
 */
function extractBeforeSpanFromHunk(hunk: string): string | null {
  if (!hunk) return null
  const lines = hunk.split('\n')
  const content: string[] = []
  for (const ln of lines) {
    if (ln.startsWith('@@')) continue
    if (ln.startsWith('+')) continue
    if (ln.startsWith(' ') || ln.startsWith('-')) {
      content.push(ln.slice(1))
    }
  }
  const txt = content.join('\n').trimEnd()
  return txt.length ? txt : null
}
