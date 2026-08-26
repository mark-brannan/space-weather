// The D-RAP absorption map: what the grid says, and what a path across it
// costs. No DOM here except the canvas `draw` is handed one -- everything the
// picture is drawn from is a pure function, so test/drap-map.test.ts can ask
// the same questions the map does without a browser.
//
// The colour ramp itself lives in hf.js, not here: it is also the HF Radio
// tile's band strip, and src/tiles.ts (via test/hf-render.test.ts) already
// pins the webapp's copy against the server's. A second copy here would be a
// third place the same ramp could drift.
import { MARINE_SSB_BAND_EDGES_HZ, drapCellColor } from './hf.js'
import { drawCoastline, limn } from './geo.js'

const FLOOR_MHZ = MARINE_SSB_BAND_EDGES_HZ[0] / 1e6
const TOP_MHZ =
  MARINE_SSB_BAND_EDGES_HZ[MARINE_SSB_BAND_EDGES_HZ.length - 1] / 1e6

/** The legend: one swatch per band edge, labelled by what it kills. */
export function legendStops() {
  return MARINE_SSB_BAND_EDGES_HZ.map((hz) => {
    const mhz = hz / 1e6
    return {
      mhz,
      color: drapCellColor(hz) || 'rgba(0,0,0,0)',
      label: mhz >= TOP_MHZ ? `${mhz}+` : String(mhz)
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

// --- drawing ---------------------------------------------------------------

/** Equirectangular: the whole globe, because an HF path does not stay local. */
const project = (width, height) => ({
  x: (lon) => ((lon + 180) / 360) * width,
  y: (lat) => ((90 - lat) / 180) * height
})

/**
 * Draw the grid, the graticule, the vessel, the subsolar point and (when the
 * reader has picked one) the path being probed.
 *
 * One filled rectangle per grid cell rather than a per-pixel sample: this is
 * 8,100 cells against 300,000-odd pixels, it runs inside somebody's browser
 * on a boat, and the cell edges are honest about how coarse the model is.
 */
export function drawDrapMap(canvas, grid, options = {}) {
  const { position, probe, now } = options
  const ctx = canvas.getContext('2d')
  if (!ctx || !grid?.frequenciesMHz) return

  const ratio = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
  const width = canvas.clientWidth || canvas.width
  const height = Math.round(width / 2)
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  canvas.style.height = `${height}px`
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const p = project(width, height)
  const cellW = width / 90
  const cellH = height / 90

  // The page is themed; the canvas is not. `color` on the element carries the
  // page's dim text colour into here, so the graticule reads on a white
  // dashboard and a black one without this file knowing which it is on.
  const ink =
    options.ink ||
    (typeof getComputedStyle === 'function'
      ? getComputedStyle(canvas).color || '#888'
      : '#888')

  ctx.globalAlpha = 0.06
  ctx.fillStyle = ink
  ctx.fillRect(0, 0, width, height)
  ctx.globalAlpha = 1

  // Cell edges snapped to whole pixels. Overlapping fills would double the
  // alpha along every seam, drawing a 90x90 mesh over the data that reads as
  // structure the model does not have.
  for (let row = 0; row < grid.frequenciesMHz.length; row++) {
    const cells = grid.frequenciesMHz[row]
    if (!Array.isArray(cells)) continue
    const y0 = Math.round(row * cellH)
    const y1 = Math.round((row + 1) * cellH)
    for (let col = 0; col < cells.length; col++) {
      const color = drapCellColor(cells[col] * 1e6)
      if (!color) continue
      const x0 = Math.round(col * cellW)
      ctx.fillStyle = color
      ctx.fillRect(x0, y0, Math.round((col + 1) * cellW) - x0, y1 - y0)
    }
  }

  ctx.strokeStyle = ink
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.25
  for (let lat = -60; lat <= 60; lat += 30)
    line(ctx, 0, p.y(lat), width, p.y(lat))
  for (let lon = -120; lon <= 120; lon += 60)
    line(ctx, p.x(lon), 0, p.x(lon), height)
  ctx.globalAlpha = 0.5
  line(ctx, 0, p.y(0), width, p.y(0))
  ctx.globalAlpha = 1
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1)

  // Over the cells and the graticule, under the subsolar point and the
  // vessel marker: the absorption is the reading, the coastline is only what
  // makes it locatable. Equirectangular here too, so the same function the
  // regional aurora/D-RAP window uses draws the whole globe just as well.
  drawCoastline(ctx, p.x, p.y, { color: ink })

  const sun = subsolarPoint(now)
  ctx.fillStyle = 'rgba(255,236,150,0.9)'
  ctx.beginPath()
  ctx.arc(p.x(sun.longitude), p.y(sun.latitude), 5, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,236,150,0.35)'
  ctx.beginPath()
  ctx.arc(p.x(sun.longitude), p.y(sun.latitude), 10, 0, Math.PI * 2)
  ctx.stroke()

  if (probe?.points?.length) {
    // The probed path is a ring of [lon, lat] like the coastline; limn
    // already breaks it at the seam against lonCenter rather than the
    // antimeridian, which is the same guard this used to hand-roll in pixel
    // space against `width / 2`.
    const path = probe.points.map((point) => [point.longitude, point.latitude])
    limn(ctx, [path], p.x, p.y, { color: ink, alpha: 0.9, width: 1.5 })

    if (probe.worstAt) {
      ctx.fillStyle = ink
      ctx.beginPath()
      ctx.arc(
        p.x(probe.worstAt.longitude),
        p.y(probe.worstAt.latitude),
        3.5,
        0,
        Math.PI * 2
      )
      ctx.fill()
    }
    const end = probe.points[probe.points.length - 1]
    marker(ctx, p.x(end.longitude), p.y(end.latitude), ink)
  }

  if (position) {
    marker(
      ctx,
      p.x(position.longitude),
      p.y(position.latitude),
      '#4ad2ff',
      true
    )
  }
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
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

/** Canvas pixel -> position, for a click on the map. */
export function positionAt(canvas, offsetX, offsetY) {
  const width = canvas.clientWidth || canvas.width
  const height = canvas.clientHeight || canvas.height
  if (!width || !height) return null
  return {
    latitude: 90 - (offsetY / height) * 180,
    longitude: (offsetX / width) * 360 - 180
  }
}
