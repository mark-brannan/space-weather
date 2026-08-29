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

export interface BrowserPublisherOptions {
  /**
   * Where the vessel is. A browser has no GPS and no Signal K server to ask,
   * so the demo states a position rather than implying one -- the same
   * viewpoint the saved capture uses. Products read it through `selfPath`
   * exactly as they read a real fix.
   */
  position: { latitude: number; longitude: number }
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
  const { position } = options
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
  const store = new Map<string, string>()
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
        return { value: position, timestamp: new Date().toISOString() }
      }
      if (path === 'navigation.position.value') return position
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
    // advisory bulletin through it; a Map is the whole implementation, and the
    // write-then-rename the file store needs has no analogue here -- a
    // synchronous Map write is already indivisible to every reader.
    readCache(filename: string) {
      return store.get(filename) ?? null
    },
    writeCache(filename: string, text: string) {
      store.set(filename, text)
    }
  }
  return publisher
}
