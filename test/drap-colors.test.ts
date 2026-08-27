import { describe, expect, it } from 'vitest'
import {
  NOAA_DRAP_STOPS,
  drapNoaaColor,
  drapNoaaCss,
  drapNoaaLegend
} from '../public/drap-colors.js'
import { NOAA_DRAP_STOPS as TILE_STOPS, drapLattice } from '../src/tiles.js'

const TOP_MHZ = 35

describe('the NOAA D-RAP colorbar', () => {
  // Sampled off NOAA's legend, so the table is data and every stop has to
  // survive the interpolation that reads it back.
  it('lands each measured stop on its measured colour', () => {
    for (const [mhz, r, g, b] of NOAA_DRAP_STOPS) {
      if (mhz === 0) continue
      expect(drapNoaaColor(mhz).slice(0, 3)).toEqual([r, g, b])
    }
  })

  it('interpolates linearly in RGB between two stops', () => {
    // 10 MHz (0,55,255) to 12 MHz (0,131,255): the midpoint is the mean.
    expect(drapNoaaColor(11).slice(0, 3)).toEqual([0, 93, 255])
  })

  it('moves monotonically between two stops', () => {
    let previous = -1
    for (let mhz = 10; mhz <= 12; mhz += 0.05) {
      const green = drapNoaaColor(mhz)[1]
      expect(green).toBeGreaterThanOrEqual(previous)
      previous = green
    }
  })

  it('saturates at pure red and holds it above 35 MHz', () => {
    for (const mhz of [TOP_MHZ, 35.5, 40, 120]) {
      expect(drapNoaaColor(mhz)).toEqual([255, 0, 0, 1])
    }
  })

  // NOAA's 0 MHz stop is #000000; published literally it reads as a hole in
  // the chart rather than as a quiet grid, so the low end carries alpha.
  it('draws nothing at all at 0 MHz, or with no reading', () => {
    for (const mhz of [0, -1, NaN, null, undefined]) {
      expect(drapNoaaColor(mhz as number)).toEqual([0, 0, 0, 0])
      expect(drapNoaaCss(mhz as number)).toBeNull()
    }
  })

  it('fades in rather than switching on, and is opaque by 4 MHz', () => {
    expect(drapNoaaColor(1)[3]).toBeCloseTo(0.25, 6)
    expect(drapNoaaColor(2)[3]).toBeCloseTo(0.5, 6)
    expect(drapNoaaColor(4)[3]).toBe(1)
  })

  it('shows a cutoff in the working bands at full strength', () => {
    for (const mhz of [8, 12, 21, 30]) {
      expect(drapNoaaColor(mhz)[3]).toBe(1)
    }
  })

  it('writes a cell as rgba once there is anything to draw', () => {
    expect(drapNoaaCss(12)).toBe('rgba(0,131,255,1.000)')
    expect(drapNoaaCss(2)).toBe('rgba(61,0,63,0.500)')
  })
})

describe('the legend strip', () => {
  it('spans the whole bar in ascending order', () => {
    const stops = drapNoaaLegend(8)
    expect(stops).toHaveLength(8)
    expect(stops[0].mhz).toBe(0)
    expect(stops[stops.length - 1].mhz).toBe(TOP_MHZ)
    expect(stops.map((s) => s.mhz)).toEqual(
      [...stops.map((s) => s.mhz)].sort((a, b) => a - b)
    )
  })

  it('paints each swatch the colour the map paints that cutoff', () => {
    for (const { mhz, color } of drapNoaaLegend(12)) {
      const [r, g, b, a] = drapNoaaColor(mhz)
      expect(color).toBe(`rgba(${r},${g},${b},${a.toFixed(3)})`)
    }
  })
})

describe('the chart-plotter tile draws the same colorbar', () => {
  // Two pictures of one number -- the webapp's map and the tile overlaid on a
  // chart. A browser cannot import the TypeScript, so the table is copied;
  // this is what makes the copy safe.
  const lattice = drapLattice({
    validTime: '2026-08-26T12:00:00Z',
    latitudes: [2, 0],
    longitudes: [-178, -174],
    frequenciesMHz: [
      [0, 0],
      [0, 0]
    ]
  })!

  it('copies NOAA_DRAP_STOPS exactly', () => {
    expect(NOAA_DRAP_STOPS).toEqual(TILE_STOPS.map((stop) => [...stop]))
  })

  it('renders every cutoff in the webapp colour, alpha included', () => {
    const { lut, lutScale } = lattice
    for (let mhz = 0; mhz <= 40; mhz += 0.25) {
      const index = Math.round(mhz * lutScale) * 4
      const [r, g, b, a] = drapNoaaColor(mhz)
      expect([
        lut[index],
        lut[index + 1],
        lut[index + 2],
        lut[index + 3]
      ]).toEqual([r, g, b, Math.round(255 * a)])
    }
  })
})
