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
/** The level this plugin treats as worth surfacing at all; see CLAUDE.md. */
const NOTABLE = 3
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

/** Mirrors gScaleForKp in src/parse.ts. */
export function gScaleForKp(kp) {
  if (!Number.isFinite(kp) || kp < KP_FOR_G1) return 0
  return Math.min(Math.floor(kp) - (KP_FOR_G1 - 1), 5)
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

/** Every scale at or above `NOTABLE` other than the one leading the hero. */
function othersInForce(levels, leadLetter) {
  return LETTER_ORDER.filter(
    (letter) => letter !== leadLetter && (levels?.[letter] ?? 0) >= NOTABLE
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

  if (lead.level >= NOTABLE) {
    return {
      kind: 'storm',
      letter: lead.letter,
      level: lead.level,
      also: othersInForce(observed, lead.letter),
      timer
    }
  }

  // A storm still ahead outranks one already gone: both are "quiet right
  // now", and only one of them is still a decision.
  if (timer.kind === 'until-level') {
    return { kind: 'brewing', letter: 'G', level: timer.level, timer }
  }

  const peak = worstOf(peak24h)
  if (peak && peak.level >= NOTABLE) {
    return { kind: 'all-clear', peak, timer }
  }

  return { kind: 'quiet', peak: peak && peak.level > 0 ? peak : null, timer }
}
