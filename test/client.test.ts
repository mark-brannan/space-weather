import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '../src/noaa/client'
import { ALERTS, SCALES, XRAY_FLARE_LATEST } from '../src/endpoints'

/**
 * A minimal Publisher recording what the client told it, and a controllable
 * fetch mock that lets each test script exactly the response sequence NOAA
 * would send for a real conditional GET: 200 with ETag, then 304 once that
 * ETag is echoed back.
 */
function harness() {
  const debugLines: string[] = []
  const statusLines: string[] = []
  const errorLines: string[] = []
  // A real, if trivial, CacheStore: the client now flushes tier 3 (see
  // src/meter.ts) through the publisher it's handed, on a tier-2 rollover,
  // so this needs to work rather than throw the way an unstubbed store would.
  const cacheFiles = new Map<string, string>()
  const publisher = {
    meta: () => {},
    values: () => {},
    value: () => {},
    selfPath: () => undefined,
    status: (m: string) => statusLines.push(m),
    fail: () => {},
    error: (m: string) => errorLines.push(m),
    debug: (m: string) => debugLines.push(m),
    readCache: (filename: string) => cacheFiles.get(filename) ?? null,
    writeCache: (filename: string, text: string) => {
      cacheFiles.set(filename, text)
    }
  }
  return { publisher, debugLines, statusLines, errorLines, cacheFiles }
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

    await client.json(SCALES, 'Scales')

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

    await client.json(SCALES, 'Scales')
    await client.json(SCALES, 'Scales')

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

    const first = await client.json(SCALES, 'Scales')
    const second = await client.json(SCALES, 'Scales')

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

    const first = await client.json(SCALES, 'Scales')
    const second = await client.json(SCALES, 'Scales')

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

    await client.json(SCALES, 'Scales')
    await client.json(ALERTS, 'Alerts')
    // Second call to the *first* path should now carry its own ETag.
    await client.json(SCALES, 'Scales')

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
    await client.json(SCALES, 'Scales')
    const second = await client.json(SCALES, 'Scales')
    expect(second).toEqual({ ok: true })
  })

  it('still surfaces a real error status, not a 304 misread', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }))
    const { publisher } = harness()
    const client = createClient(publisher as any)

    await expect(client.json(SCALES, 'Scales')).rejects.toThrow()
  })
})

describe('createClient with a torn payload', () => {
  // NOAA rewrites these files in place about once a minute, and a read landing
  // mid-write returns the new content followed by the tail of the old, longer
  // content. Observed on xray-flares-latest.json, where losing the reading left
  // the plugin publishing metadata for a path whose value never arrived.
  const torn = (body: string) =>
    new Response(body, { status: 200, headers: { etag: '"t"' } })

  it('uses the complete leading value and reports the trailing bytes', async () => {
    const good = JSON.stringify([{ current_class: 'B5.7' }])
    vi.stubGlobal('fetch', async () => torn(good + '_ratio": 0.133912'))
    const { publisher, errorLines } = harness()

    const data = await createClient(publisher as any).json(
      XRAY_FLARE_LATEST,
      'X-ray flare class'
    )

    expect(data).toEqual([{ current_class: 'B5.7' }])
    expect(errorLines).toHaveLength(1)
    expect(errorLines[0]).toContain('trailing byte')
  })

  it('still throws when the leading value never closes', async () => {
    // A truncated write, rather than a short one followed by old bytes. There is
    // no complete value to recover, and guessing at one would publish a
    // half-read payload as though it were the whole thing.
    vi.stubGlobal('fetch', async () => torn('[{"current_class": "B5.'))
    const { publisher } = harness()

    await expect(
      createClient(publisher as any).json(XRAY_FLARE_LATEST, 'X')
    ).rejects.toThrow()
  })

  it('leaves a well-formed payload on the strict path, with no warning', async () => {
    vi.stubGlobal('fetch', async () => torn(JSON.stringify({ a: 1 })))
    const { publisher, errorLines } = harness()

    expect(await createClient(publisher as any).json(SCALES, 'X')).toEqual({
      a: 1
    })
    expect(errorLines).toEqual([])
  })
})

describe('createClient metering', () => {
  it('records a completed fetch in the ring, keyed by subPath', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({ a: 1 }, { 'content-length': '9' })
    )
    const { publisher } = harness()
    const client = createClient(publisher as any)

    await client.json(SCALES, 'Scales')

    expect(client.meter.ring).toHaveLength(1)
    const record = client.meter.ring[0]
    expect(record.subPath).toBe(SCALES.subPath)
    expect(record.productName).toBe('Scales')
    expect(record.trigger).toBe('schedule')
    expect(record.status).toBe(200)
    expect(record.wireBytes).toBe(9)
    expect(record.wireBytesEstimated).toBe(false)
    expect(record.outcome).toBe('ok')
  })

  it('substitutes decoded size and flags it estimated when content-length is absent', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ a: 1 }))
    const { publisher } = harness()
    const client = createClient(publisher as any)

    await client.json(XRAY_FLARE_LATEST, 'X')

    const record = client.meter.ring[0]
    expect(record.wireBytesEstimated).toBe(true)
    expect(record.wireBytes).toBe(record.decodedBytes)
  })

  it('attributes fetches on a withTrigger view to that trigger, sharing one meter', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ a: 1 }))
    const { publisher } = harness()
    const client = createClient(publisher as any)

    await client.withTrigger('webapp').json(XRAY_FLARE_LATEST, 'X')
    await client.json(ALERTS, 'Y')

    expect(client.meter.ring.map((r) => r.trigger)).toEqual([
      'webapp',
      'schedule'
    ])
  })

  it('records httpError and networkError outcomes distinctly', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }))
    const { publisher } = harness()
    const client = createClient(publisher as any)

    await expect(client.json(XRAY_FLARE_LATEST, 'X')).rejects.toThrow()
    expect(client.meter.ring[0].outcome).toBe('httpError')
    expect(client.meter.ring[0].status).toBe(500)
  })

  it('emits one fixed-shape debug line per fetch', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({ a: 1 }, { 'content-length': '9' })
    )
    const { publisher, debugLines } = harness()
    const client = createClient(publisher as any)

    await client.json(SCALES, 'Scales')

    expect(debugLines).toHaveLength(1)
    expect(debugLines[0]).toMatch(
      /^noaa\.fetch product=Scales path=\/products\/noaa-scales\.json trigger=schedule status=200 wire=9 ms=\d+ outcome=ok$/
    )
  })
})

describe('createClient logging discipline', () => {
  it('sets the status line once per distinct message, not once per fetch', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ a: 1 }))
    const { publisher, statusLines } = harness()
    const client = createClient(publisher as any)

    await client.json(XRAY_FLARE_LATEST, 'X')
    await client.json(XRAY_FLARE_LATEST, 'X')

    expect(statusLines).toHaveLength(1)
  })

  it('calls fail() on the first failure but not on repeats of the same one', async () => {
    let failCount = 0
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }))
    const { publisher: base } = harness()
    const publisher = { ...base, fail: () => failCount++ }
    const client = createClient(publisher as any)

    await expect(client.json(XRAY_FLARE_LATEST, 'X')).rejects.toThrow()
    await expect(client.json(XRAY_FLARE_LATEST, 'X')).rejects.toThrow()
    await expect(client.json(XRAY_FLARE_LATEST, 'X')).rejects.toThrow()

    expect(failCount).toBe(1)
  })

  it('sets the status line again after a failure, so the error banner clears', async () => {
    // `fail()` and `status()` are the same field on the server. Deduping the
    // status message must not mean a recovery leaves the error banner up.
    let requestCount = 0
    vi.stubGlobal('fetch', async () => {
      requestCount++
      return requestCount === 2
        ? new Response('nope', { status: 500 })
        : jsonResponse({ a: 1 })
    })
    const { publisher, statusLines } = harness()
    const client = createClient(publisher as any)

    await client.json(XRAY_FLARE_LATEST, 'X')
    await expect(client.json(XRAY_FLARE_LATEST, 'X')).rejects.toThrow()
    await client.json(XRAY_FLARE_LATEST, 'X')

    expect(statusLines).toHaveLength(2)
  })

  it('records an unparseable content-length as an estimate, never as NaN', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({ a: 1 }, { 'content-length': 'not-a-number' })
    )
    const { publisher } = harness()
    const client = createClient(publisher as any)

    await client.json(XRAY_FLARE_LATEST, 'X')

    const record = client.meter.ring[0]
    expect(record.wireBytes).toBe(record.decodedBytes)
    expect(record.wireBytesEstimated).toBe(true)
    const bucket = client.meter.hourly.get(XRAY_FLARE_LATEST.subPath)![0]
    expect(Number.isFinite(bucket.wireBytes)).toBe(true)
  })

  it('calls a body that aborts mid-stream a timeout, not a parse error', async () => {
    vi.stubGlobal('fetch', async () => {
      const error = new Error('The operation was aborted due to timeout')
      error.name = 'TimeoutError'
      return new Response(
        new ReadableStream({
          start: (controller) => controller.error(error)
        }),
        { status: 200 }
      )
    })
    const { publisher } = harness()
    const client = createClient(publisher as any)

    await expect(client.json(XRAY_FLARE_LATEST, 'X')).rejects.toThrow()
    expect(client.meter.ring[0].outcome).toBe('timeout')
  })

  it('logs a recovery line with the failure count once the fetch succeeds again', async () => {
    let requestCount = 0
    vi.stubGlobal('fetch', async () => {
      requestCount++
      return requestCount <= 2
        ? new Response('nope', { status: 500 })
        : jsonResponse({ a: 1 })
    })
    const { publisher, errorLines } = harness()
    const client = createClient(publisher as any)

    await expect(client.json(XRAY_FLARE_LATEST, 'X')).rejects.toThrow()
    await expect(client.json(XRAY_FLARE_LATEST, 'X')).rejects.toThrow()
    await client.json(XRAY_FLARE_LATEST, 'X')

    expect(errorLines.some((m) => m.includes('recovered after 2'))).toBe(true)
  })
})
