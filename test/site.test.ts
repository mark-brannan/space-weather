// The browser site (site/, scripts/build-site.mjs): public/index.html with no
// Signal K server under it -- live from the tab by default, a saved capture on
// ?snapshot -- installable to a home screen.
//
// What is pinned: the page stays unforked, the file list stays derived rather
// than written, the seam stands in for the whole of public/signalk.js, the
// service worker's precache list is filled from the site and holds the shell
// only, and a store that outlives the tab degrades rather than failing. The
// live layer actually reaching NOAA cannot be pinned here -- the suite runs
// with no network -- so it is checked in a browser; see docs/development.md.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshFailure } from '../public/aurora.js'
import * as real from '../public/signalk.js'
import * as site from '../site/signalk.js'
import {
  coarsenPosition,
  createLocalStore,
  readLastPosition
} from '../site/store.js'
import { DEMO_PROPS } from '../src/browser/live'
import { settingsFrom } from '../src/config'
import {
  DIST,
  PLUGIN_MODULES,
  PUBLIC_MODULES,
  SHELL,
  SITE_FILES,
  fillChrome,
  fillWorker,
  formatPosition,
  resolveImports,
  snapshotPosition,
  sourceOf
} from '../scripts/build-site.mjs'

const ROOT = join(__dirname, '..')
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8')
const snapshot = JSON.parse(read('site', 'snapshot.json'))

async function freshSite() {
  vi.resetModules()
  return (await import('../site/signalk.js')) as typeof site
}
async function withSnapshot(body: unknown) {
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => body }))
  return freshSite()
}

afterEach(() => vi.unstubAllGlobals())

describe('the assembled site', () => {
  // The build's own resolver, not a copy of it: a copy would only ever agree.
  it('is closed under the imports of everything it copies', () => {
    const files = new Set(SITE_FILES)
    for (const name of SITE_FILES) {
      if (!name.endsWith('.js') && !name.endsWith('.html')) continue
      for (const target of resolveImports(name))
        expect(files.has(target), `${name} -> ${target}`).toBe(true)
    }
  })

  it('refuses an import that resolves outside the site', () => {
    expect(() =>
      resolveImports('index.html', "import x from '../../etc/passwd'")
    ).toThrow(/outside the site/)
    expect(
      resolveImports(
        'vendor/coast-wright/index.js',
        "import x from '../../geo.js'"
      )
    ).toEqual(['geo.js'])
  })

  it('names only files that exist to copy', () => {
    for (const name of SITE_FILES)
      expect(existsSync(sourceOf(name)), name).toBe(true)
  })

  it('serves the shipping page itself, not a fork of it', () => {
    expect(sourceOf('index.html')).toBe(join(ROOT, 'public', 'index.html'))
    expect(PUBLIC_MODULES).toContain('index.html')
  })

  // The substitution the whole site turns on.
  it('reaches what the page imports through the site signalk.js', () => {
    expect(sourceOf('signalk.js')).toBe(join(ROOT, 'site', 'signalk.js'))
    expect(PUBLIC_MODULES).not.toContain('signalk.js')
    expect(SITE_FILES).toContain('snapshot.json')
    expect(SITE_FILES.some((name: string) => name.startsWith('vendor/'))).toBe(
      true
    )
  })

  it('leaves the admin UI config screen out', () => {
    expect(SITE_FILES).not.toContain('remoteEntry.js')
    expect(SITE_FILES).not.toContain('config-panel.js')
  })

  it("copies the live layer's closure out of this repo's dist/", () => {
    expect(PLUGIN_MODULES).toContain('plugin/browser/live.js')
    expect(PLUGIN_MODULES).toContain('plugin/products/registry.js')
    expect(PLUGIN_MODULES.length).toBeGreaterThan(10)
    expect(sourceOf('plugin/browser/live.js')).toBe(
      join(DIST, 'browser', 'live.js')
    )
    expect(DIST).toBe(join(ROOT, 'dist'))
  })

  it('leaves the server-only modules behind', () => {
    expect(SITE_FILES).not.toContain('plugin/index.js')
    expect(SITE_FILES).not.toContain('plugin/publisher.js')
  })
})

describe('site/signalk.js stands in for the whole of public/signalk.js', () => {
  it('exports every name the real module does', () => {
    for (const name of Object.keys(real))
      expect(site[name as keyof typeof site], name).toBeDefined()
  })

  it('answers the same ids, at the paths the real URLs address', () => {
    expect(Object.keys(site.ENDPOINTS).sort()).toEqual(
      Object.keys(real.ENDPOINTS).sort()
    )
    for (const [id, path] of Object.entries(site.ENDPOINTS)) {
      if (path === null) continue
      expect(real.ENDPOINTS[id as keyof typeof real.ENDPOINTS], id).toBe(
        `/signalk/v1/api/vessels/self/${path}`
      )
    }
  })

  it('reads values out of the snapshot, and null where it has none', async () => {
    const sk = await withSnapshot(snapshot)
    const data = await sk.readAll(sk.getJson)
    expect(Object.keys(data).sort()).toEqual(Object.keys(sk.ENDPOINTS).sort())
    expect(sk.leafValue(data.f107)).toBeTypeOf('number')
    expect(data.muf).toBeNull()
  })

  it('answers a plugin route out of the response the capture saved', async () => {
    const sk = await withSnapshot({
      values: {},
      routes: { advisory: { idLine: 'a', issued: 'b', text: 'c' } }
    })
    const data = await sk.readAll(sk.getJson)
    expect(data.advisory).toEqual({ idLine: 'a', issued: 'b', text: 'c' })
    expect(data.status).toBeNull()
  })

  it('hands the map the grid the capture saved', async () => {
    const sk = await withSnapshot(snapshot)
    for (const which of ['aurora', 'drap']) {
      const entry = await sk.fetchGridCache(which)
      expect(entry.grid, which).toBeTypeOf('object')
      expect(Number.isNaN(Date.parse(entry.fetchedAt)), which).toBe(false)
    }
  })

  it('refuses a manual fetch on ?snapshot as a plugin that is not running', async () => {
    for (const which of ['aurora', 'drap']) {
      const err = await site.forceRefresh(which).then(
        () => null,
        (e: any) => e
      )
      expect(refreshFailure(err).kind, which).toBe('stopped')
    }
  })

  it('has no distance preference to read, so the page keeps nmi', async () => {
    expect(await site.distanceUnitPreference()).toBeNull()
  })

  it('retries a snapshot that would not load, and reads null meanwhile', async () => {
    vi.resetModules()
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      if (++calls <= 2) throw new Error('offline')
      return { ok: true, json: async () => snapshot }
    })
    const sk = (await import('../site/signalk.js')) as typeof site
    await expect(sk.snapshot()).rejects.toThrow()
    expect(await sk.getJson(sk.ENDPOINTS.f107 as string)).toBeNull()
    expect(await sk.snapshot()).toBeTypeOf('object')
  })

  // Carried as-is; this pins the live layer and the capture to one answer.
  it('runs live with the props the snapshot was captured under', () => {
    expect(site.SITE_PROPS).toEqual(DEMO_PROPS)
    expect(snapshot.routes.status.settings).toEqual(
      settingsFrom(site.SITE_PROPS)
    )
  })
})

describe("the snapshot's clock", () => {
  const CAPTURED = '2020-06-01T00:00:00.000Z'
  const capturedMs = Date.parse(CAPTURED)

  it('answers the captured instant, and keeps ticking', async () => {
    const sk = await freshSite()
    sk.adoptCaptureClock(CAPTURED)
    expect(Math.abs(sk.DemoDate.now() - capturedMs)).toBeLessThan(1000)
    const first = sk.DemoDate.now()
    await new Promise((done) => setTimeout(done, 20))
    expect(sk.DemoDate.now()).toBeGreaterThan(first)
  })

  it('leaves `new Date(...)` with arguments exactly as it was', async () => {
    const sk = await freshSite()
    sk.adoptCaptureClock(CAPTURED)
    const iso = '2031-02-03T04:05:06.000Z'
    expect(new sk.DemoDate(iso).toISOString()).toBe(iso)
    expect(sk.DemoDate.parse(iso)).toBe(Date.parse(iso))
    expect(new sk.DemoDate() instanceof Date).toBe(true)
    expect(sk.DemoDate.prototype).toBe(Date.prototype)
  })

  it('takes the offset from the snapshot it loads, once', async () => {
    const sk = await withSnapshot({ capturedAt: CAPTURED, values: {} })
    await sk.snapshot()
    const first = sk.DemoDate.now()
    expect(Math.abs(first - capturedMs)).toBeLessThan(1000)
    sk.adoptCaptureClock('1999-01-01T00:00:00.000Z')
    expect(sk.DemoDate.now()).toBeGreaterThanOrEqual(first)
  })
})

describe("site/chrome.js's stand-in positions", () => {
  const source = read('site', 'chrome.js')

  it('fills live from DEMO_POSITION, the snapshot from its capture', () => {
    const filled = fillChrome(source, {
      live: { latitude: 56.98, longitude: -135.35 },
      snapshot: snapshotPosition()
    })
    expect(filled).not.toMatch(/__\w+_POSITION__/)
    expect(filled).toContain('at 56.98°N 135.35°W')
    expect(filled).toContain(`at ${formatPosition(snapshotPosition())}.`)
  })

  it('refuses a template that lost a blank', () => {
    const at = { latitude: 0, longitude: 0 }
    expect(() =>
      fillChrome('only __DEMO_POSITION__', { live: at, snapshot: at })
    ).toThrow(/__SNAPSHOT_POSITION__ not found/)
  })

  it('appends to the page rather than editing it', () => {
    expect(source).toMatch(/querySelector\('\.shell'\)\.append\(note\)/)
  })
})

describe('the service worker', () => {
  // The template as written, filled by the build's own substitution -- not
  // the assembled site, which `npm test` must not depend on.
  const template = read('site', 'sw.js')

  it('has both blanks filled by the build', () => {
    const filled = fillWorker(template, 'deadbeef')
    expect(filled).not.toMatch(/__SHELL__|__VERSION__/)
    expect(filled).toContain('deadbeef')
  })

  it('refuses a template it could not fill', () => {
    expect(() => fillWorker('__SHELL__ __VERSION__ __SHELL__', 'v')).toThrow(
      /placeholder/
    )
  })

  it('precaches the shell: not itself, not the snapshot', () => {
    expect(SHELL).toContain('./index.html')
    expect(SHELL).toContain('./signalk.js')
    expect(SHELL).toContain('./plugin/browser/live.js')
    expect(SHELL).not.toContain('./sw.js')
    expect(SHELL).not.toContain('./snapshot.json')
    expect(SHELL.length).toBe(SITE_FILES.length - 2)
  })

  it('leaves NOAA and the snapshot to the network', () => {
    expect(template).toMatch(/url\.origin !== self\.location\.origin\) return/)
    expect(template).toMatch(/endsWith\('\/snapshot\.json'\)\) return/)
  })

  it('sweeps only its own caches on activate', () => {
    expect(template).toMatch(/startsWith\(CACHE_PREFIX\)/)
  })

  it('holds the event open for the runtime cache write', () => {
    expect(template).toMatch(/event\.waitUntil\(\s*caches\.open\(CACHE\)/)
  })

  it('fails a navigation deliberately rather than with undefined', () => {
    expect(template).toMatch(/\?\? Response\.error\(\)/)
  })
})

describe('the live cache store', () => {
  it('degrades to memory where storage is unusable', () => {
    vi.stubGlobal('localStorage', {
      get getItem(): never {
        throw new Error('denied')
      }
    })
    const store = createLocalStore()
    expect(store.persistent).toBe(false)
    store.writeCache('aurora.json', '{"grid":1}')
    expect(store.readCache('aurora.json')).toBe('{"grid":1}')
    expect(readLastPosition()).toBeNull()
  })

  it('keeps a readable store that can no longer be written to', () => {
    const backing = new Map([['noaa-space-weather:cache:aurora.json', 'grid']])
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: (k: string) => void backing.delete(k)
    })
    expect(createLocalStore().readCache('aurora.json')).toBe('grid')
  })

  it('evicts its own stale copy before the sibling grid', () => {
    const backing = new Map([
      ['noaa-space-weather:cache:aurora.json', 'old-aurora'],
      ['noaa-space-weather:cache:drap.json', 'drap']
    ])
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (backing.has(k)) throw new Error('QuotaExceededError')
        backing.set(k, v)
      },
      removeItem: (k: string) => void backing.delete(k)
    })
    createLocalStore().writeCache('aurora.json', 'new-aurora')
    expect(backing.get('noaa-space-weather:cache:aurora.json')).toBe(
      'new-aurora'
    )
    expect(backing.get('noaa-space-weather:cache:drap.json')).toBe('drap')
  })

  it('drops a write that will not fit instead of raising', () => {
    const backing = new Map<string, string>()
    let refuseLarge = false
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (refuseLarge && v.length > 100) throw new Error('QuotaExceededError')
        backing.set(k, v)
      },
      removeItem: (k: string) => void backing.delete(k)
    })
    const store = createLocalStore()
    store.writeCache('small.json', 'fits')
    refuseLarge = true
    expect(() =>
      store.writeCache('aurora.json', 'x'.repeat(1000))
    ).not.toThrow()
    expect(store.readCache('aurora.json')).toBeNull()
  })
})

describe('the device position is coarsened', () => {
  const source = read('site', 'signalk.js')

  it('rounds every fix to within about 11 km', () => {
    for (const latitude of [-89.97, -12.34, 0.04, 47.60621, 89.99]) {
      for (const longitude of [-179.96, -122.33207, -0.02, 88.881, 179.99]) {
        const fix = coarsenPosition({ latitude, longitude })!
        expect(Math.abs(fix.latitude - latitude)).toBeLessThanOrEqual(0.05001)
        expect(Math.abs(fix.longitude - longitude)).toBeLessThanOrEqual(0.05001)
      }
    }
    expect(coarsenPosition(null)).toBeNull()
  })

  // Read off the source: under a window, the module starts a location watch.
  it('is applied once, at the boundary in site/signalk.js', () => {
    expect(source).toMatch(
      /function adopt\(fix\)[\s\S]*?coarsenPosition\(fix\)/
    )
    expect(source).not.toMatch(/writeLastPosition\(fix\)/)
    expect(source).not.toMatch(/setPosition\(fix\)/)
  })

  it('catches a failed live load on every fix, not just the first', () => {
    expect(source).toMatch(
      /setPosition\(next\)\)\s*\n\s*\.catch\(\(\) => \{\}\)/
    )
  })

  // undefined is what makes startLivePlugin fall back to DEMO_POSITION; null
  // would mean "no position" and leave the vessel values awaiting one.
  it('hands the live layer no position, not a null one, without a fix', () => {
    expect(source).toMatch(/position: current \?\? undefined/)
  })
})
