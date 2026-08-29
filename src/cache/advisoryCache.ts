/** Persists the raw Advisory Outlook bulletin so the webapp can read it back without depending on a notification path. */
import type { CacheEntry, CacheStore } from './entryCache.js'
import { readCacheEntry, writeCacheEntry } from './entryCache.js'

const CACHE_FILENAME = 'advisory-outlook.json'

export interface AdvisoryCacheEntry extends CacheEntry {
  issued: string
  idLine: string
  teaser: string | null
  text: string
}

export function writeAdvisoryCache(
  store: CacheStore,
  entry: Omit<AdvisoryCacheEntry, 'fetchedAt'>
): void {
  writeCacheEntry<AdvisoryCacheEntry>(store, CACHE_FILENAME, entry)
}

export function readAdvisoryCache(
  store: CacheStore
): AdvisoryCacheEntry | null {
  return readCacheEntry<AdvisoryCacheEntry>(
    store,
    CACHE_FILENAME,
    (parsed) =>
      typeof parsed.issued === 'string' && typeof parsed.text === 'string'
  )
}
