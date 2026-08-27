import { describe, expect, it } from 'vitest'
import { auroraSampler, drapSampler, rasterize } from '../public/mapRaster.js'
import { mapView } from '../public/projection.js'
import { cutoffAt } from '../public/drapMap.js'
import { drapNoaaColor } from '../public/drap-colors.js'
import { parseDrapGrid } from '../src/parse'
import { fixture, fixtureJson } from './fixtures'

const drapGrid = parseDrapGrid(
  fixture('drap-global-frequencies.2026_08_20.txt')
)!
const auroraGrid = fixtureJson('ovation-aurora.2026_08_01.json')

/** A 90x90 D-RAP grid, NOAA's own geometry, with every cell at `value`. */
function flatDrapGrid(
  value: number,
  hot?: { row: number; col: number; value: number }
) {
  const latitudes = Array.from({ length: 90 }, (_, i) => 89 - i * 2)
  const longitudes = Array.from({ length: 90 }, (_, i) => -180 + i * 4)
  const frequenciesMHz = latitudes.map(() => longitudes.map(() => value))
  if (hot) frequenciesMHz[hot.row][hot.col] = hot.value
  return {
    validTime: '2026-08-20T00:00:00Z',
    latitudes,
    longitudes,
    frequenciesMHz
  }
}

describe('drapSampler', () => {
  const sample = drapSampler(drapGrid)!

  it('agrees with the published value at a cell centre', () => {
    // The map and the Signal K path are two pictures of one number. At a cell
    // centre the interpolation has no neighbours to blend toward, so the two
    // must be the same value, not merely close.
    for (const row of [10, 45, 80]) {
      for (const col of [0, 22, 60, 89]) {
        const lat = drapGrid.latitudes[row]
        const lon = drapGrid.longitudes[col]
        expect(sample(lat, lon)).toBeCloseTo(cutoffAt(drapGrid, lat, lon)!, 6)
      }
    }
  })

  it('blends between neighbouring cells rather than stepping', () => {
    // What #186 is about: the field is smooth, so the picture of it should be.
    const hot = flatDrapGrid(0, { row: 45, col: 45, value: 20 })
    const blend = drapSampler(hot)!
    const centre = blend(hot.latitudes[45], hot.longitudes[45])
    const halfway = blend(hot.latitudes[45], hot.longitudes[45] + 2)
    expect(centre).toBeCloseTo(20, 6)
    expect(halfway).toBeGreaterThan(5)
    expect(halfway).toBeLessThan(15)
  })

  it('wraps longitude across the antimeridian', () => {
    const hot = flatDrapGrid(0, { row: 45, col: 0, value: 12 })
    const blend = drapSampler(hot)!
    // Column 0 is -180. A degree the other side of the seam is a degree away,
    // not 359 -- so it still sees the hot cell.
    expect(blend(hot.latitudes[45], 179)).toBeGreaterThan(0)
  })

  it('returns null for a grid it cannot use', () => {
    expect(drapSampler(null as any)).toBeNull()
    expect(
      drapSampler({ frequenciesMHz: [], latitudes: [], longitudes: [] } as any)
    ).toBeNull()
  })
})

describe('auroraSampler', () => {
  const sample = auroraSampler(auroraGrid)!

  it('reads the OVATION grid at the cell it came from', () => {
    for (const point of [
      auroraGrid.coordinates[0],
      auroraGrid.coordinates[30000],
      auroraGrid.coordinates[65159]
    ]) {
      const [lon, lat, pct] = point
      expect(sample(lat, lon)).toBeCloseTo(pct, 6)
    }
  })

  it('rejects a grid that is not the shape OVATION publishes', () => {
    expect(auroraSampler({ coordinates: [[0, 0, 5]] } as any)).toBeNull()
    expect(auroraSampler(null as any)).toBeNull()
  })
})

describe('rasterize', () => {
  const layers = (grid: any) => [
    { sample: drapSampler(grid)!, color: drapNoaaColor }
  ]

  it('registers: every pixel carries the colour of the position drawn there', () => {
    // The registration property, stated exactly. If the raster and the vector
    // overlay ever disagreed by half a cell, the coastline would sit beside
    // the absorption rather than under it, and nobody would be able to tell
    // by how much.
    const view = mapView({
      projection: 'cylindrical',
      center: { latitude: 0, longitude: 0 },
      radiusDeg: 180,
      width: 720,
      height: 360
    })
    const sample = drapSampler(drapGrid)!
    const raster = rasterize(view, layers(drapGrid), { maxSide: 720 })
    for (const [px, py] of [
      [100, 40],
      [360, 180],
      [700, 300]
    ]) {
      const here = view.toLatLon(px + 0.5, py + 0.5)!
      const [r, g, b, a] = drapNoaaColor(sample(here.latitude, here.longitude))
      const index = (py * raster.width + px) * 4
      expect(raster.data[index + 3]).toBe(Math.round(a * 255))
      if (a > 0) {
        expect(raster.data[index]).toBe(r)
        expect(raster.data[index + 1]).toBe(g)
        expect(raster.data[index + 2]).toBe(b)
      }
    }
  })

  it('puts the hot part of the grid where the projection puts it', () => {
    // A 3x3 block rather than one cell, so what is checked is where the
    // feature landed rather than how much a bilinear tap rounds a lone spike.
    const hot = flatDrapGrid(0)
    for (let row = 19; row <= 21; row++) {
      for (let col = 69; col <= 71; col++) hot.frequenciesMHz[row][col] = 30
    }
    const view = mapView({
      projection: 'cylindrical',
      center: { latitude: 0, longitude: 0 },
      radiusDeg: 180,
      width: 720,
      height: 360
    })
    const raster = rasterize(view, layers(hot), { maxSide: 720 })
    const at = view.toPixel(hot.longitudes[70], hot.latitudes[20])!
    const index = (Math.round(at[1]) * raster.width + Math.round(at[0])) * 4
    // 30 MHz is the orange end of NOAA's bar, and opaque.
    expect(raster.data[index + 3]).toBe(255)
    expect(raster.data[index]).toBeGreaterThan(200)
    expect(raster.data[index + 2]).toBeLessThan(80)
    // ...and nowhere else on the globe has any ink at all.
    const far = (Math.round(at[1]) * raster.width + 10) * 4
    expect(raster.data[far + 3]).toBe(0)
  })

  it('puts no ink where the model says nothing is absorbed', () => {
    // NOAA's 0 MHz stop is #000000; drawn literally it would be an opaque
    // black sheet over the whole ocean rather than "nothing happening here".
    const view = mapView({
      projection: 'cylindrical',
      center: { latitude: 0, longitude: 0 },
      radiusDeg: 180,
      width: 180,
      height: 90
    })
    const raster = rasterize(view, layers(flatDrapGrid(0)), { maxSide: 180 })
    expect(raster.data.every((byte) => byte === 0)).toBe(true)
  })

  it('leaves the corners of an azimuthal disc transparent', () => {
    // Outside the boundary circle is not a place on the planet, so nothing
    // from the far side of the world may be wrapped into it.
    const view = mapView({
      projection: 'azimuthal',
      center: { latitude: 0, longitude: 0 },
      radiusDeg: 180,
      width: 200,
      height: 200
    })
    const raster = rasterize(view, layers(flatDrapGrid(25)), { maxSide: 200 })
    const corner = (0 * raster.width + 0) * 4
    const middle =
      (Math.floor(raster.height / 2) * raster.width +
        Math.floor(raster.width / 2)) *
      4
    expect(raster.data[corner + 3]).toBe(0)
    expect(raster.data[middle + 3]).toBe(255)
  })

  it('composites layers in the order it is given', () => {
    const view = mapView({
      projection: 'cylindrical',
      center: { latitude: 0, longitude: 0 },
      radiusDeg: 180,
      width: 40,
      height: 20
    })
    const under = {
      sample: () => 1,
      color: () => [0, 0, 255, 1] as [number, number, number, number]
    }
    const over = {
      sample: () => 1,
      color: () => [255, 0, 0, 1] as [number, number, number, number]
    }
    const raster = rasterize(view, [under, over], { maxSide: 40 })
    expect([raster.data[0], raster.data[1], raster.data[2]]).toEqual([
      255, 0, 0
    ])
  })

  it('composites translucent layers the way source-over says to', () => {
    // rasterize does its own alpha arithmetic, un-premultiplied, because it
    // is filling the bytes putImageData wants. Ordering is pinned above; this
    // pins the numbers, against a premultiplied reference worked the other
    // way round -- the two agree only if the formula is actually Porter-Duff
    // source-over rather than something that merely looks right on opaque
    // layers.
    const view = mapView({
      projection: 'cylindrical',
      center: { latitude: 0, longitude: 0 },
      radiusDeg: 180,
      width: 8,
      height: 4
    })
    const inks: [number, number, number, number][] = [
      [255, 0, 0, 0.4],
      [0, 255, 0, 0.25],
      [0, 0, 255, 0.6]
    ]
    const layers = inks.map((ink) => ({ sample: () => 1, color: () => ink }))
    const raster = rasterize(view, layers, { maxSide: 8 })

    let [pr, pg, pb, pa] = [0, 0, 0, 0]
    for (const [r, g, b, sa] of inks) {
      pr = r * sa + pr * (1 - sa)
      pg = g * sa + pg * (1 - sa)
      pb = b * sa + pb * (1 - sa)
      pa = sa + pa * (1 - sa)
    }
    for (const channel of [0, 1, 2, 3]) {
      const expected = channel === 3 ? pa * 255 : [pr, pg, pb][channel] / pa
      // Within a bit: the raster's bytes are rounded and the reference's are
      // not.
      expect(raster.data[channel]).toBeGreaterThanOrEqual(expected - 1)
      expect(raster.data[channel]).toBeLessThanOrEqual(expected + 1)
    }
  })

  it('renders nothing at all when no layer is selected', () => {
    const view = mapView({
      projection: 'azimuthal',
      center: { latitude: 0, longitude: 0 },
      radiusDeg: 60,
      width: 60,
      height: 60
    })
    const raster = rasterize(view, [], { maxSide: 60 })
    expect(raster.data.every((byte) => byte === 0)).toBe(true)
  })

  it('bounds its own resolution however big the canvas is', () => {
    // A boat tablet redraws this on every resize, zoom step and probe click,
    // and the source grids are 90x90 and 360x181 -- past a few hundred pixels
    // this would be JavaScript interpolating what the GPU interpolates for
    // free.
    const view = mapView({
      projection: 'azimuthal',
      center: { latitude: 0, longitude: 0 },
      radiusDeg: 60,
      width: 3000,
      height: 1500
    })
    const raster = rasterize(view, layers(drapGrid))
    expect(Math.max(raster.width, raster.height)).toBeLessThanOrEqual(480)
    expect(raster.width / raster.height).toBeCloseTo(2, 1)
  })
})
