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
  'noaa-scales.2026_08_01.json'
]

export const ADVISORY_FIXTURES = [
  'advisory-outlook.2025_04_02.txt',
  'advisory-outlook.2025_04_11.txt',
  'advisory-outlook.2025_04_14.txt',
  'advisory-outlook.2025_04_18.txt',
  'advisory-outlook.2026_08_01.txt',
  'advisory-outlook.2026_08_03.txt'
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
