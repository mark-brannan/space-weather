import { describe, expect, it, vi } from 'vitest'
import { settingsFrom } from '../src/config'
import { harness } from './harness'
import { aIndex } from '../src/products/aIndex'
import { f107 } from '../src/products/f107'
import { goesFlux } from '../src/products/goesFlux'
import { kp } from '../src/products/kp'
import { outlook27 } from '../src/products/outlook27'
import { scales } from '../src/products/scales'
import { solarWind } from '../src/products/solarWind'
import { sunspot } from '../src/products/sunspot'
import { fixture, fixtureJson } from './fixtures'

const FLARE_ENDPOINT = '/json/goes/primary/xray-flares-latest.json'

describe('scales product', () => {
  it('publishes observed levels and forecast probabilities from a captured payload', async () => {
    const h = harness({
      '/products/noaa-scales.json': fixtureJson('noaa-scales.2026_08_01.json'),
      [FLARE_ENDPOINT]: fixtureJson('xray-flares-latest.2026_08_06.json')
    })
    await scales.refresh(h.ctx)

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
    await scales.refresh(h.ctx)
    expect(h.errors.length).toBeGreaterThan(0)
  })

  it('publishes the X-ray flare class from a captured payload', async () => {
    const h = harness({
      '/products/noaa-scales.json': fixtureJson('noaa-scales.2026_08_01.json'),
      [FLARE_ENDPOINT]: fixtureJson('xray-flares-latest.2026_08_06.json')
    })
    await scales.refresh(h.ctx)

    expect(h.errors).toEqual([])
    expect(h.valueAt('environment.noaa.swpc.xray_flare.class')).toBe('B3.3')
  })

  it('still publishes scales even if the flare-class fetch fails', async () => {
    const h = harness({
      '/products/noaa-scales.json': fixtureJson('noaa-scales.2026_08_01.json')
      // FLARE_ENDPOINT deliberately unstubbed -- the client throws
    })
    await scales.refresh(h.ctx)

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
    await kp.refresh(h.ctx)
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
    await solarWind.refresh(h.ctx)

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
    await solarWind.refresh(h.ctx)
    expect(h.published).toEqual([])
    expect(h.errors.length).toBe(1)
  })
})

describe('GOES flux product', () => {
  it('publishes the latest X-ray and proton channel from a captured payload', async () => {
    const h = harness({
      '/json/goes/primary/xrays-6-hour.json': fixtureJson(
        'xrays-6-hour.2026_08_20.json'
      ),
      '/json/goes/primary/integral-protons-6-hour.json': fixtureJson(
        'integral-protons-6-hour.2026_08_20.json'
      )
    })
    await goesFlux.refresh(h.ctx)

    expect(h.errors).toEqual([])
    expect(h.valueAt('environment.noaa.swpc.xray_flux')).toBeCloseTo(
      1.3730890486840508e-6,
      15
    )
    expect(h.valueAt('environment.noaa.swpc.proton_flux')).toBeCloseTo(
      2175.9319305419922,
      6
    )
  })

  it('publishes nothing at all rather than NaN when the payload is unusable', async () => {
    const h = harness({
      '/json/goes/primary/xrays-6-hour.json': [],
      '/json/goes/primary/integral-protons-6-hour.json': []
    })
    await goesFlux.refresh(h.ctx)
    expect(h.published).toEqual([])
    expect(h.errors.length).toBe(1)
  })

  it('does not rebroadcast channels that have not moved', async () => {
    const responses = {
      '/json/goes/primary/xrays-6-hour.json': fixtureJson(
        'xrays-6-hour.2026_08_20.json'
      ),
      '/json/goes/primary/integral-protons-6-hour.json': fixtureJson(
        'integral-protons-6-hour.2026_08_20.json'
      )
    }
    const h = harness(responses)
    await goesFlux.refresh(h.ctx)
    await goesFlux.refresh(h.ctx)

    expect(h.errors).toEqual([])
    expect(h.published.length).toBe(1)
  })
})

describe('f107 product', () => {
  it('publishes the latest Noon reading from a captured payload', async () => {
    const h = harness({
      '/json/f107_cm_flux.json': fixtureJson('f107_cm_flux.2026_08_06.json')
    })
    await f107.refresh(h.ctx)

    expect(h.errors).toEqual([])
    expect(h.valueAt('environment.noaa.swpc.f107')).toBe(108)
  })

  it('has a hard-coded interval, not one driven by settings', () => {
    expect(f107.intervalMinutes(settingsFrom({ updateInterval: 5 }))).toBe(240)
  })

  it('publishes nothing rather than an error-free silent gap when no Noon entry exists', async () => {
    const h = harness({ '/json/f107_cm_flux.json': [] })
    await f107.refresh(h.ctx)
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
    await outlook27.refresh(h.ctx)

    expect(h.errors).toEqual([])
    expect(h.valueAt('environment.noaa.swpc.kp.forecast.outlook27.maxKp')).toBe(
      5
    )
    expect(
      h.valueAt('environment.noaa.swpc.kp.forecast.outlook27.maxKpTime')
    ).toBe('2026-08-11T00:00:00.000Z')
    expect(
      h.valueAt('environment.noaa.swpc.kp.forecast.outlook27.maxNoaaScale')
    ).toBe(1)
    expect(
      h.valueAt('environment.noaa.swpc.kp.forecast.outlook27.nextStormTime')
    ).toBe('2026-08-11T00:00:00.000Z')
    expect(
      h.valueAt('environment.noaa.swpc.kp.forecast.outlook27.nextStormKp')
    ).toBe(5)
    expect(
      h.valueAt('environment.noaa.swpc.kp.forecast.outlook27.series')
    ).toHaveLength(27)
  })

  it('timestamps the delta with the issue time, not the fetch time', async () => {
    const h = stubbed()
    await outlook27.refresh(h.ctx)
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
    await outlook27.refresh(h.ctx)
    for (const path of h.paths()) {
      expect(path.startsWith('notifications.')).toBe(false)
    }
  })

  it('describes every path it publishes', async () => {
    const h = stubbed()
    await outlook27.refresh(h.ctx)
    const described = outlook27.metadata!(settingsFrom({})).map((m) => m.path)
    for (const path of h.paths()) expect(described).toContain(path)
  })

  it('shares the Kp forecast subtree without colliding with it', async () => {
    // The outlook hangs off the Kp forecast so that all three horizons answer
    // "what is the worst Kp coming" from one place. That only holds while the
    // two products' leaves stay disjoint, and four of them -- maxNoaaScale,
    // nextStormTime, nextStormKp and series -- are spelled identically in
    // both, separated only by the `outlook27` node. Drop that node and they
    // overwrite the 3-hourly forecast with a recurrence estimate.
    const kpPaths = kp.metadata!(settingsFrom({})).map((m) => m.path)
    const h = stubbed()
    await outlook27.refresh(h.ctx)

    expect(h.paths().length).toBeGreaterThan(0)
    for (const path of h.paths()) {
      expect(
        path.startsWith('environment.noaa.swpc.kp.forecast.outlook27.'),
        path
      ).toBe(true)
      expect(kpPaths, path).not.toContain(path)
    }
  })

  it('polls no more than once a day, whatever the settings say', () => {
    // Bandwidth: the outlook is issued weekly, so anything faster than daily
    // is paid for and thrown away. Pinned as a floor rather than an equality
    // so the interval can lengthen without a test edit, but not quietly
    // shorten.
    expect(
      outlook27.intervalMinutes(settingsFrom({ updateInterval: 5 }))
    ).toBeGreaterThanOrEqual(1440)
  })

  it('publishes nothing when the table cannot be read', async () => {
    const h = harness({ [OUTLOOK27_ENDPOINT]: ':Issued: 2026 Aug 10 0153 UTC' })
    await outlook27.refresh(h.ctx)
    expect(h.published).toEqual([])
    expect(h.errors.length).toBe(1)
  })
})

describe('a index product', () => {
  it('publishes the planetary A index from a captured bulletin', async () => {
    const h = harness({
      '/text/wwv.txt': fixture('wwv.2026_08_20.txt')
    })
    await aIndex.refresh(h.ctx)

    expect(h.errors).toEqual([])
    expect(h.valueAt('environment.noaa.swpc.a_index')).toBe(20)
    // Timestamped to the day the indices describe, not the hour the bulletin
    // was reissued: eight bulletins a day carry the same daily average.
    expect(h.published[0].timestamp).toBe('2026-08-19T00:00:00.000Z')
  })

  it('leaves the solar flux and K index to the products that own them', async () => {
    const h = harness({
      '/text/wwv.txt': fixture('wwv.2026_08_20.txt')
    })
    await aIndex.refresh(h.ctx)

    expect(h.paths()).toEqual(['environment.noaa.swpc.a_index'])
  })

  it('carries no units on a dimensionless index', () => {
    const meta = aIndex.metadata!(settingsFrom({}))[0]
    expect(meta.path).toBe('environment.noaa.swpc.a_index')
    expect(meta.value.units).toBeUndefined()
    // No zones either: a daily average of a day already past has nothing to
    // raise that the Kp forecast and the alerts have not raised sooner.
    expect(meta.value.zones).toBeUndefined()
  })

  it('does not rebroadcast a reading that has not moved', async () => {
    // Eight bulletins a day carry one daily average, and the delta is stamped
    // with the day rather than the fetch -- so a republish is the same value
    // at the same timestamp, reaching every connected client for nothing.
    const h = harness({ '/text/wwv.txt': fixture('wwv.2026_08_20.txt') })
    await aIndex.refresh(h.ctx)
    await aIndex.refresh(h.ctx)

    expect(h.errors).toEqual([])
    expect(h.paths()).toEqual(['environment.noaa.swpc.a_index'])
  })

  it('republishes an unchanged reading once the day it describes moves on', async () => {
    // A quiet spell repeats the same A for days. Suppressing on the value
    // alone would leave the timestamp on the first of them until it aged past
    // `timeout` and a client nulled a reading that was still current.
    const wwv = fixture('wwv.2026_08_20.txt')
    const h = harness({ '/text/wwv.txt': wwv })
    await aIndex.refresh(h.ctx)

    h.client.text = async () =>
      wwv
        .replace('indices for 19 August', 'indices for 20 August')
        .replace('2026 Aug 20 0305 UTC', '2026 Aug 21 0305 UTC')
    await aIndex.refresh(h.ctx)

    expect(h.published.map((p) => p.timestamp)).toEqual([
      '2026-08-19T00:00:00.000Z',
      '2026-08-20T00:00:00.000Z'
    ])
    expect(h.published.every((p) => p.values[0].value === 20)).toBe(true)
  })

  it('declares a timeout that outlives the reading it stamps', async () => {
    // The delta is dated to the day the bulletin describes, so by the last
    // bulletin of the following day it is already near 48h old -- and the
    // next poll is an interval after that. A timeout inside that window makes
    // a compliant client null a value that is perfectly current.
    const h = harness({ '/text/wwv.txt': fixture('wwv.2026_08_20.txt') })
    await aIndex.refresh(h.ctx)

    const stampedAt = Date.parse(h.published[0].timestamp)
    const lastRepublish =
      stampedAt +
      48 * 60 * 60 * 1000 +
      aIndex.intervalMinutes(settingsFrom({})) * 60 * 1000
    const timeout = aIndex.metadata!(settingsFrom({}))[0].value.timeout
    expect(timeout * 1000).toBeGreaterThan(lastRepublish - stampedAt)
  })

  it('reports an unreadable bulletin instead of publishing nothing quietly', async () => {
    const h = harness({ '/text/wwv.txt': 'no indices here' })
    await aIndex.refresh(h.ctx)

    expect(h.paths()).toEqual([])
    expect(h.errors.length).toBeGreaterThan(0)
  })
})

describe('sunspot product', () => {
  it('publishes the newest daily sunspot number from a captured payload', async () => {
    const h = harness({
      '/text/daily-solar-indices.txt': fixture(
        'daily-solar-indices.2026_08_20.txt'
      )
    })
    await sunspot.refresh(h.ctx)

    expect(h.errors).toEqual([])
    expect(h.valueAt('environment.noaa.swpc.sunspot_number')).toBe(78)
    expect(h.published[0].timestamp).toBe('2026-08-19T00:00:00.000Z')
  })

  it('carries no units on a dimensionless count', () => {
    const meta = sunspot.metadata!(settingsFrom({}))[0]
    expect(meta.path).toBe('environment.noaa.swpc.sunspot_number')
    expect(meta.value.units).toBeUndefined()
    // And no zones, pinned the same way the A index pins it: a monthly-scale
    // number has nothing to raise on the timescale a notification is for.
    expect(meta.value.zones).toBeUndefined()
  })

  it('does not rebroadcast a row that has not moved', async () => {
    const payload = fixture('daily-solar-indices.2026_08_20.txt')
    const h = harness({ '/text/daily-solar-indices.txt': payload })
    await sunspot.refresh(h.ctx)
    await sunspot.refresh(h.ctx)

    expect(h.errors).toEqual([])
    expect(h.paths()).toEqual(['environment.noaa.swpc.sunspot_number'])
  })

  it('republishes an unchanged row once the day moves on', async () => {
    // Same argument as the A index: the day is half the comparison.
    const payload = fixture('daily-solar-indices.2026_08_20.txt')
    const h = harness({ '/text/daily-solar-indices.txt': payload })
    await sunspot.refresh(h.ctx)

    h.client.text = async () =>
      payload + '2026 08 20  126     78      560   1\n'
    await sunspot.refresh(h.ctx)

    expect(h.published.map((p) => p.timestamp)).toEqual([
      '2026-08-19T00:00:00.000Z',
      '2026-08-20T00:00:00.000Z'
    ])
    expect(h.published.every((p) => p.values[0].value === 78)).toBe(true)
  })

  it('declares a timeout that outlives the reading it stamps', () => {
    // Same argument as the A index: one row a day, dated to that day.
    const timeout = sunspot.metadata!(settingsFrom({}))[0].value.timeout
    const worstCaseAgeSeconds =
      48 * 60 * 60 + sunspot.intervalMinutes(settingsFrom({})) * 60
    expect(timeout).toBeGreaterThan(worstCaseAgeSeconds)
  })

  it('reports a payload with no usable rows instead of throwing', async () => {
    const h = harness({ '/text/daily-solar-indices.txt': '# header only\n' })
    await sunspot.refresh(h.ctx)

    expect(h.paths()).toEqual([])
    expect(h.errors.length).toBeGreaterThan(0)
  })
})
