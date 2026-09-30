/**
 * The Signal K plugin's configuration form: the JSON schema the admin UI
 * renders, and its descriptions, priced out of `endpoints.ts`. It belongs to
 * the plugin rather than the core: only `public/config-panel.js`'s tests and
 * the `./config` and `./schema` subpaths reach it, and the core reads its
 * settings through `settings.ts`.
 */
import {
  AURORA,
  DRAP,
  GOES_PROTONS_6_HOUR,
  GOES_XRAYS_6_HOUR,
  bytesPerPoll,
  formatBytes,
  predictedBytesPerDay
} from './endpoints.js'
import { ALARM_NEVER, DEFAULT_LIST_LEVEL, NoaaScaleValues } from './parse.js'

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

/**
 * The three figures the GOES flux description quotes, at the defaults. They
 * are the predicted bill rather than a sentence about it: `defaultCost` runs
 * the same arithmetic the panel does, so the form and the panel cannot say
 * different things about the same box.
 */
const GOES_FLUX_BYTES =
  GOES_XRAYS_6_HOUR.wireBytes + GOES_PROTONS_6_HOUR.wireBytes
const defaultCost = (goesFluxEnabled: boolean) =>
  predictedBytesPerDay({
    auroraEnabled: false,
    auroraInterval: 120,
    drapEnabled: true,
    drapInterval: 60,
    goesFluxEnabled,
    goesFluxInterval: 60,
    updateInterval: 60
  })
const GOES_FLUX_DAILY = defaultCost(true).goesFlux
const REST_DAILY = defaultCost(false).total

export const schema = {
  type: 'object',
  properties: {
    sendAdvisoryOutlook: {
      type: 'boolean',
      title:
        'Send notifications for weekly "Advisory Outlook" (as notification state="alert")',
      description:
        'Governs the notification only \u2014 the bulletin is fetched either' +
        ' way, at under a kilobyte a day.',
      default: true
    },
    stormAlertsEnabled: {
      type: 'boolean',
      title: 'Send a single geomagnetic storm notification (G3 and above)',
      description:
        'One notification raised while a Strong (G3) or greater storm is in' +
        ' force, changing only when the storm deepens or eases and standing' +
        ' down six hours after it ends — a handful of episodes in a typical' +
        ' year. Loudness follows the two thresholds below. The per-message' +
        ' notifications are published either way.',
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
        ' alarm has already taken, so it is pulled back down.',
      default: NoaaScaleValues.SEVERE,
      oneOf: levelOptions()
    },
    listLevel: {
      type: 'number',
      title: 'List, even silently, at…',
      description:
        'Appears in the notification list with no popup and no sound, from' +
        ' this level up to the popup level. Below it, a level is not listed at' +
        ' all -- same as no storm. Cannot be louder than the popup level, for' +
        ' the same reason the popup level cannot outrank the alarm.',
      default: DEFAULT_LIST_LEVEL,
      oneOf: levelOptions()
    },
    auroraEnabled: {
      type: 'boolean',
      title: "Keep NOAA's aurora forecast grid up to date",
      // Every figure in these descriptions is interpolated from the declared
      // wire size in src/endpoints.ts rather than written into the sentence.
      // A written one goes stale silently: the old total outlived the
      // endpoints that made it wrong, and #223 had to re-measure to find that
      // out. Still per *fetch* and no daily figure -- what a day costs depends
      // on the interval, which public/config-panel.js prices as the user moves
      // it. Re-measure with scripts/measure-noaa.mjs.
      description:
        'Fetches the grid on the interval below, publishing the probability at' +
        ' the vessel position and keeping the chart overlay tiles current.' +
        ` Off by default on bandwidth: about ${formatBytes(AURORA.wireBytes)}` +
        ` per fetch, ${(AURORA.wireBytes / bytesPerPoll()).toFixed(0)} times` +
        ' what one poll of everything else costs, so the' +
        ' interval below sets what it costs a day. This only governs the' +
        ' recurring fetch \u2014 with it off, the webapp can still fetch the' +
        ' grid once, when you ask it to.',
      default: false
    },
    drapEnabled: {
      type: 'boolean',
      title: 'Publish HF absorption (NOAA D-RAP)',
      // Same reasoning as auroraEnabled, and the same interpolation.
      description:
        'The highest radio frequency D-region absorption is blocking.' +
        ' Frequencies below it are absorbed; those above it should get' +
        ' through, barring other factors. NOAA serves one grid covering the' +
        ' whole globe, so it costs the same everywhere: about ' +
        `${formatBytes(DRAP.wireBytes)} on each fetch of the interval below,` +
        ' hourly by default, against about ' +
        `${formatBytes(bytesPerPoll())} for the rest of that poll and ` +
        `${formatBytes(GOES_FLUX_BYTES)} for the GOES flux pair.` +
        ' This only governs the recurring fetch \u2014 with' +
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
    goesFluxEnabled: {
      type: 'boolean',
      title: 'Publish GOES X-ray and proton flux',
      // Same reasoning as auroraEnabled and drapEnabled, and the same
      // interpolation -- including the two daily figures, which are the whole
      // predicted bill at the defaults with this box ticked and unticked.
      description:
        'The X-ray and proton measurements the R and S scales are bucketed' +
        ' from, plus the X-ray trend that says whether a radio blackout is' +
        ' deepening or clearing. Off by default on bandwidth, like the aurora' +
        ' grid: switching it on is much the largest thing you can add to the' +
        ` recurring poll \u2014 two six-hour time series, about ` +
        `${formatBytes(GOES_FLUX_BYTES)} on each fetch of the interval below,` +
        ` against about ${formatBytes(bytesPerPoll())} for everything else on` +
        ` it. Hourly that is roughly ${formatBytes(GOES_FLUX_DAILY)} a day, on` +
        ` top of about ${formatBytes(REST_DAILY)} for the whole of the rest of` +
        ' the plugin. This only governs' +
        ' the recurring fetch \u2014 with it off, the webapp can still fetch' +
        ' the series once, when you ask it to.',
      default: false
    },
    goesFluxInterval: {
      type: 'number',
      title: 'GOES flux fetch interval',
      description:
        'in minutes, and only while the box above is ticked. Separate from' +
        ' the interval below, because this costs three times what the rest of' +
        ' that interval does: its own rate lets a boat that wants the reading' +
        ' pay less for it. NOAA republishes both series every minute or so,' +
        ' so any rate here is slower than the source; the paths declare a' +
        ' one-hour timeout, so a rate above 60 publishes readings Signal K' +
        ' itself marks stale.',
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
        ` together about ${formatBytes(bytesPerPoll())} per poll. The two` +
        ' expensive parts of what used' +
        ' to ride this interval \u2014 the GOES flux pair and D-RAP \u2014 have' +
        ' their own rates above.',
      default: 60
    }
  }
}
