/** The only outbound I/O in the plugin. */
import { Endpoint, ENDPOINTS } from '../endpoints.js'
import { firstJsonValue } from '../parse.js'
import { Publisher } from '../publisher.js'
import { createMeter, Meter, Outcome, recordFetch, Trigger } from '../meter.js'

export type { Trigger } from '../meter.js'

export const API = 'https://services.swpc.noaa.gov'
const USER_AGENT = 'signalk-noaa-space-weather'
const TIMEOUT_MS = 30000

export interface Client {
  json(endpoint: Endpoint, productName: string): Promise<any>
  text(endpoint: Endpoint, productName: string): Promise<string>
  /** A view of this client that attributes every fetch it makes to `trigger`. */
  withTrigger(trigger: Trigger): Client
  readonly meter: Meter
}

interface CacheEntry {
  etag: string | null
  lastModified: string | null
  value: any
}

/** What `read()` got out of a response body, for metering -- decoded size and whether the payload was whole. */
interface ReadResult {
  value: any
  decodedBytes: number
  outcome: 'ok' | 'torn'
}

/**
 * Thrown by `read()` when the body could not be turned into a value at all.
 * Carries the decoded size anyway -- the bytes were still received and read,
 * even though nothing usable came out of them, and the meter should say so
 * rather than record `decodedBytes: null` for a fetch that plainly landed.
 */
class ReadError extends Error {
  decodedBytes: number
  constructor(message: string, decodedBytes: number, options?: ErrorOptions) {
    super(message, options)
    this.decodedBytes = decodedBytes
  }
}

/** Per-endpoint state for the logging discipline: dedupe repeat failures, and notice recovery. */
interface FetchLogState {
  consecutiveErrors: number
  /** The `consecutiveErrors` count at which the next throttled log line fires. */
  nextLogAt: number
}

export function createClient(publisher: Publisher): Client {
  // Keyed by subPath, not the full URL: every product hits a fixed, distinct
  // path, so this is small and never needs eviction. Lives in this closure
  // rather than module scope so it doesn't leak across plugin instances in a
  // test process, and survives a stop()/start() cycle within one running
  // server the same way NOAA's own cache would want it to.
  const cache = new Map<string, CacheEntry>()
  const meter = createMeter()
  const errorLogStates = new Map<string, FetchLogState>()
  // A single plugin-wide status line (`app.setPluginStatus`), not one per
  // product -- so it is only re-set when what it says has actually changed,
  // never on every fetch just because a fetch happened.
  let lastStatusMessage: string | null = null

  function setStatus(message: string) {
    if (message === lastStatusMessage) return
    lastStatusMessage = message
    publisher.status(message)
  }

  /**
   * `publisher.fail` and `publisher.status` write the same field on the
   * server, so a failure replaces the status line with the error banner.
   * Forgetting the last message is what lets the next success set its status
   * again and clear that banner -- without this, a plugin that failed once and
   * then recovered would show the failure until some *other* product happened
   * to produce a message this one had not already sent.
   */
  function forgetStatus() {
    lastStatusMessage = null
  }

  /**
   * The transition-into-failure and exponential-backoff halves of the
   * logging discipline: a NOAA endpoint failing every minute must not
   * produce one identical line per minute. `publisher.fail` (the plugin's
   * error banner) fires once, on the first failure; after that this logs at
   * doubling intervals, and once on recovery with the count it suppressed.
   * The real count of every failure, throttled or not, is what `recordFetch`
   * already put in the meter -- this is display discipline only.
   */
  function logFailure(subPath: string, message: string) {
    const state = errorLogStates.get(subPath) ?? {
      consecutiveErrors: 0,
      nextLogAt: 1
    }
    state.consecutiveErrors += 1
    if (state.consecutiveErrors === 1) {
      forgetStatus()
      publisher.fail(message)
    } else if (state.consecutiveErrors >= state.nextLogAt) {
      publisher.error(
        `${message} (${state.consecutiveErrors} consecutive failures)`
      )
      state.nextLogAt *= 2
    }
    errorLogStates.set(subPath, state)
  }

  function logRecovery(subPath: string, productName: string) {
    const state = errorLogStates.get(subPath)
    if (!state || state.consecutiveErrors === 0) return
    publisher.error(
      `NOAA Space Weather '${productName}' recovered after ` +
        `${state.consecutiveErrors} failed attempt(s)`
    )
    errorLogStates.delete(subPath)
  }

  /** A failed request or a body that stopped arriving: a timeout, or anything else. */
  function transportOutcome(err: unknown): Outcome {
    return err instanceof Error && err.name === 'TimeoutError'
      ? 'timeout'
      : 'networkError'
  }

  function wireBytesFor(
    response: Response,
    decodedBytes: number | null
  ): { wireBytes: number | null; wireBytesEstimated: boolean } {
    // A malformed or repeated `content-length` parses to NaN, and NaN in a
    // bucket is permanent -- every later sum for that endpoint is NaN too.
    // Fall through to the decoded size rather than record one.
    const contentLength = Number(response.headers.get('content-length'))
    if (
      response.headers.has('content-length') &&
      Number.isFinite(contentLength)
    )
      return { wireBytes: contentLength, wireBytesEstimated: false }
    if (decodedBytes !== null)
      return { wireBytes: decodedBytes, wireBytesEstimated: true }
    return { wireBytes: null, wireBytesEstimated: false }
  }

  function makeClient(trigger: Trigger): Client {
    async function get(
      endpoint: Endpoint,
      productName: string,
      read: (response: Response) => Promise<ReadResult>
    ): Promise<any> {
      // The declaration is what the config form prices, so a fetch it has never
      // heard of would be traffic nobody was told about. Undeclared is a
      // programming error, refused here rather than counted as a NOAA failure --
      // test/endpoints.test.ts is what makes it a build failure instead.
      if (!ENDPOINTS.includes(endpoint)) {
        throw new Error(
          `NOAA Space Weather '${productName}' fetched an undeclared endpoint ` +
            `${endpoint?.subPath}; add it to ENDPOINTS in src/endpoints.ts`
        )
      }
      const { subPath } = endpoint
      const url = API + subPath
      const cached = cache.get(subPath)
      const headers: Record<string, string> = { 'User-Agent': USER_AGENT }
      // Sending both conditional headers costs nothing, and is kept even though
      // no endpoint has ever been observed returning a 304 at a realistic poll
      // interval -- NOAA's ETag carries the file mtime and the files are
      // rewritten whether or not the content changed. Measurements, and the
      // reason this is not a bug, are in docs/noaa-products.md.
      if (cached?.etag) headers['If-None-Match'] = cached.etag
      if (cached?.lastModified)
        headers['If-Modified-Since'] = cached.lastModified

      const startedAt = Date.now()
      /** Record + log one fetch, with the one fixed key=value debug line the logging discipline asks for. */
      const finish = (
        status: number | null,
        outcome: Outcome,
        decodedBytes: number | null,
        wireBytes: number | null,
        wireBytesEstimated: boolean
      ) => {
        const durationMs = Date.now() - startedAt
        recordFetch(meter, {
          subPath,
          productName,
          trigger,
          startedAt,
          durationMs,
          status,
          wireBytes,
          wireBytesEstimated,
          decodedBytes,
          outcome
        })
        publisher.debug(
          `noaa.fetch product=${productName} path=${subPath} trigger=${trigger} ` +
            `status=${status ?? 'none'} wire=${wireBytes ?? 'unknown'} ms=${durationMs} outcome=${outcome}`
        )
      }

      let response: Response
      try {
        response = await fetch(url, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(TIMEOUT_MS)
        })
      } catch (err) {
        finish(null, transportOutcome(err), null, null, false)
        logFailure(
          subPath,
          `NOAA Space Weather '${productName}' unreachable at ${url}: ${err}`
        )
        throw err
      }

      if (response.status === 304 && cached) {
        const { wireBytes, wireBytesEstimated } = wireBytesFor(response, 0)
        finish(304, 'notModified', 0, wireBytes, wireBytesEstimated)
        logRecovery(subPath, productName)
        publisher.debug(`NOAA Space Weather ${productName} unchanged (304)`)
        setStatus(`NOAA Space Weather ${productName} unchanged`)
        return cached.value
      }

      if (!response.ok) {
        const { wireBytes, wireBytesEstimated } = wireBytesFor(response, null)
        finish(
          response.status,
          'httpError',
          null,
          wireBytes,
          wireBytesEstimated
        )
        const message = `NOAA Space Weather '${productName}' not found at ${url}`
        logFailure(subPath, message)
        throw new Error(message)
      }

      let result: ReadResult
      try {
        result = await read(response)
      } catch (err) {
        // `ReadError` is the only failure that is really about the payload;
        // anything else thrown here aborted the body mid-stream, which the
        // request timeout covers as much as it covers the headers.
        const decodedBytes = err instanceof ReadError ? err.decodedBytes : null
        const outcome: Outcome =
          err instanceof ReadError ? 'parseError' : transportOutcome(err)
        const { wireBytes, wireBytesEstimated } = wireBytesFor(
          response,
          decodedBytes
        )
        finish(
          response.status,
          outcome,
          decodedBytes,
          wireBytes,
          wireBytesEstimated
        )
        const message = `NOAA Space Weather '${productName}' could not be read at ${url}: ${err}`
        logFailure(subPath, message)
        throw err
      }

      const { wireBytes, wireBytesEstimated } = wireBytesFor(
        response,
        result.decodedBytes
      )
      finish(
        response.status,
        result.outcome,
        result.decodedBytes,
        wireBytes,
        wireBytesEstimated
      )
      logRecovery(subPath, productName)

      const etag = response.headers.get('etag')
      const lastModified = response.headers.get('last-modified')
      if (etag || lastModified) {
        cache.set(subPath, { etag, lastModified, value: result.value })
      } else {
        cache.delete(subPath)
      }
      setStatus(`NOAA Space Weather ${productName} retrieved`)
      return result.value
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
    ): Promise<ReadResult> {
      const body = await response.text()
      try {
        return {
          value: JSON.parse(body),
          decodedBytes: body.length,
          outcome: 'ok'
        }
      } catch (err) {
        const leading = firstJsonValue(body)
        if (leading === null)
          throw new ReadError(String(err), body.length, { cause: err })
        const parsed = JSON.parse(leading)
        publisher.error(
          `NOAA Space Weather '${productName}' arrived with ` +
            `${body.length - leading.length} trailing byte(s) after a complete ` +
            `JSON value; used the value and ignored the rest`
        )
        return { value: parsed, decodedBytes: body.length, outcome: 'torn' }
      }
    }

    async function readText(response: Response): Promise<ReadResult> {
      const body = await response.text()
      return { value: body, decodedBytes: body.length, outcome: 'ok' }
    }

    return {
      json: (endpoint, productName) =>
        get(endpoint, productName, (r) => readJson(r, productName)),
      text: (endpoint, productName) => get(endpoint, productName, readText),
      withTrigger: (t) => makeClient(t),
      meter
    }
  }

  return makeClient('schedule')
}
