/** The only outbound I/O in the plugin. */
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
    // Every product endpoint here confirmed to send ETag and/or
    // Last-Modified with a 60s Cache-Control; sending both conditional
    // headers when known costs nothing and is the more compatible form.
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

  return {
    json: (subPath, productName) => get(subPath, productName, (r) => r.json()),
    text: (subPath, productName) => get(subPath, productName, (r) => r.text())
  }
}
