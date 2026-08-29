/**
 * The product modules, and the layer that drives them, must stay loadable in a
 * browser.
 *
 * The demo page (#239 leg 2) runs these same modules against NOAA directly,
 * with no server and no bundler: `tsc` already emits ES modules whose every
 * relative import carries a `.js` extension, which is exactly what a browser
 * resolves. Nothing has to be built for that to keep working -- but one
 * `import` of a Node builtin or an npm package anywhere in the closure ends
 * it, and the failure is invisible here. `src/cache/entryCache.ts` imported
 * `fs` and `path` until the store was made a parameter, and that alone took
 * the aurora, D-RAP and advisory products with it.
 *
 * So: walk the closure the way a browser would, and let a bare specifier fail
 * a test rather than a page. Type-only imports are written `import type` in
 * these files precisely so this walk sees the graph `tsc` emits rather than
 * the one the type-checker sees -- `publisher.ts` does still touch the
 * filesystem, and products still name its types.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'

const SRC = resolve(__dirname, '../src')

/** Paths are only ever reported, never resolved, so keep them POSIX-shaped:
 *  `relative` hands back backslashes on Windows and the CI runner is real. */
const rel = (file: string) => relative(SRC, file).split(sep).join('/')
const PRODUCTS = join(SRC, 'products')
const BROWSER = join(SRC, 'browser')

/** `import`/`export ... from '<specifier>'`, minus the type-only ones. */
const FROM =
  /(?:^|\n)\s*(?:import|export)\s+(?!type\s)([^'"\n]*)from\s*['"]([^'"]+)['"]/g

function closure(entries: string[]): {
  modules: Set<string>
  bare: Map<string, Set<string>>
} {
  const modules = new Set<string>()
  const bare = new Map<string, Set<string>>()
  const walk = (file: string): void => {
    if (modules.has(file)) return
    modules.add(file)
    const src = readFileSync(file, 'utf8')
    for (const [, clause, spec] of src.matchAll(FROM)) {
      // `import { type Foo }` inline is erased too; a clause that is nothing
      // but inline type members leaves no runtime import behind.
      const members = clause.match(/\{([^}]*)\}/)?.[1]
      if (members && members.split(',').every((m) => /^\s*type\s/.test(m)))
        continue
      if (!spec.startsWith('.')) {
        if (!bare.has(spec)) bare.set(spec, new Set())
        bare.get(spec)!.add(rel(file))
        continue
      }
      // The emitted specifier ends in .js; the source it names is .ts.
      walk(resolve(dirname(file), spec).replace(/\.js$/, '.ts'))
    }
  }
  entries.forEach(walk)
  return { modules, bare }
}

describe('the product closure loads in a browser', () => {
  // Every product, plus src/browser/ -- the demo's live data layer, whose
  // whole job is to run those products with no server under it. Walking it
  // from here is what keeps the layer honest: it imports the registry rather
  // than index.ts precisely because index.ts owns the filesystem, and nothing
  // but this test would notice that edge being added back.
  const entries = [
    ...readdirSync(PRODUCTS)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(PRODUCTS, f)),
    ...readdirSync(BROWSER)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(BROWSER, f))
  ]

  it('has every product to walk from', () => {
    expect(entries.length).toBeGreaterThan(10)
  })

  it('walks the live data layer too', () => {
    const { modules } = closure(entries)
    const names = [...modules].map(rel)
    expect(names).toContain('browser/live.ts')
    expect(names).toContain('browser/publisher.ts')
    // The registry is the seam that keeps index.ts -- the plugin lifecycle,
    // the HTTP routes, the tile renderer -- out of the browser's closure.
    expect(names).toContain('products/registry.ts')
    expect(names).not.toContain('index.ts')
    expect(names).not.toContain('tiles.ts')
  })

  it('imports nothing a browser cannot resolve', () => {
    const { bare } = closure(entries)
    // Named rather than counted: the failure message has to say which module
    // did it, or the next person gets "expected 1 to be 0".
    const offenders = [...bare].map(
      ([spec, files]) => `${spec} <- ${[...files].sort().join(', ')}`
    )
    expect(offenders).toEqual([])
  })

  it('keeps the filesystem out of the closure', () => {
    const { modules } = closure(entries)
    const names = [...modules].map(rel)
    // publisher.ts owns the filesystem now, and products name only its types.
    expect(names).not.toContain('publisher.ts')
    expect(names).toContain('cache/entryCache.ts')
  })
})
