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
  /** Which interval this product is polled on. */
  schedule: 'observations' | 'notifications'
  /** Products the user can switch off. Defaults to always on. */
  enabled?: (settings: Settings) => boolean
  /** Static metadata, published once per start. */
  metadata?: (settings: Settings) => Meta[]
  refresh: (ctx: ProductContext) => Promise<void>
}
