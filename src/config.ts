/** Plugin settings: the JSON schema, and normalisation of what comes back. */
import { ALARM_NEVER, NoaaScaleValues } from './parse.js'

export interface Settings {
  sendAdvisoryOutlook: boolean
  auroraEnabled: boolean
  auroraInterval: number
  drapEnabled: boolean
  drapInterval: number
  alarmLevel: number
  popupLevel: number
  updateInterval: number
}

// Quietest first, so reading down a list is turning the plugin up -- which puts
// "Never" above Extreme, since it is quieter than any of them. It carries no
// rate: it does not happen at a frequency. "and above" is doing real work: it
// says which way the choice includes. Rates and their provenance are in
// docs/noaa-products.md.
//
// Both thresholds offer the whole scale. A popup at Minor is not a setting
// anyone should want -- the rates say so -- but it is a defensible thing to
// want, and clipping the range would also mean an existing config that asked
// for it could not be re-created after the panel had touched it.
//
// A function rather than one shared array, so each property gets its own copy.
// The Signal K plugin CI walks the schema with a WeakSet and reports anything
// it reaches twice as a circular reference -- which a shared branch is not, and
// JSON.stringify duplicates it quite happily -- but the check belongs to the
// registry rather than to this repo, and a fresh array costs nothing.
const levelOptions = () => [
  { const: ALARM_NEVER, title: 'Never' },
  { const: 5, title: 'Extreme (5) — several times a decade' },
  { const: 4, title: 'Severe (4) and above — once or twice a year' },
  { const: 3, title: 'Strong (3) and above — several times a year' },
  { const: 2, title: 'Moderate (2) and above — a couple of times a month' },
  { const: 1, title: 'Minor (1) and above — most weeks' }
]

export const schema = {
  type: 'object',
  properties: {
    sendAdvisoryOutlook: {
      type: 'boolean',
      title:
        'Send notifications for weekly "Advisory Outlook" (as notification state="alert")',
      default: true
    },
    // Loudest first, so reading down the form turns the plugin down. Each of
    // these names the level its own band opens at and says nothing about the
    // other, which is the whole reason there are two: one threshold with the
    // quieter rungs derived from it could not be labelled honestly, because
    // whatever the label claimed, the level below it was doing something too.
    alarmLevel: {
      type: 'number',
      title: 'Sound an alarm at…',
      description:
        'Visible and audible, from this level up. Applies to the G, S and R' +
        ' scales and to Kp. Rates are geomagnetic-storm days in a median year' +
        ' — the other scales differ, sharply at 4 and 5 — and roughly double' +
        ' during the active stretch of a solar cycle.',
      // `default` has to stay even though RJSF ignores it as a value under
      // `oneOf` -- it is what selects the initial option, and without it option
      // one silently becomes the default on a fresh install. `type` has to stay
      // too: without it the field renders as nothing at all.
      default: NoaaScaleValues.EXTREME,
      oneOf: levelOptions()
    },
    popupLevel: {
      type: 'number',
      title: 'Show a popup at…',
      description:
        'Visible but silent, from this level up to the alarm level. Cannot be' +
        ' louder than the alarm: a popup level above it would name a band the' +
        ' alarm has already taken, so it is pulled back down. Strong (3) and' +
        ' above is listed without a popup whatever these two are set to — a' +
        ' storm that size should leave a trace even when the plugin is turned' +
        ' all the way down.',
      default: NoaaScaleValues.SEVERE,
      oneOf: levelOptions()
    },
    auroraEnabled: {
      type: 'boolean',
      title: "Keep NOAA's aurora forecast grid up to date",
      // A user reading this form is being told what the setting costs, so the
      // measured numbers live here rather than in a comment. Per *fetch*, and
      // no daily figure: what a day costs depends on `auroraInterval`, and a
      // sentence cannot track it. public/config-panel.js computes it instead,
      // for the servers that render the panel. Re-measure with
      // scripts/measure-noaa.mjs.
      description:
        'Fetches the grid on the interval below, publishing the probability at' +
        ' the vessel position and keeping the chart overlay tiles current.' +
        ' Off by default on bandwidth: about 145 KB per fetch, roughly thirty' +
        ' times everything else this plugin downloads put together, so the' +
        ' interval below sets what it costs a day. This only governs the' +
        ' recurring fetch \u2014 with it off, the webapp can still fetch the' +
        ' grid once, when you ask it to.',
      default: false
    },
    drapEnabled: {
      type: 'boolean',
      title: 'Publish HF absorption (NOAA D-RAP)',
      // Same reasoning as auroraEnabled: the user is being told what the
      // setting costs, so the measured number lives here. Per fetch;
      // public/config-panel.js does the daily arithmetic.
      description:
        'The highest radio frequency D-region absorption is blocking.' +
        ' Frequencies below it are absorbed; those above it should get' +
        ' through, barring other factors. NOAA serves one grid covering the' +
        ' whole globe, so it costs the same everywhere: about 3.3 KB on each' +
        ' fetch of the interval below, hourly by default, against 5 KB for' +
        ' everything else. This only governs the recurring fetch \u2014 with' +
        ' it off, the webapp can still fetch the grid once, when you ask it' +
        ' to.',
      default: true
    },
    drapInterval: {
      type: 'number',
      title: 'D-RAP fetch interval',
      description:
        'in minutes. Separate from the interval below, because D-RAP is the' +
        ' one part of it a user can switch off: its own rate lets that choice' +
        ' also control what it costs, rather than only whether it runs at' +
        ' all.',
      default: 60
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
        'in minutes. Covers observations, forecasts and alerts alike,' +
        ' together about 5 KB per poll.',
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
  // ALARM_NEVER is one past the scale on purpose; see src/parse.ts.
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= ALARM_NEVER
    ? parsed
    : fallback
}

function minutes(raw: any, fallback: number): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function settingsFrom(props: any): Settings {
  const p = props ?? {}
  const alarmLevel = scaleValue(
    // `zoneAlertThreshold` (and `minScaleAlert` before it) named the lowest
    // level worth the user's attention, and the loud states derived upward from
    // it. This anchors on the alarm and derives down instead, so a saved value
    // means a different thing and has to be moved: the old pivot put `alarm`
    // two levels up, which is exactly the offset applied here. An old default
    // of 3 therefore lands on 5 and behaves identically. Old values of 4 and 5
    // clamp to 5 -- they were the dead settings that could never sound at all,
    // and there is no honest way to preserve "silent" through a rename of the
    // thing that makes noise.
    p.alarmLevel ?? shiftUp(p.zoneAlertThreshold ?? p.minScaleAlert),
    NoaaScaleValues.EXTREME
  )
  // `observationsInterval` and `notificationsInterval` are the two settings
  // this replaced. Both are still read so a saved config keeps its cadence
  // instead of silently snapping back to 60, and the smaller wins, since that
  // is the rate the install was already polling at. Resolved once, up front,
  // because drapInterval's own fallback needs the *normalised* value below --
  // reading `p.updateInterval` raw there would skip this migration and land a
  // legacy observations/notifications-only config back on the 60-minute
  // default instead of the cadence it was actually polling at.
  const updateInterval = minutes(
    p.updateInterval ??
      smaller(p.observationsInterval, p.notificationsInterval),
    60
  )
  return {
    sendAdvisoryOutlook: p.sendAdvisoryOutlook !== false,
    auroraEnabled: p.auroraEnabled === true,
    auroraInterval: minutes(p.auroraInterval, 120),
    // On by default, unlike aurora: it is the same order of size as the poll
    // it rides along with, and a config saved before this setting existed was
    // already fetching it, so defaulting off would silently stop publishing a
    // path that install already had.
    drapEnabled: p.drapEnabled !== false,
    // A config saved before this split existed was fetching D-RAP on
    // `updateInterval`, so that's what a pre-existing install keeps -- the
    // resolved value, not the raw prop, so it also carries a legacy
    // observations/notifications-only config's cadence across. An explicit
    // but invalid `drapInterval` still falls back to 60 rather than borrowing
    // `updateInterval`: it names its own setting, wrong value and all.
    drapInterval:
      p.drapInterval === undefined
        ? updateInterval
        : minutes(p.drapInterval, 60),
    alarmLevel,
    popupLevel: popupBand(p.popupLevel, alarmLevel),
    updateInterval
  }
}

/**
 * The popup threshold, which is never louder than the alarm. Above the alarm it
 * would name levels the alarm has already claimed, so it would be inert while
 * still reading as a choice, and it is pulled back down.
 *
 * `ALARM_NEVER` is exempt, because it is the one value above the alarm that is
 * not a mistake: the others are inert by accident, this one asks for no popup
 * band at all. Clamping it would relabel a deliberate "Never" as whatever the
 * alarm happened to be on the next load -- a control that does not read as what
 * was chosen, which is the bug the two thresholds exist to fix.
 *
 * Nor is it only the label. Below `ALERT_FLOOR` the quiet rung follows the
 * popup band down, so a clamped "Never" would also start listing a level the
 * user had asked nothing of.
 */
function popupBand(raw: any, alarmLevel: number): number {
  const level = scaleValue(
    raw,
    // One below the alarm is the band this had when there was only one
    // setting, so a config saved before the split keeps the ladder it already
    // had -- including a saved ALARM_NEVER, which used to slide G5 down into
    // the popup band and now says so outright.
    Math.max(NoaaScaleValues.MINOR, alarmLevel - 1)
  )
  return level === ALARM_NEVER ? level : Math.min(level, alarmLevel)
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
