// What the aurora tile is showing, and what a manual fetch did — decided
// separately from how either is worded, the same split hero.js makes for the
// banner. The copy lives in index.html; the decisions are here so they can be
// tested without a browser.

/**
 * What the tile has to say.
 *
 * `auroraEnabled` governs the recurring fetch only, not whether the grid can
 * ever be fetched (see the aurora-refresh route in src/index.ts), so "no value
 * yet" is two different situations for the reader: one that resolves itself on
 * the next interval, and one that resolves only when they press something.
 * Telling them apart is the difference between waiting and waiting forever.
 *
 * `running` is false when the status route answered nothing, which is what a
 * stopped or disabled plugin looks like from here. Without it the tile would
 * read the missing settings as "automatic updates are off" and tell the reader
 * to press a button that cannot work — a confident claim built on an answer
 * that never arrived.
 */
export function auroraCardState({ probability, scheduled, running = true }) {
  if (probability !== null && probability !== undefined) return 'value'
  if (!running) return 'stopped'
  return scheduled ? 'waiting' : 'idle'
}

/**
 * Which refusal a manual fetch hit.
 *
 * The route has four distinct ones and the actionable one -- wait n seconds --
 * is the one that matters most. Collapsing them all into "failed", which is
 * what the button used to say, hides exactly the one the user can do something
 * about.
 *
 * There is no "no position" refusal any more: the grid is global, so the fetch
 * no longer waits on a fix and the route no longer refuses for the want of
 * one.
 */
export function refreshFailure(err) {
  if (!err) return { kind: 'failed' }
  if (err.auth) return { kind: 'auth' }
  switch (err.status) {
    case 429: {
      const seconds = err.retryAfterSeconds
      return seconds
        ? { kind: 'cooldown', retryAfterSeconds: seconds }
        : { kind: 'cooldown' }
    }
    case 503:
      return { kind: 'stopped' }
    case 502:
      return { kind: 'upstream' }
    default:
      return { kind: 'failed' }
  }
}

/**
 * Seconds off a `Retry-After` header, or null if it does not carry one this
 * side can count down. The route always sends integer seconds; a proxy in
 * front of it may not send the header at all, and HTTP also allows a date
 * form, which is not worth parsing for a countdown that has a fallback.
 */
export function retryAfterSeconds(header) {
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null
}

/**
 * NOAA's own OVATION scale, sampled from the legend on their published
 * forecast image at 5% intervals, so this map, the chart-plotter overlay
 * (`NOAA_RAMP` in src/tiles.ts, the same table) and the aurora forecast
 * everyone else is looking at all agree. Spans the full 0-100%: green below
 * half, yellow at 50, amber at 70, red only above 90.
 *
 * `test/aurora-webapp.test.ts` pins this against the server's copy. It used
 * to live inline in index.html, where nothing could reach it to check.
 */
export const NOAA_AURORA_RAMP = [
  [116, 166, 117],
  [50, 196, 53],
  [23, 227, 16],
  [30, 232, 10],
  [37, 241, 6],
  [45, 247, 3],
  [61, 255, 0],
  [109, 255, 0],
  [156, 255, 2],
  [199, 255, 1],
  [248, 255, 1],
  [255, 238, 0],
  [254, 222, 0],
  [254, 201, 0],
  [255, 182, 0],
  [255, 163, 0],
  [255, 144, 2],
  [254, 113, 0],
  [250, 54, 0],
  [249, 2, 0],
  [228, 0, 0]
]

const AURORA_RAMP_STEP_PERCENT = 5

/** The ramp's colour at a probability, interpolated: `[r, g, b]`. */
export function auroraRampColor(percent) {
  const position =
    Math.max(0, Math.min(100, percent)) / AURORA_RAMP_STEP_PERCENT
  const seg = Math.min(NOAA_AURORA_RAMP.length - 2, Math.floor(position))
  const t = position - seg
  const a = NOAA_AURORA_RAMP[seg]
  const b = NOAA_AURORA_RAMP[seg + 1]
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ]
}

/**
 * One map cell: `[r, g, b, alpha]`, alpha 0..1.
 *
 * NOAA draws this ramp opaque over a dark globe; here it has an absorption
 * layer and a coastline to sit over, so alpha carries the low end. Faded in
 * across the first 2% rather than switched on at a threshold -- a hard cutoff
 * draws a crisp false edge around the oval, exactly the boundary a reader
 * would over-trust -- and rising with probability, so a 90% oval reads as the
 * solid thing it is.
 */
export function auroraCellColor(percent) {
  if (!(percent > 0)) return [0, 0, 0, 0]
  const [r, g, b] = auroraRampColor(percent)
  const alpha = Math.min(1, percent / 2) * (0.3 + 0.6 * (percent / 100))
  return [r, g, b, alpha]
}
