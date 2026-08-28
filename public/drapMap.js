// D-RAP absorption: what the grid says at a point, and what a path across it
// costs. Pure functions only -- no canvas, no DOM -- so test/drap-map.test.ts
// can ask the same questions the map does without a browser. The drawing that
// used to live at the bottom of this file is spaceMap.js, which draws every
// layer through every projection rather than this one product through one.
import { HF_SCALE_MAX_MHZ, MARINE_SSB_BAND_EDGES_HZ } from './hf.js'
import { drapNoaaLegend } from './drap-colors.js'

const FLOOR_MHZ = MARINE_SSB_BAND_EDGES_HZ[0] / 1e6

/** The scale the legend and the map are both drawn against, in MHz. One
 * constant, defined beside the HF tile's gauge, because the tile and the map
 * legend now draw the same axis and a drift between them would be invisible. */
export const LEGEND_MAX_MHZ = HF_SCALE_MAX_MHZ

/** NOAA's own label interval on that bar. Not a parameter: there is one
 * legend, and a caller free to pass 0 could only hang the loop. */
const LEGEND_STEP_MHZ = 5

/**
 * The legend bar: NOAA's own 0-35 MHz colorbar, sampled finely enough to read
 * as the continuous hue sweep it is.
 *
 * This used to be one swatch per marine SSB band edge, drawn from the band
 * ramp. The colours now match NOAA's published D-RAP product on every surface
 * (https://github.com/mark-brannan/signalk-noaa-space-weather/issues/170), so
 * the bar has to be NOAA's bar -- a legend that disagreed with the picture
 * beside it would be worse than either choice on its own.
 */
export function legendStops(steps = 24) {
  return drapNoaaLegend(steps)
}

/**
 * Where the marine SSB band edges fall on that bar, as a fraction of its
 * width.
 *
 * NOAA's colorbar answers "how much is absorbed"; a sailor asks "which of my
 * bands has gone under". These are what carry the second question onto the
 * first one's scale, both as ticks on the legend and as contours on the map
 * (`BAND_EDGE_MHZ` in spaceMap.js).
 */
/**
 * The legend's own axis: NOAA labels its D-RAP colorbar every 5 MHz, and this
 * is that. Kept separate from `bandEdgeTicks` because the two answer different
 * questions and only one of them is a scale -- the band edges say which of a
 * sailor's bands has gone under, and stay the map's contours and the HF tile's
 * strip, but they are not the numbers NOAA prints and a reader coming from
 * NOAA's product reads them as a deviation.
 */
export function legendMhzTicks() {
  const ticks = []
  for (let mhz = 0; mhz <= LEGEND_MAX_MHZ; mhz += LEGEND_STEP_MHZ)
    ticks.push({ mhz, fraction: mhz / LEGEND_MAX_MHZ })
  return ticks
}

export function bandEdgeTicks() {
  return MARINE_SSB_BAND_EDGES_HZ.map((hz) => {
    const mhz = hz / 1e6
    return {
      mhz,
      // Plain, never "25.07+": the bar used to stop at the highest band edge,
      // and it now runs to NOAA's own 35 MHz, so a "+" on the top tick would
      // claim the scale ends two-thirds of the way along it.
      label: String(mhz),
      fraction: Math.min(1, mhz / LEGEND_MAX_MHZ)
    }
  })
}

/**
 * The cutoff in MHz at a position, by nearest cell -- the same answer
 * `drapFrequencyAt` publishes for the vessel, so the number under the boat's
 * marker and the number on the Signal K path cannot disagree.
 *
 * Nearest cell rather than an interpolation: this is what NOAA modelled, and
 * a smoothed value at a point would read as more precise than 2x4 degrees of
 * grid can support.
 */
export function cutoffAt(grid, latitude, longitude) {
  if (!grid || !Array.isArray(grid.frequenciesMHz)) return null
  if (!Array.isArray(grid.latitudes) || !Array.isArray(grid.longitudes)) {
    return null
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  const latCount = grid.latitudes.length
  const lonCount = grid.longitudes.length
  if (latCount < 2 || lonCount < 2) return null
  // Row 0 is the northernmost latitude, column 0 the westernmost longitude,
  // and the step is whatever gap separates the first two samples -- the same
  // geometry `drapLattice` (src/tiles.ts) derives from the grid rather than
  // assuming NOAA's usual 90x90 / 2x4 degree shape.
  const latStep = Math.abs(grid.latitudes[0] - grid.latitudes[1])
  const lonStep = Math.abs(grid.longitudes[1] - grid.longitudes[0])
  // Clamped: the last row's centre is short of the pole's own 90, so a
  // position at the pole itself would otherwise round one row past the end
  // of the grid.
  const row = Math.min(
    latCount - 1,
    Math.max(0, Math.round((grid.latitudes[0] - clampLat(latitude)) / latStep))
  )
  const wrapped = (((longitude - grid.longitudes[0]) % 360) + 360) % 360
  const col = Math.round(wrapped / lonStep) % lonCount
  const value = grid.frequenciesMHz[row]?.[col]
  return Number.isFinite(value) ? value : null
}

const clampLat = (lat) => (lat > 90 ? 90 : lat < -90 ? -90 : lat)
const toRad = (deg) => (deg * Math.PI) / 180
const toDeg = (rad) => (rad * 180) / Math.PI
const EARTH_RADIUS_KM = 6371

/** Great-circle distance in km. */
export function distanceKm(from, to) {
  const dLat = toRad(to.latitude - from.latitude)
  const dLon = toRad(to.longitude - from.longitude)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.latitude)) *
      Math.cos(toRad(to.latitude)) *
      Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** Initial great-circle bearing in degrees true. */
export function bearingDeg(from, to) {
  const φ1 = toRad(from.latitude)
  const φ2 = toRad(to.latitude)
  const Δλ = toRad(to.longitude - from.longitude)
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

/**
 * Points along the great circle from `from` to `to`, inclusive of both ends.
 *
 * Step: about 100 km, which is under a degree of arc and so finer than the
 * 2x4 degree grid at every latitude -- no cell the path crosses can be
 * stepped over. Bounded at both ends because the interesting cases are a
 * 30 km harbour hop (which still needs both endpoints) and an antipodal
 * Winlink path (which does not need four thousand samples to be honest).
 *
 * Walked from the initial bearing rather than slerped between the two
 * endpoint vectors: the slerp weights divide by sin(deltaAngular), and near
 * the exact antipode that denominator gets small without ever hitting the
 * `deltaAngular === 0` guard, so two huge, nearly-opposite vectors get
 * summed and the cancellation is numerically garbage. Walking the bearing
 * forward never divides by the path length, so it stays stable all the way
 * to (and through) the antipode.
 */
export function greatCirclePoints(from, to, stepKm = 100) {
  const total = distanceKm(from, to)
  const steps = Math.min(400, Math.max(2, Math.ceil(total / stepKm)))
  const totalAngular = total / EARTH_RADIUS_KM
  const φ1 = toRad(from.latitude)
  const λ1 = toRad(from.longitude)
  const θ = toRad(bearingDeg(from, to))
  const points = []
  for (let i = 0; i <= steps; i++) {
    if (totalAngular === 0) {
      points.push({ latitude: from.latitude, longitude: from.longitude })
      continue
    }
    const δ = (i / steps) * totalAngular
    const φ2 = Math.asin(
      Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
    )
    const λ2 =
      λ1 +
      Math.atan2(
        Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
        Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
      )
    points.push({
      latitude: toDeg(φ2),
      // Normalised to -180..180, the same range atan2 always returned before
      // -- λ1 + a step can otherwise walk past either edge.
      longitude: ((((toDeg(λ2) + 180) % 360) + 360) % 360) - 180
    })
  }
  return points
}

/**
 * What a path costs: the worst cutoff anywhere along it, and the mean.
 *
 * The worst is the headline, and it is the honest one -- absorption anywhere
 * on the path attenuates the whole path, so a band that clears the mean and
 * not the worst does not get through. The mean is reported beside it because
 * a single bad cell on a long path is a different situation from a path that
 * is bad end to end, and only the pair distinguishes them.
 */
export function pathAbsorption(grid, from, to) {
  if (!grid || !from || !to) return null
  const points = greatCirclePoints(from, to)
  let worstMHz = null
  let worstAt = null
  let sum = 0
  let counted = 0
  for (const point of points) {
    const mhz = cutoffAt(grid, point.latitude, point.longitude)
    if (mhz === null) continue
    sum += mhz
    counted++
    if (worstMHz === null || mhz > worstMHz) {
      worstMHz = mhz
      worstAt = point
    }
  }
  if (!counted) return null
  return {
    worstMHz,
    worstAt,
    meanMHz: sum / counted,
    distanceKm: distanceKm(from, to),
    bearingDeg: bearingDeg(from, to),
    samples: counted,
    points
  }
}

/**
 * The subsolar point: where the sun is overhead right now.
 *
 * D-region absorption is a dayside phenomenon, so this is the one mark that
 * makes the picture readable at a glance -- the blob belongs near it, and a
 * blob that is not is worth a second look. Low-precision solar position
 * (NOAA's own "General Solar Position Calculations", good to a few
 * arc-minutes), which is far finer than a 4-degree grid cell.
 */
export function subsolarPoint(date = new Date()) {
  const julian = date.getTime() / 86400000 + 2440587.5
  const n = julian - 2451545.0
  const meanLongitude = (280.46 + 0.9856474 * n) % 360
  const meanAnomaly = toRad((357.528 + 0.9856003 * n) % 360)
  const eclipticLongitude = toRad(
    meanLongitude +
      1.915 * Math.sin(meanAnomaly) +
      0.02 * Math.sin(2 * meanAnomaly)
  )
  const obliquity = toRad(23.439 - 0.0000004 * n)
  const declination = toDeg(
    Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude))
  )
  const rightAscension = toDeg(
    Math.atan2(
      Math.cos(obliquity) * Math.sin(eclipticLongitude),
      Math.cos(eclipticLongitude)
    )
  )
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24
  let longitude = (rightAscension - gmst * 15) % 360
  if (longitude > 180) longitude -= 360
  if (longitude < -180) longitude += 360
  return { latitude: declination, longitude }
}

/**
 * The worst cell anywhere on the globe, and where it is.
 *
 * A quiet D-RAP grid is entirely below the lowest marine band, so the map
 * draws nothing at all -- which is the correct picture and an ambiguous one:
 * blank also looks like a grid that failed to load. This is what lets the
 * page say which it is.
 */
export function gridSummary(grid) {
  if (!grid || !Array.isArray(grid.frequenciesMHz)) return null
  let maxMHz = null
  let at = null
  for (let row = 0; row < grid.frequenciesMHz.length; row++) {
    const cells = grid.frequenciesMHz[row]
    if (!Array.isArray(cells)) continue
    for (let col = 0; col < cells.length; col++) {
      const value = cells[col]
      if (!Number.isFinite(value)) continue
      if (maxMHz === null || value > maxMHz) {
        maxMHz = value
        at = {
          latitude: grid.latitudes?.[row],
          longitude: grid.longitudes?.[col]
        }
      }
    }
  }
  return maxMHz === null ? null : { maxMHz, at, quiet: maxMHz < FLOOR_MHZ }
}
