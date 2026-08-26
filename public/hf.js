// What the HF Radio tile says, decided separately from how it is drawn -- the
// same split as hero.js and scales.js, and for the same reason: every choice
// below is a judgement about what the plugin is entitled to claim, and a
// judgement belongs somewhere a test can reach it.
import { leafTime, leafValue } from './signalk.js'

/**
 * Marine SSB band lower edges, in Hz. The same list as
 * `MARINE_SSB_BAND_EDGES_HZ` in src/parse.ts, which the D-RAP zone ladder is
 * built from; `hf-render.test.ts` pins the two identical, because a browser
 * cannot import the TypeScript and a strip drawn from a drifted copy would
 * disagree with the notification the same cutoff raises.
 *
 * Lower edges, not centres: D-RAP publishes the highest frequency degraded by
 * >=1 dB, so the first frequency of a band is the first one the cutoff reaches.
 */
export const MARINE_SSB_BAND_EDGES_HZ = [
  2_045_000, 4_000_000, 6_200_000, 8_100_000, 12_230_000, 16_360_000,
  18_780_000, 22_000_000, 25_070_000
]

/**
 * The solar flux bands, in sfu, mirroring `zonesForF107` in src/parse.ts.
 *
 * Convention, not derivation -- docs/hf-operator-view.md records that no
 * published mapping exists and that these were adopted deliberately as the
 * numbers the panels every operator reads use. The tile says so in its own
 * words rather than presenting them as measured, which is the whole reason
 * the provenance was written down.
 *
 * `from` is inclusive and the band runs to the next one's `from`, matching the
 * half-open zone matcher so a reading lands in the same band whichever surface
 * reads it.
 */
export const F107_BANDS = [
  { from: 0, key: 'closed', label: 'High bands closed' },
  { from: 70, key: 'poor', label: 'Poor' },
  { from: 90, key: 'fair', label: 'Fair' },
  { from: 120, key: 'good', label: 'Good' },
  { from: 150, key: 'excellent', label: 'Excellent' }
]

/**
 * Where "rising" starts. A chosen number, not a measured one: `xrayFluxTrend`
 * publishes a bare ratio precisely because how twitchy the reader wants to be
 * is a display decision, so this is the webapp picking one.
 *
 * 1.2 and its reciprocal rather than a pair of round numbers, so a rise and
 * the fall that undoes it read as the same size -- a ratio is multiplicative,
 * and 1.2/0.8 would call a smaller fall "clearing" than the rise it took to
 * call it "rising".
 */
export const TREND_RISING = 1.2

/** S1 begins at 10 pfu at >=10 MeV (NOAA's own boundary). */
export const S1_PFU = 10
const PFU_TO_SI = 1e4

/** The published proton flux is SI (m^-2.s^-1.sr^-1); the S scale, and every
 * operator, is quoted in pfu. */
export const toPfu = (si) => (si === null ? null : si / PFU_TO_SI)

export function f107Band(sfu) {
  if (sfu === null) return null
  let band = F107_BANDS[0]
  for (const candidate of F107_BANDS)
    if (sfu >= candidate.from) band = candidate
  return band
}

/**
 * The word for a ratio. `steady` covers the whole band between the two edges,
 * including a missing comparison window collapsing to exactly 1.
 */
export function trendWord(ratio) {
  if (ratio === null) return null
  if (ratio >= TREND_RISING) return 'rising'
  if (ratio <= 1 / TREND_RISING) return 'clearing'
  return 'steady'
}

/**
 * Each band, and whether the measured cutoff has reached it.
 *
 * `absorbed` is the only claim made about a band, and it is only ever made
 * downward. Issue #82: absorption says what is blocked from below, MUF/foF2
 * say what is supported from above, and the plugin has no MUF -- so a band
 * above the cutoff is "not blocked from below" and nothing more. Anything that
 * marked it usable, or drew it green, would be asserting a ceiling nobody
 * measured. A null cutoff is not zero either: no reading absorbs nothing, but
 * it also clears nothing.
 */
export function bandStrip(cutoffHz) {
  return MARINE_SSB_BAND_EDGES_HZ.map((hz) => ({
    hz,
    // Truncated, not rounded: the band at 18.78 MHz is the one everyone
    // calls 18, and rounding named it 19.
    label: String(Math.floor(hz / 1e6)),
    absorbed: cutoffHz !== null && cutoffHz >= hz
  }))
}

export function hfCard(data) {
  const cutoffHz = numberOrNull(data?.drap?.highest_affected_frequency)
  const sfu = numberOrNull(data?.f107)
  const protonPfu = toPfu(numberOrNull(data?.protonFlux))
  const ratio = numberOrNull(data?.xrayFlux?.trend)

  return {
    cutoffHz,
    cutoffAt: leafTime(data?.drap?.highest_affected_frequency),
    bands: bandStrip(cutoffHz),
    // Every band absorbed and no band absorbed are both real readings and
    // both draw a strip; `bandsAbsorbed` is only what the summary line counts.
    bandsAbsorbed: bandStrip(cutoffHz).filter((b) => b.absorbed).length,
    sfu,
    f107Band: f107Band(sfu),
    protonPfu,
    protonElevated: protonPfu !== null && protonPfu >= S1_PFU,
    trendRatio: ratio,
    trendWord: trendWord(ratio)
  }
}

/**
 * The Solar Activity tile: solar wind, the latest flare, and the two slow
 * indices.
 *
 * The flare here is `class`, the latest one, where the Storm Scales card takes
 * `max24h.class` -- the two tiles are answering different questions and
 * public/scales.js says why the card cannot take this one.
 */
export function solarCard(data) {
  return {
    speed: numberOrNull(data?.solarWind?.speed),
    bt: numberOrNull(data?.solarWind?.Bt),
    bz: numberOrNull(data?.solarWind?.Bz),
    flareClass: leafValue(data?.xrayFlare?.class) ?? null,
    aIndex: numberOrNull(data?.aIndex),
    sunspotNumber: numberOrNull(data?.sunspotNumber)
  }
}

function numberOrNull(node) {
  const value = leafValue(node)
  return Number.isFinite(value) ? value : null
}

/**
 * The D-RAP map ramp: one stop per marine SSB band the cutoff has passed.
 *
 * The same table as `DRAP_BAND_RAMP` in src/tiles.ts, which draws the
 * chart-plotter overlay; `hf-render.test.ts` pins the two identical, for the
 * reason the band edges above are pinned -- two pictures of one number that
 * disagree are worse than one picture.
 *
 * Stops rather than a smooth scale because the published number is a
 * frequency, not a severity: what changes for a reader is a band going under,
 * so that is where the colour moves. See `zonesForDrap` in src/parse.ts.
 */
export const DRAP_BAND_RAMP = [
  [90, 200, 120],
  [140, 214, 74],
  [186, 222, 44],
  [226, 220, 34],
  [246, 198, 30],
  [250, 166, 26],
  [250, 130, 24],
  [246, 92, 30],
  [232, 52, 44],
  [204, 24, 70]
]

/**
 * Where a cutoff sits on that ramp: the number of band edges it has passed,
 * interpolated across the gap to the next so the contours have a shoulder
 * rather than aliasing into a jagged edge.
 */
export function drapRampStop(cutoffHz) {
  const mhz = cutoffHz / 1e6
  const edges = MARINE_SSB_BAND_EDGES_HZ.map((hz) => hz / 1e6)
  if (mhz >= edges[edges.length - 1]) return DRAP_BAND_RAMP.length - 1
  for (let b = 0; b < edges.length; b++) {
    if (mhz >= edges[b]) continue
    const previous = b === 0 ? 0 : edges[b - 1]
    return b + Math.min(1, Math.max(0, (mhz - previous) / (edges[b] - previous)))
  }
  return 0
}

/**
 * `rgba(...)` for one map cell, or null where nothing a marine SSB set can
 * hear is absorbed -- absorption below the lowest band is not worth putting
 * ink on the chart for.
 */
export function drapCellColor(cutoffHz) {
  if (!(cutoffHz > 0) || cutoffHz < MARINE_SSB_BAND_EDGES_HZ[0]) return null
  const stop = drapRampStop(cutoffHz)
  const seg = Math.min(DRAP_BAND_RAMP.length - 2, Math.floor(stop))
  const t = Math.min(1, stop - seg)
  const a = DRAP_BAND_RAMP[seg]
  const b = DRAP_BAND_RAMP[seg + 1]
  const alpha = 0.22 + 0.53 * Math.min(1, stop / (DRAP_BAND_RAMP.length - 1))
  return `rgba(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(
    a[1] + (b[1] - a[1]) * t
  )},${Math.round(a[2] + (b[2] - a[2]) * t)},${alpha.toFixed(3)})`
}
