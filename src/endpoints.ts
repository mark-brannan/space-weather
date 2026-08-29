/**
 * Every NOAA endpoint this plugin fetches, what it costs on the wire, and how
 * often a scheduled run asks for it.
 *
 * This table is the one place those numbers exist. `src/noaa/client.ts` will
 * not fetch a path that is not in it, `src/config.ts` and
 * `public/config-panel.js` price the user's settings out of it, and
 * `test/endpoints.test.ts` holds it against `docs/noaa-products.md`. What this
 * replaces was a sentence in a form description, which kept its original
 * total while a product quietly grew a second and then a third endpoint;
 * #223 had to re-measure to find out how wrong it had gone. That fix
 * corrected the numbers, which is a thing that has to be done again every
 * time. This is the other half: there is now one place for them, and adding
 * an endpoint without one is a build failure rather than a sentence going
 * quietly stale.
 *
 * It imports nothing. `config.ts` reads it to build its descriptions and the
 * products reference it to declare themselves, so anything it imported would
 * be a cycle.
 */

/**
 * When a scheduled run asks for the endpoint: either it follows one of the
 * intervals the user can set, or it keeps a rate of its own.
 */
export type Interval =
  'updateInterval' | 'auroraInterval' | 'drapInterval' | 'goesFluxInterval'

export type Cadence = { follows: Interval } | { fetchesPerDay: number }

export interface Endpoint {
  subPath: string
  /** Wire size with gzip, in bytes. Measured -- never estimated. */
  wireBytes: number
  /** ISO date of the measurement, by scripts/measure-noaa.mjs. */
  measuredOn: string
  cadence: Cadence
  /** The setting that has to be on for the scheduled fetch to happen. */
  requires?: 'auroraEnabled' | 'drapEnabled' | 'goesFluxEnabled'
}

/**
 * The settings the bill depends on. Structural rather than `Settings` from
 * config.ts, which imports this file.
 */
export interface CostSettings {
  auroraEnabled: boolean
  auroraInterval: number
  drapEnabled: boolean
  drapInterval: number
  goesFluxEnabled: boolean
  goesFluxInterval: number
  updateInterval: number
}

// The run in docs/noaa-products.md's payload table. Each `wireBytes` below is
// that table's figure at the precision it records -- kilobytes for the larger
// rows -- rather than a second sample of the same endpoint taken here. The
// point is that the doc and the code cannot disagree; test/endpoints.test.ts
// renders each declaration back into the doc's own units and requires the
// cell to match.
const MEASURED = '2026-08-28'

const follows = (interval: Interval): Cadence => ({ follows: interval })

/** Once every `minutes`, which is what a product with its own timer costs. */
const every = (minutes: number): Cadence => ({
  fetchesPerDay: MINUTES_PER_DAY / minutes
})

export const MINUTES_PER_DAY = 24 * 60

export const SCALES: Endpoint = {
  subPath: '/products/noaa-scales.json',
  wireBytes: 211,
  measuredOn: MEASURED,
  cadence: follows('updateInterval')
}

export const XRAY_FLARE_LATEST: Endpoint = {
  subPath: '/json/goes/primary/xray-flares-latest.json',
  wireBytes: 452,
  measuredOn: MEASURED,
  cadence: follows('updateInterval')
}

export const XRAY_FLARES_7_DAY: Endpoint = {
  subPath: '/json/goes/primary/xray-flares-7-day.json',
  // The one endpoint whose size tracks the weather rather than the format:
  // one record per flare, so an active week costs more than a quiet one.
  wireBytes: 3277,
  measuredOn: MEASURED,
  cadence: follows('updateInterval')
}

export const KP_FORECAST: Endpoint = {
  subPath: '/products/noaa-planetary-k-index-forecast.json',
  wireBytes: 496,
  measuredOn: MEASURED,
  cadence: follows('updateInterval')
}

export const SOLAR_WIND_SPEED: Endpoint = {
  subPath: '/products/summary/solar-wind-speed.json',
  wireBytes: 59,
  measuredOn: MEASURED,
  cadence: follows('updateInterval')
}

export const SOLAR_WIND_MAG_FIELD: Endpoint = {
  subPath: '/products/summary/solar-wind-mag-field.json',
  wireBytes: 60,
  measuredOn: MEASURED,
  cadence: follows('updateInterval')
}

export const ALERTS: Endpoint = {
  subPath: '/products/alerts.json',
  wireBytes: 5427,
  measuredOn: MEASURED,
  cadence: follows('updateInterval')
}

export const GOES_XRAYS_6_HOUR: Endpoint = {
  subPath: '/json/goes/primary/xrays-6-hour.json',
  wireBytes: 24986,
  measuredOn: MEASURED,
  cadence: follows('goesFluxInterval'),
  requires: 'goesFluxEnabled'
}

export const GOES_PROTONS_6_HOUR: Endpoint = {
  subPath: '/json/goes/primary/integral-protons-6-hour.json',
  wireBytes: 8090,
  measuredOn: MEASURED,
  cadence: follows('goesFluxInterval'),
  requires: 'goesFluxEnabled'
}

export const AURORA: Endpoint = {
  subPath: '/json/ovation_aurora_latest.json',
  wireBytes: 147149,
  measuredOn: MEASURED,
  cadence: follows('auroraInterval'),
  requires: 'auroraEnabled'
}

export const DRAP: Endpoint = {
  subPath: '/text/drap_global_frequencies.txt',
  wireBytes: 2150,
  measuredOn: MEASURED,
  cadence: follows('drapInterval'),
  requires: 'drapEnabled'
}

export const F107: Endpoint = {
  subPath: '/json/f107_cm_flux.json',
  wireBytes: 1229,
  measuredOn: MEASURED,
  cadence: every(240)
}

export const A_INDEX: Endpoint = {
  subPath: '/text/wwv.txt',
  wireBytes: 346,
  measuredOn: MEASURED,
  cadence: every(180)
}

export const SUNSPOT: Endpoint = {
  subPath: '/text/daily-solar-indices.txt',
  wireBytes: 845,
  measuredOn: MEASURED,
  cadence: every(240)
}

export const OUTLOOK_27_DAY: Endpoint = {
  subPath: '/text/27-day-outlook.txt',
  wireBytes: 442,
  measuredOn: MEASURED,
  cadence: every(1440)
}

export const ADVISORY: Endpoint = {
  subPath: '/text/advisory-outlook.txt',
  wireBytes: 768,
  measuredOn: MEASURED,
  // The one cadence that is not a fixed timer: the product sleeps up to a day
  // and then polls every 15 minutes through a six-hour window before the
  // weekly issuance is due, so `intervalMinutes` is only its fallback. A week
  // costs roughly six idle fetches plus a couple of dozen in the window --
  // about thirty, which is where 30/7 comes from.
  cadence: { fetchesPerDay: 30 / 7 }
  // No `requires`: `sendAdvisoryOutlook` governs the notification, not the
  // fetch. The product is always scheduled, so the bulletin is always part of
  // the bill -- which is not what the form said before this table existed.
}

/**
 * Every endpoint, in the order the products are scheduled. A fetch of anything
 * not in here is a bug the client refuses at runtime and a test refuses at
 * build time.
 */
export const ENDPOINTS: readonly Endpoint[] = Object.freeze([
  SCALES,
  XRAY_FLARE_LATEST,
  XRAY_FLARES_7_DAY,
  KP_FORECAST,
  OUTLOOK_27_DAY,
  SOLAR_WIND_SPEED,
  SOLAR_WIND_MAG_FIELD,
  F107,
  GOES_XRAYS_6_HOUR,
  GOES_PROTONS_6_HOUR,
  A_INDEX,
  SUNSPOT,
  AURORA,
  DRAP,
  ADVISORY,
  ALERTS
])

/** Same rule as `minutes` in config.ts: a cleared field costs what the plugin will actually spend. */
function minutes(raw: number, fallback: number): number {
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/** Scheduled fetches of one endpoint in a day, at these settings. */
export function fetchesPerDay(
  endpoint: Endpoint,
  settings: CostSettings
): number {
  if (endpoint.requires && !settings[endpoint.requires]) return 0
  const cadence = endpoint.cadence
  if ('fetchesPerDay' in cadence) return cadence.fetchesPerDay
  // The defaults in config.ts, so a cleared field costs what the plugin will
  // actually spend on it.
  const fallback = cadence.follows === 'auroraInterval' ? 120 : 60
  return MINUTES_PER_DAY / minutes(settings[cadence.follows], fallback)
}

/**
 * What the plugin is predicted to fetch in a day at these settings, in bytes,
 * split the way the panel shows it. This is the number a running installation
 * gets compared against.
 */
export function predictedBytesPerDay(settings: CostSettings): {
  aurora: number
  drap: number
  goesFlux: number
  other: number
  fixed: number
  total: number
} {
  const split = {
    aurora: 0,
    drap: 0,
    goesFlux: 0,
    other: 0,
    fixed: 0,
    total: 0
  }
  for (const endpoint of ENDPOINTS) {
    const bytes = fetchesPerDay(endpoint, settings) * endpoint.wireBytes
    const cadence = endpoint.cadence
    const key =
      'fetchesPerDay' in cadence
        ? 'fixed'
        : cadence.follows === 'auroraInterval'
          ? 'aurora'
          : cadence.follows === 'drapInterval'
            ? 'drap'
            : cadence.follows === 'goesFluxInterval'
              ? 'goesFlux'
              : 'other'
    split[key] += bytes
    split.total += bytes
  }
  return split
}

/** One poll of everything on `updateInterval`, in bytes. */
export function bytesPerPoll(): number {
  return ENDPOINTS.filter(
    (e) => 'follows' in e.cadence && e.cadence.follows === 'updateInterval'
  ).reduce((sum, e) => sum + e.wireBytes, 0)
}

/** Bytes as the form should quote them: never a decoded size, never a guess. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 10 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024).toFixed(1)} KB`
}
