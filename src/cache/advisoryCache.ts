/** Persists the raw Advisory Outlook bulletin so the webapp can read it back without depending on a notification path. */
import { CacheEntry, readCacheEntry, writeCacheEntry } from './entryCache.js'

const CACHE_FILENAME = 'advisory-outlook.json'

export interface AdvisoryCacheEntry extends CacheEntry {
  issued: string
  idLine: string
  teaser: string | null
  text: string
}

export function writeAdvisoryCache(
  dataDirPath: string,
  entry: Omit<AdvisoryCacheEntry, 'fetchedAt'>
): void {
  writeCacheEntry<AdvisoryCacheEntry>(dataDirPath, CACHE_FILENAME, entry)
}

export function readAdvisoryCache(
  dataDirPath: string
): AdvisoryCacheEntry | null {
  return readCacheEntry<AdvisoryCacheEntry>(
    dataDirPath,
    CACHE_FILENAME,
    (parsed) =>
      typeof parsed.issued === 'string' && typeof parsed.text === 'string'
  )
}
