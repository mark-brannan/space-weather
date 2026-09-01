/**
 * The Publisher the browser demo runs the products against (#239 leg 2).
 *
 * The server's Publisher writes deltas into a Signal K server and JSON files
 * into a data directory. This one writes both into memory, and hands the
 * result back in exactly the shape demo/snapshot.json already has -- so the
 * demo page's data layer reads a live plugin the same way it reads a saved
 * capture, and neither the page nor the products know which they are on.
 *
 * The products are unchanged and unaware: they take a Publisher, and since
 * #272 they take their storage through it too, which is the whole reason this
 * file can exist without a filesystem.
 */
import type { CacheStore } from '../cache/entryCache.js'
import type { Meta, Publisher } from '../publisher.js'
import type { ValueUpdate } from '../parse.js'

/** A vessel-tree leaf, in the shape the Signal K REST API serves one. */
export interface Leaf {
  value?: any
  timestamp?: string
  meta?: any
}

export interface BrowserPublisher extends Publisher {
  /**
   * Every published path, dotted, in the shape snapshot.json's `values` has.
   * Not called `values`: that name is already the Publisher method products
   * publish through.
   */
  readonly published: Record<string, Leaf>
  /**
   * The same publications as the nested tree the Signal K REST API serves, so
   * a reader walks it instead of rebuilding one from `published` on every
   * read. `selfPath` walks this too.
   */
  readonly tree: Record<string, any>
  /** The most recent status line a product set, for the page to show. */
  lastStatus(): { message: string; failed: boolean } | null
}

/**
 * Where the reader is, as the publisher asks for it rather than as it was at
 * construction.
 *
 * A stated viewpoint is a value and never changes; a device fix arrives after
 * the page does and then moves. Both are the same thing to a product -- one
 * `selfPath` read per refresh -- so this is a value *or* a function, and the
 * `undefined` a function may answer is not an error case: it is the same
 * "no fix yet" a server with no GPS gives, which is already the branch that
 * sends the grid products down `awaiting-position` to `publishFromCache`.
 */
export type PositionSource =
  | { latitude: number; longitude: number }
  | (() => { latitude: number; longitude: number } | undefined)

export interface BrowserPublisherOptions {
  /**
   * Where the vessel is. A browser has no Signal K server to ask, so the
   * caller supplies it: the demo states a position, the standalone app hands
   * over a function reading the device's own fix. Products read it through
   * `selfPath` exactly as they read a real one.
   */
  position: PositionSource
  /**
   * Where the cached grids and the advisory bulletin live.
   *
   * A `Map` by default, which is right for a page that is thrown away with
   * the tab. An installed app hands over a persistent one instead, so a cold
   * start paints from the last grid rather than re-buying it.
   */
  store?: CacheStore
  /**
   * Where the plugin's log lines go. Defaults to the console.
   *
   * The extra arguments are passed on rather than dropped: products log
   * through `app.debug`'s printf shape (`'Aurora %s%% at %s'`, value, value),
   * and a console line full of unfilled `%s` is worse than no line.
   */
  log?: (
    level: 'error' | 'debug' | 'status',
    message: string,
    ...args: any[]
  ) => void
}

/**
 * Walks a dotted path into the nested tree, creating nodes on the way. A path
 * can be both a leaf and a parent -- xray_flux carries a `trend` child -- so a
 * leaf merges into whatever node is already there rather than replacing it.
 */
function nodeFor(root: Record<string, any>, dotted: string) {
  let node = root
  for (const key of dotted.split('.')) node = node[key] ?? (node[key] = {})
  return node
}

export function createBrowserPublisher(
  options: BrowserPublisherOptions
): BrowserPublisher {
  // Normalised once, so `selfPath` has one shape to read and the value case
  // costs no more than it did when a value was all this took.
  const positionNow =
    typeof options.position === 'function'
      ? options.position
      : () => options.position as { latitude: number; longitude: number }
  const log =
    options.log ??
    ((level, message, ...args) => {
      if (level === 'error') console.error(message, ...args)
      else if (level === 'status') console.info(message, ...args)
      else console.debug(message, ...args)
    })

  // Two views of the same publications, both needed and neither derivable
  // cheaply from the other on every read: the flat map is what the demo's data
  // layer serves (it is snapshot.json's `values`), and the tree is what
  // `selfPath` walks -- products read their own last published value back
  // through it, and one of them (alerts) reads a whole subtree.
  const values: Record<string, Leaf> = {}
  const tree: Record<string, any> = {}
  const memory = new Map<string, string>()
  let lastStatus: { message: string; failed: boolean } | null = null

  const put = (dotted: string, leaf: Leaf) => {
    Object.assign(values[dotted] ?? (values[dotted] = {}), leaf)
    Object.assign(nodeFor(tree, dotted), leaf)
  }

  const publisher: BrowserPublisher = {
    published: values,
    tree,
    lastStatus: () => lastStatus,

    meta(metas: Meta[]) {
      for (const { path, value } of metas) put(path, { meta: value })
    },
    values(updates: ValueUpdate[], timestamp: string) {
      for (const { path, value } of updates) put(path, { value, timestamp })
    },
    value(path: string, value: any, timestamp: string) {
      publisher.values([{ path, value }], timestamp)
    },

    /**
     * The vessel position, and anything the products have already published.
     *
     * `undefined` for a path never seen is what the server's `getSelfPath`
     * answers, and products branch on exactly that: the advisory's
     * empty-value-path check tests for it, and D-RAP and GOES read back their
     * own last value to decide whether to republish. A demo that answered null
     * would take a different branch than a boat does.
     */
    selfPath(path: string) {
      if (path === 'navigation.position') {
        const position = positionNow()
        return position
          ? { value: position, timestamp: new Date().toISOString() }
          : undefined
      }
      if (path === 'navigation.position.value') return positionNow()
      let node: any = tree
      for (const key of path.split('.')) {
        node = node?.[key]
        if (node === undefined) return undefined
      }
      return node
    },

    status(message: string) {
      lastStatus = { message, failed: false }
      log('status', message)
    },
    fail(message: string) {
      lastStatus = { message, failed: true }
      log('error', message)
    },
    error(message: string, ...args: any[]) {
      log('error', message, ...args)
    },
    debug(message: string, ...args: any[]) {
      log('debug', message, ...args)
    },

    // The CacheStore half. The products cache the two global grids and the
    // advisory bulletin through it; a Map is the whole default, and the
    // write-then-rename the file store needs has no analogue here -- a
    // synchronous Map write is already indivisible to every reader. A caller
    // that wants the grids to outlive the tab supplies its own store instead,
    // which is the same parameter #272 made the products take.
    readCache(filename: string) {
      return options.store
        ? options.store.readCache(filename)
        : (memory.get(filename) ?? null)
    },
    writeCache(filename: string, text: string) {
      if (options.store) options.store.writeCache(filename, text)
      else memory.set(filename, text)
    }
  }
  return publisher
}
