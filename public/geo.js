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
//
// The decoding and drawing used to live here by hand; they are now
// "coast-wright" and "coastlines", extracted so other projects can draw a
// coastline without also being a Signal K plugin. scripts/sync-coastline.mjs
// vendors both into public/ on prebuild and prepare, the same way
// scripts/sync-icon.mjs vendors the icon.
import { limn, rings } from './vendor/coast-wright/index.js'
import COASTLINE from './coastline.js'

let decoded = null

/**
 * The coastline as rings of [lon, lat]. Decoded once and kept: it is the
 * same few thousand points on every redraw, and both maps redraw on resize.
 */
export function coastlineRings() {
  if (!decoded) decoded = rings(COASTLINE)
  return decoded
}

/**
 * Draws the coastline through a map's own projection. See coast-wright's
 * `limn` for what `x`, `y` and `lonCenter` mean and why the seam guard tests
 * against `lonCenter` rather than the antimeridian.
 */
export function drawCoastline(ctx, x, y, options) {
  limn(ctx, coastlineRings(), x, y, options)
}

export { limn }
