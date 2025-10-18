import { describe, expect, it } from 'vitest'
import { CONFLICT_MENTION_PATTERN } from '../src/routes/webhook'
import { parseConflictsFromDiff } from '../src/modules/sandbox_executor'
import { analyzeConflicts } from '../src/modules/ai_conflict_analyzer'

describe('Merge Conflict Resolution', () => {
  describe('Comment Parsing', () => {
    it('detects @colby mention with please fix conflicts', () => {
      const comment = '@colby please fix conflicts in this PR'
      expect(CONFLICT_MENTION_PATTERN.test(comment)).toBe(true)
    })

    it('handles textual variation without at symbol', () => {
      const comment = 'colby, fix the code conflicts when you can'
      expect(CONFLICT_MENTION_PATTERN.test(comment)).toBe(true)
    })

    it('ignores unrelated comments', () => {
      const comment = 'Great work team, nothing to fix here.'
      expect(CONFLICT_MENTION_PATTERN.test(comment)).toBe(false)
    })
  })

  describe('Conflict Detection', () => {
    it('parses conflict regions from a git diff', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts\nindex 111..222 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,4 +1,4 @@\n const message = 'hello'\n<<<<<<< main\nconsole.log(message)\n=======\nconsole.info(message)\n>>>>>>> feature\n`
      const files = parseConflictsFromDiff(diff)
      expect(files).toHaveLength(1)
      expect(files[0]?.path).toBe('src/app.ts')
      expect(files[0]?.conflicts).toHaveLength(1)
      expect(files[0]?.conflicts[0]?.currentContent).toContain('console.log')
      expect(files[0]?.conflicts[0]?.incomingContent).toContain('console.info')
    })
  })

  describe('AI Analysis', () => {
    it('throws when AI binding is unavailable', async () => {
      await expect(
        analyzeConflicts(
          {} as any,
          {
            hasConflicts: true,
            conflictFiles: [
              {
                path: 'src/app.ts',
                conflicts: [
                  {
                    startLine: 1,
                    endLine: 2,
                    currentBranch: 'main',
                    currentContent: 'console.log(message)',
                    incomingBranch: 'feature',
                    incomingContent: 'console.info(message)',
                  },
                ],
              },
            ],
            rawDiff: '',
          },
          { title: 'Test PR', description: 'Testing merge conflicts' },
        ),
      ).rejects.toThrowError('Workers AI binding (env.AI) is required for conflict analysis')
    })
  })
})
