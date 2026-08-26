import { describe, expect, it } from 'vitest'
import { SCALES_NOW, SCALES_OBSERVED } from '../public/scales-source.js'
import { NOAA_SCALE_RANGES, SCALES_BASE } from '../src/paths.js'
import { transformJsonScaleRange } from '../src/parse.js'
import { SCALES_FIXTURES, fixtureJson } from './fixtures.js'

/** The Signal K path a webapp constant names, in the dotted form the plugin
 * publishes on. */
const dotted = (webappPath: string) => webappPath.replace(/\//g, '.') + '.'

/** Every G/S/R level the plugin publishes under `base` for one payload. */
function levelsAt(
  json: Record<string, unknown>,
  base: string
): Record<string, number> {
  const range = NOAA_SCALE_RANGES.find((r) => SCALES_BASE + r.subPath === base)
  if (!range) throw new Error(`no NOAA range publishes ${base}`)
  const values = transformJsonScaleRange(
    json[range.jsonIndex],
    base,
    range.isObservation
  )
  return Object.fromEntries(
    ['G', 'S', 'R'].map((letter) => [
      letter,
      values.find((v) => v.path === `${base}.${letter}`)?.value as number
    ])
  )
}

const worst = (levels: Record<string, number>) =>
  Math.max(...Object.values(levels))

describe('the observed reading the G/S/R badges draw', () => {
  it('is a path the plugin actually publishes', () => {
    const published = NOAA_SCALE_RANGES.map(
      (r) => SCALES_BASE + r.subPath + '.'
    )
    expect(published).toContain(dotted(SCALES_OBSERVED))
    expect(published).toContain(dotted(SCALES_NOW))
  })

  // The whole of issue #120. NOAA's instantaneous sample is 0 in every payload
  // we have ever captured, including a day whose 24-hour maximum was G4 and
  // the day a live R2 was reported -- so a badge wired to it is not merely
  // less useful than the maximum, it has never once shown a storm.
  it('carries the storm the instantaneous reading misses', () => {
    let stormsShown = 0
    for (const name of SCALES_FIXTURES) {
      const json = fixtureJson(name)
      const now = levelsAt(json, dotted(SCALES_NOW).slice(0, -1))
      const badge = levelsAt(json, dotted(SCALES_OBSERVED).slice(0, -1))
      expect(worst(now)).toBe(0)
      expect(worst(badge)).toBeGreaterThanOrEqual(worst(now))
      if (worst(badge) > 0) stormsShown++
    }
    expect(stormsShown).toBeGreaterThan(0)
  })

  it('reports the R2 that was live when #120 was filed', () => {
    const json = fixtureJson('noaa-scales.2026_08_25.json')
    expect(levelsAt(json, dotted(SCALES_OBSERVED).slice(0, -1)).R).toBe(2)
    expect(levelsAt(json, dotted(SCALES_NOW).slice(0, -1)).R).toBe(0)
  })
})
