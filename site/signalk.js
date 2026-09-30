// The site's stand-in for public/signalk.js: the same exports, the same
// shapes, and two things behind them instead of a Signal K server:
//
//   live      the core's own product modules, fetching NOAA from this tab at
//             the device's position when granted, DEMO_POSITION otherwise
//             (the default)
//   snapshot  one saved NOAA capture, site/snapshot.json, on ?snapshot
//
// scripts/build-site.mjs copies this file over signalk.js in the assembled
// site, so public/index.html itself, and every module it imports, runs
// unchanged against either. This file is the whole seam: if the page can
// reach a server any other way, the site silently draws nothing.
//
// Live is the default: the site should show what the plugin shows on a boat,
// and a saved capture never quite does. The snapshot stays on ?snapshot -- it
// costs NOAA nothing, and it is how to show a stormy moment in a quiet week.
import { createDocumentSeam } from './plugin/browser/seam.js'
import {
  createLocalStore,
  coarsenPosition,
  readLastPosition,
  writeLastPosition
} from './store.js'

export {
  ENDPOINTS,
  AuthRequiredError,
  treeFromValues,
  nodeAt,
  leafValue,
  leafMeta,
  leafTime,
  retryAfterSeconds
} from './plugin/browser/seam.js'

/**
 * Which data layer this page is running. Read once, from the URL, before
 * anything else in the module body -- the clock install at the end depends on
 * it. No `location` is the test suite, which drives the snapshot layer: live
 * needs a network the suite runs without.
 */
export const LIVE =
  typeof location !== 'undefined' &&
  !new URLSearchParams(location.search).has('snapshot')

// --- The snapshot's clock --------------------------------------------------
//
// The page decides for itself whether what it is showing is current: STALE_MS
// in public/index.html is three hours, measured against the data's own
// timestamps. A saved capture is older than that within an afternoon, so on a
// real clock the page would read "STALE DATA ... This is not an all-clear"
// forever -- true of a live install, false of a snapshot.
//
// So ?snapshot runs on the capture's clock. `Date.now()` and `new Date()`
// answer `capturedAt + (real now - the moment the snapshot loaded)`: an
// offset, not a freeze, so the countdowns tick exactly as they do on a boat.
// Live data is real and current, so it runs on the real clock.

const RealDate = Date
let clockShiftMs = 0
let clockAdopted = false
const shiftedNow = () => RealDate.now() + clockShiftMs

/**
 * `Date`, with the zero-argument constructor and `now()` moved onto the
 * capture's clock and nothing else touched. `new Date(iso)` has to keep
 * parsing exactly what it is given -- the page parses every NOAA timestamp
 * through it.
 *
 * A Proxy rather than a subclass so `Date.prototype`, `Date.parse`,
 * `Date.UTC` and every `x instanceof Date` in the page keep their identity.
 */
export const DemoDate = new Proxy(RealDate, {
  construct: (target, args, newTarget) =>
    Reflect.construct(target, args.length ? args : [shiftedNow()], newTarget),
  // `Date()` without `new` is a string of the current time.
  apply: () => new RealDate(shiftedNow()).toString(),
  get: (target, prop, receiver) =>
    prop === 'now' ? shiftedNow : Reflect.get(target, prop, receiver)
})

/**
 * Point the clock at the captured instant. Once only: the page re-reads the
 * snapshot on every poll, and re-adopting would rewind "now" each time.
 */
export function adoptCaptureClock(capturedAt) {
  if (clockAdopted) return
  const capturedMs = RealDate.parse(capturedAt)
  if (!Number.isFinite(capturedMs)) return
  clockAdopted = true
  clockShiftMs = capturedMs - RealDate.now()
}

let loaded = null
/** The parsed snapshot: {capturedAt, values, grids, routes}. Fetched once. */
export function snapshot() {
  if (!loaded)
    loaded = fetch('./snapshot.json')
      .then((res) => {
        if (!res.ok) throw new Error(`snapshot.json: HTTP ${res.status}`)
        return res.json()
      })
      .then((data) => {
        adoptCaptureClock(data.capturedAt)
        return data
      })
      .catch((err) => {
        // Memoising a rejection would make one failed load permanent; the
        // page already polls on a timer, so let the next caller try again.
        loaded = null
        throw err
      })
  return loaded
}

// --- The position (live) ---------------------------------------------------
//
// The device's fix when the reader grants it, coarsened; the last run's fix
// if one was stored; otherwise the plugin's own DEMO_POSITION, which
// startLivePlugin falls back to when handed no position. Not imported here:
// a ?snapshot visitor must not download the live closure to read a constant.

const listeners = new Set()
let current = readLastPosition()

/** The device's (coarsened) fix, or null while on the stand-in. */
export const position = () => current
export function onPosition(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Coarsened here and nowhere else, so the drawn position and the stored one
// cannot be two answers.
function adopt(fix) {
  const next = coarsenPosition(fix)
  // `watchPosition` fires about once a second while moving and coarsening
  // makes most of those identical; each one re-parses both cached grids.
  if (
    current &&
    next.latitude === current.latitude &&
    next.longitude === current.longitude
  )
    return
  current = next
  writeLastPosition(next)
  live()
    .then((p) => p.setPosition(next))
    .catch(() => {})
  for (const listener of listeners) listener(next)
}

// `watchPosition` because `setPosition` redraws out of cache, never from NOAA.
let watch = null
export function requestPosition() {
  if (!('geolocation' in navigator)) return
  if (watch !== null) navigator.geolocation.clearWatch(watch)
  watch = navigator.geolocation.watchPosition(
    ({ coords }) =>
      adopt({ latitude: coords.latitude, longitude: coords.longitude }),
    () => {
      // Keep whatever the page already stands on: a stored fix, or the
      // stand-in. A refusal is not a reason to draw nothing.
      for (const listener of listeners) listener(current)
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 }
  )
}

// --- The live data layer ---------------------------------------------------
//
// The core's products, compiled to dist/ and copied into the site under
// plugin/, running here against NOAA with no server and no bundler. Imported
// dynamically: a snapshot visitor must not download the product closure, and
// the precached shell should not wait on it before first paint.
let livePlugin = null
function live() {
  if (!livePlugin)
    livePlugin = import('./plugin/browser/live.js')
      .then(({ startLivePlugin }) =>
        startLivePlugin({
          // undefined, not null: undefined is what selects DEMO_POSITION.
          // Without props the core's DEMO_PROPS apply, the settings the
          // snapshot is captured under too. Whether the site should force
          // the grids on is an open ruling; one copy of the answer, not two.
          position: current ?? undefined,
          store: createLocalStore()
        })
      )
      .catch((err) => {
        // Not memoised as a permanent failure, for the snapshot's reason.
        livePlugin = null
        throw err
      })
  return livePlugin
}

/**
 * The document this page is reading, in one shape whichever layer produced it:
 * `{values, grids, routes}`, which is exactly what snapshot.json holds.
 */
let firstPaint = null
async function document_() {
  if (!LIVE) return snapshot()
  const plugin = await live()
  // Every read on the first poll waits on the same promise -- `readAll` asks
  // for every path at once. After that the document is read live.
  firstPaint ??= plugin.ready.catch(() => {})
  await firstPaint
  return plugin.document()
}

let seamInstance = null
const seam = () =>
  (seamInstance ??= createDocumentSeam({
    document: document_,
    forceRefresh: (which) => forceRefresh(which)
  }))

/**
 * The document-backed reads. Each answers null rather than rejecting on a
 * transport failure, as `getJson` in public/signalk.js does; a rejection would
 * escape `refresh()` in index.html and freeze the page.
 */
export const getJson = (path) => seam().getJson(path)
export const readAll = (read = getJson) => seam().readAll(read)
export const fetchTelemetry = () => seam().fetchTelemetry()
export const fetchGridCache = (which) => seam().fetchGridCache(which)

/**
 * Live, the button does what it says: this page is the plugin, so it fetches,
 * and its refusals are the plugin's own cooldown and 502.
 *
 * On ?snapshot it has to fail, honestly. 503 is the one kind of refusal
 * `refreshFailure` in aurora.js labels that is true here: a saved capture on a
 * static host, with no plugin running behind it.
 */
export async function forceRefresh(which) {
  if (LIVE) return (await live()).refresh(which)
  const err = new Error(
    'This is a saved NOAA snapshot on a static page — there is no plugin' +
      ' running behind it to fetch with. Open the live page, or install the' +
      ' plugin on your own Signal K server.'
  )
  err.status = 503
  throw err
}

/** No server to hold a preference; null leaves the page on its nmi default. */
export async function distanceUnitPreference() {
  return null
}

// The install, last in the file because the top-level await needs everything
// above it. On ?snapshot, `await` at module scope holds index.html's body
// until the capture is in, which closes the window where the page could read
// a real `Date.now()` first.
//
// Guarded on `window` so importing this module in the test suite neither
// repoints the runner's clock, starts fetching NOAA, nor asks for a location.
if (typeof window !== 'undefined') {
  if (LIVE) {
    live().catch(() => {})
    requestPosition()
  } else {
    globalThis.Date = DemoDate
    await snapshot().catch(() => {})
  }
}
