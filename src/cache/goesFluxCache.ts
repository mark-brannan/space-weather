/**
 * Persists the GOES flux history between restarts. The endpoint the product
 * polls carries six hours and the history it publishes is weeks, so without
 * this a restart would put the chart back to a six-hour stub and it would take
 * the whole window to grow back.
 */
import type { CacheEntry, CacheStore } from './entryCache.js'
import { readCacheEntry, writeCacheEntry } from './entryCache.js'
import type { FluxPoint } from '../parse.js'

const CACHE_FILENAME = 'goes-flux.json'

export interface GoesFluxCacheEntry extends CacheEntry {
  xray: FluxPoint[]
  proton: FluxPoint[]
}

export function writeGoesFluxCache(
  store: CacheStore,
  entry: Omit<GoesFluxCacheEntry, 'fetchedAt'>
): void {
  writeCacheEntry<GoesFluxCacheEntry>(store, CACHE_FILENAME, entry)
}

const isSeries = (value: unknown): value is FluxPoint[] =>
  Array.isArray(value) &&
  value.every(
    (point) =>
      typeof point?.time === 'string' &&
      Number.isFinite(Date.parse(point.time)) &&
      typeof point.value === 'number' &&
      point.value > 0
  )

export function readGoesFluxCache(
  store: CacheStore
): GoesFluxCacheEntry | null {
  return readCacheEntry<GoesFluxCacheEntry>(
    store,
    CACHE_FILENAME,
    (parsed) => isSeries(parsed.xray) && isSeries(parsed.proton)
  )
}
