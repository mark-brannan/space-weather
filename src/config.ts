/** Plugin settings: the JSON schema, and normalisation of what comes back. */
import { NoaaScaleValues } from './parse.js'

export interface Settings {
  sendAdvisoryOutlook: boolean
  auroraEnabled: boolean
  auroraInterval: number
  alarmLevel: number
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
    alarmLevel: {
      type: 'number',
      title: 'Sound an alarm at…',
      description:
        'One level below this shows a popup (but no sound); two below is' +
        ' listed silently. Applies to the G, S and R scales and to Kp. Rates' +
        ' are geomagnetic-storm days in a median year — the other scales' +
        ' differ, sharply at 4 and 5 — and roughly double during the active' +
        ' stretch of a solar cycle.',
      // `default` has to stay even though RJSF ignores it as a value under
      // `oneOf` -- it is what selects the initial option, and without it option
      // one silently becomes the default on a fresh install. `type` has to stay
      // too: without it the field renders as nothing at all.
      default: NoaaScaleValues.EXTREME,
      // Quietest first, so reading down the list is turning the plugin up.
      // "and above" is doing real work: it says which way the choice includes.
      // Rates and their provenance are in docs/noaa-products.md.
      oneOf: [
        { const: 5, title: 'Extreme (5) — several times a decade' },
        { const: 4, title: 'Severe (4) and above — once or twice a year' },
        { const: 3, title: 'Strong (3) and above — several times a year' },
        {
          const: 2,
          title: 'Moderate (2) and above — a couple of times a month'
        },
        { const: 1, title: 'Minor (1) and above — most weeks' }
      ]
    },
    auroraEnabled: {
      type: 'boolean',
      title: 'Publish aurora visibility at the vessel position',
      // The one place a user is told what this costs, so the numbers live here
      // rather than in a comment. Re-measure with scripts/measure-noaa.mjs.
      description:
        'Needs a vessel position. Off by default on bandwidth: the aurora grid' +
        ' is about 145 KB per fetch, roughly thirty times everything else this' +
        ' plugin downloads put together. At the default interval that is about' +
        ' 1.7 MB a day, which is real money on a metered satellite link and' +
        ' nothing at all on marina wifi.',
      default: false
    },
    auroraInterval: {
      type: 'number',
      title: 'Aurora fetch interval',
      description:
        'in minutes. Separate from the interval below, and longer, because of' +
        ' the payload size: aurora is a glance-at-it feature rather than a' +
        ' value that needs to track in real time, so there is little reason to' +
        ' spend the bandwidth more than a couple of times an hour.',
      default: 120
    },
    updateInterval: {
      type: 'number',
      title: 'How often to fetch from NOAA',
      description:
        'in minutes. Covers observations, forecasts and alerts alike, which' +
        ' together come to about 5 KB per poll.',
      default: 60
    }
  }
}

/**
 * A NOAA scale value is one of five integers. Anything else falls back, which
 * matters more than it looks: the admin form renders an out-of-range saved
 * value as a blank select with no error and writes it back untouched, so this
 * is the only thing between a hand-edited config and a level nothing can reach.
 */
function scaleValue(raw: any, fallback: number): number {
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 5
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
    // `zoneAlertThreshold` (and `minScaleAlert` before it) named the lowest
    // level worth the user's attention, and the loud states derived upward from
    // it. This anchors on the alarm and derives down instead, so a saved value
    // means a different thing and has to be moved: the old pivot put `alarm`
    // two levels up, which is exactly the offset applied here. An old default
    // of 3 therefore lands on 5 and behaves identically. Old values of 4 and 5
    // clamp to 5 -- they were the dead settings that could never sound at all,
    // and there is no honest way to preserve "silent" through a rename of the
    // thing that makes noise.
    alarmLevel: scaleValue(
      p.alarmLevel ?? shiftUp(p.zoneAlertThreshold ?? p.minScaleAlert),
      NoaaScaleValues.EXTREME
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

/** An old attention-threshold as the equivalent alarm level. */
function shiftUp(raw: any): any {
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 1
    ? Math.min(parsed + 2, NoaaScaleValues.EXTREME)
    : undefined
}

/** The lower of two possibly-absent minute values. */
function smaller(a: any, b: any): any {
  const values = [a, b].map(Number).filter((n) => Number.isFinite(n) && n > 0)
  return values.length > 0 ? Math.min(...values) : undefined
}
