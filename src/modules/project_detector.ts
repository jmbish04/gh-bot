/// <reference types="@cloudflare/workers-types" />
// src/modules/project_detector.ts
import { ghREST } from '../github'

type Env = {
  DB: D1Database
  GITHUB_APP_ID: string
  GITHUB_PRIVATE_KEY: string
}

export interface ProjectAnalysisResult {
  repo: string
  projectType: 'cloudflare-worker' | 'cloudflare-pages' | 'nextjs-pages' | 'apps-script' | 'python' | 'unknown'
  hasWrangler: boolean
  hasNextConfig: boolean
  hasPackageJson: boolean
  hasClaspJson: boolean
  hasAppsScriptJson: boolean
  hasPythonFiles: boolean
  dependencies: string[]
  devDependencies: string[]
  analysisDetails: FileAnalysisDetails
  confidenceScore: number
  cached: boolean
}

interface FileAnalysisDetails {
  detectedFiles: DetectedFile[]
  packageJsonContent?: any
  wranglerContent?: any
  nextConfigFound: boolean
  pythonFilesCount: number
  jsFrameworks: string[]
  buildTools: string[]
  deploymentIndicators: string[]
}

interface DetectedFile {
  path: string
  type: string
  significance: 'high' | 'medium' | 'low'
  reason: string
}

interface CachedProjectInfo {
  repo: string
  projectType: string
  analysisDetails: string
  confidenceScore: number
  lastAnalyzed: number
}

/**
 * Project Detection Service for analyzing GitHub repositories
 */
export class ProjectDetector {
  private env: Env
  private token: string

  constructor(env: Env, token: string) {
    this.env = env
    this.token = token
  }

  /**
   * Analyzes a repository to determine its project type
   */
  async analyzeRepository(repo: string, options: {
    forceRefresh?: boolean
    cacheMaxAge?: number
  } = {}): Promise<ProjectAnalysisResult> {
    const { forceRefresh = false, cacheMaxAge = 24 * 60 * 60 * 1000 } = options // 24 hours default

    console.log('[PROJECT_DETECTOR] Analyzing repository:', repo)

    // Check cache first unless force refresh is requested
    if (!forceRefresh) {
      const cachedResult = await this.getCachedAnalysis(repo, cacheMaxAge)
      if (cachedResult) {
        console.log('[PROJECT_DETECTOR] Using cached analysis for:', repo)
        return cachedResult
      }
    }

    const [owner, repoName] = repo.split('/')
    if (!owner || !repoName) {
      throw new Error(`Invalid repository format: ${repo}`)
    }

    try {
      // Analyze repository contents
      const analysisDetails = await this.analyzeRepositoryContents(owner, repoName)

      // Determine project type based on analysis
      const projectType = this.determineProjectType(analysisDetails)
      const confidenceScore = this.calculateConfidenceScore(analysisDetails, projectType)

      // Extract dependencies from package.json if found
      const { dependencies, devDependencies } = this.extractDependencies(analysisDetails.packageJsonContent)

      const result: ProjectAnalysisResult = {
        repo,
        projectType,
        hasWrangler: analysisDetails.detectedFiles.some(f => f.path.includes('wrangler.')),
        hasNextConfig: analysisDetails.nextConfigFound,
        hasPackageJson: !!analysisDetails.packageJsonContent,
        hasClaspJson: analysisDetails.detectedFiles.some(f => f.path === '.clasp.json'),
        hasAppsScriptJson: analysisDetails.detectedFiles.some(f => f.path === 'appsscript.json'),
        hasPythonFiles: analysisDetails.pythonFilesCount > 0,
        dependencies,
        devDependencies,
        analysisDetails,
        confidenceScore,
        cached: false
      }

      // Cache the analysis result
      await this.cacheAnalysisResult(result)

      console.log(`[PROJECT_DETECTOR] Analysis complete for ${repo}:`, {
        projectType,
        confidenceScore,
        filesDetected: analysisDetails.detectedFiles.length
      })

      return result
    } catch (error) {
      console.error('[PROJECT_DETECTOR] Analysis failed:', error)
      throw new Error(`Failed to analyze repository ${repo}: ${error}`)
    }
  }

  /**
   * Analyzes the contents of a repository by examining key files
   */
  private async analyzeRepositoryContents(owner: string, repoName: string): Promise<FileAnalysisDetails> {
    const analysisDetails: FileAnalysisDetails = {
      detectedFiles: [],
      nextConfigFound: false,
      pythonFilesCount: 0,
      jsFrameworks: [],
      buildTools: [],
      deploymentIndicators: []
    }

    // Key files to check for project type detection
    const keyFiles = [
      'wrangler.toml',
      'wrangler.json',
      'wrangler.jsonc',
      'package.json',
      'next.config.js',
      'next.config.ts',
      'next.config.mjs',
      '.clasp.json',
      'appsscript.json',
      'requirements.txt',
      'pyproject.toml',
      'setup.py',
      'Pipfile',
      'README.md',
      'README.rst',
      'tsconfig.json',
      'vite.config.js',
      'webpack.config.js',
      'nuxt.config.js',
      'gatsby-config.js',
      'svelte.config.js',
      '.vercel/project.json',
      'netlify.toml',
      'Dockerfile'
    ]

    // Check for key files in the repository
    for (const filePath of keyFiles) {
      try {
        const fileData = await this.getFileContent(owner, repoName, filePath)
        if (fileData) {
          const detectedFile: DetectedFile = {
            path: filePath,
            type: this.getFileType(filePath),
            significance: this.getFileSignificance(filePath),
            reason: this.getDetectionReason(filePath)
          }

          analysisDetails.detectedFiles.push(detectedFile)

          // Special handling for important files
          if (filePath === 'package.json') {
            try {
              analysisDetails.packageJsonContent = JSON.parse(fileData.content)
            } catch (e) {
              console.warn('[PROJECT_DETECTOR] Failed to parse package.json:', e)
            }
          } else if (filePath.startsWith('wrangler.')) {
            try {
              if (filePath.endsWith('.json') || filePath.endsWith('.jsonc')) {
                analysisDetails.wranglerContent = JSON.parse(fileData.content)
              } else {
                // For wrangler.toml, just store raw content
                analysisDetails.wranglerContent = { raw: fileData.content }
              }
            } catch (e) {
              console.warn('[PROJECT_DETECTOR] Failed to parse wrangler config:', e)
            }
          } else if (filePath.includes('next.config')) {
            analysisDetails.nextConfigFound = true
          }

          console.log(`[PROJECT_DETECTOR] Found ${filePath}`)
        }
      } catch (error) {
        // File doesn't exist, continue
      }
    }

    // Check for Python files in common directories
    analysisDetails.pythonFilesCount = await this.countPythonFiles(owner, repoName)

    // Analyze package.json for frameworks and build tools
    if (analysisDetails.packageJsonContent) {
      analysisDetails.jsFrameworks = this.detectJavaScriptFrameworks(analysisDetails.packageJsonContent)
      analysisDetails.buildTools = this.detectBuildTools(analysisDetails.packageJsonContent)
      analysisDetails.deploymentIndicators = this.detectDeploymentIndicators(analysisDetails.packageJsonContent)
    }

    return analysisDetails
  }

  /**
   * Determines the project type based on analysis results
   */
  private determineProjectType(analysis: FileAnalysisDetails): ProjectAnalysisResult['projectType'] {
    // Cloudflare Workers - highest priority for wrangler config
    if (analysis.detectedFiles.some(f => f.path.startsWith('wrangler.'))) {
      // If has Next.js config, it's likely Pages with Next.js
      if (analysis.nextConfigFound) {
        return 'cloudflare-pages'
      }
      return 'cloudflare-worker'
    }

    // Apps Script - check for .clasp.json or appsscript.json
    if (analysis.detectedFiles.some(f => f.path === '.clasp.json' || f.path === 'appsscript.json')) {
      return 'apps-script'
    }

    // Next.js - check for next.config files and Next.js dependencies
    if (analysis.nextConfigFound ||
        (analysis.packageJsonContent &&
         (analysis.packageJsonContent.dependencies?.next ||
          analysis.packageJsonContent.devDependencies?.next))) {
      return 'nextjs-pages'
    }

    // Python project - check for Python-specific files and high Python file count
    const pythonIndicators = analysis.detectedFiles.filter(f =>
      f.path === 'requirements.txt' ||
      f.path === 'pyproject.toml' ||
      f.path === 'setup.py' ||
      f.path === 'Pipfile'
    )

    if (pythonIndicators.length > 0 || analysis.pythonFilesCount > 5) {
      return 'python'
    }

    // Cloudflare Pages - look for static site generators or deployment indicators
    const pageIndicators = analysis.jsFrameworks.some(fw =>
      ['gatsby', 'nuxt', 'vite', 'react', 'vue', 'svelte', 'astro'].includes(fw)
    ) || analysis.deploymentIndicators.some(ind =>
      ['vercel', 'netlify', 'pages'].includes(ind)
    )

    if (pageIndicators && analysis.packageJsonContent) {
      return 'cloudflare-pages'
    }

    return 'unknown'
  }

  /**
   * Calculates confidence score for the project type detection
   */
  private calculateConfidenceScore(analysis: FileAnalysisDetails, projectType: ProjectAnalysisResult['projectType']): number {
    let score = 0

    // Base scoring by project type certainty
    const highConfidenceFiles = analysis.detectedFiles.filter(f => f.significance === 'high')
    const mediumConfidenceFiles = analysis.detectedFiles.filter(f => f.significance === 'medium')

    score += highConfidenceFiles.length * 30
    score += mediumConfidenceFiles.length * 15
    score += analysis.detectedFiles.length * 5

    // Type-specific bonuses
    switch (projectType) {
      case 'cloudflare-worker':
        if (analysis.detectedFiles.some(f => f.path.startsWith('wrangler.'))) score += 40
        if (analysis.packageJsonContent?.dependencies?.['@cloudflare/workers-types']) score += 20
        break

      case 'cloudflare-pages':
        if (analysis.nextConfigFound) score += 30
        if (analysis.jsFrameworks.length > 0) score += 20
        break

      case 'nextjs-pages':
        if (analysis.nextConfigFound) score += 40
        if (analysis.packageJsonContent?.dependencies?.next) score += 30
        break

      case 'apps-script':
        if (analysis.detectedFiles.some(f => f.path === '.clasp.json')) score += 50
        if (analysis.detectedFiles.some(f => f.path === 'appsscript.json')) score += 40
        break

      case 'python':
        if (analysis.pythonFilesCount > 10) score += 40
        if (analysis.detectedFiles.some(f => f.path === 'requirements.txt')) score += 30
        break
    }

    // Cap at 100 and normalize
    return Math.min(score, 100) / 100
  }

  /**
   * Gets file content from GitHub repository
   */
  private async getFileContent(owner: string, repo: string, path: string): Promise<{ content: string } | null> {
    try {
      const response = await ghREST(
        this.token,
        'GET',
        `/repos/${owner}/${repo}/contents/${path}`
      ) as any

      if (response.content && response.encoding === 'base64') {
        return {
          content: Buffer.from(response.content, 'base64').toString('utf-8')
        }
      }

      return null
    } catch (error) {
      return null
    }
  }

  /**
   * Counts Python files in the repository
   */
  private async countPythonFiles(owner: string, repo: string): Promise<number> {
    try {
      // Search for Python files using GitHub's search API
      const searchResponse = await ghREST(
        this.token,
        'GET',
        `/search/code?q=extension:py+repo:${owner}/${repo}`
      ) as any

      return searchResponse.total_count || 0
    } catch (error) {
      console.warn('[PROJECT_DETECTOR] Failed to count Python files:', error)
      return 0
    }
  }

  /**
   * Detects JavaScript frameworks from package.json
   */
  private detectJavaScriptFrameworks(packageJson: any): string[] {
    const frameworks: string[] = []
    const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies }

    const frameworkMap = {
      'react': ['react', '@types/react'],
      'vue': ['vue', '@vue/cli'],
      'angular': ['@angular/core', '@angular/cli'],
      'svelte': ['svelte', '@sveltejs/kit'],
      'next': ['next'],
      'nuxt': ['nuxt', '@nuxt/'],
      'gatsby': ['gatsby'],
      'astro': ['astro'],
      'vite': ['vite'],
      'webpack': ['webpack'],
      'parcel': ['parcel']
    }

    for (const [framework, indicators] of Object.entries(frameworkMap)) {
      if (indicators.some(indicator =>
        Object.keys(allDeps).some(dep =>
          dep === indicator || dep.startsWith(indicator)
        )
      )) {
        frameworks.push(framework)
      }
    }

    return frameworks
  }

  /**
   * Detects build tools from package.json
   */
  private detectBuildTools(packageJson: any): string[] {
    const buildTools: string[] = []
    const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies }

    const buildToolMap = {
      'webpack': ['webpack'],
      'rollup': ['rollup'],
      'vite': ['vite'],
      'parcel': ['parcel'],
      'esbuild': ['esbuild'],
      'babel': ['@babel/core', 'babel'],
      'typescript': ['typescript'],
      'eslint': ['eslint'],
      'prettier': ['prettier']
    }

    for (const [tool, indicators] of Object.entries(buildToolMap)) {
      if (indicators.some(indicator =>
        Object.keys(allDeps).some(dep => dep.startsWith(indicator))
      )) {
        buildTools.push(tool)
      }
    }

    return buildTools
  }

  /**
   * Detects deployment indicators from package.json
   */
  private detectDeploymentIndicators(packageJson: any): string[] {
    const indicators: string[] = []

    // Check scripts for deployment commands
    const scripts = packageJson.scripts || {}

    if (scripts.build?.includes('next')) indicators.push('next')
    if (scripts.deploy?.includes('wrangler')) indicators.push('cloudflare')
    if (scripts.build?.includes('vercel')) indicators.push('vercel')
    if (scripts.build?.includes('netlify')) indicators.push('netlify')

    // Check dependencies
    const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies }

    if (allDeps['@cloudflare/next-on-pages']) indicators.push('cloudflare-pages')
    if (allDeps['wrangler']) indicators.push('cloudflare')
    if (allDeps['@vercel/node']) indicators.push('vercel')

    return indicators
  }

  /**
   * Helper methods for file classification
   */
  private getFileType(filePath: string): string {
    if (filePath.startsWith('wrangler.')) return 'cloudflare-config'
    if (filePath === 'package.json') return 'node-config'
    if (filePath.includes('next.config')) return 'nextjs-config'
    if (filePath === '.clasp.json') return 'apps-script-config'
    if (filePath === 'appsscript.json') return 'apps-script-manifest'
    if (['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'].includes(filePath)) return 'python-config'
    if (filePath === 'tsconfig.json') return 'typescript-config'
    if (filePath.includes('config.js') || filePath.includes('config.ts')) return 'build-config'
    return 'other'
  }

  private getFileSignificance(filePath: string): 'high' | 'medium' | 'low' {
    const highSignificance = ['wrangler.toml', 'wrangler.json', '.clasp.json', 'appsscript.json', 'package.json']
    const mediumSignificance = ['next.config.js', 'requirements.txt', 'tsconfig.json', 'wrangler.jsonc']

    if (highSignificance.some(file => filePath.includes(file))) return 'high'
    if (mediumSignificance.some(file => filePath.includes(file))) return 'medium'
    return 'low'
  }

  private getDetectionReason(filePath: string): string {
    const reasonMap: Record<string, string> = {
      'wrangler.toml': 'Cloudflare Workers configuration file',
      'wrangler.json': 'Cloudflare Workers configuration file',
      'wrangler.jsonc': 'Cloudflare Workers configuration file',
      '.clasp.json': 'Google Apps Script project configuration',
      'appsscript.json': 'Google Apps Script manifest file',
      'package.json': 'Node.js project manifest',
      'requirements.txt': 'Python dependencies file',
      'pyproject.toml': 'Modern Python project configuration',
      'next.config.js': 'Next.js framework configuration',
      'next.config.ts': 'Next.js framework configuration',
      'tsconfig.json': 'TypeScript project configuration'
    }

    return reasonMap[filePath] || `Configuration or project file: ${filePath}`
  }

  /**
   * Extracts dependencies from package.json content
   */
  private extractDependencies(packageJsonContent: any): { dependencies: string[]; devDependencies: string[] } {
    if (!packageJsonContent) {
      return { dependencies: [], devDependencies: [] }
    }

    return {
      dependencies: Object.keys(packageJsonContent.dependencies || {}),
      devDependencies: Object.keys(packageJsonContent.devDependencies || {})
    }
  }

  /**
   * Retrieves cached analysis from database
   */
  private async getCachedAnalysis(repo: string, maxAge: number): Promise<ProjectAnalysisResult | null> {
    try {
      const result = await this.env.DB.prepare(
        'SELECT * FROM project_type_cache WHERE repo = ? AND (? - last_analyzed) < ?'
      ).bind(repo, Date.now(), maxAge).first()

      if (result) {
        const analysisDetails = JSON.parse(result.analysis_details as string)

        return {
          repo,
          projectType: result.project_type as ProjectAnalysisResult['projectType'],
          hasWrangler: !!result.has_wrangler,
          hasNextConfig: !!result.has_next_config,
          hasPackageJson: !!result.has_package_json,
          hasClaspJson: !!result.has_clasp_json,
          hasAppsScriptJson: !!result.has_apps_script_json,
          hasPythonFiles: !!result.has_python_files,
          dependencies: JSON.parse(result.dependencies as string || '[]'),
          devDependencies: JSON.parse(result.dev_dependencies as string || '[]'),
          analysisDetails,
          confidenceScore: result.confidence_score as number,
          cached: true
        }
      }
    } catch (error) {
      console.warn('[PROJECT_DETECTOR] Failed to get cached analysis:', error)
    }

    return null
  }

  /**
   * Caches analysis result in database
   */
  private async cacheAnalysisResult(result: ProjectAnalysisResult): Promise<void> {
    try {
      await this.env.DB.prepare(`
        INSERT OR REPLACE INTO project_type_cache
        (repo, project_type, has_wrangler, has_next_config, has_package_json,
         has_clasp_json, has_apps_script_json, has_python_files, dependencies,
         dev_dependencies, analysis_details, confidence_score, last_analyzed, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        result.repo,
        result.projectType,
        result.hasWrangler ? 1 : 0,
        result.hasNextConfig ? 1 : 0,
        result.hasPackageJson ? 1 : 0,
        result.hasClaspJson ? 1 : 0,
        result.hasAppsScriptJson ? 1 : 0,
        result.hasPythonFiles ? 1 : 0,
        JSON.stringify(result.dependencies),
        JSON.stringify(result.devDependencies),
        JSON.stringify(result.analysisDetails),
        result.confidenceScore,
        Date.now(),
        Date.now()
      ).run()

      console.log('[PROJECT_DETECTOR] Analysis cached for:', result.repo)
    } catch (error) {
      console.warn('[PROJECT_DETECTOR] Failed to cache analysis:', error)
    }
  }
}

/**
 * Factory function to create a ProjectDetector instance
 */
export function createProjectDetector(env: Env, token: string): ProjectDetector {
  return new ProjectDetector(env, token)
}

/**
 * Convenience function for analyzing a repository
 */
export async function analyzeProjectType(
  env: Env,
  token: string,
  repo: string,
  options?: {
    forceRefresh?: boolean
    cacheMaxAge?: number
  }
): Promise<ProjectAnalysisResult> {
  const detector = createProjectDetector(env, token)
  return await detector.analyzeRepository(repo, options)
}

/**
 * Gets project type statistics from the database
 */
export async function getProjectTypeStats(env: Env): Promise<{
  totalProjects: number
  typeDistribution: Record<string, number>
  averageConfidence: number
  lastAnalyzedRange: { oldest: number; newest: number }
}> {
  try {
    const stats = await env.DB.prepare(`
      SELECT
        project_type,
        COUNT(*) as count,
        AVG(confidence_score) as avg_confidence,
        MIN(last_analyzed) as oldest_analyzed,
        MAX(last_analyzed) as newest_analyzed
      FROM project_type_cache
      GROUP BY project_type
    `).all()

    const totalProjects = (stats.results || []).reduce((sum: number, row: any) => sum + row.count, 0)
    const typeDistribution: Record<string, number> = {}
    let totalConfidence = 0

    for (const row of stats.results || []) {
      typeDistribution[row.project_type as string] = row.count as number
      totalConfidence += (row.avg_confidence as number) * (row.count as number)
    }

    const averageConfidence = totalProjects > 0 ? totalConfidence / totalProjects : 0

    const oldestAnalyzed = Math.min(...(stats.results || []).map((r: any) => r.oldest_analyzed))
    const newestAnalyzed = Math.max(...(stats.results || []).map((r: any) => r.newest_analyzed))

    return {
      totalProjects,
      typeDistribution,
      averageConfidence,
      lastAnalyzedRange: {
        oldest: oldestAnalyzed,
        newest: newestAnalyzed
      }
    }
  } catch (error) {
    console.error('[PROJECT_DETECTOR] Failed to get project type stats:', error)
    return {
      totalProjects: 0,
      typeDistribution: {},
      averageConfidence: 0,
      lastAnalyzedRange: { oldest: 0, newest: 0 }
    }
  }
}
