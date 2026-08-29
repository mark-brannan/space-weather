import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `noaa/client.ts` is the only module allowed to touch the network -- see
 * CLAUDE.md. `test/endpoints.test.ts` pins that every path fetched through
 * the client is declared in `src/endpoints.ts` and measured by
 * `scripts/measure-noaa.mjs`; this is the other half, that nothing fetches
 * outside the client to route around that declaration in the first place.
 */
const srcDir = fileURLToPath(new URL('../src', import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

const sources = sourceFiles(srcDir).map((path) => ({
  path: path.slice(srcDir.length + 1),
  text: readFileSync(path, 'utf8')
}))

describe('every NOAA fetch goes through the client', () => {
  it('makes no outbound request outside the client', () => {
    const offenders = sources
      .filter(({ path }) => path !== 'noaa/client.ts')
      .filter(({ text }) => /(?<![.\w])fetch\s*\(/.test(text))
      .map(({ path }) => path)
    expect(offenders).toEqual([])
  })
})
