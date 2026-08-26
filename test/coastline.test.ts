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

  it('stays small enough that its size is never the argument', () => {
    // The whole case for shipping geography at all is that it costs a
    // rounding error against a tarball carrying a megabyte of screenshots
    // (issue #32). A later regeneration at a finer tolerance, or somebody
    // dropping a raw Natural Earth file in here, would quietly spend that
    // argument -- this is the number that has to hold, not the tolerance
    // constants in scripts/gen-coastline.mjs.
    const asset = fileURLToPath(
      new URL('../public/coastline.js', import.meta.url)
    )
    expect(readFileSync(asset).byteLength).toBeLessThan(12_000)
  })

  it('decodes to whole rings of plottable coordinates', () => {
    expect(rings.length).toBeGreaterThan(100)
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

  it('quantises to a tenth of a degree', () => {
    // A coordinate off the lattice means the encoder and the decoder disagree
    // about the scale, which draws a plausible-looking coastline in the wrong
    // place -- the failure that has no visible symptom.
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        expect(Math.round(lon * 10)).toBeCloseTo(lon * 10, 9)
        expect(Math.round(lat * 10)).toBeCloseTo(lat * 10, 9)
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
        // Half the canvas is 180 degrees of longitude. Nothing on a 0.25
        // degree coastline moves that far in one step; anything that does is
        // the seam being drawn rather than broken.
        expect(Math.abs(to[0] - from[0])).toBeLessThan(width / 2)
      }
    })
  }
})
