import { describe, expect, it, vi } from 'vitest'
import { settingsFrom } from '../src/config'
import {
  auroraProbabilityAt,
  parseAuroraPayload,
  zonesForAurora
} from '../src/parse'
import { aurora } from '../src/products/aurora'
import { fixtureJson, matchZone } from './fixtures'

const REAL = 'ovation-aurora.2026_08_01.json'

/**
 * A grid in NOAA's documented layout — longitude-major, latitude ascending
 * from -90 — whose values come from `cell(lon, lat)`. Synthetic grids are what
 * make the interpolation maths checkable: a captured payload only proves the
 * shape, and on a quiet day most of it is zero.
 */
function grid(cell: (lon: number, lat: number) => number) {
  const coordinates: number[][] = []
  for (let lon = 0; lon < 360; lon++) {
    for (let lat = -90; lat <= 90; lat++) {
      coordinates.push([lon, lat, cell(lon, lat)])
    }
  }
  return { observationTime: null, forecastTime: null, coordinates }
}

describe('parseAuroraPayload', () => {
  it('reads the captured payload', () => {
    const forecast = parseAuroraPayload(fixtureJson(REAL))!
    expect(forecast.coordinates.length).toBe(360 * 181)
    expect(forecast.observationTime).toBe('2026-08-01T18:16:00.000Z')
    expect(forecast.forecastTime).toBe('2026-08-01T19:52:00.000Z')
  })

  it('returns null rather than throwing on unusable input', () => {
    for (const input of [null, undefined, {}, { coordinates: [] }, 'nope']) {
      expect(parseAuroraPayload(input as any)).toBeNull()
    }
  })

  it('tolerates missing timestamps', () => {
    const forecast = parseAuroraPayload({ coordinates: [[0, 0, 1]] })!
    expect(forecast.observationTime).toBeNull()
    expect(forecast.forecastTime).toBeNull()
  })
})

describe('auroraProbabilityAt', () => {
  it('returns the cell value as a ratio when the position is on a grid point', () => {
    const forecast = parseAuroraPayload(fixtureJson(REAL))!
    // Raw cell values in the captured payload: (lon 20, lat 70) is 9%.
    expect(auroraProbabilityAt(forecast, 70, 20)).toBeCloseTo(0.09, 10)
    expect(auroraProbabilityAt(forecast, 0, 0)).toBeCloseTo(0.03, 10)
  })

  it('interpolates between cells rather than snapping to one', () => {
    // A ramp in latitude: halfway between lat 60 (=10) and lat 61 (=20).
    const forecast = grid((_lon, lat) => (lat === 60 ? 10 : lat === 61 ? 20 : 0))
    expect(auroraProbabilityAt(forecast, 60.5, 0)).toBeCloseTo(0.15, 10)
    expect(auroraProbabilityAt(forecast, 60.25, 0)).toBeCloseTo(0.125, 10)
  })

  it('interpolates across the 0/360 longitude seam', () => {
    // The captured payload happens to be zero either side of the seam, so this
    // needs a synthetic grid to mean anything.
    const forecast = grid((lon, lat) =>
      lat === 60 ? (lon === 359 ? 10 : lon === 0 ? 20 : 0) : 0
    )
    expect(auroraProbabilityAt(forecast, 60, -0.5)).toBeCloseTo(0.15, 10)
    expect(auroraProbabilityAt(forecast, 60, 359.5)).toBeCloseTo(0.15, 10)
    expect(auroraProbabilityAt(forecast, 60, -1)).toBeCloseTo(0.1, 10)
    expect(auroraProbabilityAt(forecast, 60, 0)).toBeCloseTo(0.2, 10)
  })

  it('accepts Signal K longitudes in -180..180', () => {
    const forecast = grid((lon) => (lon === 213 ? 50 : 0))
    // -147 east is 213 in the grid's 0..359 frame.
    expect(auroraProbabilityAt(forecast, 65, -147)).toBeCloseTo(0.5, 10)
  })

  it('clamps at the poles instead of running off the grid', () => {
    const forecast = grid((_lon, lat) => (lat === 90 ? 40 : lat === -90 ? 30 : 0))
    expect(auroraProbabilityAt(forecast, 90, 0)).toBeCloseTo(0.4, 10)
    expect(auroraProbabilityAt(forecast, 95, 0)).toBeCloseTo(0.4, 10)
    expect(auroraProbabilityAt(forecast, -90, 0)).toBeCloseTo(0.3, 10)
    expect(auroraProbabilityAt(forecast, -120, 0)).toBeCloseTo(0.3, 10)
  })

  it('always yields a ratio in 0..1 over the whole captured grid', () => {
    const forecast = parseAuroraPayload(fixtureJson(REAL))!
    for (let lat = -90; lat <= 90; lat += 7) {
      for (let lon = -180; lon < 180; lon += 11) {
        const value = auroraProbabilityAt(forecast, lat, lon)
        expect(value, `${lat},${lon}`).not.toBeNull()
        expect(Number.isFinite(value!), `${lat},${lon}`).toBe(true)
        expect(value!).toBeGreaterThanOrEqual(0)
        expect(value!).toBeLessThanOrEqual(1)
      }
    }
  })

  it('finds the right cell even if the payload is not in the documented order', () => {
    // The O(1) offset is an optimisation, not an assumption: NOAA has changed
    // payload shapes on this plugin before.
    const shuffled = grid((lon, lat) => (lon === 10 && lat === 50 ? 80 : 0))
    shuffled.coordinates.reverse()
    expect(auroraProbabilityAt(shuffled, 50, 10)).toBeCloseTo(0.8, 10)
  })

  it('returns null rather than NaN for anything it cannot resolve', () => {
    const forecast = parseAuroraPayload(fixtureJson(REAL))!
    expect(auroraProbabilityAt(null, 60, 0)).toBeNull()
    expect(auroraProbabilityAt(forecast, NaN, 0)).toBeNull()
    expect(auroraProbabilityAt(forecast, 60, NaN)).toBeNull()
    expect(auroraProbabilityAt({ coordinates: [] } as any, 60, 0)).toBeNull()
  })
})

describe('zonesForAurora', () => {
  const wire = () => JSON.parse(JSON.stringify(zonesForAurora()))

  it('never escalates to alarm at any probability', () => {
    // Aurora is an opportunity, not a hazard. Nothing here may make a noise.
    const zones = wire()
    for (const zone of zones) {
      expect(['nominal', 'normal', 'alert', 'warn']).toContain(zone.state)
    }
  })

  it('matches a zone at every probability including 1', () => {
    const zones = wire()
    for (const p of [0, 0.05, 0.1, 0.29, 0.3, 0.49, 0.5, 0.99, 1]) {
      expect(matchZone(zones, p), `p=${p}`).toBeGreaterThanOrEqual(0)
    }
    // The top band must be open-ended: the matcher is exclusive on `upper`,
    // so a value of exactly 1 would otherwise fall outside every zone.
    expect('upper' in zones[zones.length - 1]).toBe(false)
    expect(zones[matchZone(zones, 1)].state).toBe('warn')
  })

  it('leaves no gap between adjacent bands', () => {
    const zones = wire()
    for (let i = 1; i < zones.length; i++) {
      expect(zones[i].lower).toBe(zones[i - 1].upper)
    }
  })
})

describe('aurora product', () => {
  function harness(position: any, response?: any) {
    const published: any[] = []
    const errors: string[] = []
    const fetched: string[] = []
    const publisher = {
      meta: () => {},
      values: (values: any[]) => published.push(...values),
      value(path: string, value: any) {
        published.push({ path, value })
      },
      selfPath: (p: string) =>
        p === 'navigation.position.value' ? position : undefined,
      status: () => {},
      fail: () => {},
      error: (m: string) => errors.push(m),
      debug: () => {}
    }
    const client = {
      json: async (subPath: string) => {
        fetched.push(subPath)
        return response
      },
      text: async () => ''
    }
    return {
      published,
      errors,
      fetched,
      ctx: {
        client,
        publisher,
        settings: settingsFrom({ auroraEnabled: true }),
        stopped: () => false
      },
      valueAt: (path: string) =>
        published.find((v) => v.path === path)?.value
    }
  }

  it('publishes the probability at the vessel position', async () => {
    const h = harness({ latitude: 70, longitude: 20 }, fixtureJson(REAL))
    await aurora.refresh(h.ctx as any)

    expect(h.errors).toEqual([])
    expect(h.valueAt('environment.noaa.swpc.aurora.probability')).toBeCloseTo(
      0.09,
      10
    )
    expect(h.valueAt('environment.noaa.swpc.aurora.forecastTime')).toBe(
      '2026-08-01T19:52:00.000Z'
    )
  })

  it('does not fetch at all when the vessel has no position', async () => {
    // The payload is ~900 KB and the link may be metered; there is nothing to
    // do with a global grid and no position.
    const h = harness(undefined, fixtureJson(REAL))
    const result = await aurora.refresh(h.ctx as any)

    expect(h.fetched).toEqual([])
    expect(h.published).toEqual([])
    expect(h.errors).toEqual([])
    // 'not-ready' rather than a silent skip: a GPS fix can take minutes after
    // boot, and on an hourly product a silent skip means an hour of nothing.
    expect(result).toBe('not-ready')
  })

  it('reports ready once a position appears', async () => {
    const h = harness({ latitude: 70, longitude: 20 }, fixtureJson(REAL))
    expect(await aurora.refresh(h.ctx as any)).not.toBe('not-ready')
  })

  it('ignores a position that is not usable', async () => {
    for (const bad of [{}, { latitude: 'x', longitude: 2 }, { latitude: null }]) {
      const h = harness(bad, fixtureJson(REAL))
      await aurora.refresh(h.ctx as any)
      expect(h.fetched).toEqual([])
    }
  })

  it('reports a malformed payload without publishing', async () => {
    const h = harness({ latitude: 70, longitude: 20 }, { coordinates: [] })
    await aurora.refresh(h.ctx as any)
    expect(h.published).toEqual([])
    expect(h.errors.length).toBe(1)
  })

  it('is off unless switched on', () => {
    expect(aurora.enabled!(settingsFrom({}))).toBe(false)
    expect(aurora.enabled!(settingsFrom({ auroraEnabled: true }))).toBe(true)
  })

  it('polls on its own interval, not the observations one', () => {
    const settings = settingsFrom({
      auroraInterval: 120,
      observationsInterval: 15
    })
    expect(aurora.intervalMinutes(settings)).toBe(120)
  })
})
