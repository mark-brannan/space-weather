import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '../src/noaa/client'

/**
 * A minimal Publisher recording what the client told it, and a controllable
 * fetch mock that lets each test script exactly the response sequence NOAA
 * would send for a real conditional GET: 200 with ETag, then 304 once that
 * ETag is echoed back.
 */
function harness() {
  const debugLines: string[] = []
  const statusLines: string[] = []
  const publisher = {
    meta: () => {},
    values: () => {},
    value: () => {},
    selfPath: () => undefined,
    status: (m: string) => statusLines.push(m),
    fail: () => {},
    error: () => {},
    debug: (m: string) => debugLines.push(m)
  }
  return { publisher, debugLines, statusLines }
}

function jsonResponse(body: any, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createClient conditional GET', () => {
  it('sends no conditional headers on the first request', async () => {
    let seenHeaders: Headers | undefined
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seenHeaders = new Headers(init.headers)
      return jsonResponse({ a: 1 }, { etag: '"abc"' })
    })
    const { publisher } = harness()
    const client = createClient(publisher as any)

    await client.json('/products/noaa-scales.json', 'Scales')

    expect(seenHeaders?.has('if-none-match')).toBe(false)
    expect(seenHeaders?.has('if-modified-since')).toBe(false)
  })

  it('echoes back the ETag on the next request for the same path', async () => {
    let requestCount = 0
    let secondRequestHeaders: Headers | undefined
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      requestCount++
      if (requestCount === 1) return jsonResponse({ a: 1 }, { etag: '"abc"' })
      secondRequestHeaders = new Headers(init.headers)
      return new Response(null, { status: 304 })
    })
    const { publisher } = harness()
    const client = createClient(publisher as any)

    await client.json('/products/noaa-scales.json', 'Scales')
    await client.json('/products/noaa-scales.json', 'Scales')

    expect(secondRequestHeaders?.get('if-none-match')).toBe('"abc"')
  })

  it('returns the cached value on a 304 rather than an empty body', async () => {
    let requestCount = 0
    vi.stubGlobal('fetch', async () => {
      requestCount++
      return requestCount === 1
        ? jsonResponse({ scales: 'unchanged' }, { etag: '"abc"' })
        : new Response(null, { status: 304 })
    })
    const { publisher, statusLines } = harness()
    const client = createClient(publisher as any)

    const first = await client.json('/products/noaa-scales.json', 'Scales')
    const second = await client.json('/products/noaa-scales.json', 'Scales')

    expect(first).toEqual({ scales: 'unchanged' })
    expect(second).toEqual({ scales: 'unchanged' })
    expect(statusLines.some((m) => m.includes('unchanged'))).toBe(true)
  })

  it('replaces the cached value when the server sends a fresh 200', async () => {
    let requestCount = 0
    vi.stubGlobal('fetch', async () => {
      requestCount++
      return jsonResponse({ n: requestCount }, { etag: `"v${requestCount}"` })
    })
    const { publisher } = harness()
    const client = createClient(publisher as any)

    const first = await client.json('/products/noaa-scales.json', 'Scales')
    const second = await client.json('/products/noaa-scales.json', 'Scales')

    expect(first).toEqual({ n: 1 })
    expect(second).toEqual({ n: 2 })
  })

  it('keeps separate cache entries per NOAA endpoint', async () => {
    const headersSeen: Record<string, Headers> = {}
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      headersSeen[url] = new Headers(init.headers)
      return jsonResponse({ ok: true }, { etag: '"shared-looking-but-not"' })
    })
    const { publisher } = harness()
    const client = createClient(publisher as any)

    await client.json('/products/noaa-scales.json', 'Scales')
    await client.json('/products/alerts.json', 'Alerts')
    // Second call to the *first* path should now carry its own ETag.
    await client.json('/products/noaa-scales.json', 'Scales')

    const scalesUrl = Object.keys(headersSeen).find((u) =>
      u.includes('noaa-scales')
    )!
    expect(headersSeen[scalesUrl].has('if-none-match')).toBe(true)
  })

  it('falls back to a normal request when the response carries no cache headers', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ ok: true }))
    const { publisher } = harness()
    const client = createClient(publisher as any)

    // Must not throw on the second call despite there being nothing cached.
    await client.json('/products/noaa-scales.json', 'Scales')
    const second = await client.json('/products/noaa-scales.json', 'Scales')
    expect(second).toEqual({ ok: true })
  })

  it('still surfaces a real error status, not a 304 misread', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }))
    const { publisher } = harness()
    const client = createClient(publisher as any)

    await expect(
      client.json('/products/noaa-scales.json', 'Scales')
    ).rejects.toThrow()
  })
})
