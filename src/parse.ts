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

// G is defined directly in terms of Kp: G1 = Kp5 ... G5 = Kp9.
export const KP_FOR_G1 = 5

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
 * `alarmLevel` is the level that sounds an alarm; the quieter states derive
 * *downward* from it — one below is `warn`, two below is `alert`, anything
 * under that is `normal`.
 *
 * The direction matters and is the whole reason this reads the way it does.
 * Deriving upward from a "worth your attention" pivot instead runs off the end
 * of a five-level scale: with the pivot at 4 nothing can reach `alarm`, and at
 * 5 nothing can even reach `warn`, so the two loudest-sounding choices a user
 * could make were the two that silenced the plugin. Anchoring on the alarm
 * leaves the levels above the pivot to absorb that, so every setting is live
 * and turning the number down is monotonically louder.
 *
 * The default of 5 is what NOAA's frequency table supports: over an 11-year
 * cycle level 5 falls on ~4 days, level 4 on ~60, level 3 on ~130. Alarming
 * below 5 means a sound several times a year, and below 3 it is most weeks.
 */
export function stateForScaleValue(
  value: number,
  alarmLevel: number = NoaaScaleValues.EXTREME
): AlarmState {
  if (value <= 0) return NotificationStates.NOMINAL
  if (value >= alarmLevel) return NotificationStates.ALARM
  if (value === alarmLevel - 1) return NotificationStates.WARN
  if (value === alarmLevel - 2) return NotificationStates.ALERT
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
  alarmLevel: number = NoaaScaleValues.EXTREME
): Zone[] {
  const zones: Zone[] = []
  for (let value = 0; value <= MAX_NOAA_SCALE; value++) {
    zones.push({
      lower: value,
      upper: value + 1,
      state: stateForScaleValue(value, alarmLevel),
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
 * same G-scale severity mapping. Kp is a real number (e.g. 5.67), so the zone
 * boundaries are the G thresholds rather than unit-wide buckets.
 */
export function zonesForKp(
  alarmLevel: number = NoaaScaleValues.EXTREME
): Zone[] {
  const zones: Zone[] = [
    {
      lower: 0,
      upper: KP_FOR_G1,
      state: NotificationStates.NOMINAL,
      message: 'Kp below storm level'
    }
  ]
  for (let g = 1; g <= MAX_NOAA_SCALE; g++) {
    const zone: Zone = {
      lower: KP_FOR_G1 + g - 1,
      state: stateForScaleValue(g, alarmLevel),
      message: `G${g} (${NoaaScaleNames[g]}) -- Kp ${KP_FOR_G1 + g - 1}`
    }
    // The top band deliberately carries no `upper` key. Kp saturates at 9 and
    // the server's matcher is exclusive on `upper`, so Kp exactly 9 needs
    // headroom -- but Infinity is not representable in JSON and would reach the
    // server as null, which does not trigger the `upper = Infinity`
    // destructuring default and would leave G5 matching no zone at all.
    // Omitting the key serialises it away entirely, so the default applies.
    if (g < MAX_NOAA_SCALE) {
      zone.upper = KP_FOR_G1 + g
    }
    zones.push(zone)
  }
  return zones
}

/** Kp to G scale value. Kp < 5 is no storm; Kp 5..9 maps to G1..G5. */
export function gScaleForKp(kp: number): number {
  if (!Number.isFinite(kp) || kp < KP_FOR_G1) return NoaaScaleValues.NONE
  return Math.min(Math.floor(kp) - (KP_FOR_G1 - 1), MAX_NOAA_SCALE)
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

/**
 * Parse one entry of https://services.swpc.noaa.gov/products/alerts.json
 *
 * Returns null when the payload can't be understood, so the caller can skip it
 * rather than the whole batch dying on one malformed message.
 */
export function parseAlert(
  alert: any,
  alarmLevel: number = NoaaScaleValues.EXTREME
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
        : stateForScaleValue(scaleValue, alarmLevel),
    issued,
    validUntil: alertValidUntil(alert.message),
    cancelled
  }
}

/**
 * Hard ceiling on simultaneously raised alert notifications, whatever NOAA
 * sends. Grouping by message code already bounds this to the ~40 documented
 * codes, and the busiest fixture on record (the April 2025 G4 storm) reaches
 * 8 — but a payload change that made the code capture vary would silently
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

export interface AlertSelectionOptions {
  now: Date
  /** Overrides {@link ALERT_MAX_AGE_MS}; tests only. */
  maxAgeMs?: number
  alarmLevel?: number
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
 * The payload is a rolling ~30-day archive — 118 to 200 messages in every
 * captured fixture — and until 0.12.0 this plugin raised a notification for
 * each one, on a path keyed by NOAA's serial number. That was wrong twice
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
    limit = MAX_ALERT_NOTIFICATIONS
  } = options

  const newest = new Map<string, AlertNotification>()
  let unparseable = 0

  for (const entry of payload) {
    const parsed = parseAlert(entry, alarmLevel)
    if (!parsed) {
      unparseable++
      continue
    }

    const expiresAt =
      parsed.validUntil ?? new Date(parsed.issued.getTime() + maxAgeMs)
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
      description: entry.message
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
 * recent event. A single-element array is the documented shape; tolerate an
 * empty one (no event ever recorded) rather than throwing.
 */
export function parseXrayFlare(json: any): XrayFlare | null {
  const entry = Array.isArray(json) ? json[0] : null
  if (
    !entry ||
    typeof entry.current_class !== 'string' ||
    !entry.current_class
  ) {
    return null
  }
  if (typeof entry.time_tag !== 'string' || !entry.time_tag) return null
  return { flareClass: entry.current_class, time: entry.time_tag }
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
 * forecast. Kp maps directly onto the G scale (G1 = Kp5 ... G5 = Kp9).
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
  const past = rows.filter((row) => row.at.getTime() <= nowMs)
  const future = rows.filter((row) => row.at.getTime() > nowMs)

  const latest = past.length > 0 ? past[past.length - 1] : null
  const within = (hours: number) =>
    future.filter((row) => row.at.getTime() <= nowMs + hours * 3600 * 1000)

  const maxKp = (subset: typeof rows) =>
    subset.length > 0 ? Math.max(...subset.map((row) => row.kp)) : null

  const max24h = maxKp(within(24))
  const max72h = maxKp(within(72))
  const nextStorm = future.find((row) => row.kp >= KP_FOR_G1) ?? null

  const seriesStart = nowMs - 24 * 3600 * 1000
  const seriesEnd = nowMs + 72 * 3600 * 1000
  const series: KpSeriesPoint[] = rows
    .filter(
      (row) => row.at.getTime() >= seriesStart && row.at.getTime() <= seriesEnd
    )
    .map((row) => ({
      time: row.at.toISOString(),
      kp: row.kp,
      forecast: row.at.getTime() > nowMs
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
      kp: Number(record?.kp ?? record?.Kp)
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
 * Aurora is an opportunity, not a hazard, so no band is allowed to reach
 * `alarm` and the product never attaches a sound method. The top band is
 * `warn` purely so a dashboard can make it stand out.
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
    // No `upper`: probability tops out at 1, and the server's matcher is
    // exclusive on upper, so the top band must be open-ended.
    {
      lower: 0.5,
      state: NotificationStates.WARN,
      message: 'Aurora very likely'
    }
  ]
}
