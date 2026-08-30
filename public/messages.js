// What NOAA is currently saying, in its own words, decided separately from
// how it is drawn -- the same split as hero.js and scales.js.
//
// The hero banner compresses a watch to one clause ("G2 predicted for Sat 30
// Aug"), which is the right size for a banner and throws away everything
// NOAA actually wrote: which condition, when it was issued, how long it runs,
// what the other days in the table say, and the message body itself. Nothing
// in the webapp read any of that -- the alerts subtree was published and
// drawn by nothing (issue #45's data, #34's gap).
//
// This is the stop-gap surface for it: a list, off a link in the hero. The
// designed in-force tile is still its own card on the board; the thing this
// has to beat is the page not showing the data at all.

/** The two states `stateForScaleValue` produces below the list threshold. */
const STOOD_DOWN = new Set(['normal', 'nominal'])

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How long a stood-down message stays on the list.
 *
 * The alerts subtree is not a history -- a withdrawn message is set back to
 * `normal` and kept, so what is available is "recently in force", bounded by
 * how long the plugin has been running rather than by anything NOAA says.
 * Two days is the span over which a watch, its warning and its summary are
 * one story; past that the list is claiming to be an archive it is not.
 */
export const RECENT_MS = 2 * DAY_MS

/**
 * NOAA's verbs, strongest claim about *now* first: an alert is a condition
 * observed, a warning is one expected within hours, a watch is one expected
 * days out, and a summary is one already over.
 */
const VERB_ORDER = ['ALERT', 'WARNING', 'WATCH', 'SUMMARY']

/**
 * The NOAA messages this page can show, newest first, in force before stood
 * down.
 *
 * `alerts` is the `notifications.noaa.swpc.alerts` subtree: one leaf per
 * message code. Everything here comes off the published value; nothing is
 * re-parsed, so the list cannot disagree with the notification the boat's
 * alarm panel got.
 */
export function messagesInForce(alerts, nowMs) {
  const rows = []
  for (const node of Object.values(alerts ?? {})) {
    const value = node?.value
    if (!value || typeof value !== 'object') continue
    if (!value.message && !value.description) continue

    const issuedAt = Date.parse(value.issued)
    const inForce = !STOOD_DOWN.has(value.state)
    if (!inForce) {
      // Aged by the leaf's own timestamp -- when the plugin observed the
      // withdrawal (standDown in products/alerts.ts republishes with a
      // fresh one) -- not by `value.issued`. A message issued long ago but
      // stood down five minutes ago is still fresh news; issued would drop
      // it on arrival. One that cannot be dated has not earned its place
      // either way, so it fails closed the same as an unreadable `issued`
      // did -- age Infinity, dropped, rather than sitting on the list for as
      // long as the plugin runs.
      const stoodDownAt = Date.parse(node?.timestamp)
      const age = Number.isFinite(stoodDownAt) ? nowMs - stoodDownAt : Infinity
      if (age > RECENT_MS) continue
    }

    rows.push({
      code: codeOf(value),
      verb: value.alertLevel || '',
      scale: value.scale || '',
      level: levelOf(value),
      headline: value.message || '',
      text: value.description || value.message || '',
      issued: Number.isFinite(issuedAt) ? value.issued : null,
      issuedAt: Number.isFinite(issuedAt) ? issuedAt : null,
      validUntil: value.validUntil ?? null,
      serialNumber: value.serialNumber ?? null,
      inForce,
      // Empty for everything but a watch, and the whole reason a watch is
      // worth opening: the days are the only forward-looking dates NOAA
      // publishes.
      days: predictedDays(value, nowMs)
    })
  }

  // In force first, then NOAA's verb, then newest. A stood-down message
  // issued after one still running is still the older news -- what happened
  // last is not the same question as what is true now, and the list answers
  // the second.
  rows.sort(
    (a, b) =>
      Number(b.inForce) - Number(a.inForce) ||
      verbRank(a.verb) - verbRank(b.verb) ||
      (b.issuedAt ?? 0) - (a.issuedAt ?? 0)
  )
  return rows
}

/**
 * A watch's per-day table, each day marked as past or still ahead.
 *
 * "Ahead" runs to the end of the day, not its start, for the same reason
 * `watchAhead` in hero.js does: NOAA's table has day granularity, so a G2
 * predicted for today is still a prediction at 0600 on that day.
 */
function predictedDays(value, nowMs) {
  if (!Array.isArray(value.predictedByDay)) return []
  return value.predictedByDay.map((day) => {
    const at = Date.parse(day?.date)
    return {
      date: day?.date ?? null,
      letter: day?.letter ?? 'G',
      level: Number.isFinite(day?.level) ? day.level : 0,
      ahead: Number.isFinite(at) ? at + DAY_MS > nowMs : false
    }
  })
}

/** `noaa_swpc_alert_WATA30` back to `WATA30`; the id is what carries it. */
function codeOf(value) {
  const id = typeof value.id === 'string' ? value.id : ''
  const tail = id.split('_').pop()
  return tail || ''
}

/**
 * The severity to colour the row by: the scale the message names, not its
 * notification state. `G2 - Moderate` is a G2 whether or not this install's
 * thresholds make it audible, and the list is describing NOAA's claim.
 */
function levelOf(value) {
  const digits = String(value.scale ?? '').match(/[GSR]([0-5])/)
  if (digits) return parseInt(digits[1], 10)
  // A watch with no scale line still names its worst day.
  if (Array.isArray(value.predictedByDay)) {
    const worst = value.predictedByDay.reduce(
      (max, day) =>
        Number.isFinite(day?.level) ? Math.max(max, day.level) : max,
      0
    )
    if (worst > 0) return worst
  }
  return null
}

function verbRank(verb) {
  const at = VERB_ORDER.indexOf(String(verb).toUpperCase())
  return at === -1 ? VERB_ORDER.length : at
}

/**
 * The hero's link text: how many messages there are, and whether any of them
 * is still in force. A bare count reads as a badge for something new, and a
 * count with no verb on the end does not read as a link at all.
 */
export function messagesSummary(rows) {
  const live = rows.filter((row) => row.inForce).length
  if (live === 1) return '1 NOAA message in force — read it'
  if (live > 1) return `${live} NOAA messages in force — read them`
  if (rows.length > 0) return 'Recent NOAA messages — read them'
  return null
}

/** The overlay's own heading, which must not claim a message is in force. */
export function messagesTitle(rows) {
  return rows.some((row) => row.inForce)
    ? 'Messages in force'
    : 'Recent messages'
}
