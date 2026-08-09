/** Plugin settings: the JSON schema, and normalisation of what comes back. */
import { NoaaScaleValues } from './parse.js'

export interface Settings {
  sendAdvisoryOutlook: boolean
  auroraEnabled: boolean
  auroraInterval: number
  zoneAlertThreshold: number
  updateInterval: number
}

export const schema = {
  type: 'object',
  properties: {
    sendAdvisoryOutlook: {
      type: 'boolean',
      title:
        'Send notifications for weekly "Advisory Outlook" (as notification state="alert")',
      default: true
    },
    zoneAlertThreshold: {
      type: 'number',
      title:
        'Lowest NOAA "scale" value this plugin treats as worth your attention',
      description:
        '1-5. Governs both the alarm zone on observed/forecast scale and Kp values,' +
        ' and the state of NOAA alert/watch/warning notifications. Levels below this' +
        ' are "normal". This level is "alert" (no popup or sound), one above is' +
        ' "warn" (visual), and higher is "alarm" (visual and sound). The default of 3' +
        ' reflects NOAA event frequencies: level 1 occurs on roughly a quarter of all' +
        ' days, level 3 about monthly, level 5 four times per solar cycle.',
      default: NoaaScaleValues.STRONG
    },
    auroraEnabled: {
      type: 'boolean',
      title: 'Publish aurora visibility at the vessel position',
      description:
        "Requires a position. Off by default because NOAA's aurora grid is" +
        ' roughly 900 KB per fetch, which is significant on a metered' +
        ' satellite link.',
      default: false
    },
    auroraInterval: {
      type: 'number',
      title: 'Aurora fetch interval',
      description:
        'in minutes. Separate from the interval below, and longer, because of' +
        ' the payload size (~900 KB): aurora is a glance-at-it feature rather' +
        ' than a value that needs to track in real time, so there is little' +
        ' reason to spend the bandwidth more than a couple of times an hour.',
      default: 120
    },
    updateInterval: {
      type: 'number',
      title: 'How often to fetch from NOAA',
      description:
        'in minutes. Covers observations, forecasts and alerts alike. NOAA' +
        ' publishes on its own cadence, so polling faster than it publishes' +
        ' only costs bandwidth.',
      default: 60
    }
  }
}

function scaleValue(raw: any, fallback: number): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 5
    ? parsed
    : fallback
}

function minutes(raw: any, fallback: number): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function settingsFrom(props: any): Settings {
  const p = props ?? {}
  return {
    sendAdvisoryOutlook: p.sendAdvisoryOutlook !== false,
    auroraEnabled: p.auroraEnabled === true,
    auroraInterval: minutes(p.auroraInterval, 120),
    // Before 0.8.0 this was two separate settings (minScaleAlert and
    // zoneAlertThreshold) that happened to share the same default and the
    // same purpose -- "how bad before this plugin makes noise about it" --
    // and had no reason to ever be set differently. `minScaleAlert` is
    // accepted here only so an old saved config that customised it isn't
    // silently ignored; it no longer appears in the schema.
    zoneAlertThreshold: scaleValue(
      p.zoneAlertThreshold ?? p.minScaleAlert,
      NoaaScaleValues.STRONG
    ),
    // `observationsInterval` and `notificationsInterval` are the two settings
    // this replaced. Both are still read so a saved config keeps its cadence
    // instead of silently snapping back to 60, and the smaller wins, since that
    // is the rate the install was already polling at.
    updateInterval: minutes(
      p.updateInterval ??
        smaller(p.observationsInterval, p.notificationsInterval),
      60
    )
  }
}

/** The lower of two possibly-absent minute values. */
function smaller(a: any, b: any): any {
  const values = [a, b].map(Number).filter((n) => Number.isFinite(n) && n > 0)
  return values.length > 0 ? Math.min(...values) : undefined
}
