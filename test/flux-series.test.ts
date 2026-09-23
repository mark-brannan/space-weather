import { describe, expect, it } from 'vitest'
import {
  PROTON_FLOOR,
  R_THRESHOLDS,
  S_THRESHOLDS,
  XRAY_FLOOR,
  fluxOverlay,
  protonLadder,
  xrayLadder
} from '../public/flux.js'
import { kpFloorForG } from '../public/hero.js'
import {
  goesFluxSeries,
  mergeFluxSeries,
  parseGoesFluxSeries
} from '../src/parse'
import { fixtureJson } from './fixtures'

const BUCKET = 15 * 60 * 1000

/**
 * The overlay's whole claim is that one dotted ladder reads for three series
 * (issue #108). That only holds if R1 and S1 land on exactly the row G1 does,
 * so these are the assertions the picture rests on -- everything else about
 * the mapping is a consequence of them.
 */
describe('the flux ladders are pinned to the Kp one', () => {
  it('puts every R threshold on its own G row', () => {
    R_THRESHOLDS.forEach((flux, i) => {
      expect(xrayLadder(flux)).toBeCloseTo(kpFloorForG(i + 1), 10)
    })
  })

  it('puts every S threshold on its own G row', () => {
    S_THRESHOLDS.forEach((flux, i) => {
      expect(protonLadder(flux)).toBeCloseTo(kpFloorForG(i + 1), 10)
    })
  })

  it('sits a quiet reading on the baseline, not below it', () => {
    expect(xrayLadder(XRAY_FLOOR)).toBe(0)
    expect(xrayLadder(XRAY_FLOOR / 100)).toBe(0)
    expect(protonLadder(PROTON_FLOOR)).toBe(0)
  })

  it('keeps a decade of headroom over R5 and clamps above it', () => {
    // An X28 has happened; without the headroom knot it would draw at the
    // same height as the X20 that opens R5.
    expect(xrayLadder(2.8e-3)).toBeGreaterThan(xrayLadder(2e-3))
    expect(xrayLadder(1)).toBe(9)
  })

  it('has no answer for a missing or non-positive reading', () => {
    for (const bad of [null, undefined, 0, -1, NaN]) {
      expect(xrayLadder(bad as number)).toBeNull()
    }
  })

  it('rises with the reading', () => {
    let previous = -1
    for (const flux of [1e-8, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3]) {
      const kp = xrayLadder(flux)
      expect(kp).toBeGreaterThan(previous)
      previous = kp as number
    }
  })
})

describe('the flux series a chart draws', () => {
  const xrayJson = fixtureJson('xrays-6-hour.2026_08_20.json')
  const protonJson = fixtureJson('integral-protons-6-hour.2026_08_20.json')

  it('buckets the payload and keeps each bucket maximum', () => {
    const series = goesFluxSeries(xrayJson, '0.1-0.8nm', BUCKET)
    expect(series.length).toBeGreaterThan(20)
    expect(series.length).toBeLessThan(40) // six hours of quarter-hours
    for (const point of series) {
      expect(Date.parse(point.time) % BUCKET).toBe(0)
      expect(point.value).toBeGreaterThan(0)
    }
    const times = series.map((p) => Date.parse(p.time))
    expect([...times].sort((a, b) => a - b)).toEqual(times)

    // The maximum, not the mean: every bucket is at least as high as the
    // highest raw record inside it and no higher.
    const bucket = series[1]
    const at = Date.parse(bucket.time)
    const inside = xrayJson
      .filter(
        (row: any) =>
          row.energy === '0.1-0.8nm' &&
          Date.parse(row.time_tag) >= at &&
          Date.parse(row.time_tag) < at + BUCKET
      )
      .map((row: any) => row.flux)
    expect(bucket.value).toBe(Math.max(...inside))
  })

  it('publishes proton flux in the SI units its scalar path uses', () => {
    const { proton } = parseGoesFluxSeries(xrayJson, protonJson, BUCKET)
    const at = Date.parse(proton[0].time)
    const pfu = protonJson
      .filter(
        (row: any) =>
          row.energy === '>=10 MeV' &&
          Date.parse(row.time_tag) >= at &&
          Date.parse(row.time_tag) < at + BUCKET
      )
      .map((row: any) => row.flux)
    // pfu is cm^-2; the path publishes m^-2, which is 10^4 of them.
    expect(proton[0].value).toBeCloseTo(Math.max(...pfu) * 1e4, 10)
  })

  it('reads a payload that is not an array as no series at all', () => {
    expect(goesFluxSeries(null, '0.1-0.8nm', BUCKET)).toEqual([])
    expect(goesFluxSeries({ error: 'nope' }, '0.1-0.8nm', BUCKET)).toEqual([])
  })
})

describe('the retained window', () => {
  const at = (minutes: number) => new Date(minutes * 60 * 1000).toISOString()
  const WINDOW = 60 * 60 * 1000

  it('extends what is held with what a fresh payload adds', () => {
    const held = [
      { time: at(0), value: 1 },
      { time: at(15), value: 2 }
    ]
    const fresh = [
      { time: at(15), value: 3 },
      { time: at(30), value: 4 }
    ]
    expect(mergeFluxSeries(held, fresh, WINDOW)).toEqual([
      { time: at(0), value: 1 },
      // The overlapping bucket was still filling when it was first read.
      { time: at(15), value: 3 },
      { time: at(30), value: 4 }
    ])
  })

  it('drops what has fallen out of the window behind the newest point', () => {
    const held = [
      { time: at(0), value: 1 },
      { time: at(30), value: 2 }
    ]
    const fresh = [{ time: at(75), value: 3 }]
    expect(mergeFluxSeries(held, fresh, WINDOW).map((p) => p.time)).toEqual([
      at(30),
      at(75)
    ])
  })

  it('is empty until something has been polled', () => {
    expect(mergeFluxSeries([], [], WINDOW)).toEqual([])
  })
})

describe('the overlay the chart is handed', () => {
  const leaf = (points: unknown) => ({ series: { value: points } })

  it('maps both channels onto the Kp scale', () => {
    const overlay = fluxOverlay({
      xrayFlux: leaf([{ time: '2026-08-20T00:00:00Z', value: 1e-5 }]),
      protonFlux: leaf([{ time: '2026-08-20T00:00:00Z', value: 1e5 }])
    })
    expect(overlay.xray[0].kp).toBeCloseTo(kpFloorForG(1), 10)
    expect(overlay.proton[0].kp).toBeCloseTo(kpFloorForG(1), 10)
    expect(overlay.xray[0].time).toBe(Date.parse('2026-08-20T00:00:00Z'))
  })

  it('is null for a channel that has published nothing', () => {
    expect(fluxOverlay({})).toEqual({ xray: null, proton: null })
    expect(fluxOverlay({ xrayFlux: leaf([]) }).xray).toBeNull()
    expect(fluxOverlay(null)).toEqual({ xray: null, proton: null })
  })
})
