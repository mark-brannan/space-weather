// Every Signal K path the webapp reads, in one list, so which path feeds
// which surface is something a test can assert on -- issue #120 was a URL
// inline in index.html's fetch list, invisible to the whole suite.
import { SCALES_NOW, SCALES_OBSERVED } from './scales-source.js'

const API = '/signalk/v1/api'
const vessel = (path) => `${API}/vessels/self/${path}`
const plugin = (route) => `${API}/signalk-noaa-space-weather/${route}`

// readAll fetches every row every refresh, so a row nothing draws costs a
// request a minute for nothing. Add one when a surface starts reading it.
export const ENDPOINTS = {
  scalesNow: vessel(SCALES_NOW),
  scalesObserved: vessel(SCALES_OBSERVED),
  scalesForecast: vessel('environment/noaa/swpc/scales/forecast'),
  kp: vessel('environment/noaa/swpc/kp'),
  solarWind: vessel('environment/noaa/swpc/solar_wind'),
  aurora: vessel('environment/noaa/swpc/aurora'),
  xrayFlare: vessel('environment/noaa/swpc/xray_flare'),
  // The HF Radio and Solar Activity tiles. Six paths the plugin has always
  // published and nothing drew, which is why they were absent here.
  xrayFlux: vessel('environment/noaa/swpc/xray_flux'),
  protonFlux: vessel('environment/noaa/swpc/proton_flux'),
  drap: vessel('environment/noaa/swpc/drap'),
  f107: vessel('environment/noaa/swpc/f107'),
  aIndex: vessel('environment/noaa/swpc/a_index'),
  sunspotNumber: vessel('environment/noaa/swpc/sunspot_number'),
  // The whole alerts subtree, one leaf per NOAA message code. The hero reads
  // the watches out of it (`watchAhead` in hero.js); it is one request either
  // way, and per-code paths are not knowable in advance.
  alerts: vessel('notifications/noaa/swpc/alerts'),
  position: vessel('navigation/position'),
  // Nothing publishes this yet -- the MUF is issue #82, and the HF tile draws
  // its half of the gauge as explicitly unmeasured until something does. The
  // row is here rather than added later because a 404 reads as null through
  // `getJson`, and the tile then needs no second change to start drawing it.
  muf: vessel('environment/noaa/swpc/muf'),
  advisory: plugin('advisory-outlook'),
  status: plugin('status')
}

// `read` is passed in so the caller keeps its own auth and error handling; a
// 401 on any one of these means the same thing for all of them.
export async function readAll(read) {
  const ids = Object.keys(ENDPOINTS)
  const values = await Promise.all(ids.map((id) => read(ENDPOINTS[id])))
  return Object.fromEntries(ids.map((id, i) => [id, values[i]]))
}

// A leaf is `{value, timestamp, $source, meta}`, but not every node is one: a
// vessel name is a bare string, and an object with no `value` is a path
// carrying only `meta` -- described at startup, never published.
export const leafValue = (node) =>
  node && typeof node === 'object'
    ? 'value' in node
      ? node.value
      : null
    : (node ?? null)

// `meta` is described once at startup and rides on the same node as the
// value; the HF tile's solar-flux gauge is drawn from the published zone
// ladder rather than a second copy of it.
export const leafMeta = (node) =>
  node && typeof node === 'object' && node.meta && typeof node.meta === 'object'
    ? node.meta
    : null

export const leafTime = (node) => (node && node.timestamp) || null

// --- the plugin's own routes, and the server's preferences ----------------
//
// Here for the same reason the vessel paths above are: one module owns every
// call the webapp's own page makes, so the GitHub Pages demo (#199, #239)
// substitutes this file and the shipping page runs over a snapshot
// unchanged. `remoteEntry.js`/`config-panel.js` are the admin UI's config
// screen, not the page, and still read the server themselves.

// The plugin's cached grids, read back from the fetch it already made
// server-side for the value at the vessel. Reading one never reaches NOAA.
const GRID_ROUTE = {
  aurora: plugin('aurora-grid'),
  drap: plugin('drap-grid')
}

// Manual "fetch now": forces the plugin to fetch NOAA off its schedule,
// cooldown-limited server-side (see aurora-refresh in src/index.ts). Works
// with automatic updates switched off, which is the case it mostly exists
// for: that setting is about what the plugin spends on its own initiative,
// and a press is not that.
const REFRESH_ROUTE = {
  aurora: plugin('aurora-refresh'),
  drap: plugin('drap-refresh')
}

/**
 * The plugin's own fetch instrumentation (docs/instrumentation-design.md's
 * surface 1). Deliberately not a row in `ENDPOINTS` above: everything there is
 * read on every poll, and this body carries the meter's whole 200-record ring
 * -- tens of kilobytes for a panel that is closed most of the time. The
 * diagnostics panel asks for it on its own slower cadence and whenever it is
 * opened instead.
 */
const TELEMETRY = plugin('telemetry')

// The server's own API, not a Signal K path, so it hangs off neither helper.
const UNIT_PREFERENCES = '/signalk/v1/unitpreferences/active'

// Thrown by getJson on 401/403 so refresh() can tell "you're not logged in"
// apart from "nothing published yet" (both used to render as the same
// blank/zero UI, which is indistinguishable from a broken plugin).
export class AuthRequiredError extends Error {}

export async function getJson(path) {
  let res
  try {
    res = await fetch(path, { cache: 'no-store' })
  } catch {
    return null // offline / DNS / etc. -- not an auth problem
  }
  if (res.status === 401 || res.status === 403) {
    throw new AuthRequiredError(path)
  }
  if (!res.ok) return null
  try {
    return await res.json()
  } catch {
    return null
  }
}

/**
 * The telemetry route's body, or null. `getJson` answers null for the 503 a
 * stopped plugin sends and for a server too old to have the route, both of
 * which the panel draws as "no telemetry" rather than as a failure.
 */
export async function fetchTelemetry() {
  return getJson(TELEMETRY)
}

export async function fetchGridCache(which) {
  const url = GRID_ROUTE[which]
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (res.status === 401 || res.status === 403) {
    throw new AuthRequiredError(url)
  }
  const body = await res.json().catch(() => null)
  if (res.status === 404) {
    const err = new Error((body && body.error) || 'Nothing cached yet.')
    err.notCached = true
    throw err
  }
  if (!res.ok) throw new Error(`Server responded ${res.status}`)
  return body // { fetchedAt, grid }
}

// Seconds a refusal asks the reader to wait, off the header the refresh
// route sends. Here rather than in aurora.js because `remoteEntry.js` is
// fetched and evaluated on every admin page load and imports this module:
// an edge from here to a presentation module would pull the aurora colour
// ramp onto that hot path for every user, opened plugin or not.
/**
 * Seconds off a `Retry-After` header, or null if it does not carry one this
 * side can count down. The route always sends integer seconds; a proxy in
 * front of it may not send the header at all, and HTTP also allows a date
 * form, which is not worth parsing for a countdown that has a fallback.
 */
export function retryAfterSeconds(header) {
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null
}

export async function forceRefresh(which) {
  const url = REFRESH_ROUTE[which]
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (res.status === 401 || res.status === 403) {
    throw new AuthRequiredError(url)
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error(
      (body && body.error) || `Server responded ${res.status}`
    )
    err.status = res.status
    err.retryAfterSeconds = retryAfterSeconds(res.headers.get('Retry-After'))
    throw err
  }
  return body
}

// The reader's own distance unit, read from the server's Unit Preferences API
// (https://github.com/SignalK/signalk-server) rather than hardcoded nmi
// (Mark's round-3 review) -- a plain function of km, so a caller never needs
// to know where the preference came from. Null when there is no usable one:
// servers without that API (older ones, or none set) 404, and the nmi the
// caller already had is the only thing there is to fall back to.
export async function distanceUnitPreference() {
  try {
    const res = await fetch(UNIT_PREFERENCES, {
      headers: { Accept: 'application/json' }
    })
    if (!res.ok) return null
    const prefs = await res.json()
    const distance = prefs?.categories?.distance
    // Never eval a formula that isn't plain arithmetic on `value` -- the
    // server is a trusted origin for the numbers it publishes, but not
    // trusted enough to hand it script execution over a preferences file a
    // reader could edit or a proxy could tamper with. Strip every literal
    // "value" token out first and check what's left is only digits,
    // whitespace and arithmetic -- no other identifier can survive that.
    const formula = distance?.formula
    if (
      !formula ||
      !/^[\d\s.+\-*/()]*$/.test(formula.split('value').join(''))
    ) {
      return null
    }
    const convert = new Function('value', `"use strict"; return (${formula})`)
    const digits = Math.min(
      6,
      (distance.displayFormat?.split('.')[1] || '').length
    )
    const unit = distance.symbol || distance.targetUnit
    // Surviving the character allowlist above doesn't make a formula callable
    // arithmetic (`value(value)` passes it and throws), and a unit-less
    // reading is meaningless. Prove both once here, synchronously, rather
    // than throwing out of the caller's redraw every time.
    if (!unit || !Number.isFinite(convert(1000))) return null
    return (km) => `${convert(km * 1000).toFixed(digits)} ${unit}`
  } catch {
    // Network hiccup or a malformed response -- nmi is still a correct
    // answer, just not necessarily the reader's preferred one.
    return null
  }
}
