// Geography shared by every map this webapp draws. The aurora grid and the
// D-RAP absorption grid are both bare numbers over a sphere: without a
// coastline the reader has a coloured rectangle and a dot, and no way to tell
// whether the bright patch is over their passage or over Siberia.
//
// It is drawn here rather than borrowed from the boat's own charts because
// every chart source Signal K can offer is Web Mercator, which cannot show a
// pole -- and polar absorption is half of what these maps exist to show. The
// coastline's size, and the argument against the alternatives, are on
// https://github.com/mark-brannan/signalk-noaa-space-weather/issues/32
import { COASTLINE } from './coastline.js'

/** Coordinates were stored as tenths of a degree; see scripts/gen-coastline.mjs. */
const SCALE = 10

/**
 * Google's polyline varint over deltas, one ring per string, decoded to
 * [lon, lat] pairs in degrees.
 */
function decodeRing(encoded) {
  const points = []
  let index = 0
  let lon = 0
  let lat = 0
  while (index < encoded.length) {
    let shift = 0
    let bits = 0
    let byte
    do {
      byte = encoded.charCodeAt(index++) - 63
      bits |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    lon += bits & 1 ? ~(bits >> 1) : bits >> 1
    shift = 0
    bits = 0
    do {
      byte = encoded.charCodeAt(index++) - 63
      bits |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    lat += bits & 1 ? ~(bits >> 1) : bits >> 1
    points.push([lon / SCALE, lat / SCALE])
  }
  return points
}

let decoded = null

/**
 * The coastline as rings of [lon, lat]. Decoded once and kept: it is the same
 * few thousand points on every redraw, and both maps redraw on resize.
 */
export function coastlineRings() {
  if (!decoded) decoded = COASTLINE.map(decodeRing)
  return decoded
}

/**
 * Draws the coastline through a map's own projection.
 *
 * `x` and `y` are the caller's lon/lat-to-pixel functions, so this makes no
 * assumption about the window, the centre or the scale -- the aurora map is a
 * band around the vessel and an absorption map is the whole planet, and both
 * are equirectangular only because the grids are.
 *
 * Segments spanning more than half the world are dropped rather than drawn.
 * A ring crossing the antimeridian holds two points a tenth of a degree apart
 * on the ground and 360 apart in the numbers; so does a ring passing behind a
 * window centred anywhere but Greenwich. Either one, joined, lays a line
 * across the whole map -- so the seam is tested against `lonCenter`, the
 * longitude the caller's own projection measures from.
 */
export function drawCoastline(
  ctx,
  x,
  y,
  { color, alpha = 0.45, width = 1, lonCenter = 0 }
) {
  const fromCentre = (lon) => {
    let d = lon - lonCenter
    if (d > 180) d -= 360
    if (d < -180) d += 360
    return d
  }
  ctx.save()
  ctx.strokeStyle = color
  ctx.globalAlpha = alpha
  ctx.lineWidth = width
  ctx.lineJoin = 'round'
  for (const ring of coastlineRings()) {
    ctx.beginPath()
    let pendown = false
    let previous = 0
    for (let i = 0; i < ring.length; i++) {
      const [lon, lat] = ring[i]
      const d = fromCentre(lon)
      if (i > 0 && Math.abs(d - previous) > 180) pendown = false
      previous = d
      if (pendown) ctx.lineTo(x(lon), y(lat))
      else ctx.moveTo(x(lon), y(lat))
      pendown = true
    }
    ctx.stroke()
  }
  ctx.restore()
}
