import { describe, expect, it } from 'vitest'
import {
  LEGEND_MAX_MHZ,
  bandEdgeTicks,
  cutoffAt,
  distanceKm,
  greatCirclePoints,
  gridSummary,
  legendStops,
  pathAbsorption,
  subsolarPoint
} from '../public/drapMap.js'
import { drapNoaaColor } from '../public/drap-colors.js'
import { MARINE_SSB_BAND_EDGES_HZ } from '../public/hf.js'
import { drapFrequencyAt, parseDrapGrid } from '../src/parse'
import { fixture } from './fixtures'

const REAL = 'drap-global-frequencies.2026_08_20.txt'
const grid = parseDrapGrid(fixture(REAL))!

describe('legendStops', () => {
  // The palette itself is pinned against the server's copy by
  // test/drap-colors.test.ts. What matters here is that the bar the reader
  // sees is drawn from the same function the map paints with, over the same
  // range -- a legend that agreed with nothing would be worse than no legend.
  it('samples NOAA colorbar across the whole scale, in order', () => {
    const stops = legendStops(24)
    expect(stops).toHaveLength(24)
    expect(stops[0].mhz).toBe(0)
    expect(stops[stops.length - 1].mhz).toBe(LEGEND_MAX_MHZ)
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i].mhz).toBeGreaterThan(stops[i - 1].mhz)
    }
    for (const stop of stops) {
      const [r, g, b, a] = drapNoaaColor(stop.mhz)
      expect(stop.color).toBe(`rgba(${r},${g},${b},${a.toFixed(3)})`)
    }
  })
})

describe('bandEdgeTicks', () => {
  it('puts one tick per marine SSB band edge, in order, on the bar', () => {
    const ticks = bandEdgeTicks()
    expect(ticks.map((t) => t.mhz)).toEqual(
      MARINE_SSB_BAND_EDGES_HZ.map((hz) => hz / 1e6)
    )
    for (const tick of ticks) {
      expect(tick.fraction).toBeCloseTo(
        Math.min(1, tick.mhz / LEGEND_MAX_MHZ),
        10
      )
      expect(tick.fraction).toBeGreaterThanOrEqual(0)
      expect(tick.fraction).toBeLessThanOrEqual(1)
    }
  })
})

describe('cutoffAt', () => {
  // The map's number under the boat and the number on the Signal K path have
  // to be the same reading; drapFrequencyAt is what the vessel's own path
  // publishes it from, so the two must never disagree.
  it('reads the cell the published value comes from', () => {
    expect(cutoffAt(grid, 41, -178)).toBe(drapFrequencyAt(grid, 41, -178))
  })

  it('wraps longitude at the antimeridian', () => {
    expect(cutoffAt(grid, 41, 182)).toBe(cutoffAt(grid, 41, -178))
    expect(cutoffAt(grid, 41, -538)).toBe(cutoffAt(grid, 41, -178))
  })

  it('has an answer at the poles rather than falling off the grid', () => {
    expect(cutoffAt(grid, 90, 0)).not.toBeNull()
    expect(cutoffAt(grid, -90, 0)).not.toBeNull()
  })

  it('is null rather than NaN for a position it cannot use', () => {
    expect(cutoffAt(grid, NaN, 0)).toBeNull()
    expect(cutoffAt(null, 0, 0)).toBeNull()
  })
})

describe('greatCirclePoints', () => {
  it('starts and ends where it was asked to', () => {
    const from = { latitude: 37.8, longitude: -122.4 }
    const to = { latitude: -33.9, longitude: 151.2 }
    const points = greatCirclePoints(from, to)
    expect(points[0].latitude).toBeCloseTo(from.latitude, 6)
    expect(points[points.length - 1].longitude).toBeCloseTo(to.longitude, 6)
  })

  /**
   * A great circle is not the straight line on an equirectangular map, and
   * the difference is the whole point: the short way from California to Japan
   * goes near the Aleutians, which is exactly where a polar cap absorption
   * event lives.
   */
  it('follows the great circle, not the rhumb line', () => {
    const points = greatCirclePoints(
      { latitude: 37.8, longitude: -122.4 },
      { latitude: 35.7, longitude: 139.7 }
    )
    const north = Math.max(...points.map((p) => p.latitude))
    expect(north).toBeGreaterThan(45)
  })

  /** No cell on the path may be stepped over: the grid is 2 degrees tall. */
  it('samples finer than a grid cell', () => {
    const points = greatCirclePoints(
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 20 }
    )
    for (let i = 1; i < points.length; i++) {
      expect(
        Math.abs(points[i].longitude - points[i - 1].longitude)
      ).toBeLessThan(2)
    }
  })

  it('bounds the sample count on a very long path', () => {
    const points = greatCirclePoints(
      { latitude: 60, longitude: 0 },
      { latitude: -60, longitude: 180 }
    )
    expect(points.length).toBeLessThanOrEqual(401)
  })

  it('handles a path of no length', () => {
    const here = { latitude: 12, longitude: 34 }
    const points = greatCirclePoints(here, here)
    expect(points.every((p) => p.latitude === 12 && p.longitude === 34)).toBe(
      true
    )
  })

  /**
   * The slerp this used to use divides by sin(deltaAngular), which only gets
   * close to zero near the exact antipode rather than hitting it -- so a
   * path that isn't quite antipodal is exactly where the old bug bit, not
   * the antipode itself.
   */
  it('stays finite and monotonic near the exact antipode', () => {
    const from = { latitude: 10, longitude: 20 }
    const to = { latitude: -9.9999, longitude: -159.9999 }
    const points = greatCirclePoints(from, to)
    for (const p of points) {
      expect(Number.isFinite(p.latitude)).toBe(true)
      expect(Number.isFinite(p.longitude)).toBe(true)
    }
    for (let i = 1; i < points.length; i++) {
      expect(distanceKm(points[i - 1], points[i])).toBeLessThan(150)
    }
  })
})

describe('pathAbsorption', () => {
  it('reports the worst cell on the path, not the one under the boat', () => {
    // A synthetic grid with one bad band across the equator: a path from well
    // north to well south has to cross it, and the endpoints are clear.
    const synthetic = {
      validTime: grid.validTime,
      latitudes: grid.latitudes,
      longitudes: grid.longitudes,
      frequenciesMHz: grid.latitudes.map((lat) =>
        grid.longitudes.map(() => (Math.abs(lat) < 10 ? 18 : 0))
      )
    }
    const probe = pathAbsorption(
      synthetic,
      { latitude: 50, longitude: 0 },
      { latitude: -50, longitude: 0 }
    )
    expect(cutoffAt(synthetic, 50, 0)).toBe(0)
    expect(probe!.worstMHz).toBe(18)
    expect(Math.abs(probe!.worstAt!.latitude)).toBeLessThan(10)
    // The mean is the other half of the pair: one bad band across an
    // otherwise clear path is not a path that is bad end to end.
    expect(probe!.meanMHz).toBeLessThan(probe!.worstMHz)
  })

  it('carries the bearing and distance the operator would point at', () => {
    const probe = pathAbsorption(
      grid,
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 90 }
    )
    expect(probe!.bearingDeg).toBeCloseTo(90, 0)
    expect(probe!.distanceKm).toBeCloseTo(10007, -2)
  })

  it('is null without a grid or an endpoint', () => {
    expect(pathAbsorption(null, { latitude: 0, longitude: 0 }, null)).toBeNull()
    expect(pathAbsorption(grid, null, { latitude: 0, longitude: 0 })).toBeNull()
  })
})

describe('subsolarPoint', () => {
  /**
   * The one mark that makes the picture readable: D-region absorption is a
   * dayside phenomenon, so the blob belongs near the sun. Checked against the
   * two solstices and an equinox, where the answer is known without a model.
   */
  it('puts the sun over the tropics at the solstices', () => {
    expect(
      subsolarPoint(new Date('2026-06-21T12:00:00Z')).latitude
    ).toBeCloseTo(23.4, 0)
    expect(
      subsolarPoint(new Date('2026-12-21T12:00:00Z')).latitude
    ).toBeCloseTo(-23.4, 0)
    expect(
      Math.abs(subsolarPoint(new Date('2026-03-20T12:00:00Z')).latitude)
    ).toBeLessThan(1)
  })

  it('puts it near Greenwich at noon UTC and near the dateline at midnight', () => {
    expect(
      Math.abs(subsolarPoint(new Date('2026-03-20T12:00:00Z')).longitude)
    ).toBeLessThan(3)
    expect(
      Math.abs(subsolarPoint(new Date('2026-03-20T00:00:00Z')).longitude)
    ).toBeGreaterThan(177)
  })
})

describe('gridSummary', () => {
  it('tells a quiet grid from one that failed to load', () => {
    const quiet = {
      latitudes: grid.latitudes,
      longitudes: grid.longitudes,
      frequenciesMHz: grid.latitudes.map(() => grid.longitudes.map(() => 1.2))
    }
    expect(gridSummary(quiet)!.quiet).toBe(true)
    expect(gridSummary(quiet)!.maxMHz).toBe(1.2)
    expect(gridSummary(null)).toBeNull()
    expect(gridSummary({ frequenciesMHz: [] })).toBeNull()
  })

  it('finds the worst cell and where it is', () => {
    const summary = gridSummary(grid)!
    expect(summary.maxMHz).toBe(Math.max(...grid.frequenciesMHz.flat()))
    expect(grid.latitudes).toContain(summary.at!.latitude)
  })
})
