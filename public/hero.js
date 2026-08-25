// What the hero banner should say, decided separately from how it is worded.
//
// The webapp's other panels each render one value, so their logic is a
// formatter. This one has to choose between "nothing is happening", "nothing
// is happening but something did", "nothing is happening yet but something
// will", and "something is happening", from four sources that disagree about
// time -- and the wrong choice is a page that reads "space weather is quiet"
// hours after a storm (issue #34). Deciding that here keeps the copy in
// index.html and lets the decision be tested without a browser.

/** Kp at which NOAA calls it a G1 storm; mirrors KP_FOR_G1 in src/parse.ts. */
const KP_FOR_G1 = 5
/**
 * The level at which this plugin interrupts the user; mirrors ALERT_FLOOR in
 * src/parse.ts. It decides precedence and nothing else here. Whether a
 * storm is worth *saying* is a lower bar than whether it is worth a
 * notification -- see IN_FORCE.
 */
const NOTABLE = 3
/**
 * Anything NOAA names is worth describing. NOAA's own front page and the WWV
 * bulletin both report an R2 as "moderate"; a page that answers that with
 * "quiet" is not being restrained, it is making the opposite claim (issue
 * #126). Loudness stays where it belongs, in alarmLevel and popupLevel: this
 * only governs what the banner says when somebody looks at it.
 */
const IN_FORCE = 1
/**
 * How long a fresh plugin gets to produce its first value before silence
 * stops meaning "starting up". The first fetch is scheduled 5s after start
 * and the slowest default interval is two hours, but a product that is going
 * to work at all answers on its first attempt -- so this only has to clear
 * the initial delay plus a slow link, not a whole poll cycle.
 */
export const STARTUP_GRACE_MS = 15 * 60 * 1000

/**
 * An impact clause written as a sentence, folded into the middle of one.
 * Acronyms keep their case: NOAA's scale effects open on "HF" and "GNSS" as
 * often as not, and "hF blackout" is simply wrong.
 */
export function uncapitalise(text) {
  if (!text) return ''
  return /^[A-Z]{2}/.test(text)
    ? text
    : text.charAt(0).toLowerCase() + text.slice(1)
}

/**
 * Mirrors kpFloorForG in src/parse.ts: a G band opens a third below the Kp it
 * is named after, so G4 starts at 7.667 rather than 8.
 */
export const kpFloorForG = (g) => KP_FOR_G1 + g - 1 - 1 / 3

/** Mirrors gScaleForKp in src/parse.ts. */
export function gScaleForKp(kp) {
  if (!Number.isFinite(kp)) return 0
  for (let g = 5; g >= 1; g--) {
    if (kp >= kpFloorForG(g)) return g
  }
  return 0
}

/**
 * G before R before S at equal levels. Not alphabetical and not NOAA's own
 * order: it is what the level costs a boat. A geomagnetic storm degrades GNSS
 * and HF together, a radio blackout takes HF on the sunlit side, and a
 * radiation storm mostly bites over the poles -- so on a tie the first is the
 * one worth leading with.
 */
const LETTER_ORDER = ['G', 'R', 'S']

function worstOf(levels) {
  let best = null
  for (const letter of LETTER_ORDER) {
    const level = levels?.[letter]
    if (!Number.isFinite(level)) continue
    if (!best || level > best.level) best = { letter, level }
  }
  return best
}

/**
 * The other scales worth naming beside the one leading the hero: nothing
 * quieter than the lead itself, and never below `NOTABLE` when the lead is
 * above it. So a G4 banner still does not list an R1, but an R2 banner --
 * which exists at all because level 2 is worth describing -- lists a G2.
 */
function othersInForce(levels, leadLetter, leadLevel) {
  const floor = Math.min(NOTABLE, leadLevel)
  return LETTER_ORDER.filter(
    (letter) => letter !== leadLetter && (levels?.[letter] ?? 0) >= floor
  ).map((letter) => ({ letter, level: levels[letter] }))
}

function forecastPoints(series, nowMs) {
  return (series ?? [])
    .filter((point) => {
      const at = Date.parse(point?.time)
      return Number.isFinite(at) && at > nowMs
    })
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
}

/**
 * The one clock the hero shows, in every state. It always counts to the next
 * change in conditions, or -- when nothing is coming -- how much of the
 * forecast horizon is still clear. A placeholder in this slot reads as an
 * alarm rather than as an absence, so there is deliberately no branch that
 * produces one.
 *
 * `currentLevel` is the geomagnetic level in force now, so that a storm
 * already running counts to the level above it (the actionable change) and
 * falls back to counting to the drop. It has to be the *geomagnetic* level
 * even when another scale leads the banner: `series` is the Kp forecast and
 * describes nothing else. Comparing an R or S level against it reads an
 * easing time out of a forecast that never mentioned radio blackouts, and
 * raises the escalation bar high enough to drop a real inbound G storm.
 */
export function timerFor(series, currentLevel, nowMs) {
  const ahead = forecastPoints(series, nowMs)
  if (ahead.length === 0) return { kind: 'unknown' }

  const escalation = Math.max(NOTABLE, (currentLevel ?? 0) + 1)
  const worse = ahead.find((point) => gScaleForKp(point.kp) >= escalation)
  if (worse) {
    return {
      kind: 'until-level',
      level: gScaleForKp(worse.kp),
      at: worse.time
    }
  }

  if ((currentLevel ?? 0) >= NOTABLE) {
    const eases = ahead.find((point) => gScaleForKp(point.kp) < currentLevel)
    if (eases) return { kind: 'until-easing', at: eases.time }
  }

  // Nothing ahead changes anything, so the useful number is how long that
  // holds: the forecast runs out at its last point, not at a round 72 hours.
  return { kind: 'forecast-clear', at: ahead[ahead.length - 1].time }
}

/**
 * @param input.observed        {G,S,R} levels observed now
 * @param input.peak24h         {G,S,R} 24-hour observed maximums
 * @param input.series          Kp forecast points, {time, kp, forecast}
 * @param input.observedAt      timestamp of the newest observation
 * @param input.startedAt       when this run of the plugin began
 * @param input.staleAfterMs    age at which observations stop being trusted
 */
export function heroState(input, now = Date.now()) {
  const {
    observed,
    peak24h,
    series,
    observedAt,
    startedAt,
    staleAfterMs
  } = input
  const lead = worstOf(observed)

  if (!lead) {
    const startMs = Date.parse(startedAt ?? '')
    const running = Number.isFinite(startMs) ? now - startMs : null
    return {
      kind: running !== null && running > STARTUP_GRACE_MS ? 'silent' : 'starting',
      startedAt: startedAt ?? null,
      timer: { kind: 'since-start', at: startedAt ?? null }
    }
  }

  const observedMs = Date.parse(observedAt ?? '')
  if (Number.isFinite(observedMs) && now - observedMs > staleAfterMs) {
    return {
      kind: 'stale',
      observedAt,
      timer: { kind: 'since-update', at: observedAt }
    }
  }

  const timer = timerFor(series, observed?.G ?? 0, now)

  const storm = (letter, level) => ({
    kind: 'storm',
    letter,
    level,
    also: othersInForce(observed, letter, level),
    timer
  })

  if (lead.level >= NOTABLE) return storm(lead.letter, lead.level)

  // A storm still ahead outranks one already gone, and outranks a minor one
  // running now: all three leave the boat fine today, and only the forecast
  // is still a decision. Anything reaching this line is below NOTABLE, so
  // what the forecast offers is always the louder of the two.
  if (timer.kind === 'until-level') {
    return { kind: 'brewing', letter: 'G', level: timer.level, timer }
  }

  const peak = worstOf(peak24h)
  if (peak && peak.level >= NOTABLE) {
    return { kind: 'all-clear', peak, timer }
  }

  // Below the alert floor the plugin still raises nothing, but the banner has
  // to say what NOAA says. Same state as a real storm, one level quieter --
  // the difference is carried by the level and by NOAA's word for it, which
  // is what index.html renders.
  if (lead.level >= IN_FORCE && (!peak || peak.level <= lead.level)) {
    return storm(lead.letter, lead.level)
  }

  // Nothing this minute as bad as the day has been. NOAA's front page reports
  // the 24-hour maximum as the condition and the WWV bulletin puts it in
  // words, so a day whose maximum was R2 is a moderate day rather than a
  // quiet one. `all-clear` above is the louder version of this and reads
  // differently on purpose: there, a real storm ended, and the relief is the
  // news. At level 1-2 nothing ended, so the honest report is just what
  // happened.
  if (peak && peak.level >= IN_FORCE) {
    return { kind: 'recent', peak, timer }
  }

  return { kind: 'quiet', peak: null, timer }
}
