// The live layer's CacheStore: the same two synchronous string methods the
// products take, over localStorage, so a cold start paints from the last
// fetch rather than waiting on a ~900 KB grid.

const PREFIX = 'noaa-space-weather:cache:'

/**
 * Private browsing and blocked cookies make the `localStorage` *getter* throw,
 * not just the call, so the try/catch has to wrap the access itself. A read
 * probe, not a write: a full store is still readable, and running out of room
 * is `writeCache`'s to handle.
 */
function available() {
  try {
    localStorage.getItem(`${PREFIX}probe`)
    return true
  } catch {
    return false
  }
}

/**
 * A write that will not fit is dropped, not raised: the products treat a miss
 * as "fetch it again", where raising would abort a refresh already in hand.
 */
export function createLocalStore() {
  if (!available()) {
    const memory = new Map()
    return {
      readCache: (name) => memory.get(name) ?? null,
      writeCache: (name, text) => void memory.set(name, text),
      persistent: false
    }
  }

  return {
    readCache(name) {
      try {
        return localStorage.getItem(PREFIX + name)
      } catch {
        return null
      }
    },
    writeCache(name, text) {
      const key = PREFIX + name
      const write = () => localStorage.setItem(key, text)
      try {
        return void write()
      } catch {
        // Out of quota.
      }
      // The stale copy of this same entry first: going straight to the full
      // clear makes the two grids evict each other turn about, so the store
      // converges on holding one of them.
      try {
        localStorage.removeItem(key)
        return void write()
      } catch {
        // Still out of quota.
      }
      try {
        for (const other of Object.keys(localStorage)) {
          if (other.startsWith(PREFIX)) localStorage.removeItem(other)
        }
        write()
      } catch {
        // Dropped on purpose; the next refresh re-fetches.
      }
    },
    persistent: true
  }
}

const POSITION_KEY = 'noaa-space-weather:position'

/** One place is a tenth of a degree: ~11 km, coarser than any grid we index. */
const POSITION_PLACES = 1

/** Why coarsening rather than encryption: docs/design-decisions.md. */
export function coarsenPosition(position) {
  if (!position) return null
  // toFixed, not multiply-round-divide: the latter leaves binary-float dust.
  const round = (v) => Number(v.toFixed(POSITION_PLACES))
  return {
    latitude: round(position.latitude),
    longitude: round(position.longitude)
  }
}

/** Outside PREFIX so a quota clear cannot take it: it is two numbers. */
export function readLastPosition() {
  try {
    const saved = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null')
    return typeof saved?.latitude === 'number' &&
      typeof saved?.longitude === 'number'
      ? { latitude: saved.latitude, longitude: saved.longitude }
      : null
  } catch {
    return null
  }
}

export function writeLastPosition(position) {
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify(position))
  } catch {
    // A viewpoint that does not persist is still a viewpoint for this run.
  }
}
