/**
 * The one place that talks to the Signal K `app` object.
 *
 * Everything downstream takes a Publisher rather than closing over `app`,
 * which is what makes the product modules testable without a server.
 */
import { ValueUpdate } from './parse.js'

export interface Meta {
  path: string
  value: any
}

export interface Publisher {
  meta(metas: Meta[]): void
  values(values: ValueUpdate[], timestamp: string): void
  value(path: string, value: any, timestamp: string): void
  selfPath(path: string): any
  status(message: string): void
  fail(message: string): void
  error(message: string, ...args: any[]): void
  debug(message: string, ...args: any[]): void
}

export function createPublisher(app: any, pluginId: string): Publisher {
  return {
    meta(metas) {
      if (metas.length === 0) return
      app.handleMessage(pluginId, { updates: [{ meta: metas }] })
    },
    values(values, timestamp) {
      if (values.length === 0) return
      app.handleMessage(pluginId, { updates: [{ values, timestamp }] })
    },
    value(path, value, timestamp) {
      this.values([{ path, value }], timestamp)
    },
    selfPath: (path) => app.getSelfPath(path),
    status: (message) => app.setPluginStatus(message),
    fail: (message) => app.setPluginError(message),
    error: (message, ...args) => app.error(message, ...args),
    debug: (message, ...args) => app.debug(message, ...args)
  }
}
