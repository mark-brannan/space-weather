/** Persists the raw Advisory Outlook bulletin so the webapp can read it back without depending on a notification path. */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

const CACHE_FILENAME = 'advisory-outlook.json'

export interface AdvisoryCacheEntry {
  fetchedAt: string
  issued: string
  idLine: string
  teaser: string | null
  text: string
}

/** Write-then-rename so a concurrent read never sees a half-written file. */
export function writeAdvisoryCache(
  dataDirPath: string,
  entry: Omit<AdvisoryCacheEntry, 'fetchedAt'>
): void {
  const finalPath = join(dataDirPath, CACHE_FILENAME)
  const tmpPath = finalPath + '.tmp'
  const full: AdvisoryCacheEntry = {
    fetchedAt: new Date().toISOString(),
    ...entry
  }
  writeFileSync(tmpPath, JSON.stringify(full))
  renameSync(tmpPath, finalPath)
}

/** Never throws: a missing or corrupt cache file is "nothing cached yet". */
export function readAdvisoryCache(
  dataDirPath: string
): AdvisoryCacheEntry | null {
  const path = join(dataDirPath, CACHE_FILENAME)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (
      !parsed ||
      typeof parsed.fetchedAt !== 'string' ||
      typeof parsed.issued !== 'string' ||
      typeof parsed.text !== 'string'
    )
      return null
    return parsed
  } catch {
    return null
  }
}
