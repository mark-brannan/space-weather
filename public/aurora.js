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
 * The route has five distinct ones and at least two of them are actionable —
 * wait n seconds, wait for a GPS fix. Collapsing them all into "failed", which
 * is what the button used to say, hides exactly the ones the user can do
 * something about.
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
    case 409:
      return { kind: 'no-position' }
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
