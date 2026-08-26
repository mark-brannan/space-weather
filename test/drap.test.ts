import { describe, expect, it } from 'vitest'
import { settingsFrom } from '../src/config'
import { drap } from '../src/products/drap'
import { fixture } from './fixtures'

const REAL = 'drap-global-frequencies.2026_08_20.txt'

function harness(position: any, response?: string) {
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
    dataDirPath: () => {
      throw new Error('dataDirPath is not stubbed')
    }
  }
  const client = {
    json: async () => {
      throw new Error('unstubbed json call')
    },
    text: async (subPath: string) => {
      fetched.push(subPath)
      return response ?? ''
    }
  }
  return {
    published,
    errors,
    fetched,
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

  it('does not fetch at all when the vessel has no position', async () => {
    const h = harness(undefined, fixture(REAL))
    const result = await drap.refresh(h.ctx as any)

    expect(h.fetched).toEqual([])
    expect(h.published).toEqual([])
    expect(h.errors).toEqual([])
    expect(result).toBe('not-ready')
  })

  it('reports ready once a position appears', async () => {
    const h = harness({ latitude: 41, longitude: -178 }, fixture(REAL))
    expect(await drap.refresh(h.ctx as any)).not.toBe('not-ready')
  })

  it('ignores a position that is not usable', async () => {
    for (const bad of [
      {},
      { latitude: 'x', longitude: 2 },
      { latitude: null }
    ]) {
      const h = harness(bad, fixture(REAL))
      await drap.refresh(h.ctx as any)
      expect(h.fetched).toEqual([])
    }
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
