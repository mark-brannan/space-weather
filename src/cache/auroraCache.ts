/**
 * Persists the raw OVATION grid to the plugin's own data directory, so the
 * ~900 KB fetch happens exactly once per interval, server-side, and the
 * probability-at-position value, the webapp's map and the chart-plotter tiles
 * all read the same capture.
 *
 * Before this, the webapp fetched NOAA directly from the browser -- a second,
 * independent ~900 KB request, and one that only works if the browser has its
 * own path to the internet separate from the Signal K server's. Caching here
 * and serving it back over the plugin's own HTTP route removes both problems:
 * one fetch, and the browser only ever talks to the server it already loaded
 * the page from.
 *
 * It is also what lets the fetch happen with no vessel position at all: the
 * grid is global, so it is worth buying whether or not anything can be indexed
 * out of it yet, and the point value is published from here when a fix turns
 * up. See src/products/aurora.ts.
 */
import type { CacheEntry, CacheStore } from './entryCache.js'
import { readCacheEntry, writeCacheEntry } from './entryCache.js'

const CACHE_FILENAME = 'aurora-grid.json'

export interface AuroraCacheEntry extends CacheEntry {
  grid: any
}

export function writeAuroraCache(store: CacheStore, grid: any): void {
  writeCacheEntry<AuroraCacheEntry>(store, CACHE_FILENAME, { grid })
}

export function readAuroraCache(store: CacheStore): AuroraCacheEntry | null {
  return readCacheEntry<AuroraCacheEntry>(
    store,
    CACHE_FILENAME,
    (parsed) => !!parsed.grid
  )
}
