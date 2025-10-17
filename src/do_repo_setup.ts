import { GitHubClient, getInstallationToken, getFileAtRef, ensureBranchExists, ensurePullRequestWithCommit, type CommitFile, ghREST } from './github';
import { formatTimestamp } from './util';
import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml';

type ProjectType = 'cloudflare-worker' | 'python' | 'google-apps-script' | 'unknown';

interface Env {
  DB: D1Database;
  REPO_MEMORY: KVNamespace;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO_DEFAULT_BRANCH_FALLBACK?: string;
  CF_BINDINGS_MCP_URL?: string;
}

interface RepositorySetupPayload {
  owner: string;
  repo: string;
  eventType: string;
  installationId?: number;
  defaultBranch?: string;
}

interface RepositoryAnalysisResult {
  defaultBranch: string;
  selectedFiles: string[];
  projectType: ProjectType;
  frameworks: string[];
  languages: string[];
  summaries: Record<string, string>;
  packageJson?: Record<string, unknown>;
  wranglerPath?: string;
  wranglerConfig?: Record<string, unknown>;
  existingAgents?: string | null;
  existingStyle?: string | null;
}

const DEFAULT_BINDINGS_MCP = 'https://bindings.mcp.cloudflare.com/mcp';

export class RepositorySetupCoordinator {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/analyze' && request.method === 'POST') {
      const payload = (await request.json()) as RepositorySetupPayload;
      this.state.waitUntil(this.handleSetup(payload));
      return Response.json({ status: 'accepted' }, { status: 202 });
    }

    if (url.pathname === '/status' && request.method === 'GET') {
      const status = await this.state.storage.get<RepositoryAnalysisResult>('lastResult');
      return Response.json(status ?? { status: 'idle' });
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleSetup(payload: RepositorySetupPayload): Promise<void> {
    const repoKey = `${payload.owner}/${payload.repo}`;
    await this.logAction(repoKey, payload.eventType, 'start', 'pending', { payload });

    try {
      const token = await this.getToken(payload.installationId);
      if (!token) {
        throw new Error('Missing GitHub token to analyze repository');
      }

      const client = new GitHubClient({ personalAccessToken: token });
      const analysis = await this.analyzeRepository(client, token, payload);
      await this.state.storage.put('lastResult', analysis);
      await this.logAction(repoKey, payload.eventType, 'analyze_repository', 'success', {
        selectedFiles: analysis.selectedFiles,
        projectType: analysis.projectType,
      });

      const commitFiles: CommitFile[] = [];

      const agentContent = await this.ensureAgentFile(repoKey, analysis, payload);
      if (agentContent) commitFiles.push(agentContent);

      const styleContent = await this.ensureStyleGuide(repoKey, analysis, payload);
      if (styleContent) commitFiles.push(styleContent);

      const standardizationFiles = await this.enforceStandardization(repoKey, analysis, token);
      commitFiles.push(...standardizationFiles);

      if (commitFiles.length > 0) {
        await this.createPullRequest(client, payload, analysis.defaultBranch, commitFiles);
        await this.logAction(repoKey, payload.eventType, 'create_pull_request', 'success', {
          files: commitFiles.map((f) => f.path),
        });
      } else {
        await this.logAction(repoKey, payload.eventType, 'create_pull_request', 'skipped', {
          reason: 'No changes required',
        });
      }
    } catch (error) {
      console.error('[REPO_SETUP] Failed to complete setup', error);
      await this.logAction(repoKey, payload.eventType, 'error', 'error', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async getToken(installationId?: number): Promise<string | null> {
    if (installationId) {
      try {
        return await getInstallationToken(this.env, installationId);
      } catch (error) {
        console.warn('[REPO_SETUP] Failed to mint installation token', error);
      }
    }
    return this.env.GITHUB_TOKEN ?? null;
  }

  private async analyzeRepository(client: GitHubClient, token: string, payload: RepositorySetupPayload): Promise<RepositoryAnalysisResult> {
    const repoKey = `${payload.owner}/${payload.repo}`;
    const repo = await ghREST(token, 'GET', `/repos/${payload.owner}/${payload.repo}`);
    const defaultBranch = payload.defaultBranch ?? repo.default_branch ?? this.env.GITHUB_REPO_DEFAULT_BRANCH_FALLBACK ?? 'main';
    const tree = await ghREST(token, 'GET', `/repos/${payload.owner}/${payload.repo}/git/trees/${defaultBranch}?recursive=1`);
    const files = (tree.tree ?? []).filter((node: any) => node.type === 'blob');

    const selectedFiles = this.selectRepresentativeFiles(files.map((f: any) => f.path));
    const summaries: Record<string, string> = {};
    const languages = new Set<string>();
    const frameworks = new Set<string>();
    let packageJson: Record<string, unknown> | undefined;
    let wranglerConfig: any;
    let wranglerPath: string | undefined;

    for (const path of selectedFiles) {
      const cacheKey = `${repoKey}::${defaultBranch}::${path}`;
      const cached = await this.env.REPO_MEMORY.get(cacheKey, 'json') as { summary: string } | null;
      const requiresFreshContent = !cached || ['package.json', 'wrangler.toml', 'wrangler.jsonc', 'AGENTS.md', 'STYLE_GUIDE.md'].includes(path);
      const content = requiresFreshContent ? await getFileAtRef(token, payload.owner, payload.repo, path, defaultBranch) : null;
      if (!cached && !content) continue;

      if (!cached && content) {
        const summary = this.buildSummary(path, content);
        summaries[path] = summary;
        await this.env.REPO_MEMORY.put(cacheKey, JSON.stringify({ summary, captured_at: Date.now() }));
      } else if (cached) {
        summaries[path] = cached.summary;
      }

      const material = content ?? undefined;

      if ((path === 'package.json') && material) {
        try {
          packageJson = JSON.parse(material);
          this.collectFrameworkSignals(packageJson, frameworks);
          languages.add('javascript');
        } catch (error) {
          console.warn('[REPO_SETUP] Failed to parse package.json', error);
        }
      }

      if ((path === 'wrangler.toml' || path === 'wrangler.jsonc') && material) {
        try {
          wranglerPath = path;
          wranglerConfig = this.parseWranglerConfig(material, path.endsWith('.jsonc'));
          frameworks.add('cloudflare-worker');
        } catch (error) {
          console.warn('[REPO_SETUP] Failed to parse wrangler config', error);
        }
      }

      if (path.endsWith('.py')) languages.add('python');
      if (path.endsWith('.ts') || path.endsWith('.js')) languages.add('typescript');
    }

    const existingAgents = await getFileAtRef(token, payload.owner, payload.repo, 'AGENTS.md', defaultBranch);
    const existingStyle = await getFileAtRef(token, payload.owner, payload.repo, 'STYLE_GUIDE.md', defaultBranch);

    const projectType = this.detectProjectType(selectedFiles, wranglerConfig, languages);

    if (projectType === "python") {
      frameworks.add("python");
    } else if (projectType === "google-apps-script") {
      frameworks.add("google-apps-script");
    }

    const analysis: RepositoryAnalysisResult = {
      defaultBranch,
      selectedFiles,
      projectType,
      frameworks: Array.from(frameworks),
      languages: Array.from(languages),
      summaries,
      packageJson,
      wranglerConfig,
      wranglerPath,
      existingAgents,
      existingStyle,
    };

    return analysis;
  }

  private selectRepresentativeFiles(paths: string[]): string[] {
    const preferred = ['README.md', 'package.json', 'wrangler.toml', 'wrangler.jsonc', 'AGENTS.md', 'STYLE_GUIDE.md'];
    const selected = new Set<string>();
    for (const path of preferred) {
      if (paths.includes(path)) selected.add(path);
    }

    const srcFiles = paths.filter((p) => p.startsWith('src/') && /\.(ts|tsx|js|jsx|py)$/i.test(p));
    srcFiles.sort((a, b) => a.length - b.length);
    for (const file of srcFiles.slice(0, 5)) selected.add(file);

    if (!selected.has('README.md')) {
      const alt = paths.find((p) => p.toLowerCase().endsWith('readme.md'));
      if (alt) selected.add(alt);
    }

    return Array.from(selected);
  }

  private buildSummary(path: string, content: string): string {
    const lines = content.split(/\r?\n/).slice(0, 20).join('\n');
    return `Summary of ${path}:\n${lines}`;
  }

  private collectFrameworkSignals(pkg: Record<string, unknown>, frameworks: Set<string>) {
    const deps = {
      ...((pkg.dependencies ?? {}) as Record<string, string>),
      ...((pkg.devDependencies ?? {}) as Record<string, string>),
    };
    if (deps['@cloudflare/workers-types'] || deps['wrangler']) frameworks.add('cloudflare-worker');
    if (deps['@shadcn/ui'] || deps['shadcn-ui']) frameworks.add('shadcn/ui');
    if (deps['react']) frameworks.add('react');
  }

  private parseWranglerConfig(content: string, isJson: boolean) {
    if (isJson) {
      const withoutComments = content.replace(/\/\*[^]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
      return JSON.parse(withoutComments);
    }
    return parseToml(content);
  }

  private detectProjectType(paths: string[], wranglerConfig: any, languages: Set<string>): ProjectType {
    if (wranglerConfig) return 'cloudflare-worker';
    if (paths.some((p) => p === '.clasp.json' || p.endsWith('appsscript.json'))) return 'google-apps-script';
    if (languages.has('python')) return 'python';
    return 'unknown';
  }

  private async ensureAgentFile(repo: string, analysis: RepositoryAnalysisResult, payload: RepositorySetupPayload): Promise<CommitFile | null> {
    const template = await this.lookupTemplate(analysis, 'agent_template');
    const mcpGuidance = await this.fetchMcpGuidance(analysis);
    const desired = this.renderAgentsMd(analysis, template, mcpGuidance);

    if (!analysis.existingAgents) {
      await this.logAction(repo, payload.eventType, 'generate_agents_md', 'success', { created: true });
      return { path: 'AGENTS.md', content: desired };
    }

    if (analysis.existingAgents !== desired) {
      await this.logAction(repo, payload.eventType, 'update_agents_md', 'success', { updated: true });
      return { path: 'AGENTS.md', content: desired };
    }

    await this.logAction(repo, payload.eventType, 'update_agents_md', 'skipped', { reason: 'No changes' });
    return null;
  }

  private async ensureStyleGuide(repo: string, analysis: RepositoryAnalysisResult, payload: RepositorySetupPayload): Promise<CommitFile | null> {
    const template = await this.lookupTemplate(analysis, 'style_template');
    const mcpGuidance = await this.fetchMcpGuidance(analysis);
    const desired = this.renderStyleGuide(analysis, template, mcpGuidance);

    if (!analysis.existingStyle) {
      await this.logAction(repo, payload.eventType, 'generate_style_guide', 'success', { created: true });
      return { path: 'STYLE_GUIDE.md', content: desired };
    }

    if (analysis.existingStyle !== desired) {
      await this.logAction(repo, payload.eventType, 'update_style_guide', 'success', { updated: true });
      return { path: 'STYLE_GUIDE.md', content: desired };
    }

    await this.logAction(repo, payload.eventType, 'update_style_guide', 'skipped', { reason: 'No changes' });
    return null;
  }

  private async enforceStandardization(repo: string, analysis: RepositoryAnalysisResult, token: string): Promise<CommitFile[]> {
    const files: CommitFile[] = [];
    if (analysis.projectType === 'cloudflare-worker' && analysis.wranglerConfig && analysis.wranglerPath) {
      const updatedWrangler = await this.ensureWranglerBindings(repo, analysis);
      if (updatedWrangler) files.push({ path: analysis.wranglerPath, content: updatedWrangler });
      const pkgUpdate = await this.ensurePackageScripts(repo, analysis);
      if (pkgUpdate) files.push(pkgUpdate);
    }

    if (analysis.projectType === 'python') {
      const requirements = await this.ensureRequirements(repo, token, analysis);
      if (requirements) files.push(requirements);
      const setupScript = await this.ensurePythonSetupScript(repo, token, analysis);
      if (setupScript) files.push(setupScript);
    }

    if (analysis.projectType === 'google-apps-script') {
      const clasp = await this.ensureClaspConfig(repo, token, analysis);
      if (clasp) files.push(clasp);
    }

    return files;
  }

  private async ensureWranglerBindings(repo: string, analysis: RepositoryAnalysisResult): Promise<string | null> {
    if (!analysis.wranglerConfig) return null;

    const config = JSON.parse(JSON.stringify(analysis.wranglerConfig));
    if (!config.observability) config.observability = {};
    if (config.observability.enabled !== true) {
      config.observability.enabled = true;
    }

    const bindings = this.extractBindings(config);
    const ensured: Record<string, string | null> = {};
    for (const binding of bindings) {
      ensured[binding.name] = await this.ensureBindingExists(binding.type, binding.name);
    }

    const serialized = analysis.wranglerPath?.endsWith('.jsonc')
      ? `${JSON.stringify(config, null, 2)}\n`
      : `${stringifyToml(config)}\n`;

    await this.logAction(repo, 'repository_setup', 'ensure_wrangler_bindings', 'success', {
      ensured,
    });

    return serialized;
  }

  private extractBindings(config: any): Array<{ type: string; name: string }> {
    const bindings: Array<{ type: string; name: string }> = [];
    if (Array.isArray(config.kv_namespaces)) {
      for (const kv of config.kv_namespaces) {
        if (kv.binding) bindings.push({ type: 'KV', name: kv.binding });
      }
    }
    if (Array.isArray(config.d1_databases)) {
      for (const d1 of config.d1_databases) {
        if (d1.binding) bindings.push({ type: 'D1', name: d1.binding });
      }
    }
    if (Array.isArray(config.r2_buckets)) {
      for (const r2 of config.r2_buckets) {
        if (r2.binding) bindings.push({ type: 'R2', name: r2.binding });
      }
    }
    if (Array.isArray(config.queues?.producers)) {
      for (const q of config.queues.producers) {
        if (q.binding) bindings.push({ type: 'QUEUE', name: q.binding });
      }
    }
    return bindings;
  }

  private async ensureBindingExists(type: string, name: string): Promise<string | null> {
    const url = this.env.CF_BINDINGS_MCP_URL ?? DEFAULT_BINDINGS_MCP;
    const payload = {
      accountId: this.env.CF_ACCOUNT_ID,
      apiToken: this.env.CF_API_TOKEN,
      bindingType: type,
      bindingName: name,
    };

    try {
      const verify = await fetch(`${url}/bindings/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (verify.ok) {
        const data = await verify.json();
        return data?.bindingId ?? null;
      }
      if (verify.status === 404) {
        const create = await fetch(`${url}/bindings/create`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (create.ok) {
          const data = await create.json();
          return data?.bindingId ?? null;
        }
      }
    } catch (error) {
      console.warn('[REPO_SETUP] Failed to verify binding', { type, name, error });
    }

    return null;
  }

  private async ensurePackageScripts(repo: string, analysis: RepositoryAnalysisResult): Promise<CommitFile | null> {
    if (!analysis.packageJson) return null;
    const pkg = JSON.parse(JSON.stringify(analysis.packageJson));
    if (!pkg.scripts) pkg.scripts = {};
    const scripts = pkg.scripts as Record<string, string>;
    const required: Record<string, string> = {
      build: 'wrangler build',
      deploy: 'wrangler deploy',
      'migrate:remote': 'wrangler d1 migrations apply DB --remote',
      'migrate:local': 'wrangler d1 migrations apply DB --local',
    };
    const added: string[] = [];
    for (const [key, value] of Object.entries(required)) {
      if (!scripts[key]) {
        scripts[key] = value;
        added.push(key);
      }
    }

    if (!added.length) return null;

    await this.logAction(repo, 'repository_setup', 'ensure_package_scripts', 'success', { added });

    return {
      path: 'package.json',
      content: `${JSON.stringify(pkg, null, 2)}\n`,
    };
  }

  private async ensureRequirements(repo: string, token: string, analysis: RepositoryAnalysisResult): Promise<CommitFile | null> {
    const [owner, repoName] = repo.split('/');
    const existing = await getFileAtRef(token, owner, repoName, 'requirements.txt', analysis.defaultBranch);
    if (existing) return null;

    const imports = new Set<string>();
    for (const [path, summary] of Object.entries(analysis.summaries)) {
      if (path.endsWith('.py')) {
        const importRegex = /^(?:from\s+([a-zA-Z0-9_.]+)|import\s+([a-zA-Z0-9_.]+))/gm;
        for (const match of summary.matchAll(importRegex)) {
          const name = (match[1] || match[2]).split('.')[0];
          if (name && !['os', 'sys', 'typing'].includes(name)) imports.add(name);
        }
      }
    }

    if (!imports.size) return null;

    const content = `${Array.from(imports).join('\n')}\n`;
    await this.logAction(repo, 'repository_setup', 'generate_requirements', 'success', {
      packages: Array.from(imports),
    });
    return { path: 'requirements.txt', content };
  }

  private async ensurePythonSetupScript(repo: string, token: string, analysis: RepositoryAnalysisResult): Promise<CommitFile | null> {
    const [owner, repoName] = repo.split('/');
    const existing = await getFileAtRef(token, owner, repoName, 'scripts/setup.sh', analysis.defaultBranch);
    if (existing) return null;
    const script = `#!/usr/bin/env bash\nset -euo pipefail\npython3 -m venv .venv\nsource .venv/bin/activate\npip install -r requirements.txt\n`;
    await this.logAction(repo, 'repository_setup', 'ensure_python_setup', 'success', {});
    return { path: 'scripts/setup.sh', content: script };
  }

  private async ensureClaspConfig(repo: string, token: string, analysis: RepositoryAnalysisResult): Promise<CommitFile | null> {
    const [owner, repoName] = repo.split('/');
    const existing = await getFileAtRef(token, owner, repoName, '.clasp.json', analysis.defaultBranch);
    if (existing) return null;
    const content = `${JSON.stringify({ scriptId: '', rootDir: 'src' }, null, 2)}\n`;
    await this.logAction(repo, 'repository_setup', 'ensure_clasp', 'success', {});
    return { path: '.clasp.json', content };
  }

  private async createPullRequest(client: GitHubClient, payload: RepositorySetupPayload, baseBranch: string, files: CommitFile[]): Promise<void> {
    const target = { owner: payload.owner, repo: payload.repo } as const;
    const branch = `auto/repo-setup-${formatTimestamp()}`;
    await ensureBranchExists(client, target, branch, baseBranch);
    await ensurePullRequestWithCommit({
      client,
      target,
      baseBranch,
      branch,
      commitMessage: 'chore(repo): bootstrap configuration',
      files,
      prBody: this.buildPrBody(files),
    });
  }

  private buildPrBody(files: CommitFile[]): string {
    const lines = files.map((file) => `- ${file.path}`);
    return ['## Repository setup automation', '', 'The following files were created or updated automatically:', ...lines].join('\n');
  }

  private async lookupTemplate(analysis: RepositoryAnalysisResult, field: 'agent_template' | 'style_template'): Promise<string | null> {
    let query = `SELECT ${field} as template FROM repo_guidance_templates WHERE 1=1`;
    const params: string[] = [];

    if (analysis.languages.length) {
      query += ` AND (language IS NULL OR language IN (${analysis.languages.map(() => '?').join(',')}))`;
      params.push(...analysis.languages);
    } else {
      query += ' AND language IS NULL';
    }

    if (analysis.frameworks.length) {
      query += ` AND (infrastructure IS NULL OR infrastructure IN (${analysis.frameworks.map(() => '?').join(',')}))`;
      params.push(...analysis.frameworks);
    } else {
      query += ' AND infrastructure IS NULL';
    }

    query += ' ORDER BY id LIMIT 1';

    try {
      const row = await this.env.DB.prepare(query).bind(...params).first<{ template: string }>();
      return row?.template ?? null;
    } catch (error) {
      console.warn('[REPO_SETUP] Failed to lookup template', error);
      return null;
    }
  }

  private renderAgentsMd(analysis: RepositoryAnalysisResult, template: string | null, mcpGuidance: string): string {
    const base = template ?? `# Agent Instructions\n\n## Project Overview\n${analysis.summaries['README.md'] ?? 'No README detected.'}`;
    const sections = [base.trim(), '', '## Key Files'];
    for (const [path, summary] of Object.entries(analysis.summaries)) {
      sections.push(`### ${path}`, summary);
    }
    if (mcpGuidance) {
      sections.push('', '## MCP Guidance', mcpGuidance);
    }
    return sections.join('\n');
  }

  private renderStyleGuide(analysis: RepositoryAnalysisResult, template: string | null, mcpGuidance: string): string {
    const base = template ?? `# Style Guide\n\nThis guide is generated from automated analysis.`;
    const sections = [base.trim(), '', '## Languages', analysis.languages.join(', ') || 'Not detected'];
    if (analysis.frameworks.length) {
      sections.push('', '## Frameworks', analysis.frameworks.join(', '));
    }
    if (mcpGuidance) {
      sections.push('', '## Cloudflare Guidance', mcpGuidance);
    }
    return sections.join('\n');
  }

  private async fetchMcpGuidance(analysis: RepositoryAnalysisResult): Promise<string> {
    if (!analysis.frameworks.includes('cloudflare-worker')) return '';
    try {
      const response = await fetch('https://docs.mcp.cloudflare.com/sse?query=cloudflare+worker+best+practices');
      if (!response.ok) return '';
      const text = await response.text();
      return text.slice(0, 500);
    } catch (error) {
      console.warn('[REPO_SETUP] Failed to fetch MCP guidance', error);
      return '';
    }
  }

  private async logAction(repo: string, eventType: string, action: string, status: string, details?: Record<string, unknown>) {
    console.log('[REPO_SETUP]', { repo, eventType, action, status, details });
    try {
      await this.env.DB.prepare(
        `INSERT INTO repo_setup_logs (repo, event_type, action, status, details_json) VALUES (?,?,?,?,?)`
      )
        .bind(repo, eventType, action, status, details ? JSON.stringify(details) : null)
        .run();
    } catch (error) {
      console.warn('[REPO_SETUP] Failed to log action', error);
    }
  }
}
