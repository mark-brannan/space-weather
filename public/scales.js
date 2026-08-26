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
