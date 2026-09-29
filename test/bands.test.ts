import { describe, expect, it } from 'vitest'
import {
  FOT_RATIO,
  MARINE_BANDS,
  VERDICT_LABEL,
  bandConditions,
  bandPanelMarkup,
  bandVerdict,
  groupVerdict,
  noonAndMidnight
} from '../public/bands.js'

const leaf = (value: unknown) => ({ value, timestamp: '2026-08-26T12:00:00Z' })

// Equator, equinox, longitude 0: local noon and UTC noon coincide, so the
// sun's own position is trivial to reason about without floating-point
// solar-geometry arithmetic leaking into the assertions.
const NOON_UTC = new Date('2026-03-20T12:00:00Z')
const equator = { latitude: 0, longitude: 0 }
const eightMHz = MARINE_BANDS.find((b) => b.label === '8 MHz')!.bands[0][1]

describe('bandVerdict: one band against one window', () => {
  it('is poor when the D-RAP floor has reached the band', () => {
    expect(
      bandVerdict(7_000_000, { floorHz: 7_000_000, ceilingHz: 14_000_000 })
    ).toEqual({
      verdict: 'poor',
      reason: 'absorbed'
    })
    // Floor above the band absorbs it too -- "reached" means "at or past".
    expect(
      bandVerdict(7_000_000, { floorHz: 9_000_000, ceilingHz: 14_000_000 })!
        .reason
    ).toBe('absorbed')
  })

  it('is poor above the MUF, with no floor in play', () => {
    expect(
      bandVerdict(14_000_000, { floorHz: null, ceilingHz: 10_000_000 })
    ).toEqual({
      verdict: 'poor',
      reason: 'above-muf'
    })
  })

  it('is fair in the top 15% under the MUF, including exactly at the MUF', () => {
    const ceilingHz = 10_000_000
    expect(bandVerdict(ceilingHz, { floorHz: null, ceilingHz })!.reason).toBe(
      'near-muf'
    )
    expect(
      bandVerdict(ceilingHz * FOT_RATIO + 1, { floorHz: null, ceilingHz })!
        .reason
    ).toBe('near-muf')
  })

  it('is good at or under FOT_RATIO x MUF, above the floor', () => {
    const ceilingHz = 10_000_000
    const judged = bandVerdict(ceilingHz * FOT_RATIO, {
      floorHz: null,
      ceilingHz
    })
    expect(judged).toEqual({ verdict: 'good', reason: 'window' })
    expect(bandVerdict(1_000, { floorHz: null, ceilingHz })!.verdict).toBe(
      'good'
    )
  })

  it('makes no claim with no ceiling, or a non-finite band', () => {
    expect(
      bandVerdict(7_000_000, { floorHz: null, ceilingHz: null })
    ).toBeNull()
    expect(
      bandVerdict(NaN, { floorHz: null, ceilingHz: 10_000_000 })
    ).toBeNull()
  })
})

describe('groupVerdict: a group reads as its best band', () => {
  const window = { floorHz: 5_000_000, ceilingHz: 8_000_000 }
  const group = {
    label: 'test',
    bands: [
      ['low', 3_000_000], // under the floor: poor/absorbed
      ['high', 9_000_000] // above the ceiling: poor/above-muf
    ] as [string, number][]
  }

  it('ranks good over fair over poor', () => {
    const mixed = {
      label: 'mixed',
      bands: [
        ['poor-band', 3_000_000],
        ['good-band', 6_000_000]
      ] as [string, number][]
    }
    expect(groupVerdict(mixed, window)).toEqual({
      verdict: 'good',
      reason: 'window',
      band: 'good-band'
    })
  })

  it('is null only when every band in the group is unjudged', () => {
    expect(groupVerdict(group, { floorHz: null, ceilingHz: null })).toBeNull()
    // Both bands here ARE judged (both poor), so the group still reports one.
    expect(groupVerdict(group, window)).not.toBeNull()
  })
})

describe('noonAndMidnight: the two instants the columns are taken at', () => {
  it('is 12 hours apart, offset from UTC noon by the longitude', () => {
    // Eastern US, UTC-5: local noon is 17:00 UTC.
    const { noon, midnight } = noonAndMidnight(
      -75,
      new Date('2026-01-15T23:00:00Z')
    )
    expect(noon.toISOString()).toBe('2026-01-15T17:00:00.000Z')
    expect(midnight.toISOString()).toBe('2026-01-16T05:00:00.000Z')
  })

  it('takes the UTC day of `at`, not the instant within it', () => {
    const early = noonAndMidnight(0, new Date('2026-01-15T00:00:01Z'))
    const late = noonAndMidnight(0, new Date('2026-01-15T23:59:59Z'))
    expect(early.noon.toISOString()).toBe(late.noon.toISOString())
  })
})

describe('bandConditions: day/night columns', () => {
  const data = {
    f107: leaf(150),
    kp: { observed: leaf(0) },
    position: leaf(equator)
  }

  it('labels the columns Day and Night, at local noon and midnight', () => {
    const { columns } = bandConditions(data, NOON_UTC)
    expect(columns.map((c) => c.key)).toEqual(['day', 'night'])
    expect(columns.map((c) => c.label)).toEqual(['Day', 'Night'])
    const { noon, midnight } = noonAndMidnight(0, NOON_UTC)
    expect(columns[0].at).toEqual(noon)
    expect(columns[1].at).toEqual(midnight)
  })

  it('marks the column the vessel is currently in, and only one of them', () => {
    const { columns } = bandConditions(data, NOON_UTC)
    expect(columns.filter((c) => c.current)).toHaveLength(1)
    expect(columns.find((c) => c.key === 'day')!.current).toBe(true)

    const midnightUtc = new Date('2026-03-20T00:00:00Z')
    const atNight = bandConditions(data, midnightUtc)
    expect(atNight.columns.find((c) => c.key === 'night')!.current).toBe(true)
  })

  it('gives every column a modelled ceiling, day warmer than night', () => {
    const { columns } = bandConditions(data, NOON_UTC)
    const [day, night] = columns
    expect(day.ceilingHz).toBeGreaterThan(0)
    expect(night.ceilingHz).toBeGreaterThan(0)
    expect(day.ceilingHz).toBeGreaterThan(night.ceilingHz)
    expect(day.ceilingEstimated).toBe(true)
    expect(night.ceilingEstimated).toBe(true)
  })
})

describe('bandConditions: the D-RAP floor applies only to the current column', () => {
  const dayCutoff = eightMHz + 500_000 // just above the 8 MHz marine edge
  const data = {
    f107: leaf(150),
    kp: { observed: leaf(0) },
    position: leaf(equator),
    drap: { highest_affected_frequency: leaf(dayCutoff) }
  }

  it('absorbs the band in the current column but not the other one', () => {
    const { columns, marine } = bandConditions(data, NOON_UTC) // day is current
    const day = columns.find((c) => c.key === 'day')!
    const night = columns.find((c) => c.key === 'night')!
    expect(day.floorHz).toBe(dayCutoff)
    expect(day.floorMeasured).toBe(true)
    expect(night.floorHz).toBeNull()
    expect(night.floorMeasured).toBe(false)

    const row = marine.find((r) => r.label === '8 MHz')!
    expect(row.cells[0]).toEqual({
      verdict: 'poor',
      reason: 'absorbed',
      band: '8 MHz'
    })
    // Same frequency, night column: no floor reading applies, so absorption
    // cannot be the reason even though the D-RAP cutoff is published.
    expect(row.cells[1]?.reason).not.toBe('absorbed')
  })

  it('prefers a measured MUF over the estimate, only in the current column', () => {
    const measuredMufHz = 12_000_000
    const withMuf = bandConditions(
      { ...data, muf: leaf(measuredMufHz) },
      NOON_UTC
    )
    const [day, night] = withMuf.columns
    expect(day.ceilingHz).toBe(measuredMufHz)
    expect(day.ceilingEstimated).toBe(false)
    expect(night.ceilingEstimated).toBe(true)
  })
})

describe('bandConditions: proton note is additive, never changes a cell', () => {
  const base = {
    f107: leaf(150),
    kp: { observed: leaf(0) },
    position: leaf(equator),
    drap: { highest_affected_frequency: leaf(eightMHz + 500_000) }
  }

  it('flips the polar note at 10 pfu and nowhere else', () => {
    const below = bandConditions(
      { ...base, protonFlux: leaf(9.9 * 1e4) },
      NOON_UTC
    )
    const atThreshold = bandConditions(
      { ...base, protonFlux: leaf(10 * 1e4) },
      NOON_UTC
    )
    expect(below.polarPathsDegraded).toBe(false)
    expect(atThreshold.polarPathsDegraded).toBe(true)
    // Everything that feeds a cell is untouched by the proton reading.
    expect(atThreshold.ham).toEqual(below.ham)
    expect(atThreshold.marine).toEqual(below.marine)
    expect(atThreshold.columns.map((c) => c.ceilingHz)).toEqual(
      below.columns.map((c) => c.ceilingHz)
    )
  })

  it('is false with no proton reading at all', () => {
    expect(bandConditions(base, NOON_UTC).polarPathsDegraded).toBe(false)
  })
})

describe('bandConditions: missing inputs degrade to an empty state, never NaN', () => {
  it('has nothing at all with no data', () => {
    const conditions = bandConditions({}, NOON_UTC)
    expect(conditions.available).toBe(false)
    expect(conditions.columns).toEqual([])
    expect(conditions.missing.sort()).toEqual(['a position fix', 'solar flux'])
    expect(
      conditions.ham.every((row) => row.cells.every((c) => c === null))
    ).toBe(true)
    expect(
      conditions.marine.every((row) => row.cells.every((c) => c === null))
    ).toBe(true)
    expect(JSON.stringify(conditions)).not.toMatch(/NaN/)
  })

  it('names only the input actually missing', () => {
    const noPosition = bandConditions({ f107: leaf(150) }, NOON_UTC)
    expect(noPosition.missing).toEqual(['a position fix'])

    const noFlux = bandConditions({ position: leaf(equator) }, NOON_UTC)
    expect(noFlux.available).toBe(false)
    expect(noFlux.missing).toEqual(['solar flux'])
  })

  it('does not blow up on a partial position, and still reports no position', () => {
    const conditions = bandConditions(
      { f107: leaf(150), position: leaf({ latitude: 47.6 }) },
      NOON_UTC
    )
    expect(conditions.available).toBe(false)
    expect(JSON.stringify(conditions)).not.toMatch(/NaN/)
  })

  it('leaves a cell unjudged, not guessed, in a column with no ceiling at all', () => {
    // Measured MUF covers the current (day) column; nothing covers night
    // because there is no F10.7 to model it from.
    const conditions = bandConditions(
      {
        position: leaf(equator),
        muf: leaf(21_000_000)
      },
      NOON_UTC
    )
    const [day, night] = conditions.columns
    expect(day.ceilingHz).toBe(21_000_000)
    expect(night.ceilingHz).toBeNull()
    const row = conditions.marine.find((r) => r.label === '8 MHz')!
    expect(row.cells[0]).not.toBeNull()
    expect(row.cells[1]).toBeNull()
    expect(JSON.stringify(conditions)).not.toMatch(/NaN/)
  })
})

describe('bandPanelMarkup', () => {
  const populated = {
    f107: leaf(150),
    kp: { observed: leaf(0) },
    position: leaf(equator),
    drap: { highest_affected_frequency: leaf(eightMHz + 500_000) }
  }

  it('renders the empty state by what is missing, with no table', () => {
    const markup = bandPanelMarkup(bandConditions({}, NOON_UTC))
    expect(markup).toContain('Needs')
    expect(markup).toContain('solar flux')
    expect(markup).toContain('a position fix')
    expect(markup).not.toContain('<table')
  })

  it('prints the verdict word in every judged cell, not just its colour', () => {
    const markup = bandPanelMarkup(bandConditions(populated, NOON_UTC))
    expect(markup).toContain(VERDICT_LABEL.poor)
    for (const word of Object.values(VERDICT_LABEL)) {
      expect(markup.includes(word) || markup.includes('bc-none')).toBe(true)
    }
  })

  it('marks the current column "now" and notes the other is ceiling-only', () => {
    const markup = bandPanelMarkup(bandConditions(populated, NOON_UTC))
    expect(markup).toContain('bc-now-tag')
    expect(markup).toContain('ceiling only')
  })

  it('shows the polar-paths note only when a proton event is in progress', () => {
    const quiet = bandPanelMarkup(bandConditions(populated, NOON_UTC))
    const stormy = bandPanelMarkup(
      bandConditions({ ...populated, protonFlux: leaf(10 * 1e4) }, NOON_UTC)
    )
    expect(quiet).not.toContain('Proton event')
    expect(stormy).toContain('Proton event')
  })

  it('draws an unjudged cell as a dash, not a guessed verdict', () => {
    const conditions = bandConditions(
      { position: leaf(equator), muf: leaf(21_000_000) },
      NOON_UTC
    )
    const markup = bandPanelMarkup(conditions)
    expect(markup).toContain('bc-none')
    expect(markup).toContain('&mdash;')
  })

  it('prints the asOf note, stale or not, only when one is given', () => {
    const conditions = bandConditions(populated, NOON_UTC)
    const fresh = bandPanelMarkup(conditions, {
      text: '12:00 UTC',
      stale: false
    })
    const stale = bandPanelMarkup(conditions, {
      text: '02:00 UTC',
      stale: true
    })
    const none = bandPanelMarkup(conditions, null)
    expect(fresh).toContain('12:00 UTC')
    expect(fresh).not.toContain('class="stale"')
    expect(stale).toContain('class="stale"')
    expect(none).not.toContain('Oldest input')
  })
})
