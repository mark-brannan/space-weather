/**
 * Pure accounting of what the plugin has fetched from NOAA. No `app`, no
 * network, no clock of its own -- every timestamp arrives as an argument, so
 * this is unit-testable with no server and no fetch mock. See
 * docs/instrumentation-design.md.
 *
 * Three tiers are described there; only the first two exist yet:
 *
 * - Tier 1, the ring: the last 200 fetch records, full detail, never
 *   persisted. "What has it been doing the last few hours."
 * - Tier 2, the rolling 24 hours: per endpoint, one bucket of aggregate
 *   counts per hour, for the 24 hours up to its newest fetch. What a
 *   daily-cost comparison reads.
 *
 * Tier 3 (totals since install, persisted) is a later phase.
 */

export type Trigger = 'schedule' | 'manual' | 'webapp'

export type Outcome =
  | 'ok'
  | 'notModified'
  | 'httpError'
  | 'timeout'
  | 'networkError'
  | 'torn'
  | 'parseError'

export interface FetchRecord {
  /** The key -- counters are per endpoint, not per product. */
  subPath: string
  /** Rolled up for display only. */
  productName: string
  /** A press is not the plugin's own initiative, and the bill should say so. */
  trigger: Trigger
  startedAt: number
  durationMs: number
  status: number | null
  /** The compressed size, from `content-length`. What the fetch actually cost. */
  wireBytes: number | null
  /** True when `content-length` was absent and `decodedBytes` stood in for it. */
  wireBytesEstimated: boolean
  decodedBytes: number | null
  outcome: Outcome
}

export interface HourBucket {
  /** Epoch ms, floored to the hour. */
  hourStart: number
  fetches: number
  wireBytes: number
  decodedBytes: number
  errors: number
  notModified: number
}

const RING_LIMIT = 200
const HOURLY_BUCKETS = 24
const HOUR_MS = 60 * 60 * 1000

export interface Meter {
  ring: FetchRecord[]
  hourly: Map<string, HourBucket[]>
}

export function createMeter(): Meter {
  return { ring: [], hourly: new Map() }
}

function isError(outcome: Outcome): boolean {
  return outcome !== 'ok' && outcome !== 'notModified'
}

/**
 * Append one fetch to the ring and fold it into its endpoint's current hourly
 * bucket, dropping any bucket that has aged out of the 24-hour window.
 *
 * The window is measured in hours, not in buckets: an endpoint polled once
 * every two hours would otherwise accumulate 24 buckets spanning two days and
 * report them as a day's traffic. Only a fetch advances it -- the meter has no
 * clock of its own -- so a snapshot's oldest bucket can still predate
 * `now - 24h` for an endpoint that has stopped being fetched. `hourStart` is
 * on every bucket, which is what lets a reader see that.
 */
export function recordFetch(meter: Meter, entry: FetchRecord): void {
  meter.ring.push(entry)
  if (meter.ring.length > RING_LIMIT) meter.ring.shift()

  const hourStart = Math.floor(entry.startedAt / HOUR_MS) * HOUR_MS
  const oldest = hourStart - (HOURLY_BUCKETS - 1) * HOUR_MS
  const buckets = (meter.hourly.get(entry.subPath) ?? []).filter(
    (b) => b.hourStart >= oldest
  )
  let bucket = buckets[buckets.length - 1]
  if (!bucket || bucket.hourStart !== hourStart) {
    bucket = {
      hourStart,
      fetches: 0,
      wireBytes: 0,
      decodedBytes: 0,
      errors: 0,
      notModified: 0
    }
    buckets.push(bucket)
  }
  bucket.fetches += 1
  bucket.wireBytes += entry.wireBytes ?? 0
  bucket.decodedBytes += entry.decodedBytes ?? 0
  if (entry.outcome === 'notModified') bucket.notModified += 1
  if (isError(entry.outcome)) bucket.errors += 1
  meter.hourly.set(entry.subPath, buckets)
}

/** JSON-safe view for the /telemetry route: the ring, and each endpoint's hourly buckets. */
export function meterSnapshot(meter: Meter): {
  ring: FetchRecord[]
  hourly: Record<string, HourBucket[]>
} {
  const hourly: Record<string, HourBucket[]> = {}
  for (const [subPath, buckets] of meter.hourly)
    hourly[subPath] = buckets.slice()
  return { ring: meter.ring.slice(), hourly }
}
