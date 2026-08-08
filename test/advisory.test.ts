import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { settingsFrom } from '../src/config'
import { advisory, nextAdvisoryDelayMinutes } from '../src/products/advisory'
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

  function harness(text: string) {
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
      selfPath: () => undefined,
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
        settings: settingsFrom({ sendAdvisoryOutlook: true }),
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

  it('is on by default', () => {
    expect(advisory.enabled!(settingsFrom({}))).toBe(true)
    expect(
      advisory.enabled!(settingsFrom({ sendAdvisoryOutlook: false }))
    ).toBe(false)
  })
})
