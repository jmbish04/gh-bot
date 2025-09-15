// src/types/analysis.ts
export type RepoKind = 'frontend' | 'backend' | 'full_stack' | 'library' | 'cli' | 'infra' | 'other'

export type WranglerBinding =
  | 'kv' | 'd1' | 'r2' | 'queues' | 'ai' | 'vectorize' | 'durable_objects'
  | 'email' | 'analytics_engine' | 'pages_functions' | 'hyperdrive' | 'cache'

export interface StructuredAnalysis {
  purpose: string                 // 1–2 sentences
  summary: string                 // 4–8 bullets or short paragraphs
  use_cases: string[]             // 3–8 items
  repo_kind: RepoKind             // enum
  wrangler_bindings: WranglerBinding[] // detected/declared
  routes: string[]                // URL paths or patterns if found
  entrypoints: string[]           // files that register handlers/DOs
  notable_deps: string[]          // top packages indicating behavior
  languages: string[]             // ['ts','js','toml',...]
  risk_flags: string[]            // e.g., ["proxy/vpn","abuse-risk"]
  confidence: number              // 0..1
}
