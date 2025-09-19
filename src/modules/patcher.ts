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
  const addedSpan = extractAddedSpanFromHunk(diffHunk)
  const candidateSpans = [beforeSpan, addedSpan].filter((span): span is string => Boolean(span))

  if (candidateSpans.length === 0) {
    // If this is a brand new file (no before context) fall back to writing the suggestion content directly
    if (original.trim().length === 0 && suggestions.length > 0) {
      const combined = suggestions
        .map(s => s.replace(/\r\n/g, '\n').replace(/\n$/, ''))
        .join('\n\n')
      if (combined.trim().length > 0) {
        return { [filePath]: combined }
      }
    }
    return {}
  }

  let updated = original
  let applied = 0

  for (const suggestion of suggestions) {
    // Normalize newlines
    const cleanSuggestion = suggestion.replace(/\r\n/g, '\n').replace(/\n$/, '') // GitHub suggestions often end with newline

    let replaced = false

    for (const candidate of candidateSpans) {
      const cleanBefore = candidate.replace(/\r\n/g, '\n').trimEnd()
      if (!cleanBefore) continue

      // Try exact match first
      if (updated.includes(cleanBefore)) {
        updated = updated.replace(cleanBefore, cleanSuggestion)
        applied++
        replaced = true
        break
      }

      // Fallback: looser match on whitespace
      const loose = collapseWs(cleanBefore)
      const updatedLoose = collapseWs(updated)
      if (loose && updatedLoose.indexOf(loose) >= 0) {
        // Too messy to splice accurately in loose form; skip to avoid corruption
        continue
      }
    }

    // For truly new files with no replaceable span, fall back to writing the suggestion content
    if (!replaced && original.trim().length === 0 && cleanSuggestion.trim().length > 0) {
      updated = cleanSuggestion
      applied++
    }
  }

  if (applied > 0 && updated !== original) {
    return { [filePath]: updated }
  }

  if (original.trim().length === 0 && suggestions.length > 0) {
    const combined = suggestions
      .map(s => s.replace(/\r\n/g, '\n').replace(/\n$/, ''))
      .join('\n\n')
    if (combined.trim().length > 0) {
      return { [filePath]: combined }
    }
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

function extractAddedSpanFromHunk(hunk: string): string | null {
  if (!hunk) return null
  const lines = hunk.split('\n')
  const added = lines
    .filter(ln => ln.startsWith('+') && !ln.startsWith('+++'))
    .map(ln => ln.slice(1))
  const txt = added.join('\n').trimEnd()
  return txt.length ? txt : null
}
