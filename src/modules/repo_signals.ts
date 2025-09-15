// src/modules/repo_signals.ts
import type { WranglerBinding } from '../types/analysis'

/**
 * Detects bindings from a Wrangler TOML configuration file.
 *
 * @param toml - The TOML configuration file as a string.
 * @returns An array of detected Wrangler bindings.
 */
export function detectBindingsFromWrangler(toml: string): WranglerBinding[] {
  const b = new Set<WranglerBinding>()
  if (/\[\[kv_namespaces\]\]/i.test(toml)) b.add('kv')
  if (/\[\[d1_databases\]\]/i.test(toml)) b.add('d1')
  if (/\[\[r2_buckets\]\]/i.test(toml)) b.add('r2')
  if (/\[\[queues\]\]|\[queues\]/i.test(toml)) b.add('queues')
  if (/\[ai\]|\@cloudflare\/ai|\/ai\/run\//i.test(toml)) b.add('ai')
  if (/\[vectorize\]/i.test(toml)) b.add('vectorize')
  if (/durable_objects/i.test(toml)) b.add('durable_objects')
  if (/\[email\]/i.test(toml)) b.add('email')
  if (/\[analytics_engine\]/i.test(toml)) b.add('analytics_engine')
  if (/\[pages\]/i.test(toml)) b.add('pages_functions')
  if (/\[hyperdrive\]/i.test(toml)) b.add('hyperdrive')
  if (/\bcaches?\b/i.test(toml)) b.add('cache')
  return Array.from(b)
}

/**
 * Detects entry points from a list of file samples.
 *
 * @param samples - An array of file samples, each containing a path and text content.
 * @returns An array of detected entry points.
 */
export function detectEntrypoints(samples: {path:string,text:string}[]): string[] {
  const entrypoints = new Set<string>()

  for (const s of samples) {
    const text = s.text.toLowerCase()
    const path = s.path.toLowerCase()

    // Common entry point patterns
    if (/index\.(ts|js|mjs)$/i.test(path) || /worker\.(ts|js|mjs)$/i.test(path)) {
      entrypoints.add(s.path)
    }

    // Files that export handlers
    if (/export\s+default\s+{/.test(s.text) || /export\s+default\s+class/.test(s.text)) {
      entrypoints.add(s.path)
    }

    // Files with handler patterns
    if (/\.on\(|addEventListener|\.get\(|\.post\(|fetch\s*\(/.test(text)) {
      entrypoints.add(s.path)
    }

    // Durable Object classes
    if (/class\s+\w+\s+{[\s\S]*fetch\s*\(/i.test(s.text)) {
      entrypoints.add(s.path)
    }
  }

  return Array.from(entrypoints).slice(0, 20)
}

export function detectNotableDeps(samples: {path:string,text:string}[]): string[] {
  const deps = new Set<string>()

  for (const s of samples) {
    if (/package\.json$/i.test(s.path)) {
      try {
        const pkg = JSON.parse(s.text)
        const allDeps = {...(pkg.dependencies || {}), ...(pkg.devDependencies || {})}

        // Filter for notable/behavioral deps
        Object.keys(allDeps).forEach(dep => {
          if (/^(@cloudflare|hono|itty-router|worktop|toucan-js|openai|anthropic|@anthropic-ai|postgres|mysql|redis|prisma|drizzle|kysely|zod|joi|express|fastify|koa)/.test(dep)) {
            deps.add(dep)
          }
        })
      } catch {}
    }
  }

  return Array.from(deps).slice(0, 20)
}
