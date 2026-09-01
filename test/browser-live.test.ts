/**
 * The demo's live data layer (#239 leg 2): the plugin's own product modules,
 * running in a browser tab against NOAA with no server under them.
 *
 * What is pinned here is everything about that layer a test can hold offline
 * -- the publisher's two views of what it published, and the fact that the two
 * demos state the same viewpoint. The layer actually reaching NOAA cannot be
 * pinned here at all: the plugin registry runs `npm test` under
 * `firejail --net=none` with a 60 second cap. That half is checked in a
 * browser by hand; see docs/development.md.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { settingsFrom } from '../src/config'
import { DEMO_POSITION, DEMO_PROPS } from '../src/browser/live'
import { createBrowserPublisher } from '../src/browser/publisher'
import { createDocumentSeam } from '../src/browser/seam'
import { readAuroraCache, writeAuroraCache } from '../src/cache/auroraCache'
import { PLUGIN_MODULES, SITE_FILES, sourceOf } from '../scripts/build-demo.mjs'

const ROOT = join(__dirname, '..')
const snapshot = JSON.parse(
  readFileSync(join(ROOT, 'demo', 'snapshot.json'), 'utf8')
)

const publisher = () => createBrowserPublisher({ position: DEMO_POSITION })

describe('the browser publisher', () => {
  it('keeps the flat and nested views of one publication in step', () => {
    const p = publisher()
    p.value('environment.noaa.swpc.kp', 4.3, '2026-08-29T00:00:00Z')
    expect(p.published['environment.noaa.swpc.kp']).toEqual({
      value: 4.3,
      timestamp: '2026-08-29T00:00:00Z'
    })
    expect(p.tree.environment.noaa.swpc.kp.value).toBe(4.3)
  })

  // The shape products read their own last value back through, and the one
  // case that has bitten before: a path that is both a leaf and a parent.
  it('merges a leaf into a node that already has a child', () => {
    const p = publisher()
    p.value('environment.noaa.swpc.xray_flux.trend', 0.99, 'now')
    p.value('environment.noaa.swpc.xray_flux', 1e-6, 'now')
    expect(p.selfPath('environment.noaa.swpc.xray_flux.value')).toBe(1e-6)
    expect(p.selfPath('environment.noaa.swpc.xray_flux.trend.value')).toBe(0.99)
  })

  it('merges metadata onto the same node as the value', () => {
    const p = publisher()
    p.meta([{ path: 'environment.noaa.swpc.f107', value: { units: 'sfu' } }])
    p.value('environment.noaa.swpc.f107', 116, 'now')
    expect(p.published['environment.noaa.swpc.f107']).toEqual({
      meta: { units: 'sfu' },
      value: 116,
      timestamp: 'now'
    })
  })

  // `undefined`, not null: products branch on exactly what the server's
  // getSelfPath answers for a path it has never seen, and null takes the
  // other branch.
  it('answers undefined for a path nothing has published', () => {
    expect(
      publisher().selfPath('environment.noaa.swpc.nothing')
    ).toBeUndefined()
  })

  it('answers the vessel position in both shapes products ask for', () => {
    const p = publisher()
    expect(p.selfPath('navigation.position.value')).toEqual(DEMO_POSITION)
    expect(p.selfPath('navigation.position')).toMatchObject({
      value: DEMO_POSITION
    })
  })

  it('is the CacheStore its products persist through', () => {
    const p = publisher()
    expect(readAuroraCache(p)).toBeNull()
    writeAuroraCache(p, { coordinates: [] })
    expect(readAuroraCache(p)?.grid).toEqual({ coordinates: [] })
  })
})

describe('the two demos agree about what they are showing', () => {
  // The saved capture imports both of these from the live layer. If they ever
  // stop matching what is in the committed snapshot, the page's two modes are
  // claiming different viewpoints -- and every number on it is worked out from
  // that position.
  it('captures at the position the live layer states', () => {
    expect(snapshot.values['navigation.position'].value).toEqual(DEMO_POSITION)
  })

  it('captures with the settings the live layer runs', () => {
    expect(snapshot.routes.status.settings).toEqual(settingsFrom(DEMO_PROPS))
  })
})

describe('the assembled site carries the compiled plugin', () => {
  it('copies the live layer and its closure out of dist/', () => {
    expect(PLUGIN_MODULES).toContain('plugin/browser/live.js')
    expect(PLUGIN_MODULES).toContain('plugin/products/registry.js')
    expect(PLUGIN_MODULES.length).toBeGreaterThan(10)
  })

  // The whole point of the registry split: index.ts owns the plugin
  // lifecycle, the HTTP routes and the tile renderer, and reaches the
  // filesystem through every one of them.
  it('leaves the server-only modules behind', () => {
    expect(SITE_FILES).not.toContain('plugin/index.js')
    expect(SITE_FILES).not.toContain('plugin/tiles.js')
    expect(SITE_FILES).not.toContain('plugin/publisher.js')
  })

  it('reads a plugin module out of dist/, not public/', () => {
    expect(sourceOf('plugin/browser/live.js')).toBe(
      join(ROOT, 'dist', 'browser', 'live.js')
    )
  })
})

describe('a poll does not re-read the grids', () => {
  // `readAll` calls document() once per path; live.ts answers `grids` with
  // getters so those 18 calls cost no ~900 KB JSON.parse each.
  const countingDocument = () => {
    let reads = 0
    const document = async () => ({
      values: {},
      tree: {},
      grids: {
        get aurora() {
          reads += 1
          return { fetchedAt: 'now', grid: [] }
        },
        get drap() {
          reads += 1
          return { fetchedAt: 'now', grid: [] }
        }
      },
      routes: {}
    })
    return { document, reads: () => reads }
  }

  it('reads no grid at all over a whole readAll pass', async () => {
    const { document, reads } = countingDocument()
    const seam = createDocumentSeam({
      document,
      forceRefresh: async () => undefined
    })
    await seam.readAll()
    expect(reads()).toBe(0)
  })

  it('reads one grid when the map asks for one', async () => {
    const { document, reads } = countingDocument()
    const seam = createDocumentSeam({
      document,
      forceRefresh: async () => undefined
    })
    await seam.fetchGridCache('aurora')
    expect(reads()).toBe(1)
  })

  it('answers grids as getters, not as eager reads', () => {
    const source = readFileSync(join(ROOT, 'src', 'browser', 'live.ts'), 'utf8')
    expect(source).toMatch(/get aurora\(\) \{\s*\n\s*return readAuroraCache/)
    expect(source).toMatch(/get drap\(\) \{\s*\n\s*return readDrapCache/)
  })
})
