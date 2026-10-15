// Geography shared by every map this webapp draws. The aurora grid and the
// D-RAP absorption grid are both bare numbers over a sphere: without a
// coastline the reader has a coloured rectangle and a dot, and no way to tell
// whether the bright patch is over their passage or over Siberia.
//
// It is drawn here rather than borrowed from the boat's own charts because
// every chart source Signal K can offer is Web Mercator, which cannot show a
// pole -- and polar absorption is half of what these maps exist to show. The
// argument against the alternatives is on
// https://github.com/mark-brannan/signalk-noaa-space-weather/issues/32
//
// The geography is Natural Earth's 50m coastline as published -- nothing
// simplified, every island kept -- and "coast-wright" turns it into rings
// and draws them. scripts/sync-coastline.mjs vendors both into public/ on
// prebuild and prepare, the same way scripts/sync-icon.mjs vendors the icon.
import { geojsonRings, limn } from './vendor/coast-wright/index.js'
import COASTLINE from './coastline.js'

/**
 * The coastline as rings of [lon, lat]. coast-wright keeps them per
 * document: it is the same tens of thousands of points on every redraw, and
 * both maps redraw on resize.
 */
export function coastlineRings() {
  return geojsonRings(COASTLINE)
}

/**
 * The coastline as coast-wright's port takes it: an async iterable of rings,
 * so the day a provider hands rings over piece by piece this is the one
 * function that changes and `limn`'s caller does not.
 */
export async function* coastlineSource() {
  yield* coastlineRings()
}

/**
 * Draws the coastline through a map's own projection. See coast-wright's
 * `limn` for what `x`, `y` and `lonCenter` mean and why the seam guard tests
 * against `lonCenter` rather than the antimeridian.
 */
export function drawCoastline(ctx, x, y, options) {
  return limn(ctx, coastlineSource(), x, y, options)
}

export { limn }
