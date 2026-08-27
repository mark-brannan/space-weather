// Turning a grid of numbers into pixels, for whatever projection the reader
// has picked.
//
// Both grids used to be drawn one filled rectangle per cell, which fixed the
// picture to one projection -- a cell is only a rectangle on a cylindrical
// map -- and left the D-RAP map the last blocky surface in the product, while
// NOAA's own image and this plugin's chart-plotter tiles both interpolate the
// same grid
// (https://github.com/mark-brannan/signalk-noaa-space-weather/issues/186).
//
// Inverting it fixes both at once: walk the *destination* pixels, ask the
// projection where each one is on the planet, and sample the grid there. The
// projection is then a parameter rather than an assumption, an oblique
// azimuthal disc costs exactly what a rectangle costs, and the result is
// interpolated because the sampler interpolates.
//
// Nothing here touches the DOM. `rasterize` returns plain RGBA bytes so
// test/map-raster.test.ts can assert registration and colour without a canvas.

/**
 * Rendered at a bounded resolution and scaled up by the browser, not at the
 * canvas's own device-pixel size.
 *
 * The source grids are 90x90 (D-RAP) and 360x181 (aurora); a 480-pixel raster
 * is already finer than either, so anything beyond it is the browser
 * interpolating in JavaScript what it will interpolate in hardware anyway.
 * On a boat tablet at devicePixelRatio 2 a full-size raster is over a million
 * inverse projections per redraw, and a redraw happens on every resize, zoom
 * step and probe click.
 *
 * The coastline, graticule and markers are drawn vectorially at full
 * resolution on top, so nothing with an edge a reader would measure against
 * goes through this.
 */
export const RASTER_MAX_SIDE = 480

/**
 * The OVATION grid as a sampler: `(lat, lon) => percent`.
 *
 * `grid.coordinates` is 65,160 `[lon, lat, percent]` triples in longitude-major
 * order, lon 0..359 and lat -90..90. Indexed into a Float32Array once per
 * grid rather than searched per pixel -- at a quarter of a million pixels a
 * redraw, the difference is the whole feature.
 */
export function auroraSampler(grid) {
  const points = grid?.coordinates
  if (!Array.isArray(points) || points.length === 0) return null
  const LON_COUNT = 360
  const LAT_COUNT = 181
  if (points.length !== LON_COUNT * LAT_COUNT) return null
  const values = new Float32Array(LON_COUNT * LAT_COUNT)
  for (const point of points) {
    const lon = ((Math.round(point[0]) % 360) + 360) % 360
    const lat = Math.round(point[1])
    if (lat < -90 || lat > 90) continue
    const value = point[2]
    values[lon * LAT_COUNT + (lat + 90)] = Number.isFinite(value) ? value : 0
  }
  return (lat, lon) =>
    bilinear(values, {
      latStart: -90,
      latStep: 1,
      latCount: LAT_COUNT,
      lonStart: 0,
      lonStep: 1,
      lonCount: LON_COUNT,
      lat,
      lon
    })
}

/**
 * The D-RAP grid as a sampler: `(lat, lon) => MHz`.
 *
 * Geometry is read off the grid rather than assuming NOAA's usual 90x90 at
 * 2x4 degrees, the same way `drapLattice` in src/tiles.ts derives it -- the
 * shape has changed under this plugin before.
 *
 * Interpolated, unlike `cutoffAt` in drapMap.js, which deliberately answers
 * by nearest cell. The difference is not an inconsistency: a *number* put in
 * front of a reader should not claim precision the model does not have, while
 * a *picture* of a field this smooth (mean adjacent-cell delta 0.09 MHz on
 * the 2026-08-20 fixture) is more honest interpolated than drawn as walls.
 */
export function drapSampler(grid) {
  const rows = grid?.frequenciesMHz
  const lats = grid?.latitudes
  const lons = grid?.longitudes
  if (!Array.isArray(rows) || !Array.isArray(lats) || !Array.isArray(lons)) {
    return null
  }
  const latCount = lats.length
  const lonCount = lons.length
  if (latCount < 2 || lonCount < 2) return null
  const values = new Float32Array(lonCount * latCount)
  for (let row = 0; row < latCount; row++) {
    const cells = rows[row]
    if (!Array.isArray(cells)) return null
    // Row 0 is the northernmost latitude; the lattice runs south to north.
    const y = latCount - 1 - row
    for (let col = 0; col < lonCount; col++) {
      const mhz = cells[col]
      values[col * latCount + y] = Number.isFinite(mhz) ? mhz : 0
    }
  }
  const latStep = Math.abs(lats[0] - lats[1])
  const lonStep = Math.abs(lons[1] - lons[0])
  const lonStart = lons[0] < 0 ? lons[0] + 360 : lons[0]
  return (lat, lon) =>
    bilinear(values, {
      latStart: lats[latCount - 1],
      latStep,
      latCount,
      lonStart,
      lonStep,
      lonCount,
      lat,
      lon
    })
}

/**
 * Bilinear sample of a lon-major lattice. Longitude wraps (both grids are
 * global and their last column abuts their first); latitude clamps, because
 * the row nearest a pole is the last thing modelled in that direction and
 * there is nothing past it to blend toward.
 */
function bilinear(values, spec) {
  const { latStart, latStep, latCount, lonStart, lonStep, lonCount } = spec
  const latPos = Math.min(
    latCount - 1,
    Math.max(0, (spec.lat - latStart) / latStep)
  )
  const lonPos =
    ((((spec.lon - lonStart) / lonStep) % lonCount) + lonCount) % lonCount

  const y0 = Math.floor(latPos)
  const y1 = Math.min(latCount - 1, y0 + 1)
  const ty = latPos - y0
  const x0 = Math.floor(lonPos)
  const x1 = (x0 + 1) % lonCount
  const tx = lonPos - x0

  const v00 = values[x0 * latCount + y0]
  const v10 = values[x1 * latCount + y0]
  const v01 = values[x0 * latCount + y1]
  const v11 = values[x1 * latCount + y1]
  return (
    v00 * (1 - tx) * (1 - ty) +
    v10 * tx * (1 - ty) +
    v01 * (1 - tx) * ty +
    v11 * tx * ty
  )
}

/**
 * Rasterise the active layers through a viewport.
 *
 * `layers` are drawn in order, each `{ sample(lat, lon), color(value) }`,
 * where `color` returns `[r, g, b, alpha]` with alpha 0..1, or null for "put
 * no ink here". Composited source-over, so a layer listed later sits on top --
 * the caller's list order is the stacking order and this makes no judgement
 * about which product matters more.
 *
 * Returns `{ data, width, height }` rather than an `ImageData`: this module
 * has to run under vitest, where `ImageData` does not exist. The caller wraps
 * it.
 */
export function rasterize(view, layers, options = {}) {
  const maxSide = options.maxSide || RASTER_MAX_SIDE
  const scale = Math.min(1, maxSide / Math.max(view.width, view.height))
  const width = Math.max(1, Math.round(view.width * scale))
  const height = Math.max(1, Math.round(view.height * scale))
  const data = new Uint8ClampedArray(width * height * 4)
  const active = layers.filter((layer) => layer && layer.sample && layer.color)
  if (active.length === 0) return { data, width, height }

  // Raster pixel centres, mapped back onto the view's own pixel grid so the
  // two rasters register exactly however the browser scales between them.
  const sx = view.width / width
  const sy = view.height / height

  for (let py = 0; py < height; py++) {
    const viewY = (py + 0.5) * sy
    for (let px = 0; px < width; px++) {
      const here = view.toLatLon((px + 0.5) * sx, viewY)
      // Off the planet: outside an azimuthal disc, or past a pole. Left
      // transparent, which is what keeps the disc's corners empty rather
      // than wrapping the far side of the world into them.
      if (!here) continue
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (const layer of active) {
        const value = layer.sample(here.latitude, here.longitude)
        if (value === null || !Number.isFinite(value)) continue
        const ink = layer.color(value)
        if (!ink || !(ink[3] > 0)) continue
        const sa = Math.min(1, ink[3])
        const out = sa + a * (1 - sa)
        if (out <= 0) continue
        r = (ink[0] * sa + r * a * (1 - sa)) / out
        g = (ink[1] * sa + g * a * (1 - sa)) / out
        b = (ink[2] * sa + b * a * (1 - sa)) / out
        a = out
      }
      if (a <= 0) continue
      const at = (py * width + px) * 4
      data[at] = r
      data[at + 1] = g
      data[at + 2] = b
      data[at + 3] = Math.round(a * 255)
    }
  }
  return { data, width, height }
}
