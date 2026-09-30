// Captures one real NOAA snapshot into site/snapshot.json, for the browser
// site's ?snapshot layer: a saved moment, fast, free, and impossible to break
// from outside -- the way to show a stormy day in a quiet week. It is run by
// hand when the snapshot is worth refreshing, never by the page.
//
//   npm install && npm run build && npm run site:capture
//
// Same pattern as loadRealProducts in scripts/mock-webapp.mjs: the products
// are decoupled from Signal K behind the Publisher interface, so this runs
// the real ones out of this repo's own dist/ against a publisher that
// captures every published value into a map instead of a delta. The two grids
// come back through the same on-disk cache the plugin itself writes.
//
// The vessel is a chosen viewpoint, not a real boat: the capture runs at the
// core's DEMO_POSITION. Every value published at the vessel -- the aurora
// probability, the D-RAP absorption cutoff the HF band strip is drawn from --
// needs somewhere to be, and a page whose headline surface reads "awaiting
// position" forever is not a demo of the plugin. It buys no extra NOAA
// traffic: both grids are global and fetched before any position is looked
// at. The position lands in the snapshot as data, at `navigation.position`.
//
// Deliberately outside the test suite: it needs the live service, and the
// suite runs with no network.

import fssync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(REPO, 'site', 'snapshot.json')

// Driven off the core's PRODUCTS registry rather than a list kept here: a
// hand-maintained list is how the demo ended up with four values and a
// half-empty page (signalk-noaa-space-weather#239). A product added to the registry lands in the
// next capture with no edit to this file.
// DEMO_POSITION and DEMO_PROPS come from the core's browser/live, which is
// where the live demo reads them too: the two demos are the same page over
// two data layers, and a capture claiming a different viewpoint or different
// settings than the live one would make them disagree about their own numbers.
// This repo's own build, not an installed copy: run `npm run build` first, or
// the capture is of whatever dist/ last held.
import { PRODUCTS } from '../dist/products/registry.js'
import { settingsFrom } from '../dist/config.js'
import * as auroraCache from '../dist/cache/auroraCache.js'
import * as drapCache from '../dist/cache/drapCache.js'
import * as advisoryCache from '../dist/cache/advisoryCache.js'
import { createClient } from '../dist/noaa/client.js'
import { telemetryBody } from '../dist/telemetry.js'
import { DEMO_POSITION, DEMO_PROPS } from '../dist/browser/live.js'

// One clock for the whole capture: the vessel is at this position as of the
// same moment the snapshot claims to be from.
const capturedAt = new Date().toISOString()

// One node per dotted path, in the shape the REST API serves a leaf:
// `{value, timestamp, meta}`. Metadata merges onto the same node as the value
// rather than into a second top-level key, because that is where the webapp
// looks for it -- `leafMeta` in public/signalk.js reads `node.meta`, and the
// HF gauge draws its zone ladder out of it. A path can carry meta and no
// value (a subtree's description), which reads back as null the same way it
// does from a real server.
const values = {}
const cacheStore = new Map()
const nodeFor = (p) => values[p] ?? (values[p] = {})
// Counted, not just stored: a refresh that returns without publishing is not
// a success -- the plugin's own refresh route says so with a `fetchedAt` diff,
// and here it would write a snapshot with that product's tiles simply missing.
let published = 0
const publisher = {
  meta(metas) {
    for (const { path: p, value } of metas) nodeFor(p).meta = value
  },
  values(vals, timestamp) {
    for (const { path: p, value } of vals) {
      Object.assign(nodeFor(p), { value, timestamp })
      published++
    }
  },
  value(p, value, timestamp) {
    this.values([{ path: p, value }], timestamp)
  },
  // The vessel position, and nothing else. `undefined` is what getSelfPath
  // answers for a path it has never seen, and products branch on exactly
  // that: the advisory's empty-value-path check tests for it, and D-RAP's
  // republish check reads back its own last value, which on a first run there
  // has never been. Both shapes of the position lookup are answered because
  // `vesselPosition` tries both against a real server.
  selfPath(p) {
    if (p === 'navigation.position') {
      return { value: DEMO_POSITION, timestamp: capturedAt }
    }
    if (p === 'navigation.position.value') return DEMO_POSITION
    return undefined
  },
  status(message) {
    console.log(message)
  },
  fail(message) {
    console.error(message)
  },
  error(message, ...args) {
    console.error(message, ...args)
  },
  debug() {},
  // A Publisher is also the CacheStore its products persist through. A Map,
  // not a directory: this process writes the three cached payloads and reads
  // them back below, and nothing outside it ever wants them.
  readCache: (filename) => cacheStore.get(filename) ?? null,
  writeCache: (filename, text) => cacheStore.set(filename, text)
}

// The demo shows every surface the webapp can draw, which means the two grids
// and the GOES flux tiles -- all three default off on bandwidth grounds. So
// the capture runs as a configured install rather than a default one, and the
// same settings go into `routes.status` below: the page reads `status.settings`
// to label the refresh buttons and to decide whether a product is scheduled,
// so a snapshot carrying aurora data while claiming `auroraEnabled: false`
// would have the demo state the opposite of how it is running.
//
// Still through `settingsFrom`, not an object assembled here, so every other
// value is the one a fresh install gets and cannot drift from it.
const settings = settingsFrom(DEMO_PROPS)

const client = createClient(publisher)
const ctx = {
  client,
  publisher,
  settings,
  stopped: () => false
}

// In the snapshot the same way it would be on a boat, so the map can draw the
// vessel and the aurora tile can say where the reading is from.
publisher.value('navigation.position', DEMO_POSITION, capturedAt)

// Nothing NOAA had in force is a real state of the world, and the alerts
// payload is the one that can legitimately be empty of it: no message in force
// means no notification to publish, and a quiet week is still a good snapshot.
// Every other product publishing nothing is a bug.
const MAY_PUBLISH_NOTHING = new Set(['Alerts, Watches, and Warnings'])

// A snapshot with a hole in it is not a snapshot: a product that throws, or
// that returns without publishing anything, fails the run, and the committed
// file keeps its previous complete capture.
//
// `enabled` is consulted the way the plugin's index.ts consults it, so metadata lands
// for exactly the products a server running DEMO_PROPS would publish it for.
// A product switched off under those settings is a hole in the demo rather
// than a saving, so it stops the run instead: the fix is to turn it on above.
for (const product of PRODUCTS) {
  if (product.enabled && !product.enabled(settings)) {
    console.error(
      `${product.name} is off under the demo settings -- add its key to ` +
        'DEMO_PROPS, or the demo publishes a page with its tiles blank'
    )
    process.exit(1)
  }
  console.log(`fetching ${product.name}...`)
  if (product.metadata) publisher.meta(product.metadata(settings))
  const before = published
  let result
  try {
    result = await product.refresh(ctx)
  } catch (err) {
    console.error(`${product.name} failed: ${err}`)
    process.exit(1)
  }
  // 'awaiting-position' is the one honest way to publish nothing -- the fetch
  // happened and is cached, there was just nowhere to index it. It cannot
  // happen here (the capture supplies a position), so it reads as a bug in
  // this script rather than in the product.
  if (result === 'awaiting-position') {
    console.error(`${product.name} found no vessel position to publish at`)
    process.exit(1)
  }
  if (published === before && !MAY_PUBLISH_NOTHING.has(product.name)) {
    console.error(`${product.name} refreshed without publishing anything`)
    process.exit(1)
  }
}

const grids = {
  aurora: auroraCache.readAuroraCache(publisher),
  drap: drapCache.readDrapCache(publisher)
}
for (const [name, entry] of Object.entries(grids)) {
  if (!entry?.grid) {
    console.error(`${name} refresh left nothing in the cache`)
    process.exit(1)
  }
}

// What the plugin's own HTTP routes serve, keyed by the same ids
// public/signalk.js uses for them. The published advisory paths carry the
// notification and a summary; the page's outlook overlay wants the bulletin
// itself, which only this route has ever served. Same shape as `grids`: the
// route body verbatim, so a demo answering it needs no translation.
//
// `status` is the same body /status answers on a running plugin, carrying the
// settings this capture actually ran with. Without it the page reads
// `status?.settings?.drapEnabled` as undefined and tells the visitor automatic
// updates are off -- a claim about how the plugin ships that is not true of
// this capture or of a default install. `startedAt` is the capture instant,
// which is what the demo's clock makes "just now".
//
// `telemetry` is this capture's own meter: the real wire size of every fetch
// it just made, against the declarations. Its 24-hour window is minutes old,
// which is the honest thing for a snapshot to say -- the diagnostics panel
// draws that as "collecting", compares the per-fetch sizes it can already
// judge, and withholds the day's verdict it cannot.
const routes = {
  advisory: advisoryCache.readAdvisoryCache(publisher),
  status: { startedAt: capturedAt, settings },
  telemetry: telemetryBody(capturedAt, settings, client.meter)
}
if (!routes.advisory) {
  console.error('the advisory refresh left nothing in the cache')
  process.exit(1)
}

const snapshot = { capturedAt, values, grids, routes }

// Publishing NaN is the one thing this plugin must never do, and
// JSON.stringify turns it into `null` on the way out -- so a parser bug would
// land in the committed snapshot as a plausible-looking absence. Caught here,
// while the numbers are still numbers, and over the whole snapshot rather than
// over the published values alone: the grids are ~200,000 of the numbers on
// this page and are what mapRaster.js samples for every pixel it draws.
function nonFinitePaths(node, at, found) {
  if (typeof node === 'number') {
    if (!Number.isFinite(node)) found.push(at)
  } else if (node && typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) {
      nonFinitePaths(child, at ? `${at}.${key}` : key, found)
      // One bad grid is millions of entries; the first few name the place.
      if (found.length >= 5) return found
    }
  }
  return found
}
const bad = nonFinitePaths(snapshot, '', [])
if (bad.length) {
  console.error(`non-finite number in the snapshot at: ${bad.join(', ')}`)
  process.exit(1)
}

await fs.mkdir(path.dirname(OUT), { recursive: true })
const tempOut = `${OUT}.${process.pid}.tmp`
await fs.writeFile(tempOut, JSON.stringify(snapshot))
await fs.rename(tempOut, OUT)
const kb = Math.round((await fs.stat(OUT)).size / 1024)
console.log(
  `wrote ${path.relative(REPO, OUT)} (${kb} KB, ${Object.keys(values).length} paths,` +
    ` captured ${snapshot.capturedAt})`
)
