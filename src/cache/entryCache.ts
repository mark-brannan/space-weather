/**
 * The shape every cached NOAA payload here shares: one JSON file per product
 * in the plugin's own data directory, written whole and stamped with the
 * instant it was written. Three products cache one now, so the file mechanics
 * live here and each of them keeps only its own type and its own validation.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

/** Every entry carries when it was written; readers diff it to spot a new one. */
export interface CacheEntry {
  fetchedAt: string
}

/**
 * Write-then-rename rather than a direct write, so a reader (an HTTP route, on
 * a different tick) never sees a half-written file. Same-directory rename is
 * atomic on the filesystems Signal K actually runs on.
 */
export function writeCacheEntry<T extends CacheEntry>(
  dataDirPath: string,
  filename: string,
  body: Omit<T, 'fetchedAt'>
): void {
  const finalPath = join(dataDirPath, filename)
  const tmpPath = finalPath + '.tmp'
  const entry = { fetchedAt: new Date().toISOString(), ...body }
  writeFileSync(tmpPath, JSON.stringify(entry))
  renameSync(tmpPath, finalPath)
}

/** Never throws: a missing, corrupt or unrecognised file is "nothing cached yet". */
export function readCacheEntry<T extends CacheEntry>(
  dataDirPath: string,
  filename: string,
  isComplete: (parsed: Record<string, unknown>) => boolean
): T | null {
  const path = join(dataDirPath, filename)
  if (!existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const entry = parsed as Record<string, unknown>
    if (typeof entry.fetchedAt !== 'string') return null
    return isComplete(entry) ? (entry as T) : null
  } catch {
    return null
  }
}
