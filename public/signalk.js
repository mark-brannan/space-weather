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
