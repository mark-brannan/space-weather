import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseAdvisoryOutlook,
  parseAlert,
  parseIssueDate,
  parseKpForecast,
  parseSolarWind,
  transformJsonScaleRange,
  zonesForKp,
  zonesForScale
} from '../src/parse'
import {
  ADVISORY_FIXTURES,
  ALERT_FIXTURES,
  KP_FORECAST_FIXTURES,
  SCALES_FIXTURES,
  fixture,
  fixtureJson
} from './fixtures'

/**
 * The Signal K plugin registry runs this suite inside `firejail --net=none`
 * with a 60 second budget. A test that reaches for NOAA would not merely be
 * slow -- it would fail there while passing locally, which is the worst
 * failure mode to debug. This guard makes that impossible to introduce
 * accidentally: any network call during a parse becomes a test failure here
 * rather than a red CI run somewhere else.
 */
describe('parsing is entirely offline', () => {
  let attempted: string[]

  beforeEach(() => {
    attempted = []
    const forbid = (...args: any[]) => {
      attempted.push(String(args[0]))
      throw new Error(`network access attempted: ${args[0]}`)
    }
    vi.stubGlobal('fetch', forbid)
    vi.stubGlobal('XMLHttpRequest', undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses every captured payload with no network available', () => {
    for (const name of ADVISORY_FIXTURES) {
      const text = fixture(name)
      expect(parseIssueDate(text)).toBeInstanceOf(Date)
      expect(parseAdvisoryOutlook(text)).not.toBeNull()
    }

    for (const name of ALERT_FIXTURES) {
      for (const alert of fixtureJson(name)) {
        expect(parseAlert(alert)).not.toBeNull()
      }
    }

    for (const name of SCALES_FIXTURES) {
      const scales = fixtureJson(name)
      for (const index of ['-1', '0', '1', '2', '3']) {
        expect(
          transformJsonScaleRange(scales[index], 'base', index === '-1' || index === '0')
            .length
        ).toBeGreaterThan(0)
      }
    }

    for (const name of KP_FORECAST_FIXTURES) {
      expect(parseKpForecast(fixtureJson(name)).max72h).not.toBeUndefined()
    }

    parseSolarWind(
      fixtureJson('solar-wind-speed.2026_08_01.json'),
      fixtureJson('solar-wind-mag-field.2026_08_01.json')
    )
    zonesForScale('G')
    zonesForKp()

    expect(attempted).toEqual([])
  })

  it('fails loudly if anything does reach for the network', () => {
    // Proves the guard itself works rather than silently passing.
    expect(() => (globalThis.fetch as any)('https://services.swpc.noaa.gov')).toThrow(
      /network access attempted/
    )
  })
})
