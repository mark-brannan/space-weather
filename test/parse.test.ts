import { describe, expect, it } from 'vitest'
import {
  NoaaScaleValues,
  firstJsonValue,
  getAlertLevel,
  parse27DayOutlook,
  parseAdvisoryOutlook,
  parseAlert,
  parseDailySolarIndices,
  parseF107,
  parseGeophysicalAlert,
  parseIssueDate,
  parseKpForecast,
  parseSolarWind,
  parseXrayFlare,
  percentToRatio,
  transformJsonScaleRange
} from '../src/parse'
import {
  ADVISORY_FIXTURES,
  ALERT_FIXTURES,
  KP_FORECAST_FIXTURES,
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
  it('reads the current flare class from a captured payload', () => {
    const flare = parseXrayFlare(
      fixtureJson('xray-flares-latest.2026_08_06.json')
    )
    expect(flare).toEqual({ flareClass: 'B3.3', time: '2026-08-06T03:46:00Z' })
  })

  it('returns null rather than throwing on unusable input', () => {
    for (const input of [null, undefined, {}, [], [{}], 'nope']) {
      expect(parseXrayFlare(input as any)).toBeNull()
    }
  })

  it('returns null when current_class is present but empty', () => {
    expect(
      parseXrayFlare([{ current_class: '', time_tag: '2026-08-06T03:46:00Z' }])
    ).toBeNull()
  })

  it('returns null when time_tag is missing', () => {
    expect(parseXrayFlare([{ current_class: 'M2.1' }])).toBeNull()
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
    expect(summary.observed).toBe(2)
    expect(summary.observedTime).toBe('2026-08-01T06:00:00.000Z')
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
    expect(summary.series.filter((p) => p.forecast).length).toBe(22)
    expect(summary.series.filter((p) => !p.forecast).length).toBe(8)
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

  it('parses every captured outlook', () => {
    for (const name of OUTLOOK27_FIXTURES) {
      const outlook = parse27DayOutlook(fixture(name))
      expect(outlook?.days.length, name).toBeGreaterThan(0)
      for (const day of outlook!.days) {
        expect(Number.isFinite(day.kp), name).toBe(true)
        expect(Number.isFinite(day.f107), name).toBe(true)
        expect(Number.isFinite(day.aIndex), name).toBe(true)
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
