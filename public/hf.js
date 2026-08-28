// What the HF Radio tile says, decided separately from how it is drawn -- the
// same split as hero.js and scales.js, and for the same reason: every choice
// below is a judgement about what the plugin is entitled to claim, and a
// judgement belongs somewhere a test can reach it.
import { leafMeta, leafTime, leafValue } from './signalk.js'

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

/**
 * The frequency axis every D-RAP surface is drawn against, in MHz. NOAA's own
 * colorbar runs 0-35, `public/drapMap.js` re-exports this as `LEGEND_MAX_MHZ`
 * for the map legend, and the HF tile's gauge uses the same span -- a reader
 * who has just looked at the map must not have to re-learn the scale to read
 * the tile.
 */
export const HF_SCALE_MAX_MHZ = 35

/** NOAA's own label interval on that axis. */
const HF_SCALE_STEP_MHZ = 5

const clamp01 = (n) => Math.min(1, Math.max(0, n))

/**
 * The HF window as one linear gauge, 0-35 MHz.
 *
 * Replaces the nine equal-width band chips. The chips were a ladder of
 * *names*, so 2 and 4 MHz sat as far apart as 18 and 22, and nothing on them
 * could be compared with the map's own frequency axis. The marine SSB edges
 * survive as tick marks at their true positions -- `MARINE_SSB_BAND_EDGES_HZ`
 * is still the list, and still the same list the D-RAP zone ladder is built
 * from -- but the scale is now frequency, not band ordinal.
 *
 * Two ends, and only one of them is measured. The floor is D-RAP absorption
 * (the LUF): everything below `cutoffHz` is blocked from underneath. The
 * ceiling is the MUF, and issue #82 still stands -- nothing in this plugin
 * measures the F2 layer. So `mufHz` is null until a source lands, and the
 * gauge says so with a hatched "ceiling unmeasured" region rather than
 * painting the space above the cutoff as open. The open window is only ever
 * drawn between two measured ends.
 */
export function hfGauge(cutoffHz, mufHz = null) {
  const fraction = (hz) =>
    hz === null ? null : clamp01(hz / 1e6 / HF_SCALE_MAX_MHZ)
  const ticks = []
  for (let mhz = 0; mhz <= HF_SCALE_MAX_MHZ; mhz += HF_SCALE_STEP_MHZ)
    ticks.push({ mhz, fraction: mhz / HF_SCALE_MAX_MHZ })

  const absorbedFraction = fraction(cutoffHz)
  const mufFraction = fraction(mufHz)
  const openFrom = absorbedFraction ?? 0
  return {
    maxMhz: HF_SCALE_MAX_MHZ,
    ticks,
    // Same claim the chips made, at the frequency it is actually true at.
    bandEdges: MARINE_SSB_BAND_EDGES_HZ.map((hz) => ({
      hz,
      mhz: hz / 1e6,
      fraction: fraction(hz),
      absorbed: cutoffHz !== null && cutoffHz >= hz
    })),
    cutoffHz,
    mufHz,
    absorbedFraction,
    mufFraction,
    // A null cutoff absorbs nothing, but it also clears nothing: with no
    // reading at either end the whole axis is unknown, not open. A null
    // cutoff with a *known* MUF is the same claim over the shorter span
    // below it -- the region has to close at the MUF rather than run to the
    // top, or it draws as bare track: `to > from` in the renderer's `seg()`
    // is false against a null `to`.
    unknownFrom: cutoffHz === null ? 0 : mufHz === null ? openFrom : null,
    unknownTo: mufHz === null ? 1 : cutoffHz === null ? mufFraction : null,
    openFrom: cutoffHz !== null && mufHz !== null ? openFrom : null,
    openTo:
      cutoffHz !== null && mufHz !== null
        ? Math.max(openFrom, mufFraction)
        : null,
    // Above a known MUF is closed from above, which is a measurement and not
    // an absence -- so it is painted, not hatched. A cutoff *above* the MUF
    // is the blackout case rather than an error: the two ends cross, the open
    // window is empty, and both closed regions still say something true.
    aboveFrom: mufFraction,
    aboveTo: mufHz === null ? null : 1,
    windowClosed:
      cutoffHz !== null && mufHz !== null && mufFraction <= openFrom,
    ceilingUnmeasured: mufHz === null,
    // Distinct from ceilingUnmeasured: this is the D-RAP-not-published case
    // with an otherwise-derivable MUF, which needs its own legend line so it
    // doesn't claim an "Open" swatch that nothing was drawn for.
    floorUnmeasured: cutoffHz === null && mufHz !== null
  }
}

/**
 * The solar flux gauge, built from the Signal K path's own `meta.zones` where
 * the server hands them over, and from `F107_BANDS` where it does not.
 *
 * The zones are the same ladder either way -- `zonesForF107` in src/parse.ts
 * is what publishes them and `hf-render.test.ts` pins the two identical -- but
 * preferring the metadata means the gauge follows the plugin's published
 * thresholds rather than a second copy of them, which is the whole point of
 * publishing a zone ladder at all.
 */
export const F107_SCALE_MAX_SFU = 250

/** "Poor HF conditions" is a notification message; a gauge tick is not the
 * place for the noun it already sits under. */
function zoneLabel(message, index) {
  if (typeof message !== 'string' || message === '') {
    return F107_BANDS[index]?.label ?? ''
  }
  return message.replace(/\s*HF conditions$/, '').replace(/essentially /, '')
}

export function f107Zones(meta) {
  const zones = Array.isArray(meta?.zones) ? meta.zones : null
  // Sorted before `key`/`label` are assigned by index -- the published order
  // is ascending today, but assigning first and sorting after would silently
  // pair each zone with the wrong band the day it isn't.
  const source =
    zones && zones.length
      ? zones
          .map((zone) => ({
            from: Number.isFinite(Number(zone.lower)) ? Number(zone.lower) : 0,
            message: zone.message
          }))
          .sort((a, b) => a.from - b.from)
          .map((zone, i) => ({
            from: zone.from,
            key: F107_BANDS[i]?.key ?? F107_BANDS[F107_BANDS.length - 1].key,
            label: zoneLabel(zone.message, i)
          }))
      : F107_BANDS.map((band) => ({ ...band }))
  return source
    .slice()
    .sort((a, b) => a.from - b.from)
    .map((band, i, all) => {
      const to = i === all.length - 1 ? F107_SCALE_MAX_SFU : all[i + 1].from
      return {
        ...band,
        to,
        fraction: clamp01(band.from / F107_SCALE_MAX_SFU),
        width:
          clamp01(to / F107_SCALE_MAX_SFU) -
          clamp01(band.from / F107_SCALE_MAX_SFU)
      }
    })
}

/**
 * Where a reading sits on that ladder, and which band it is in. The band is
 * looked up in the same list the gauge draws, so the coloured word and the
 * needle can never name different bands.
 */
export function f107Gauge(sfu, meta) {
  const bands = f107Zones(meta)
  let band = null
  if (sfu !== null) {
    band = bands[0]
    for (const candidate of bands) if (sfu >= candidate.from) band = candidate
  }
  return {
    maxSfu: F107_SCALE_MAX_SFU,
    bands,
    value: sfu,
    // Clamped, not dropped: a reading past the top of the scale still has to
    // put the needle somewhere, and the number is printed beside it anyway.
    fraction: sfu === null ? null : clamp01(sfu / F107_SCALE_MAX_SFU),
    overflow: sfu !== null && sfu > F107_SCALE_MAX_SFU,
    band
  }
}

/**
 * A best-effort MUF, and everything about it is a stated choice rather than a
 * measurement. Issue #82 is still open: no NOAA product this plugin fetches
 * carries foF2 or MUF, so what follows is a model built from numbers the
 * plugin already has -- F10.7, the vessel's position, the clock, and Kp.
 *
 * The form is textbook Chapman, as `docs/hf-operator-view.md` sets it out:
 * ionisation goes as EUV x cos(zenith), electron density as its square root
 * and critical frequency as the square root of that, so
 *
 *   foF2  proportional to  (F10.7 x cos X)^(1/4)
 *   MUF(3000)  =  M x foF2,  M ~= 3
 *
 * The constant of proportionality is the part no textbook supplies, and the
 * doc is explicit that a regression quoted from memory is exactly the kind of
 * plausible-and-wrong number that survives review. So instead of a fitted
 * coefficient this anchors on two figures a reader can argue with directly,
 * both written here as the assumptions they are:
 *
 *   - mid-latitude local noon at F10.7 = 150 gives foF2 ~ 10 MHz;
 *   - foF2 at night falls to roughly a third of that, not to zero.
 *
 * The second is the one that matters. A bare cos(X) term drives the estimate
 * to zero after sunset, but the real F2 layer survives the night on transport
 * and plasmaspheric refill -- which is why the low bands open in the evening,
 * the hours a sailor's nets actually run. Rather than extrapolate into that
 * silently, cos(X) is floored, so the night estimate is a stated fraction of
 * the noon one and never a claim that nothing works.
 *
 * Every surface that draws this labels it estimated. It is deliberately NOT
 * published to the Signal K tree: a modelled number on a path beside measured
 * ones is read as measured by every consumer that is not this webapp.
 */
export const MUF_M_FACTOR = 3

/** foF2 at mid-latitude local noon with F10.7 at the anchor flux, in MHz. */
export const FOF2_NOON_MHZ = 10
export const FOF2_ANCHOR_SFU = 150

/**
 * The night floor, as a fraction of the same-flux noon value. Applied to
 * cos(X) rather than to the result -- `NIGHT_RATIO ** 4`, since the quarter
 * power is what the estimate takes -- so the curve into night is continuous
 * instead of stepping onto a floor.
 */
export const FOF2_NIGHT_RATIO = 0.35
const COS_ZENITH_FLOOR = FOF2_NIGHT_RATIO ** 4

/**
 * How much of the F2 layer a storm takes away, per unit of Kp, at high
 * latitude. Convention, like the F10.7 bands: the depression is real and
 * strongly latitude-weighted, and no published coefficient is being quoted.
 * Floored so the estimate can be badly hurt but never annihilated.
 */
const STORM_PENALTY_PER_KP = 0.04
const STORM_PENALTY_FLOOR = 0.5
const STORM_LATITUDE_FULL_DEG = 60

const RADIANS = Math.PI / 180

/**
 * cos of the solar zenith angle at a position and instant.
 *
 * The equation of time is left out: it moves apparent noon by up to about a
 * quarter hour, which moves a quarter-power term by well under a percent --
 * far inside the error of everything else here.
 */
export function cosSolarZenith(latitude, longitude, at) {
  const time = at instanceof Date ? at : new Date(at)
  if (!Number.isFinite(time.getTime())) return null
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null

  const startOfYear = Date.UTC(time.getUTCFullYear(), 0, 1)
  const dayOfYear = (time.getTime() - startOfYear) / 86_400_000
  // Obliquity, about the solstice: the standard low-precision declination.
  const declination =
    -23.44 * Math.cos(RADIANS * ((360 / 365.24) * (dayOfYear + 10)))
  const utcHours =
    time.getUTCHours() + time.getUTCMinutes() / 60 + time.getUTCSeconds() / 3600
  const hourAngle = 15 * (utcHours - 12) + longitude

  return (
    Math.sin(RADIANS * latitude) * Math.sin(RADIANS * declination) +
    Math.cos(RADIANS * latitude) *
      Math.cos(RADIANS * declination) *
      Math.cos(RADIANS * hourAngle)
  )
}

/** The storm term: full weight past 60 degrees, none at the equator. */
function stormFactor(kp, latitude) {
  if (!Number.isFinite(kp)) return 1
  const weight = Math.min(1, Math.abs(latitude) / STORM_LATITUDE_FULL_DEG)
  return Math.max(STORM_PENALTY_FLOOR, 1 - STORM_PENALTY_PER_KP * kp * weight)
}

/** The estimate itself, in MHz, or null where an input is missing. */
export function estimateFoF2({ sfu, latitude, longitude, at, kp }) {
  if (!Number.isFinite(sfu) || sfu <= 0) return null
  const cosZenith = cosSolarZenith(latitude, longitude, at)
  if (cosZenith === null) return null
  const lit = Math.max(COS_ZENITH_FLOOR, cosZenith)
  return (
    FOF2_NOON_MHZ *
    (sfu / FOF2_ANCHOR_SFU) ** 0.25 *
    lit ** 0.25 *
    stormFactor(kp, latitude)
  )
}

/** MUF(3000) in Hz, the same units the measured path would carry. */
export function estimateMufHz(inputs) {
  const foF2 = estimateFoF2(inputs)
  return foF2 === null ? null : foF2 * MUF_M_FACTOR * 1e6
}

export function hfCard(data, at = new Date()) {
  const cutoffHz = numberOrNull(data?.drap?.highest_affected_frequency)
  const sfu = numberOrNull(data?.f107)
  const protonPfu = toPfu(numberOrNull(data?.protonFlux))
  const ratio = numberOrNull(data?.xrayFlux?.trend)
  // A measured MUF if one is ever published, and the model above if not.
  // Measured wins without question: the estimate exists because issue #82 is
  // open, and it should stop being drawn the moment it stops being the only
  // thing available. `mufEstimated` is what every surface labels.
  const measuredMufHz = numberOrNull(data?.muf)
  const position = leafValue(data?.position)
  const estimatedMufHz =
    measuredMufHz !== null
      ? null
      : estimateMufHz({
          sfu,
          latitude: position?.latitude,
          longitude: position?.longitude,
          at,
          kp: numberOrNull(data?.kp?.observed)
        })
  const mufHz = measuredMufHz ?? estimatedMufHz

  return {
    cutoffHz,
    cutoffAt: leafTime(data?.drap?.highest_affected_frequency),
    mufHz,
    mufEstimated: measuredMufHz === null && mufHz !== null,
    mufAt: leafTime(data?.muf),
    gauge: hfGauge(cutoffHz, mufHz),
    sfuGauge: f107Gauge(sfu, leafMeta(data?.f107)),
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
 * The band-ladder ramp: one stop per marine SSB band the cutoff has passed.
 *
 * No longer a map palette. Both maps -- the chart-plotter overlay and the
 * webapp's own -- now draw NOAA's published D-RAP colorbar
 * (`public/drap-colors.js`, mirrored in src/tiles.ts and pinned by
 * test/drap-colors.test.ts), so that a reader comparing this plugin against
 * NOAA's own image sees one picture rather than two
 * (https://github.com/mark-brannan/signalk-noaa-space-weather/issues/170).
 *
 * What survives here is the HF tile's band strip, where stops rather than a
 * smooth scale is still the right encoding: the strip is a ladder of bands,
 * not a field of frequencies, and what changes for its reader is a band going
 * under. See `zonesForDrap` in src/parse.ts. The map carries the same
 * information as contour lines over NOAA's colours instead.
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
    return (
      b + Math.min(1, Math.max(0, (mhz - previous) / (edges[b] - previous)))
    )
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
