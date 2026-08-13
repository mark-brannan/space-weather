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
export const ADVISORY_BASE = 'notifications.noaa.swpc.advisory_outlook'
/**
 * Alerts, watches and warnings, one leaf per NOAA message code (`WARK05`,
 * `ALTEF3`, ...). Before 0.12.0 these went straight under NOTIFICATIONS_BASE
 * keyed by NOAA's serial number, which minted a new permanent path for every
 * reissue of the same condition -- see `currentAlertNotifications` and issue
 * #45. A code names one condition, so the path count is bounded.
 */
export const ALERTS_BASE = 'notifications.noaa.swpc.alerts'
// A single "most recent Noon reading" value, not bucketed by observation
// range like the scales -- there is only ever one current number.
export const F107_BASE = 'environment.noaa.swpc.f107'
/**
 * The 27-day outlook. Its own base rather than a longer arm of KP_BASE: it is
 * a recurrence estimate at daily resolution, and reading it as a continuation
 * of the 3-hourly Kp forecast would overstate both its skill and its detail.
 * Nothing under here carries `zones`, so none of it raises a notification.
 */
export const OUTLOOK27_BASE = 'environment.noaa.swpc.outlook_27day'

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
