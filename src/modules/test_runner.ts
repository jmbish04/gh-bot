// src/modules/test_runner.ts
import type { Env } from '../routes/webhook'

export interface TestResult {
  testSuite: string
  totalTests: number
  passedTests: number
  failedTests: number
  skippedTests: number
  durationMs: number
  status: 'passed' | 'failed' | 'error'
  errorMessage?: string
  testDetails: {
    suite: string
    tests: Array<{
      name: string
      status: 'passed' | 'failed' | 'skipped'
      duration?: number
      error?: string
    }>
  }
  triggeredBy: 'cron' | 'manual' | 'api'
}

/**
 * Runs the webhook test suite and returns results
 */
export async function runWebhookTests(env: Env): Promise<TestResult> {
  const startTime = Date.now()
  const testSuite = 'webhook'
  const results: TestResult['testDetails']['tests'] = []

  try {
    // Import test functions dynamically
    const {
      parseTriggers,
      extractSuggestions,
      truncateText,
      simplifyUser,
      simplifyRepository,
      extractRelevantData,
      checkRecentDuplicate,
      isNewRepository,
      CONFLICT_MENTION_PATTERN,
    } = await import('../routes/webhook')

    // Test parseTriggers
    try {
      const triggers = parseTriggers('/apply\n/colby implement')
      if (triggers.length === 2 && triggers.includes('/apply') && triggers.includes('/colby implement')) {
        results.push({ name: 'parseTriggers - multiple commands', status: 'passed' })
      } else {
        results.push({ name: 'parseTriggers - multiple commands', status: 'failed', error: 'Expected 2 triggers' })
      }
    } catch (error) {
      results.push({ name: 'parseTriggers - multiple commands', status: 'failed', error: String(error) })
    }

    // Test extractSuggestions
    try {
      const suggestions = extractSuggestions('```suggestion\nconst x = 1;\n```')
      if (suggestions.length === 1 && suggestions[0].includes('const x = 1')) {
        results.push({ name: 'extractSuggestions - single suggestion', status: 'passed' })
      } else {
        results.push({ name: 'extractSuggestions - single suggestion', status: 'failed', error: 'Expected 1 suggestion' })
      }
    } catch (error) {
      results.push({ name: 'extractSuggestions - single suggestion', status: 'failed', error: String(error) })
    }

    // Test truncateText
    try {
      const longText = 'a'.repeat(5000)
      const truncated = truncateText(longText, 100)
      if (truncated && truncated.length === 101 && truncated.endsWith('…')) {
        results.push({ name: 'truncateText - long text', status: 'passed' })
      } else {
        results.push({ name: 'truncateText - long text', status: 'failed', error: 'Truncation failed' })
      }
    } catch (error) {
      results.push({ name: 'truncateText - long text', status: 'failed', error: String(error) })
    }

    // Test simplifyUser
    try {
      const user = simplifyUser({
        login: 'testuser',
        id: 123,
        type: 'User',
        avatar_url: 'https://example.com/avatar',
        html_url: 'https://github.com/testuser',
      })
      if (user && user.login === 'testuser' && user.id === 123) {
        results.push({ name: 'simplifyUser - valid user', status: 'passed' })
      } else {
        results.push({ name: 'simplifyUser - valid user', status: 'failed', error: 'User simplification failed' })
      }
    } catch (error) {
      results.push({ name: 'simplifyUser - valid user', status: 'failed', error: String(error) })
    }

    // Test simplifyRepository
    try {
      const repo = simplifyRepository({
        id: 456,
        name: 'test-repo',
        full_name: 'owner/test-repo',
        default_branch: 'main',
        private: false,
        html_url: 'https://github.com/owner/test-repo',
        owner: { login: 'owner' },
      })
      if (repo && repo.name === 'test-repo' && repo.full_name === 'owner/test-repo') {
        results.push({ name: 'simplifyRepository - valid repo', status: 'passed' })
      } else {
        results.push({ name: 'simplifyRepository - valid repo', status: 'failed', error: 'Repo simplification failed' })
      }
    } catch (error) {
      results.push({ name: 'simplifyRepository - valid repo', status: 'failed', error: String(error) })
    }

    // Test extractRelevantData
    try {
      const payload = {
        action: 'opened',
        repository: {
          id: 1,
          name: 'repo',
          full_name: 'owner/repo',
          owner: { login: 'owner' },
        },
        pull_request: {
          id: 100,
          number: 1,
          title: 'Test PR',
          state: 'open',
          user: { login: 'author' },
        },
      }
      const relevant = extractRelevantData('pull_request', payload)
      if (relevant.event_type === 'pull_request' && relevant.pull_request?.number === 1) {
        results.push({ name: 'extractRelevantData - pull_request', status: 'passed' })
      } else {
        results.push({ name: 'extractRelevantData - pull_request', status: 'failed', error: 'Data extraction failed' })
      }
    } catch (error) {
      results.push({ name: 'extractRelevantData - pull_request', status: 'failed', error: String(error) })
    }

    // Test checkRecentDuplicate
    try {
      const result = await checkRecentDuplicate(env, `test-delivery-${Date.now()}`, false)
      if (typeof result === 'boolean') {
        results.push({ name: 'checkRecentDuplicate - returns boolean', status: 'passed' })
      } else {
        results.push({ name: 'checkRecentDuplicate - returns boolean', status: 'failed', error: 'Expected boolean' })
      }
    } catch (error) {
      results.push({ name: 'checkRecentDuplicate - returns boolean', status: 'failed', error: String(error) })
    }

    // Test isNewRepository
    try {
      const result = await isNewRepository(env, 'owner/new-repo')
      if (typeof result === 'boolean') {
        results.push({ name: 'isNewRepository - returns boolean', status: 'passed' })
      } else {
        results.push({ name: 'isNewRepository - returns boolean', status: 'failed', error: 'Expected boolean' })
      }
    } catch (error) {
      results.push({ name: 'isNewRepository - returns boolean', status: 'failed', error: String(error) })
    }

    // Test CONFLICT_MENTION_PATTERN
    try {
      if (CONFLICT_MENTION_PATTERN.test('@colby please fix conflicts')) {
        results.push({ name: 'CONFLICT_MENTION_PATTERN - matches', status: 'passed' })
      } else {
        results.push({ name: 'CONFLICT_MENTION_PATTERN - matches', status: 'failed', error: 'Pattern should match' })
      }
    } catch (error) {
      results.push({ name: 'CONFLICT_MENTION_PATTERN - matches', status: 'failed', error: String(error) })
    }

    const durationMs = Date.now() - startTime
    const passedTests = results.filter((r) => r.status === 'passed').length
    const failedTests = results.filter((r) => r.status === 'failed').length
    const skippedTests = results.filter((r) => r.status === 'skipped').length

    return {
      testSuite,
      totalTests: results.length,
      passedTests,
      failedTests,
      skippedTests,
      durationMs,
      status: failedTests > 0 ? 'failed' : 'passed',
      testDetails: {
        suite: testSuite,
        tests: results,
      },
      triggeredBy: 'api', // Will be overridden by caller
    }
  } catch (error) {
    const durationMs = Date.now() - startTime
    return {
      testSuite,
      totalTests: results.length,
      passedTests: results.filter((r) => r.status === 'passed').length,
      failedTests: results.filter((r) => r.status === 'failed').length,
      skippedTests: results.filter((r) => r.status === 'skipped').length,
      durationMs,
      status: 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
      testDetails: {
        suite: testSuite,
        tests: results,
      },
      triggeredBy: 'api',
    }
  }
}

/**
 * Saves test results to the database
 */
export async function saveTestResults(env: Env, result: TestResult): Promise<number> {
  try {
    const insertResult = await env.DB.prepare(
      `INSERT INTO test_results (
        test_suite, total_tests, passed_tests, failed_tests, skipped_tests,
        duration_ms, status, error_message, test_details_json, triggered_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        result.testSuite,
        result.totalTests,
        result.passedTests,
        result.failedTests,
        result.skippedTests,
        result.durationMs,
        result.status,
        result.errorMessage || null,
        JSON.stringify(result.testDetails),
        result.triggeredBy
      )
      .run()

    return (insertResult?.meta?.last_row_id as number) ?? 0
  } catch (error) {
    console.error('[TEST_RUNNER] Failed to save test results:', error)
    throw error
  }
}

/**
 * Gets the latest test result from the database
 */
export async function getLatestTestResult(env: Env): Promise<TestResult | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT 
        id, test_suite, total_tests, passed_tests, failed_tests, skipped_tests,
        duration_ms, status, error_message, test_details_json, triggered_by, created_at
      FROM test_results
      ORDER BY created_at DESC
      LIMIT 1`
    ).first<{
      id: number
      test_suite: string
      total_tests: number
      passed_tests: number
      failed_tests: number
      skipped_tests: number
      duration_ms: number
      status: string
      error_message: string | null
      test_details_json: string
      triggered_by: string
      created_at: string
    }>()

    if (!row) {
      return null
    }

    return {
      testSuite: row.test_suite,
      totalTests: row.total_tests,
      passedTests: row.passed_tests,
      failedTests: row.failed_tests,
      skippedTests: row.skipped_tests,
      durationMs: row.duration_ms,
      status: row.status as 'passed' | 'failed' | 'error',
      errorMessage: row.error_message || undefined,
      testDetails: JSON.parse(row.test_details_json),
      triggeredBy: row.triggered_by as 'cron' | 'manual' | 'api',
    }
  } catch (error) {
    console.error('[TEST_RUNNER] Failed to get latest test result:', error)
    return null
  }
}

