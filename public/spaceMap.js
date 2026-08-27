// The webapp's map: one canvas, any combination of layers, either projection,
// any zoom.
//
// There used to be two maps -- a regional aurora window and a global D-RAP
// rectangle -- behind a dropdown that showed one and hid the other. Living
// with both produced a list of complaints on each that turned out to be one
// redesign rather than two patches
// (https://github.com/mark-brannan/signalk-noaa-space-weather/issues/177):
// the layers wanted to be seen together, the regional view wanted a
// coastline, the global view wanted aurora on it, and neither wanted the
// projection welded to the product.
//
// So the products are layers, the projection is a control, and the extent is
// a control. What is left here is only the drawing.
//
// The data itself goes through mapRaster.js, which walks destination pixels
// and asks the projection where each one is. Everything with an edge a reader
// would measure against -- the coastline, the graticule, the markers, the
// probed path -- is drawn vectorially at full resolution over the top.

import { coastlineRings, limn } from './geo.js'
import { auroraCellColor } from './aurora.js'
import { drapNoaaColor } from './drap-colors.js'
import { MARINE_SSB_BAND_EDGES_HZ } from './hf.js'
import { auroraSampler, drapSampler, rasterize } from './mapRaster.js'
import { subsolarPoint } from './drapMap.js'
import { mapView } from './projection.js'

// The map draws on its own ground, not the page's.
//
// NOAA's D-RAP colorbar starts at #000000 and the first few MHz are near-black
// violet -- a palette designed to sit on a black globe, where "dark" reads as
// "nothing happening". Composited onto a light dashboard instead, an ordinary
// quiet day (1-3 MHz over most of the dayside) becomes a heavy purple sheet
// that buries the coastline: measured on the mock rig, not guessed. Matching
// NOAA's colours therefore means matching the ground they were sampled
// against, so this panel is deliberately dark in both themes -- the same
// choice every published space-weather map makes, and the reason the ink for
// everything drawn over the data is fixed here rather than inherited from the
// page.
//
// The chart-plotter overlay in src/tiles.ts is the opposite case and keeps its
// alpha ramp: it has the owner's own chart underneath and no ground of its
// own. Argument on
// https://github.com/mark-brannan/signalk-noaa-space-weather/issues/170
export const MAP_GROUND = '#05070d'
export const MAP_INK = 'rgba(226,232,240,0.92)'
// The vessel and the path scored from it, in one colour that belongs to
// neither product. The probed path used to be drawn in the map's own ink, and
// on a quiet day -- one band-edge contour, arcing across the whole dayside --
// there was nothing to tell the reader which line was theirs.
export const MAP_TRACK = '#4ad2ff'

export const MIN_RADIUS_DEG = 15
export const MAX_RADIUS_DEG = 180
export const DEFAULT_RADIUS_DEG = 60

/**
 * The two products, as layers.
 *
 * Order is stacking order: absorption under aurora, because absorption is a
 * broad daylit wash and the auroral oval is a narrow bright feature, and the
 * narrow thing on top of the broad one is the readable way round.
 */
export const LAYER_IDS = ['drap', 'aurora']

const SAMPLERS = { aurora: auroraSampler, drap: drapSampler }
const COLORS = {
  aurora: (pct) => auroraCellColor(pct),
  drap: (mhz) => drapNoaaColor(mhz)
}

/**
 * The viewport a set of controls resolves to on a given canvas.
 *
 * Kept as a function of its own, and stashed on the canvas by `drawSpaceMap`,
 * so a click can be turned back into a position through exactly the geometry
 * that was drawn -- not a second copy of it that could drift.
 */
export function viewFor(canvas, options = {}) {
  const width = canvas.clientWidth || canvas.width || 1
  const height = canvas.clientHeight || canvas.height || 1
  return mapView({
    projection: options.projection,
    // Without a fix there is no vessel to centre on. Latitude 20N rather than
    // the equator so a whole-world view is not half ocean, and the centre is
    // only ever a default: the moment a position arrives the map recentres.
    center: options.position || { latitude: 20, longitude: 0 },
    radiusDeg: options.radiusDeg || DEFAULT_RADIUS_DEG,
    width,
    height
  })
}

/**
 * Draw everything. `grids` carries whichever cached grids the page has;
 * `layers` is which of them the reader has switched on.
 */
export function drawSpaceMap(canvas, options = {}) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const {
    grids = {},
    layers = LAYER_IDS,
    position,
    probe,
    now,
    bandContours = false
  } = options

  const ratio = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
  const width = canvas.clientWidth || canvas.width
  const height = canvas.clientHeight || canvas.height
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const view = viewFor(canvas, options)
  canvas._view = view

  const ink = options.ink || MAP_INK

  const active = []
  for (const id of LAYER_IDS) {
    if (!layers.includes(id)) continue
    const sample = SAMPLERS[id](grids[id])
    if (sample) active.push({ id, sample, color: COLORS[id] })
  }

  // An azimuthal disc does not fill its rectangle. Everything is clipped to
  // it so the corners stay page-coloured rather than collecting the smeared
  // edge of the upscaled raster.
  const disc = view.proj.separable ? null : discPath(view)
  ctx.save()
  if (disc) ctx.clip(disc)

  ctx.fillStyle = options.ground || MAP_GROUND
  if (disc) ctx.fill(disc)
  else ctx.fillRect(0, 0, width, height)

  if (active.length) paintRaster(ctx, view, active)

  const drap = active.find((layer) => layer.id === 'drap')
  if (drap && bandContours) drawBandContours(ctx, view, drap.sample, ink)

  drawGraticule(ctx, view, ink)
  drawCoast(ctx, view, ink)
  ctx.restore()

  if (disc) {
    ctx.strokeStyle = ink
    ctx.globalAlpha = 0.35
    ctx.lineWidth = 1
    ctx.stroke(disc)
    ctx.globalAlpha = 1
  } else {
    ctx.strokeStyle = ink
    ctx.globalAlpha = 0.35
    ctx.lineWidth = 1
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1)
    ctx.globalAlpha = 1
  }

  ctx.save()
  if (disc) ctx.clip(disc)
  if (drap) drawSun(ctx, view, now)
  if (probe?.points?.length) drawProbe(ctx, view, probe, MAP_TRACK)
  if (position) {
    const at = view.toPixel(position.longitude, position.latitude)
    if (at) marker(ctx, at[0], at[1], MAP_TRACK, true)
  }
  ctx.restore()

  return view
}

/**
 * The raster, drawn once and scaled up by the browser.
 *
 * `imageSmoothingEnabled` is the whole point: the browser interpolates in
 * hardware what would otherwise be one hard-edged rectangle per grid cell.
 * That is what NOAA's own image does and what src/tiles.ts already did for
 * the chart overlay, leaving this the only blocky surface in the product
 * (https://github.com/mark-brannan/signalk-noaa-space-weather/issues/186).
 */
function paintRaster(ctx, view, layers) {
  const raster = rasterize(view, layers)
  if (typeof document === 'undefined' || typeof ImageData === 'undefined') {
    return
  }
  const offscreen = document.createElement('canvas')
  offscreen.width = raster.width
  offscreen.height = raster.height
  const offCtx = offscreen.getContext('2d')
  if (!offCtx) return
  offCtx.putImageData(
    new ImageData(raster.data, raster.width, raster.height),
    0,
    0
  )
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(offscreen, 0, 0, view.width, view.height)
}

/** The boundary circle of an azimuthal view, as a path. */
function discPath(view) {
  const path = new Path2D()
  path.arc(
    view.width / 2,
    view.height / 2,
    view.proj.radiusWorld(view.radiusDeg) * view.scale,
    0,
    Math.PI * 2
  )
  return path
}

// --- the coastline ---------------------------------------------------------

/**
 * Coast-wright's `limn` takes `x(lon)` and `y(lat)` as separate functions,
 * which is only expressible for a cylindrical projection: on an azimuthal one
 * the pixel column a point lands in depends on its latitude too. So the
 * separable case goes through the library -- its seam guard against
 * `lonCenter` is exactly right there and better than anything measured in
 * pixels -- and the azimuthal case is stroked here, against a different
 * discontinuity.
 */
function drawCoast(ctx, view, ink) {
  // Twice: a dark wide stroke, then the light one over it. A single light
  // line vanishes wherever the absorption ramp reaches its yellow end, which
  // is exactly the part of the map somebody is looking hardest at.
  const passes = [
    { color: 'rgba(0,0,0,0.45)', alpha: 1, width: 2.2 },
    { color: ink, alpha: 0.6, width: 1 }
  ]
  for (const pass of passes) {
    if (view.proj.separable) {
      limn(ctx, coastlineRings(), view.x, view.y, {
        ...pass,
        lonCenter: view.center.longitude
      })
    } else {
      strokeRings(ctx, coastlineRings(), view, pass)
    }
  }
}

/**
 * Rings of `[lon, lat]` through a projection that is not separable.
 *
 * An azimuthal equidistant map has no antimeridian to break at -- the whole
 * sphere is continuous inside the disc -- but it does have one singularity,
 * the antipode of the centre, where a segment that straddles it is drawn as a
 * chord straight across the map. A pixel-length cap catches that and nothing
 * else: neighbouring coastline points are a degree apart on the ground, so a
 * segment spanning a third of the viewport is not geography.
 */
export function strokeRings(ctx, rings, view, options = {}) {
  const { color, alpha = 0.45, width = 1 } = options
  const cap = options.maxSegment || Math.max(view.width, view.height) / 3
  ctx.save()
  if (color) ctx.strokeStyle = color
  ctx.globalAlpha = alpha
  ctx.lineWidth = width
  ctx.lineJoin = 'round'
  for (const ring of rings) {
    ctx.beginPath()
    let pendown = false
    let previous = null
    for (const point of ring) {
      const at = view.toPixel(point[0], point[1])
      if (!at) {
        pendown = false
        previous = null
        continue
      }
      if (
        previous &&
        Math.hypot(at[0] - previous[0], at[1] - previous[1]) > cap
      ) {
        pendown = false
      }
      if (pendown) ctx.lineTo(at[0], at[1])
      else ctx.moveTo(at[0], at[1])
      pendown = true
      previous = at
    }
    ctx.stroke()
  }
  ctx.restore()
}

// --- the graticule ---------------------------------------------------------

/**
 * Parallels and meridians, drawn as polylines through the projection rather
 * than as straight lines, because on an azimuthal map they are neither
 * straight nor evenly spaced -- and a reader who cannot see that curvature
 * has no way to tell which projection they are looking at.
 *
 * Spacing follows the zoom: 30 degrees is a useful grid on a whole-world view
 * and a single line on a harbour-scale one.
 */
function drawGraticule(ctx, view, ink) {
  const step = view.radiusDeg > 90 ? 30 : view.radiusDeg > 40 ? 15 : 10
  const rings = []
  for (let lat = -90 + step; lat <= 90 - step; lat += step) {
    const ring = []
    for (let lon = -180; lon <= 180; lon += 2) ring.push([lon, lat])
    rings.push(ring)
  }
  for (let lon = -180; lon < 180; lon += step * 2) {
    const ring = []
    for (let lat = -90; lat <= 90; lat += 2) ring.push([lon, lat])
    rings.push(ring)
  }
  strokeRings(ctx, rings, view, { color: ink, alpha: 0.14 })
  const equator = []
  for (let lon = -180; lon <= 180; lon += 2) equator.push([lon, 0])
  strokeRings(ctx, [equator], view, { color: ink, alpha: 0.28 })
}

// --- band-edge contours ----------------------------------------------------

/** The marine SSB band edges, in MHz, as contour levels. */
export const BAND_EDGE_MHZ = MARINE_SSB_BAND_EDGES_HZ.map((hz) => hz / 1e6)

/**
 * Lines where the absorption cutoff crosses a marine SSB band edge.
 *
 * NOAA's colorbar is a 0-35 MHz hue sweep: it says how much is absorbed, and
 * nothing about what that costs *this* reader. A sailor's question is which
 * of their bands has gone under, and the answer is a contour -- inside this
 * line, 8 MHz no longer gets out. Drawn over NOAA's own colours rather than
 * instead of them, so the map still matches the picture everyone else is
 * looking at.
 *
 * Marching squares in pixel space, sampling through the projection, so the
 * contours are correct on an oblique azimuthal disc as well as a rectangle.
 * The step is coarse on purpose: the grid is 2x4 degrees and a contour drawn
 * finer than that would be tracing interpolation, not the model.
 */
function drawBandContours(ctx, view, sample, ink) {
  const step = 6
  const cols = Math.ceil(view.width / step) + 1
  const rows = Math.ceil(view.height / step) + 1
  const field = new Float64Array(cols * rows)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const here = view.toLatLon(c * step, r * step)
      field[r * cols + c] = here ? sample(here.latitude, here.longitude) : NaN
    }
  }

  ctx.save()
  ctx.lineCap = 'round'
  // Labels already on the map, so a second one on top of the first is not
  // drawn at all: close-together bands (2.045 and 4, 6.2 and 8.1) would
  // otherwise stack into an unreadable smear at the shoulder of the blob.
  const placed = []
  for (const level of BAND_EDGE_MHZ) {
    const segments = []
    marchingSquares(field, cols, rows, step, level, segments)
    if (!segments.length) continue
    // Black, and drawn twice: a contour has to read over the violet low end
    // and over the yellow peak of the same ramp, and no single colour does
    // both. The dark line is the one that carries; the light one keeps it
    // from disappearing into the near-black ground at the quiet end.
    for (const pass of [
      { color: 'rgba(0,0,0,0.7)', width: 2.6 },
      { color: ink, width: 1 }
    ]) {
      ctx.strokeStyle = pass.color
      ctx.lineWidth = pass.width
      ctx.beginPath()
      for (const [a, b] of segments) {
        ctx.moveTo(a[0], a[1])
        ctx.lineTo(b[0], b[1])
      }
      ctx.stroke()
    }
    labelContour(ctx, view, segments, level, ink, placed)
  }
  ctx.restore()
}

/**
 * One label per contour, so the ring means something without counting
 * inwards from the edge.
 *
 * Placed on the topmost segment of the contour: an arbitrary rule, but a
 * stable one -- it does not jump around the ring as the field creeps
 * between redraws, which a "longest segment" or "nearest the centre" rule
 * would.
 *
 * Topmost *inside the viewport*, though. A blob wider than the map leaves
 * every one of its contours through the top edge, and the topmost segment of
 * each is then exactly where the label cannot be drawn -- half of it hanging
 * off the canvas. Skipping the segments too close to an edge keeps the label
 * on its own line rather than sliding it away from it.
 */
function labelContour(ctx, view, segments, level, ink, placed) {
  const margin = 10
  let best = null
  for (const [a, b] of segments) {
    const y = (a[1] + b[1]) / 2
    if (y < margin || y > view.height - margin) continue
    if (!best || y < best.y) best = { x: (a[0] + b[0]) / 2, y }
  }
  if (!best) return
  // The band's name, not the edge's exact frequency: an operator asks for
  // "the 8 meg band", and 8.1 on a contour reads as a measurement of the
  // absorption rather than as a label for what it takes out. The unit is
  // spelled out because a bare number sitting on a contour line reads as
  // part of the map, not as a label for it.
  const text = `${Math.trunc(level)} MHz`
  ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const half = ctx.measureText(text).width / 2 + 4
  const cx = Math.min(view.width - half, Math.max(half, best.x))
  const box = { x0: cx - half, y0: best.y - 8, x1: cx + half, y1: best.y + 8 }
  for (const other of placed) {
    const clear =
      box.x1 < other.x0 ||
      box.x0 > other.x1 ||
      box.y1 < other.y0 ||
      box.y0 > other.y1
    if (!clear) return
  }
  placed.push(box)
  ctx.fillStyle = 'rgba(0,0,0,0.75)'
  ctx.beginPath()
  ctx.roundRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, 3)
  ctx.fill()
  ctx.fillStyle = ink
  ctx.fillText(text, cx, best.y)
}

/**
 * One threshold's worth of contour, appended to the current path.
 *
 * The classic case table, minus the saddle disambiguation: at this step size
 * an ambiguous saddle is a handful of pixels and either reading draws a line
 * a reader would accept. Cells touching a NaN -- off the disc, or past a pole
 * -- are skipped entirely rather than guessed at.
 *
 * Collected rather than stroked, because each contour is drawn more than once
 * (a dark pass and a light one) and gets a label placed from its own extent.
 */
function marchingSquares(field, cols, rows, step, level, out) {
  const at = (c, r) => field[r * cols + c]
  const cut = (v0, v1) => (level - v0) / (v1 - v0)
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const tl = at(c, r)
      const tr = at(c + 1, r)
      const br = at(c + 1, r + 1)
      const bl = at(c, r + 1)
      if (!Number.isFinite(tl + tr + br + bl)) continue
      const code =
        (tl > level ? 8 : 0) |
        (tr > level ? 4 : 0) |
        (br > level ? 2 : 0) |
        (bl > level ? 1 : 0)
      if (code === 0 || code === 15) continue
      const x = c * step
      const y = r * step
      const top = [x + step * cut(tl, tr), y]
      const right = [x + step, y + step * cut(tr, br)]
      const bottom = [x + step * cut(bl, br), y + step]
      const left = [x, y + step * cut(tl, bl)]
      const draw = (a, b) => out.push([a, b])
      switch (code) {
        case 1:
        case 14:
          draw(left, bottom)
          break
        case 2:
        case 13:
          draw(bottom, right)
          break
        case 3:
        case 12:
          draw(left, right)
          break
        case 4:
        case 11:
          draw(top, right)
          break
        case 6:
        case 9:
          draw(top, bottom)
          break
        case 7:
        case 8:
          draw(left, top)
          break
        case 5:
          draw(left, top)
          draw(bottom, right)
          break
        case 10:
          draw(top, right)
          draw(left, bottom)
          break
      }
    }
  }
}

// --- marks -----------------------------------------------------------------

/**
 * The subsolar point. D-region absorption is a dayside phenomenon, so this is
 * the one mark that makes the picture readable at a glance: the blob belongs
 * near it, and a blob that is not is worth a second look.
 */
function drawSun(ctx, view, now) {
  const sun = subsolarPoint(now)
  const at = view.toPixel(sun.longitude, sun.latitude)
  if (!at) return
  ctx.fillStyle = 'rgba(255,236,150,0.9)'
  ctx.beginPath()
  ctx.arc(at[0], at[1], 5, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,236,150,0.35)'
  ctx.beginPath()
  ctx.arc(at[0], at[1], 10, 0, Math.PI * 2)
  ctx.stroke()
}

function drawProbe(ctx, view, probe, ink) {
  const path = probe.points.map((point) => [point.longitude, point.latitude])
  // Dark under, colour over, the same as the coastline and the contours: the
  // path crosses the whole ramp by construction, since scoring it is the
  // point.
  strokeRings(ctx, [path], view, {
    color: 'rgba(0,0,0,0.5)',
    alpha: 1,
    width: 3.4
  })
  strokeRings(ctx, [path], view, { color: ink, alpha: 0.95, width: 1.8 })
  if (probe.worstAt) {
    const worst = view.toPixel(probe.worstAt.longitude, probe.worstAt.latitude)
    if (worst) {
      ctx.fillStyle = ink
      ctx.beginPath()
      ctx.arc(worst[0], worst[1], 3.5, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  const end = probe.points[probe.points.length - 1]
  const at = view.toPixel(end.longitude, end.latitude)
  if (at) marker(ctx, at[0], at[1], ink)
}

function marker(ctx, x, y, color, filled = false) {
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(x, y, 5, 0, Math.PI * 2)
  ctx.stroke()
  if (filled) {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(x, y, 2, 0, Math.PI * 2)
    ctx.fill()
  }
}

/**
 * Canvas pixel to position, through the same viewport that was drawn.
 *
 * Reads the view off the canvas rather than rebuilding one from the controls:
 * a click has to be answered by the geometry the reader actually clicked on,
 * and two constructions of "the same" viewport is exactly the pair that
 * drifts.
 */
export function positionAt(canvas, offsetX, offsetY) {
  const view = canvas?._view
  if (!view) return null
  return view.toLatLon(offsetX, offsetY)
}
