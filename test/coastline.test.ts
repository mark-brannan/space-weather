import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { coastlineRings, drawCoastline } from '../public/geo.js'

/**
 * Records what a canvas would have drawn. Only the path calls matter: whether
 * the pen was down between two points is the whole question here.
 */
function recordingContext() {
  const segments: [number, number][][] = []
  let pen: [number, number] | null = null
  return {
    segments,
    save() {},
    restore() {},
    beginPath() {
      pen = null
    },
    stroke() {},
    moveTo(x: number, y: number) {
      pen = [x, y]
    },
    lineTo(x: number, y: number) {
      if (pen) segments.push([pen, [x, y]])
      pen = [x, y]
    }
  }
}

describe('the coastline asset', () => {
  const rings = coastlineRings()

  const source = readFileSync(
    fileURLToPath(new URL('../data/ne_50m_coastline.geojson', import.meta.url))
  )

  it('is Natural Earth v5.1.2 50m, byte for byte', () => {
    // The pin scripts/sync-coastline.mjs checks at build. Swapping in 10m
    // or a newer release is a choice to measure parse and draw on a Pi
    // again (issue #44), not a file to drop in.
    expect(createHash('sha256').update(source).digest('hex')).toBe(
      '271f1c4c1908312bac6b29d158ea1356544beafc129f260005300913aa5ea283'
    )
  })

  it('ships the published file unmodified', () => {
    const asset = readFileSync(
      fileURLToPath(new URL('../public/coastline.js', import.meta.url)),
      'utf8'
    )
    expect(asset).toContain(`export default ${source.toString('utf8').trim()}`)
  })

  it('keeps every line Natural Earth publishes', () => {
    // Nothing simplified, no island dropped: the count the 50m file has.
    expect(rings.length).toBe(1429)
    expect(rings.reduce((n, ring) => n + ring.length, 0)).toBe(60416)
  })

  it('flattens to whole rings of plottable coordinates', () => {
    for (const ring of rings) {
      expect(ring.length).toBeGreaterThanOrEqual(2)
      for (const [lon, lat] of ring) {
        expect(lon).toBeGreaterThanOrEqual(-180)
        expect(lon).toBeLessThanOrEqual(180)
        expect(lat).toBeGreaterThanOrEqual(-90)
        expect(lat).toBeLessThanOrEqual(90)
      }
    }
  })
})

describe('drawCoastline', () => {
  const width = 800
  const project = (lonCenter: number) => ({
    x: (lon: number) => {
      let d = lon - lonCenter
      if (d > 180) d -= 360
      if (d < -180) d += 360
      return width / 2 + (d / 180) * (width / 2)
    },
    y: (lat: number) => 160 - lat
  })

  // A window centred on Greenwich meets the seam at the antimeridian; one
  // centred near Fiji meets it at Greenwich. Both have to survive it, and the
  // second is the case a dateline-only guard gets wrong.
  for (const lonCenter of [0, 178, -122.3]) {
    it(`joins no two points across the seam at ${lonCenter}`, () => {
      const { x, y } = project(lonCenter)
      const ctx = recordingContext()
      drawCoastline(ctx as never, x, y, { color: '#fff', lonCenter })

      expect(ctx.segments.length).toBeGreaterThan(1000)
      for (const [from, to] of ctx.segments) {
        // Half the canvas is 180 degrees of longitude. No coastline moves
        // that far in one step; anything that does is the seam being drawn
        // rather than broken.
        expect(Math.abs(to[0] - from[0])).toBeLessThan(width / 2)
      }
    })
  }
})
