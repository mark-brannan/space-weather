import { describe, expect, it } from 'vitest'
import { PROJECTIONS, mapView } from '../public/projection.js'
import { bearingDeg, distanceKm } from '../public/drapMap.js'

const EARTH_RADIUS_KM = 6371
const R2D = 180 / Math.PI

describe('azimuthal equidistant', () => {
  const project = PROJECTIONS.azimuthal.create(38, -40)

  it('maps its own centre to the origin', () => {
    const [x, y] = project.forward(-40, 38)
    expect(x).toBeCloseTo(0, 9)
    expect(y).toBeCloseTo(0, 9)
  })

  it('is true to scale: distance from the origin is the great-circle distance', () => {
    // The whole reason this projection is here. If it ever stops holding,
    // the probe's straight line stops being the path it claims to be.
    for (const target of [
      { latitude: 60, longitude: -20 },
      { latitude: -33, longitude: 151 },
      { latitude: 0, longitude: 100 }
    ]) {
      const [x, y] = project.forward(target.longitude, target.latitude)
      const drawn = Math.hypot(x, y) * EARTH_RADIUS_KM
      const real = distanceKm({ latitude: 38, longitude: -40 }, target)
      expect(drawn).toBeCloseTo(real, 3)
    }
  })

  it('preserves bearing from the centre', () => {
    for (const target of [
      { latitude: 70, longitude: -40 },
      { latitude: 10, longitude: 20 },
      { latitude: -20, longitude: -120 }
    ]) {
      const [x, y] = project.forward(target.longitude, target.latitude)
      // Screen-space bearing: +y is north, +x is east.
      const drawn = (((Math.atan2(x, y) * R2D) % 360) + 360) % 360
      const real = bearingDeg({ latitude: 38, longitude: -40 }, target)
      expect(drawn).toBeCloseTo(real, 4)
    }
  })

  it('round-trips forward and back across the whole sphere', () => {
    for (let lat = -85; lat <= 85; lat += 17) {
      for (let lon = -175; lon <= 175; lon += 23) {
        const [x, y] = project.forward(lon, lat)
        const back = project.inverse(x, y)
        expect(back).not.toBeNull()
        expect(back!.latitude).toBeCloseTo(lat, 6)
        // Longitude is meaningless at a pole, and these are not poles.
        expect(Math.cos((back!.longitude - lon) / R2D)).toBeCloseTo(1, 6)
      }
    }
  })

  it('answers nothing outside the boundary circle', () => {
    // Past pi radians of arc is not a place on the planet. This is what keeps
    // the disc's corners transparent instead of wrapping the far side of the
    // world into them, and what makes a click out there a non-event.
    expect(project.inverse(Math.PI + 0.05, 0)).toBeNull()
    expect(project.inverse(3, 3)).toBeNull()
    expect(project.inverse(Math.PI - 0.01, 0)).not.toBeNull()
  })

  it('keeps the exact antipode finite, where bearing is undefined', () => {
    // Every bearing is equally "toward" the antipode -- there is no right
    // answer for which edge pixel it lands on, only a wrong one (NaN) to
    // avoid. Antipode of 38N 40W is 38S 140E.
    const [x, y] = project.forward(140, -38)
    expect(Number.isFinite(x)).toBe(true)
    expect(Number.isFinite(y)).toBe(true)
    expect(Math.hypot(x, y)).toBeLessThanOrEqual(Math.PI)
  })
})

describe('equidistant cylindrical', () => {
  it('round-trips forward and back around its own centre', () => {
    const project = PROJECTIONS.cylindrical.create(55, 170)
    for (let dLat = -30; dLat <= 30; dLat += 10) {
      for (let dLon = -170; dLon <= 170; dLon += 34) {
        const lat = 55 + dLat
        const lon = ((((170 + dLon + 180) % 360) + 360) % 360) - 180
        const [x, y] = project.forward(lon, lat)
        const back = project.inverse(x, y)
        expect(back).not.toBeNull()
        expect(back!.latitude).toBeCloseTo(lat, 9)
        expect(Math.cos((back!.longitude - lon) / R2D)).toBeCloseTo(1, 9)
      }
    }
  })

  it('crosses the antimeridian without tearing', () => {
    // Centred at 170E, a point at 170W is 20 degrees east, not 340 west.
    const project = PROJECTIONS.cylindrical.create(0, 170)
    const [x] = project.forward(-170, 0)
    expect(x).toBeCloseTo(20, 9)
  })

  it('compensates longitude at high latitude on a regional view', () => {
    // A degree of longitude is half a degree of latitude's width at 60N, and
    // a close-up says so rather than drawing a window twice as wide as it is
    // tall. Standard parallel at the centre is what does this.
    const equator = PROJECTIONS.cylindrical.create(0, 0, 15)
    const high = PROJECTIONS.cylindrical.create(60, 0, 15)
    expect(equator.forward(10, 0)[0]).toBeCloseTo(10, 9)
    expect(high.forward(10, 60)[0]).toBeCloseTo(5, 1)
  })

  it('drops the compensation once the view is hemispheric', () => {
    // Keeping it would squeeze a whole-world map into a rectangle that cannot
    // reach either pole -- which it did, and which drew the eastern and
    // western thirds of the world as empty page.
    const high = PROJECTIONS.cylindrical.create(60, 0, 180)
    expect(high.forward(10, 60)[0]).toBeCloseTo(10, 9)
  })

  it('answers nothing past a pole', () => {
    const project = PROJECTIONS.cylindrical.create(80, 0)
    expect(project.inverse(0, 20)).toBeNull()
    expect(project.inverse(0, 5)).not.toBeNull()
  })
})

describe('mapView', () => {
  const center = { latitude: 47.6, longitude: -122.3 }

  for (const projection of ['azimuthal', 'cylindrical'] as const) {
    describe(projection, () => {
      const view = mapView({
        projection,
        center,
        radiusDeg: 60,
        width: 900,
        height: 420
      })

      it('puts the centre it settled on in the middle of the canvas', () => {
        // Not necessarily the vessel: a cylindrical window taller than the
        // room above the boat slides toward the equator rather than drawing
        // the space past the pole. `view.center` is what it settled on.
        const at = view.toPixel(view.center.longitude, view.center.latitude)!
        expect(at[0]).toBeCloseTo(450, 6)
        expect(at[1]).toBeCloseTo(210, 6)
      })

      it('round-trips a pixel through the position it draws there', () => {
        for (const [px, py] of [
          [450, 210],
          [500, 240],
          [430, 190]
        ]) {
          const here = view.toLatLon(px, py)!
          expect(here).not.toBeNull()
          const back = view.toPixel(here.longitude, here.latitude)!
          expect(back[0]).toBeCloseTo(px, 4)
          expect(back[1]).toBeCloseTo(py, 4)
        }
      })

      it('draws north above the centre and east to its right', () => {
        const north = view.toPixel(
          view.center.longitude,
          view.center.latitude + 5
        )!
        const east = view.toPixel(
          view.center.longitude + 5,
          view.center.latitude
        )!
        expect(north[1]).toBeLessThan(210)
        expect(east[0]).toBeGreaterThan(450)
      })
    })
  }

  it('scales an azimuthal disc to cover the viewport, not to fit in it', () => {
    // Wasted space either side of the map is the complaint issue #177 was
    // filed about: at the chosen radius the picture reaches the long edge.
    const view = mapView({
      projection: 'azimuthal',
      center: { latitude: 0, longitude: 0 },
      radiusDeg: 90,
      width: 900,
      height: 420
    })
    const east = view.toPixel(90, 0)!
    expect(east[0]).toBeCloseTo(900, 6)
  })

  it('keeps a flat window inside the planet, sliding the centre if it must', () => {
    // A 57-degree-tall window centred on a boat at 47.6N would run 14 degrees
    // past the north pole and draw the overhang as empty page.
    const view = mapView({
      projection: 'cylindrical',
      center,
      radiusDeg: 60,
      width: 900,
      height: 420
    })
    const top = view.toLatLon(450, 0)!
    const bottom = view.toLatLon(450, 420)!
    expect(top.latitude).toBeLessThanOrEqual(90)
    expect(bottom.latitude).toBeGreaterThanOrEqual(-90)
    expect(view.center.latitude).toBeLessThan(center.latitude)
    // The vessel is still on screen -- sliding the centre is not the same as
    // losing the boat.
    expect(view.toPixel(center.longitude, center.latitude)![1]).toBeGreaterThan(
      0
    )
  })

  it('leaves an azimuthal disc centred on the vessel at any zoom', () => {
    for (const radiusDeg of [15, 60, 180]) {
      const view = mapView({
        projection: 'azimuthal',
        center,
        radiusDeg,
        width: 900,
        height: 420
      })
      expect(view.center.latitude).toBe(center.latitude)
      const at = view.toPixel(center.longitude, center.latitude)!
      expect(at[0]).toBeCloseTo(450, 6)
      expect(at[1]).toBeCloseTo(210, 6)
    }
  })

  it('shows a whole turn of longitude on a flat map, at any latitude', () => {
    // The standard parallel compresses longitude, so the scale that fills the
    // width depends on it. Missing that drew the eastern and western thirds of
    // the world as empty page, from a boat at 48N.
    for (const latitude of [0, 47.6, 68]) {
      const view = mapView({
        projection: 'cylindrical',
        center: { latitude, longitude: -122.3 },
        radiusDeg: 180,
        width: 900,
        height: 420
      })
      expect(view.toLatLon(1, 210)).not.toBeNull()
      expect(view.toLatLon(899, 210)).not.toBeNull()
      expect(Math.abs(view.center.latitude)).toBeLessThan(10)
    }
  })

  it('keeps the window inside the planet at every shape, latitude and zoom', () => {
    // The clamp is applied against a scale that the standard parallel then
    // changes, so settling it takes more than one pass. Clamping once left a
    // wide, short tile at 60N showing eight degrees of empty sky past the
    // pole -- visible, and not caught by any single-case check.
    for (const width of [760, 900, 1100]) {
      for (const height of [340, 420, 460]) {
        for (const latitude of [-85, -60, -30, 0, 30, 47.6, 60, 85]) {
          for (let radiusDeg = 20; radiusDeg <= 180; radiusDeg += 5) {
            const view = mapView({
              projection: 'cylindrical',
              center: { latitude, longitude: 12 },
              radiusDeg,
              width,
              height
            })
            const halfHeightDeg = height / 2 / view.scale
            expect(view.center.latitude + halfHeightDeg).toBeLessThanOrEqual(
              90.001
            )
            expect(view.center.latitude - halfHeightDeg).toBeGreaterThanOrEqual(
              -90.001
            )
          }
        }
      }
    }
  })

  it('never draws more than one turn of longitude on a flat map', () => {
    // Zoomed all the way out on a viewport far wider than it is tall, the
    // scale is held up by the width rather than the height, so the same ocean
    // is not painted twice.
    const view = mapView({
      projection: 'cylindrical',
      center: { latitude: 0, longitude: 0 },
      radiusDeg: 180,
      width: 900,
      height: 200
    })
    expect(view.toPixel(180, 0)![0]).toBeCloseTo(900, 6)
    expect(view.toPixel(-180, 0)![0]).toBeCloseTo(0, 6)
  })

  it('falls back to 0,0 when the centre is not yet a fix', () => {
    // 'awaiting-position' passes no centre at all; a boat with a GPS fault
    // could hand back NaN. Either way mapView must produce a usable view
    // rather than propagate the non-finite value into every pixel.
    for (const center of [undefined, {}, { latitude: NaN, longitude: NaN }]) {
      const view = mapView({
        projection: 'cylindrical',
        center,
        radiusDeg: 60,
        width: 900,
        height: 420
      })
      expect(view.center).toEqual({ latitude: 0, longitude: 0 })
      expect(view.toPixel(0, 0)).not.toBeNull()
    }
  })

  it('agrees with toPixel through the separable x/y accessors', () => {
    // coast-wright's `limn` and the graticule call x() and y() one
    // coordinate at a time rather than toPixel's paired call; they must
    // land on the same pixel or the coastline and the map disagree.
    const view = mapView({
      projection: 'cylindrical',
      center: { latitude: 47.6, longitude: -122.3 },
      radiusDeg: 60,
      width: 900,
      height: 420
    })
    for (const [lon, lat] of [
      [-122.3, 47.6],
      [-90, 30],
      [10, -20]
    ]) {
      const [px, py] = view.toPixel(lon, lat)!
      expect(view.x(lon)).toBeCloseTo(px, 6)
      expect(view.y(lat)).toBeCloseTo(py, 6)
    }
  })
})
