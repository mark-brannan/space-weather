import { Settings } from '../config.js'
import { Endpoint } from '../endpoints.js'
import { Client } from '../noaa/client.js'
import { Meta, Publisher } from '../publisher.js'

export interface ProductContext {
  client: Client
  publisher: Publisher
  settings: Settings
  /** True once stop() has run; products check it before publishing. */
  stopped: () => boolean
}

/**
 * One NOAA product. Adding a data source means adding one of these and one
 * entry to the array in index.ts — nothing else.
 */
export interface Product {
  name: string
  /**
   * Every endpoint this product fetches, from the table in src/endpoints.ts.
   * Declaring them is what makes the cost of a setting arithmetic rather than
   * a sentence: the config form prices the user's settings out of these, and a
   * fetch of anything not declared here is refused by the client.
   */
  endpoints: Endpoint[]
  /**
   * How often to poll, in minutes. A function of settings rather than a fixed
   * enum of schedules, because a product with an unusual payload can justify
   * its own cadence — the aurora grid is much the largest and gets a slower one.
   */
  intervalMinutes: (settings: Settings) => number
  /** Products the user can switch off. Defaults to always on. */
  enabled?: (settings: Settings) => boolean
  /** Static metadata, published once per start. */
  metadata?: (settings: Settings) => Meta[]
  /**
   * Returning 'awaiting-position' means the fetch happened and is cached, but
   * the vessel has no position to index it at yet. The caller retries shortly
   * instead of waiting out a whole interval — which on an hourly product would
   * mean an hour of silence after boot — and retries through
   * `publishFromCache` rather than through here, so the wait for a GPS fix
   * cannot turn into repeat NOAA traffic.
   *
   * Returning `{ nextDelayMinutes }` overrides `intervalMinutes` for the next
   * scheduled run only — for a product whose natural cadence varies over
   * time (the advisory outlook polling tighter near its expected weekly
   * issuance). Most products never return this and just get `intervalMinutes`
   * on every tick, unchanged from before.
   */
  refresh: (
    ctx: ProductContext
  ) => Promise<void | 'awaiting-position' | { nextDelayMinutes: number }>
  /**
   * Publish whatever the cached payload yields at the vessel's position, with
   * no network I/O at all. Only a product that caches a *global* payload has
   * one: the fetch is worth making before there is anywhere to index it, and
   * this is what turns the capture into a value once there is.
   *
   * Returns false only while a position is still missing -- the one state a
   * retry can fix. Anything else (no cache, an unparseable one, a position
   * that falls outside the grid) is true: it is over, and asking again in five
   * seconds would not change it.
   */
  publishFromCache?: (ctx: ProductContext) => boolean
}
