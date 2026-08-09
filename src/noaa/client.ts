/** The only outbound I/O in the plugin. */
import { firstJsonValue } from '../parse.js'
import { Publisher } from '../publisher.js'

export const API = 'https://services.swpc.noaa.gov'
const USER_AGENT = 'signalk-noaa-space-weather'
const TIMEOUT_MS = 30000

export interface Client {
  json(subPath: string, productName: string): Promise<any>
  text(subPath: string, productName: string): Promise<string>
}

interface CacheEntry {
  etag: string | null
  lastModified: string | null
  value: any
}

export function createClient(publisher: Publisher): Client {
  // Keyed by subPath, not the full URL: every product hits a fixed, distinct
  // path, so this is small and never needs eviction. Lives in this closure
  // rather than module scope so it doesn't leak across plugin instances in a
  // test process, and survives a stop()/start() cycle within one running
  // server the same way NOAA's own cache would want it to.
  const cache = new Map<string, CacheEntry>()

  async function get(
    subPath: string,
    productName: string,
    read: (response: Response) => Promise<any>
  ): Promise<any> {
    const url = API + subPath
    const cached = cache.get(subPath)
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT }
    // Sending both conditional headers costs nothing, and is kept even though
    // no endpoint has ever been observed returning a 304 at a realistic poll
    // interval -- NOAA's ETag carries the file mtime and the files are
    // rewritten whether or not the content changed. Measurements, and the
    // reason this is not a bug, are in docs/noaa-products.md.
    if (cached?.etag) headers['If-None-Match'] = cached.etag
    if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })

    if (response.status === 304 && cached) {
      publisher.debug(`NOAA Space Weather ${productName} unchanged (304)`)
      publisher.status(
        `NOAA Space Weather ${productName} unchanged: ${new Date()}`
      )
      return cached.value
    }

    if (!response.ok) {
      const status = `NOAA Space Weather '${productName}' not found at ${url}`
      publisher.fail(status)
      throw new Error(status)
    }

    const data = await read(response)
    const etag = response.headers.get('etag')
    const lastModified = response.headers.get('last-modified')
    if (etag || lastModified) {
      cache.set(subPath, { etag, lastModified, value: data })
    } else {
      cache.delete(subPath)
    }
    publisher.status(
      `NOAA Space Weather ${productName} retrieved: ${new Date()}`
    )
    return data
  }

  /**
   * `response.json()`, except that a body which is a complete JSON value
   * followed by trailing bytes yields that value instead of throwing.
   *
   * NOAA rewrites these files in place and a read can land mid-write, arriving
   * as the new content plus the tail of the old, longer content -- measured in
   * docs/noaa-products.md. Strict parsing runs first, so a well-formed payload
   * takes the fast path and nothing about normal operation changes.
   */
  async function readJson(
    response: Response,
    productName: string
  ): Promise<any> {
    const body = await response.text()
    try {
      return JSON.parse(body)
    } catch (err) {
      const leading = firstJsonValue(body)
      if (leading === null) throw err
      const parsed = JSON.parse(leading)
      publisher.error(
        `NOAA Space Weather '${productName}' arrived with ` +
          `${body.length - leading.length} trailing byte(s) after a complete ` +
          `JSON value; used the value and ignored the rest`
      )
      return parsed
    }
  }

  return {
    json: (subPath, productName) =>
      get(subPath, productName, (r) => readJson(r, productName)),
    text: (subPath, productName) => get(subPath, productName, (r) => r.text())
  }
}
