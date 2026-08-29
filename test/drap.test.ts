import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { settingsFrom } from '../src/config'
import { readDrapCache } from '../src/cache/drapCache'
import { drap } from '../src/products/drap'
import { fixture } from './fixtures'
import { Endpoint } from '../src/endpoints'

const REAL = 'drap-global-frequencies.2026_08_20.txt'

function harness(position: any, response?: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'drap-test-'))
  const published: any[] = []
  const errors: string[] = []
  const fetched: string[] = []
  const publisher = {
    meta: () => {},
    values: (values: any[]) => published.push(...values),
    value(path: string, value: any) {
      published.push({ path, value })
    },
    selfPath: (p: string) => {
      if (p === 'navigation.position.value') return position
      // Answers what this harness has already published, the same way
      // products.test.ts's shared harness does, so the dedup check in
      // drap.ts sees what a server would show it.
      const match = p.match(/^(.+)\.value$/)
      return match
        ? published.find((v) => v.path === match[1])?.value
        : undefined
    },
    status: () => {},
    fail: () => {},
    error: (m: string) => errors.push(m),
    debug: () => {},
    // A real directory, not a stub: the grid cache is what the point value
    // is published from now, so a test that faked it would be testing the
    // fake rather than the write-then-rename round trip.
    dataDirPath: () => dataDir
  }
  const client = {
    json: async () => {
      throw new Error('unstubbed json call')
    },
    text: async ({ subPath }: Endpoint) => {
      fetched.push(subPath)
      return response ?? ''
    }
  }
  return {
    published,
    errors,
    fetched,
    dataDir,
    setPosition: (next: unknown) => {
      position = next
    },
    ctx: {
      client,
      publisher,
      settings: settingsFrom({}),
      stopped: () => false
    },
    valueAt: (path: string) => published.find((v) => v.path === path)?.value
  }
}

describe('D-RAP product', () => {
  it('publishes the highest affected frequency at the vessel position, in Hz', async () => {
    // 41N/-178E is an exact grid point in the fixture: 2.9 MHz.
    const h = harness({ latitude: 41, longitude: -178 }, fixture(REAL))
    await drap.refresh(h.ctx as any)

    expect(h.errors).toEqual([])
    expect(
      h.valueAt('environment.noaa.swpc.drap.highest_affected_frequency')
    ).toBeCloseTo(2.9e6, 0)
    expect(h.valueAt('environment.noaa.swpc.drap.validTime')).toBe(
      '2026-08-20T04:42:00.000Z'
    )
  })

  it('fetches and caches the grid with no vessel position at all', async () => {
    const h = harness(undefined, fixture(REAL))
    const result = await drap.refresh(h.ctx as any)

    // The grid is global -- the same bytes wherever the boat is -- so the
    // fetch is worth making before there is anywhere to index it.
    expect(h.fetched).toEqual(['/text/drap_global_frequencies.txt'])
    expect(h.published).toEqual([])
    expect(h.errors).toEqual([])
    expect(result).toBe('awaiting-position')
    expect(readDrapCache(h.dataDir)?.grid.validTime).toBe(
      '2026-08-20T04:42:00.000Z'
    )
  })

  it('publishes from the cache once a position turns up, with no second fetch', async () => {
    const h = harness(undefined, fixture(REAL))
    await drap.refresh(h.ctx as any)

    h.setPosition({ latitude: 41, longitude: -178 })
    expect(drap.publishFromCache!(h.ctx as any)).toBe(true)

    expect(h.fetched.length).toBe(1)
    expect(
      h.valueAt('environment.noaa.swpc.drap.highest_affected_frequency')
    ).toBeCloseTo(2.9e6, 0)
  })

  it('keeps asking only while the position is what is missing', async () => {
    const h = harness(undefined, fixture(REAL))
    await drap.refresh(h.ctx as any)
    expect(drap.publishFromCache!(h.ctx as any)).toBe(false)

    // Nothing cached is not a wait -- no retry will produce a grid.
    const empty = harness(undefined)
    expect(drap.publishFromCache!(empty.ctx as any)).toBe(true)
  })

  it('reports ready once a position appears', async () => {
    const h = harness({ latitude: 41, longitude: -178 }, fixture(REAL))
    expect(await drap.refresh(h.ctx as any)).toBeUndefined()
  })

  it('still fetches when the position is not usable', async () => {
    for (const bad of [
      {},
      { latitude: 'x', longitude: 2 },
      { latitude: null }
    ]) {
      const h = harness(bad, fixture(REAL))
      expect(await drap.refresh(h.ctx as any)).toBe('awaiting-position')
      expect(h.published).toEqual([])
    }
  })

  it('rejects a cached grid whose rows do not match its own axes', () => {
    // A grid with frequenciesMHz but no latitudes/longitudes, or a matrix
    // whose row/column counts don't match, is not a value future lookups can
    // trust -- treat it as nothing cached rather than let a lookup index off
    // the end of a shorter axis.
    const dataDir = mkdtempSync(join(tmpdir(), 'drap-test-'))
    const write = (grid: unknown) =>
      writeFileSync(
        join(dataDir, 'drap-grid.json'),
        JSON.stringify({ fetchedAt: new Date().toISOString(), grid })
      )

    write({ frequenciesMHz: [[1, 2]] })
    expect(readDrapCache(dataDir)).toBeNull()

    write({
      latitudes: [1],
      longitudes: [1, 2],
      frequenciesMHz: [
        [1, 2],
        [3, 4]
      ]
    })
    expect(readDrapCache(dataDir)).toBeNull()

    write({
      latitudes: [1, 2],
      longitudes: [1, 2],
      frequenciesMHz: [[1, 2], [3]]
    })
    expect(readDrapCache(dataDir)).toBeNull()

    write({ latitudes: [1], longitudes: [1, 2], frequenciesMHz: [[1, 2]] })
    expect(readDrapCache(dataDir)).not.toBeNull()
  })

  it('reports a malformed payload without publishing', async () => {
    const h = harness({ latitude: 41, longitude: -178 }, 'not a drap grid')
    await drap.refresh(h.ctx as any)
    expect(h.published).toEqual([])
    expect(h.errors.length).toBe(1)
  })

  it('does not rebroadcast a reading that has not moved', async () => {
    const h = harness({ latitude: 41, longitude: -178 }, fixture(REAL))
    await drap.refresh(h.ctx as any)
    await drap.refresh(h.ctx as any)

    expect(h.errors).toEqual([])
    expect(h.published.length).toBe(2) // one refresh's worth: frequency + validTime
  })
})

describe('the D-RAP switch', () => {
  it('is on unless the saved config says otherwise', () => {
    // A config saved before this setting existed was already fetching D-RAP,
    // so an absent key must not silently stop publishing the path.
    expect(drap.enabled!(settingsFrom({}))).toBe(true)
    expect(drap.enabled!(settingsFrom({ drapEnabled: false }))).toBe(false)
    expect(drap.enabled!(settingsFrom({ drapEnabled: true }))).toBe(true)
  })
})
