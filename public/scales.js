// What the Storm Scales card says, decided separately from how it is drawn --
// the same split as hero.js. The card names the endpoints it draws from, so
// issue #120 (badges fed by the instantaneous sample instead of the 24-hour
// maximum) is now a wiring choice a test can reach.
import { leafTime, leafValue } from './signalk.js'

export const LETTERS = ['G', 'S', 'R']

// Resolved here rather than handed in by the caller: passing the wrong node
// is what #120 was, and it has to be wrong here, where the tests are.
export const SCALES_CARD_SOURCES = {
  observed: 'scalesObserved',
  forecast: 'scalesForecast',
  flare: 'xrayFlare'
}

const DAY_KEYS = ['1day', '2day', '3day']

// Every value is a number or `null`, never `0` standing in for "no reading" --
// 0 is a real and common level on all three scales. Probabilities arrive as
// the 0-1 ratios Signal K wants and come back out as percentages to draw.
export function scalesCard(data) {
  const observedNode = data?.[SCALES_CARD_SOURCES.observed]
  const forecastNode = data?.[SCALES_CARD_SOURCES.forecast]
  const flareNode = data?.[SCALES_CARD_SOURCES.flare]

  const observed = Object.fromEntries(
    LETTERS.map((letter) => [letter, numberOrNull(observedNode?.[letter])])
  )

  return {
    observed,
    // Either leaf answers "how old is this", and a product that failed
    // mid-publish may have only one of them.
    observedAt: leafTime(observedNode?.G) || leafTime(observedNode?.time),
    // The 24-hour peak, not the latest flare, because of where this readout
    // sits: inside the R row, beside a badge that is NOAA's 24-hour maximum
    // and coloured by that badge's level. The flare next to it has to be the
    // one that level describes or the row disagrees with itself -- which is
    // issue #122's complaint, one endpoint further back. The latest flare is
    // published too and the Solar Activity tile draws it.
    flareClass: leafValue(flareNode?.max24h?.class) ?? null,
    forecast: DAY_KEYS.map((key) => forecastDay(forecastNode?.[key]))
  }
}

// `at` is the value at `<n>day.time`, NOAA's own per-day DateStamp, not the
// leaf's timestamp -- all three days publish in one update, so a timestamp
// would label every column identically.
function forecastDay(node) {
  return {
    at: leafValue(node?.time) ?? null,
    G: numberOrNull(node?.G),
    sProbability: percent(node?.S?.probability),
    rMinorProbability: percent(node?.R?.minorProbability),
    rMajorProbability: percent(node?.R?.majorProbability)
  }
}

function numberOrNull(node) {
  const value = leafValue(node)
  return Number.isFinite(value) ? value : null
}

function percent(node) {
  const ratio = numberOrNull(node)
  return ratio === null ? null : ratio * 100
}

// Below here is what the card looks like, moved out of index.html alongside
// the wiring above -- issue #121 named `renderScales` as the untested half:
// `scalesCard` proved which endpoint fills the badge, but nothing fed the
// result through to markup and asked it for "G4". `scalesMarkup` is the pure
// half of the old `renderScales` (a string in, a string out); index.html
// keeps only the two DOM writes (`body.innerHTML = ...`, `setLetter`/
// `setTimestamp`) that a fixture-driven test cannot reach anyway.

// NOAA's own words for its own scale (mirrors NoaaScaleNames in
// src/parse.ts), because this describes the sky. It used to carry the
// notification-state wording instead -- Nominal/Normal/Normal/Alert/Warn/
// Alarm -- which answered "how loud should this be?" in the slot that asks
// "what is happening?", and printed Normal under an R2 that NOAA, and the
// WWV bulletin, both call Moderate (issue #126). The loudness vocabulary is
// still right where it is a setting: the config panel's ladder.
//
// Index 0 departs from NOAA's own word on purpose: "None" in a pill or under
// a badge reads as broken, not calm. "Quiet" is the standing default for no
// current, recent, or near-future storm until WWV coverage across more days
// says otherwise.
const SEV_WORDS = ['Quiet', 'Minor', 'Moderate', 'Strong', 'Severe', 'Extreme']

export function sevClass(level) {
  if (level === null || level === undefined) return null
  if (level <= 0) return 'sev-0'
  if (level === 1) return 'sev-1'
  if (level === 2) return 'sev-2'
  if (level === 3) return 'sev-3'
  if (level === 4) return 'sev-4'
  return 'sev-5'
}

export function sevWord(level) {
  if (level === null || level === undefined) return '—'
  return SEV_WORDS[Math.min(5, Math.max(0, Math.round(level)))]
}

// Coloring for S/R's forecast percentages, not the 0-5 G/S/R scale levels
// above -- these are frequency tiers sourced from NOAA's own historical
// rates (median day sits around 1%, so most of the range is "green"):
// exceeds 1% ~90-95% of days, exceeds 5% ~15-20%, exceeds 10% ~5-10%,
// exceeds 25% ~2-4%, exceeds 50% <1%. Cutoffs are config constants here,
// easy to retune without touching the rendering logic.
export function tierClass(pct) {
  if (pct === null || pct === undefined) return null
  if (pct <= 5) return 'sev-1'
  if (pct <= 10) return 'sev-3'
  if (pct <= 25) return 'sev-4'
  return 'sev-5'
}

// Half-circle arc gauge: fill is always linear 0-100% (honest magnitude),
// color flags the frequency tier -- a 15% reading is genuinely rare even
// though the arc itself is barely a third full.
export function arcSvg(pct, cls) {
  const p = pct === null || pct === undefined ? 0 : Math.max(0, Math.min(100, pct))
  const dash = 78.5
  const offset = (dash * (1 - p / 100)).toFixed(1)
  const color = cls ? `var(--${cls})` : 'var(--grid)'
  const label = pct === null || pct === undefined ? '–' : `${Math.round(pct)}%`
  return `<svg class="scales-arc-svg" viewBox="0 0 60 34">
      <path d="M5,30 A25,25 0 0,1 55,30" fill="none" stroke="var(--grid)" stroke-width="6"/>
      <path d="M5,30 A25,25 0 0,1 55,30" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round"
        stroke-dasharray="${dash}" stroke-dashoffset="${offset}"/>
      <text x="30" y="21" text-anchor="middle" fill="${color}" font-family="var(--font-mono)" font-weight="700" font-size="11">${label}</text>
    </svg>`
}

// "M1.4" -> class letter in the rounded face, magnitude in the numeral face,
// matching how the G/S/R badges are set. Anything that isn't the expected
// letter+number shape is rendered as plain text rather than guessed at.
export function flareMarkup(flareClass) {
  if (!flareClass) return '&ndash;'
  const m = /^([A-Z])([\d.]+)$/.exec(String(flareClass).trim())
  if (!m) return String(flareClass).replace(/[<>&]/g, '')
  return `${m[1]}<span class="num">${m[2]}</span>`
}

// UTC, not the vessel's local zone: NOAA's forecast days are UTC days and
// days 2 and 3 arrive stamped 00:00:00, so rendering them locally puts two
// columns on the same date.
function dayLabel(day, i) {
  return day.at
    ? new Date(day.at).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC'
      })
    : `Day ${i + 1}`
}

/** The Storm Scales card body, as HTML. `renderScales` in index.html only
 * assigns this to the scales container's innerHTML and drives the two DOM-only reads
 * (`setLetter`, `setTimestamp`) that a fixture cannot exercise. */
export function scalesMarkup(card) {
  const { G: gLevel, S: sLevel, R: rLevel } = card.observed
  // rCls also colours the flare-class readout below, rather than that
  // getting a second letter-tier table to drift apart from this one. Issue
  // #122: the value it colours is background flux, not the flare that drove R.
  const gCls = sevClass(gLevel) || 'sev-0',
    sCls = sevClass(sLevel) || 'sev-0',
    rCls = sevClass(rLevel) || 'sev-0'

  const gPredCell = (day) => {
    if (day.G === null) return '<div class="scales-pred sev-0">&ndash;</div>'
    return `<div class="scales-pred ${sevClass(day.G) || 'sev-0'}">G<span class="num">${day.G}</span></div>`
  }
  const sPredCell = (day) =>
    `<div class="scales-arc">${arcSvg(day.sProbability, tierClass(day.sProbability))}</div>`
  const rLine = (pct, label) =>
    `<div class="scales-r-line ${tierClass(pct) || 'sev-0'}">${label}: <b>${pct === null ? '&ndash;' : Math.round(pct) + '%'}</b></div>`
  const rPredCell = (day) => `<div class="scales-r-day">
        ${rLine(day.rMinorProbability, 'R1&ndash;R2')}
        ${rLine(day.rMajorProbability, 'R3&ndash;R5')}
      </div>`

  const days = card.forecast

  return `
      <div class="scales-head">
        <span></span><span>Past 24h</span>
        ${days.map((d, i) => `<span>${dayLabel(d, i)}</span>`).join('')}
      </div>

      <div class="scales-row">
        <div class="scales-meta"><span class="name">Geomagnetic Storm</span></div>
        <div class="scales-badge-col">
          <div class="scales-badge" id="letterG">${gLevel === null ? '&ndash;' : `G<span class="num">${gLevel}</span>`}</div>
          <div class="scales-word ${gCls}">${sevWord(gLevel)}</div>
        </div>
        ${days.map(gPredCell).join('')}
      </div>

      <div class="scales-row">
        <div class="scales-meta"><span class="name">Solar Radiation Storm</span></div>
        <div class="scales-badge-col">
          <div class="scales-badge" id="letterS">${sLevel === null ? '&ndash;' : `S<span class="num">${sLevel}</span>`}</div>
          <div class="scales-word ${sCls}">${sevWord(sLevel)}</div>
        </div>
        ${days.map(sPredCell).join('')}
      </div>

      <div class="scales-row">
        <div class="scales-r-namebadge">
          <div class="name">Radio Blackout</div>
          <div class="scales-badge" id="letterR">${rLevel === null ? '&ndash;' : `R<span class="num">${rLevel}</span>`}</div>
          <div class="scales-flare-lbl">Solar Flare Class</div>
          <div class="scales-flare-val ${rCls}">${flareMarkup(card.flareClass)}</div>
        </div>
        ${days.map(rPredCell).join('')}
      </div>

      <div class="empty-state" style="margin-top:2px;padding:0;background:none;font-size:0.68rem;">
        R and S percentages are NOAA's predicted probability of reaching that level; G is NOAA's single predicted level, not a probability.
      </div>`
}
