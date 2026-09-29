// Where the page reads its numbers for. Usually the vessel, but a reader can
// name somewhere else -- a destination, home, the dock the boat is not at --
// or ask the browser where it is. One chain, the same in every consumer: the
// Signal K plugin, the standalone app and the demo all publish a vessel
// position through signalk.js, and this decides whether the page uses it.
//
// The choice is the page's alone, per browser. The server's published values
// and the notifications raised from them stay at the vessel: they mean "here,
// on board", and a chart plotter alarming for somewhere a reader was browsing
// would be wrong data, not a preference.

const STORAGE_KEY = 'space-weather.viewpoint'

const HEMISPHERE = /^([-+]?\d+(?:\.\d+)?)\s*°?\s*([NSEW])?$/i

function coordinate(text, positive, negative, limit) {
  const match = HEMISPHERE.exec(text.trim())
  if (!match) return null
  let value = Number(match[1])
  const hemisphere = match[2]?.toUpperCase()
  if (hemisphere) {
    if (hemisphere !== positive && hemisphere !== negative) return null
    if (value < 0) return null
    if (hemisphere === negative) value = -value
  }
  return Math.abs(value) <= limit ? value : null
}

/**
 * `"60.4, 5.3"`, `"60.4 5.3"`, `"33.9S 151.2E"` -> `{latitude, longitude}`,
 * or null for anything that is not unambiguously a place.
 */
export function parseCoords(text) {
  if (typeof text !== 'string') return null
  const parts = text
    .trim()
    .split(/\s*,\s*|\s+(?=[-+]?\d)/)
    .filter(Boolean)
  if (parts.length !== 2) return null
  const latitude = coordinate(parts[0], 'N', 'S', 90)
  const longitude = coordinate(parts[1], 'E', 'W', 180)
  if (latitude === null || longitude === null) return null
  return { latitude, longitude }
}

function isPosition(value) {
  return (
    !!value &&
    Number.isFinite(value.latitude) &&
    Number.isFinite(value.longitude) &&
    Math.abs(value.latitude) <= 90 &&
    Math.abs(value.longitude) <= 180
  )
}

/**
 * The chain: a place the reader chose, then the vessel, then nothing. The
 * demo's stand-in arrives as the vessel, so it needs no rung of its own.
 */
export function resolveViewpoint(chosen, vessel) {
  if (isPosition(chosen)) {
    return {
      latitude: chosen.latitude,
      longitude: chosen.longitude,
      source: chosen.source === 'device' ? 'device' : 'entered'
    }
  }
  if (isPosition(vessel)) {
    return {
      latitude: vessel.latitude,
      longitude: vessel.longitude,
      source: 'vessel'
    }
  }
  return null
}

export const SOURCE_LABEL = {
  vessel: 'vessel',
  entered: 'entered',
  device: 'this device'
}

/**
 * What the reader chose, if anything: `?at=lat,lon` first, so a link can
 * carry a place, then what this browser remembered. A query that parses is
 * remembered in turn. Storage can throw (private windows, blocked site data),
 * and the page must work without it.
 */
export function readChosen(search, storage) {
  const at = new URLSearchParams(search || '').get('at')
  const fromQuery = at ? parseCoords(at) : null
  if (fromQuery) {
    const chosen = { ...fromQuery, source: 'entered' }
    writeChosen(storage, chosen)
    return chosen
  }
  try {
    const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null')
    return isPosition(saved) ? saved : null
  } catch {
    return null
  }
}

/**
 * Remember a choice, or forget it with null. A device fix is not remembered:
 * it answers "where am I now", and read back on a later visit it would still
 * say "this device" about wherever the device was then.
 */
export function writeChosen(storage, chosen) {
  try {
    if (chosen && chosen.source !== 'device') {
      storage?.setItem(STORAGE_KEY, JSON.stringify(chosen))
    }
    else storage?.removeItem(STORAGE_KEY)
  } catch {
    // Unremembered is fine: the choice still holds for this visit.
  }
}

/**
 * Whether "Use my location" can work at all. Browsers withhold geolocation
 * from insecure contexts, and a Signal K server on the boat's LAN is usually
 * plain http -- there the button would only ever fail, so it is not offered.
 */
export function canLocate(win) {
  return !!win?.isSecureContext && !!win.navigator?.geolocation
}

/** Two decimals is about a kilometre: the grids are a degree or coarser. */
export function formatCoords(position) {
  return `${position.latitude.toFixed(2)}, ${position.longitude.toFixed(2)}`
}
