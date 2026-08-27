// NOAA's own D-RAP colorbar, on every surface that draws the grid: the
// webapp's map and its legend from here, the chart-plotter overlay from the
// mirror of this table in src/tiles.ts. Issue #170 settled the split aurora
// makes -- NOAA's colours on the chart, the plugin's own on the dark page --
// the other way for D-RAP: a picture that sits beside NOAA's own image of the
// same grid has to be the same picture, on whichever screen it is read.

/**
 * The colorbar, sampled from NOAA's legend PNG for "Highest Frequency
 * Affected by 1dB Absorption" -- a palette image, so the samples carry no
 * JPEG noise -- with 0-35 MHz mapped linearly across its pixel width
 * (2026-08-26, recorded in
 * https://github.com/mark-brannan/signalk-noaa-space-weather/issues/170).
 *
 * `[MHz, r, g, b]`. A hue sweep, black through violet, blue, cyan, green and
 * yellow to red, not the single-hue intensity ramp aurora uses. NOAA publishes
 * no numeric definition of it, so the legend image is the only source there
 * is; re-sample it rather than adjusting these by eye.
 */
export const NOAA_DRAP_STOPS = [
  [0, 0, 0, 0], // #000000
  [2, 61, 0, 63], // #3d003f
  [4, 88, 0, 132], // #580084
  [6, 71, 0, 195], // #4700c3
  [8, 21, 0, 255], // #1500ff
  [10, 0, 55, 255], // #0037ff
  [12, 0, 131, 255], // #0083ff
  [14, 0, 216, 255], // #00d8ff
  [16, 0, 255, 220], // #00ffdc
  [18, 0, 255, 144], // #00ff90
  [20, 0, 255, 67], // #00ff43
  [22, 4, 255, 0], // #04ff00
  [24, 76, 255, 0], // #4cff00
  [26, 157, 255, 0], // #9dff00
  [28, 229, 255, 0], // #e5ff00
  [30, 255, 195, 0], // #ffc300
  [32, 255, 123, 0], // #ff7b00
  [34, 255, 42, 0], // #ff2a00
  // The last sampled pixel of the strip is 255,12,0, but the legend's own end
  // box is pure red and the scale saturates there: past 35 MHz there is no
  // more colour to give, so the table ends on the colour the box holds.
  [35, 255, 0, 0] // #ff0000
]

/**
 * Where the alpha ramp reaches opaque, in MHz.
 *
 * NOAA draws this bar over its own black background, where 0 MHz is #000000
 * and reads as "nothing". Over a nautical chart, or the webapp's dark page,
 * an opaque black cell reads as void -- no data, or a hole in the chart --
 * which is the opposite of what a quiet grid means. Aurora solved this by
 * drawing its 0% stop fully transparent; the same answer applies here.
 *
 * Alpha is linear in MHz from invisible at 0 to fully opaque at this stop,
 * and flat above it. Two things fix the shape:
 *
 * - It is a fade, not a threshold. A cutoff switched on at some MHz draws a
 *   crisp contour around the absorption footprint, and a crisp line is
 *   exactly what a reader over-trusts on a 2x4 degree grid.
 * - It reaches *fully* opaque, and early. Now that hue carries the severity,
 *   alpha must not: a half-transparent #580084 composites to lavender over a
 *   paper chart and to near-black over the dark page, so the same cell would
 *   read as two different severities on two screens on the same boat. Above
 *   this stop every cell is shown at NOAA's own colour, undiluted.
 *
 * 4 MHz because that is the last stop whose colour is still dark enough to be
 * lost against either background anyway (#3d003f at 2 MHz), so the fade costs
 * no legible information, and because it is the second marine SSB band edge:
 * by the time a cell fades in, the boat has lost a band it could work.
 */
const ALPHA_FULL_MHZ = 4

const TOP = NOAA_DRAP_STOPS[NOAA_DRAP_STOPS.length - 1]

/** Linear in RGB between the bracketing stops; holds pure red past the top. */
function rgbAt(mhz) {
  if (mhz >= TOP[0]) return [TOP[1], TOP[2], TOP[3]]
  let i = 0
  while (i < NOAA_DRAP_STOPS.length - 2 && mhz >= NOAA_DRAP_STOPS[i + 1][0]) {
    i++
  }
  const a = NOAA_DRAP_STOPS[i]
  const b = NOAA_DRAP_STOPS[i + 1]
  const t = (mhz - a[0]) / (b[0] - a[0])
  return [
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    Math.round(a[3] + (b[3] - a[3]) * t)
  ]
}

/**
 * The colour of one cutoff frequency as `[r, g, b, a]`, alpha 0..1.
 *
 * No reading, or no absorption at all, is `[0, 0, 0, 0]` -- fully transparent,
 * never a black cell.
 */
export function drapNoaaColor(mhz) {
  if (!Number.isFinite(mhz) || mhz <= 0) return [0, 0, 0, 0]
  const [r, g, b] = rgbAt(mhz)
  return [r, g, b, Math.min(1, mhz / ALPHA_FULL_MHZ)]
}

function css([r, g, b, a]) {
  return `rgba(${r},${g},${b},${a.toFixed(3)})`
}

/** `rgba(...)` for one cell, or null where nothing should be drawn at all. */
export function drapNoaaCss(mhz) {
  const rgba = drapNoaaColor(mhz)
  return rgba[3] <= 0 ? null : css(rgba)
}

/**
 * Evenly spaced samples across the whole bar, for a legend strip.
 *
 * Drawn from `drapNoaaColor`, including its alpha, so a swatch cannot claim a
 * colour the map does not paint -- the transparent low end of the strip is the
 * honest picture of a grid with nothing on it.
 */
export function drapNoaaLegend(steps = 8) {
  const n = Math.max(2, Math.floor(steps))
  const out = []
  for (let i = 0; i < n; i++) {
    const mhz = (TOP[0] * i) / (n - 1)
    out.push({ mhz, color: css(drapNoaaColor(mhz)) })
  }
  return out
}
