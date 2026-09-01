/**
 * The page's data layer, over a document rather than a server.
 *
 * `public/signalk.js` is the only module the shipping page reaches the server
 * through. Two other things now sit behind that same seam -- the GitHub Pages
 * demo and the standalone app -- and both answer the page out of the same
 * `{values, tree, grids, routes}` document: the shape `demo/snapshot.json`
 * holds on disk and `src/browser/live.ts` assembles in memory. That the two
 * are one shape is the whole reason the page needs no branch of its own.
 *
 * So this is the part of those layers that is not about *where* the document
 * came from. What is left to each caller is only that: the demo chooses
 * between a saved capture and a live plugin, the app always runs the plugin.
 * Written here, in `src/browser/`, because a site copies `dist/` in already
 * and `test/browser-closure.test.ts` walks this directory -- a Node import
 * added to it fails a test rather than a page.
 */
import type { Leaf } from './publisher.js'

/**
 * The vessel paths the page reads, by the name it knows each one by.
 *
 * A `null` marks a surface that is not a vessel path at all: the plugin's own
 * routes have no path and neither is reconstructable from one -- the advisory
 * route serves the bulletin `text` and `idLine` no published path carries, and
 * `status` describes a running plugin. Those are answered out of `routes`
 * instead, via `ROUTE_OF`.
 */
export const ENDPOINTS: Record<string, string | null> = {
  scalesNow: 'environment/noaa/swpc/scales/observations/latest',
  scalesObserved: 'environment/noaa/swpc/scales/observations/24_hours_maximums',
  scalesForecast: 'environment/noaa/swpc/scales/forecast',
  kp: 'environment/noaa/swpc/kp',
  solarWind: 'environment/noaa/swpc/solar_wind',
  aurora: 'environment/noaa/swpc/aurora',
  xrayFlare: 'environment/noaa/swpc/xray_flare',
  xrayFlux: 'environment/noaa/swpc/xray_flux',
  protonFlux: 'environment/noaa/swpc/proton_flux',
  drap: 'environment/noaa/swpc/drap',
  f107: 'environment/noaa/swpc/f107',
  aIndex: 'environment/noaa/swpc/a_index',
  sunspotNumber: 'environment/noaa/swpc/sunspot_number',
  alerts: 'notifications/noaa/swpc/alerts',
  position: 'navigation/position',
  // No document carries this yet -- the MUF is issue #82 -- and `nodeAt`
  // answers null, which is the same "not measured" the live webapp gets.
  muf: 'environment/noaa/swpc/muf',
  advisory: null,
  status: null
}

/** The plugin routes, by the key their response is filed under in `routes`. */
export const ROUTE_OF: Record<string, string> = {
  advisory: 'advisory',
  status: 'status'
}

/** The document the page is read out of, saved or live. */
export interface SeamDocument {
  values: Record<string, Leaf>
  /** The same values as a nested tree, when the producer already keeps one. */
  tree?: Record<string, any>
  grids: Record<string, unknown>
  routes: Record<string, unknown>
}

/**
 * A dotted-path value map as the nested tree the REST API would serve. A path
 * can be both a leaf and a parent -- xray_flux carries a `trend` child --
 * which is why leaves merge into the node rather than replacing it, the same
 * shape `leafValue` already reads.
 */
export function treeFromValues(
  values: Record<string, Leaf> | undefined
): Record<string, any> {
  const root: Record<string, any> = {}
  for (const [dotted, leaf] of Object.entries(values || {})) {
    let node = root
    for (const key of dotted.split('.')) node = node[key] ?? (node[key] = {})
    Object.assign(node, leaf)
  }
  return root
}

/** The subtree at a slash path, or null -- a 404 from a server that isn't there. */
export function nodeAt(tree: any, slashPath: string): any {
  let node = tree
  for (const key of slashPath.split('/')) {
    node = node?.[key]
    if (node === undefined) return null
  }
  return node
}

export const leafValue = (node: any) =>
  node && typeof node === 'object'
    ? 'value' in node
      ? node.value
      : null
    : (node ?? null)

export const leafMeta = (node: any) =>
  node && typeof node === 'object' && node.meta && typeof node.meta === 'object'
    ? node.meta
    : null

export const leafTime = (node: any) => (node && node.timestamp) || null

/**
 * Seconds off a `Retry-After` header, or null. The page counts a cooldown down
 * from this, so a header that is not a positive number is no cooldown at all.
 */
export function retryAfterSeconds(header: unknown): number | null {
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null
}

/**
 * Exported for parity with `public/signalk.js`: the page catches it to tell
 * "you are not logged in" apart from "nothing published yet". Nothing behind
 * this seam ever throws it -- there is no server to be logged out of -- but
 * the page's `instanceof` checks need the class to exist.
 */
export class AuthRequiredError extends Error {}

export interface SeamOptions {
  /** The document as it stands now. Called per read; cheap by contract. */
  document: () => Promise<SeamDocument>
  /** What the map's "fetch now" buttons do. Rejects the way the page labels. */
  forceRefresh: (which: string) => Promise<unknown>
  /**
   * The reader's distance unit, when there is somewhere to read one from.
   * Null leaves the page on the nmi it already defaults to, which is the right
   * unit for boats.
   */
  distanceUnitPreference?: () => Promise<string | null>
}

/**
 * The seam's server-facing half, bound to one document source.
 *
 * Everything here answers null rather than throwing on a transport failure:
 * `getJson` in `public/signalk.js` does the same, and the page's own no-data
 * state is built on it. Rejecting instead would escape `refresh()` in
 * index.html as an unhandled rejection and leave the page frozen on whatever
 * it last drew.
 */
export function createDocumentSeam(options: SeamOptions) {
  const { document, forceRefresh } = options

  // Once per document, not per read: the page polls every path on a timer.
  // Keyed on the parsed object, so a re-fetched document gets its own tree.
  let built: { data: SeamDocument; tree: Record<string, any> } | null = null
  async function valueTree() {
    const data = await document()
    if (data.tree) return data.tree
    if (built?.data !== data)
      built = { data, tree: treeFromValues(data.values) }
    return built.tree
  }

  /** One path out of the document, in the shape the REST API answers with. */
  async function getJson(path: string | null | undefined) {
    if (!path) return null
    try {
      return nodeAt(await valueTree(), path)
    } catch {
      return null
    }
  }

  /** One route response out of the document, or null. */
  async function routeJson(route: string) {
    try {
      const { routes } = await document()
      return (routes && routes[route]) ?? null
    } catch {
      return null
    }
  }

  return {
    getJson,
    routeJson,

    // `read` defaults rather than being ignored, so the page's own
    // `readAll(getJson)` and a bare `readAll()` answer the same thing. It
    // reads vessel paths only: a plugin route is not a path, so `read` is not
    // given one to make a URL out of.
    async readAll(read: (path: string) => Promise<any> = getJson) {
      const ids = Object.keys(ENDPOINTS)
      const values = await Promise.all(
        ids.map((id) => {
          const path = ENDPOINTS[id]
          return path ? read(path) : routeJson(ROUTE_OF[id])
        })
      )
      return Object.fromEntries(ids.map((id, i) => [id, values[i]]))
    },

    /** The telemetry route's body -- this tab's own meter, where it is live. */
    async fetchTelemetry() {
      return routeJson('telemetry')
    },

    /** The grid this layer holds, in the shape the map's layer loader takes. */
    async fetchGridCache(which: string) {
      const { grids } = await document()
      const entry = grids && grids[which]
      if (!entry) {
        // The same shape the plugin's 404 produces, so the map draws its own
        // "nothing cached yet" wording rather than reporting an error.
        throw Object.assign(new Error('Nothing cached yet.'), {
          notCached: true
        })
      }
      return entry
    },

    forceRefresh,

    distanceUnitPreference: options.distanceUnitPreference ?? (async () => null)
  }
}
