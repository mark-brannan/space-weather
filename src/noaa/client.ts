/** The only outbound I/O in the plugin. */
import { Publisher } from '../publisher.js'

export const API = 'https://services.swpc.noaa.gov'
const USER_AGENT = 'signalk-noaa-space-weather'
const TIMEOUT_MS = 30000

export interface Client {
  json(subPath: string, productName: string): Promise<any>
  text(subPath: string, productName: string): Promise<string>
}

export function createClient(publisher: Publisher): Client {
  async function get(
    subPath: string,
    productName: string,
    read: (response: Response) => Promise<any>
  ): Promise<any> {
    const url = API + subPath
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!response.ok) {
      const status = `NOAA Space Weather '${productName}' not found at ${url}`
      publisher.fail(status)
      throw new Error(status)
    }
    const data = await read(response)
    publisher.status(
      `NOAA Space Weather ${productName} retrieved: ${new Date()}`
    )
    return data
  }

  return {
    json: (subPath, productName) =>
      get(subPath, productName, (r) => r.json()),
    text: (subPath, productName) => get(subPath, productName, (r) => r.text())
  }
}
