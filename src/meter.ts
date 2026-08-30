/**
 * Pure accounting of what the plugin has fetched from NOAA. No `app`, no
 * network, no clock of its own -- every timestamp arrives as an argument, so
 * this is unit-testable with no server and no fetch mock. Persistence is
 * pure the same way: `loadTotals`/`flushTotals`/`maybeFlushTotals` take a
 * `CacheStore` (see src/cache/entryCache.ts) rather than touching `fs`
 * themselves, so a test can back it with an in-memory store. See
 * docs/instrumentation-design.md.
 *
 * Three tiers:
 *
 * - Tier 1, the ring: the last 200 fetch records, full detail, never
 *   persisted. "What has it been doing the last few hours."
 * - Tier 2, the rolling 24 hours: per endpoint, one bucket of aggregate
 *   counts per hour, for the 24 hours up to its newest fetch. What a
 *   daily-cost comparison reads.
 * - Tier 3, totals since install: per endpoint, cumulative counts, flushed
 *   to disk on the tier-2 rollover (at most hourly, only if something
 *   moved) plus once at stop(). See "Persistence and flash wear" in the
 *   design doc for why the cadence is this stingy.
 */

import {
  CacheEntry,
  CacheStore,
  readCacheEntry,
  writeCacheEntry
} from './cache/entryCache.js'

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
  /**
   * Of `fetches`, how many had no `content-length` and so contributed their
   * *decoded* size to `wireBytes` above. Kept because a reader comparing these
   * bytes against a declared, measured wire size has to be able to tell: gzip
   * makes the decoded size roughly ten times the real cost, and quoting one as
   * a cost is the thing docs/instrumentation-design.md forbids outright.
   *
   * A browser is the case this exists for. The demo runs these same products
   * in a tab (#239), where `fetch` decompresses transparently and does not
   * expose the compressed length -- so every figure there is estimated, and a
   * surface that did not know would report a tenfold over-fetch on a plugin
   * behaving perfectly.
   */
  estimated: number
}

/** Tier 3: cumulative since install. Same fields as HourBucket, minus the hour it belongs to -- there isn't one. */
export interface EndpointTotals {
  fetches: number
  wireBytes: number
  decodedBytes: number
  errors: number
  notModified: number
}

const RING_LIMIT = 200
const HOURLY_BUCKETS = 24
const HOUR_MS = 60 * 60 * 1000
/** "Flush at most hourly" from the design doc's flash-wear budget. */
const MIN_FLUSH_INTERVAL_MS = HOUR_MS
const TOTALS_FILENAME = 'meter-totals.json'

export interface Meter {
  ring: FetchRecord[]
  hourly: Map<string, HourBucket[]>
  /**
   * Called at most once per `recordFetch`, when that call opens a new
   * tier-2 hourly bucket for its endpoint. Phase 3's Signal K paths hang
   * their publish off this rather than firing on every fetch -- the meter
   * already knows when a bucket rolls over, so nothing downstream should
   * reimplement that detection against a clock of its own.
   */
  onRollover?: () => void
  totals: Map<string, EndpointTotals>
  /** Set by recordFetch whenever a counter moves; cleared once flushed. The gate for "only if the counters moved". */
  totalsDirty: boolean
  /** Epoch ms of the last successful flush, or null before the first one. */
  totalsFlushedAt: number | null
}

export function createMeter(onRollover?: () => void): Meter {
  return {
    ring: [],
    hourly: new Map(),
    onRollover,
    totals: new Map(),
    totalsDirty: false,
    totalsFlushedAt: null
  }
}

function isError(outcome: Outcome): boolean {
  return outcome !== 'ok' && outcome !== 'notModified'
}

/**
 * Append one fetch to the ring, fold it into its endpoint's current hourly
 * bucket (dropping any bucket that has aged out of the 24-hour window), and
 * add it to the endpoint's since-install totals.
 *
 * The window is measured in hours, not in buckets: an endpoint polled once
 * every two hours would otherwise accumulate 24 buckets spanning two days and
 * report them as a day's traffic. Only a fetch advances it -- the meter has no
 * clock of its own -- so a snapshot's oldest bucket can still predate
 * `now - 24h` for an endpoint that has stopped being fetched. `hourStart` is
 * on every bucket, which is what lets a reader see that.
 *
 * Returns whether this fetch started a new hourly bucket -- the trigger the
 * design doc names for considering a tier-3 flush. The caller owns the
 * clock and the CacheStore, so it decides what to do with that; recordFetch
 * itself never touches either.
 */
export function recordFetch(meter: Meter, entry: FetchRecord): boolean {
  meter.ring.push(entry)
  if (meter.ring.length > RING_LIMIT) meter.ring.shift()

  const hourStart = Math.floor(entry.startedAt / HOUR_MS) * HOUR_MS
  const oldest = hourStart - (HOURLY_BUCKETS - 1) * HOUR_MS
  const buckets = (meter.hourly.get(entry.subPath) ?? []).filter(
    (b) => b.hourStart >= oldest
  )
  let bucket = buckets[buckets.length - 1]
  const rolledOver = !bucket || bucket.hourStart !== hourStart
  if (rolledOver) {
    bucket = {
      hourStart,
      fetches: 0,
      wireBytes: 0,
      decodedBytes: 0,
      errors: 0,
      notModified: 0,
      estimated: 0
    }
    buckets.push(bucket)
  }
  bucket.fetches += 1
  bucket.wireBytes += entry.wireBytes ?? 0
  bucket.decodedBytes += entry.decodedBytes ?? 0
  if (entry.wireBytesEstimated) bucket.estimated += 1
  if (entry.outcome === 'notModified') bucket.notModified += 1
  if (isError(entry.outcome)) bucket.errors += 1
  meter.hourly.set(entry.subPath, buckets)

  const totals = meter.totals.get(entry.subPath) ?? {
    fetches: 0,
    wireBytes: 0,
    decodedBytes: 0,
    errors: 0,
    notModified: 0
  }
  totals.fetches += 1
  totals.wireBytes += entry.wireBytes ?? 0
  totals.decodedBytes += entry.decodedBytes ?? 0
  if (entry.outcome === 'notModified') totals.notModified += 1
  if (isError(entry.outcome)) totals.errors += 1
  meter.totals.set(entry.subPath, totals)
  meter.totalsDirty = true

  // Fired only after the triggering fetch is folded into the bucket and
  // stored, so a listener reading meterTotals() from inside the callback
  // sees it counted.
  if (rolledOver) meter.onRollover?.()

  return rolledOver
}

/**
 * Rolling 24h totals across every endpoint, as of `now`.
 *
 * Not a sum over whatever `meter.hourly` currently holds: a bucket list is
 * only pruned to the last 24 hours *relative to that endpoint's own newest
 * fetch* (see `recordFetch`'s comment), so an endpoint that has stopped being
 * fetched can still be carrying buckets older than `now - 24h`. This applies
 * that same window globally instead, which is what a total published under
 * one Signal K path needs to mean.
 */
export function meterTotals(
  meter: Meter,
  now: number
): { bytesPerDay: number; fetchesPerDay: number; errorsPerDay: number } {
  // A bucket covers a full hour, so one that started up to 24h (not 23h)
  // before `now` can still overlap the last 24 hours -- e.g. now = 30.5h,
  // a bucket started at 6h covers up to 7h and its 6.75h fetch is only
  // 23.75h old. Using HOURLY_BUCKETS rather than HOURLY_BUCKETS - 1 keeps
  // that boundary bucket in.
  const oldest = Math.floor(now / HOUR_MS) * HOUR_MS - HOURLY_BUCKETS * HOUR_MS
  let bytesPerDay = 0
  let fetchesPerDay = 0
  let errorsPerDay = 0
  for (const buckets of meter.hourly.values()) {
    for (const bucket of buckets) {
      if (bucket.hourStart < oldest) continue
      bytesPerDay += bucket.wireBytes
      fetchesPerDay += bucket.fetches
      errorsPerDay += bucket.errors
    }
  }
  return { bytesPerDay, fetchesPerDay, errorsPerDay }
}

/** JSON-safe view for the /telemetry route: the ring, each endpoint's hourly buckets, and its totals since install. */
export function meterSnapshot(meter: Meter): {
  ring: FetchRecord[]
  hourly: Record<string, HourBucket[]>
  totals: Record<string, EndpointTotals>
} {
  const hourly: Record<string, HourBucket[]> = {}
  for (const [subPath, buckets] of meter.hourly)
    hourly[subPath] = buckets.slice()
  const totals: Record<string, EndpointTotals> = {}
  for (const [subPath, t] of meter.totals) totals[subPath] = { ...t }
  return { ring: meter.ring.slice(), hourly, totals }
}

function isEndpointTotals(value: unknown): value is EndpointTotals {
  if (!value || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  return (
    typeof t.fetches === 'number' &&
    typeof t.wireBytes === 'number' &&
    typeof t.decodedBytes === 'number' &&
    typeof t.errors === 'number' &&
    typeof t.notModified === 'number'
  )
}

interface TotalsCacheEntry extends CacheEntry {
  totals: Record<string, EndpointTotals>
}

/**
 * Loads tier 3 from disk into an (otherwise empty, just-started) meter.
 * Call once, at start() -- see index.ts for why it isn't the constructor.
 *
 * A file that fails to parse, or doesn't match the shape, is discarded
 * rather than partially trusted: the same rule `firstJsonValue` in parse.ts
 * applies to a torn NOAA payload applies here. There is no complete total to
 * recover from a corrupt one, so starting over at zero is the honest answer.
 */
export function loadTotals(meter: Meter, store: CacheStore): void {
  const entry = readCacheEntry<TotalsCacheEntry>(
    store,
    TOTALS_FILENAME,
    (parsed) => {
      const totals = parsed.totals
      return (
        !!totals &&
        typeof totals === 'object' &&
        Object.values(totals as Record<string, unknown>).every(isEndpointTotals)
      )
    }
  )
  if (!entry) return
  for (const [subPath, totals] of Object.entries(entry.totals))
    meter.totals.set(subPath, { ...totals })
}

/**
 * Writes tier 3 to disk, unconditionally on the hourly gate -- used once in
 * stop(), and by maybeFlushTotals once it has already decided to. Still
 * skips the write when nothing has moved since the last flush: an unwritten
 * erase block is cheaper than any write, even one that would write back the
 * same bytes.
 */
export function flushTotals(
  meter: Meter,
  store: CacheStore,
  now: number
): void {
  if (!meter.totalsDirty) return
  const totals: Record<string, EndpointTotals> = {}
  for (const [subPath, t] of meter.totals) totals[subPath] = { ...t }
  writeCacheEntry<TotalsCacheEntry>(store, TOTALS_FILENAME, { totals })
  meter.totalsDirty = false
  meter.totalsFlushedAt = now
}

/**
 * The flash-wear discipline itself: call this whenever recordFetch reports a
 * tier-2 rollover, and it writes at most once an hour, only if a counter
 * actually moved since the last write. See "Persistence and flash wear" in
 * docs/instrumentation-design.md for why the budget is this stingy.
 */
export function maybeFlushTotals(
  meter: Meter,
  store: CacheStore,
  now: number
): void {
  if (!meter.totalsDirty) return
  if (
    meter.totalsFlushedAt !== null &&
    now - meter.totalsFlushedAt < MIN_FLUSH_INTERVAL_MS
  )
    return
  flushTotals(meter, store, now)
}
