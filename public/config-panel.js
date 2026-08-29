// Everything the plugin configuration panel decides, with no React and no DOM.
//
// Splitting it out is the same trade public/hero.js makes: the panel renders
// inside the admin UI, which needs a browser and a logged-in server, and none
// of the decisions below need either. remoteEntry.js is the rendering half.
//
// Some of what is here is a copy of a rule that lives in src/, on purpose: the
// panel is served as plain JavaScript out of public/ and cannot import from
// dist/. test/config-panel.test.ts pins each copy against the original over its
// whole input domain, so a divergence fails the build rather than shipping a
// panel that describes something the plugin does not do.

/**
 * What an absent key means, mirroring the `default` on each property of
 * `schema` in src/config.ts.
 *
 * The saved configuration is shown as-is with these filled in, which is what
 * the generated form did: migration of the superseded keys belongs to
 * `settingsFrom`, on the server, and stays there. `settingsDiffer` below is how
 * the panel finds out what it made of them.
 */
export const DEFAULTS = Object.freeze({
  sendAdvisoryOutlook: true,
  alarmLevel: 5,
  popupLevel: 4,
  auroraEnabled: false,
  auroraInterval: 120,
  drapEnabled: true,
  drapInterval: 60,
  goesFluxEnabled: false,
  goesFluxInterval: 60,
  updateInterval: 60
})

/** Mirrors `NoaaScaleNames` in src/parse.ts, less the zero entry. */
export const SCALE_NAMES = Object.freeze([
  null,
  'Minor',
  'Moderate',
  'Strong',
  'Severe',
  'Extreme'
])

/**
 * Every NOAA endpoint the plugin fetches, its measured wire size, and how often
 * a scheduled run asks for it. A copy of `ENDPOINTS` in src/endpoints.ts, which
 * is the source of truth; test/endpoints.test.ts pins the two together field
 * for field, so a re-measurement that lands in only one of them fails the
 * build. The panel is served as plain JavaScript out of public/ and cannot
 * import from dist/ -- the same trade as DEFAULTS above.
 *
 * The panel holds these rather than a handful of per-product totals because a
 * total is what went stale last time: the old figure outlived the product
 * that grew from one endpoint to three, and finding that out took a
 * re-measurement. Sizes are docs/noaa-products.md's payload table at the
 * precision it records. Re-measure with scripts/measure-noaa.mjs.
 */
export const ENDPOINTS = Object.freeze([
  {
    subPath: '/products/noaa-scales.json',
    wireBytes: 211,
    cadence: { follows: 'updateInterval' }
  },
  {
    subPath: '/json/goes/primary/xray-flares-latest.json',
    wireBytes: 452,
    cadence: { follows: 'updateInterval' }
  },
  {
    subPath: '/json/goes/primary/xray-flares-7-day.json',
    wireBytes: 3277,
    cadence: { follows: 'updateInterval' }
  },
  {
    subPath: '/products/noaa-planetary-k-index-forecast.json',
    wireBytes: 496,
    cadence: { follows: 'updateInterval' }
  },
  {
    subPath: '/text/27-day-outlook.txt',
    wireBytes: 442,
    cadence: { fetchesPerDay: 1 }
  },
  {
    subPath: '/products/summary/solar-wind-speed.json',
    wireBytes: 59,
    cadence: { follows: 'updateInterval' }
  },
  {
    subPath: '/products/summary/solar-wind-mag-field.json',
    wireBytes: 60,
    cadence: { follows: 'updateInterval' }
  },
  {
    subPath: '/json/f107_cm_flux.json',
    wireBytes: 1229,
    cadence: { fetchesPerDay: 6 }
  },
  {
    subPath: '/json/goes/primary/xrays-6-hour.json',
    wireBytes: 24986,
    cadence: { follows: 'goesFluxInterval' },
    requires: 'goesFluxEnabled'
  },
  {
    subPath: '/json/goes/primary/integral-protons-6-hour.json',
    wireBytes: 8090,
    cadence: { follows: 'goesFluxInterval' },
    requires: 'goesFluxEnabled'
  },
  {
    subPath: '/text/wwv.txt',
    wireBytes: 346,
    cadence: { fetchesPerDay: 8 }
  },
  {
    subPath: '/text/daily-solar-indices.txt',
    wireBytes: 845,
    cadence: { fetchesPerDay: 6 }
  },
  {
    subPath: '/json/ovation_aurora_latest.json',
    wireBytes: 147149,
    cadence: { follows: 'auroraInterval' },
    requires: 'auroraEnabled'
  },
  {
    subPath: '/text/drap_global_frequencies.txt',
    wireBytes: 2150,
    cadence: { follows: 'drapInterval' },
    requires: 'drapEnabled'
  },
  {
    subPath: '/text/advisory-outlook.txt',
    wireBytes: 768,
    // No `requires`: sendAdvisoryOutlook governs the notification, not
    // the fetch -- src/products/advisory.ts has no `enabled`, so the
    // bulletin is always part of the bill.
    cadence: { fetchesPerDay: 30 / 7 }
  },
  {
    subPath: '/products/alerts.json',
    wireBytes: 5427,
    cadence: { follows: 'updateInterval' }
  }
])

const MINUTES_PER_DAY = 24 * 60
/** Long enough to be worth quoting, short enough that every month has one. */
export const DAYS_PER_MONTH = 30

/**
 * A minute interval as the plugin will read it. Same rule as `minutes` in
 * src/config.ts, because a half-typed or cleared number field must cost what
 * the plugin will actually spend, not NaN and not zero.
 */
export function minutes(raw, fallback) {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Scheduled fetches of one endpoint in a day; mirrors `fetchesPerDay` in src/endpoints.ts. */
function endpointFetchesPerDay(endpoint, settings) {
  if (endpoint.requires && !settings[endpoint.requires]) return 0
  if (endpoint.cadence.fetchesPerDay !== undefined) {
    return endpoint.cadence.fetchesPerDay
  }
  const interval = endpoint.cadence.follows
  return MINUTES_PER_DAY / minutes(settings[interval], DEFAULTS[interval])
}

/**
 * Kilobytes a day, split the way the form's rows split it: what still follows
 * `updateInterval`, the three things with a rate of their own, and everything
 * on a fixed cadence. Every term is a declared endpoint times its own cadence,
 * so adding an endpoint prices it here with nothing else to remember -- which
 * is the difference between this and the per-product constants it replaced.
 */
export function dailyKb(settings) {
  const split = {
    aurora: 0,
    drap: 0,
    goesFlux: 0,
    other: 0,
    fixed: 0,
    total: 0
  }
  for (const endpoint of ENDPOINTS) {
    const kb =
      (endpointFetchesPerDay(endpoint, settings) * endpoint.wireBytes) / 1024
    const follows = endpoint.cadence.follows
    const key =
      follows === 'auroraInterval'
        ? 'aurora'
        : follows === 'drapInterval'
          ? 'drap'
          : follows === 'goesFluxInterval'
            ? 'goesFlux'
            : follows
              ? 'other'
              : 'fixed'
    split[key] += kb
    split.total += kb
  }
  return split
}

/**
 * Bytes at the scale a boat owner buys them in. Satellite airtime is sold by
 * the megabyte, so KB below a megabyte and GB above a thousand keeps every
 * figure comparable to a plan without arithmetic.
 */
export function formatKb(kb) {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(2)} GB`
  if (kb >= 1024) return `${(kb / 1024).toFixed(kb < 10 * 1024 ? 2 : 1)} MB`
  return `${Math.round(kb)} KB`
}

/** Mirrors `ALERT_FLOOR` in src/parse.ts. */
export const ALERT_FLOOR = 3

/**
 * Mirrors `stateForScaleValue` in src/parse.ts, which carries the argument for
 * why there are two thresholds rather than one anchor with derived rungs.
 */
export function stateForScaleValue(
  value,
  alarmLevel,
  popupLevel = alarmLevel - 1
) {
  if (value <= 0) return 'nominal'
  if (value >= alarmLevel) return 'alarm'
  if (value >= popupLevel) return 'warn'
  if (value >= Math.min(popupLevel - 1, ALERT_FLOOR)) return 'alert'
  return 'normal'
}

/** Mirrors `methodForState` in src/parse.ts. */
export function methodForState(state) {
  const method = []
  if (state === 'warn' || state === 'alarm' || state === 'emergency') {
    method.push('visual')
  }
  if (state === 'alarm' || state === 'emergency') method.push('sound')
  return method
}

/**
 * How often an event at each level *and above* happens, in words, from the
 * measured table in docs/noaa-products.md re-counted under NOAA's banding.
 * Both controls quote these, so they move together.
 *
 * Words rather than the day counts they came from. The counts are geomagnetic
 * storm days in a median year, and at that resolution Extreme rounds to zero --
 * a number that reads as "never" for the level the alarm defaults to. The
 * phrasing also carries the uncertainty the archive actually supports: "once or
 * twice a year" is honest where "3" is not. docs/noaa-products.md keeps the
 * figures, with the method that makes them mean something; regenerate them with
 * scripts/measure-kp.mjs.
 *
 * The G figures, because one cadence cannot label three scales; the panel says
 * so where it shows them.
 */
export const RATE = Object.freeze({
  1: 'most weeks',
  2: 'a couple of times a month',
  3: 'several times a year',
  4: 'once or twice a year',
  5: 'several times a decade'
})

/** Mirrors `ALARM_NEVER` in src/parse.ts. */
export const ALARM_NEVER = 6

/**
 * The choices offered for both thresholds, mirroring `levelOptions` in
 * src/config.ts. Quietest first, so reading down the list turns the plugin
 * up, which puts "Never" at the top. It carries no rate: it has no frequency.
 */
export const LEVEL_OPTIONS = Object.freeze([
  // ALARM_NEVER carries no rate: it does not happen at a frequency.
  { value: ALARM_NEVER },
  ...[5, 4, 3, 2, 1].map((value) => Object.freeze({ value, rate: RATE[value] }))
])

/** What a state does to a notification client, in the words a user would use. */
const EFFECT = Object.freeze({
  nominal: 'nothing',
  normal: 'recorded only',
  alert: 'listed, no popup, no sound',
  warn: 'pops up, no sound',
  alarm: 'pops up and sounds'
})

/**
 * One row per NOAA level, loudest first, for the two chosen thresholds. Loudest
 * first because the loudest threshold is the first thing set and the rest of
 * the ladder hangs below it.
 */
export function ladderFor(alarmLevel, popupLevel) {
  const rows = []
  for (let level = 5; level >= 1; level--) {
    const state = stateForScaleValue(level, alarmLevel, popupLevel)
    rows.push({
      level,
      name: SCALE_NAMES[level],
      state,
      method: methodForState(state),
      effect: EFFECT[state],
      // The same words the fallback dropdown uses, so a user who has seen one
      // control recognises the other. They carry their own uncertainty --
      // "once or twice", "several" -- which the measured day counts cannot: a
      // bare 3 claims a precision the Kp archive does not support, and at
      // Extreme the median year rounds to 0, which reads as "never" for the
      // one level this whole screen exists to get right.
      rate: RATE[level]
    })
  }
  return rows
}

/**
 * The two boundaries, loudest first, as the ladder draws them.
 *
 * A threshold names the level its band opens at, so its line rests on the
 * *bottom* edge of that level's row -- the band is everything above the line.
 * `ALARM_NEVER` puts it above the top row instead, where the band is empty:
 * "Never" is reached by running out of storms rather than by being a level.
 */
export const BOUNDARIES = Object.freeze([
  Object.freeze({ key: 'alarmLevel', kind: 'sound' }),
  Object.freeze({ key: 'popupLevel', kind: 'popup' })
])

/**
 * Where a boundary's line sits: the level whose row it rests under, or null
 * for the line above the whole ladder.
 */
export function lineUnder(level) {
  return level === ALARM_NEVER ? null : level
}

/**
 * What a grip says about itself. Both halves are literal -- neither borrows the
 * other's words -- so a screen reader hears the same thing the ladder shows.
 */
export function gripLabel(kind, level) {
  if (level === ALARM_NEVER)
    return kind === 'sound' ? 'never sounds' : 'never pops up'
  const verb = kind === 'sound' ? 'sounds' : 'pops up'
  return `${verb} from ${SCALE_NAMES[level]} (${level})`
}

/**
 * One threshold moved, with the other taken along if it has to be.
 *
 * Mirrors the clamp in `settingsFrom`, including its exemption: a popup of
 * `ALARM_NEVER` is quieter than every level rather than louder than the alarm,
 * so it neither drags the alarm up nor gets dragged down by it. Taking the
 * alarm along would silence a plugin the user had only asked to stop popping
 * up.
 */
export function withLevel(settings, key, value) {
  const next = { ...settings, [key]: value }
  if (next.popupLevel === ALARM_NEVER) return next
  if (key === 'alarmLevel') next.popupLevel = Math.min(next.popupLevel, value)
  else next.alarmLevel = Math.max(next.alarmLevel, value)
  return next
}

/** The quietest level either threshold offers. Neither range is clipped. */
export const MINOR = 1

/**
 * Where an arrow key puts a boundary, or null for a key the grip does not
 * claim -- which is what lets Tab and the rest reach the form around it.
 *
 * Up is quieter. The line rises, the band above it loses its bottom row, and
 * one more level stops interrupting. Home and End are the ends of the range the
 * grip reports through `aria-valuemin` and `aria-valuemax`, so the numbers a
 * screen reader announces and the keys that reach them agree.
 */
export function stepLevel(current, key) {
  if (key === 'ArrowUp' || key === 'ArrowRight')
    return Math.min(ALARM_NEVER, current + 1)
  if (key === 'ArrowDown' || key === 'ArrowLeft')
    return Math.max(MINOR, current - 1)
  if (key === 'Home') return MINOR
  if (key === 'End') return ALARM_NEVER
  return null
}

/**
 * The level whose edge a pointer is nearest, given each level's edge in the
 * same coordinates. Snapping to the nearest rather than the one under the
 * cursor is what lets a grip reach the line above the top row at all.
 */
export function nearestLevel(edges, y) {
  let best = null
  let bestGap = Infinity
  for (const [level, at] of Object.entries(edges)) {
    const gap = Math.abs(at - y)
    if (gap < bestGap) {
      bestGap = gap
      best = Number(level)
    }
  }
  return best
}

/**
 * The quiet rung in words, read back off the ladder rather than derived a
 * second time -- so the sentence cannot claim something the table under it
 * contradicts. `ALERT_FLOOR` puts levels here that neither threshold names,
 * which is exactly why it is worth saying out loud.
 */
export function quietRule(alarmLevel, popupLevel) {
  const listed = ladderFor(alarmLevel, popupLevel)
    .filter((row) => row.state === 'alert')
    .map((row) => `${SCALE_NAMES[row.level]} (${row.level})`)
    .reverse()
  if (listed.length === 0) return 'Nothing is listed quietly.'
  const verb = listed.length === 1 ? 'is' : 'are'
  return `${listed.join(', ')} ${verb} listed quietly — no popup, no sound.`
}

/**
 * The dropdown line for one choice. `ALARM_NEVER` is not a NOAA level and has
 * no name in `SCALE_NAMES`, so it reads as itself rather than as a severity --
 * the whole point is that it cannot be mistaken for "alarm at the top".
 *
 * It needs no explanation of what still happens, which is what the split into
 * two thresholds bought: the other dropdown says so, in its own words, on the
 * line above or below.
 */
export function levelOptionLabel(option) {
  if (option.value === ALARM_NEVER) return 'Never'
  const andAbove = option.value < 5 ? ' and above' : ''
  return `${SCALE_NAMES[option.value]} (${option.value})${andAbove} — ${option.rate}`
}

/**
 * A NOAA scale value is one of five integers; mirrors `scaleValue` in
 * src/config.ts so the panel cannot offer a level the plugin would discard.
 */
export function scaleValue(raw, fallback) {
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= ALARM_NEVER
    ? parsed
    : fallback
}

/**
 * The saved configuration as five values the panel can render, and as five
 * values `settingsFrom` will read back unchanged. Superseded keys are left
 * alone rather than translated here; `settingsDiffer` is where the panel finds
 * out what they turned into.
 */
/** Mirrors `popupBand` in src/config.ts. */
function popupBand(raw, alarmLevel) {
  const level = scaleValue(raw, Math.max(1, alarmLevel - 1))
  return level === ALARM_NEVER ? level : Math.min(level, alarmLevel)
}

/** The lower of two possibly-absent minute values. Mirrors `smaller` in src/config.ts. */
function smaller(a, b) {
  const values = [a, b].map(Number).filter((n) => Number.isFinite(n) && n > 0)
  return values.length > 0 ? Math.min(...values) : undefined
}

export function panelSettings(configuration) {
  const c = configuration ?? {}
  const alarmLevel = scaleValue(c.alarmLevel, DEFAULTS.alarmLevel)
  // Mirrors `settingsFrom`: a config saved before `updateInterval` existed
  // still carries `observationsInterval` / `notificationsInterval`, and the
  // smaller of the two is the cadence that install was actually polling at.
  // Resolved once so the field shown for it and the drapInterval fallback
  // below agree with each other and with the plugin.
  const updateInterval = minutes(
    c.updateInterval ??
      smaller(c.observationsInterval, c.notificationsInterval),
    DEFAULTS.updateInterval
  )
  return {
    sendAdvisoryOutlook: c.sendAdvisoryOutlook !== false,
    alarmLevel,
    // The same clamp `settingsFrom` applies, so the panel cannot show a popup
    // level the plugin would pull back down the moment it read it -- including
    // its exemption for ALARM_NEVER, which is the one value above the alarm
    // that the user meant. Clamping that one would redraw a chosen "Never" as
    // a level on reload.
    popupLevel: popupBand(c.popupLevel, alarmLevel),
    auroraEnabled: c.auroraEnabled === true,
    auroraInterval: minutes(c.auroraInterval, DEFAULTS.auroraInterval),
    drapEnabled: c.drapEnabled !== false,
    // Mirrors `settingsFrom`: absent falls back to the resolved
    // `updateInterval` above (what a pre-split config was actually fetching
    // D-RAP at), not straight to the 60-minute default -- an explicit but
    // invalid `drapInterval` still lands on 60, since it names its own
    // setting, wrong value and all.
    drapInterval:
      c.drapInterval === undefined
        ? updateInterval
        : minutes(c.drapInterval, DEFAULTS.drapInterval),
    goesFluxEnabled: c.goesFluxEnabled === true,
    // Same migration as `drapInterval` above, for the same reason.
    goesFluxInterval:
      c.goesFluxInterval === undefined
        ? updateInterval
        : minutes(c.goesFluxInterval, DEFAULTS.goesFluxInterval),
    updateInterval
  }
}

/**
 * Whether the running plugin disagrees with what the panel would show for a
 * saved configuration -- which happens exactly when a key it has never been
 * saved with is being supplied by `settingsFrom`, either as a default or as a
 * migration of a superseded key. Saying so is the difference between a screen
 * that describes this boat and one that describes a fresh install.
 *
 * `running` is null until the status route answers, and an unreachable server
 * must not manufacture a disagreement, so that case is "no".
 */
export function settingsDiffer(shown, running) {
  if (!running) return false
  return Object.keys(shown).some((key) => shown[key] !== running[key])
}

/**
 * A Signal K leaf is `{value, timestamp, $source, meta}`, and a path that has
 * only ever been described carries `meta` and no `value` at all -- a product
 * whose first fetch has not landed, or has been failing. Both read as absent.
 */
export function leafValue(node) {
  if (!node || typeof node !== 'object') return null
  return 'value' in node ? node.value : null
}

function finite(raw) {
  // `Number(null)` and `Number('')` are both 0, so an absent path would read as
  // "no activity" rather than as absent -- the exact confusion this whole
  // section exists to avoid.
  if (raw === null || raw === undefined || raw === '') return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Mirrors `kpFloorForG` in src/parse.ts: a G band opens a third below the Kp
 * it is named after, so G4 starts at 7.667 rather than 8.
 */
export const kpFloorForG = (g) => 5 + g - 1 - 1 / 3

/** Mirrors `gScaleForKp` in src/parse.ts. */
export function gScaleForKp(kp) {
  if (!Number.isFinite(kp)) return 0
  for (let g = 5; g >= 1; g--) {
    if (kp >= kpFloorForG(g)) return g
  }
  return 0
}

/**
 * G before R before S at equal levels, the same order and for the same reason
 * as `LETTER_ORDER` in public/hero.js: it is what the level costs a boat, not
 * NOAA's own order and not alphabetical.
 */
const LETTER_ORDER = ['G', 'R', 'S']

/**
 * What the sky is doing, from the two paths the plugin already publishes, in
 * the shape the panel needs to judge it against `alarmLevel`.
 *
 * Returns null when nothing has been published rather than a set of zeroes: on
 * this screen "quiet" and "the first fetch has not landed" are different
 * answers, and only one of them says the setting above is doing anything.
 */
export function currentConditions(scales, kp) {
  const levels = {}
  let worst = null
  for (const letter of LETTER_ORDER) {
    const level = finite(leafValue(scales?.[letter]))
    if (level === null) continue
    levels[letter] = level
    if (!worst || level > worst.level) worst = { letter, level }
  }

  const observedKp = finite(leafValue(kp?.observed))
  const forecastKp = finite(leafValue(kp?.forecast?.max24h))
  if (!worst && observedKp === null && forecastKp === null) return null

  return {
    levels,
    worst,
    observedKp,
    forecast:
      forecastKp === null
        ? null
        : { kp: forecastKp, level: gScaleForKp(forecastKp) }
  }
}

/**
 * What a level would do at the chosen thresholds -- the same three fields the
 * ladder shows, for one level rather than all five, so the row a boat is
 * actually sitting on can be named.
 */
export function verdictFor(level, alarmLevel, popupLevel) {
  const state = stateForScaleValue(level, alarmLevel, popupLevel)
  return { state, method: methodForState(state), effect: EFFECT[state] }
}
