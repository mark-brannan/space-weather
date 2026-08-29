/**
 * The shape every cached NOAA payload here shares: one JSON document per
 * product, written whole and stamped with the instant it was written. Three
 * products cache one now, so the mechanics live here and each of them keeps
 * only its own type and its own validation.
 *
 * Storage is taken rather than reached for. This file used to import `fs` and
 * `path` directly, which made it -- and through it the aurora, D-RAP and
 * advisory products -- unloadable anywhere without a filesystem. The browser
 * demo (#239) runs these same product modules, so the two primitives it needs
 * come from the `CacheStore` it is handed. `createPublisher` supplies the
 * server's, and it is the same argument as the rest of publisher.ts: one
 * module owns the host, everything downstream takes it as a parameter.
 */

/**
 * Somewhere to keep one small document per name. Implemented against the
 * filesystem in publisher.ts; the browser demo implements it against memory.
 */
export interface CacheStore {
  /** The document, or null if there is not one -- never throws for absence. */
  readCache(filename: string): string | null
  /** Replace the document whole. Atomicity, where it matters, is the store's. */
  writeCache(filename: string, text: string): void
}

/** Every entry carries when it was written; readers diff it to spot a new one. */
export interface CacheEntry {
  fetchedAt: string
}

export function writeCacheEntry<T extends CacheEntry>(
  store: CacheStore,
  filename: string,
  body: Omit<T, 'fetchedAt'>
): void {
  const entry = { fetchedAt: new Date().toISOString(), ...body }
  store.writeCache(filename, JSON.stringify(entry))
}

/** Never throws: a missing, corrupt or unrecognised document is "nothing cached yet". */
export function readCacheEntry<T extends CacheEntry>(
  store: CacheStore,
  filename: string,
  isComplete: (parsed: Record<string, unknown>) => boolean
): T | null {
  try {
    const text = store.readCache(filename)
    if (text === null) return null
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return null
    const entry = parsed as Record<string, unknown>
    if (typeof entry.fetchedAt !== 'string') return null
    return isComplete(entry) ? (entry as T) : null
  } catch {
    return null
  }
}
