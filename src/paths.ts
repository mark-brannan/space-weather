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
export const NOTIFICATIONS_BASE = 'notifications.noaa.swpc'
export const ADVISORY_BASE = 'notifications.noaa.swpc.advisory_outlook'

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
