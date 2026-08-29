/**
 * The plugin, running in a browser tab against NOAA directly (#239 leg 2).
 *
 * The demo page has always been the shipping page (never a fork), reading
 * through one seam -- public/signalk.js. This is the third thing that can sit
 * behind that seam: not a Signal K server, and not a saved capture either, but
 * the plugin's own product modules doing their own fetching, here, now.
 *
 * Nothing in src/products/ was written for this and nothing in it changed to
 * allow it. A product takes a client, a publisher and settings; the server
 * supplies one of each and so does this. What made it possible was moving the
 * last two host resources behind those parameters -- the network into
 * noaa/client.ts (long since) and storage into the Publisher (#272).
 *
 * What this module owns is only the part index.ts owns on a server: build the
 * context, publish metadata once, run the first pass, and keep each product on
 * its own interval.
 */
import { readAdvisoryCache } from '../cache/advisoryCache.js'
import { readAuroraCache } from '../cache/auroraCache.js'
import { readDrapCache } from '../cache/drapCache.js'
import { Settings, settingsFrom } from '../config.js'
import { TIMEOUT_MS, createClient } from '../noaa/client.js'
import { aurora } from '../products/aurora.js'
import { drap } from '../products/drap.js'
import { PRODUCTS } from '../products/registry.js'
import { FORCE_REFRESH_COOLDOWN_MS } from '../refreshPolicy.js'
import type { Product, ProductContext } from '../products/types.js'
import { BrowserPublisher, Leaf, createBrowserPublisher } from './publisher.js'

/**
 * Where the demo says it is: real cruising water, and far enough north that
 * both the aurora oval and D-RAP's polar absorption are legible rather than
 * flat zero most of the year. A stated viewpoint, not a boat.
 *
 * One definition for both demos -- scripts/capture-demo-snapshot.mjs imports
 * this too. The live page and the saved capture claiming different positions
 * would make the two modes disagree about where their own numbers are from.
 */
export const DEMO_POSITION = { latitude: 60.4, longitude: 5.3 }

/**
 * How the demo runs the plugin: the two grids and the GOES flux tiles on, all
 * of which default off on bandwidth grounds. The demo exists to show every
 * surface the webapp can draw, and the page reads these back out of `/status`
 * to describe how the plugin is running -- so they are the settings, not a
 * description of them. Everything else is what a fresh install gets, because
 * `settingsFrom` fills the rest in.
 */
export const DEMO_PROPS = {
  auroraEnabled: true,
  drapEnabled: true,
  goesFluxEnabled: true
}

/** The same document demo/snapshot.json holds, assembled live instead of saved. */
export interface LiveDocument {
  values: Record<string, Leaf>
  /** The same values as a nested tree -- what the page's path reads walk. */
  tree: Record<string, any>
  grids: { aurora: unknown; drap: unknown }
  routes: {
    advisory: unknown
    status: { startedAt: string; settings: Settings }
  }
}

export interface LivePlugin {
  /** Everything published so far, in snapshot.json's shape. Cheap; call per read. */
  document(): LiveDocument
  /** Fetch one grid now, off its schedule -- what the webapp's refresh buttons do. */
  refresh(which: GridName): Promise<void>
  /**
   * Resolves when the first pass over every product has finished or failed, or
   * when one NOAA request's worth of time has passed -- whichever comes first.
   *
   * The demo page paints on this. Waiting for the pass is what stops a reader
   * seeing "no data" over data that has already arrived: the page polls every
   * 60 seconds, so a first read taken a moment too early costs a minute of
   * saying nothing was received. The bound is what stops that becoming an
   * unbounded blank page when NOAA is the thing that is not answering -- there
   * is nothing to paint then anyway, and the next poll picks up whatever did
   * land.
   */
  ready: Promise<void>
  stop(): void
  readonly publisher: BrowserPublisher
}

export interface LiveOptions {
  position?: { latitude: number; longitude: number }
  props?: Record<string, unknown>
  log?: (
    level: 'error' | 'debug' | 'status',
    message: string,
    ...args: any[]
  ) => void
}

/**
 * The two products the webapp has a "fetch now" button for, each with the read
 * that says whether a fetch actually landed anything.
 */
const GRID_PRODUCT = {
  aurora: { product: aurora, read: readAuroraCache },
  drap: { product: drap, read: readDrapCache }
}
export type GridName = keyof typeof GRID_PRODUCT

const MINUTE_MS = 60_000

/**
 * A refusal in the shape `refreshFailure` in public/aurora.js sorts on: the
 * page tells a cooldown, an upstream failure and an auth failure apart by
 * `status`, and counts a cooldown down from `retryAfterSeconds`. Built here so
 * the live demo's button fails the same way the server's route makes it fail,
 * rather than in some fourth way the page has no label for.
 */
function refusal(message: string, status: number, retryAfterSeconds?: number) {
  return Object.assign(new Error(message), { status, retryAfterSeconds })
}

export function startLivePlugin(options: LiveOptions = {}): LivePlugin {
  const settings = settingsFrom(options.props ?? DEMO_PROPS)
  // Published as data as well as answered through `selfPath`: the map draws
  // the vessel from `navigation.position`, and the aurora tile says which
  // position its reading is for. The saved capture carries it the same way.
  const position = options.position ?? DEMO_POSITION
  const publisher = createBrowserPublisher({ position, log: options.log })
  let stopped = false
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const inFlight = new Map<string, Promise<number | null>>()
  /** When each product last *started* a fetch, for the manual-refresh cooldown. */
  const lastFetchAt = new Map<string, number>()
  const startedAt = new Date().toISOString()

  // No conditional-GET headers and no User-Agent: a browser cannot send either
  // to NOAA, for two separate measured reasons in docs/noaa-products.md. The
  // rest of the fetch path -- the endpoint guard, the torn-payload recovery,
  // the meter, the failure logging -- is the plugin's own, unchanged.
  const client = createClient(publisher, {
    conditionalGet: false,
    userAgent: null
  })

  const ctx: ProductContext = {
    client,
    publisher,
    settings,
    stopped: () => stopped
  }

  const enabled = (product: Product) =>
    !product.enabled || product.enabled(settings)

  /**
   * One product's turn. A failure is logged by the client and then dropped:
   * on a page with twelve of these, one endpoint being down must cost that
   * one tile, not the run.
   */
  async function runOnce(product: Product): Promise<number | null> {
    if (stopped) return null
    // One refresh per product at a time, so a second caller joins the one
    // already running rather than buying the same payload twice -- the rule
    // `refreshOnce` carries on the server, for the same reason: a button a
    // reader can press must not multiply NOAA traffic.
    const running = inFlight.get(product.name)
    if (running) return running
    const attempt = attemptOnce(product).finally(() =>
      inFlight.delete(product.name)
    )
    inFlight.set(product.name, attempt)
    return attempt
  }

  async function attemptOnce(product: Product): Promise<number | null> {
    lastFetchAt.set(product.name, Date.now())
    try {
      const result = await product.refresh(ctx)
      // A grid with nowhere to index it yet. It cannot happen here -- the demo
      // always states a position -- but publishing from the cache is what the
      // server does, and it costs no NOAA traffic to do the same.
      if (result === 'awaiting-position') {
        product.publishFromCache?.(ctx)
        return null
      }
      if (result && typeof result === 'object') return result.nextDelayMinutes
    } catch {
      // Already reported through publisher.fail/error by the client.
    }
    return null
  }

  function schedule(product: Product, delayMinutes: number) {
    if (stopped) return
    clearTimeout(timers.get(product.name))
    const timer = setTimeout(
      async () => {
        const next = await runOnce(product)
        schedule(product, next ?? product.intervalMinutes(settings))
      },
      Math.max(1, delayMinutes) * MINUTE_MS
    )
    timers.set(product.name, timer)
  }

  // Sequential, not Promise.all: twelve concurrent fetches with a ~900 KB grid
  // among them is a worse first paint than letting the small products land
  // first, and it is gentler on a service this page does not pay for.
  publisher.value('navigation.position', position, startedAt)

  const firstPass = (async () => {
    for (const product of PRODUCTS) {
      if (stopped) return
      if (!enabled(product)) continue
      if (product.metadata) publisher.meta(product.metadata(settings))
      const next = await runOnce(product)
      schedule(product, next ?? product.intervalMinutes(settings))
    }
  })()

  const ready = Promise.race([
    firstPass,
    new Promise<void>((resolve) => setTimeout(resolve, TIMEOUT_MS))
  ])

  return {
    publisher,
    ready,
    document: () => ({
      values: publisher.published,
      tree: publisher.tree,
      grids: {
        aurora: readAuroraCache(publisher),
        drap: readDrapCache(publisher)
      },
      routes: {
        advisory: readAdvisoryCache(publisher),
        status: { startedAt, settings }
      }
    }),
    /**
     * A press is not the plugin's own initiative, so it fetches whether or not
     * the product is scheduled -- and then defers the next scheduled run by a
     * full interval, because the grid it would have bought is the one just
     * bought. The same two rules the server's refresh routes follow.
     */
    async refresh(which: GridName) {
      const { product, read } = GRID_PRODUCT[which]
      // A fetch already in flight is not traffic this press would add -- it
      // joins that one below. Only one this press would *start* is the
      // cooldown's business, and it is measured from the last fetch rather
      // than the last press, so a scheduled fetch holds it down too.
      if (!inFlight.has(product.name)) {
        const sinceLast = Date.now() - (lastFetchAt.get(product.name) ?? 0)
        if (sinceLast < FORCE_REFRESH_COOLDOWN_MS) {
          const retryAfterSeconds = Math.ceil(
            (FORCE_REFRESH_COOLDOWN_MS - sinceLast) / 1000
          )
          throw refusal(
            `Refreshed too recently; try again in ${retryAfterSeconds}s.`,
            429,
            retryAfterSeconds
          )
        }
      }
      const before = read(publisher)
      const next = await runOnce(product)
      schedule(product, next ?? product.intervalMinutes(settings))
      // A refresh that returned without writing anything is not a success:
      // reporting one would leave the button saying it worked over a reading
      // that has not moved. The same `fetchedAt` diff the server's route makes.
      const after = read(publisher)
      if (!after || after.fetchedAt === before?.fetchedAt) {
        throw refusal(
          `Refreshed, but no new ${product.name} data came back from NOAA.`,
          502
        )
      }
    },
    stop() {
      stopped = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }
}
