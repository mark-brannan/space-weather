import { describe, expect, it } from 'vitest'
import {
  TWILIGHT_DEG,
  greylineColor,
  greylineLegend,
  greylineSampler,
  solarElevationDeg,
  subsolarPoint
} from '../public/greyline.js'
import { subsolarPoint as fromDrapMap } from '../public/drapMap.js'
import { rasterize } from '../public/mapRaster.js'
import { mapView } from '../public/projection.js'

const EQUINOX_NOON_UTC = new Date('2026-03-20T12:00:00Z')

describe('solarElevationDeg', () => {
  it('is 90 at the subsolar point and -90 at its antipode', () => {
    const sun = subsolarPoint(EQUINOX_NOON_UTC)
    expect(solarElevationDeg(sun, sun.latitude, sun.longitude)).toBeCloseTo(
      90,
      3
    )
    expect(
      solarElevationDeg(sun, -sun.latitude, sun.longitude + 180)
    ).toBeCloseTo(-90, 3)
  })

  it('puts the equinox terminator on the 90th meridians', () => {
    // At the March equinox at 12:00 UTC the sun is near 0N 0E, so dawn and
    // dusk run down 90W and 90E -- within the equation of time (~8 min, or
    // 2 degrees of longitude) and the declination's drift through the day.
    const sun = subsolarPoint(EQUINOX_NOON_UTC)
    for (const lat of [-60, -30, 0, 30, 60]) {
      expect(Math.abs(solarElevationDeg(sun, lat, 90))).toBeLessThan(2.5)
      expect(Math.abs(solarElevationDeg(sun, lat, -90))).toBeLessThan(2.5)
    }
    expect(solarElevationDeg(sun, 0, 0)).toBeGreaterThan(85)
    expect(solarElevationDeg(sun, 0, 180)).toBeLessThan(-85)
  })

  it('keeps the June pole in daylight and the December pole in night', () => {
    // Midnight sun: at the June solstice the north pole's sun sits at the
    // declination, ~23.4 degrees up, all day; the south pole is as far down.
    for (const hour of ['00', '06', '12', '18']) {
      const sun = subsolarPoint(new Date(`2026-06-21T${hour}:00:00Z`))
      expect(solarElevationDeg(sun, 90, 0)).toBeCloseTo(23.4, 0)
      expect(solarElevationDeg(sun, -90, 0)).toBeCloseTo(-23.4, 0)
    }
  })
})

describe('subsolarPoint', () => {
  it('matches the almanac at the equinox and both solstices', () => {
    // 12:00 UTC: the declination is the season, the longitude is the equation
    // of time (-7.5 min in March puts the sun ~1.9 degrees east of Greenwich).
    const march = subsolarPoint(EQUINOX_NOON_UTC)
    expect(Math.abs(march.latitude)).toBeLessThan(0.1)
    expect(march.longitude).toBeCloseTo(1.9, 0)
    const june = subsolarPoint(new Date('2026-06-21T12:00:00Z'))
    expect(june.latitude).toBeCloseTo(23.44, 1)
    expect(Math.abs(june.longitude)).toBeLessThan(1)
    const december = subsolarPoint(new Date('2026-12-21T12:00:00Z'))
    expect(december.latitude).toBeCloseTo(-23.44, 1)
    expect(Math.abs(december.longitude)).toBeLessThan(1)
  })

  it('is still importable from drapMap.js, and is the same function', () => {
    expect(fromDrapMap).toBe(subsolarPoint)
  })
})

describe('greylineColor', () => {
  it('lights the day, bands the civil twilight, leaves the night as ground', () => {
    const day = greylineColor(30)!
    const grey = greylineColor(-3)!
    expect(day[3]).toBeGreaterThan(0)
    expect(grey[3]).toBeGreaterThan(0)
    // The band is a band: a different colour from day, not only its edge.
    expect(grey.slice(0, 3)).not.toEqual(day.slice(0, 3))
    expect(greylineColor(TWILIGHT_DEG.astronomical)).toBeNull()
    expect(greylineColor(-45)).toBeNull()
    expect(greylineColor(NaN)).toBeNull()
  })

  it('fades through nautical and astronomical twilight, never brightening', () => {
    let previous = greylineColor(TWILIGHT_DEG.civil)![3]
    for (
      let el = TWILIGHT_DEG.civil - 0.5;
      el > TWILIGHT_DEG.astronomical;
      el -= 0.5
    ) {
      const alpha = greylineColor(el)![3]
      expect(alpha).toBeLessThanOrEqual(previous)
      previous = alpha
    }
  })

  it('draws the legend from the same function the map paints with', () => {
    for (const stop of greylineLegend()) {
      expect(stop.rgba).toEqual(greylineColor(stop.elevationDeg))
    }
    expect(greylineLegend().find((s) => s.label === 'Night')!.rgba).toBeNull()
  })
})

describe('the greyline as a map layer', () => {
  const layer = {
    sample: greylineSampler(EQUINOX_NOON_UTC),
    color: greylineColor
  }

  // Both projections, one rule: the pixel over 0N 0E at equinox noon is lit,
  // the pixel over 0N 180E is ground. The raster knows nothing about the
  // projection beyond `view.toLatLon`, so this is registration, not maths.
  for (const projection of ['cylindrical', 'azimuthal']) {
    it(`lights noon and leaves midnight dark on the ${projection} map`, () => {
      const view = mapView({
        projection,
        center: { latitude: 0, longitude: 0 },
        radiusDeg: 200,
        width: 1000,
        height: 400
      })
      const raster = rasterize(view, [layer], { maxSide: 1000 })
      const alphaAt = (lon: number, lat: number) => {
        const at = view.toPixel(lon, lat)!
        const px = Math.floor(at[0] * (raster.width / view.width))
        const py = Math.floor(at[1] * (raster.height / view.height))
        return raster.data[(py * raster.width + px) * 4 + 3]
      }
      expect(alphaAt(0, 0)).toBeGreaterThan(0)
      expect(alphaAt(179, 0)).toBe(0)
      expect(alphaAt(-179, 0)).toBe(0)
    })
  }
})
