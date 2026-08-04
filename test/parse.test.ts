import { describe, expect, it } from 'vitest'
import {
  NoaaScaleValues,
  getAlertLevel,
  parseAdvisoryOutlook,
  parseAlert,
  parseIssueDate,
  parseKpForecast,
  parseSolarWind,
  percentToRatio,
  transformJsonScaleRange
} from '../src/parse'
import {
  ADVISORY_FIXTURES,
  ALERT_FIXTURES,
  KP_FORECAST_FIXTURES,
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
      const alertingAt = (threshold: number) =>
        alerts.filter((a: any) => parseAlert(a, threshold)!.state === 'alert')
          .length

      expect(alertingAt(1), name).toBeGreaterThan(0)
      expect(alertingAt(1), name).toBeGreaterThan(alertingAt(3))
      expect(alertingAt(3), name).toBeGreaterThanOrEqual(alertingAt(5))
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
      expect(parsed.scaleValue).toBe(NoaaScaleValues.EXTREME)
    }
  })

  it('treats "or greater" as the extreme level', () => {
    const parsed = parseAlert({
      product_id: 'test',
      issue_datetime: '2025-04-17 12:00:00.000',
      message:
        'Space Weather Message Code: WATA50\nSerial Number: 1\nIssue Time: 2025 Apr 17 1200 UTC\n\nWATCH: Geomagnetic Storm Category G3 Predicted\n\nNOAA Scale: G3 or greater - Strong to Extreme\n'
    })!
    expect(parsed.scaleValue).toBe(NoaaScaleValues.EXTREME)
    expect(parsed.state).toBe('alert')
  })

  it('returns null instead of throwing on malformed entries', () => {
    expect(parseAlert(null)).toBeNull()
    expect(parseAlert({})).toBeNull()
    expect(parseAlert({ message: 'no serial number here' })).toBeNull()
    expect(
      parseAlert({ message: 'Serial Number: 1\nSpace Weather Message Code: ALTEF3', issue_datetime: 'nonsense' })
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
          expect(update.value, `${name} ${update.path}`).toBeGreaterThanOrEqual(0)
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
    expect(summary.maxNoaaScale).toBe(1)
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
          ).toBeGreaterThanOrEqual(new Date(summary.series[i - 1].time).getTime())
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
    const records = fixtureJson('noaa-planetary-k-index-forecast.2026_08_01.json')
    expect(Array.isArray(table[0])).toBe(true)
    expect(Array.isArray(records[0])).toBe(false)

    const fromTable = parseKpForecast(table, new Date('2025-04-03T00:00:00Z'))
    expect(fromTable.observed).toBeCloseTo(3.67, 5)
    expect(fromTable.observedTime).toBe('2025-04-03T00:00:00.000Z')
    expect(fromTable.max72h).toBeCloseTo(5.67, 5)

    const fromRecords = parseKpForecast(records, new Date('2026-07-25T00:00:00Z'))
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
