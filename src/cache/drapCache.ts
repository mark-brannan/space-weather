/**
 * Persists the parsed D-RAP grid, for the same reason src/cache/auroraCache.ts
 * persists OVATION's: NOAA serves one grid covering the whole globe, the
 * plugin buys all of it, and publishing one cell out of it and discarding the
 * rest wastes a payload that is already paid for.
 *
 * Parsed rather than raw, unlike aurora: the wire format is a fixed-width text
 * table, and every reader here wants the numbers. Re-parsing it per tile
 * render or per HTTP request would be work with no reader for the text.
 */
import { DrapGrid } from '../parse.js'
import type { CacheEntry, CacheStore } from './entryCache.js'
import { readCacheEntry, writeCacheEntry } from './entryCache.js'

const CACHE_FILENAME = 'drap-grid.json'

export interface DrapCacheEntry extends CacheEntry {
  grid: DrapGrid
}

export function writeDrapCache(store: CacheStore, grid: DrapGrid): void {
  writeCacheEntry<DrapCacheEntry>(store, CACHE_FILENAME, { grid })
}

export function readDrapCache(store: CacheStore): DrapCacheEntry | null {
  return readCacheEntry<DrapCacheEntry>(store, CACHE_FILENAME, (parsed) => {
    const grid = parsed.grid as DrapGrid | undefined
    return (
      !!grid &&
      Array.isArray(grid.latitudes) &&
      Array.isArray(grid.longitudes) &&
      Array.isArray(grid.frequenciesMHz) &&
      grid.frequenciesMHz.length === grid.latitudes.length &&
      grid.frequenciesMHz.every(
        (row) => Array.isArray(row) && row.length === grid.longitudes.length
      )
    )
  })
}
