import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ENDPOINTS as PANEL_ENDPOINTS,
  dailyKb
} from '../public/config-panel.js'
import { settingsFrom } from '../src/config'
import {
  ADVISORY,
  ENDPOINTS,
  Endpoint,
  bytesPerPoll,
  predictedBytesPerDay
} from '../src/endpoints'
import { PRODUCTS } from '../src/index'
import { createClient } from '../src/noaa/client'

/**
 * The declarations in src/endpoints.ts are what the config form quotes and
 * what a running installation's traffic gets compared against. Three things
 * have to hold for that to mean anything, and this file is all three: nothing
 * fetches an endpoint that is not declared, the declared sizes are the ones
 * docs/noaa-products.md measured, and the panel computes the same bill the
 * plugin does. The bug this replaces was a form description that said "about
 * 5 KB per poll" while one product had quietly grown from one endpoint to
 * three.
 */

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')

describe('every endpoint is declared', () => {
  it('is claimed by exactly one product', () => {
    const claimed = PRODUCTS.flatMap((product) => product.endpoints)
    expect(new Set(claimed).size).toBe(claimed.length)
    expect(new Set(claimed)).toEqual(new Set(ENDPOINTS))
  })

  it('has a distinct subPath', () => {
    const paths = ENDPOINTS.map((e) => e.subPath)
    expect(new Set(paths).size).toBe(paths.length)
  })

  /**
   * The client takes an `Endpoint`, so a raw path literal cannot compile --
   * but a product could still build one inline and route around the whole
   * table. This is what catches that: every NOAA path in src/ is one the table
   * declares.
   */
  it('is the only kind of NOAA path in the source', () => {
    const declared = new Set(ENDPOINTS.map((e) => e.subPath))
    for (const file of PRODUCT_SOURCES) {
      const source = read(`../src/products/${file}`)
      for (const [literal] of source.matchAll(
        /'(\/(?:json|text|products)\/[^']+)'/g
      )) {
        expect(declared, `${file} fetches ${literal}`).toContain(
          literal.slice(1, -1)
        )
      }
    }
  })

  it('is refused at runtime when it is not in the table', async () => {
    const publisher = {
      status: () => {},
      fail: () => {},
      error: () => {},
      debug: () => {}
    }
    const undeclared: Endpoint = {
      subPath: '/json/made-up.json',
      wireBytes: 1,
      measuredOn: '2026-08-28',
      cadence: { fetchesPerDay: 1 }
    }
    await expect(
      createClient(publisher as any).json(undeclared, 'Invented')
    ).rejects.toThrow(/undeclared endpoint/)
  })
})

const PRODUCT_SOURCES = [
  'scales.ts',
  'kp.ts',
  'outlook27.ts',
  'solarWind.ts',
  'f107.ts',
  'goesFlux.ts',
  'aIndex.ts',
  'sunspot.ts',
  'aurora.ts',
  'drap.ts',
  'advisory.ts',
  'alerts.ts'
]

describe('the measurement script covers the table', () => {
  /**
   * scripts/measure-noaa.mjs is how the declared sizes get re-measured, so an
   * endpoint it does not know about is one that silently never gets a fresh
   * number -- which is how the GOES flux pair went two releases unpriced.
   */
  it('measures every declared endpoint', () => {
    const script = read('../scripts/measure-noaa.mjs')
    for (const endpoint of ENDPOINTS) {
      expect(script, endpoint.subPath).toContain(`'${endpoint.subPath}'`)
    }
  })
})

describe('the declared cadence is the one the product is scheduled on', () => {
  const settings = { ...settingsFrom({}), updateInterval: 45, drapInterval: 15 }

  for (const product of PRODUCTS) {
    for (const endpoint of product.endpoints) {
      const cadence = endpoint.cadence
      if ('follows' in cadence) {
        it(`${endpoint.subPath} follows ${cadence.follows}`, () => {
          expect(product.intervalMinutes(settings)).toBe(
            settings[cadence.follows]
          )
        })
      } else if (endpoint !== ADVISORY) {
        // ADVISORY is the exception, and the only one: its refresh returns a
        // `nextDelayMinutes` that tightens near the weekly issuance, so
        // `intervalMinutes` is a fallback rather than its rate. The declared
        // 30/7 is what a week of that behaviour comes to.
        it(`${endpoint.subPath} keeps its own timer`, () => {
          expect(cadence.fetchesPerDay).toBeCloseTo(
            (24 * 60) / product.intervalMinutes(settings)
          )
        })
      }
    }
  }

  it('requires the same setting the product is enabled by', () => {
    for (const product of PRODUCTS) {
      for (const endpoint of product.endpoints) {
        if (!endpoint.requires) continue
        for (const on of [true, false]) {
          expect(
            product.enabled?.({ ...settings, [endpoint.requires]: on }),
            `${endpoint.subPath} vs ${product.name}`
          ).toBe(on)
        }
      }
    }
  })
})

describe('the declared sizes are the measured ones', () => {
  /**
   * docs/noaa-products.md is the source of truth for how NOAA behaves, so a
   * re-measurement that updates the doc and forgets the code -- or the other
   * way round -- has to fail here rather than ship a form quoting a number
   * nobody measured. Each declaration is rendered back into the doc's own
   * units and has to reproduce the cell exactly: the declarations carry the
   * table's precision, and nothing else.
   */
  const doc = read('../docs/noaa-products.md')
  const from = doc.indexOf('## Payload size')
  // Bounded to that section: every later table in this file is keyed by the
  // same endpoint paths, and an unbounded scan reads a change count as a size.
  const section = doc.slice(from, doc.indexOf('\n###', from))
  const table = new Map<string, string>()
  for (const [, path, wire] of section.matchAll(
    /^\| `([^`]+)` \|[^|]*\|[^|]*\| ([\d.]+ (?:B|KB)) \|/gm
  )) {
    table.set(path, wire)
  }

  /** The doc's own rendering: bytes below a kilobyte, one decimal above. */
  const asDoc = (bytes: number) =>
    bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`

  it('lists exactly the declared endpoints', () => {
    expect([...table.keys()].sort()).toEqual(
      ENDPOINTS.map((e) => e.subPath).sort()
    )
  })

  for (const endpoint of ENDPOINTS) {
    it(`${endpoint.subPath} is the doc's ${asDoc(endpoint.wireBytes)}`, () => {
      expect(table.get(endpoint.subPath)).toBe(asDoc(endpoint.wireBytes))
    })
  }

  it('sums the updateInterval rows to the figure the doc quotes', () => {
    // "The seven rows still marked `updateInterval` come to about 9.7 KB a
    // poll" -- the figure the form now interpolates rather than repeats.
    expect(section).toContain(
      `about ${(bytesPerPoll() / 1024).toFixed(1)} KB a poll`
    )
  })
})

describe('the panel and the plugin compute the same bill', () => {
  it('holds the same table, field for field', () => {
    expect(
      PANEL_ENDPOINTS.map((e: any) => ({ ...e, cadence: { ...e.cadence } }))
    ).toEqual(
      ENDPOINTS.map((e) => {
        const { measuredOn, ...rest } = e
        return { ...rest, cadence: { ...e.cadence } }
      })
    )
  })

  it('agrees on the daily total across the settings a user can reach', () => {
    for (const auroraEnabled of [true, false]) {
      for (const drapEnabled of [true, false]) {
        for (const sendAdvisoryOutlook of [true, false]) {
          for (const updateInterval of [5, 60, 720]) {
            for (const auroraInterval of [30, 120]) {
              for (const drapInterval of [30, 120]) {
                for (const goesFluxEnabled of [true, false]) {
                  for (const goesFluxInterval of [30, 120]) {
                    const settings = settingsFrom({
                      auroraEnabled,
                      drapEnabled,
                      sendAdvisoryOutlook,
                      updateInterval,
                      auroraInterval,
                      drapInterval,
                      goesFluxEnabled,
                      goesFluxInterval
                    })
                    const panel = dailyKb(settings)
                    const plugin = predictedBytesPerDay(settings)
                    for (const key of [
                      'aurora',
                      'drap',
                      'goesFlux',
                      'other',
                      'fixed',
                      'total'
                    ]) {
                      expect(
                        panel[key] * 1024,
                        `${key} at ${JSON.stringify(settings)}`
                      ).toBeCloseTo(plugin[key], 6)
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  })
})
