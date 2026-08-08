import { Settings } from '../config.js'
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
   * How often to poll, in minutes. A function of settings rather than a fixed
   * enum of schedules, because a product with an unusual payload can justify
   * its own cadence — the aurora grid is ~900 KB and gets a slower one.
   */
  intervalMinutes: (settings: Settings) => number
  /** Products the user can switch off. Defaults to always on. */
  enabled?: (settings: Settings) => boolean
  /** Static metadata, published once per start. */
  metadata?: (settings: Settings) => Meta[]
  /**
   * Returning 'not-ready' means a precondition is missing rather than the
   * fetch having failed — the vessel has no position fix yet, say. The caller
   * retries shortly instead of waiting out a whole interval, which on an
   * hourly product would mean an hour of silence after boot.
   *
   * Returning `{ nextDelayMinutes }` overrides `intervalMinutes` for the next
   * scheduled run only — for a product whose natural cadence varies over
   * time (the advisory outlook polling tighter near its expected weekly
   * issuance). Most products never return this and just get `intervalMinutes`
   * on every tick, unchanged from before.
   */
  refresh: (
    ctx: ProductContext
  ) => Promise<void | 'not-ready' | { nextDelayMinutes: number }>
}
