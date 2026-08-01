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

export type AlarmState = (typeof NotificationStates)[keyof typeof NotificationStates]

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
 * `alertThreshold` is the lowest value that produces anything above `normal`.
 * NOAA's own frequency table makes the default of 3 the sensible pivot: over an
 * 11-year cycle (~4015 days) G1 occurs on ~900 days and R1 on ~950 -- roughly a
 * quarter of all days -- while level 3 occurs on ~130-140 days (about monthly)
 * and level 5 on ~4. Alerting below 3 would be noise. 3 also matches the
 * long-standing `minScaleAlert` default for alert notifications.
 */
export function stateForScaleValue(
  value: number,
  alertThreshold: number = NoaaScaleValues.STRONG
): AlarmState {
  if (value <= 0) return NotificationStates.NOMINAL
  if (value < alertThreshold) return NotificationStates.NORMAL
  if (value === alertThreshold) return NotificationStates.ALERT
  if (value === alertThreshold + 1) return NotificationStates.WARN
  return NotificationStates.ALARM
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
  alertThreshold: number = NoaaScaleValues.STRONG
): Zone[] {
  const zones: Zone[] = []
  for (let value = 0; value <= MAX_NOAA_SCALE; value++) {
    zones.push({
      lower: value,
      upper: value + 1,
      state: stateForScaleValue(value, alertThreshold),
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
  alertThreshold: number = NoaaScaleValues.STRONG
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
      state: stateForScaleValue(g, alertThreshold),
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
 * Notification method fields for a metadata object. These sit alongside
 * `zones` and let a zone carry a state without necessarily interrupting the
 * user: levels at or just above the alert threshold are informational
 * (empty method), and only the top bands get visual/sound.
 */
export function zoneMethods(visual: boolean = true, sound: boolean = true) {
  const loud: string[] = []
  if (visual) loud.push('visual')
  const loudest: string[] = [...loud]
  if (sound) loudest.push('sound')
  return {
    nominalMethod: [],
    normalMethod: [],
    alertMethod: [],
    warnMethod: loud,
    alarmMethod: loudest,
    emergencyMethod: loudest
  }
}

/**
 * Parse a UTC date/time from NOAA text-product lines such as:
 *   :Issued: 2025 Apr 08 1230 UTC
 * Returns null rather than throwing when the line is absent or malformed.
 */
export function parseIssueDate(text: string): Date | null {
  const issuedLine = text.match(/\n:Issued: ([^\n]*)/)
  if (!issuedLine) return null
  const dateTimeRegex = /([0-9]{4} [A-Za-z]{3,9} [0-9]{1,2}) ([0-9]{2,4} UTC)/
  const parts = issuedLine[1].match(dateTimeRegex)
  if (!parts) return null
  const datePortion = parts[1]
  const timePortion = parts[2].padStart(8, '0')
  const newTimeString =
    timePortion.slice(0, 2) + ':' + timePortion.slice(2, 4) + ' UTC'
  const parsed = new Date(datePortion + ' ' + newTimeString)
  return isNaN(parsed.getTime()) ? null : parsed
}

export interface AdvisoryOutlook {
  idLine: string
  shortId: string
  issued: Date
}

/**
 * Parse the weekly advisory outlook text product.
 * https://services.swpc.noaa.gov/text/advisory-outlook.txt
 */
export function parseAdvisoryOutlook(text: string): AdvisoryOutlook | null {
  const match = text.match(
    /\n(SPACE WEATHER ADVISORY OUTLOOK ([^\n]*))\n([^\n]*)\n/
  )
  if (!match) return null
  const issued = parseIssueDate(text)
  if (!issued) return null
  return { idLine: match[1], shortId: match[2].trim(), issued }
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
}

/**
 * Parse one entry of https://services.swpc.noaa.gov/products/alerts.json
 *
 * Returns null when the payload can't be understood, so the caller can skip it
 * rather than the whole batch dying on one malformed message.
 */
export function parseAlert(
  alert: any,
  minScaleAlert: number = NoaaScaleValues.STRONG
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
    if (scaleText.match(/or greater/)) {
      scaleValue = NoaaScaleValues.EXTREME
    } else {
      const digits = scaleText.match(/[GSR]([0-5])/)
      scaleValue = digits ? parseInt(digits[1], 10) : null
    }
  }

  return {
    serialNumber: serial[1],
    messageCode: code[1],
    alertLevel: getAlertLevel(code[1]),
    mainMessage: headline ? headline[5] : alert.message.split('\n')[0],
    scaleText,
    scaleValue,
    state:
      scaleValue !== null && scaleValue >= minScaleAlert
        ? NotificationStates.ALERT
        : NotificationStates.NORMAL,
    issued
  }
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

export interface KpSummary {
  observed: number | null
  observedTime: string | null
  max24h: number | null
  max72h: number | null
  maxNoaaScale: number | null
  nextStormTime: string | null
  nextStormKp: number | null
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
    nextStormKp: null
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

  return {
    observed: latest ? latest.kp : null,
    observedTime: latest ? latest.at.toISOString() : null,
    max24h,
    max72h,
    maxNoaaScale: max72h === null ? null : gScaleForKp(max72h),
    nextStormTime: nextStorm ? nextStorm.at.toISOString() : null,
    nextStormKp: nextStorm ? nextStorm.kp : null
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
    if (typeof record[key] === 'string' && record[key] !== '') return record[key]
  }
  return null
}
