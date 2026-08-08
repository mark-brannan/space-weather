/**
 * Persists the raw OVATION grid to the plugin's own data directory, so the
 * ~900 KB fetch happens exactly once per interval, server-side, and both the
 * probability-at-position value and the webapp's map read the same capture.
 *
 * Before this, the webapp fetched NOAA directly from the browser -- a second,
 * independent ~900 KB request, and one that only works if the browser has its
 * own path to the internet separate from the Signal K server's. Caching here
 * and serving it back over the plugin's own HTTP route removes both problems:
 * one fetch, and the browser only ever talks to the server it already loaded
 * the page from.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

const CACHE_FILENAME = 'aurora-grid.json'

export interface AuroraCacheEntry {
  fetchedAt: string
  grid: any
}

/**
 * Write-then-rename rather than a direct write, so a reader (the HTTP route,
 * on a different tick) never sees a half-written file. Same-directory rename
 * is atomic on the filesystems Signal K actually runs on.
 */
export function writeAuroraCache(dataDirPath: string, grid: any): void {
  const finalPath = join(dataDirPath, CACHE_FILENAME)
  const tmpPath = finalPath + '.tmp'
  const entry: AuroraCacheEntry = { fetchedAt: new Date().toISOString(), grid }
  writeFileSync(tmpPath, JSON.stringify(entry))
  renameSync(tmpPath, finalPath)
}

/** Never throws: a missing or corrupt cache file is "nothing cached yet". */
export function readAuroraCache(dataDirPath: string): AuroraCacheEntry | null {
  const path = join(dataDirPath, CACHE_FILENAME)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed.fetchedAt !== 'string' || !parsed.grid)
      return null
    return parsed
  } catch {
    return null
  }
}
