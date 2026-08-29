import { describe, expect, it } from 'vitest'
import {
  NoaaScaleValues,
  drapFrequencyAt,
  firstJsonValue,
  getAlertLevel,
  parse27DayOutlook,
  parseAdvisoryOutlook,
  parseAlert,
  parseDailySolarIndices,
  parseDrapGrid,
  parseF107,
  parseGoesFlux,
  parseGeophysicalAlert,
  fluxForFlareClass,
  gScaleForKp,
  parseIssueDate,
  parseKpForecast,
  parseSolarWind,
  parseXrayFlare,
  parseXrayFlarePeak,
  percentToRatio,
  transformJsonScaleRange,
  xrayFluxTrend
} from '../src/parse'
import {
  ADVISORY_FIXTURES,
  ALERT_FIXTURES,
  KP_FORECAST_FIXTURES,
  OUTLOOK27_CORRECTED_FIXTURE,
  OUTLOOK27_CORRUPT_FIXTURE,
  OUTLOOK27_FIXTURES,
  SCALES_FIXTURES,
  fixture,
  fixtureJson
} from './fixtures'

describe('parseIssueDate', () => {
  it('reads the :Issued: line as UTC', () => {
    expect(
      parseIssueDate(fixture('advisory-outlook.2026_08_01.txt'))?.toISOString()
    ).toBe('2026-07-27T01:00:00.000Z')
  })

  it('zero-pads a short time field', () => {
    // ":Issued: 2025 Apr 14 0145 UTC" -- the hour is not zero-padded in the
    // source and has to be rewritten to 01:45 before Date can read it.
    expect(
      parseIssueDate(fixture('advisory-outlook.2025_04_14.txt'))?.toISOString()
    ).toBe('2025-04-14T01:45:00.000Z')
  })

  it('parses every captured advisory', () => {
    for (const name of ADVISORY_FIXTURES) {
      expect(parseIssueDate(fixture(name)), name).toBeInstanceOf(Date)
    }
  })

  it('returns null rather than throwing on unparseable input', () => {
    expect(parseIssueDate('')).toBeNull()
    expect(parseIssueDate('\n:Issued: not a date at all\n')).toBeNull()
  })
})

describe('parseAdvisoryOutlook', () => {
  it('extracts the advisory serial and issue time', () => {
    const outlook = parseAdvisoryOutlook(
      fixture('advisory-outlook.2026_08_01.txt')
    )
    expect(outlook?.shortId).toBe('#26-29')
    expect(outlook?.issued.toISOString()).toBe('2026-07-27T01:00:00.000Z')
  })

  it('yields a Signal K path segment with no whitespace', () => {
    // shortId is concatenated into a delta path, so a stray space would
    // produce an unaddressable path.
    for (const name of ADVISORY_FIXTURES) {
      const outlook = parseAdvisoryOutlook(fixture(name))
      expect(outlook, name).not.toBeNull()
      expect(outlook!.shortId, name).not.toMatch(/\s/)
    }
  })

  it('returns null on input that is not an advisory', () => {
    expect(parseAdvisoryOutlook('nothing to see here')).toBeNull()
  })

  it('extracts the first sentence of the Outlook For section as a teaser', () => {
    const outlook = parseAdvisoryOutlook(
      fixture('advisory-outlook.2026_08_03.txt')
    )
    expect(outlook?.outlookTeaser).toBe(
      'G1 (Minor) storms are expected on 03 Aug  (due to a CME persistent' +
        ' and waning disturbances) and likely on 19 Aug (due to a recurrent' +
        ' high speed stream).'
    )
  })

  it('finds a teaser in every captured advisory', () => {
    for (const name of ADVISORY_FIXTURES) {
      const outlook = parseAdvisoryOutlook(fixture(name))
      expect(outlook?.outlookTeaser, name).toBeTruthy()
    }
  })
})

describe('getAlertLevel', () => {
  it.each([
    ['ALTEF3', 'ALERT'],
    ['WARK04', 'WARNING'],
    ['WATA20', 'WATCH'],
    ['SUMXM5', 'SUMMARY'],
    ['ZZZ999', 'ALERT']
  ])('%s -> %s', (code, expected) => {
    expect(getAlertLevel(code)).toBe(expected)
  })
})

describe('parseAlert', () => {
  it('parses every alert in every captured payload', () => {
    for (const name of ALERT_FIXTURES) {
      const alerts = fixtureJson(name)
      expect(alerts.length, name).toBeGreaterThan(0)
      for (const alert of alerts) {
        const parsed = parseAlert(alert)
        expect(parsed, `${name} ${alert.product_id}`).not.toBeNull()
        expect(parsed!.serialNumber).toMatch(/^[0-9]+$/)
        expect(parsed!.mainMessage.length).toBeGreaterThan(0)
        expect(parsed!.issued.getTime()).not.toBeNaN()
      }
    }
  })

  it('never falls back to the unparsed-headline sentinel', () => {
    for (const name of ALERT_FIXTURES) {
      for (const alert of fixtureJson(name)) {
        expect(parseAlert(alert)!.mainMessage).not.toContain('parsing failure')
      }
    }
  })

  it('raises alert state strictly according to the threshold', () => {
    // Regression guard. Until 0.2.0 the state and scale locals were shadowed by
    // a `const` inside the scale-line branch, so every alert shipped
    // state="normal" and scale="" and the threshold did nothing at all. If that
    // returns, all three counts collapse to zero.
    for (const name of ALERT_FIXTURES) {
      const alerts = fixtureJson(name)
      const raisedAt = (threshold: number) =>
        alerts.filter((a: any) => parseAlert(a, threshold)!.state !== 'normal')
          .length

      expect(raisedAt(1), name).toBeGreaterThan(0)
      expect(raisedAt(1), name).toBeGreaterThanOrEqual(raisedAt(3))
      expect(raisedAt(3), name).toBeGreaterThan(raisedAt(5))
    }
  })

  it('grades a scale value through the same ladder the zones use', () => {
    // The alert/watch/warning product used to collapse everything at or above
    // the threshold to `alert` and then attach visual+sound to it regardless,
    // so an S1 and an S5 were equally loud (issue #45). A NOAA level has to
    // read the same whether it arrives as a message or as a zone transition.
    const at = (scale: number) =>
      parseAlert(
        {
          product_id: 'test',
          issue_datetime: '2026-08-01 12:00:00.000',
          message:
            'Space Weather Message Code: ALTK07\nSerial Number: 1\n' +
            'Issue Time: 2026 Aug 01 1200 UTC\n\nALERT: test\n' +
            `NOAA Scale: G${scale} - test\n`
        },
        5
      )!.state

    expect(at(1)).toBe('normal')
    expect(at(2)).toBe('normal')
    expect(at(3)).toBe('alert')
    expect(at(4)).toBe('warn')
    expect(at(5)).toBe('alarm')
  })

  it('leaves a message with no scale line at normal', () => {
    // The screenshot on issue #45 is one of these: "ALERT: Electron 2MeV
    // Integral Flux exceeded 1000pfu" carries no NOAA scale at all, and there
    // are more of them in a payload than there are scaled messages. They are
    // informational, and must not be graded as though they were severe.
    const unscaled = fixtureJson('alerts.2026_08_01.json')
      .map((a: any) => parseAlert(a)!)
      .filter((p: any) => p.scaleValue === null)

    expect(unscaled.length).toBeGreaterThan(0)
    for (const parsed of unscaled) {
      expect(parsed.state, parsed.messageCode).toBe('normal')
    }
  })

  it('populates scale text whenever the payload carries a scale line', () => {
    for (const name of ALERT_FIXTURES) {
      for (const alert of fixtureJson(name)) {
        const parsed = parseAlert(alert)!
        if (/NOAA Scale: *[GSR][0-9]/.test(alert.message)) {
          expect(parsed.scaleText, alert.product_id).toMatch(/^[GSR][0-9]/)
          expect(parsed.scaleValue).not.toBeNull()
        } else {
          expect(parsed.scaleText).toBe('')
          expect(parsed.scaleValue).toBeNull()
        }
      }
    }
  })

  it('keeps scale text on one line', () => {
    // "NOAA Scale: G3 or greater - Strong to Extreme" is followed by a
    // boilerplate paragraph that an unbounded match swallowed whole.
    const withOrGreater = fixtureJson('alerts.2025_04_17.json')
      .map((a: any) => parseAlert(a)!)
      .filter((p: any) => p.scaleText.includes('or greater'))

    expect(withOrGreater.length).toBeGreaterThan(0)
    for (const parsed of withOrGreater) {
      expect(parsed.scaleText).not.toContain('\n')
      expect(parsed.scaleValue).toBe(NoaaScaleValues.STRONG)
    }
  })

  it('grades "or greater" at the level NOAA stated, not above it', () => {
    const parsed = parseAlert({
      product_id: 'test',
      issue_datetime: '2025-04-17 12:00:00.000',
      message:
        'Space Weather Message Code: WATA50\nSerial Number: 1\nIssue Time: 2025 Apr 17 1200 UTC\n\nWATCH: Geomagnetic Storm Category G3 Predicted\n\nNOAA Scale: G3 or greater - Strong to Extreme\n'
    })!
    // "or greater" is a floor NOAA is asserting, not a ceiling it is
    // predicting. Grading it EXTREME makes this hedged forecast sound an alarm
    // while an observed G4 only reaches warn.
    expect(parsed.scaleValue).toBe(NoaaScaleValues.STRONG)
    expect(parsed.state).toBe('alert')
    expect(parsed.scaleText).toBe('G3 or greater')
  })

  it('never grades a forecast above an observation of the same level', () => {
    const at = (scaleText: string) =>
      parseAlert({
        product_id: 'test',
        issue_datetime: '2025-04-17 12:00:00.000',
        message:
          'Space Weather Message Code: WATA50\nSerial Number: 1\nIssue Time: 2025 Apr 17 1200 UTC\n\nWATCH: test\n\nNOAA Scale: ' +
          scaleText +
          '\n'
      })!.state

    expect(at('G3 or greater - Strong to Extreme')).toBe('alert')
    expect(at('G4 - Severe')).toBe('warn')
    expect(at('G5 - Extreme')).toBe('alarm')
  })

  it('returns null instead of throwing on malformed entries', () => {
    expect(parseAlert(null)).toBeNull()
    expect(parseAlert({})).toBeNull()
    expect(parseAlert({ message: 'no serial number here' })).toBeNull()
    expect(
      parseAlert({
        message: 'Serial Number: 1\nSpace Weather Message Code: ALTEF3',
        issue_datetime: 'nonsense'
      })
    ).toBeNull()
  })
})

describe('transformJsonScaleRange', () => {
  it('emits scalar G/S/R levels for observations', () => {
    const scales = fixtureJson('noaa-scales.2026_08_01.json')
    const updates = transformJsonScaleRange(scales['0'], 'base', true)
    const byPath = Object.fromEntries(updates.map((u) => [u.path, u.value]))

    expect(byPath['base.time']).toBe('2026-08-01T07:47:00Z')
    for (const letter of ['G', 'S', 'R']) {
      expect(typeof byPath[`base.${letter}`], letter).toBe('number')
      expect(byPath[`base.${letter}`]).toBeGreaterThanOrEqual(0)
      expect(byPath[`base.${letter}`]).toBeLessThanOrEqual(5)
    }
  })

  it('emits probabilities on their own leaf paths for forecasts', () => {
    // Forecast S and R carry no Scale at all -- only probabilities -- and those
    // used to be published as nested object values that consumers could not
    // subscribe to individually.
    const scales = fixtureJson('noaa-scales.2026_08_01.json')
    const updates = transformJsonScaleRange(scales['1'], 'base', false)
    const byPath = Object.fromEntries(updates.map((u) => [u.path, u.value]))

    expect(Object.keys(byPath).sort()).toEqual([
      'base.G',
      'base.R.majorProbability',
      'base.R.minorProbability',
      'base.S.probability',
      'base.time'
    ])
    expect(typeof byPath['base.G']).toBe('number')
    for (const value of Object.values(byPath)) {
      expect(value).not.toBeNaN()
    }
  })

  it('never yields NaN on a scalar level, in any captured payload', () => {
    // NOAA changed the solar wind summaries from {"Bt":5} to [{"bt":4}] and the
    // old accessors became `undefined * 1`, publishing NaN for months. A shape
    // change is silent, so the guard has to sweep every capture. The
    // probability sweep above covers the probability paths and skips the rest,
    // which leaves the scalar G/S/R levels -- and the observed variant -- unheld.
    let checked = 0
    for (const name of SCALES_FIXTURES) {
      const scales = fixtureJson(name)
      for (const index of ['1', '2', '3']) {
        if (!scales[index]) continue
        for (const observed of [true, false]) {
          for (const update of transformJsonScaleRange(
            scales[index],
            'base',
            observed
          )) {
            if (update.path.includes('robability')) continue
            checked++
            expect(update.value, `${name} ${update.path}`).not.toBeNaN()
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('converts percentages to ratios', () => {
    const scales = fixtureJson('noaa-scales.2026_08_01.json')
    // The captured payload reads S Prob "75", R MinorProb "35", MajorProb "5".
    const byPath = Object.fromEntries(
      transformJsonScaleRange(scales['1'], 'base', false).map((u) => [
        u.path,
        u.value
      ])
    )
    expect(byPath['base.S.probability']).toBeCloseTo(0.75, 10)
    expect(byPath['base.R.minorProbability']).toBeCloseTo(0.35, 10)
    expect(byPath['base.R.majorProbability']).toBeCloseTo(0.05, 10)
  })

  it('keeps every probability within 0..1 across all captured payloads', () => {
    for (const name of SCALES_FIXTURES) {
      const scales = fixtureJson(name)
      for (const index of ['1', '2', '3']) {
        if (!scales[index]) continue
        for (const update of transformJsonScaleRange(
          scales[index],
          'base',
          false
        )) {
          if (!update.path.includes('robability')) continue
          if (update.value === null) continue
          expect(update.value, `${name} ${update.path}`).toBeGreaterThanOrEqual(
            0
          )
          expect(update.value, `${name} ${update.path}`).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('yields null rather than NaN for absent values', () => {
    const updates = transformJsonScaleRange(
      {
        DateStamp: '2026-01-01',
        TimeStamp: '00:00:00',
        G: { Scale: null },
        S: { Prob: null },
        R: { MinorProb: null, MajorProb: null }
      },
      'base',
      false
    )
    for (const update of updates) {
      if (update.path === 'base.time') continue
      expect(update.value, update.path).toBeNull()
    }
  })

  it('parses all five ranges of every captured payload', () => {
    for (const name of SCALES_FIXTURES) {
      const scales = fixtureJson(name)
      for (const [index, isObservation] of [
        ['-1', true],
        ['0', true],
        ['1', false],
        ['2', false],
        ['3', false]
      ] as [string, boolean][]) {
        expect(scales[index], `${name} index ${index}`).toBeTruthy()
        const updates = transformJsonScaleRange(
          scales[index],
          'base',
          isObservation
        )
        expect(updates.length, `${name} ${index}`).toBeGreaterThan(1)
        expect(updates[0].path).toBe('base.time')
        expect(String(updates[0].value)).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
        )
      }
    }
  })
})

describe('percentToRatio', () => {
  it.each([
    ['75', 0.75],
    ['5', 0.05],
    ['0', 0],
    [null, null],
    [undefined, null],
    ['', null],
    ['not a number', null]
  ])('%s -> %s', (input, expected) => {
    const actual = percentToRatio(input)
    if (expected === null) expect(actual).toBeNull()
    else expect(actual).toBeCloseTo(expected as number, 10)
  })
})

describe('parseXrayFlare', () => {
  it("reads the flare's own peak, not the background flux at poll time", () => {
    // Issue #122: this payload's `current_class` is B3.3 -- the background
    // flux when NOAA wrote the file -- while the flare it describes peaked at
    // B4.6 four hours earlier. Publishing the former under a heading that
    // reads as "the flare" is the defect.
    const flare = parseXrayFlare(
      fixtureJson('xray-flares-latest.2026_08_06.json')
    )
    expect(flare).toEqual({ flareClass: 'B4.6', time: '2026-08-05T23:53:00Z' })
  })

  it('reads the peak on the day #122 was measured', () => {
    const flare = parseXrayFlare(
      fixtureJson('xray-flares-latest.2026_08_25.json')
    )
    expect(flare?.flareClass).toBe('C4.7')
  })

  it('falls back to the current class when NOAA sends no peak', () => {
    expect(
      parseXrayFlare([
        { current_class: 'M2.1', time_tag: '2026-08-06T03:46:00Z' }
      ])
    ).toEqual({ flareClass: 'M2.1', time: '2026-08-06T03:46:00Z' })
  })

  it('rejects a class that is not one, on either field', () => {
    // The only free string this plugin publishes, so it is validated where it
    // enters rather than escaped where it is drawn -- a consumer that is not
    // this plugin's own page gets the same guarantee.
    const time = '2026-08-06T03:46:00Z'
    for (const bad of ['<img src=x onerror=alert(1)>', 'Q1', 'M-1', '  ']) {
      expect(parseXrayFlare([{ max_class: bad, max_time: time }])).toBeNull()
      expect(
        parseXrayFlare([{ current_class: bad, time_tag: time }])
      ).toBeNull()
    }
    // A bare letter is NOAA's own way of writing the decade boundary.
    expect(parseXrayFlare([{ max_class: ' M ', max_time: time }])).toEqual({
      flareClass: 'M',
      time
    })
  })

  it('returns null rather than throwing on unusable input', () => {
    for (const input of [null, undefined, {}, [], [{}], 'nope']) {
      expect(parseXrayFlare(input as any)).toBeNull()
    }
  })

  it('returns null when both classes are present but empty', () => {
    expect(
      parseXrayFlare([
        { max_class: '', current_class: '', time_tag: '2026-08-06T03:46:00Z' }
      ])
    ).toBeNull()
  })

  it('returns null when neither reading carries a time', () => {
    expect(parseXrayFlare([{ max_class: 'M2.1' }])).toBeNull()
    expect(parseXrayFlare([{ current_class: 'M2.1' }])).toBeNull()
  })
})

describe('fluxForFlareClass', () => {
  it.each([
    ['M1', 1e-5],
    ['M6.9', 6.9e-5],
    ['X1.0', 1e-4],
    ['M9.9', 9.9e-5],
    ['B4.6', 4.6e-7],
    // NOAA writes a bare letter for the decade boundary.
    ['X', 1e-4]
  ])('%s -> %s W/m2', (input, expected) => {
    expect(fluxForFlareClass(input)!).toBeCloseTo(expected, 12)
  })

  it('orders M9.9 below X1.0, which string comparison does not', () => {
    expect('M9.9' > 'X1.0').toBe(false)
    expect(fluxForFlareClass('M9.9')!).toBeLessThan(fluxForFlareClass('X1.0')!)
  })

  it('returns null for anything that is not a class', () => {
    for (const input of ['', 'Q1', 'M-1', 'nope', null, undefined])
      expect(fluxForFlareClass(input)).toBeNull()
  })
})

describe('parseXrayFlarePeak', () => {
  const week = () => fixtureJson('xray-flares-7-day.2026_08_26.json')

  it('picks the strongest flare inside the window, not the newest', () => {
    const peak = parseXrayFlarePeak(week(), new Date('2026-08-26T06:00:00Z'))
    // The M6.9 of the 25th, over a C1.2 that peaked five hours before `now`.
    expect(peak).toEqual({
      flareClass: 'M6.9',
      time: '2026-08-25T10:02:00Z'
    })
  })

  it('moves the answer when the window moves', () => {
    // Same file, a window ending before that M6.9 began.
    expect(
      parseXrayFlarePeak(week(), new Date('2026-08-25T09:00:00Z'))?.flareClass
    ).toBe('M1.9')
    // And one covering the M8.1 of the 20th instead.
    expect(
      parseXrayFlarePeak(week(), new Date('2026-08-20T18:00:00Z'))?.flareClass
    ).toBe('M8.1')
  })

  it('returns null for a window with no flare in it', () => {
    // The week's own leading edge: this file's first record peaked at
    // 04:54 on the 19th, so a window ending at 04:00 contains none of it.
    expect(
      parseXrayFlarePeak(week(), new Date('2026-08-19T04:00:00Z'))
    ).toBeNull()
  })

  it('never reaches forward past `now`', () => {
    // The window is a past 24 hours, so a file whose later records postdate
    // the clock must not contribute one.
    expect(
      parseXrayFlarePeak(week(), new Date('2026-08-19T12:00:00Z'))?.flareClass
    ).toBe('C5.0')
  })

  it('ranks on the class when NOAA sends no max_xrlong', () => {
    const stripped = week().map(
      ({ max_xrlong, ...rest }: Record<string, unknown>) => rest
    )
    expect(
      parseXrayFlarePeak(stripped, new Date('2026-08-26T06:00:00Z'))?.flareClass
    ).toBe('M6.9')
  })

  it('returns null rather than throwing on unusable input', () => {
    const now = new Date('2026-08-26T06:00:00Z')
    for (const input of [null, undefined, {}, [], [{}], 'nope'])
      expect(parseXrayFlarePeak(input, now)).toBeNull()
  })
})

describe('xrayFluxTrend', () => {
  const quiet = () => fixtureJson('xrays-6-hour.2026_08_20.json')

  it('reads a quiet sky as neither rising nor falling', () => {
    const trend = xrayFluxTrend(quiet())!
    expect(trend.ratio).toBeGreaterThan(0.8)
    expect(trend.ratio).toBeLessThan(1.25)
    // Anchored on the newest sample, not the wall clock.
    expect(trend.time).toBe('2026-08-20T04:42:00.000Z')
  })

  it('reads a rise as a ratio above 1 and a decay as one below', () => {
    const at = (minutesAgo: number, flux: number) => ({
      time_tag: new Date(
        Date.parse('2026-08-20T05:00:00Z') - minutesAgo * 60_000
      ).toISOString(),
      energy: '0.1-0.8nm',
      flux
    })
    const ramp = (factor: number) =>
      Array.from({ length: 30 }, (_, i) => at(i, 1e-6 * factor ** (29 - i)))

    expect(xrayFluxTrend(ramp(1.1))!.ratio).toBeGreaterThan(3)
    expect(xrayFluxTrend(ramp(1 / 1.1))!.ratio).toBeLessThan(1 / 3)
  })

  it('reports no trend rather than a flat one when a window is empty', () => {
    // Only the recent window is populated; the half hour behind it is a gap,
    // which is not the same measurement as "unchanged".
    const only = quiet().filter(
      (r) => Date.parse(r.time_tag) > Date.parse('2026-08-20T04:28:00Z')
    )
    expect(xrayFluxTrend(only)).toBeNull()
  })

  it('ignores the other energy channel', () => {
    const short = quiet().filter((r) => r.energy !== '0.1-0.8nm')
    expect(xrayFluxTrend(short)).toBeNull()
  })

  it('returns null rather than throwing on unusable input', () => {
    for (const input of [null, undefined, {}, [], [{}], 'nope'])
      expect(xrayFluxTrend(input)).toBeNull()
  })
})

describe('parseF107', () => {
  it('reads the latest Noon reading from a captured payload', () => {
    const flux = parseF107(fixtureJson('f107_cm_flux.2026_08_06.json'))
    expect(flux).toEqual({ flux: 108, time: '2026-08-05T20:00:00' })
  })

  it('ignores Morning and Afternoon readings even if newer', () => {
    const flux = parseF107([
      {
        reporting_schedule: 'Morning',
        flux: 999,
        time_tag: '2026-08-07T17:00:00'
      },
      { reporting_schedule: 'Noon', flux: 108, time_tag: '2026-08-05T20:00:00' }
    ])
    expect(flux).toEqual({ flux: 108, time: '2026-08-05T20:00:00' })
  })

  it('picks the newest Noon entry regardless of array order', () => {
    const flux = parseF107([
      {
        reporting_schedule: 'Noon',
        flux: 100,
        time_tag: '2026-07-01T20:00:00'
      },
      { reporting_schedule: 'Noon', flux: 108, time_tag: '2026-08-05T20:00:00' }
    ])
    expect(flux).toEqual({ flux: 108, time: '2026-08-05T20:00:00' })
  })

  it('returns null rather than throwing on unusable input', () => {
    for (const input of [null, undefined, {}, [], [{}], 'nope']) {
      expect(parseF107(input as any)).toBeNull()
    }
  })

  it('returns null when no Noon entry is present', () => {
    expect(
      parseF107([
        {
          reporting_schedule: 'Morning',
          flux: 101,
          time_tag: '2026-08-06T17:00:00'
        }
      ])
    ).toBeNull()
  })
})

describe('parseKpForecast', () => {
  const fixtureName = 'noaa-planetary-k-index-forecast.2026_08_01.json'

  it('summarises observed and forecast Kp relative to a given moment', () => {
    const summary = parseKpForecast(
      fixtureJson(fixtureName),
      new Date('2026-08-01T07:00:00Z')
    )
    // 06:00 is in the past at this anchor but NOAA marks it `estimated`, so
    // the last measurement is the 03:00 row.
    expect(summary.observed).toBe(1)
    expect(summary.observedTime).toBe('2026-08-01T03:00:00.000Z')
    expect(summary.max24h).toBeCloseTo(5.67, 5)
    expect(summary.max72h).toBeCloseTo(5.67, 5)
    // 5.67 is 6-, the bottom of NOAA's Kp 6 band, so G2 rather than G1.
    expect(summary.maxNoaaScale).toBe(2)
    expect(summary.nextStormTime).toBe('2026-08-02T06:00:00.000Z')
    expect(summary.nextStormKp).toBeCloseTo(5.67, 5)
  })

  it('bounds the series to 24h in the past through 72h ahead', () => {
    const summary = parseKpForecast(
      fixtureJson(fixtureName),
      new Date('2026-08-01T07:00:00Z')
    )
    expect(summary.series.length).toBe(30)
    // First point is the oldest still within the 24h lookback, not the
    // fixture's full ~7-day history.
    expect(summary.series[0]).toEqual({
      time: '2026-07-31T09:00:00.000Z',
      kp: 1.67,
      forecast: false
    })
    expect(summary.series[summary.series.length - 1].forecast).toBe(true)
    // The 06:00 point is `estimated` -- drawn as forecast even though its
    // timestamp is behind the anchor.
    expect(summary.series.filter((p) => p.forecast).length).toBe(23)
    expect(summary.series.filter((p) => !p.forecast).length).toBe(7)
  })

  it('sorts the series and never produces NaN', () => {
    for (const name of KP_FORECAST_FIXTURES) {
      const summary = parseKpForecast(fixtureJson(name))
      for (let i = 0; i < summary.series.length; i++) {
        expect(Number.isFinite(summary.series[i].kp), name).toBe(true)
        if (i > 0) {
          expect(
            new Date(summary.series[i].time).getTime(),
            name
          ).toBeGreaterThanOrEqual(
            new Date(summary.series[i - 1].time).getTime()
          )
        }
      }
    }
  })

  it('never publishes a forecast row as the observation', () => {
    // The payload behind the 5.67-vs-4.33 report: NOAA marks the whole current
    // UTC day `estimated`, so at 01:51Z the 00:00 row -- a G2 forecast -- was
    // already in the past. Reading the latest row by time alone published it
    // as observed while NOAA's own site showed the measured Kp at G0.
    const summary = parseKpForecast(
      fixtureJson('noaa-planetary-k-index-forecast.2026_08_29.json'),
      new Date('2026-08-29T01:51:00Z')
    )
    expect(summary.observed).toBeCloseTo(4.33, 5)
    expect(summary.observedTime).toBe('2026-08-28T21:00:00.000Z')
    expect(gScaleForKp(summary.observed!)).toBe(NoaaScaleValues.NONE)
    // The forecast peak is still the storm -- only the observation was wrong.
    expect(summary.max24h).toBeCloseTo(5.67, 5)
    const current = summary.series.find(
      (point) => point.time === '2026-08-29T00:00:00.000Z'
    )
    expect(current?.forecast).toBe(true)
    // The bin in progress is the onset, and it is still running at 01:51.
    expect(summary.nextStormTime).toBe('2026-08-29T00:00:00.000Z')
  })

  it('drops an estimated bin that has already run, rather than calling it ahead', () => {
    // NOAA's `observed` column lags, and can stall: at 21:00Z most of the
    // day's rows are still marked `estimated` while being hours in the past.
    // Read as forecast, the 00:00 G2 would be published as the *next* storm
    // onset -- 21 hours behind the boat.
    const summary = parseKpForecast(
      fixtureJson('noaa-planetary-k-index-forecast.2026_08_29.json'),
      new Date('2026-08-29T21:30:00Z')
    )
    expect(summary.nextStormTime).toBeNull()
    expect(summary.max24h).toBeCloseTo(3.67, 5)
    // The elapsed bins are still drawn -- only the forward-looking numbers
    // refuse them.
    expect(
      summary.series.find((p) => p.time === '2026-08-29T00:00:00.000Z')
        ?.forecast
    ).toBe(true)
  })

  it('returns an empty series rather than throwing on malformed input', () => {
    for (const input of [null, undefined, {}, 'nope', []]) {
      expect(parseKpForecast(input as any).series).toEqual([])
    }
  })

  it('narrows the windows as the reference moment moves earlier', () => {
    const summary = parseKpForecast(
      fixtureJson(fixtureName),
      new Date('2026-07-26T00:00:00Z')
    )
    expect(summary.max24h).toBeLessThanOrEqual(summary.max72h!)
    expect(summary.observedTime).toBe('2026-07-26T00:00:00.000Z')
  })

  it('reads both the tabular and record payload shapes', () => {
    // NOAA has served this product as a header-row table with space-separated
    // timestamps and as a list of records with ISO-style ones. The captured
    // payloads cover both, and a summary from either must be usable.
    const table = fixtureJson('noaa-planetary-k-index-forecast.2025_04_10.json')
    const records = fixtureJson(
      'noaa-planetary-k-index-forecast.2026_08_01.json'
    )
    expect(Array.isArray(table[0])).toBe(true)
    expect(Array.isArray(records[0])).toBe(false)

    const fromTable = parseKpForecast(table, new Date('2025-04-03T00:00:00Z'))
    expect(fromTable.observed).toBeCloseTo(3.67, 5)
    expect(fromTable.observedTime).toBe('2025-04-03T00:00:00.000Z')
    expect(fromTable.max72h).toBeCloseTo(5.67, 5)

    const fromRecords = parseKpForecast(
      records,
      new Date('2026-07-25T00:00:00Z')
    )
    expect(fromRecords.observed).toBeCloseTo(1, 5)
    expect(fromRecords.observedTime).toBe('2026-07-25T00:00:00.000Z')
  })

  it('does not mistake the header row for data', () => {
    const table = fixtureJson('noaa-planetary-k-index-forecast.2025_04_10.json')
    const summary = parseKpForecast(table, new Date('2030-01-01T00:00:00Z'))
    // Everything is in the past at that anchor, so the last row wins; the
    // header row would have produced NaN and been dropped.
    expect(summary.observed).not.toBeNull()
    expect(Number.isFinite(summary.observed!)).toBe(true)
  })

  it('keeps max24h no greater than max72h for every captured payload', () => {
    for (const name of KP_FORECAST_FIXTURES) {
      const rows = fixtureJson(name)
      const first = Array.isArray(rows[0]) ? rows[1][0] : rows[0].time_tag
      const anchor = new Date(String(first).replace(' ', 'T') + 'Z')
      const summary = parseKpForecast(rows, anchor)
      expect(summary.max72h, name).not.toBeNull()
      expect(summary.max24h!, name).toBeLessThanOrEqual(summary.max72h!)
      expect(summary.maxNoaaScale, name).toBeGreaterThanOrEqual(0)
      expect(summary.maxNoaaScale, name).toBeLessThanOrEqual(5)
    }
  })

  it('reports no storm when nothing forecast reaches Kp 5', () => {
    const quiet = [
      { time_tag: '2026-01-01T00:00:00', kp: 1, observed: 'observed' },
      { time_tag: '2026-01-01T03:00:00', kp: 2.33, observed: 'predicted' }
    ]
    const summary = parseKpForecast(quiet, new Date('2026-01-01T01:00:00Z'))
    expect(summary.nextStormTime).toBeNull()
    expect(summary.nextStormKp).toBeNull()
    expect(summary.maxNoaaScale).toBe(0)
  })

  it('finds the first storm onset, not the largest', () => {
    const rows = [
      { time_tag: '2026-01-01T00:00:00', kp: 1, observed: 'observed' },
      { time_tag: '2026-01-01T03:00:00', kp: 5, observed: 'predicted' },
      { time_tag: '2026-01-01T06:00:00', kp: 8, observed: 'predicted' }
    ]
    const summary = parseKpForecast(rows, new Date('2026-01-01T01:00:00Z'))
    expect(summary.nextStormTime).toBe('2026-01-01T03:00:00.000Z')
    expect(summary.nextStormKp).toBe(5)
    expect(summary.max24h).toBe(8)
  })

  it('treats time_tag as UTC', () => {
    const summary = parseKpForecast(
      [{ time_tag: '2026-01-01T12:00:00', kp: 3, observed: 'observed' }],
      new Date('2026-01-01T13:00:00Z')
    )
    expect(summary.observedTime).toBe('2026-01-01T12:00:00.000Z')
  })

  it('survives malformed input', () => {
    for (const input of [null, undefined, {}, 'nope', [], [{ kp: 'x' }]]) {
      const summary = parseKpForecast(input as any, new Date())
      expect(summary.observed).toBeNull()
      expect(summary.max72h).toBeNull()
    }
  })
})

describe('parse27DayOutlook', () => {
  const captured = () => parse27DayOutlook(fixture(OUTLOOK27_FIXTURES[0]))

  it('reads one row per day of the solar rotation, skipping the header', () => {
    const outlook = captured()
    expect(outlook?.days).toHaveLength(27)
    expect(outlook?.days[0]).toEqual({
      time: '2026-08-10T00:00:00.000Z',
      f107: 90,
      aIndex: 12,
      kp: 4
    })
    expect(outlook?.days[26].time).toBe('2026-09-05T00:00:00.000Z')
  })

  it('parses every captured outlook without ever producing NaN', () => {
    for (const name of OUTLOOK27_FIXTURES) {
      const outlook = parse27DayOutlook(fixture(name))
      expect(outlook?.days.length, name).toBeGreaterThan(0)
      for (const day of outlook!.days) {
        for (const value of [day.kp, day.f107, day.aIndex]) {
          expect(value === null || Number.isFinite(value), name).toBe(true)
        }
      }
    }
  })

  it('reads the issue date', () => {
    expect(captured()?.issued?.toISOString()).toBe('2026-08-10T01:53:00.000Z')
  })

  it('reports the peak on its first day, not its last', () => {
    // Kp 5 appears twice in this fixture, on 11 Aug and again on 19 Aug. The
    // useful answer for planning is when the disturbed stretch starts.
    const outlook = captured()
    expect(outlook?.maxKp).toBe(5)
    expect(outlook?.maxKpTime).toBe('2026-08-11T00:00:00.000Z')
    expect(outlook?.maxNoaaScale).toBe(NoaaScaleValues.MINOR)
  })

  it('finds the first day reaching storm level', () => {
    const outlook = captured()
    expect(outlook?.nextStormTime).toBe('2026-08-11T00:00:00.000Z')
    expect(outlook?.nextStormKp).toBe(5)
  })

  it('leaves the storm fields null when the window stays quiet', () => {
    const outlook = parse27DayOutlook('2026 Aug 10 90 12 4\n')
    expect(outlook?.nextStormTime).toBeNull()
    expect(outlook?.nextStormKp).toBeNull()
    expect(outlook?.maxKp).toBe(4)
  })

  it('accepts an ISO date column', () => {
    const outlook = parse27DayOutlook('2026-08-10      90     12     4\n')
    expect(outlook?.days[0]).toEqual({
      time: '2026-08-10T00:00:00.000Z',
      f107: 90,
      aIndex: 12,
      kp: 4
    })
  })

  it('keeps reading a row that grows a fourth column', () => {
    const outlook = parse27DayOutlook('2026 Aug 10   90   12   4   whatever\n')
    expect(outlook?.days[0].kp).toBe(4)
  })

  it('sorts rows into date order', () => {
    const outlook = parse27DayOutlook(
      '2026 Aug 12 92 10 3\n2026 Aug 10 90 12 4\n2026 Aug 11 90 20 5\n'
    )
    expect(outlook?.days.map((d) => d.f107)).toEqual([90, 90, 92])
    expect(outlook?.maxKpTime).toBe('2026-08-11T00:00:00.000Z')
  })

  it('returns null rather than an empty table', () => {
    // The product logs an error on null. An outlook with no rows published as
    // an empty series would look like a quiet 27 days.
    expect(parse27DayOutlook('')).toBeNull()
    expect(
      parse27DayOutlook('#  Date   10.7 cm   A Index   Kp Index\n')
    ).toBeNull()
    expect(parse27DayOutlook('2026 Foo 10 90 12 4\n')).toBeNull()
    expect(parse27DayOutlook('2026 Aug 10 x y z\n')).toBeNull()
  })

  describe('the outlook NOAA reissued to correct it', () => {
    const sepFirst = (name: string) =>
      parse27DayOutlook(fixture(name))?.days.find(
        (day) => day.time === '2026-09-01T00:00:00.000Z'
      )

    it('publishes the flux NOAA later withdrew -- 1151 is a real burst magnitude', () => {
      // 1151 sfu in the Sep 01 column of the 0259 issue. NOAA's own 1801
      // reissue says 120 instead, but a flare can put raw F10.7 in the
      // hundreds of thousands of sfu, so 1151 has no physical tell that
      // marks it as wrong -- only NOAA's retraction does, and this plugin
      // has no way to see that. Range checks can't catch a forecast error
      // that sits inside the range of what's physically possible.
      const day = sepFirst(OUTLOOK27_CORRUPT_FIXTURE)
      expect(fixture(OUTLOOK27_CORRUPT_FIXTURE)).toContain('1151')
      expect(day?.f107).toBe(1151)
    })

    it('publishes the corrected flux from the reissue too', () => {
      expect(sepFirst(OUTLOOK27_CORRECTED_FIXTURE)?.f107).toBe(120)
    })
  })

  describe('plausibility bounds', () => {
    it('nulls a column outside what the quantity can be', () => {
      // Kp is 0-9 by definition and the planetary A index maxes at 400.
      // F10.7 has no defined ceiling -- a flare can put a raw reading in
      // the hundreds of thousands to millions of sfu -- and no defined
      // floor either, so only NaN, negative, and the display-breaking
      // extreme (1e8+) get nulled.
      const outlook = parse27DayOutlook(
        '2026 Aug 10   90   500    4\n' +
          '2026 Aug 11   90    12   12\n' +
          '2026 Aug 12    0    12    4\n' +
          '2026 Aug 13  200000000    12    4\n'
      )
      expect(outlook?.days.map((d) => d.aIndex)).toEqual([null, 12, 12, 12])
      expect(outlook?.days.map((d) => d.kp)).toEqual([4, null, 4, 4])
      expect(outlook?.days.map((d) => d.f107)).toEqual([90, 90, 0, null])
      expect(outlook?.rejected).toBe(3)
    })

    it('does not read a rejected Kp as a quiet day', () => {
      // The peak and the first storm day have to come from the days that still
      // carry a Kp, or a corrupt column silently lowers both.
      const outlook = parse27DayOutlook(
        '2026 Aug 10   90   12   99\n2026 Aug 11   90   20    5\n'
      )
      expect(outlook?.maxKp).toBe(5)
      expect(outlook?.maxKpTime).toBe('2026-08-11T00:00:00.000Z')
      expect(outlook?.nextStormKp).toBe(5)
      expect(outlook?.maxNoaaScale).toBe(NoaaScaleValues.MINOR)
    })

    it('leaves the summary null when no row keeps a Kp', () => {
      const outlook = parse27DayOutlook('2026 Aug 10   90   12   99\n')
      expect(outlook?.days).toHaveLength(1)
      expect(outlook?.maxKp).toBeNull()
      expect(outlook?.maxKpTime).toBeNull()
      expect(outlook?.maxNoaaScale).toBeNull()
      expect(outlook?.nextStormKp).toBeNull()
    })

    it('keeps the edges of the A index and Kp ranges', () => {
      const outlook = parse27DayOutlook('2026 Aug 10   400   400   9\n')
      expect(outlook?.days[0]).toEqual({
        time: '2026-08-10T00:00:00.000Z',
        f107: 400,
        aIndex: 400,
        kp: 9
      })
    })

    it('rejects only NaN, negative, and display-breaking F10.7 readings', () => {
      const outlook = parse27DayOutlook(
        '2026 Aug 10   1000000   12   4\n' +
          '2026 Aug 11   -5        12   4\n' +
          '2026 Aug 12   500000000 12   4\n'
      )
      // A million sfu is a real flare magnitude, not a display-breaking one.
      expect(outlook?.days.map((d) => d.f107)).toEqual([1000000, null, null])
    })
  })
})

describe('parseSolarWind', () => {
  it('reads the current NOAA array payload and converts to SI', () => {
    const wind = parseSolarWind(
      fixtureJson('solar-wind-speed.2026_08_01.json'),
      fixtureJson('solar-wind-mag-field.2026_08_01.json')
    )
    // 287 km/s -> m/s, 4 nT and -2 nT -> Tesla
    expect(wind.speed).toBe(287000)
    expect(wind.bt).toBeCloseTo(4e-9, 20)
    expect(wind.bz).toBeCloseTo(-2e-9, 20)
    expect(wind.timestamp).toBe('2026-08-01T07:42:00Z')
  })

  it('still reads the legacy object payload', () => {
    // NOAA served {"WindSpeed":…,"TimeStamp":…} and {"Bt":…,"Bz":…} when this
    // plugin was written; both shapes are accepted so a revert upstream cannot
    // break it again.
    const wind = parseSolarWind(
      { WindSpeed: 400, TimeStamp: '2025-04-19T01:00:00Z' },
      { Bt: 5, Bz: -3, TimeStamp: '2025-04-19T01:00:00Z' }
    )
    expect(wind.speed).toBe(400000)
    expect(wind.bt).toBeCloseTo(5e-9, 20)
    expect(wind.bz).toBeCloseTo(-3e-9, 20)
  })

  it('never produces NaN', () => {
    // Reading the array payload with the old object accessors yielded
    // `undefined * 1` and published NaN to Bt and Bz.
    for (const [speed, mag] of [
      [[], []],
      [null, null],
      [{}, {}],
      [[{ proton_speed: null }], [{ bt: null, bz_gsm: null }]],
      [{ WindSpeed: 'x' }, { Bt: 'x', Bz: 'x' }]
    ]) {
      const wind = parseSolarWind(speed, mag)
      for (const value of [wind.speed, wind.bt, wind.bz]) {
        expect(value === null || Number.isFinite(value)).toBe(true)
      }
    }
  })

  it('falls back to the speed timestamp when the field payload has none', () => {
    const wind = parseSolarWind(
      [{ proton_speed: 300, time_tag: '2026-08-01T00:00:00Z' }],
      [{ bt: 3 }]
    )
    expect(wind.timestamp).toBe('2026-08-01T00:00:00Z')
  })
})

describe('parseGoesFlux', () => {
  it('reads the latest 0.1-0.8nm and >=10 MeV records from a captured payload', () => {
    const flux = parseGoesFlux(
      fixtureJson('xrays-6-hour.2026_08_20.json'),
      fixtureJson('integral-protons-6-hour.2026_08_20.json')
    )
    expect(flux.xrayFlux).toBeCloseTo(1.3730890486840508e-6, 15)
    expect(flux.xrayTimestamp).toBe('2026-08-20T04:42:00Z')
    // 0.21759319305419922 pfu -> m^-2.s^-1.sr^-1
    expect(flux.protonFlux).toBeCloseTo(2175.9319305419922, 6)
    expect(flux.protonTimestamp).toBe('2026-08-20T04:35:00Z')
  })

  it('scans past interleaved channels rather than reading the last element', () => {
    const flux = parseGoesFlux(
      [
        { time_tag: '2026-01-01T00:00:00Z', energy: '0.1-0.8nm', flux: 1e-7 },
        { time_tag: '2026-01-01T00:01:00Z', energy: '0.05-0.4nm', flux: 2e-8 }
      ],
      [
        { time_tag: '2026-01-01T00:00:00Z', energy: '>=10 MeV', flux: 0.3 },
        { time_tag: '2026-01-01T00:00:00Z', energy: '>=1 MeV', flux: 5 }
      ]
    )
    expect(flux.xrayFlux).toBe(1e-7)
    expect(flux.protonFlux).toBeCloseTo(3000, 6)
  })

  it('never produces NaN', () => {
    for (const [xray, proton] of [
      [[], []],
      [null, null],
      [{}, {}],
      [[{ energy: '0.1-0.8nm', flux: null }], [{ energy: '>=10 MeV' }]],
      [
        [{ energy: '0.1-0.8nm', flux: 'x' }],
        [{ energy: '>=10 MeV', flux: 'x' }]
      ]
    ]) {
      const flux = parseGoesFlux(xray, proton)
      for (const value of [flux.xrayFlux, flux.protonFlux]) {
        expect(value === null || Number.isFinite(value)).toBe(true)
      }
    }
  })
})

describe('parseDrapGrid', () => {
  it('reads the valid time and grid dimensions from a captured payload', () => {
    const grid = parseDrapGrid(
      fixture('drap-global-frequencies.2026_08_20.txt')
    )
    expect(grid?.validTime).toBe('2026-08-20T04:42:00.000Z')
    expect(grid?.latitudes.length).toBe(90)
    expect(grid?.longitudes.length).toBe(90)
    expect(grid?.latitudes[0]).toBe(89)
    expect(grid?.longitudes[0]).toBe(-178)
    for (const row of grid!.frequenciesMHz) {
      expect(row.length).toBe(90)
    }
  })

  it('returns null on input with no grid', () => {
    expect(parseDrapGrid('nothing to see here')).toBeNull()
    expect(parseDrapGrid('')).toBeNull()
  })

  it('reads a CRLF payload the same as LF', () => {
    // A Windows checkout serves this fixture with \r\n line endings; a
    // trailing \r landing inside the last numeric column used to fail
    // Number.isFinite for the whole grid. Normalize first: the fixture may
    // already be CRLF depending on the checkout this test itself runs on.
    const lf = fixture('drap-global-frequencies.2026_08_20.txt').replace(
      /\r\n/g,
      '\n'
    )
    const crlf = parseDrapGrid(lf.replace(/\n/g, '\r\n'))
    expect(crlf?.validTime).toBe('2026-08-20T04:42:00.000Z')
    expect(crlf?.frequenciesMHz).toEqual(parseDrapGrid(lf)?.frequenciesMHz)
  })

  it('rejects a grid caught mid-rewrite, short of the documented 90x90 shape', () => {
    // NOAA rewrites this file in place; a read can land after only some of
    // the data rows have been written. Every row present is still internally
    // consistent (right width, finite values), so only a shape check catches
    // it -- otherwise drapFrequencyAt would silently snap to the nearest
    // surviving row instead of the one NOAA actually measured.
    const full = fixture('drap-global-frequencies.2026_08_20.txt')
    const lines = full.split('\n')
    const dataStart = lines.findIndex((line) => /^\s*-?\d+\s*\|/.test(line))
    // Without this the slice below could drop every data row and the parser
    // would return null for the wrong reason, passing the test on nothing.
    expect(dataStart).toBeGreaterThanOrEqual(0)
    const truncated = lines.slice(0, dataStart + 45).join('\n')
    expect(parseDrapGrid(truncated)).toBeNull()
  })

  it('rejects a grid whose valid time did not survive the read', () => {
    const full = fixture('drap-global-frequencies.2026_08_20.txt')
    expect(parseDrapGrid(full.replace(/Product Valid At.*/, ''))).toBeNull()
  })
})

describe('drapFrequencyAt', () => {
  const grid = parseDrapGrid(fixture('drap-global-frequencies.2026_08_20.txt'))

  it('reads the exact grid point for an on-grid position', () => {
    expect(drapFrequencyAt(grid, 41, -178)).toBeCloseTo(2.9, 5)
  })

  it('snaps to the nearest grid point for an off-grid position', () => {
    // 41N/-178E is the nearest defined point to 40.9N/-176.9E.
    expect(drapFrequencyAt(grid, 40.9, -176.9)).toBeCloseTo(2.9, 5)
  })

  it('wraps longitude across the -180/180 boundary', () => {
    // -179.9 is close to the -178 column on the circle (1.9 degrees), not
    // 358.1 degrees away as an unwrapped difference would compute it.
    expect(drapFrequencyAt(grid, 89, -179.9)).toBeCloseTo(
      grid!.frequenciesMHz[0][0],
      5
    )
  })

  it('returns null with no grid or a non-finite position', () => {
    expect(drapFrequencyAt(null, 0, 0)).toBeNull()
    expect(drapFrequencyAt(grid, NaN, 0)).toBeNull()
    expect(drapFrequencyAt(grid, 0, NaN)).toBeNull()
  })
})

describe('firstJsonValue', () => {
  it('returns a well-formed payload unchanged', () => {
    expect(firstJsonValue('[{"a":1}]')).toBe('[{"a":1}]')
    expect(firstJsonValue('  {"a":[1,2]}\n')).toBe('{"a":[1,2]}')
  })

  it('stops at the end of the first complete value', () => {
    // The real shape of a mid-write read: shorter new content, then the tail of
    // the longer old content.
    expect(firstJsonValue('[{"a":1}]_ratio": 0.1339')).toBe('[{"a":1}]')
  })

  it('is not fooled by brackets inside strings', () => {
    const text = '[{"m":"ALERT: ]}] not a bracket"}]'
    expect(firstJsonValue(text)).toBe(text)
    expect(JSON.parse(firstJsonValue(text)!)[0].m).toContain(']}]')
  })

  it('handles an escaped quote before a bracket', () => {
    const text = '[{"m":"a \\" ]"}]'
    expect(firstJsonValue(text)).toBe(text)
  })

  it('counts nesting of the outer bracket type', () => {
    expect(firstJsonValue('[[1],[2]]tail')).toBe('[[1],[2]]')
    expect(firstJsonValue('{"a":{"b":1}}tail')).toBe('{"a":{"b":1}}')
  })

  it('returns null when the value never closes', () => {
    // A truncated write. Recovering a prefix here would publish half a payload
    // as though it were whole.
    expect(firstJsonValue('[{"a":1}')).toBeNull()
    expect(firstJsonValue('{"a":')).toBeNull()
  })

  it('returns null for anything that is not an array or object', () => {
    for (const text of ['', '   ', 'nope', '"a string"', '42'])
      expect(firstJsonValue(text), JSON.stringify(text)).toBeNull()
  })
})

describe('parseGeophysicalAlert', () => {
  const WWV = fixture('wwv.2026_08_20.txt')

  it('reads the planetary A index and the day it describes', () => {
    const alert = parseGeophysicalAlert(WWV)
    expect(alert?.aIndex).toBe(20)
    expect(alert?.day).toBe('2026-08-19T00:00:00.000Z')
  })

  it('accepts the wordings NOAA has used between the label and the number', () => {
    const header = WWV.slice(0, WWV.indexOf('Solar-terrestrial'))
    for (const [phrase, expected] of [
      ['estimated planetary A-index 20.', 20],
      ['estimated planetary A-index was 20.', 20],
      ['estimated planetary A index of 8.', 8],
      ['estimated planetary A-index 112.', 112]
    ] as [string, number][]) {
      const text =
        header +
        'Solar-terrestrial indices for 19 August follow.\n' +
        'Solar flux 126 and ' +
        phrase +
        '\n'
      expect(parseGeophysicalAlert(text)?.aIndex, phrase).toBe(expected)
    }
  })

  it('reads a December day off a January bulletin as the year before', () => {
    const text =
      ':Product: Geophysical Alert Message wwv.txt\n' +
      ':Issued: 2027 Jan 01 0305 UTC\n' +
      'Solar-terrestrial indices for 31 December follow.\n' +
      'Solar flux 126 and estimated planetary A-index 20.\n'
    expect(parseGeophysicalAlert(text)?.day).toBe('2026-12-31T00:00:00.000Z')
  })

  it("rejects NOAA's negative filler rather than reading it as a severe index", () => {
    // The gap before the number is matched loosely, so an unsigned pattern
    // reads -999 as 999 -- a fabricated extreme storm out of a missing
    // measurement.
    const text =
      ':Issued: 2026 Aug 20 0605 UTC\n' +
      'Solar-terrestrial indices for 19 August follow.\n' +
      'Solar flux 126 and estimated planetary A-index -999.\n'
    expect(parseGeophysicalAlert(text)).toBeNull()
  })

  it('rejects a bulletin day that is not on the calendar', () => {
    const text =
      ':Issued: 2026 Mar 01 0305 UTC\n' +
      'Solar-terrestrial indices for 31 February follow.\n' +
      'Solar flux 126 and estimated planetary A-index 20.\n'
    expect(parseGeophysicalAlert(text)).toBeNull()
  })

  it('returns null rather than a number without a day, or a day without a number', () => {
    expect(parseGeophysicalAlert('')).toBeNull()
    expect(parseGeophysicalAlert('No indices in this bulletin.')).toBeNull()
    expect(
      parseGeophysicalAlert(
        ':Issued: 2026 Aug 20 0605 UTC\nestimated planetary A-index 20.\n'
      )
    ).toBeNull()
  })
})

describe('parseDailySolarIndices', () => {
  const DSD = fixture('daily-solar-indices.2026_08_20.txt')

  it('reads the newest complete day from the 30-day table', () => {
    const latest = parseDailySolarIndices(DSD)
    expect(latest?.sunspotNumber).toBe(78)
    expect(latest?.day).toBe('2026-08-19T00:00:00.000Z')
  })

  it('takes the newest row whatever order the table is in', () => {
    const lines = DSD.replace(/\r\n/g, '\n').split('\n')
    const reversed = lines.slice().reverse().join('\n')
    expect(parseDailySolarIndices(reversed)).toEqual(
      parseDailySolarIndices(DSD)
    )
  })

  it('accepts an ISO date column alongside the one NOAA writes today', () => {
    const text = '2026-08-19  126     78      560      1\n'
    expect(parseDailySolarIndices(text)).toEqual({
      day: '2026-08-19T00:00:00.000Z',
      sunspotNumber: 78
    })
  })

  it("skips a row whose sunspot column is NOAA's -999 filler", () => {
    const text =
      '2026 08 18  125     71      510      1\n' +
      '2026 08 19  126   -999      560      1\n'
    expect(parseDailySolarIndices(text)?.day).toBe('2026-08-18T00:00:00.000Z')
  })

  it('rejects a day that is not on the calendar', () => {
    // Date rolls 30 February forward to 2 March, which sorts ahead of every
    // real row -- so a torn payload would win the newest-row pick.
    const text =
      '2026 08 19  126     78      560      1\n' +
      '2026 02 30  126     99      560      1\n'
    expect(parseDailySolarIndices(text)?.day).toBe('2026-08-19T00:00:00.000Z')
    expect(parseDailySolarIndices('2026-02-30  126  99\n')).toBeNull()
  })

  it('returns null rather than NaN when there is no usable row', () => {
    for (const text of [
      '',
      '# comment only\n',
      ':Issued: 0225 UT 20 Aug 2026\n'
    ])
      expect(parseDailySolarIndices(text), JSON.stringify(text)).toBeNull()
  })
})
