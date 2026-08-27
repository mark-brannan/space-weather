// Map projections for the webapp's maps, and the viewport that turns one into
// pixels. Pure maths, no canvas and no DOM, so test/projection.test.ts can ask
// a projection the same questions the map does without a browser.
//
// Two projections, because the two things a reader wants from these grids are
// genuinely different pictures:
//
//   azimuthal equidistant, centred on the vessel -- the ham operator's map. A
//     straight line from the centre *is* a great circle, which for an
//     absorption product is the propagation path itself, so the probe's line
//     is semantic rather than decorative. It also shows a pole, which no
//     cylindrical projection can, and polar absorption is half of what these
//     maps exist to show. The argument is on
//     https://github.com/mark-brannan/signalk-noaa-space-weather/issues/174
//
//   equidistant cylindrical -- the flat rectangle everybody recognises, which
//     is what you want when you are comparing against NOAA's own published
//     image rather than planning a path.
//
// Every projection here exposes the same four things, so the renderer never
// branches on which one it was handed: `forward`, `inverse`, `radiusWorld`
// and `separable`. Adding a third (Winkel tripel is the runner-up in #174) is
// one more entry in PROJECTIONS and nothing else.

const D2R = Math.PI / 180
const R2D = 180 / Math.PI

/** Normalises a longitude difference onto -180..180. */
function wrapDelta(deg) {
  let d = deg % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}

/**
 * Azimuthal equidistant, centred on (lat0, lon0).
 *
 * World units are radians of arc: a point's distance from the origin is its
 * true great-circle distance from the centre, and its bearing from the centre
 * is exact. y increases northward (mathematical convention); the viewport
 * flips it when it converts to canvas pixels.
 *
 * The one singularity is the antipode of the centre, where every bearing maps
 * to the same real point but spreads across the whole boundary circle here.
 * `c` is clamped just short of pi so a point that lands there -- or a rounding
 * error that overshoots pi -- renders at the disc's edge instead of returning
 * NaN. Nothing is lost: the antipode is a single geographic point regardless
 * of which edge pixel draws it.
 */
function createAzimuthal(lat0, lon0) {
  const phi0 = lat0 * D2R
  const lam0 = lon0 * D2R
  const sinPhi0 = Math.sin(phi0)
  const cosPhi0 = Math.cos(phi0)

  return {
    id: 'azimuthal',
    // A segment between two neighbouring coastline points is only nonsense
    // when it straddles the antipode, which no meridian test can catch --
    // see `strokeRings` in spaceMap.js.
    separable: false,
    center: { latitude: lat0, longitude: lon0 },
    radiusWorld: (deg) => Math.min(180, Math.max(1, deg)) * D2R,
    // Cover, not fit: the disc reaches every edge and its far fringe -- the
    // most distorted and least useful part of the picture -- overflows,
    // rather than leaving the tile's sides empty. Wasted space on both sides
    // of the map is the specific complaint issue #177 was filed about.
    scaleFor: (radius, width, height) => Math.max(width, height) / 2 / radius,
    // A disc is centred wherever it is asked to be; there is no edge of the
    // world for it to overhang.
    clampCenter: (lat) => lat,
    forward(lon, lat) {
      const phi = lat * D2R
      const dLambda = wrapDelta(lon - lon0) * D2R
      const cosC =
        sinPhi0 * Math.sin(phi) + cosPhi0 * Math.cos(phi) * Math.cos(dLambda)
      let c = Math.acos(Math.max(-1, Math.min(1, cosC)))
      if (c < 1e-9) return [0, 0]
      if (c > Math.PI - 1e-6) c = Math.PI - 1e-6
      const dx = Math.cos(phi) * Math.sin(dLambda)
      const dy = cosPhi0 * Math.sin(phi) - sinPhi0 * Math.cos(phi) * Math.cos(dLambda)
      // (dx, dy) has magnitude sin(c), so dividing by it (rather than by
      // sin(c) directly, as k = c / sin(c) does) is the same scaling but
      // survives the case that sank near the antipode: c/sin(c) blows up as
      // sin(c) -> 0 while dx and dy are *also* collapsing toward 0 there
      // (sin(dLambda) -> sin(pi) = 0), and the two limits don't cancel
      // cleanly in floating point -- the product lands near [0, 0], the
      // centre, instead of on the boundary circle the docstring above
      // promises. Normalising by the vector's own magnitude keeps the
      // result on the circle of radius c right up to the antipode, where
      // dx and dy underflow to exactly 0 and the fallback below picks one
      // of the (equally valid, per the docstring) boundary points.
      const norm = Math.hypot(dx, dy)
      if (norm < 1e-12) return [c, 0]
      return [(dx / norm) * c, (dy / norm) * c]
    },
    inverse(x, y) {
      const c = Math.hypot(x, y)
      // Outside the boundary circle is not anywhere on the planet, which is
      // what lets the rasteriser leave the disc's corners transparent rather
      // than wrapping the far side of the world back into them.
      if (c > Math.PI) return null
      if (c < 1e-12) return { latitude: lat0, longitude: lon0 }
      const sinC = Math.sin(c)
      const cosC = Math.cos(c)
      const latitude =
        Math.asin(cosC * sinPhi0 + (y * sinC * cosPhi0) / c) * R2D
      const longitude =
        lon0 +
        Math.atan2(x * sinC, c * cosPhi0 * cosC - y * sinPhi0 * sinC) * R2D
      return { latitude, longitude: wrapDelta(longitude) }
    }
  }
}

/**
 * Equidistant cylindrical, centred on (lat0, lon0).
 *
 * The standard parallel is the interesting part. At the equator this is plain
 * plate carree; at the centre latitude it is the `lonScaleFactor` correction
 * the aurora map used to apply by hand, which is what keeps a regional window
 * at 65N from being drawn two and a half times wider than it is tall.
 *
 * Which one is right depends on how much world is on screen, so it is
 * interpolated between them by extent rather than picked once: preserving
 * local shape is a local idea, and a hemispheric map has no single local
 * shape left to preserve. Past 90 degrees of arc the correction is gone
 * entirely, which is what lets zooming out end at a 2:1 world rectangle
 * rather than at a squeezed one that cannot reach either pole.
 *
 * Clamped at 70 degrees: past that cos(phi0) shrinks fast enough that a small
 * change in the vessel's latitude visibly rescales the map underneath the
 * reader.
 */
function createCylindrical(lat0, lon0, radiusDeg = 0) {
  // Full correction out to 20 degrees of arc, none past 90, interpolated
  // between. On the factor rather than on the angle: it is the width of a
  // degree of longitude that is being blended, and blending the angle
  // under-corrects a close-up by a third.
  const local = Math.max(0, Math.min(1, 1 - (radiusDeg - 20) / 70))
  const cosStandard =
    1 - (1 - Math.cos(Math.min(70, Math.abs(lat0)) * D2R)) * local

  return {
    id: 'cylindrical',
    // x depends only on longitude and y only on latitude, which is what lets
    // the coastline be drawn with coast-wright's own seam guard.
    separable: true,
    center: { latitude: lat0, longitude: lon0 },
    // Half-height in degrees of latitude, and there are only 90 of those
    // between the centre and a pole -- zooming "out" past that on a
    // cylindrical map buys nothing but empty sky.
    radiusWorld: (deg) => Math.min(90, Math.max(1, deg)),
    // Fit the latitude span to the height, but never at a scale that would
    // show more than one whole turn of longitude across the width: past that
    // the map starts drawing the same ocean twice -- and, before this
    // accounted for the standard parallel, ran out of planet a third of the
    // way in from each edge and drew the rest as empty page.
    scaleFor: (radius, width, height) =>
      Math.max(height / 2 / radius, width / (360 * cosStandard)),
    // A window 77 degrees tall cannot be centred at 48N: a third of it would
    // be past the pole. So the centre slides toward the equator by however
    // much the window overhangs, which is what makes zooming out end at the
    // whole world rather than at the northern two-thirds of it.
    clampCenter: (lat, halfHeightDeg) => {
      const room = 90 - Math.min(90, halfHeightDeg)
      return Math.max(-room, Math.min(room, lat))
    },
    forward(lon, lat) {
      return [wrapDelta(lon - lon0) * cosStandard, lat - lat0]
    },
    inverse(x, y) {
      const latitude = lat0 + y
      if (latitude > 90 || latitude < -90) return null
      const longitude = lon0 + x / cosStandard
      // More than half a turn from the centre is the far side of the seam,
      // already drawn on the other edge of the map.
      if (Math.abs(longitude - lon0) > 180) return null
      return { latitude, longitude: wrapDelta(longitude) }
    }
  }
}

export const PROJECTIONS = {
  azimuthal: {
    id: 'azimuthal',
    label: 'Great circle',
    hint: 'Vessel-centred. A straight line from the boat is a great circle, so it is the HF path.',
    create: createAzimuthal
  },
  cylindrical: {
    id: 'cylindrical',
    label: 'Flat',
    hint: "The familiar rectangle, for comparing against NOAA's own image.",
    create: createCylindrical
  }
}

export const DEFAULT_PROJECTION = 'azimuthal'

/**
 * A viewport: a projection, a centre, how far out it reaches, and a canvas
 * size, resolved into the two functions everything else needs -- lon/lat to
 * pixel and back.
 *
 * `radiusDeg` is degrees of arc from the centre to the nearer edge of the
 * viewport, which is one control that means the same thing in both
 * projections and at every latitude: 20 is a regional close-up, 180 is
 * everywhere.
 *
 * How the radius turns into pixels is the projection's own business
 * (`scaleFor`): an azimuthal disc wants to cover the viewport, a cylindrical
 * rectangle wants to fit a latitude span into its height without drawing the
 * same ocean twice across its width.
 */
export function mapView({
  projection = DEFAULT_PROJECTION,
  center,
  radiusDeg = 60,
  width,
  height
}) {
  const entry = PROJECTIONS[projection] || PROJECTIONS[DEFAULT_PROJECTION]
  const lat = Number.isFinite(center?.latitude) ? center.latitude : 0
  const lon = Number.isFinite(center?.longitude) ? center.longitude : 0
  // Built more than once: the centre a cylindrical map can honestly use
  // depends on how much latitude is on screen, that depends on the scale, and
  // the scale depends back on the centre through the standard parallel.
  // Guessing from the radius alone pulls the vessel off centre at zoom levels
  // that did not need it; clamping once against the first pass's scale leaves
  // the map overhanging the pole by several degrees, because the second pass
  // rescales underneath the answer. Each pass moves the centre toward the
  // equator and never back, so this settles; the cap is there because a
  // projection is not the place to rely on that.
  let proj = entry.create(lat, lon, radiusDeg)
  let centerLat = lat
  // Converges geometrically rather than in one step, and a tenth of a degree
  // is already a fraction of a pixel, so the cap is generous and the
  // tolerance is what actually ends it.
  for (let pass = 0; pass < 20; pass++) {
    const halfHeightDeg =
      height / 2 / proj.scaleFor(proj.radiusWorld(radiusDeg), width, height)
    const next = proj.clampCenter(lat, halfHeightDeg)
    if (Math.abs(next - centerLat) < 1e-6) break
    centerLat = next
    proj = entry.create(centerLat, lon, radiusDeg)
  }
  const radius = proj.radiusWorld(radiusDeg)
  const scale = proj.scaleFor(radius, width, height)
  const cx = width / 2
  const cy = height / 2

  const toPixel = (lon_, lat_) => {
    const world = proj.forward(lon_, lat_)
    if (!world) return null
    return [cx + world[0] * scale, cy - world[1] * scale]
  }

  return {
    projection: entry.id,
    proj,
    center: { latitude: centerLat, longitude: lon },
    radiusDeg,
    width,
    height,
    scale,
    toPixel,
    // Separable accessors, for the callers (coast-wright's `limn`, the
    // graticule) that hand a projection one coordinate at a time. Only
    // meaningful when `proj.separable`; the renderer checks before using them.
    x: (lon_) => cx + proj.forward(lon_, centerLat)[0] * scale,
    y: (lat_) => cy - proj.forward(lon, lat_)[1] * scale,
    toLatLon: (px, py) => proj.inverse((px - cx) / scale, (cy - py) / scale)
  }
}
