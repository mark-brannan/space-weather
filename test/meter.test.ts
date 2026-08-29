import { describe, expect, it } from 'vitest'
import {
  createMeter,
  FetchRecord,
  flushTotals,
  loadTotals,
  maybeFlushTotals,
  Meter,
  meterSnapshot,
  recordFetch
} from '../src/meter'
import { CacheStore } from '../src/cache/entryCache'

const HOUR_MS = 60 * 60 * 1000

/** An in-memory CacheStore, so tier-3 persistence is tested with no filesystem. */
function memoryStore(): CacheStore & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    readCache: (filename) => files.get(filename) ?? null,
    writeCache: (filename, text) => {
      files.set(filename, text)
    }
  }
}

function entry(overrides: Partial<FetchRecord> = {}): FetchRecord {
  return {
    subPath: '/products/noaa-scales.json',
    productName: 'Scales',
    trigger: 'schedule',
    startedAt: 0,
    durationMs: 10,
    status: 200,
    wireBytes: 100,
    wireBytesEstimated: false,
    decodedBytes: 120,
    outcome: 'ok',
    ...overrides
  }
}

describe('recordFetch: tier 1, the ring', () => {
  it('keeps the most recent 200 and drops the oldest first', () => {
    const meter = createMeter()
    for (let i = 0; i < 205; i++) {
      recordFetch(meter, entry({ startedAt: i, durationMs: i }))
    }
    expect(meter.ring).toHaveLength(200)
    expect(meter.ring[0].durationMs).toBe(5)
    expect(meter.ring[199].durationMs).toBe(204)
  })
})

describe('recordFetch: tier 2, the rolling 24 hours', () => {
  it('folds same-hour fetches into one bucket per endpoint', () => {
    const meter = createMeter()
    recordFetch(meter, entry({ startedAt: 0, wireBytes: 100 }))
    recordFetch(meter, entry({ startedAt: 1000, wireBytes: 200 }))

    const buckets = meter.hourly.get('/products/noaa-scales.json')!
    expect(buckets).toHaveLength(1)
    expect(buckets[0].fetches).toBe(2)
    expect(buckets[0].wireBytes).toBe(300)
  })

  it('rolls a new bucket in on the hour and keeps at most 24', () => {
    const meter = createMeter()
    for (let hour = 0; hour < 30; hour++) {
      recordFetch(meter, entry({ startedAt: hour * HOUR_MS }))
    }
    const buckets = meter.hourly.get('/products/noaa-scales.json')!
    expect(buckets).toHaveLength(24)
    // The oldest 6 hours fell off the front.
    expect(buckets[0].hourStart).toBe(6 * HOUR_MS)
    expect(buckets[23].hourStart).toBe(29 * HOUR_MS)
  })

  it('bounds the window by hours, not by bucket count', () => {
    // An endpoint polled every two hours: 24 buckets would span two days and
    // be read as one day's traffic.
    const meter = createMeter()
    for (let hour = 0; hour < 60; hour += 2) {
      recordFetch(meter, entry({ startedAt: hour * HOUR_MS }))
    }
    const buckets = meter.hourly.get('/products/noaa-scales.json')!
    expect(buckets[buckets.length - 1].hourStart).toBe(58 * HOUR_MS)
    expect(buckets[0].hourStart).toBe(36 * HOUR_MS)
    expect(buckets).toHaveLength(12)
  })

  it('counts notModified and every non-ok outcome separately from errors', () => {
    const meter = createMeter()
    recordFetch(meter, entry({ outcome: 'ok' }))
    recordFetch(meter, entry({ outcome: 'notModified' }))
    recordFetch(meter, entry({ outcome: 'httpError' }))
    recordFetch(meter, entry({ outcome: 'timeout' }))

    const bucket = meter.hourly.get('/products/noaa-scales.json')![0]
    expect(bucket.fetches).toBe(4)
    expect(bucket.notModified).toBe(1)
    expect(bucket.errors).toBe(2)
  })

  it('keeps endpoints in separate buckets, keyed by subPath not product', () => {
    const meter = createMeter()
    recordFetch(
      meter,
      entry({ subPath: '/json/goes/primary/xrays-6-hour.json' })
    )
    recordFetch(
      meter,
      entry({ subPath: '/json/goes/secondary/xrays-6-hour.json' })
    )

    expect(meter.hourly.size).toBe(2)
  })
})

describe('meterSnapshot', () => {
  it('is a JSON-safe copy: mutating it does not touch the meter', () => {
    const meter = createMeter()
    recordFetch(meter, entry())

    const snapshot = meterSnapshot(meter)
    snapshot.ring.push(entry({ startedAt: 999 }))
    snapshot.hourly['/products/noaa-scales.json'].push({
      hourStart: 999,
      fetches: 1,
      wireBytes: 1,
      decodedBytes: 1,
      errors: 0,
      notModified: 0
    })

    expect(meter.ring).toHaveLength(1)
    expect(meter.hourly.get('/products/noaa-scales.json')).toHaveLength(1)
  })

  it('turns the hourly Map into a plain object keyed by subPath', () => {
    const meter = createMeter()
    recordFetch(meter, entry())
    const snapshot = meterSnapshot(meter)
    expect(Object.keys(snapshot.hourly)).toEqual(['/products/noaa-scales.json'])
  })
})

describe('recordFetch: tier 3, totals since install', () => {
  it('keeps accumulating past the ring limit and the 24-hour window', () => {
    const meter = createMeter()
    for (let hour = 0; hour < 30; hour++) {
      recordFetch(meter, entry({ startedAt: hour * HOUR_MS, wireBytes: 10 }))
    }
    const totals = meter.totals.get('/products/noaa-scales.json')!
    expect(totals.fetches).toBe(30)
    expect(totals.wireBytes).toBe(300)
  })

  it('counts notModified and errors the same way the hourly bucket does', () => {
    const meter = createMeter()
    recordFetch(meter, entry({ outcome: 'ok' }))
    recordFetch(meter, entry({ outcome: 'notModified' }))
    recordFetch(meter, entry({ outcome: 'httpError' }))

    const totals = meter.totals.get('/products/noaa-scales.json')!
    expect(totals.fetches).toBe(3)
    expect(totals.notModified).toBe(1)
    expect(totals.errors).toBe(1)
  })

  it('keeps endpoints separate, same as the hourly buckets', () => {
    const meter = createMeter()
    recordFetch(meter, entry({ subPath: '/a.json' }))
    recordFetch(meter, entry({ subPath: '/b.json' }))
    expect(meter.totals.size).toBe(2)
  })

  it('marks the meter dirty and returns whether the hourly bucket rolled over', () => {
    const meter = createMeter()
    expect(meter.totalsDirty).toBe(false)

    const first = recordFetch(meter, entry({ startedAt: 0 }))
    expect(first).toBe(true) // the very first bucket for this endpoint
    expect(meter.totalsDirty).toBe(true)

    meter.totalsDirty = false // simulate a flush having just happened
    const sameHour = recordFetch(meter, entry({ startedAt: 1000 }))
    expect(sameHour).toBe(false)
    expect(meter.totalsDirty).toBe(true) // recordFetch always dirties, rollover or not

    const nextHour = recordFetch(meter, entry({ startedAt: HOUR_MS }))
    expect(nextHour).toBe(true)
  })
})

describe('meterSnapshot: totals', () => {
  it('includes totals, as a JSON-safe copy independent of the meter', () => {
    const meter = createMeter()
    recordFetch(meter, entry({ wireBytes: 100 }))
    const snapshot = meterSnapshot(meter)

    expect(snapshot.totals['/products/noaa-scales.json'].fetches).toBe(1)
    snapshot.totals['/products/noaa-scales.json'].fetches = 999
    expect(meter.totals.get('/products/noaa-scales.json')!.fetches).toBe(1)
  })
})

describe('tier 3 persistence: flushTotals, maybeFlushTotals, loadTotals', () => {
  it('flushTotals writes nothing when the meter is not dirty', () => {
    const meter = createMeter()
    const store = memoryStore()
    flushTotals(meter, store, 0)
    expect(store.files.size).toBe(0)
  })

  it('flushTotals writes when dirty, then clears dirty and stamps totalsFlushedAt', () => {
    const meter = createMeter()
    recordFetch(meter, entry())
    const store = memoryStore()

    flushTotals(meter, store, 5000)

    expect(store.files.size).toBe(1)
    expect(meter.totalsDirty).toBe(false)
    expect(meter.totalsFlushedAt).toBe(5000)
  })

  it('maybeFlushTotals does nothing when nothing moved', () => {
    const meter = createMeter()
    const store = memoryStore()
    maybeFlushTotals(meter, store, 0)
    expect(store.files.size).toBe(0)
  })

  it('maybeFlushTotals flushes immediately the first time, even mid-hour', () => {
    const meter = createMeter()
    recordFetch(meter, entry())
    const store = memoryStore()

    maybeFlushTotals(meter, store, 1000)

    expect(store.files.size).toBe(1)
    expect(meter.totalsFlushedAt).toBe(1000)
  })

  it('maybeFlushTotals refuses a second flush inside the same hour', () => {
    const meter = createMeter()
    recordFetch(meter, entry())
    const store = memoryStore()
    maybeFlushTotals(meter, store, 0)

    recordFetch(meter, entry({ startedAt: HOUR_MS - 1 }))
    maybeFlushTotals(meter, store, HOUR_MS - 1)

    // Still dirty -- the gate held it back, it wasn't dropped.
    expect(meter.totalsDirty).toBe(true)
    expect(meter.totalsFlushedAt).toBe(0)
  })

  it('maybeFlushTotals flushes again once an hour has passed', () => {
    const meter = createMeter()
    recordFetch(meter, entry())
    const store = memoryStore()
    maybeFlushTotals(meter, store, 0)

    recordFetch(meter, entry({ startedAt: HOUR_MS }))
    maybeFlushTotals(meter, store, HOUR_MS)

    expect(meter.totalsDirty).toBe(false)
    expect(meter.totalsFlushedAt).toBe(HOUR_MS)
  })

  it('round-trips through loadTotals into a fresh meter', () => {
    const meter = createMeter()
    recordFetch(meter, entry({ wireBytes: 42 }))
    recordFetch(meter, entry({ subPath: '/b.json', wireBytes: 7 }))
    const store = memoryStore()
    flushTotals(meter, store, 0)

    const reloaded = createMeter()
    loadTotals(reloaded, store)

    expect(reloaded.totals.get('/products/noaa-scales.json')!.wireBytes).toBe(
      42
    )
    expect(reloaded.totals.get('/b.json')!.wireBytes).toBe(7)
    // Loading does not itself dirty the meter or touch tiers 1/2.
    expect(reloaded.totalsDirty).toBe(false)
    expect(reloaded.ring).toHaveLength(0)
  })

  it('discards a file that fails to parse, rather than partially trusting it', () => {
    const store = memoryStore()
    store.files.set('meter-totals.json', '{not json')
    const meter = createMeter()

    loadTotals(meter, store)

    expect(meter.totals.size).toBe(0)
  })

  it('discards a file whose totals do not match the expected shape', () => {
    const store = memoryStore()
    store.files.set(
      'meter-totals.json',
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        totals: { '/a.json': { fetches: 'not a number' } }
      })
    )
    const meter = createMeter()

    loadTotals(meter, store)

    expect(meter.totals.size).toBe(0)
  })

  it('does nothing when there is no file cached yet', () => {
    const meter: Meter = createMeter()
    loadTotals(meter, memoryStore())
    expect(meter.totals.size).toBe(0)
  })
})
