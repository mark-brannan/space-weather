// Where it is day, computed from the clock and nothing else.
//
// Greyline propagation is the classic HF phenomenon: along the day/night
// terminator the D layer has already collapsed (or not yet formed) while the
// F layer still reflects, briefly opening low-band paths that neither full
// day nor full night allows. It is also the context the other two layers
// were missing -- D-RAP absorption is a dayside phenomenon, and the auroral
// oval is only visible on the night side -- so the map should say where day
// is.
//
// Pure astronomy: no network, no fetch, no cache to go stale. The one layer
// on this map that is exactly as right at sea with no link as it is at the
// dock (https://github.com/mark-brannan/signalk-noaa-space-weather/issues/85).

const toRad = (deg) => (deg * Math.PI) / 180
const toDeg = (rad) => (rad * 180) / Math.PI

/**
 * The subsolar point: where the sun is overhead right now.
 *
 * Low-precision solar position (NOAA's own "General Solar Position
 * Calculations", good to a few arc-minutes) -- far finer than a 4-degree
 * D-RAP cell or a raster pixel at world scale.
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
 * The sun's geometric elevation above the horizon at a point, in degrees.
 *
 * 90 minus the great-circle angle to the subsolar point. No refraction and no
 * solar disc: together they move the visible sunrise by under a degree, well
 * inside the twilight band this is drawn as.
 */
export function solarElevationDeg(sun, latitude, longitude) {
  const lat = toRad(latitude)
  const dec = toRad(sun.latitude)
  const cosZenith =
    Math.sin(lat) * Math.sin(dec) +
    Math.cos(lat) * Math.cos(dec) * Math.cos(toRad(longitude - sun.longitude))
  return toDeg(Math.asin(Math.max(-1, Math.min(1, cosZenith))))
}

/**
 * The standard twilights: the sun's centre 6, 12 and 18 degrees below the
 * horizon.
 */
export const TWILIGHT_DEG = { civil: -6, nautical: -12, astronomical: -18 }

/**
 * Solar elevation as a raster sampler: `(lat, lon) => degrees`, for one
 * instant. The subsolar point is solved once per draw, not once per pixel.
 */
export function greylineSampler(date = new Date()) {
  const sun = subsolarPoint(date)
  return (lat, lon) => solarElevationDeg(sun, lat, lon)
}

// The map's ground is near-black in both themes (spaceMap.js MAP_GROUND), so
// shading the night would be black on black. The day side is lit instead,
// with a cool wash the D-RAP colorbar and the aurora ramp both sit over
// without borrowing a hue from either, and the night is left as the ground.
const DAY = [96, 118, 150]
const DAY_ALPHA = 0.3
// The greyline itself, civil twilight, drawn warmer and a touch brighter than
// day so the band where the low bands open reads as a band, not merely as the
// edge of the wash.
const GREY = [178, 166, 150]
const GREY_ALPHA = 0.36

/**
 * `[r, g, b, alpha]` for a solar elevation, in mapRaster's convention, or null
 * for "leave the ground": day lit, civil twilight as a distinct band, then
 * nautical and astronomical twilight fading out to night.
 */
export function greylineColor(elevationDeg) {
  if (!Number.isFinite(elevationDeg)) return null
  if (elevationDeg >= 0) {
    // A degree of feather on the sunlit side, so the band has an edge rather
    // than a seam.
    return mix(GREY, GREY_ALPHA, DAY, DAY_ALPHA, Math.min(1, elevationDeg))
  }
  if (elevationDeg >= TWILIGHT_DEG.civil) return [...GREY, GREY_ALPHA]
  if (elevationDeg <= TWILIGHT_DEG.astronomical) return null
  const t =
    (elevationDeg - TWILIGHT_DEG.astronomical) /
    (TWILIGHT_DEG.civil - TWILIGHT_DEG.astronomical)
  // Continuous with the band at -6: a step there drew civil twilight as a
  // wall on its night side, and the edge that matters is sunrise, not -6.
  return [...GREY, GREY_ALPHA * t * t]
}

function mix(from, fromAlpha, to, toAlpha, t) {
  return [
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
    fromAlpha + (toAlpha - fromAlpha) * t
  ]
}

/** Legend swatches, drawn from `greylineColor` so they cannot disagree. */
export function greylineLegend() {
  return [
    { label: 'Day', elevationDeg: 10 },
    { label: 'Greyline', elevationDeg: -3 },
    { label: 'Twilight', elevationDeg: -10 },
    { label: 'Night', elevationDeg: -30 }
  ].map((stop) => ({ ...stop, rgba: greylineColor(stop.elevationDeg) }))
}
