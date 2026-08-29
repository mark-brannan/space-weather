/**
 * Pure, I/O-free parsing and transformation of NOAA SWPC payloads.
 *
 * Nothing in this module performs network access or touches the Signal K
 * `app` object, so every function here is directly testable against the
 * captured payloads in `examples/`. `index.ts` owns all I/O.
 */

export const NotificationStates = Object.freeze({
  NOMINAL: 'nominal',
  NORMAL: 'normal',
  ALERT: 'alert',
  WARN: 'warn',
  ALARM: 'alarm',
  EMERGENCY: 'emergency'
})

// https://www.spaceweather.gov/noaa-scales-explanation
export const NoaaScaleValues = Object.freeze({
  NONE: 0,
  MINOR: 1,
  MODERATE: 2,
  STRONG: 3,
  SEVERE: 4,
  EXTREME: 5
})

/**
 * A threshold one past the top of the scale, which is how "never" is expressed
 * for either of them: `stateForScaleValue` compares against it unchanged, so no
 * value reaches that band and the quieter ones still land. On `alarmLevel` it
 * removes the sound; on `popupLevel` it removes the popup. Silencing the plugin
 * by clamping everything to `normal` would have hidden a G5 outright.
 *
 * It is deliberately not a sixth NOAA level. Nothing publishes it, no zone
 * carries it, and `NoaaScaleNames` is not indexed by it.
 */
export const ALARM_NEVER = 6

/**
 * The level from which an event is always at least listed, whatever the two
 * thresholds are set to.
 *
 * A G3 is a real storm -- several a year, not several a day -- so there is no
 * setting at which one should leave no trace at all. Turning the plugin down is
 * a decision about being interrupted, and `alert` interrupts nobody:
 * `methodForState` gives it an empty method array, so it appears in the
 * notification list and does nothing else. Quietest is not the same as absent.
 */
export const ALERT_FLOOR = NoaaScaleValues.STRONG

// Index by scale value 0-5.
export const NoaaScaleNames = Object.freeze([
  'none',
  'Minor',
  'Moderate',
  'Strong',
  'Severe',
  'Extreme'
])

export const MAX_NOAA_SCALE = 5

// G is defined directly in terms of Kp: G1 = the Kp 5 band ... G5 = the Kp 9
// band. Those name bands, not integers; `kpFloorForG` says where one opens.
export const KP_FOR_G1 = 5

/**
 * The lowest Kp inside NOAA's G_n band.
 *
 * Kp is reported in thirds, and NOAA's `G4 = Kp 8` names the whole 8 band --
 * 8-, 8o, 8+ -- which opens a third below the integer, at 7.667. Banding on
 * the integer instead put every boundary a third of a step high, so a Kp of 8-
 * read as G3 here while NOAA's own page called the same storm G4 (issue #63).
 *
 * An exact third rather than the 7.667 NOAA prints: the same value reaches us
 * spelled 7.67 in the JSON products and 7.667 in the GFZ archive, and a floor
 * rounded to either precision excludes a spelling that lands just under it.
 */
export function kpFloorForG(g: number): number {
  return KP_FOR_G1 + g - 1 - 1 / 3
}

export type AlarmState =
  (typeof NotificationStates)[keyof typeof NotificationStates]

export interface Zone {
  lower?: number
  upper?: number
  state: AlarmState
  message: string
}

export interface ValueUpdate {
  path: string
  value: any
}

/**
 * Map a NOAA scale value (0-5) to a Signal K alarm state.
 *
 * Two thresholds, each naming the level its band opens at: `alarmLevel` sounds,
 * `popupLevel` shows a popup without sounding. Both are boundaries, which is
 * the point of there being two of them — a single anchor with the quieter rungs
 * derived from it cannot be described by any honest label, because whatever the
 * setting claims, the level below it is doing something too (issue #71).
 *
 * `popupLevel` defaults to one below the alarm, which is the ladder this
 * function had when it took one argument, so a call site that has not been told
 * about the second threshold keeps its old behaviour.
 *
 * Below the popup band, `ALERT_FLOOR` and the level immediately under the popup
 * are both listed. The second of those is what keeps the bands adjacent when a
 * user sets the popup below the floor: the quiet rung follows the popup down
 * rather than leaving a gap of `normal` between them.
 *
 * Turning either number down is monotonically louder, and every value of either
 * is live — no setting silences the level it names. That was not true of the
 * arrangement this replaced twice over: deriving *upward* from a "worth your
 * attention" pivot ran off the end of a five-level scale, so a pivot of 4 could
 * never reach `alarm` and one of 5 could not even reach `warn`, making the two
 * loudest-sounding choices the two that silenced the plugin.
 *
 * Where the defaults sit is an argument about how often each level happens
 * rather than about this function; the settings dropdowns carry those rates.
 */
export function stateForScaleValue(
  value: number,
  alarmLevel: number = NoaaScaleValues.EXTREME,
  popupLevel: number = alarmLevel - 1
): AlarmState {
  if (value <= 0) return NotificationStates.NOMINAL
  if (value >= alarmLevel) return NotificationStates.ALARM
  if (value >= popupLevel) return NotificationStates.WARN
  if (value >= Math.min(popupLevel - 1, ALERT_FLOOR))
    return NotificationStates.ALERT
  return NotificationStates.NORMAL
}

/**
 * Signal K zones for a NOAA scale path (values 0-5).
 *
 * The server's zone matcher tests `value >= lower && value < upper`
 * (signalk-server src/zones.ts), so a discrete level n is the half-open
 * interval [n, n+1) and the top zone must extend past 5 or an Extreme event
 * falls outside every zone and produces no notification at all.
 */
export function zonesForScale(
  letter: string,
  alarmLevel: number = NoaaScaleValues.EXTREME,
  popupLevel: number = alarmLevel - 1
): Zone[] {
  const zones: Zone[] = []
  for (let value = 0; value <= MAX_NOAA_SCALE; value++) {
    zones.push({
      lower: value,
      upper: value + 1,
      state: stateForScaleValue(value, alarmLevel, popupLevel),
      message:
        value === 0
          ? `No ${letter} activity`
          : `${letter}${value} (${NoaaScaleNames[value]})`
    })
  }
  return zones
}

/**
 * Signal K zones for a planetary K-index path (Kp 0-9), expressed through the
 * same G-scale severity mapping. Kp is a real number reported in thirds (e.g.
 * 5.67), so the boundaries are `kpFloorForG` rather than unit-wide buckets and
 * do not come out round.
 */
export function zonesForKp(
  alarmLevel: number = NoaaScaleValues.EXTREME,
  popupLevel: number = alarmLevel - 1
): Zone[] {
  const zones: Zone[] = [
    {
      lower: 0,
      upper: kpFloorForG(1),
      state: NotificationStates.NOMINAL,
      message: 'Kp below storm level'
    }
  ]
  for (let g = 1; g <= MAX_NOAA_SCALE; g++) {
    const zone: Zone = {
      lower: kpFloorForG(g),
      state: stateForScaleValue(g, alarmLevel, popupLevel),
      // The Kp quoted is the band NOAA names the level after, not the floor.
      message: `G${g} (${NoaaScaleNames[g]}) -- Kp ${KP_FOR_G1 + g - 1}`
    }
    // The top band deliberately carries no `upper` key. Kp saturates at 9 and
    // the server's matcher is exclusive on `upper`, so Kp exactly 9 needs
    // headroom -- but Infinity is not representable in JSON and would reach the
    // server as null, which does not trigger the `upper = Infinity`
    // destructuring default and would leave G5 matching no zone at all.
    // Omitting the key serialises it away entirely, so the default applies.
    if (g < MAX_NOAA_SCALE) {
      zone.upper = kpFloorForG(g + 1)
    }
    zones.push(zone)
  }
  return zones
}

/**
 * Kp to G scale value: the highest band whose floor the value reached, and
 * G0 (no storm) below G1's. Asking `kpFloorForG` rather than rounding keeps
 * this and `zonesForKp` agreeing by construction, so a Kp published as G4
 * cannot land in the G3 zone.
 */
export function gScaleForKp(kp: number): number {
  if (!Number.isFinite(kp)) return NoaaScaleValues.NONE
  for (let g = MAX_NOAA_SCALE; g >= 1; g--) {
    if (kp >= kpFloorForG(g)) return g
  }
  return NoaaScaleValues.NONE
}

/**
 * The one place that decides whether a notification state interrupts the user:
 * nothing at or below `alert` does, `warn` is visual, and `alarm`/`emergency`
 * are visual and audible.
 *
 * `zoneMethods` below hands this policy to the server's zone watcher, and the
 * notifications this plugin raises itself go through it directly. Both have to
 * agree: a product that attaches visual+sound of its own accord is how a
 * month-old "flux exceeded" summary ends up sounding an alarm (issue #45).
 *
 * State is the only input, deliberately. Severity already says how loud a thing
 * should be, and a user who wants a quieter plugin has `alarmLevel`, which
 * moves the whole ladder. A per-method mute would cut across every
 * product at once — a preference about the notification client rather than
 * about space weather.
 */
export function methodForState(state: AlarmState): string[] {
  const method: string[] = []
  if (
    state === NotificationStates.WARN ||
    state === NotificationStates.ALARM ||
    state === NotificationStates.EMERGENCY
  ) {
    method.push('visual')
  }
  if (
    state === NotificationStates.ALARM ||
    state === NotificationStates.EMERGENCY
  ) {
    method.push('sound')
  }
  return method
}

/**
 * Notification method fields for a metadata object. These sit alongside
 * `zones` and let a zone carry a state without necessarily interrupting the
 * user: levels at or just above the alert threshold are informational
 * (empty method), and only the top bands get visual/sound.
 */
export function zoneMethods() {
  return {
    nominalMethod: methodForState(NotificationStates.NOMINAL),
    normalMethod: methodForState(NotificationStates.NORMAL),
    alertMethod: methodForState(NotificationStates.ALERT),
    warnMethod: methodForState(NotificationStates.WARN),
    alarmMethod: methodForState(NotificationStates.ALARM),
    emergencyMethod: methodForState(NotificationStates.EMERGENCY)
  }
}

/**
 * Parse a UTC date/time in the one format every NOAA product uses for them:
 *   2025 Apr 08 1230 UTC
 * Returns null rather than throwing when the text is absent or malformed.
 */
export function parseNoaaDateTime(text: string | null): Date | null {
  if (!text) return null
  const dateTimeRegex = /([0-9]{4} [A-Za-z]{3,9} [0-9]{1,2}) ([0-9]{2,4} UTC)/
  const parts = text.match(dateTimeRegex)
  if (!parts) return null
  const datePortion = parts[1]
  const timePortion = parts[2].padStart(8, '0')
  const newTimeString =
    timePortion.slice(0, 2) + ':' + timePortion.slice(2, 4) + ' UTC'
  const parsed = new Date(datePortion + ' ' + newTimeString)
  return isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Parse a UTC date/time from NOAA text-product lines such as:
 *   :Issued: 2025 Apr 08 1230 UTC
 * Returns null rather than throwing when the line is absent or malformed.
 */
export function parseIssueDate(text: string): Date | null {
  const issuedLine = text.match(/\n:Issued: ([^\n]*)/)
  return issuedLine ? parseNoaaDateTime(issuedLine[1]) : null
}

/** The value of a `Label: ...` line in an alerts.json message body. */
function labelledLine(message: string, label: string): string | null {
  const match = message.match(new RegExp(`\\n${label}: *([^\\n]*)`))
  return match ? match[1] : null
}

export interface AdvisoryOutlook {
  idLine: string
  shortId: string
  issued: Date
  /** First sentence of the "Outlook For ..." section, for a one-line teaser. */
  outlookTeaser: string | null
}

/**
 * Parse the weekly advisory outlook text product.
 * https://services.swpc.noaa.gov/text/advisory-outlook.txt
 */
export function parseAdvisoryOutlook(text: string): AdvisoryOutlook | null {
  // Fixtures (and NOAA's own output) can carry CRLF line endings depending
  // on how they were checked out or fetched; match on \n alone below.
  const normalized = text.replace(/\r\n/g, '\n')
  const match = normalized.match(
    /\n(SPACE WEATHER ADVISORY OUTLOOK ([^\n]*))\n([^\n]*)\n/
  )
  if (!match) return null
  const issued = parseIssueDate(text)
  if (!issued) return null

  // NOAA always breaks the outlook into single-sentence-per-line paragraphs;
  // the first line after the header is the teaser.
  const teaserMatch = normalized.match(/\nOutlook For [^\n]*\n\n([^\n]+)/)
  const outlookTeaser = teaserMatch ? teaserMatch[1].trim() : null

  return { idLine: match[1], shortId: match[2].trim(), issued, outlookTeaser }
}

/** Message codes are documented at http://www.spaceweather.org/ISES/code/fmt/exam.html */
export function getAlertLevel(messageCode: string): string {
  if (messageCode.match(/ALT/)) return 'ALERT'
  if (messageCode.match(/WAR/)) return 'WARNING'
  if (messageCode.match(/WAT/)) return 'WATCH'
  if (messageCode.match(/SUM/)) return 'SUMMARY'
  return 'ALERT'
}

export interface ParsedAlert {
  serialNumber: string
  messageCode: string
  alertLevel: string
  mainMessage: string
  scaleText: string
  scaleValue: number | null
  state: AlarmState
  issued: Date
  /**
   * When the message stops describing the present, where NOAA says so.
   * Null for the ones that don't (see `alertValidUntil`), leaving the caller
   * to bound them by age instead.
   */
  validUntil: Date | null
  /** A `CANCEL ALERT`/`CANCEL WARNING` retraction of an earlier serial. */
  cancelled: boolean
  /** A watch's per-day forecast table; empty for every other message. */
  predictedByDay: PredictedDay[]
}

/**
 * How long a NOAA message describes the present, according to the message.
 *
 * Warnings and watches carry an explicit end, restated as "Now Valid Until"
 * each time NOAA extends one. A summary reports an event that has already
 * finished, so its "End Time" is the moment it stopped being news. Plain
 * alerts state neither — they are a threshold crossing at an instant — and
 * return null here.
 */
function alertValidUntil(message: string): Date | null {
  for (const label of ['Now Valid Until', 'Valid To', 'End Time']) {
    const parsed = parseNoaaDateTime(labelledLine(message, label))
    if (parsed) return parsed
  }
  return null
}

export interface PredictedDay {
  /** Start of the predicted UTC day, ISO 8601. */
  date: string
  /** `G`, `S` or `R`; the scale the watch names. */
  letter: string
  /** 0 for NOAA's "None (Below G1)". */
  level: number
}

/**
 * Parse a watch's "Highest Storm Level Predicted by Day" table.
 *
 * This is the only thing NOAA publishes that says a CME is in transit and
 * when it is expected to arrive. Nothing else in this plugin's inputs knows:
 * the Kp forecast series is a model run that has not yet moved, so a webapp
 * reading only that says "quiet" for the two days between the watch being
 * issued and the storm arriving (the case that prompted this).
 *
 * NOAA writes the days as `Aug 02` with no year, always within a few days of
 * the issue time, so the year comes from the issue date and is nudged by one
 * when that lands the day half a year away -- which is what a table spanning
 * New Year looks like.
 */
export function parseWatchDays(message: string, issued: Date): PredictedDay[] {
  // NOAA mixes CRLF and LF inside one message, so the line break is not a
  // reliable `\n` -- 2025's fixtures carry `\r\n` here and 2026's do not.
  const table = message.match(
    /Highest Storm Level Predicted by Day: *\r?\n([^\r\n]*)/
  )
  if (!table) return []

  const days: PredictedDay[] = []
  // `Jul 31:  None (Below G1)   Aug 02:  G2 (Moderate)`, all on one line.
  const entry = /([A-Za-z]{3}) ([0-9]{1,2}): +(?:([GSR])([0-5])|None)/g
  let match: RegExpExecArray | null
  while ((match = entry.exec(table[1])) !== null) {
    const [, month, day, letter, level] = match
    const date = watchDayDate(month, day, issued)
    if (!date) continue
    days.push({
      date: date.toISOString(),
      // A "None (Below G1)" cell names no scale, and every watch that carries
      // this table is geomagnetic -- the `Below G1` is NOAA saying so.
      letter: letter ?? 'G',
      level: level ? parseInt(level, 10) : 0
    })
  }
  return days
}

const HALF_YEAR_MS = 182 * 24 * 60 * 60 * 1000

function watchDayDate(month: string, day: string, issued: Date): Date | null {
  const year = issued.getUTCFullYear()
  const parsed = new Date(`${year} ${month} ${day} 00:00 UTC`)
  if (isNaN(parsed.getTime())) return null
  const drift = parsed.getTime() - issued.getTime()
  if (drift > HALF_YEAR_MS) parsed.setUTCFullYear(year - 1)
  else if (drift < -HALF_YEAR_MS) parsed.setUTCFullYear(year + 1)
  return parsed
}

/**
 * Parse one entry of https://services.swpc.noaa.gov/products/alerts.json
 *
 * Returns null when the payload can't be understood, so the caller can skip it
 * rather than the whole batch dying on one malformed message.
 */
export function parseAlert(
  alert: any,
  alarmLevel: number = NoaaScaleValues.EXTREME,
  popupLevel: number = alarmLevel - 1
): ParsedAlert | null {
  if (!alert || typeof alert.message !== 'string') return null

  const serial = alert.message.match(/Serial Number: ([0-9]+)/)
  const code = alert.message.match(/Space Weather Message Code: ([A-Z0-9]+)/)
  if (!serial || !code) return null

  const issued = new Date(alert.issue_datetime + 'Z')
  if (isNaN(issued.getTime())) return null

  // The headline is the 5th line and may start with 'WARNING:',
  // 'EXTENDED WARNING:', 'CONTINUED ALERT:', 'SUMMARY:', etc.
  const headline = alert.message.match(
    /([^\n]*\n)([^\n]*\n)([^\n]*\n)([^\n]*\n)([A-Z ]*:[^\n]*)/
  )

  // The scale line is optional and takes several forms:
  //   NOAA Scale: R2 - Moderate
  //   Predicted NOAA Scale: S1 - Minor
  //   NOAA Scale: G3 or greater - Strong to Extreme
  let scaleText = ''
  let scaleValue: number | null = null
  // `[^-]*` must not run past the end of the line: "G3 or greater - Strong to
  // Extreme" has no hyphen before the newline in some messages, so an
  // unrestricted match swallowed the trailing boilerplate paragraph into the
  // scale text.
  const scaleLine = alert.message.match(
    /\n([^[\n]*NOAA Scale: *([GSR][0-9][^-\n]*)[^\n]*)/
  )
  if (scaleLine) {
    scaleText = scaleLine[2].trim()
    // The stated digit, including for "G3 or greater": that is a floor NOAA is
    // asserting, not a ceiling it is predicting. Reading it as 5 inverts the
    // ladder, since a hedged forecast then outranks an observed G4. The hedge
    // stays visible in `scaleText` either way.
    const digits = scaleText.match(/[GSR]([0-5])/)
    scaleValue = digits ? parseInt(digits[1], 10) : null
  }

  const mainMessage = headline ? headline[5] : alert.message.split('\n')[0]
  const cancelled = /^ *CANCEL\b/.test(mainMessage)

  return {
    serialNumber: serial[1],
    messageCode: code[1],
    alertLevel: getAlertLevel(code[1]),
    mainMessage,
    scaleText,
    scaleValue,
    // A retraction of an earlier message is never itself a live condition, so
    // it resolves to `normal` and clears the path the message it cancels was
    // published on. Everything else runs through the same severity ladder the
    // scale and Kp zones use, so a given NOAA level reads the same whichever
    // way it reaches the user.
    state:
      cancelled || scaleValue === null
        ? NotificationStates.NORMAL
        : stateForScaleValue(scaleValue, alarmLevel, popupLevel),
    issued,
    validUntil: alertValidUntil(alert.message),
    cancelled,
    predictedByDay: parseWatchDays(alert.message, issued)
  }
}

/**
 * Hard ceiling on simultaneously raised alert notifications, whatever NOAA
 * sends. Grouping by message code already bounds this to the ~40 documented
 * codes, and no captured payload comes close (docs/noaa-products.md counts
 * them) — but a payload change that made the code capture vary would silently
 * reintroduce the unbounded path count of issue #45, and this is a plugin
 * inside somebody's navigation server.
 */
export const MAX_ALERT_NOTIFICATIONS = 25

/** Loudest first, so `MAX_ALERT_NOTIFICATIONS` drops the least important. */
const STATE_SEVERITY: string[] = [
  NotificationStates.NOMINAL,
  NotificationStates.NORMAL,
  NotificationStates.ALERT,
  NotificationStates.WARN,
  NotificationStates.ALARM,
  NotificationStates.EMERGENCY
]

export interface AlertNotification {
  /** NOAA message code, e.g. `WARK05`. The leaf of the Signal K path. */
  code: string
  serialNumber: string
  alertLevel: string
  mainMessage: string
  scaleText: string
  state: AlarmState
  method: string[]
  issued: Date
  validUntil: Date | null
  /** The full NOAA message body. */
  description: string
  /** A watch's per-day forecast table; empty for every other message. */
  predictedByDay: PredictedDay[]
}

/**
 * How long a NOAA message that states no expiry of its own stays in force.
 *
 * Fixed rather than configurable: nobody can answer "how many hours should an
 * alert with no stated expiry keep counting as current?" better than the value
 * matching how NOAA issues them, and getting it wrong is invisible in both
 * directions — too low drops live conditions, too high rebuilds issue #45 one
 * poll at a time. Messages that *do* state an expiry ignore this entirely,
 * which is most of the ones a boat cares about.
 */
export const ALERT_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * A watch's own fallback expiry: the end of the last day its forecast table
 * names, never earlier than {@link ALERT_MAX_AGE_MS}.
 *
 * A `WATA` watch never carries "Now Valid Until" (checked against every
 * captured fixture), so without this every one fell back to
 * {@link ALERT_MAX_AGE_MS} — but the table it does carry runs 36 to 69 hours
 * past issue in those same fixtures, so the flat 24-hour fallback dropped a
 * CME watch as no-longer-in-force a day or more before the storm it predicted
 * was due to arrive.
 */
function watchFallbackExpiry(alert: ParsedAlert, maxAgeMs: number): Date {
  const floor = alert.issued.getTime() + maxAgeMs
  const latestDay = alert.predictedByDay.reduce(
    (latest, day) => Math.max(latest, Date.parse(day.date)),
    -Infinity
  )
  if (!Number.isFinite(latestDay)) return new Date(floor)
  return new Date(Math.max(floor, latestDay + 24 * 60 * 60 * 1000))
}

export interface AlertSelectionOptions {
  now: Date
  /** Overrides {@link ALERT_MAX_AGE_MS}; tests only. */
  maxAgeMs?: number
  alarmLevel?: number
  popupLevel?: number
  limit?: number
}

export interface AlertSelection {
  /** In force at `now`, at most one per message code, loudest first. */
  inForce: AlertNotification[]
  unparseable: number
  /** In-force messages discarded by `limit`. Zero in every real payload. */
  dropped: number
}

/**
 * Reduce a whole `/products/alerts.json` payload to the notifications that
 * describe the present.
 *
 * The payload is a rolling ~30-day archive of a couple of hundred messages,
 * and until 0.12.0 this plugin raised a notification for each one, on a path
 * keyed by NOAA's serial number. That was wrong twice
 * over. Most of those messages describe events that ended weeks ago, and NOAA
 * mints a fresh serial every time it extends or continues a condition, so one
 * ongoing K-index warning became 19 separate permanent notification paths in a
 * month. See issue #45: a Pi5 was unusable inside ten minutes.
 *
 * So: drop anything no longer in force, and key the path on the message code
 * instead. A code names one condition, which is what a notification is for —
 * extensions, continuations and cancellations of that condition then update
 * the path in place rather than accumulating beside it, and the path count is
 * bounded by NOAA's code list for the life of the server.
 */
export function currentAlertNotifications(
  payload: any[],
  options: AlertSelectionOptions
): AlertSelection {
  const {
    now,
    maxAgeMs = ALERT_MAX_AGE_MS,
    alarmLevel = NoaaScaleValues.EXTREME,
    popupLevel = alarmLevel - 1,
    limit = MAX_ALERT_NOTIFICATIONS
  } = options

  const newest = new Map<string, AlertNotification>()
  let unparseable = 0

  for (const entry of payload) {
    const parsed = parseAlert(entry, alarmLevel, popupLevel)
    if (!parsed) {
      unparseable++
      continue
    }

    const expiresAt = parsed.validUntil ?? watchFallbackExpiry(parsed, maxAgeMs)
    if (expiresAt.getTime() <= now.getTime()) continue

    const candidate: AlertNotification = {
      code: parsed.messageCode,
      serialNumber: parsed.serialNumber,
      alertLevel: parsed.alertLevel,
      mainMessage: parsed.mainMessage.trim(),
      scaleText: parsed.scaleText,
      state: parsed.state,
      method: methodForState(parsed.state),
      issued: parsed.issued,
      validUntil: parsed.validUntil,
      description: entry.message,
      predictedByDay: parsed.predictedByDay
    }

    const held = newest.get(candidate.code)
    if (!held || supersedes(candidate, held))
      newest.set(candidate.code, candidate)
  }

  const held = [...newest.values()]
  const ordered = held
    .filter((alert) => !downgraded(alert, held))
    .sort(
      (a, b) =>
        STATE_SEVERITY.indexOf(b.state) - STATE_SEVERITY.indexOf(a.state) ||
        b.issued.getTime() - a.issued.getTime()
    )

  return {
    inForce: ordered.slice(0, limit),
    unparseable,
    dropped: Math.max(0, ordered.length - limit)
  }
}

/**
 * Later issue time wins. Serial numbers break a tie because NOAA stamps
 * `issue_datetime` to the millisecond but a reissue can share it, and the
 * serial is monotonic per code.
 */
function supersedes(
  candidate: AlertNotification,
  held: AlertNotification
): boolean {
  const byTime = candidate.issued.getTime() - held.issued.getTime()
  if (byTime !== 0) return byTime > 0
  return Number(candidate.serialNumber) > Number(held.serialNumber)
}

/**
 * The message code prefixes whose trailing number is a severity level.
 *
 * An allow-list, not a pattern, because the pattern is wrong. A shared prefix
 * and a trailing digit look like a ladder and mostly are not: `ALTTP2` and
 * `ALTTP4` are Type II and Type IV radio bursts, two unrelated emissions, and
 * treating the 4 as "higher" than the 2 stood a live Type IV burst down when
 * an unrelated Type II arrived 45 seconds later in
 * `alerts.2026_08_01.json`. Only these three are levels of one phenomenon:
 * K-index observations, K-index warnings, and geomagnetic storm watches.
 *
 * Adding a family here is a claim about what NOAA means by the number, so make
 * it one family at a time against a fixture. An unlisted code keeps the
 * behaviour it had before this rule existed, which is the safe direction.
 */
const SEVERITY_LADDERS = ['ALTK', 'WARK', 'WATA']

/**
 * Split a message code into the ladder it belongs to and its rung, e.g.
 * `ALTK07` -> `ALTK` at 7. Anything outside {@link SEVERITY_LADDERS}, and any
 * code with no numeric suffix, is on no ladder and returns null.
 */
function ladderRung(code: string): { family: string; level: number } | null {
  const match = /^(.*?)(\d+)$/.exec(code)
  if (!match || !SEVERITY_LADDERS.includes(match[1])) return null
  return { family: match[1], level: Number(match[2]) }
}

/**
 * Whether a later, lower message on the same ladder has overtaken this one.
 *
 * NOAA cancels a condition when it ends, and the observed-value zones follow a
 * storm down on their own, but neither covers a *downgrade*: an `ALTK07`
 * carries no "Valid To" at all, so it rides {@link ALERT_MAX_AGE_MS} for a
 * full day while the next synoptic period is already reporting `ALTK05`. Over
 * the three fixtures that is one episode per storm — 0 polls in April 2025,
 * 5.5 hours in the 16 April storm, 22 hours over 4-5 July 2026 — each one a G3
 * or G4 notification still raised after NOAA said the storm had eased.
 *
 * Dropping it here is enough: `clearWithdrawn` in the alerts product returns
 * any code that leaves the in-force set to `normal`.
 *
 * Sound on each of {@link SEVERITY_LADDERS} for its own reason. K-index
 * synoptic periods are disjoint three-hour windows, so the newest `ALTK` *is*
 * the current state; a later `WARK` at a lower threshold is a revised
 * forecast; and a `WATA` watch says in its own text that it supersedes all
 * prior watches. Ties on issue time keep the louder message, which is the safe
 * direction.
 */
function downgraded(
  alert: AlertNotification,
  all: AlertNotification[]
): boolean {
  const rung = ladderRung(alert.code)
  if (!rung) return false

  return all.some((other) => {
    const otherRung = ladderRung(other.code)
    return (
      otherRung !== null &&
      otherRung.family === rung.family &&
      otherRung.level < rung.level &&
      other.issued.getTime() > alert.issued.getTime()
    )
  })
}

/**
 * Transform one range entry of
 * https://services.swpc.noaa.gov/products/noaa-scales.json
 *
 * The three scales are not symmetric, and observations differ from forecasts:
 *
 *   observations (keys "-1" and "0"): G, S and R each carry Scale (0-5) + Text
 *   forecasts   (keys "1", "2", "3"): G carries a predicted Scale + Text;
 *                                     S carries only Prob (chance of S1+);
 *                                     R carries only MinorProb (R1-R2) and
 *                                     MajorProb (R3+), with no Scale at all.
 *
 * Probabilities arrive as percent strings ("75") and are emitted as Signal K
 * ratios (0.75) on their own leaf paths rather than as nested object values, so
 * ordinary consumers can subscribe to them.
 */
export function transformJsonScaleRange(
  json: any,
  basePath: string,
  isObservation: boolean
): ValueUpdate[] {
  const valueUpdates: ValueUpdate[] = []

  valueUpdates.push({
    path: basePath + '.time',
    value: json['DateStamp'] + 'T' + json['TimeStamp'] + 'Z'
  })

  for (const key of ['G', 'S', 'R']) {
    const entry = json[key]
    if (!entry) continue

    if (key === 'G' || isObservation) {
      valueUpdates.push({
        path: basePath + '.' + key,
        value: parseIntOrNull(entry['Scale'])
      })
    } else if (key === 'S') {
      valueUpdates.push({
        path: basePath + '.S.probability',
        value: percentToRatio(entry['Prob'])
      })
    } else {
      valueUpdates.push({
        path: basePath + '.R.minorProbability',
        value: percentToRatio(entry['MinorProb'])
      })
      valueUpdates.push({
        path: basePath + '.R.majorProbability',
        value: percentToRatio(entry['MajorProb'])
      })
    }
  }
  return valueUpdates
}

function parseIntOrNull(raw: any): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const parsed = parseInt(String(raw), 10)
  return isNaN(parsed) ? null : parsed
}

/** NOAA gives whole percents as strings; Signal K wants a 0-1 ratio. */
export function percentToRatio(raw: any): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const parsed = parseFloat(String(raw))
  return isNaN(parsed) ? null : parsed / 100
}

export interface XrayFlare {
  flareClass: string
  time: string
}

/**
 * The first complete JSON array or object in `text`, or null.
 *
 * NOAA rewrites these files in place roughly once a minute, and a read that
 * lands mid-write can return the new content followed by the tail of the old,
 * longer content. `JSON.parse` rejects the whole thing ("Unexpected
 * non-whitespace character after JSON at position N") and a reading is lost --
 * observed on `xray-flares-latest.json`, which then left the plugin publishing
 * metadata for a path whose value never arrived.
 *
 * A complete leading value means its closing bracket was written, so it is the
 * new content in full rather than a guess at it: a truncated write fails to
 * close and returns null here instead. Only the outer bracket type is counted,
 * which is sound because a brace cannot close a bracket.
 */
export function firstJsonValue(text: string): string | null {
  const start = text.search(/\S/)
  if (start < 0) return null
  const open = text[start]
  if (open !== '[' && open !== '{') return null
  const close = open === '[' ? ']' : '}'

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === open) depth++
    else if (char === close && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

/**
 * GOES X-ray flare classification ("B3.3", "M2.1", "X1.4") for the most
 * recent event, at that event's own peak.
 *
 * `max_class`/`max_time`, deliberately not `current_class`/`time_tag`: issue
 * #122 measured the latter as the *background* flux at poll time, which is a
 * different quantity wearing the same label. Live on 2026-08-25 the plugin
 * published B9.6 on a day whose latest flare peaked at C4.7, under a heading
 * that reads as the flare which caused the blackout.
 *
 * `current_class` remains the fallback, and only that: an event still in
 * progress carries no `end_time` but does carry a running `max_class`, so the
 * fallback fires when NOAA moves the field rather than while a flare is rising.
 * A single-element array is the documented shape; tolerate an empty one (no
 * event ever recorded) rather than throwing.
 */
export function parseXrayFlare(json: any): XrayFlare | null {
  const entry = Array.isArray(json) ? json[0] : null
  if (!entry) return null
  const peak = flareRecord(entry)
  if (peak) return peak
  const flareClass = flareClassOf(entry.current_class)
  if (flareClass === null) return null
  if (typeof entry.time_tag !== 'string' || !entry.time_tag) return null
  return { flareClass, time: entry.time_tag }
}

/** One record's peak, or null when either half of the pair is unusable. */
function flareRecord(entry: any): XrayFlare | null {
  const flareClass = flareClassOf(entry?.max_class)
  if (flareClass === null) return null
  if (typeof entry.max_time !== 'string' || !entry.max_time) return null
  return { flareClass, time: entry.max_time }
}

/**
 * The flare class if the field is one, else null -- the boundary check on the
 * only NOAA field this plugin publishes as a free string rather than a number.
 * Every other value on these paths is parsed into a number, so `class` is the
 * one that reaches a consumer's DOM as whatever NOAA sent; validating it here
 * covers Freeboard and Grafana too, where escaping in `public/index.html`
 * would only have covered this plugin's own page.
 *
 * Reuses `fluxForFlareClass` rather than repeating its regex: "is a class" and
 * "abbreviates a flux we can rank on" are the same question, and a second
 * pattern would be free to drift from the one the ranking uses.
 */
export function flareClassOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return fluxForFlareClass(trimmed) === null ? null : trimmed
}

/**
 * Watts per square metre for a GOES flare class, so two classes can be
 * compared as the measurement they abbreviate rather than as strings -- "M9.9"
 * sorts above "X1.0" alphabetically and is a tenth of it in flux.
 *
 * The letter is a decade and the number a multiplier within it, which is the
 * same definition the R-scale table in docs/hf-operator-view.md is built on.
 * Returns null for anything that is not a class, including the empty string.
 * Takes `unknown` rather than `string` -- it normalises with `String(...)`
 * below regardless, so the wider signature is what it already tolerates at
 * runtime, and lets a caller (or a test) pass a NOAA payload's raw field
 * straight through without a cast.
 */
export function fluxForFlareClass(flareClass: unknown): number | null {
  const match = /^([ABCMX])\s*([0-9]+(?:\.[0-9]+)?)?$/i.exec(
    String(flareClass ?? '').trim()
  )
  if (!match) return null
  const decade: Record<string, number> = {
    A: 1e-8,
    B: 1e-7,
    C: 1e-6,
    M: 1e-5,
    X: 1e-4
  }
  // NOAA writes a bare letter for the decade boundary ("M" is M1.0).
  const multiplier = match[2] === undefined ? 1 : Number(match[2])
  if (!Number.isFinite(multiplier)) return null
  return decade[match[1].toUpperCase()] * multiplier
}

/**
 * The strongest flare to peak in the `windowHours` before `now`, from
 * https://services.swpc.noaa.gov/json/goes/primary/xray-flares-7-day.json
 *
 * The companion to `parseXrayFlare` and the reason #122 needed two values
 * rather than one: the latest flare answers "is anything happening", and this
 * answers "what did today do" -- the same question NOAA's own 24-hour maximum
 * on the R scale answers, at the resolution an operator reads conditions in.
 *
 * Ranked on `max_xrlong` where NOAA sends it and on the class it abbreviates
 * where it does not, so a payload that drops the numeric field still ranks
 * correctly instead of silently picking the last record. Returns null when no
 * flare peaked inside the window -- a real and ordinary answer at solar
 * minimum, and not the same as having no data.
 */
export function parseXrayFlarePeak(
  json: any,
  now: Date,
  windowHours = 24
): XrayFlare | null {
  if (!Array.isArray(json)) return null
  const since = now.getTime() - windowHours * 60 * 60 * 1000
  let best: XrayFlare | null = null
  let bestFlux = -Infinity
  for (const entry of json) {
    const peak = flareRecord(entry)
    if (!peak) continue
    const peaked = Date.parse(peak.time)
    if (!Number.isFinite(peaked) || peaked < since || peaked > now.getTime())
      continue
    const flux =
      firstNumber(entry, ['max_xrlong']) ?? fluxForFlareClass(peak.flareClass)
    if (flux === null) continue
    if (flux > bestFlux) {
      bestFlux = flux
      best = peak
    }
  }
  return best
}

export interface F107Flux {
  flux: number
  time: string
}

/**
 * https://services.swpc.noaa.gov/json/f107_cm_flux.json
 *
 * Three readings a day (Morning/Noon/Afternoon); only "Noon" is the
 * traditionally-quoted daily figure (it's also the only one carrying a
 * ninety-day mean, which this doesn't currently surface). Doesn't trust the
 * array's own order for "latest" -- picks the Noon entry with the newest
 * time_tag instead, the same defensive stance aurora's grid lookup takes.
 */
export function parseF107(json: any): F107Flux | null {
  if (!Array.isArray(json)) return null
  let latest: F107Flux | null = null
  for (const entry of json) {
    if (entry?.reporting_schedule !== 'Noon') continue
    const flux = Number(entry.flux)
    const time = entry.time_tag
    if (!Number.isFinite(flux) || typeof time !== 'string' || !time) continue
    if (!latest || time > latest.time) latest = { flux, time }
  }
  return latest
}

export interface KpSeriesPoint {
  time: string
  kp: number
  /** True once `time` is after the `now` the summary was computed against. */
  forecast: boolean
}

export interface KpSummary {
  observed: number | null
  observedTime: string | null
  max24h: number | null
  max72h: number | null
  maxNoaaScale: number | null
  nextStormTime: string | null
  nextStormKp: number | null
  /**
   * The 3-hourly points from 24h in the past to 72h ahead, for drawing a
   * timeline. The full feed already has to be parsed to compute the summary
   * above -- this is that same data, not a second fetch -- bounded to the
   * window the summary fields already describe rather than sending the whole
   * ~7-day feed.
   */
  series: KpSeriesPoint[]
}

/**
 * Summarise https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json
 *
 * The feed is ~81 rows of 3-hourly Kp spanning roughly -7 to +3 days, each
 * tagged observed / estimated / predicted. That is eight times the resolution
 * of the single G value per forecast day in noaa-scales.json, and unlike that
 * feed it says *when* -- which is the actionable part of a geomagnetic storm
 * forecast.
 *
 * `now` is injectable so the windows are testable against captured payloads.
 */
export function parseKpForecast(json: any, now: Date = new Date()): KpSummary {
  const empty: KpSummary = {
    observed: null,
    observedTime: null,
    max24h: null,
    max72h: null,
    maxNoaaScale: null,
    nextStormTime: null,
    nextStormKp: null,
    series: []
  }
  const rows = kpRows(json)

  if (rows.length === 0) return empty

  const nowMs = now.getTime()
  // NOAA marks the whole current UTC day `estimated`, so a row can be in the
  // past and still be a forecast. Splitting on the mark rather than on time is
  // what keeps a predicted storm out of the observed path -- it published a
  // G2 while NOAA's own site showed the measured Kp at G0.
  const observed = rows.filter(
    (row) => row.observed && row.at.getTime() <= nowMs
  )
  // Everything not yet measured: the rows still ahead, plus the in-progress
  // 3-hour bin, whose forecast is timestamped in the past.
  const forecast = rows.filter(
    (row) => row.at.getTime() > nowMs || !row.observed
  )

  const latest = observed.length > 0 ? observed[observed.length - 1] : null
  const within = (hours: number) =>
    forecast.filter((row) => row.at.getTime() <= nowMs + hours * 3600 * 1000)

  const maxKp = (subset: typeof rows) =>
    subset.length > 0 ? Math.max(...subset.map((row) => row.kp)) : null

  const max24h = maxKp(within(24))
  const max72h = maxKp(within(72))
  // The in-progress 3-hour bin counts: a storm already underway is still the
  // onset the user needs to see, and it is at most three hours old.
  const nextStorm =
    forecast.find((row) => row.kp >= kpFloorForG(NoaaScaleValues.MINOR)) ?? null

  const seriesStart = nowMs - 24 * 3600 * 1000
  const seriesEnd = nowMs + 72 * 3600 * 1000
  const series: KpSeriesPoint[] = rows
    .filter(
      (row) => row.at.getTime() >= seriesStart && row.at.getTime() <= seriesEnd
    )
    .map((row) => ({
      time: row.at.toISOString(),
      kp: row.kp,
      forecast: !row.observed
    }))

  return {
    observed: latest ? latest.kp : null,
    observedTime: latest ? latest.at.toISOString() : null,
    max24h,
    max72h,
    maxNoaaScale: max72h === null ? null : gScaleForKp(max72h),
    nextStormTime: nextStorm ? nextStorm.at.toISOString() : null,
    nextStormKp: nextStorm ? nextStorm.kp : null,
    series
  }
}

interface KpRow {
  at: Date
  kp: number
  /**
   * False for NOAA's `estimated` and `predicted` rows. The feed carries
   * forecast rows for the whole current UTC day, so several of them are
   * already in the past at any given moment -- time alone does not say
   * whether a row was measured.
   */
  observed: boolean
}

/**
 * Normalise the Kp forecast payload to sorted, well-typed rows.
 *
 * NOAA serves this product in two shapes and has switched between them. The
 * older form is a table with a header row and space-separated timestamps:
 *
 *   [["time_tag","kp","observed","noaa_scale"],
 *    ["2025-04-03 00:00:00","3.67","observed",null], ...]
 *
 * the current form is a list of records with ISO-style timestamps:
 *
 *   [{"time_tag":"2026-07-25T00:00:00","kp":1.00,"observed":"observed"}, ...]
 *
 * Either is accepted. Rows that cannot be understood are dropped rather than
 * poisoning the summary.
 */
function kpRows(json: any): KpRow[] {
  if (!Array.isArray(json) || json.length === 0) return []

  let records: any[]
  if (Array.isArray(json[0])) {
    const header: string[] = json[0].map((h: any) => String(h))
    records = json.slice(1).map((row: any[]) => {
      const record: any = {}
      header.forEach((key, index) => {
        record[key] = row[index]
      })
      return record
    })
  } else {
    records = json
  }

  return records
    .map((record: any) => ({
      at: parseUtcTimestamp(record?.time_tag),
      // The tabular form quotes its numbers; `Kp` appears on the observed-only
      // product rather than the forecast, but costs nothing to accept.
      kp: Number(record?.kp ?? record?.Kp),
      // A payload carrying no such column is all measurement -- that is the
      // shape of the observed-only product.
      observed:
        record?.observed === undefined || record?.observed === null
          ? true
          : String(record.observed).trim().toLowerCase() === 'observed'
    }))
    .filter(
      (row): row is KpRow =>
        row.at !== null && !isNaN(row.at.getTime()) && Number.isFinite(row.kp)
    )
    .sort((a, b) => a.at.getTime() - b.at.getTime())
}

/**
 * NOAA timestamps in these products carry no zone designator but are UTC, and
 * appear as both "2026-07-25T00:00:00" and "2025-04-03 00:00:00".
 */
function parseUtcTimestamp(raw: any): Date | null {
  if (typeof raw !== 'string' || raw === '') return null
  const normalised = raw.trim().replace(' ', 'T')
  const parsed = new Date(
    /(Z|[+-]\d{2}:?\d{2})$/.test(normalised) ? normalised : normalised + 'Z'
  )
  return isNaN(parsed.getTime()) ? null : parsed
}

export interface Outlook27Day {
  /** Start of the UTC day the row describes, as an ISO instant. */
  time: string
  /** `null` where the column was outside `OUTLOOK_RANGES`; never NaN. */
  f107: number | null
  aIndex: number | null
  /** The *largest* Kp expected that day, not a daily mean. */
  kp: number | null
}

export interface Outlook27 {
  issued: Date | null
  days: Outlook27Day[]
  maxKp: number | null
  maxKpTime: string | null
  maxNoaaScale: number | null
  nextStormTime: string | null
  nextStormKp: number | null
  /**
   * How many columns across the whole table were rejected as implausible. The
   * product logs it, so a dropped value is not invisible.
   */
  rejected: number
}

/**
 * Parse https://services.swpc.noaa.gov/text/27-day-outlook.txt
 *
 * One row per UTC day for a full solar rotation: Radio Flux 10.7cm, Planetary
 * A Index, and the largest Kp expected that day. See the outlook27 product for
 * what that horizon is worth and why nothing here raises a notification.
 */
export function parse27DayOutlook(text: string): Outlook27 | null {
  const days: Outlook27Day[] = []
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const row = outlookRow(line)
    if (row) days.push(row)
  }
  if (days.length === 0) return null

  days.sort((a, b) => (a.time < b.time ? -1 : 1))
  // A rejected Kp column must not be read as a quiet day, so the peak and the
  // first storm are taken over the days that still carry one.
  const rated = days.filter(
    (day): day is Outlook27Day & { kp: number } => day.kp !== null
  )
  // First day attaining the peak, not the last: for planning, the question is
  // when the disturbed stretch starts.
  const peak = rated.length
    ? rated.reduce((best, day) => (day.kp > best.kp ? day : best))
    : null
  const nextStorm =
    rated.find((day) => day.kp >= kpFloorForG(NoaaScaleValues.MINOR)) ?? null

  return {
    issued: parseIssueDate(text),
    days,
    maxKp: peak ? peak.kp : null,
    maxKpTime: peak ? peak.time : null,
    maxNoaaScale: peak ? gScaleForKp(peak.kp) : null,
    nextStormTime: nextStorm ? nextStorm.time : null,
    nextStormKp: nextStorm ? nextStorm.kp : null,
    rejected: days.reduce(
      (count, day) =>
        count +
        (day.f107 === null ? 1 : 0) +
        (day.aIndex === null ? 1 : 0) +
        (day.kp === null ? 1 : 0),
      0
    )
  }
}

/**
 * What each outlook column can physically be.
 *
 * NOAA reissued the 2026-08-24 outlook fifteen hours later to replace a radio
 * flux of 1151 for Sep 01 with 120; both payloads are in `examples/`. Only
 * `Number.isFinite` stood between that and `...outlook27.series`, and a
 * corrupt Kp column would likewise reach `gScaleForKp`, which has no upper
 * bound, and publish a G level nothing in the sky supports.
 *
 * Kp and the A index are bounded by definition, so their limits need no
 * re-measuring. F10.7 has no comparable bound in either direction: a weaker
 * quiet sun than any on record is possible on the low end, and a flare can
 * put a *raw* flux reading in the hundreds of thousands to millions of sfu
 * on the high end (the 2006 X4 flare read roughly 1,000,000) -- 1151 was
 * NOAA's own forecast error, not proof the column has a low ceiling. F10.7's
 * range is therefore 0 (a flux can't be negative) to a value picked only to
 * stop a garbage token from reading as a real number on the chart, not to
 * express any physical limit:
 *
 * - The planetary A index is a daily mean of ap, and ap saturates at 400 at
 *   Kp 9, so 400 is definitional rather than empirical.
 * - Kp is a 0-9 scale by definition.
 */
const OUTLOOK_RANGES = {
  f107: { min: 0, max: 1e8 },
  aIndex: { min: 0, max: 400 },
  kp: { min: 0, max: 9 }
}

/** The value, or `null` if it is outside the range -- never NaN. */
function inRange(value: number, range: { min: number; max: number }) {
  return Number.isFinite(value) && value >= range.min && value <= range.max
    ? value
    : null
}

/**
 * One data row of the outlook table, or null for anything else in the file.
 *
 * Tokenised rather than matched as a whole line, so a fourth column or a
 * change of spacing does not silently empty the table -- both of this
 * plugin's other long-lived parsers have had to absorb a NOAA shape change.
 * The ISO date form is accepted for the same reason; NOAA writes
 * `2026 Aug 10` today.
 *
 * An implausible column is nulled on its own rather than taking the row with
 * it: the day still has a date, and its other two columns are still the best
 * answer available for it. A row whose every column was rejected carries
 * nothing and is dropped.
 */
function outlookRow(line: string): Outlook27Day | null {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(':')) {
    return null
  }

  const tokens = trimmed.split(/\s+/)
  const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(tokens[0])
  const dateTokens = isoDate ? 1 : 3
  if (tokens.length < dateTokens + 3) return null

  const [rawF107, rawAIndex, rawKp] = tokens
    .slice(dateTokens, dateTokens + 3)
    .map(Number)
  const f107 = inRange(rawF107, OUTLOOK_RANGES.f107)
  const aIndex = inRange(rawAIndex, OUTLOOK_RANGES.aIndex)
  const kp = inRange(rawKp, OUTLOOK_RANGES.kp)
  if (f107 === null && aIndex === null && kp === null) return null

  const at = new Date(
    isoDate
      ? tokens[0] + 'T00:00:00Z'
      : tokens.slice(0, 3).join(' ') + ' 00:00 UTC'
  )
  if (isNaN(at.getTime())) return null

  return { time: at.toISOString(), f107, aIndex, kp }
}

export interface SolarWind {
  speed: number | null
  bt: number | null
  bz: number | null
  timestamp: string | null
}

/**
 * Normalise the solar wind summary payloads to SI.
 *
 * NOAA changed the shape of these two products after this plugin was first
 * written. They used to be objects:
 *
 *   {"WindSpeed": 400, "TimeStamp": "..."}   {"Bt": 5, "Bz": -3, "TimeStamp": "..."}
 *
 * and are now single-element arrays with snake_case keys:
 *
 *   [{"proton_speed": 287, "time_tag": "..."}]
 *   [{"bt": 4, "bz_gsm": -1, "time_tag": "..."}]
 *
 * Both shapes are accepted so the plugin keeps working whichever is served.
 * Speed is km/s in the source and Signal K wants m/s; Bt and Bz are nT and
 * Signal K wants Tesla.
 */
export function parseSolarWind(speedJson: any, magJson: any): SolarWind {
  const speedRow = firstRecord(speedJson)
  const magRow = firstRecord(magJson)

  const speedKmPerSecond = firstNumber(speedRow, ['proton_speed', 'WindSpeed'])
  const bt = firstNumber(magRow, ['bt', 'Bt'])
  const bz = firstNumber(magRow, ['bz_gsm', 'bz', 'Bz'])
  const timestamp =
    firstString(magRow, ['time_tag', 'TimeStamp']) ??
    firstString(speedRow, ['time_tag', 'TimeStamp'])

  return {
    speed: speedKmPerSecond === null ? null : speedKmPerSecond * 1000,
    bt: bt === null ? null : bt * 1e-9,
    bz: bz === null ? null : bz * 1e-9,
    timestamp
  }
}

function firstRecord(json: any): any {
  if (Array.isArray(json)) return json.length > 0 ? json[0] : null
  return json ?? null
}

function firstNumber(record: any, keys: string[]): number | null {
  if (!record) return null
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      const parsed = Number(record[key])
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function firstString(record: any, keys: string[]): string | null {
  if (!record) return null
  for (const key of keys) {
    if (typeof record[key] === 'string' && record[key] !== '')
      return record[key]
  }
  return null
}

// ---------------------------------------------------------------------------
// Aurora (NOAA OVATION model)
// https://services.swpc.noaa.gov/json/ovation_aurora_latest.json
// ---------------------------------------------------------------------------

/** Longitudes 0..359 and latitudes -90..90 inclusive: a 360 x 181 grid. */
const AURORA_LAT_STEPS = 181
const AURORA_LON_STEPS = 360

export interface AuroraForecast {
  observationTime: string | null
  forecastTime: string | null
  coordinates: number[][]
}

export function parseAuroraPayload(json: any): AuroraForecast | null {
  if (
    !json ||
    !Array.isArray(json.coordinates) ||
    json.coordinates.length === 0
  ) {
    return null
  }
  return {
    observationTime: asIsoString(json['Observation Time']),
    forecastTime: asIsoString(json['Forecast Time']),
    coordinates: json.coordinates
  }
}

function asIsoString(raw: any): string | null {
  if (typeof raw !== 'string' || raw === '') return null
  const parsed = new Date(raw)
  return isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/**
 * Read one grid cell.
 *
 * NOAA documents the array as longitude-major with latitude ascending from
 * -90, which makes the offset computable and the lookup O(1) over 65,160
 * entries. The layout is verified per read rather than trusted: if the entry
 * at the computed offset is not the cell we asked for, fall back to a scan.
 * NOAA has changed payload shapes on this plugin twice, and a silently wrong
 * index would be far worse than a slow one.
 */
function auroraCell(
  coordinates: number[][],
  lon: number,
  lat: number
): number | null {
  const index = lon * AURORA_LAT_STEPS + (lat + 90)
  const entry = coordinates[index]
  if (Array.isArray(entry) && entry[0] === lon && entry[1] === lat) {
    return Number.isFinite(entry[2]) ? entry[2] : null
  }
  for (const candidate of coordinates) {
    if (
      Array.isArray(candidate) &&
      candidate[0] === lon &&
      candidate[1] === lat
    ) {
      return Number.isFinite(candidate[2]) ? candidate[2] : null
    }
  }
  return null
}

/**
 * Aurora probability at a position, as a 0-1 ratio.
 *
 * Bilinear interpolation across the four surrounding cells rather than
 * nearest-neighbour: the grid is a coarse 1 degree — about 60 nautical miles
 * of latitude — and the auroral oval's edge is exactly where a boat cares
 * about the answer. Nearest-neighbour would make the value jump by whole
 * percent steps as the vessel moves, which reads as instrument noise.
 *
 * Longitude wraps at the 0/360 seam; latitude clamps at the poles.
 * Returns null rather than NaN for any input it cannot resolve.
 */
export function auroraProbabilityAt(
  forecast: AuroraForecast | null,
  latitude: number,
  longitude: number
): number | null {
  if (!forecast || !Array.isArray(forecast.coordinates)) return null
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null

  const lat = Math.min(90, Math.max(-90, latitude))
  // Signal K longitude is -180..180; the grid is 0..359.
  const lon =
    ((longitude % AURORA_LON_STEPS) + AURORA_LON_STEPS) % AURORA_LON_STEPS

  const lat0 = Math.floor(lat)
  const lat1 = Math.min(lat0 + 1, 90)
  const lon0 = Math.floor(lon) % AURORA_LON_STEPS
  const lon1 = (lon0 + 1) % AURORA_LON_STEPS
  const fy = lat - lat0
  const fx = lon - Math.floor(lon)

  const corners = [
    auroraCell(forecast.coordinates, lon0, lat0),
    auroraCell(forecast.coordinates, lon1, lat0),
    auroraCell(forecast.coordinates, lon0, lat1),
    auroraCell(forecast.coordinates, lon1, lat1)
  ]
  if (corners.some((value) => value === null)) return null
  const [v00, v10, v01, v11] = corners as number[]

  const lower = v00 + (v10 - v00) * fx
  const upper = v01 + (v11 - v01) * fx
  const percent = lower + (upper - lower) * fy

  return Math.min(100, Math.max(0, percent)) / 100
}

/**
 * Zones for aurora probability (a 0-1 ratio).
 *
 * The top band is `warn` purely so a dashboard can make it stand out; nothing
 * here reaches `alarm`. See the aurora product for why.
 */
export function zonesForAurora(): Zone[] {
  return [
    {
      lower: 0,
      upper: 0.1,
      state: NotificationStates.NOMINAL,
      message: 'Aurora unlikely'
    },
    {
      lower: 0.1,
      upper: 0.3,
      state: NotificationStates.NORMAL,
      message: 'Aurora possible'
    },
    {
      lower: 0.3,
      upper: 0.5,
      state: NotificationStates.ALERT,
      message: 'Aurora likely'
    },
    // No `upper`, for the reason given on zonesForKp's top band.
    {
      lower: 0.5,
      state: NotificationStates.WARN,
      message: 'Aurora very likely'
    }
  ]
}

/**
 * Marine SSB band lower edges, in Hz, ITU Appendix 17 order.
 *
 * The strip the webapp draws and the zone ladder below are the same list read
 * two ways, so a band added here appears in both. Lower edges rather than
 * centres or upper edges: D-RAP publishes the highest frequency degraded by
 * >=1 dB, so everything below the cutoff is affected, and the first frequency
 * of a band is the first one the cutoff reaches.
 */
export const MARINE_SSB_BAND_EDGES_HZ = [
  2_045_000, 4_000_000, 6_200_000, 8_100_000, 12_230_000, 16_360_000,
  18_780_000, 22_000_000, 25_070_000
]

/**
 * Zones for the D-RAP highest affected frequency.
 *
 * The published value is a *frequency*, not a severity: "9.9 MHz absorbed" is
 * the end of the working day for someone on 8 MHz and nothing at all to
 * someone on 22, so the severity depends on the reader's band rather than on
 * the number. The ladder therefore buckets by which marine SSB bands fall
 * under the cutoff, which is the only reading of the number that is the same
 * for every reader.
 *
 * And it stays quiet. `alert` carries an empty method array (`methodForState`),
 * so the top bands are listed and never sound or pop -- being informative
 * about a band the operator may not be using is not grounds to interrupt them,
 * and a cutoff that wanders across a boundary through the day would interrupt
 * them repeatedly. That is #45's failure mode with a different number in it.
 */
export function zonesForDrap(): Zone[] {
  const [, , , eightMHz, , , , twentyTwoMHz] = MARINE_SSB_BAND_EDGES_HZ
  return [
    {
      lower: 0,
      upper: MARINE_SSB_BAND_EDGES_HZ[0],
      state: NotificationStates.NOMINAL,
      message: 'No marine HF band absorbed'
    },
    {
      lower: MARINE_SSB_BAND_EDGES_HZ[0],
      upper: eightMHz,
      state: NotificationStates.NORMAL,
      message: 'Marine bands below 8 MHz absorbed'
    },
    {
      lower: eightMHz,
      upper: twentyTwoMHz,
      state: NotificationStates.ALERT,
      message: 'Marine bands below 22 MHz absorbed'
    },
    // No `upper`, for the reason given on zonesForKp's top band.
    {
      lower: twentyTwoMHz,
      state: NotificationStates.ALERT,
      message: 'All marine SSB bands absorbed'
    }
  ]
}

/**
 * The solar flux bands every operator quotes, in sfu.
 *
 * Convention, not derivation: docs/hf-operator-view.md records that no
 * published mapping exists and that these were adopted deliberately as the
 * numbers the panels everyone reads use. The provenance is the point, and it
 * is why the webapp labels them rather than presenting them as measured.
 *
 * The ladder runs the other way from every other one in this plugin -- high
 * F10.7 is *good* -- so it tops out at `nominal` and bottoms out at `normal`,
 * and no band reaches `alert`. A naive "higher = worse" ladder would put the
 * whole of solar minimum into `alert` and leave it there for years, describing
 * a condition nobody can act on and nothing will change, which is #45 again in
 * slow motion.
 */
export function zonesForF107(): Zone[] {
  return [
    {
      lower: 0,
      upper: 70,
      state: NotificationStates.NORMAL,
      message: 'High bands essentially closed'
    },
    {
      lower: 70,
      upper: 90,
      state: NotificationStates.NORMAL,
      message: 'Poor HF conditions'
    },
    {
      lower: 90,
      upper: 120,
      state: NotificationStates.NORMAL,
      message: 'Fair HF conditions'
    },
    {
      lower: 120,
      upper: 150,
      state: NotificationStates.NOMINAL,
      message: 'Good HF conditions'
    },
    // No `upper`, for the reason given on zonesForKp's top band.
    {
      lower: 150,
      state: NotificationStates.NOMINAL,
      message: 'Excellent HF conditions'
    }
  ]
}

export interface GeophysicalAlert {
  /** The UTC day the indices in the bulletin describe, as an ISO instant. */
  day: string
  /** Estimated planetary A index: the linearised daily summary of K. */
  aIndex: number
}

/**
 * https://services.swpc.noaa.gov/text/wwv.txt -- the Geophysical Alert
 * Message, the text broadcast on WWV/WWVH at 18 minutes past each hour.
 *
 * Only the A index is taken from it. The bulletin also quotes the solar flux
 * and the current K, but both already publish from their own products, and a
 * second source for a value already on a path is a way for two numbers to
 * disagree rather than a second reading.
 *
 * The wording is matched loosely -- the phrase between "A-index" and the
 * number has varied ("was", "of", nothing at all) -- for the same reason the
 * Kp and solar wind parsers accept more than one shape.
 */
export function parseGeophysicalAlert(text: string): GeophysicalAlert | null {
  const normalized = text.replace(/\r\n/g, '\n')
  // The sign is captured rather than skipped: the gap before the number is
  // matched loosely, so an unsigned pattern reads NOAA's -999 filler as a
  // severe 999 -- a fabricated storm out of a missing measurement. A is a
  // magnitude and has no negative values to lose.
  const aMatch = normalized.match(/A[- ]index\D{0,12}?(-?\d+(?:\.\d+)?)/i)
  if (!aMatch) return null
  const aIndex = Number(aMatch[1])
  if (!Number.isFinite(aIndex) || aIndex < 0) return null

  const day = indicesDay(normalized)
  return day ? { day, aIndex } : null
}

/**
 * The UTC day the bulletin's indices are for. It names a day and a month but
 * no year ("indices for 19 August follow"), so the year comes from the
 * :Issued: line -- and a bulletin issued on 1 January reports 31 December, so
 * a day that lands ahead of its own issue date belongs to the year before.
 */
function indicesDay(text: string): string | null {
  const issued = parseIssueDate(text)
  const match = text.match(/indices for (\d{1,2} [A-Za-z]{3,9})/i)
  if (!issued || !match) return null

  const at = new Date(`${match[1]} ${issued.getUTCFullYear()} 00:00 UTC`)
  // `31 February` parses, as the 3rd of March; see utcDay.
  if (isNaN(at.getTime()) || at.getUTCDate() !== Number(match[1].split(' ')[0]))
    return null
  if (at.getTime() > issued.getTime()) {
    at.setUTCFullYear(at.getUTCFullYear() - 1)
  }
  return at.toISOString()
}

/**
 * A `YYYY-MM-DD` date as a UTC instant, or null if it is not a real day.
 *
 * `Date` silently rolls an impossible date forward -- `2026-02-30` parses as
 * the 2nd of March -- so a torn row could yield a day that looks valid and
 * sorts ahead of the real newest one, which is exactly the row the caller
 * picks. Reading the parts back is what catches that.
 */
function utcDay(text: string): string | null {
  const at = new Date(text + 'T00:00:00Z')
  if (isNaN(at.getTime())) return null
  const [year, month, dayOfMonth] = text.split('-').map(Number)
  const rolled =
    at.getUTCFullYear() !== year ||
    at.getUTCMonth() + 1 !== month ||
    at.getUTCDate() !== dayOfMonth
  return rolled ? null : at.toISOString()
}

export interface DailySolarIndices {
  /** The UTC day of the row, as an ISO instant. */
  day: string
  /** SESC sunspot number: where the solar cycle is, hence whether the high bands open. */
  sunspotNumber: number
}

/**
 * https://services.swpc.noaa.gov/text/daily-solar-indices.txt (DSD.txt) --
 * the last 30 daily rows, of which only the newest complete one is used.
 *
 * SWPC's other sunspot products carry the whole record back to 1749 or 1996
 * for the same one current number, at a hundred times the wire cost; see
 * docs/noaa-products.md.
 *
 * Tokenised rather than matched as a whole line, and the ISO date form
 * accepted alongside NOAA's `2026 08 19`, for the reason outlookRow gives.
 */
export function parseDailySolarIndices(text: string): DailySolarIndices | null {
  let latest: DailySolarIndices | null = null
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const row = dailySolarRow(line)
    if (row && (!latest || row.day > latest.day)) latest = row
  }
  return latest
}

function dailySolarRow(line: string): DailySolarIndices | null {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(':')) {
    return null
  }

  const tokens = trimmed.split(/\s+/)
  const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(tokens[0])
  const dateTokens = isoDate ? 1 : 3
  if (tokens.length < dateTokens + 2) return null

  const sunspotNumber = Number(tokens[dateTokens + 1])
  // NOAA fills a missing value with -999 rather than leaving the column
  // empty, and a negative sunspot count is the only way that shows up here.
  if (!Number.isFinite(sunspotNumber) || sunspotNumber < 0) return null

  const day = utcDay(
    isoDate ? tokens[0] : tokens.slice(0, dateTokens).join('-')
  )
  return day ? { day, sunspotNumber } : null
}

/**
 * Whether a raised notification still has something to stand down.
 *
 * A non-empty method matters even at `normal`, and is not a hypothetical: the
 * screenshot on issue #45 is a `normal` notification carrying visual+sound,
 * which is why it was making noise about a three-week-old message. Treating
 * `state === normal` as "already quiet" would leave exactly the reported case
 * untouched.
 */
export function isRaised(value: {
  state?: unknown
  method?: unknown
}): boolean {
  return (
    value.state !== NotificationStates.NORMAL ||
    (Array.isArray(value.method) && value.method.length > 0)
  )
}

// ---------------------------------------------------------------------------
// GOES X-ray and integral proton flux
// https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json
// https://services.swpc.noaa.gov/json/goes/primary/integral-protons-6-hour.json
// ---------------------------------------------------------------------------

export interface GoesFlux {
  /** 0.1-0.8nm channel, W/m^2 -- the channel the GOES flare class (M1, X1, ...) is defined on. */
  xrayFlux: number | null
  xrayTimestamp: string | null
  /** >=10 MeV channel, converted from pfu (cm^-2.s^-1.sr^-1) to m^-2.s^-1.sr^-1 -- the channel the S scale is defined on. */
  protonFlux: number | null
  protonTimestamp: string | null
}

const PFU_TO_SI = 1e4 // cm^-2 -> m^-2

/**
 * Both endpoints are flat arrays interleaving several energy channels per
 * timestamp (two for X-rays, eight for protons), not one channel appended in
 * order -- so "latest" means the last record matching the wanted channel,
 * found by scanning from the end, not simply the last element.
 */
export function parseGoesFlux(xrayJson: any, protonJson: any): GoesFlux {
  const xrayRow = lastRecordForEnergy(xrayJson, '0.1-0.8nm')
  const protonRow = lastRecordForEnergy(protonJson, '>=10 MeV')

  const xrayFlux = firstNumber(xrayRow, ['flux'])
  const protonFluxPfu = firstNumber(protonRow, ['flux'])

  return {
    xrayFlux,
    xrayTimestamp: firstString(xrayRow, ['time_tag']),
    protonFlux: protonFluxPfu === null ? null : protonFluxPfu * PFU_TO_SI,
    protonTimestamp: firstString(protonRow, ['time_tag'])
  }
}

/**
 * Which way the floor is moving: the ratio of the X-ray flux now to the flux
 * half an hour ago, from the ~700 records `xrays-6-hour.json` already carries
 * on every poll and which `parseGoesFlux` reads one of.
 *
 * The trend is the one HF question the X-ray channel can answer that the flare
 * class cannot. Per docs/hf-operator-view.md the channel acts on the D region
 * only, so it moves the *floor* and says nothing about the F2 ceiling -- but
 * "is this blackout deepening or clearing" is exactly what an operator waiting
 * one out wants, and the absolute flux is the flare class in other notation
 * (issue #122's "one number twice").
 *
 * A ratio rather than a word: which ratio counts as "rising" is a display
 * choice about how twitchy the reader wants to be, and belongs to whatever
 * draws it, not to the measurement. Above 1 the floor is rising.
 *
 * Medians over two adjacent 15-minute windows rather than two samples, because
 * the 1-per-minute cadence is noisy at B-class levels where a single dropout
 * would otherwise read as a collapse. Returns null unless both windows are
 * substantially populated: a feed with a gap where the comparison should be
 * has no trend to report, which is not the same as a flat one.
 */
export interface XrayTrend {
  /** Flux now divided by flux ~30 minutes ago. Above 1 the floor is rising. */
  ratio: number
  /** Time of the newest sample the ratio was computed from. */
  time: string
}

const TREND_WINDOW_MINUTES = 15
const TREND_MIN_SAMPLES = 8

export function xrayFluxTrend(xrayJson: any): XrayTrend | null {
  if (!Array.isArray(xrayJson)) return null
  const samples: { at: number; flux: number }[] = []
  for (const entry of xrayJson) {
    if (entry?.energy !== '0.1-0.8nm') continue
    const flux = firstNumber(entry, ['flux'])
    const at = Date.parse(entry.time_tag)
    // A zero or negative flux is not a reading of "no X-rays"; it is a bad
    // record, and one in the denominator would publish an infinite ratio.
    if (flux === null || flux <= 0 || !Number.isFinite(at)) continue
    samples.push({ at, flux })
  }
  if (samples.length === 0) return null

  // Anchored on the newest sample rather than the wall clock: the feed runs
  // minutes behind, and the leaf's own timestamp is what says how old this is.
  const latest = samples.reduce((a, b) => (b.at > a.at ? b : a))
  const window = TREND_WINDOW_MINUTES * 60 * 1000
  const fluxes = (fromAgo: number, toAgo: number) =>
    samples
      .filter(
        (s) =>
          latest.at - s.at >= fromAgo * window &&
          latest.at - s.at < toAgo * window
      )
      .map((s) => s.flux)

  const recent = median(fluxes(0, 1))
  const prior = median(fluxes(1, 2))
  if (recent === null || prior === null) return null
  return { ratio: recent / prior, time: new Date(latest.at).toISOString() }
}

function median(values: number[]): number | null {
  if (values.length < TREND_MIN_SAMPLES) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

function lastRecordForEnergy(json: any, energy: string): any {
  if (!Array.isArray(json)) return null
  for (let i = json.length - 1; i >= 0; i--) {
    if (json[i]?.energy === energy) return json[i]
  }
  return null
}

// ---------------------------------------------------------------------------
// D-RAP global frequencies
// https://services.swpc.noaa.gov/text/drap_global_frequencies.txt
// ---------------------------------------------------------------------------

export interface DrapGrid {
  validTime: string
  /** 89 down to -89, step -2. */
  latitudes: number[]
  /** -178 up to 178, step 4. */
  longitudes: number[]
  /** [latitude row][longitude column], MHz, the highest frequency degraded by >=1dB. */
  frequenciesMHz: number[][]
}

const DRAP_LON_ROW = /^\s*-?\d+(?:\s+-?\d+)+\s*$/
const DRAP_DATA_ROW = /^\s*(-?\d+)\s*\|\s*(.+)$/

export function parseDrapGrid(rawText: string): DrapGrid | null {
  // A checkout with CRLF line endings (git on Windows) leaves a trailing \r
  // on every line; unstripped it lands inside the last numeric column and
  // fails the Number.isFinite check below for the entire grid.
  const text = rawText.replace(/\r\n/g, '\n')
  const validMatch = text.match(
    /Product Valid At\s*:\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*UTC/
  )
  const validTime = validMatch
    ? asIsoString(`${validMatch[1].replace(' ', 'T')}:00Z`)
    : null

  let longitudes: number[] | null = null
  const latitudes: number[] = []
  const rows: number[][] = []

  for (const line of text.split('\n')) {
    if (!longitudes && !line.startsWith('#') && DRAP_LON_ROW.test(line)) {
      longitudes = line.trim().split(/\s+/).map(Number)
      continue
    }
    const dataMatch = line.match(DRAP_DATA_ROW)
    if (dataMatch) {
      latitudes.push(Number(dataMatch[1]))
      rows.push(dataMatch[2].trim().split(/\s+/).map(Number))
    }
  }

  if (!longitudes || rows.length === 0) return null
  if (rows.some((row) => row.length !== longitudes!.length)) return null
  if (rows.some((row) => row.some((v) => !Number.isFinite(v)))) return null
  // A read landing mid-write (docs/noaa-products.md) can catch this text
  // grid mid-rewrite: every row that arrived is internally consistent, but
  // there are fewer of them than NOAA's documented 90x90 shape. Accepting
  // that grid would let nearestIndex silently snap to the nearest surviving
  // row/column -- a wrong answer with no signal it's wrong, the same failure
  // auroraCell avoids by returning null on an inexact match rather than
  // approximating.
  if (latitudes.length !== 90 || longitudes.length !== 90) return null
  // The header is torn by the same rewrite the rows are, and a grid whose
  // valid time did not survive it has no way to say how old it is. Publishing
  // it stamped with the local clock dates a NOAA reading by when we read it.
  if (!validTime) return null

  return { validTime, latitudes, longitudes, frequenciesMHz: rows }
}

/**
 * Highest degraded frequency (MHz) at a position, from the nearest grid
 * point. Not interpolated: a D-RAP cell is a threshold, not a continuous
 * field, so blending a blacked-out cell with a clear one would invent a
 * frequency nothing actually measured.
 */
export function drapFrequencyAt(
  grid: DrapGrid | null,
  latitude: number,
  longitude: number
): number | null {
  if (!grid) return null
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null

  const latIndex = nearestIndex(grid.latitudes, latitude, (a, b) =>
    Math.abs(a - b)
  )
  const lonIndex = nearestIndex(grid.longitudes, longitude, angularDistance)
  if (latIndex === -1 || lonIndex === -1) return null

  // parseDrapGrid already guarantees every cell is finite, but this function
  // takes a DrapGrid rather than the raw text -- "never publish NaN" holds
  // for any grid a caller hands in, not only ones that went through the
  // parser.
  const value = grid.frequenciesMHz[latIndex]?.[lonIndex]
  return Number.isFinite(value) ? value : null
}

function nearestIndex(
  values: number[],
  target: number,
  distance: (a: number, b: number) => number
): number {
  let best = -1
  let bestDistance = Infinity
  for (let i = 0; i < values.length; i++) {
    const d = distance(values[i], target)
    if (d < bestDistance) {
      bestDistance = d
      best = i
    }
  }
  return best
}

/** Shortest distance between two longitudes on a -180..180 circle. */
function angularDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360
  return diff > 180 ? 360 - diff : diff
}
