import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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
