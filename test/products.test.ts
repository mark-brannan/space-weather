import { describe, expect, it, vi } from 'vitest'
import { settingsFrom } from '../src/config'
import { f107 } from '../src/products/f107'
import { kp } from '../src/products/kp'
import { outlook27 } from '../src/products/outlook27'
import { scales } from '../src/products/scales'
import { solarWind } from '../src/products/solarWind'
import { fixture, fixtureJson } from './fixtures'

/**
 * The point of the products/ split: a product can be exercised with a fake
 * client and a fake publisher, with no server, no timers and no network. Each
 * of these drives the real refresh path over a captured payload and asserts on
 * what would reach Signal K.
 */
function harness(responses: Record<string, any>) {
  const published: { values: any[]; timestamp: string }[] = []
  const metas: any[] = []
  const errors: string[] = []

  const publisher = {
    meta: (m: any[]) => metas.push(...m),
    values: (values: any[], timestamp: string) =>
      published.push({ values, timestamp }),
    value(path: string, value: any, timestamp: string) {
      this.values([{ path, value }], timestamp)
    },
    selfPath: () => undefined,
    status: () => {},
    fail: () => {},
    error: (m: string, ...a: any[]) => errors.push(`${m} ${a.join(' ')}`),
    debug: () => {}
  }

  const client = {
    json: async (subPath: string) => {
      if (!(subPath in responses)) throw new Error(`unstubbed ${subPath}`)
      return responses[subPath]
    },
    text: async (subPath: string) => {
      if (!(subPath in responses)) throw new Error(`unstubbed ${subPath}`)
      return responses[subPath]
    }
  }

  const flat = () => published.flatMap((p) => p.values)
  return {
    publisher,
    client,
    metas,
    errors,
    published,
    ctx: {
      client,
      publisher,
      settings: settingsFrom({}),
      stopped: () => false
    },
    valueAt: (path: string) => flat().find((v) => v.path === path)?.value,
    paths: () => flat().map((v) => v.path)
  }
}

const FLARE_ENDPOINT = '/json/goes/primary/xray-flares-latest.json'

describe('scales product', () => {
  it('publishes observed levels and forecast probabilities from a captured payload', async () => {
    const h = harness({
      '/products/noaa-scales.json': fixtureJson('noaa-scales.2026_08_01.json'),
      [FLARE_ENDPOINT]: fixtureJson('xray-flares-latest.2026_08_06.json')
    })
    await scales.refresh(h.ctx as any)

    expect(h.errors).toEqual([])
    expect(
      h.valueAt('environment.noaa.swpc.scales.observations.latest.G')
    ).toBe(0)
    expect(
      h.valueAt('environment.noaa.swpc.scales.forecast.1day.S.probability')
    ).toBeCloseTo(0.75, 10)
    expect(h.paths()).toContain(
      'environment.noaa.swpc.scales.forecast.3day.R.majorProbability'
    )
  })

  it('describes both observation ranges separately', () => {
    const paths = scales.metadata!(settingsFrom({})).map((m) => m.path)
    expect(paths).toContain(
      'environment.noaa.swpc.scales.observations.latest.G'
    )
    expect(paths).toContain(
      'environment.noaa.swpc.scales.observations.24_hours_maximums.G'
    )
    expect(paths.length).toBe(new Set(paths).size)
  })

  it('reports a missing range instead of throwing', async () => {
    const h = harness({
      '/products/noaa-scales.json': {},
      [FLARE_ENDPOINT]: fixtureJson('xray-flares-latest.2026_08_06.json')
    })
    await scales.refresh(h.ctx as any)
    expect(h.errors.length).toBeGreaterThan(0)
  })

  it('publishes the X-ray flare class from a captured payload', async () => {
    const h = harness({
      '/products/noaa-scales.json': fixtureJson('noaa-scales.2026_08_01.json'),
      [FLARE_ENDPOINT]: fixtureJson('xray-flares-latest.2026_08_06.json')
    })
    await scales.refresh(h.ctx as any)

    expect(h.errors).toEqual([])
    expect(h.valueAt('environment.noaa.swpc.xray_flare.class')).toBe('B3.3')
  })

  it('still publishes scales even if the flare-class fetch fails', async () => {
    const h = harness({
      '/products/noaa-scales.json': fixtureJson('noaa-scales.2026_08_01.json')
      // FLARE_ENDPOINT deliberately unstubbed -- the client throws
    })
    await scales.refresh(h.ctx as any)

    expect(
      h.valueAt('environment.noaa.swpc.scales.observations.latest.G')
    ).toBe(0)
    expect(h.valueAt('environment.noaa.swpc.xray_flare.class')).toBeUndefined()
    expect(h.errors.some((e) => e.includes('flare'))).toBe(true)
  })
})

describe('kp product', () => {
  it('publishes the forecast summary', async () => {
    // The product always windows the series against the real clock (correct
    // in production), but the fixture is a fixed snapshot -- so this test
    // must pin the clock into the fixture's own window, or it silently
    // starts failing as real time drifts away from 2026-08-01.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T07:00:00Z'))

    const h = harness({
      '/products/noaa-planetary-k-index-forecast.json': fixtureJson(
        'noaa-planetary-k-index-forecast.2026_08_01.json'
      )
    })
    await kp.refresh(h.ctx as any)
    vi.useRealTimers()

    expect(h.errors).toEqual([])
    expect(h.paths()).toEqual(
      expect.arrayContaining([
        'environment.noaa.swpc.kp.observed',
        'environment.noaa.swpc.kp.forecast.max24h',
        'environment.noaa.swpc.kp.forecast.nextStormTime',
        'environment.noaa.swpc.kp.forecast.series'
      ])
    )

    const series = h.valueAt('environment.noaa.swpc.kp.forecast.series')
    expect(Array.isArray(series)).toBe(true)
    expect(series.length).toBeGreaterThan(0)
    for (const point of series) {
      expect(typeof point.time).toBe('string')
      expect(Number.isFinite(point.kp)).toBe(true)
      expect(typeof point.forecast).toBe('boolean')
    }
  })
})

describe('solar wind product', () => {
  it('publishes SI values from the current NOAA payload shape', async () => {
    const h = harness({
      '/products/summary/solar-wind-speed.json': fixtureJson(
        'solar-wind-speed.2026_08_01.json'
      ),
      '/products/summary/solar-wind-mag-field.json': fixtureJson(
        'solar-wind-mag-field.2026_08_01.json'
      )
    })
    await solarWind.refresh(h.ctx as any)

    expect(h.errors).toEqual([])
    expect(h.valueAt('environment.noaa.swpc.solar_wind.speed')).toBe(287000)
    expect(h.valueAt('environment.noaa.swpc.solar_wind.Bt')).toBeCloseTo(
      4e-9,
      20
    )
  })

  it('publishes nothing at all rather than NaN when the payload is unusable', async () => {
    const h = harness({
      '/products/summary/solar-wind-speed.json': [],
      '/products/summary/solar-wind-mag-field.json': []
    })
    await solarWind.refresh(h.ctx as any)
    expect(h.published).toEqual([])
    expect(h.errors.length).toBe(1)
  })
})

describe('f107 product', () => {
  it('publishes the latest Noon reading from a captured payload', async () => {
    const h = harness({
      '/json/f107_cm_flux.json': fixtureJson('f107_cm_flux.2026_08_06.json')
    })
    await f107.refresh(h.ctx as any)

    expect(h.errors).toEqual([])
    expect(h.valueAt('environment.noaa.swpc.f107')).toBe(108)
  })

  it('has a hard-coded interval, not one driven by settings', () => {
    expect(f107.intervalMinutes(settingsFrom({ updateInterval: 5 }))).toBe(240)
  })

  it('publishes nothing rather than an error-free silent gap when no Noon entry exists', async () => {
    const h = harness({ '/json/f107_cm_flux.json': [] })
    await f107.refresh(h.ctx as any)
    expect(h.published).toEqual([])
    expect(h.errors.length).toBe(1)
  })
})

const OUTLOOK27_ENDPOINT = '/text/27-day-outlook.txt'

describe('outlook27 product', () => {
  const stubbed = () =>
    harness({ [OUTLOOK27_ENDPOINT]: fixture('27-day-outlook.2026_08_12.txt') })

  it('publishes the summary and the daily series from a captured payload', async () => {
    const h = stubbed()
    await outlook27.refresh(h.ctx as any)

    expect(h.errors).toEqual([])
    expect(h.valueAt('environment.noaa.swpc.outlook_27day.maxKp')).toBe(5)
    expect(h.valueAt('environment.noaa.swpc.outlook_27day.maxKpTime')).toBe(
      '2026-08-11T00:00:00.000Z'
    )
    expect(h.valueAt('environment.noaa.swpc.outlook_27day.maxNoaaScale')).toBe(
      1
    )
    expect(h.valueAt('environment.noaa.swpc.outlook_27day.nextStormTime')).toBe(
      '2026-08-11T00:00:00.000Z'
    )
    expect(h.valueAt('environment.noaa.swpc.outlook_27day.nextStormKp')).toBe(5)
    expect(
      h.valueAt('environment.noaa.swpc.outlook_27day.series')
    ).toHaveLength(27)
  })

  it('timestamps the delta with the issue time, not the fetch time', async () => {
    const h = stubbed()
    await outlook27.refresh(h.ctx as any)
    expect(h.published[0].timestamp).toBe('2026-08-10T01:53:00.000Z')
  })

  it('raises no notification for any of it', async () => {
    // The whole design decision of this product: 27-day data is a recurrence
    // estimate, and the server raises a notification off any path carrying
    // meta.zones. A G1 day falls inside the window roughly monthly -- this
    // fixture has two -- so zoning it would fire on low-skill data and dilute
    // the 3-day alerts. Nothing here gets zones, and nothing publishes under
    // notifications.
    for (const meta of outlook27.metadata!(settingsFrom({}))) {
      expect(meta.value.zones, meta.path).toBeUndefined()
    }

    const h = stubbed()
    await outlook27.refresh(h.ctx as any)
    for (const path of h.paths()) {
      expect(path.startsWith('notifications.')).toBe(false)
    }
  })

  it('describes every path it publishes', async () => {
    const h = stubbed()
    await outlook27.refresh(h.ctx as any)
    const described = outlook27.metadata!(settingsFrom({})).map((m) => m.path)
    for (const path of h.paths()) expect(described).toContain(path)
  })

  it('has a hard-coded interval, not one driven by settings', () => {
    expect(outlook27.intervalMinutes(settingsFrom({ updateInterval: 5 }))).toBe(
      240
    )
  })

  it('publishes nothing when the table cannot be read', async () => {
    const h = harness({ [OUTLOOK27_ENDPOINT]: ':Issued: 2026 Aug 10 0153 UTC' })
    await outlook27.refresh(h.ctx as any)
    expect(h.published).toEqual([])
    expect(h.errors.length).toBe(1)
  })
})
