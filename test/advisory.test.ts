import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { settingsFrom } from '../src/config'
import { advisory, nextAdvisoryDelayMinutes } from '../src/products/advisory'
import { ADVISORY_BASE } from '../src/paths'
import { NotificationStates } from '../src/parse'
import { fixture } from './fixtures'

const REAL = 'advisory-outlook.2026_08_03.txt'

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

  it('is scheduled whether or not sendAdvisoryOutlook is on', () => {
    // The setting is titled "Send notifications for..."; it governs the
    // notification and nothing else. Gating the schedule on it too froze the
    // published bulletin for as long as the flag stayed off.
    expect(advisory.enabled).toBeUndefined()
  })

  it('publishes no notification while sendAdvisoryOutlook is off', async () => {
    const h = harness(fixture(REAL), {}, { sendAdvisoryOutlook: false })
    await advisory.refresh(h.ctx as any)

    expect(h.errors).toEqual([])
    expect(h.published.filter((p) => p.path === ADVISORY_BASE)).toEqual([])
    // The fetch still happened: the cache is what the webapp reads back.
    expect(existsSync(join(h.dataDir, 'advisory-outlook.json'))).toBe(true)
  })

  it('stands a raised bulletin down when sendAdvisoryOutlook goes off', async () => {
    const h = harness(
      fixture(REAL),
      {
        [`${ADVISORY_BASE}.value`]: {
          id: 'space_weather_advisory_outlook',
          shortId: '#26-30',
          state: NotificationStates.ALERT,
          method: []
        }
      },
      { sendAdvisoryOutlook: false }
    )
    await advisory.refresh(h.ctx as any)

    const [stood] = h.published.filter((p) => p.path === ADVISORY_BASE)
    expect(stood.value.state).toBe(NotificationStates.NORMAL)
    expect(stood.value.method).toEqual([])
  })

  it('re-raises the same bulletin once sendAdvisoryOutlook comes back on', async () => {
    // Same shortId as the fixture, already stood down -- confirms the dedupe
    // checks whether the notification is raised and not only its shortId.
    const h = harness(fixture(REAL), {
      [`${ADVISORY_BASE}.value`]: {
        id: 'space_weather_advisory_outlook',
        shortId: '#26-30',
        state: NotificationStates.NORMAL,
        method: []
      }
    })
    await advisory.refresh(h.ctx as any)

    const [raised] = h.published.filter((p) => p.path === ADVISORY_BASE)
    expect(raised.value.state).toBe(NotificationStates.ALERT)
  })

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
    const h = harness(fixture(REAL))
    await advisory.refresh(h.ctx as any)

    const notifications = h.published.filter((p) => p.value?.id)
    expect(notifications).toHaveLength(1)
    const [only] = notifications
    expect(only.path).toBe(ADVISORY_BASE)
    expect(only.value.shortId).toMatch(/\S/)
    expect(only.value.state).toBe(NotificationStates.ALERT)
  })

  it('does not republish a bulletin the path already holds', async () => {
    const first = harness(fixture(REAL))
    await advisory.refresh(first.ctx as any)
    const [published] = first.published.filter((p) => p.value?.id)

    const again = harness(fixture(REAL), {
      [`${ADVISORY_BASE}.value`]: published.value
    })
    await advisory.refresh(again.ctx as any)
    expect(again.published.filter((p) => p.value?.id)).toEqual([])
  })

  it('stands down a per-bulletin path left by an older version', async () => {
    const stale = {
      id: 'space_weather_advisory_outlookSWO25-034',
      state: NotificationStates.ALERT,
      method: ['visual']
    }
    const h = harness(fixture(REAL), {
      [ADVISORY_BASE]: {
        // The leaf's own keys sit alongside the legacy children.
        value: { id: 'space_weather_advisory_outlook' },
        meta: { name: 'irrelevant' },
        'SWO25-034': { value: stale }
      }
    })
    await advisory.refresh(h.ctx as any)

    const cleared = h.published.find(
      (p) => p.path === `${ADVISORY_BASE}.SWO25-034`
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
        'SWO25-034': {
          value: {
            id: 'space_weather_advisory_outlookSWO25-034',
            state: NotificationStates.NORMAL,
            method: ['visual', 'sound']
          }
        }
      }
    })
    await advisory.refresh(h.ctx as any)

    const cleared = h.published.find(
      (p) => p.path === `${ADVISORY_BASE}.SWO25-034`
    )
    expect(cleared.value.state).toBe(NotificationStates.NORMAL)
    expect(cleared.value.method).toEqual([])
  })

  it('raises the notification by default', async () => {
    // What `advisory.enabled` used to assert. The default is still on, but it
    // is now a fact about the notification rather than about the schedule --
    // see the test at the top of this file for why those had to come apart.
    const h = harness(fixture(REAL), {}, { sendAdvisoryOutlook: undefined })
    await advisory.refresh(h.ctx as any)

    const [raised] = h.published.filter((p) => p.path === ADVISORY_BASE)
    expect(raised.value.state).toBe(NotificationStates.ALERT)
  })
})
