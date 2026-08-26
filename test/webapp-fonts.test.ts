import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * All five faces in public/index.html are embedded as data URIs -- a boat has
 * no internet, so there is no CDN fallback to fall back to. Oswald and Space
 * Mono used to ship their full character range; subsetting to the glyphs the
 * page actually uses cut most of that weight. Nothing short of decoding every
 * glyph in every request would catch a silent return to the full range, so
 * this pins a byte budget per face instead: comfortably above what a Latin
 * subset needs, comfortably below what an unsubset face weighs.
 */
describe('public/index.html embedded fonts', () => {
  const html = readFileSync(
    fileURLToPath(new URL('../public/index.html', import.meta.url)),
    'utf8'
  )

  const FACE_BYTE_BUDGET = 40_000

  const faces = [
    ...html.matchAll(
      /font-family: '([^']+)';\s*\n\s*src: url\(data:font\/\w+;base64,([A-Za-z0-9+/=]+)\)/g
    )
  ].map(([, name, base64]) => ({
    name,
    bytes: Math.floor((base64.length * 3) / 4)
  }))

  it('finds all five embedded faces', () => {
    expect(faces).toHaveLength(5)
  })

  it.each(faces.map((f) => [f.name, f.bytes] as const))(
    '%s stays under the byte budget (%i bytes)',
    (name, bytes) => {
      expect(bytes).toBeLessThan(FACE_BYTE_BUDGET)
    }
  )
})
