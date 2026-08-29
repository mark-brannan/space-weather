import { describe, expect, it } from 'vitest'
import {
  createMeter,
  FetchRecord,
  meterSnapshot,
  recordFetch
} from '../src/meter'

const HOUR_MS = 60 * 60 * 1000

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
