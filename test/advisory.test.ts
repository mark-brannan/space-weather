import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsFrom } from '../src/config'
import { advisory, nextAdvisoryDelayMinutes } from '../src/products/advisory'
import { ADVISORY_BASE, ADVISORY_VALUE_BASE } from '../src/paths'
import { writeAdvisoryCache } from '../src/cache/advisoryCache'
import { NotificationStates } from '../src/parse'
import { fixture } from './fixtures'

const REAL = 'advisory-outlook.2026_08_03.txt'
// The real fixture's own issue date -- fetches "at" this moment (or shortly
// after) read as a current bulletin; the real wall clock has since moved
// past the notification's expiry, which is exactly the case a handful of
// these tests need to hold constant.
const REAL_ISSUED = new Date('2026-08-03T04:25:00.000Z')

describe('nextAdvisoryDelayMinutes', () => {
  const ISSUED = new Date('2026-08-03T04:25:00Z')

  it('polls tightly once nothing has ever been cached', () => {
    expect(
      nextAdvisoryDelayMinutes(new Date('2026-08-01T00:00:00Z'), null)
    ).toBe(15)
  })

  it('sleeps until shortly before the next expected issuance', () => {
    // A week out minus the 6h lead time is comfortably more than a day away.
    const now = new Date(ISSUED.getTime() + 24 * 60 * 60 * 1000) // a day later
    const delay = nextAdvisoryDelayMinutes(now, ISSUED)
    expect(delay).toBeGreaterThan(60)
    expect(delay).toBeLessThanOrEqual(24 * 60)
  })

  it('switches to tight polling inside the 6h pre-issuance window', () => {
    const windowOpen = new Date(
      ISSUED.getTime() + 7 * 24 * 60 * 60 * 1000 - 5 * 60 * 60 * 1000
    )
    expect(nextAdvisoryDelayMinutes(windowOpen, ISSUED)).toBe(15)
  })

  it('keeps tight-polling if the expected issuance has come and gone unfetched', () => {
    const overdue = new Date(ISSUED.getTime() + 8 * 24 * 60 * 60 * 1000)
    expect(nextAdvisoryDelayMinutes(overdue, ISSUED)).toBe(15)
  })
})

describe('advisory product', () => {
  const dataDirs: string[] = []
  afterEach(() => {
    for (const dir of dataDirs.splice(0))
      rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  function harness(
    text: string,
    model: Record<string, unknown> = {},
    settingsOverrides: Record<string, unknown> = {}
  ) {
    const published: any[] = []
    const errors: string[] = []
    const dataDir = mkdtempSync(join(tmpdir(), 'advisory-cache-'))
    dataDirs.push(dataDir)
    const publisher = {
      meta: () => {},
      values: (values: any[]) => published.push(...values),
      value(path: string, value: any) {
        published.push({ path, value })
      },
      selfPath: (path: string) => model[path],
      status: () => {},
      fail: () => {},
      error: (m: string) => errors.push(m),
      debug: () => {},
      dataDirPath: () => dataDir
    }
    const client = {
      json: async () => ({}),
      text: async () => text
    }
    return {
      published,
      errors,
      dataDir,
      ctx: {
        client,
        publisher,
        settings: settingsFrom({
          sendAdvisoryOutlook: true,
          ...settingsOverrides
        }),
        stopped: () => false
      }
    }
  }

  it('caches the raw bulletin, issue date, and teaser to disk', async () => {
    const h = harness(fixture(REAL))
    await advisory.refresh(h.ctx as any)

    expect(h.errors).toEqual([])
    const cached = JSON.parse(
      readFileSync(join(h.dataDir, 'advisory-outlook.json'), 'utf8')
    )
    expect(cached.issued).toBe('2026-08-03T04:25:00.000Z')
    expect(cached.text).toBe(fixture(REAL))
    expect(typeof cached.teaser).toBe('string')
    expect(typeof cached.fetchedAt).toBe('string')
  })

  it('returns a scheduling hint tuned to the cached issue date', async () => {
    const h = harness(fixture(REAL))
    const result = await advisory.refresh(h.ctx as any)
    expect(result).toHaveProperty('nextDelayMinutes')
    expect(typeof (result as any).nextDelayMinutes).toBe('number')
  })

  it('does not fail the refresh if the cache write fails', async () => {
    vi.useFakeTimers({ now: REAL_ISSUED, toFake: ['Date'] })
    const h = harness(fixture(REAL))
    ;(h.ctx.publisher as any).dataDirPath = () => {
      throw new Error('disk full')
    }
    const result = await advisory.refresh(h.ctx as any)
    // The notification publish still happened even though caching didn't.
    expect(h.published.length).toBeGreaterThan(0)
    expect(h.errors.some((e) => e.includes('Failed to cache'))).toBe(true)
    expect(result).toHaveProperty('nextDelayMinutes')
  })

  it('reports a parse failure without publishing or throwing', async () => {
    const h = harness('nothing to see here')
    const result = await advisory.refresh(h.ctx as any)
    expect(h.published).toEqual([])
    expect(h.errors.length).toBe(1)
    expect(result).toHaveProperty('nextDelayMinutes')
  })

  it('publishes one fixed path, with the bulletin number in the value', async () => {
    vi.useFakeTimers({ now: REAL_ISSUED, toFake: ['Date'] })
    const h = harness(fixture(REAL))
    await advisory.refresh(h.ctx as any)

    const notifications = h.published.filter((p) => p.path === ADVISORY_BASE)
    expect(notifications).toHaveLength(1)
    const [only] = notifications
    expect(only.value.shortId).toMatch(/\S/)
    expect(only.value.state).toBe(NotificationStates.ALERT)
  })

  it('also publishes the bulletin as plain data, not just a notification', async () => {
    const h = harness(fixture(REAL))
    await advisory.refresh(h.ctx as any)

    const values = h.published.filter((p) => p.path === ADVISORY_VALUE_BASE)
    expect(values).toHaveLength(1)
    expect(values[0].value.shortId).toMatch(/\S/)
    // Plain data, not a notification -- no `state`/`method` to interpret.
    expect(values[0].value).not.toHaveProperty('state')
  })

  it('does not republish a bulletin the path already holds', async () => {
    vi.useFakeTimers({ now: REAL_ISSUED, toFake: ['Date'] })
    const first = harness(fixture(REAL))
    await advisory.refresh(first.ctx as any)
    const [published] = first.published.filter((p) => p.path === ADVISORY_BASE)

    const again = harness(fixture(REAL), {
      // `issued` overridden to just now, purely so this run's real wall
      // clock -- long past the fixture's baked-in date -- doesn't also
      // trip `expireIfStale`; the dedupe under test doesn't look at it.
      [`${ADVISORY_BASE}.value`]: {
        ...published.value,
        issued: new Date().toISOString()
      },
      // The plain-data path already holding a value is what makes the
      // "not empty, so no forced republish on upgrade" branch a no-op here.
      [`${ADVISORY_VALUE_BASE}.value`]: published.value
    })
    // The value path's own dedupe reads the cache, not this path -- seed it
    // the way a real prior run would have left it.
    writeAdvisoryCache(again.dataDir, {
      issued: published.value.issued,
      idLine: published.value.message,
      teaser: null,
      text: fixture(REAL)
    })
    await advisory.refresh(again.ctx as any)
    expect(again.published).toEqual([])
  })

  it('publishes the value path even when the cache already matches, for an install upgrading straight into it', async () => {
    // An install that predates ADVISORY_VALUE_BASE already has today's
    // bulletin cached (the cache existed for the webapp's HTTP route
    // before this path did) -- the plain cache dedupe alone would leave
    // this path empty until the next Monday.
    const h = harness(fixture(REAL))
    writeAdvisoryCache(h.dataDir, {
      issued: '2026-08-03T04:25:00.000Z',
      idLine: 'irrelevant',
      teaser: null,
      text: fixture(REAL)
    })
    await advisory.refresh(h.ctx as any)

    const value = h.published.find((p) => p.path === ADVISORY_VALUE_BASE)
    expect(value).toBeDefined()
  })

  it('keeps fetching and publishing the data when sendAdvisoryOutlook is off, just not the notification', async () => {
    const h = harness(fixture(REAL), {}, { sendAdvisoryOutlook: false })
    await advisory.refresh(h.ctx as any)

    expect(h.published.filter((p) => p.path === ADVISORY_BASE)).toEqual([])
    const value = h.published.find((p) => p.path === ADVISORY_VALUE_BASE)
    expect(value).toBeDefined()
    expect(value.value.shortId).toMatch(/\S/)
    // The fetch still happened: the cache is what the webapp reads back.
    expect(existsSync(join(h.dataDir, 'advisory-outlook.json'))).toBe(true)
  })

  it('stands down an already-raised notification once sendAdvisoryOutlook is turned off', async () => {
    const h = harness(
      fixture(REAL),
      {
        [`${ADVISORY_BASE}.value`]: {
          id: 'space_weather_advisory_outlook',
          shortId: '#old-01',
          issued: '2026-07-20T00:00:00.000Z',
          state: NotificationStates.ALERT,
          method: []
        }
      },
      { sendAdvisoryOutlook: false }
    )
    await advisory.refresh(h.ctx as any)

    const notifications = h.published.filter((p) => p.path === ADVISORY_BASE)
    expect(notifications).toHaveLength(1)
    expect(notifications[0].value.state).toBe(NotificationStates.NORMAL)
    expect(notifications[0].value.method).toEqual([])
  })

  it('expires a notification past its effective week even when the fetch that tick fails to parse', async () => {
    // Past WEEK_MS + 2 * DAY_MS, the slack EXPIRY_MS carries for a bulletin
    // that's merely running late.
    const staleIssued = new Date(
      Date.now() - 10 * 24 * 60 * 60 * 1000
    ).toISOString()
    const h = harness('nothing to see here', {
      [`${ADVISORY_BASE}.value`]: {
        id: 'space_weather_advisory_outlook',
        shortId: '#old-01',
        issued: staleIssued,
        state: NotificationStates.ALERT,
        method: []
      }
    })
    await advisory.refresh(h.ctx as any)

    const notifications = h.published.filter((p) => p.path === ADVISORY_BASE)
    expect(notifications).toHaveLength(1)
    expect(notifications[0].value.state).toBe(NotificationStates.NORMAL)
  })

  it('re-raises a stood-down bulletin once sendAdvisoryOutlook comes back on', async () => {
    // At the fixture's own issue date, the bulletin is not expired -- this
    // is a flag-was-off re-raise, not an expiry one.
    vi.useFakeTimers({ now: REAL_ISSUED, toFake: ['Date'] })
    // Same shortId as the fixture, already stood down -- confirms the
    // dedupe checks `state` and not only `shortId`.
    const h = harness(fixture(REAL), {
      [`${ADVISORY_BASE}.value`]: {
        id: 'space_weather_advisory_outlook',
        shortId: '#26-30',
        issued: '2026-08-03T04:25:00.000Z',
        state: NotificationStates.NORMAL,
        method: []
      }
    })
    await advisory.refresh(h.ctx as any)

    const notifications = h.published.filter((p) => p.path === ADVISORY_BASE)
    expect(notifications).toHaveLength(1)
    expect(notifications[0].value.state).toBe(NotificationStates.ALERT)
  })

  it('does not re-raise a bulletin once it has aged past its own expiry, even with sendAdvisoryOutlook on', async () => {
    // NOAA keeps serving the same bulletin, ten days on -- past
    // EXPIRY_MS. Without the age check at publish time, expireIfStale's
    // stand-down (state now `normal`) would read as "not already current"
    // and get undone on this very tick.
    const now = new Date(REAL_ISSUED.getTime() + 10 * 24 * 60 * 60 * 1000)
    vi.useFakeTimers({ now, toFake: ['Date'] })
    const h = harness(fixture(REAL), {
      [`${ADVISORY_BASE}.value`]: {
        id: 'space_weather_advisory_outlook',
        shortId: '#26-30',
        issued: REAL_ISSUED.toISOString(),
        state: NotificationStates.ALERT,
        method: []
      }
    })
    await advisory.refresh(h.ctx as any)

    const notifications = h.published.filter((p) => p.path === ADVISORY_BASE)
    expect(notifications).toHaveLength(1)
    expect(notifications[0].value.state).toBe(NotificationStates.NORMAL)
  })

  it('stands down a per-bulletin path left by an older version', async () => {
    // The pre-0.25.0 path, keyed on the raw bulletin number NOAA published --
    // `#` included, since nothing sanitized it back then.
    const stale = {
      id: 'space_weather_advisory_outlook#25-11',
      state: NotificationStates.ALERT,
      method: ['visual']
    }
    const h = harness(fixture(REAL), {
      [ADVISORY_BASE]: {
        // The leaf's own keys sit alongside the legacy children.
        value: { id: 'space_weather_advisory_outlook' },
        meta: { name: 'irrelevant' },
        '#25-11': { value: stale }
      }
    })
    await advisory.refresh(h.ctx as any)

    const cleared = h.published.find(
      (p) => p.path === `${ADVISORY_BASE}.#25-11`
    )
    expect(cleared.value.state).toBe(NotificationStates.NORMAL)
    expect(cleared.value.method).toEqual([])
    // The leaf's own `value` and `meta` are not mistaken for legacy children.
    expect(
      h.published.filter((p) => p.path.startsWith(`${ADVISORY_BASE}.`))
    ).toHaveLength(1)
  })

  it('stands down a legacy path left quiet but still asking for a sound', async () => {
    // Issue #45's screenshot: `normal` with a non-empty method still makes
    // noise, so state alone does not mean "already stood down".
    const h = harness(fixture(REAL), {
      [ADVISORY_BASE]: {
        '#25-11': {
          value: {
            id: 'space_weather_advisory_outlook#25-11',
            state: NotificationStates.NORMAL,
            method: ['visual', 'sound']
          }
        }
      }
    })
    await advisory.refresh(h.ctx as any)

    const cleared = h.published.find(
      (p) => p.path === `${ADVISORY_BASE}.#25-11`
    )
    expect(cleared.value.state).toBe(NotificationStates.NORMAL)
    expect(cleared.value.method).toEqual([])
  })

  it('is always scheduled -- sendAdvisoryOutlook governs the notification, not the fetch', () => {
    expect(advisory.enabled).toBeUndefined()
  })
})
