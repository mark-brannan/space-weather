/**
 * The webapp's diagnostics panel: where the line between "these two numbers
 * agree" and "the configuration screen is lying" is drawn.
 *
 * That line is the whole point of docs/instrumentation-design.md, and the
 * design doc left the number as an explicit placeholder. So these are tests of
 * the thresholds themselves, not of the markup around them -- what trips a
 * verdict, what must not, and what has to wait for a full window before it is
 * allowed to accuse anything.
 */
import { describe, expect, it } from 'vitest'
import {
  MIN_SIZE_SAMPLES,
  SIZE_DIVERGENCE,
  TOTAL_DIVERGENCE,
  WINDOW_HOURS,
  currentErrors,
  diagnosticsView,
  footstripNote,
  hoursCovered
} from '../public/diagnostics.js'
import { AURORA, SCALES } from '../src/endpoints'

const HOUR = 60 * 60 * 1000
const NOW = Date.UTC(2026, 7, 28, 12, 0, 0)

/** One hourly bucket, `hoursAgo` before `NOW`, rounded to the hour like the meter's. */
const bucket = (
  hoursAgo: number,
  over: Partial<{
    fetches: number
    wireBytes: number
    errors: number
    notModified: number
    estimated: number
  }> = {}
) => ({
  hourStart: Math.floor((NOW - hoursAgo * HOUR) / HOUR) * HOUR,
  fetches: 1,
  wireBytes: 0,
  errors: 0,
  notModified: 0,
  estimated: 0,
  ...over
})

/** Buckets spread one per hour over `hours`, each carrying `per` bytes. */
const spread = (hours: number, per: number, fetches = 1) =>
  Array.from({ length: hours }, (_, i) =>
    bucket(hours - 1 - i, { fetches, wireBytes: per * fetches })
  )

const declared = (subPath: string, wireBytes: number, bytesPerDay: number) => ({
  subPath,
  productName: 'Test product',
  wireBytes,
  measuredOn: '2026-08-28',
  fetchesPerDay: wireBytes > 0 ? bytesPerDay / wireBytes : 0,
  bytesPerDay
})

const body = (endpoints: unknown[], hourly: Record<string, unknown[]>) => ({
  schema: 2,
  startedAt: new Date(NOW - 25 * HOUR).toISOString(),
  settings: {},
  predicted: {
    total: (endpoints as any[]).reduce((sum, e) => sum + e.bytesPerDay, 0),
    endpoints
  },
  ring: [],
  hourly
})

describe('how much of the 24-hour window the meter actually covers', () => {
  it('is nothing at all before the first fetch', () => {
    expect(hoursCovered({}, NOW)).toBe(0)
  })

  // Bucket starts are floored to the hour, so the current partial hour is the
  // one the span does not count.
  it('counts the whole hours behind the current one, plus the current one', () => {
    expect(hoursCovered({ a: [bucket(0)] }, NOW)).toBe(1)
    expect(hoursCovered({ a: [bucket(5), bucket(0)] }, NOW)).toBe(6)
  })

  // Tier 2 prunes to 24 buckets by hourStart, so a genuinely full window puts
  // the oldest start 23 hours back and never 24. If the gate were written
  // against a 24-hour span it would never open.
  it('reads full at the widest span the meter can hold', () => {
    expect(hoursCovered({ a: [bucket(23), bucket(0)] }, NOW)).toBe(WINDOW_HOURS)
  })

  it('takes the oldest bucket across every endpoint, not one of them', () => {
    expect(hoursCovered({ a: [bucket(2)], b: [bucket(9)] }, NOW)).toBe(10)
  })
})

describe('the banner waits for a full window before judging a day', () => {
  const partial = () =>
    diagnosticsView(
      body(
        [declared(AURORA.subPath, AURORA.wireBytes, AURORA.wireBytes * 12)],
        { [AURORA.subPath]: spread(3, AURORA.wireBytes) }
      ),
      NOW
    )

  // The meter starts empty at every plugin start, and the aurora grid alone is
  // 147 KB arriving in lumps two hours apart. Three hours in, measured is a
  // fraction of a day's prediction for no reason but the clock -- so judging
  // there would raise the alarm after every single restart.
  it('says it is collecting rather than that the plugin is under-fetching', () => {
    const view = partial()
    expect(view.verdict).toEqual({ kind: 'collecting', hours: 3 })
    expect(view.windowComplete).toBe(false)
  })

  it('has nothing for the footstrip to interrupt with while collecting', () => {
    expect(partial().rows.every((row: any) => !row.dayDiverged)).toBe(true)
  })

  it('judges once the window has filled', () => {
    const view = diagnosticsView(
      body([declared('/a', 1000, 24_000)], { '/a': spread(24, 1000) }),
      NOW
    )
    expect(view.windowComplete).toBe(true)
    expect(view.verdict.kind).toBe('agrees')
  })
})

describe('the total, once there is a window to judge it against', () => {
  const totalView = (measuredPerHour: number, predictedPerDay: number) =>
    diagnosticsView(
      body([declared('/a', 1000, predictedPerDay)], {
        '/a': spread(24, measuredPerHour)
      }),
      NOW
    )

  it('agrees inside the threshold', () => {
    // 1.2x, inside 25%.
    expect(totalView(1000, 20_000).verdict.kind).toBe('agrees')
    expect(TOTAL_DIVERGENCE).toBe(0.25)
  })

  // #223: the form said 5 KB a poll while the plugin was fetching 42 KB. The
  // shape of that failure is over-fetching against a prediction, and it is the
  // one this whole design was built to catch.
  it('reports over-fetching, which is the configuration screen understating cost', () => {
    const view = totalView(1000, 12_000)
    expect(view.verdict.kind).toBe('over')
    expect(view.totalRatio).toBe(2)
  })

  // Not the same finding, and not the same fix: less traffic than predicted
  // almost always means something is not running rather than something is
  // cheap, so it gets its own wording rather than a shared "diverged".
  it('reports under-fetching separately', () => {
    expect(totalView(1000, 96_000).verdict.kind).toBe('under')
  })

  it('says nothing when the settings predict nothing', () => {
    const view = diagnosticsView(
      body([declared('/a', 0, 0)], { '/a': spread(24, 0) }),
      NOW
    )
    expect(view.verdict.kind).toBe('nothing')
  })
})

describe("one endpoint's size against its declaration", () => {
  const sizeView = (perFetch: number, fetches: number) =>
    diagnosticsView(
      body([declared(SCALES.subPath, 1000, 24_000)], {
        [SCALES.subPath]: [
          bucket(0, { fetches, wireBytes: perFetch * fetches })
        ]
      }),
      NOW
    ).rows[0]

  // The comparison that needs no window at all: 42 KB arriving where 5 KB was
  // declared is visible on the first few fetches, a day before the total can
  // say anything.
  it('is judged without waiting for the window', () => {
    const row = sizeView(2000, MIN_SIZE_SAMPLES)
    expect(row.sizeRatio).toBe(2)
    expect(row.sizeDiverged).toBe(true)
    expect(row.dayDiverged).toBe(false)
  })

  // Set loose on purpose: xray-flares-7-day.json is one record per flare and
  // alerts.json is a rolling 30-day archive, so both genuinely swell over an
  // active week. A tight line here would fire during exactly the storm a
  // reader opened the page for.
  it('tolerates ordinary variation up to the threshold', () => {
    expect(SIZE_DIVERGENCE).toBe(0.5)
    expect(sizeView(1400, MIN_SIZE_SAMPLES).sizeDiverged).toBe(false)
    // Exactly half again is the boundary and is not yet an accusation.
    expect(sizeView(1500, MIN_SIZE_SAMPLES).sizeDiverged).toBe(false)
    expect(sizeView(1600, MIN_SIZE_SAMPLES).sizeDiverged).toBe(true)
    // And the same tolerance downwards, which is what a payload that shrank
    // looks like -- NOAA dropping a field is the same class of drift.
    expect(sizeView(400, MIN_SIZE_SAMPLES).sizeDiverged).toBe(true)
  })

  // A torn read is a short body, and one of them is not a drift.
  it('will not accuse on fewer samples than it takes to be a trend', () => {
    expect(sizeView(100, MIN_SIZE_SAMPLES - 1).sizeDiverged).toBe(false)
    expect(sizeView(100, MIN_SIZE_SAMPLES).sizeDiverged).toBe(true)
  })

  // Without this an endpoint that started failing would read as one that got
  // smaller -- the opposite of what is wrong with it.
  it('divides by the fetches that carried a body, not by every request', () => {
    const row = diagnosticsView(
      body([declared('/a', 1000, 24_000)], {
        '/a': [
          bucket(0, { fetches: 6, wireBytes: 4000, errors: 1, notModified: 3 })
        ]
      }),
      NOW
    ).rows[0]
    expect(row.bodyFetches).toBe(2)
    expect(row.perFetch).toBe(2000)
  })
})

describe('a row that is wrong in a way no window can excuse', () => {
  // The settings say this endpoint should not be fetched at all, and it is.
  // Nothing about a partial window makes that reading any less true.
  it('flags traffic on an endpoint the settings switched off, immediately', () => {
    const row = diagnosticsView(
      body([declared('/a', 1000, 0)], {
        '/a': [bucket(0, { wireBytes: 900 })]
      }),
      NOW
    ).rows[0]
    expect(row.predictedBytes).toBe(0)
    expect(row.dayDiverged).toBe(true)
  })

  // A declared endpoint that has not been fetched in a whole day. Only says
  // anything once the day is real -- see the collecting tests above.
  it('flags an endpoint that has gone silent, but only after a full window', () => {
    const silent = (windowHours: number) =>
      diagnosticsView(
        body([declared('/a', 1000, 24_000), declared('/b', 1000, 24_000)], {
          '/a': spread(windowHours, 1000)
        }),
        NOW
      ).rows.find((row: any) => row.subPath === '/b')
    expect(silent(24).silent).toBe(true)
    expect(silent(3).silent).toBe(false)
  })

  // The client refuses an undeclared fetch and a test walks the registry, so
  // this should be unreachable -- which is exactly why it must not be dropped
  // on the floor if it ever happens.
  it('gives a row to an endpoint the declarations do not carry', () => {
    const view = diagnosticsView(
      body([declared('/a', 1000, 24_000)], {
        '/a': spread(24, 1000),
        '/undeclared': [bucket(0, { wireBytes: 5000 })]
      }),
      NOW
    )
    const row = view.rows.find((r: any) => r.subPath === '/undeclared')
    expect(row).toBeDefined()
    expect(row.productName).toBeNull()
    expect(row.dayDiverged).toBe(true)
  })
})

describe('the 24-hour window is applied globally, not per endpoint', () => {
  // src/meter.ts prunes an endpoint's buckets relative to that endpoint's own
  // newest fetch, so one that stopped being fetched can still be carrying
  // buckets older than now - 24h. Counting those would report yesterday's
  // traffic as today's -- and hide the very thing a silent endpoint should
  // show.
  it('leaves out a bucket that has aged past the window', () => {
    const view = diagnosticsView(
      body([declared('/a', 1000, 24_000)], {
        '/a': [
          bucket(40, { wireBytes: 99_000 }),
          bucket(0, { wireBytes: 1000 })
        ]
      }),
      NOW
    )
    expect(view.measuredBytes).toBe(1000)
  })
})

describe('what is failing now, as opposed to what failed today', () => {
  const record = (subPath: string, outcome: string, startedAt: number) => ({
    subPath,
    productName: 'p',
    trigger: 'schedule',
    startedAt,
    durationMs: 10,
    status: 200,
    wireBytes: 100,
    wireBytesEstimated: false,
    decodedBytes: 100,
    outcome
  })

  it('reads the newest record per endpoint, not any record', () => {
    const errors = currentErrors([
      record('/recovered', 'timeout', NOW - 3 * HOUR),
      record('/recovered', 'ok', NOW - HOUR),
      record('/broken', 'ok', NOW - 3 * HOUR),
      record('/broken', 'httpError', NOW - HOUR)
    ])
    expect(errors.map((e: any) => e.subPath)).toEqual(['/broken'])
  })

  // 304 is a successful conditional GET, not a failure.
  it('does not count a not-modified as a failure', () => {
    expect(currentErrors([record('/a', 'notModified', NOW)])).toEqual([])
  })
})

// A browser's `fetch` decompresses transparently and does not expose the
// compressed length, so the demo running these products in a tab (#239) records
// decoded sizes. Those are roughly ten times a real cost, and the declarations
// they would be compared against are measured wire sizes -- so a panel that did
// not know would report a tenfold over-fetch on a plugin behaving perfectly.
describe('a runtime that does not report transfer sizes', () => {
  const estimatedView = () =>
    diagnosticsView(
      body([declared('/a', 1000, 24_000)], {
        '/a': spread(24, 10_000).map((b) => ({ ...b, estimated: b.fetches }))
      }),
      NOW
    )

  it('judges nothing, rather than reporting a tenfold over-fetch', () => {
    const view = estimatedView()
    expect(view.totalRatio).toBe(10)
    expect(view.estimated).toBe(true)
    expect(view.verdict.kind).toBe('estimated')
    expect(view.rows[0].sizeDiverged).toBe(false)
    expect(view.rows[0].dayDiverged).toBe(false)
  })

  it('has nothing to put on the footstrip either', () => {
    expect(footstripNote(estimatedView())).toBeNull()
  })

  // One estimated endpoint puts its decoded bytes into the total, so the total
  // is not judgeable even though every other row is.
  it('withholds the total when only one endpoint is estimated', () => {
    const view = diagnosticsView(
      body([declared('/a', 1000, 24_000), declared('/b', 1000, 24_000)], {
        '/a': spread(24, 1000),
        '/b': spread(24, 10_000).map((b) => ({ ...b, estimated: b.fetches }))
      }),
      NOW
    )
    expect(view.verdict.kind).toBe('estimated')
    expect(view.rows.find((r: any) => r.subPath === '/a').estimated).toBe(false)
  })

  // The one finding a decoded size cannot spoil: that a fetch happened at all
  // on an endpoint the settings predict at zero.
  it('still flags traffic the settings predict at zero', () => {
    const row = diagnosticsView(
      body([declared('/a', 1000, 0)], {
        '/a': [bucket(0, { wireBytes: 9000, estimated: 1 })]
      }),
      NOW
    ).rows[0]
    expect(row.estimated).toBe(true)
    expect(row.dayDiverged).toBe(true)
  })
})

describe('a page with no plugin behind it', () => {
  it('reads as having no telemetry rather than throwing', () => {
    for (const empty of [null, undefined, {}, { ring: [] }]) {
      expect(diagnosticsView(empty, NOW).ok).toBe(false)
    }
  })
})
