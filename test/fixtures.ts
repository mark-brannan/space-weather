import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ENDPOINTS } from '../public/signalk.js'
import { ValueUpdate } from '../src/parse.js'
import { scales } from '../src/products/scales.js'
import { harness } from './harness.js'

/**
 * Captured NOAA payloads live in examples/ and are the only input these tests
 * use. Nothing here touches the network; offline.test.ts asserts that.
 */
export function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../examples/${name}`, import.meta.url)),
    'utf8'
  )
}

export function fixtureJson(name: string): any {
  return JSON.parse(fixture(name))
}

export const ALERT_FIXTURES = [
  'alerts.2025_04_11.json',
  'alerts.2025_04_17.json',
  'alerts.2026_08_01.json'
]

export const SCALES_FIXTURES = [
  'noaa-scales.2025_04_08.json',
  'noaa-scales.2025_04_10.json',
  'noaa-scales.2025_04_13.json',
  'noaa-scales.2025_04_16.json',
  'noaa-scales.2025_04_18.json',
  'noaa-scales.2026_08_01.json',
  // The payload behind issue #120: R2 in the 24-hour maximum, R0 in the
  // instantaneous reading the badges used to draw.
  'noaa-scales.2026_08_25.json'
]

export const ADVISORY_FIXTURES = [
  'advisory-outlook.2025_04_02.txt',
  'advisory-outlook.2025_04_11.txt',
  'advisory-outlook.2025_04_14.txt',
  'advisory-outlook.2025_04_18.txt',
  'advisory-outlook.2026_08_01.txt',
  'advisory-outlook.2026_08_03.txt'
]

/**
 * Invented payloads, in `examples/synthetic/`. Real captures prove what NOAA
 * does send; these prove the plugin survives what it might -- and, more to the
 * point of #120, they carry the value combinations a real quiet sky never
 * produces. `synthetic-fixtures.test.ts` asserts this list names every file in
 * that directory, so one added and never read cannot go unnoticed.
 */
export const SYNTHETIC_SCALES_FIXTURES = [
  'noaa-scales.all-slots-distinct.json',
  'noaa-scales.storm-in-progress.json',
  'noaa-scales.quiet-with-forecast.json',
  'noaa-scales.solar-radiation-only.json',
  'noaa-scales.extreme-all.json'
]

export const SYNTHETIC_HOSTILE_SCALES_FIXTURES = [
  'noaa-scales.hostile-types.json',
  'noaa-scales.hostile-missing-observed.json',
  'noaa-scales.hostile-out-of-range.json'
]

/**
 * Real X-ray flare captures. A list rather than one name so a new capture is
 * swept by everything that reads it, with no second edit.
 */
export const FLARE_FIXTURES = [
  'xray-flares-latest.2026_08_06.json',
  'xray-flares-latest.2026_08_25.json'
]

/**
 * Solar wind arrives on two endpoints, so a capture is a pair: speed and
 * magnetic field from the same moment. Paired here rather than as two lists
 * because reading a speed from one day against a Bz from another would be a
 * fixture nobody captured.
 */
export const SOLAR_WIND_FIXTURES = [
  {
    speed: 'solar-wind-speed.2026_08_01.json',
    magField: 'solar-wind-mag-field.2026_08_01.json'
  }
]

export const SYNTHETIC_FLARE_FIXTURES = [
  'xray-flares-latest.x-class-peaked.json',
  'xray-flares-latest.x-class-rising.json',
  'xray-flares-latest.hostile-empty.json',
  'xray-flares-latest.hostile-nulls.json'
]

/**
 * Neither is valid JSON, on purpose: read as text, never parsed directly.
 *
 * The two halves of what a read landing mid-rewrite looks like. NOAA rewrites
 * these files in place, so a *shorter* new payload leaves the tail of the
 * longer old one behind -- that is the torn-with-tail one, and it has a
 * complete leading value to recover. The truncated one does not, and must not
 * be recovered into a half value.
 */
export const SYNTHETIC_TRUNCATED_FIXTURE = 'noaa-scales.hostile-truncated.json'
export const SYNTHETIC_TORN_FIXTURE = 'noaa-scales.hostile-torn-with-tail.json'

export const SYNTHETIC_TEXT_FIXTURES = [
  'wwv.no-storms.txt',
  'wwv.all-three-storms.txt',
  'drap-global-frequencies.warning-in-force.txt'
]

export const AURORA_FIXTURES = ['ovation-aurora.2026_08_01.json']

export const OUTLOOK27_FIXTURES = ['27-day-outlook.2026_08_12.txt']

export const KP_FORECAST_FIXTURES = [
  'noaa-planetary-k-index-forecast.2025_04_10.json',
  'noaa-planetary-k-index-forecast.2025_04_11.json',
  'noaa-planetary-k-index-forecast.2025_04_17.json',
  'noaa-planetary-k-index-forecast.2026_08_01.json'
]

/**
 * The server's zone matcher, reproduced verbatim from signalk-server
 * src/zones.ts so the zone tests check the behaviour that actually happens on
 * a server rather than our own restatement of it.
 */
export function matchZone(zones: any[], value: number): number {
  return zones.findIndex((zone) => {
    const { upper = Infinity, lower = -Infinity } = zone
    return typeof value === 'number' && value < upper && value >= lower
  })
}

/**
 * The endpoint the flare class arrives on. Shared because two files stub it:
 * products.test.ts pairs it with a scales payload, dead-fields.test.ts sweeps
 * every captured flare payload past it.
 */
export const FLARE_ENDPOINT = '/json/goes/primary/xray-flares-latest.json'

const SCALES_ENDPOINT = '/products/noaa-scales.json'

type Leaf = { value: unknown; timestamp: string }

/** A GET on a non-leaf path returns the subtree below it, leaves and all. */
export type ApiNode = Leaf | { [key: string]: ApiNode }

/** The dotted path a vessel URL addresses; `null` for the plugin's own routes. */
function pathOf(url: string): string | null {
  const vessel = '/signalk/v1/api/vessels/self/'
  return url.startsWith(vessel)
    ? url.slice(vessel.length).replace(/\//g, '.')
    : null
}

/**
 * What a GET on each endpoint would return, built from what the product
 * published. A path it never published 404s, reaching the webapp as `null`.
 */
function apiTree(
  batches: { values: ValueUpdate[]; timestamp: string }[]
): Record<string, ApiNode | null> {
  const data: Record<string, ApiNode | null> = {}
  for (const [id, url] of Object.entries<string>(ENDPOINTS)) {
    const base = pathOf(url)
    if (base === null) continue
    let node: ApiNode | null = null
    // Each batch stamps its own leaves. `scales.refresh` publishes the flare
    // class and the scale levels in separate calls with separate timestamps,
    // so flattening first and stamping everything from the last batch would
    // report the scales time for the flare leaf -- a surface reading a value
    // from one place and its freshness from another, which is the family of
    // bug this corpus exists to catch.
    for (const { values, timestamp } of batches) {
      for (const { path, value } of values) {
        if (path !== base && !path.startsWith(base + '.')) continue
        const rest = path === base ? [] : path.slice(base.length + 1).split('.')
        const leaf: Leaf = { value, timestamp }
        if (rest.length === 0) {
          node = leaf
          continue
        }
        node ??= {}
        let cursor = node as Record<string, ApiNode>
        for (const key of rest.slice(0, -1))
          cursor = (cursor[key] ??= {}) as Record<string, ApiNode>
        cursor[rest[rest.length - 1]] = leaf
      }
    }
    data[id] = node
  }
  return data
}

/**
 * Runs the real Scales product over one captured payload, offline, and returns
 * the result the way the Signal K API would serve it to the webapp -- the whole
 * path from NOAA's bytes to what a card module reads, with no hand-written
 * middle.
 *
 * `flareFixture` is optional because most scales fixtures do not pair with a
 * flare capture. Left off, the flare endpoint is unstubbed and the client
 * throws, which is the best-effort case the product already handles.
 */
export async function publishedScalesTree(
  scalesFixture: string,
  flareFixture?: string
): Promise<Record<string, ApiNode | null>> {
  const responses: Record<string, unknown> = {
    [SCALES_ENDPOINT]: fixtureJson(scalesFixture)
  }
  if (flareFixture) responses[FLARE_ENDPOINT] = fixtureJson(flareFixture)

  const h = harness(responses)
  await scales.refresh(h.ctx)
  return apiTree(h.published)
}
