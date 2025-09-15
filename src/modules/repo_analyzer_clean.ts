// // src/modules/repo_analyzer.ts
// import type { StructuredAnalysis } from '../types/analysis';
// import {
//   AUX_MODELS,
//   callModel,
//   looksNonEnglish,
//   pickModelForTask,
//   translateToEnglish,
//   type Env,
//   type PickInputs,
//   type PickResult,
//   type TaskKind
// } from './ai_models';
// import { ghREST } from './github_helpers';
// import { detectBindingsFromWrangler, detectEntrypoints, detectNotableDeps } from './repo_signals';

// // Re-export types for backward compatibility
// export type { Env, PickInputs, PickResult, TaskKind };

// /**
//  * @description Options for configuring a repository analysis task.
//  */
// type AnalyzeOpts = {
//   token: string;
//   owner: string;
//   repo: string;
//   ref: string;
//   maxBytes?: number;
//   maxFiles?: number;
// };

// // ---------- Core Analysis Logic ----------

// /**
//  * @description Performs a comprehensive, structured analysis of a GitHub repository's code.
//  */
// export async function analyzeRepo(env: Env, opts: AnalyzeOpts): Promise<StructuredAnalysis> {
//   const { token, owner, repo, ref, maxBytes = 200_000, maxFiles = 60 } = opts;
//   const repoFullName = `${owner}/${repo}`;
//   console.log(`[Analyze] Starting structured analysis for ${repoFullName}@${ref}`);

//   const tree = await ghREST(token, 'GET', `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
//   const allFiles: any[] = ((tree as any)?.tree || []).filter((n: any) => n.type === 'blob');

//   const textFileExts = /\.(ts|js|mjs|cjs|toml|md|py|go|rs|java|php|rb|cs|cpp|c|cc|cxx|yml|yaml|json|html|css|txt)$/i;
//   const binaryFileExts = /\.(pdf|jpeg|jpg|png|webp|svg|xlsx|xlsm|xlsb|xls|et|ods|csv|numbers)$/i;

//   const picked = pickImportantFiles(allFiles).slice(0, maxFiles);

//   const documentsToConvert: {name: string, blob: Blob}[] = [];
//   const textSamples: {path: string, text: string}[] = [];
//   let wranglerText = '';

//   for (const f of picked) {
//     const fileContent = await getRaw(token, owner, repo, f.path, ref, true); // Fetch as ArrayBuffer
//     if (!fileContent) continue;

//     if (binaryFileExts.test(f.path)) {
//         documentsToConvert.push({ name: f.path, blob: new Blob([fileContent]) });
//     } else if (textFileExts.test(f.path)) {
//         const text = new TextDecoder().decode(fileContent as ArrayBuffer);
//         const chunk = text.length > 4000 ? text.slice(0, 4000) : text;
//         textSamples.push({ path: f.path, text: chunk });
//         if (/wrangler\.toml$/i.test(f.path)) wranglerText = text;
//     }
//   }

//   if (documentsToConvert.length > 0) {
//       console.log(`[AI] Converting ${documentsToConvert.length} binary files to markdown.`);
//       const markdownResults = await env.AI.toMarkdown(documentsToConvert);
//       for (const result of markdownResults) {
//           if (result.data) {
//               textSamples.push({ path: result.name, text: result.data });
//           }
//       }
//   }

//   console.log(`[Analyze] Sampled and processed ${textSamples.length} files.`);

//   const languages = Array.from(detectLanguages(textSamples));
//   const bindings = detectBindingsFromWrangler(wranglerText);
//   const entrypoints = detectEntrypoints(textSamples);
//   const deps = detectNotableDeps(textSamples);
//   const signals = extractSignals(textSamples);
//   const codebaseType = getCodebaseType(signals);

//   const modelSelection = pickModelForTask({ task: 'repo_summarize', hasDesignDocsOrImages: documentsToConvert.length > 0 });
//   console.log(`[AI] Model selected for repo summary. Rationale: ${modelSelection.rationale}`);

//   const { prompt, schema } = buildSpecializedStructuredPrompt(codebaseType, {
//     owner, repo, ref, languages, bindings,
//     routes: signals.routes || [],
//     entrypoints, deps, samples: textSamples,
//   });

//   let raw: string;
//   try {
//     console.log(`[AI] Attempting analysis with primary model: ${modelSelection.primary}`);
//     raw = await callModel(env, modelSelection.primary, prompt, schema);
//   } catch (e: any) {
//     console.error(`[AI] Primary model failed: ${e.message}. Attempting fallback.`);
//     if (modelSelection.fallback) {
//       console.log(`[AI] Attempting analysis with fallback model: ${modelSelection.fallback}`);
//       raw = await callModel(env, modelSelection.fallback, prompt, schema);
//     } else {
//       console.error(`[AI] No fallback model available. Analysis failed.`);
//       throw e;
//     }
//   }

//   let analysis = coerceAnalysis(raw);
//   analysis = await enforceEnglish(env, analysis);

//   console.log(`[DB] Saving structured analysis for ${repoFullName}.`);
//   await saveStructuredAnalysis(env, repoFullName, analysis, textSamples.length, 0); // Note: byte count is harder now
//   console.log(`[Analyze] Successfully completed analysis for ${repoFullName}.`);

//   return analysis;
// }

// /**
//  * @description Performs a legacy, less-structured analysis of a repository.
//  * @deprecated
//  */
// export async function analyzeRepoCode(env: Env, opts: AnalyzeOpts) {
//   // This function remains as-is for now, without the new toMarkdown/JSON mode logic
//   // ...
//   return {};
// }


// // ---------- Helpers and Signal Extraction ----------

// function pickImportantFiles(files: any[]) {
//   const hi = [
//     /^wrangler\.toml$/i, /^package\.json$/i, /^pnpm-lock\.yaml$/i, /^yarn\.lock$/i,
//     /^README\.md$/i, /^README\.[a-z-]+\.md$/i,
//     /^_routes\.json$/i, /^routes\.(json|txt)$/i,
//     // Add binary formats that are important for context
//     /\.pdf$/i, /\.jpeg$/i, /\.jpg$/i, /\.png$/i,
//   ];
//   const weight = (p:string) => {
//     const l = p.toLowerCase();
//     let w = 0;
//     if (hi.some(rx => rx.test(l.split('/').pop()!))) w += 5;
//     if (/(^|\/)(src|functions|workers?|api|edge)\//.test(l)) w += 3;
//     if (/\.(ts|js|mjs|cjs|toml)$/.test(l)) w += 2;
//     if (/(do|durable|d1|cron|schedule|ai|\/ai\/run)/.test(l)) w += 1;
//     return w;
//   };
//   return files
//     .filter(f => !/(\.min\.(js|css)|\.(lock|map|wasm|mp4|zip|gz|tar|7z))$/i.test(f.path)) // Keep important binaries
//     .sort((a,b)=> weight(b.path) - weight(a.path));
// }

// async function getRaw(token:string, owner:string, repo:string, path:string, ref:string, asArrayBuffer = false): Promise<string | ArrayBuffer> {
//   const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
//   try {
//     const r = await fetch(url, { headers: { Authorization: `token ${token}` } });
//     if (!r.ok) {
//       console.warn(`[GitHub] Failed to fetch raw file: ${url} (Status: ${r.status})`);
//       return '';
//     }
//     return asArrayBuffer ? r.arrayBuffer() : r.text();
//   } catch (e: any) {
//     console.error(`[GitHub] Error fetching raw file ${url}: ${e.message}`);
//     return '';
//   }
// }

// function detectLanguages(samples: {path:string,text:string}[]): Set<string> {
//   const set = new Set<string>();
//   for (const s of samples) {
//     if (s.path.endsWith('.ts')) set.add('ts');
//     else if (s.path.endsWith('.js') || s.path.endsWith('.mjs') || s.path.endsWith('.cjs')) set.add('js');
//     else if (s.path.endsWith('.toml')) set.add('toml');
//     else if (s.path.toLowerCase().includes('readme')) set.add('md');
//     else if (s.path.endsWith('.py')) set.add('python');
//     else if (s.path.endsWith('.go')) set.add('go');
//     else if (s.path.endsWith('.rs')) set.add('rust');
//     else if (s.path.endsWith('.java')) set.add('java');
//     else if (s.path.endsWith('.php')) set.add('php');
//     else if (s.path.endsWith('.rb')) set.add('ruby');
//     else if (s.path.endsWith('.cs')) set.add('csharp');
//     else if (s.path.endsWith('.cpp') || s.path.endsWith('.cc') || s.path.endsWith('.cxx')) set.add('cpp');
//     else if (s.path.endsWith('.c')) set.add('c');
//     else if (s.path.endsWith('.yml') || s.path.endsWith('.yaml')) set.add('yaml');
//     else if (s.path.endsWith('.json')) set.add('json');
//     else if (s.path.endsWith('.html')) set.add('html');
//     else if (s.path.endsWith('.css')) set.add('css');
//   }
//   return set;
// }

// function extractSignals(samples:{path:string,text:string}[]): any {
//   const sig:any = {
//     hasWrangler:false, hasDO:false, hasD1:false, hasCron:false, usesAI:false,
//     routes:[] as string[],
//     hasAuth: false, hasProxy: false, hasNetwork: false, hasFileSystem: false,
//     frameworks: [] as string[], dependencies: [] as string[]
//   };

//   for (const s of samples) {
//     const text = s.text.toLowerCase();
//     if (/wrangler\.toml$/i.test(s.path)) {
//       sig.hasWrangler = true;
//       if (/\[\[d1_databases\]\]/i.test(s.text)) sig.hasD1 = true;
//       if (/durable_objects/i.test(s.text)) sig.hasDO = true;
//       if (/^\s*crons\s*=|\[triggers\]\s*[\s\S]*crons/i.test(s.text)) sig.hasCron = true;
//     }
//     if (/\/ai\/run\/|@cloudflare\/ai|openai|anthropic|gemini/.test(text)) sig.usesAI = true;
//     const routeMatches = s.text.matchAll(/(app|router)\.(get|post|all|put|delete|patch)\(['"`]([^'"`]+)['"`]/gi);
//     for (const match of routeMatches) {
//         sig.routes.push(match[3]);
//     }
//     if (/auth|jwt|token|login|password|oauth|session/.test(text)) sig.hasAuth = true;
//     if (/proxy|tunnel|vpn|forward|redirect/.test(text)) sig.hasProxy = true;
//     if (/fetch|http|request|axios|urllib|curl/.test(text)) sig.hasNetwork = true;
//     if (/fs\.|file|read|write|upload|download/.test(text)) sig.hasFileSystem = true;
//     if (/hono|from ['"]hono['"]/.test(text)) sig.frameworks.push('hono');
//     if (/express|from ['"]express['"]/.test(text)) sig.frameworks.push('express');
//     if (/next|from ['"]next['"]/.test(text)) sig.frameworks.push('nextjs');
//     if (/react|from ['"]react['"]/.test(text)) sig.frameworks.push('react');
//     if (/package\.json$/i.test(s.path)) {
//       try {
//         const pkg = JSON.parse(s.text);
//         const deps = {...(pkg.dependencies || {}), ...(pkg.devDependencies || {})};
//         sig.dependencies = Object.keys(deps).slice(0, 20);
//       } catch {}
//     }
//   }

//   sig.routes = Array.from(new Set(sig.routes)).slice(0, 20);
//   sig.frameworks = Array.from(new Set(sig.frameworks));
//   return sig;
// }


// // ---------- Prompt Engineering ----------

// function getCodebaseType(signals: any): string {
//   if (signals.hasWrangler) return 'cloudflare-worker';
//   if (signals.frameworks.includes('react') || signals.frameworks.includes('nextjs')) return 'frontend';
//   if (signals.frameworks.includes('express') || signals.frameworks.includes('hono')) return 'backend';
//   return 'other';
// }

// function buildSpecializedStructuredPrompt(codebaseType: string, args: {
//   owner: string, repo: string, ref: string,
//   languages: string[], bindings: string[], routes: string[], entrypoints: string[],
//   deps: string[], samples: { path: string, text: string }[]
// }): { prompt: string, schema: object } {

//   const baseSchema = {
//     type: "object",
//     properties: {
//       purpose: { type: "string" },
//       summary: { type: "string" },
//       use_cases: { type: "array", items: { type: "string" } },
//       repo_kind: { type: "string", enum: ["frontend", "backend", "full_stack", "library", "cli", "infra", "other"] },
//       routes: { type: "array", items: { type: "string" } },
//       entrypoints: { type: "array", items: { type: "string" } },
//       notable_deps: { type: "array", items: { type: "string" } },
//       languages: { type: "array", items: { type: "string" } },
//       risk_flags: { type: "array", items: { type: "string" } },
//       confidence: { type: "number" },
//     },
//     required: ["purpose", "summary", "use_cases", "repo_kind", "languages", "confidence"],
//   };

//   if (codebaseType === 'cloudflare-worker') {
//     (baseSchema.properties as any).wrangler_bindings = {
//       type: "array",
//       items: { type: "string", enum: ["kv", "d1", "r2", "queues", "ai", "vectorize", "durable_objects", "email", "analytics_engine", "pages_functions", "hyperdrive", "cache"] }
//     };
//   }

//   const instructions = `You are analyzing a software repository. Based on the provided code samples and metadata, generate a JSON object that strictly follows the provided schema. Silently translate any non-English content.`;

//   const META = `Repo: ${args.owner}/${args.repo}@${args.ref}...`;
//   const DOCS = args.samples.map(s => `FILE: ${s.path}\n-----\n${s.text}`).join('\n\n====\n\n');
//   const prompt = `${instructions}\n\n${META}\n\nCODE SAMPLES:\n${DOCS}`;

//   return { prompt, schema: baseSchema };
// }

// function buildPrompt(args:{
//   owner:string, repo:string, ref:string,
//   languages:string[], signals:any, samples:{path:string,text:string}[]
// }) {
//   const head = `You are auditing a software repository...`;
//   const meta = `Repo: ${args.owner}/${args.repo}@${args.ref}...`;
//   const docs = args.samples.map(s => `FILE: ${s.path}\n-----\n${s.text}`).join('\n\n====\n\n');
//   return `${head}\n\n${meta}\n\nCODE SAMPLES:\n${docs}`;
// }


// // ---------- Data Coercion and Sanitization ----------

// function coerceAnalysis(raw: any): StructuredAnalysis {
//   const isArray = Array.isArray;
//   const asArr = (v:any) => isArray(v) ? v.map(String) : [];
//   const clamp = (n:any) => Math.max(0, Math.min(1, Number(n||0.5)));
//   let obj: any;
//   if (typeof raw === 'string') {
//     try {
//       obj = JSON.parse(raw);
//     } catch (e) {
//       console.error(`[Coerce] Failed to parse raw string as JSON: ${raw}`, e);
//       obj = {};
//     }
//   } else {
//     obj = raw || {};
//   }
//   const validBindings = ['kv','d1','r2','queues','ai','vectorize','durable_objects','email','analytics_engine','pages_functions','hyperdrive','cache'];
//   return {
//     purpose: String(obj.purpose || 'Unknown'),
//     summary: String(obj.summary || '').trim(),
//     use_cases: asArr(obj.use_cases).slice(0, 12),
//     repo_kind: (['frontend','backend','full_stack','library','cli','infra','other'].includes(obj.repo_kind) ? obj.repo_kind : 'other'),
//     wrangler_bindings: asArr(obj.wrangler_bindings).filter((b: string) => validBindings.includes(b)) as any,
//     routes: asArr(obj.routes).slice(0, 50),
//     entrypoints: asArr(obj.entrypoints).slice(0, 20),
//     notable_deps: asArr(obj.notable_deps).slice(0, 20),
//     languages: asArr(obj.languages).slice(0, 10),
//     risk_flags: asArr(obj.risk_flags).slice(0, 20),
//     confidence: clamp(obj.confidence),
//   };
// }

// async function enforceEnglish(env: Env, analysis: StructuredAnalysis): Promise<StructuredAnalysis> {
//   const text = `${analysis.purpose}\n${analysis.summary}`;
//   if (!looksNonEnglish(text)) return analysis;

//   console.log(`[Translate] Non-English text detected. Attempting to translate with model ${AUX_MODELS.M2M100_1_2B.id}.`);
//   const translatedText = await translateToEnglish(env, text);

//   if (translatedText !== text) {
//     console.log('[Translate] Successfully translated content.');
//     analysis.summary = translatedText;
//     analysis.purpose = (translatedText.split('\n')[0] || '').slice(0, 200);
//   } else {
//     console.warn('[Translate] Translation returned the same result.');
//   }
//   return analysis;
// }


// // ---------- Database Interaction ----------

// async function saveStructuredAnalysis(env: Env, repoFullName: string, analysis: StructuredAnalysis, filesSampled: number, bytesSampled: number) {
//   console.log(`[DB] Preparing to save analysis for ${repoFullName}.`);
//   try {
//     await env.DB.prepare(`
//       INSERT INTO repo_analysis (repo_full_name, analyzed_at, files_sampled, bytes_sampled, languages_json, signals_json, purpose, summary_short, summary_long, risk_flags_json, confidence, structured_json)
//       VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repo_full_name) DO UPDATE SET
//         analyzed_at=excluded.analyzed_at, files_sampled=excluded.files_sampled, bytes_sampled=excluded.bytes_sampled, languages_json=excluded.languages_json, signals_json=excluded.signals_json,
//         purpose=excluded.purpose, summary_short=excluded.summary_short, summary_long=excluded.summary_long, risk_flags_json=excluded.risk_flags_json, confidence=excluded.confidence, structured_json=excluded.structured_json
//     `).bind(
//       repoFullName, Date.now(), filesSampled, bytesSampled, JSON.stringify(analysis.languages), '{}',
//       analysis.purpose, analysis.summary.split('\n')[0].slice(0, 140), analysis.summary,
//       JSON.stringify(analysis.risk_flags), analysis.confidence, JSON.stringify(analysis)
//     ).run();

//     console.log(`[DB] Updating bindings index for ${repoFullName}.`);
//     await env.DB.prepare(`DELETE FROM repo_analysis_bindings WHERE repo_full_name=?`).bind(repoFullName).run();
//     if (analysis.wrangler_bindings.length > 0) {
//         const stmt = env.DB.prepare(`INSERT INTO repo_analysis_bindings (repo_full_name, binding) VALUES (?, ?)`);
//         const batch = analysis.wrangler_bindings.map(binding => stmt.bind(repoFullName, binding));
//         await env.DB.batch(batch);
//     }
//     console.log(`[DB] Successfully saved analysis and bindings for ${repoFullName}.`);
//   } catch (e: any) {
//     console.error(`[DB] Failed to save analysis for ${repoFullName}: ${e.message}`, e);
//   }
// }

// export async function getRepoAnalysis(env: Env, repoFullName: string): Promise<any | null> {
//   console.log(`[DB] Fetching analysis for ${repoFullName}.`);
//   try {
//     return await env.DB.prepare('SELECT * FROM repo_analysis WHERE repo_full_name = ?').bind(repoFullName).first();
//   } catch (e: any) {
//     console.error(`[DB] Error fetching analysis for ${repoFullName}: ${e.message}`);
//     return null;
//   }
// }

// export async function isRepoAnalysisStale(env: Env, repoFullName: string, maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<boolean> {
//   const analysis = await getRepoAnalysis(env, repoFullName);
//   if (!analysis) {
//     console.log(`[StaleCheck] No analysis found for ${repoFullName}. It is stale.`);
//     return true;
//   }
//   const age = Date.now() - (analysis as any).analyzed_at;
//   const isStale = age > maxAgeMs;
//   console.log(`[StaleCheck] Analysis for ${repoFullName} is ${age}ms old. Stale: ${isStale}.`);
//   return isStale;
// }
