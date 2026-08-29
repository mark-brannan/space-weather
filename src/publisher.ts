/**
 * The one place that talks to the Signal K `app` object.
 *
 * Everything downstream takes a Publisher rather than closing over `app`,
 * which is what makes the product modules testable without a server.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CacheStore } from './cache/entryCache.js'
import { ValueUpdate } from './parse.js'

export interface Meta {
  path: string
  value: any
}

/**
 * A Publisher is also where the plugin's own persistence comes from. The cache
 * modules take a `CacheStore` rather than a directory path, so the filesystem
 * stays behind this one module -- the same rule as the Signal K `app` object
 * above, and what lets the product modules run in a browser (#239).
 */
export interface Publisher extends CacheStore {
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
    debug: (message, ...args) => app.debug(message, ...args),
    ...createFileStore(() => app.getDataDirPath())
  }
}

/**
 * The server's CacheStore: one JSON file per name in the plugin's own data
 * directory.
 *
 * `getDataDirPath()` is read per call, not once: the server's own docs say it
 * is only callable from start() onward, never from the plugin constructor, and
 * `createPublisher` runs in the constructor. Every read and write here happens
 * inside a product's refresh() or a router handler, both of which only ever
 * run after start(), so that constraint holds by construction.
 *
 * Exported so a test can build the real store over a temp directory and pin
 * the write-then-rename behaviour below, which a stub would not exercise.
 */
export function createFileStore(dataDirPath: () => string): CacheStore {
  return {
    /**
     * Write-then-rename rather than a direct write, so a reader (an HTTP
     * route, on a different tick) never sees a half-written file.
     * Same-directory rename is atomic on the filesystems Signal K actually
     * runs on.
     */
    writeCache(filename, text) {
      const finalPath = join(dataDirPath(), filename)
      const tmpPath = finalPath + '.tmp'
      writeFileSync(tmpPath, text)
      renameSync(tmpPath, finalPath)
    },
    readCache(filename) {
      const path = join(dataDirPath(), filename)
      return existsSync(path) ? readFileSync(path, 'utf8') : null
    }
  }
}
