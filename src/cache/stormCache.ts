/**
 * Persists the collapsed storm notification's state machine between polls and
 * across restarts. Without it, a restart mid-hold forgets when the in-force
 * set went quiet and re-times the whole hold, and a restart mid-storm loses
 * the message the path should republish into a fresh server model.
 */
import type { CacheEntry, CacheStore } from './entryCache.js'
import { readCacheEntry, writeCacheEntry } from './entryCache.js'

const CACHE_FILENAME = 'storm.json'

export interface StormCacheEntry extends CacheEntry {
  /** 0 when stood down, otherwise the G level the path is raised at. */
  level: number
  /** ISO instant the in-force set dropped below G3, while still holding. */
  belowSince: string | null
  /** The driving alert's headline and issue instant, for republishing. */
  message: string
  issued: string
}

export function writeStormCache(
  store: CacheStore,
  entry: Omit<StormCacheEntry, 'fetchedAt'>
): void {
  writeCacheEntry<StormCacheEntry>(store, CACHE_FILENAME, entry)
}

export function readStormCache(store: CacheStore): StormCacheEntry | null {
  return readCacheEntry<StormCacheEntry>(
    store,
    CACHE_FILENAME,
    (parsed) =>
      typeof parsed.level === 'number' &&
      (parsed.belowSince === null || typeof parsed.belowSince === 'string') &&
      typeof parsed.message === 'string' &&
      typeof parsed.issued === 'string'
  )
}
