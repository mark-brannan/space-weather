/**
 * Single source of truth for the Signal K paths this plugin owns.
 *
 * The metadata for the scales used to be six near-identical hand-written
 * blocks, and three of them silently pointed at the wrong paths. Anything that
 * repeats per scale or per forecast range is derived from the tables here
 * instead, so that class of mistake cannot recur.
 */
export const SCALES_BASE = 'environment.noaa.swpc.scales.'
export const KP_BASE = 'environment.noaa.swpc.kp'
export const SOLAR_WIND_BASE = 'environment.noaa.swpc.solar_wind'
export const AURORA_BASE = 'environment.noaa.swpc.aurora'
// Same underlying GOES X-ray measurement the R scale buckets into 0-5, at
// the letter+number resolution (e.g. "M2.1") operators actually use. Not
// under SCALES_BASE: it isn't bucketed by observation range like G/S/R are,
// it's a single "most recent event" reading.
export const XRAY_FLARE_BASE = 'environment.noaa.swpc.xray_flare'
export const NOTIFICATIONS_BASE = 'notifications.noaa.swpc'
/**
 * The weekly Advisory Outlook, a single notification rather than a subtree:
 * there is only ever one current bulletin, and keying the path on the week's
 * bulletin number moved the notification out from under anyone subscribed to
 * it every Monday (issue #104). The number is in the value's `shortId`, and
 * `clearShortIdPaths` cleans up after the old scheme.
 */
export const ADVISORY_BASE = 'notifications.noaa.swpc.advisory_outlook'
/**
 * Alerts, watches and warnings, one leaf per NOAA message code (`WARK05`,
 * `ALTEF3`, ...) rather than per serial number; `currentAlertNotifications`
 * explains why, and `clearSerialNumberPaths` cleans up after the old scheme.
 */
export const ALERTS_BASE = 'notifications.noaa.swpc.alerts'
// A single "most recent Noon reading" value, not bucketed by observation
// range like the scales -- there is only ever one current number.
export const F107_BASE = 'environment.noaa.swpc.f107'
/**
 * The 27-day outlook: a third horizon for the same index, so a named subtree of
 * the Kp forecast rather than a base of its own. Asking "what is the worst Kp
 * coming" should not require knowing which NOAA product answered.
 *
 * A subtree, and deliberately not siblings of `max24h`/`max72h`, because the
 * two are not the same kind of data -- one is a 3-hourly sample, the other a
 * whole-day maximum from a recurrence estimate. Flattened into one namespace
 * they read as interchangeable, and the two `series` invite being spliced into
 * a single array, which misrepresents both. Naming the node makes reading the
 * outlook as a continuation of the 3-day forecast a deliberate act rather than
 * an accident; the outlook27 product says why that reading would overstate it.
 */
export const OUTLOOK27_BASE = `${KP_BASE}.forecast.outlook27`
/**
 * The estimated planetary A index -- the daily linearised summary of the
 * 3-hourly K, and the third term of the phrase every HF operator reads
 * conditions in ("SFI 145, A 8, K 2").
 *
 * Its own base rather than an arm of KP_BASE even though both are geomagnetic:
 * A is a whole-day average and Kp a 3-hourly sample, and under one base the
 * two invite being read against each other as though a rise in one meant a
 * rise in the other on the same clock.
 *
 * No `zones` on it, deliberately. A high A index describes a day that has
 * already happened, and everything it would raise is something the Kp
 * forecast and the alerts product have already said louder and sooner.
 */
export const A_INDEX_BASE = 'environment.noaa.swpc.a_index'
/**
 * The SESC sunspot number: the slow variable, telling an operator whether the
 * high bands open at all this month. Alongside F107_BASE rather than under it
 * -- the two track each other closely but are separate observations, and one
 * is not derived from the other.
 */
export const SUNSPOT_BASE = 'environment.noaa.swpc.sunspot_number'

export const SCALE_LETTERS = ['G', 'S', 'R'] as const
export type ScaleLetter = (typeof SCALE_LETTERS)[number]

export const SCALE_DESCRIPTIONS: Record<ScaleLetter, string> = {
  G: 'Geomagnetic Storm',
  S: 'Solar Radiation Storm',
  R: 'Radio Blackout'
}

export interface ScaleRange {
  /** Key in noaa-scales.json. */
  jsonIndex: string
  subPath: string
  label: string
  isObservation: boolean
}

export const NOAA_SCALE_RANGES: ScaleRange[] = [
  {
    jsonIndex: '-1',
    subPath: 'observations.24_hours_maximums',
    label: '24-hour observed maximum',
    isObservation: true
  },
  {
    jsonIndex: '0',
    subPath: 'observations.latest',
    label: 'Latest observed',
    isObservation: true
  },
  {
    jsonIndex: '1',
    subPath: 'forecast.1day',
    label: 'Day 1 forecast',
    isObservation: false
  },
  {
    jsonIndex: '2',
    subPath: 'forecast.2day',
    label: 'Day 2 forecast',
    isObservation: false
  },
  {
    jsonIndex: '3',
    subPath: 'forecast.3day',
    label: 'Day 3 forecast',
    isObservation: false
  }
]
