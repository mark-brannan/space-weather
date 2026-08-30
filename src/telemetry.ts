/**
 * The body of the `/telemetry` route: what the plugin has fetched, and what
 * its own declarations said it would. Surface 1 of
 * docs/instrumentation-design.md's "Four surfaces, one source", and the one
 * the other surfaces are views of.
 *
 * Its own module rather than a closure in index.ts because three callers want
 * the same body and only one of them has a server: the plugin's route,
 * `src/browser/live.ts` (the demo running the plugin in a tab, which has a
 * meter of its own), and `scripts/capture-demo-snapshot.mjs`. A second copy in
 * the browser would be a second answer to "what does this cost", which is the
 * class of bug this whole design exists to stop.
 *
 * Pure: no `app`, no network, no filesystem, and the clock is a parameter --
 * so it stays inside the browser closure `test/browser-closure.test.ts` walks.
 */
import type { Settings } from './config.js'
import { ENDPOINTS, fetchesPerDay, predictedBytesPerDay } from './endpoints.js'
import { Meter, meterSnapshot } from './meter.js'
import { PRODUCTS } from './products/registry.js'

/**
 * The predicted half of the cross-check, per endpoint and in total: what the
 * declarations in `src/endpoints.ts` say a day at these settings should cost.
 * The measured half sits beside it in the body below, keyed by the same
 * `subPath`, so comparing the two is a join rather than a translation.
 *
 * Nothing new is derived here. `fetchesPerDay` and `predictedBytesPerDay` are
 * phase 2's own functions, unchanged -- the same two the configuration form
 * prices its settings out of, so the number this route publishes and the
 * number the form promised cannot drift apart. `total` comes from
 * `predictedBytesPerDay` rather than from summing the rows, for the same
 * reason.
 *
 * `productName` is looked up from `PRODUCTS` rather than declared on the
 * endpoint: counters are keyed per endpoint on purpose -- a product-keyed one
 * would have hidden #223 entirely, since "GOES flux" is one product and three
 * fetches -- and the product is a display column over that key, not part of
 * it.
 */
export function predictedTable(settings: Settings) {
  const productOf = new Map<string, string>()
  for (const product of PRODUCTS) {
    for (const endpoint of product.endpoints) {
      if (!productOf.has(endpoint.subPath)) {
        productOf.set(endpoint.subPath, product.name)
      }
    }
  }
  return {
    total: predictedBytesPerDay(settings).total,
    endpoints: ENDPOINTS.map((endpoint) => {
      const fetches = fetchesPerDay(endpoint, settings)
      return {
        subPath: endpoint.subPath,
        productName: productOf.get(endpoint.subPath) ?? null,
        /** The declared wire size one fetch should cost. */
        wireBytes: endpoint.wireBytes,
        /** When that was last measured -- which is how a declaration goes stale. */
        measuredOn: endpoint.measuredOn,
        fetchesPerDay: fetches,
        bytesPerDay: fetches * endpoint.wireBytes
      }
    })
  }
}

/**
 * `schema` is versioned so a scraper can tell one shape from the next. 1 was
 * phase 1's ring and buckets; 2 adds `predicted`. The totals-since-install
 * tier is phase 4.
 */
export const TELEMETRY_SCHEMA = 2

/**
 * The whole body. Deliberately no comparison of the two halves: what counts as
 * a divergence worth saying out loud is a presentation decision, it lives with
 * the surface that presents it (`public/diagnostics.js`), and a scraper
 * reading these numbers is free to draw its own line.
 */
export function telemetryBody(
  startedAt: string,
  settings: Settings,
  meter: Meter
) {
  return {
    schema: TELEMETRY_SCHEMA,
    startedAt,
    settings,
    predicted: predictedTable(settings),
    ...meterSnapshot(meter)
  }
}
