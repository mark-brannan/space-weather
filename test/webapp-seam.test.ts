import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as signalk from '../public/signalk.js'

/**
 * `public/signalk.js` is the one module the webapp's page talks to the
 * server through, so the GitHub Pages demo (#199, #239) can substitute a
 * snapshot-backed copy of it and run the shipping page unchanged. That only
 * holds while nothing else calls the server behind its back: a single raw
 * `fetch` left in the page is enough to make the demo silently draw nothing.
 * The admin UI's config screen (`remoteEntry.js`, `config-panel.js`) is not
 * the page and is not copied into the demo; it still reads the server itself.
 */
const html = readFileSync(
  fileURLToPath(new URL('../public/index.html', import.meta.url)),
  'utf8'
)

// Every way a browser page can open a connection, not just `fetch` -- the
// Signal K delta stream is a WebSocket, so a streaming update is the most
// plausible next thing somebody adds here, and it would otherwise sail past
// a fetch-only guard. The lookbehind excludes word characters only -- which
// is what keeps `refetchLayer` out -- and deliberately not the dot, so
// `window.fetch(url)`, the same leak spelled differently, still trips it.
const TRANSPORTS = [
  /(?<!\w)fetch\s*\(/,
  /new\s+Request\s*\(/,
  /new\s+XMLHttpRequest\b/,
  /new\s+EventSource\s*\(/,
  /new\s+WebSocket\s*\(/,
  /sendBeacon\s*\(/
]

describe('the webapp page reaches the server only through signalk.js', () => {
  it.each(TRANSPORTS)('opens no connection of its own: %s', (pattern) => {
    expect(pattern.test(html)).toBe(false)
  })

  // Catches a comment quoting a server path as well as code holding one.
  // That is the intended reading, not a false positive: a URL written down
  // in this file is a URL the demo's substitute cannot answer.
  it('holds no server URL of its own', () => {
    expect(html).not.toContain('/signalk/')
  })

  it('exports everything the page reaches the server with', () => {
    for (const name of [
      'AuthRequiredError',
      'getJson',
      'fetchGridCache',
      'forceRefresh',
      'distanceUnitPreference',
      'ENDPOINTS',
      'readAll',
      'leafValue',
      'leafMeta',
      'leafTime'
    ]) {
      expect(signalk[name], name).toBeDefined()
    }
  })
})

/** Enough of a Response for the seam: it reads status, headers and json. */
const reply = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (name: string) => headers[name] ?? null },
  json: async () => {
    if (body === undefined) throw new Error('not json')
    return body
  }
})

// Captures the init too: dropping `cache: 'no-store'` or the `Accept`
// header would otherwise be a silent change with the suite still green.
const stub = (answer: (url: string) => unknown) => {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return answer(url)
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('the plugin routes are addressed by product, not by URL', () => {
  it('reads each grid back from its own product route', async () => {
    const calls = stub(() => reply(200, { fetchedAt: 'then', grid: {} }))
    await signalk.fetchGridCache('aurora')
    await signalk.fetchGridCache('drap')
    await signalk.forceRefresh('aurora')
    await signalk.forceRefresh('drap')
    expect(calls.map((c) => c.url)).toEqual([
      '/signalk/v1/api/signalk-noaa-space-weather/aurora-grid',
      '/signalk/v1/api/signalk-noaa-space-weather/drap-grid',
      '/signalk/v1/api/signalk-noaa-space-weather/aurora-refresh',
      '/signalk/v1/api/signalk-noaa-space-weather/drap-refresh'
    ])
    for (const call of calls) {
      expect(call.init).toEqual({ headers: { Accept: 'application/json' } })
    }
  })

  it('marks a grid the plugin has not cached yet', async () => {
    stub(() => reply(404, { error: 'Nothing cached yet.' }))
    await expect(signalk.fetchGridCache('drap')).rejects.toMatchObject({
      notCached: true
    })
  })

  it('tells a logged-out reader apart from an empty one', async () => {
    stub(() => reply(401, null))
    await expect(signalk.fetchGridCache('aurora')).rejects.toBeInstanceOf(
      signalk.AuthRequiredError
    )
    await expect(signalk.forceRefresh('aurora')).rejects.toBeInstanceOf(
      signalk.AuthRequiredError
    )
  })

  it('carries the cooldown a refusal asks the reader to wait out', async () => {
    stub(() => reply(429, { error: 'Too soon' }, { 'Retry-After': '42' }))
    await expect(signalk.forceRefresh('drap')).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 42
    })
  })

  it('reads an unauthorised vessel path as an auth failure, a 404 as null', async () => {
    const calls = stub((url) =>
      url.endsWith('kp') ? reply(404, null) : reply(403, null)
    )
    expect(await signalk.getJson('/signalk/v1/api/vessels/self/kp')).toBeNull()
    // A stale read is worse than none: the page polls the same paths every
    // minute and would otherwise redraw a cached storm as the current one.
    expect(calls[0].init).toEqual({ cache: 'no-store' })
    await expect(signalk.getJson('/other')).rejects.toBeInstanceOf(
      signalk.AuthRequiredError
    )
  })
})

describe('the distance unit preference', () => {
  const prefs = (distance: unknown) =>
    stub(() => reply(200, { categories: { distance } }))

  it('converts with the formula the server published', async () => {
    prefs({
      formula: 'value / 1852',
      symbol: 'nm',
      displayFormat: '0.00'
    })
    const format = await signalk.distanceUnitPreference()
    expect(format!(1852)).toBe('1000.00 nm')
  })

  it('refuses a formula that is not plain arithmetic on value', async () => {
    for (const formula of [
      'fetch("http://evil")',
      'globalThis.x = 1',
      'value(value)'
    ]) {
      prefs({ formula, symbol: 'nm', displayFormat: '0.0' })
      expect(await signalk.distanceUnitPreference()).toBeNull()
    }
  })

  it('has no preference to report when the server has no such API', async () => {
    stub(() => reply(404, null))
    expect(await signalk.distanceUnitPreference()).toBeNull()
  })

  it('has none when the preference carries no unit to label it with', async () => {
    prefs({ formula: 'value / 1000', displayFormat: '0.0' })
    expect(await signalk.distanceUnitPreference()).toBeNull()
  })
})
