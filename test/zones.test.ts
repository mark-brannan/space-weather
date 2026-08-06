import { describe, expect, it } from 'vitest'
import {
  MAX_NOAA_SCALE,
  NoaaScaleValues,
  gScaleForKp,
  stateForScaleValue,
  zoneMethods,
  zonesForKp,
  zonesForScale
} from '../src/parse'
import { matchZone } from './fixtures'

/** Zones travel to the server as JSON, so that is how they must be tested. */
const overTheWire = (zones: any[]) => JSON.parse(JSON.stringify(zones))

describe('stateForScaleValue', () => {
  it('keeps routine levels below the threshold out of alarm states', () => {
    // NOAA's own frequency table: level 1 occurs on roughly a quarter of all
    // days over a solar cycle, level 3 about monthly, level 5 four times per
    // cycle. Anything alarming below the threshold would be constant noise.
    expect(stateForScaleValue(0)).toBe('nominal')
    expect(stateForScaleValue(1)).toBe('normal')
    expect(stateForScaleValue(2)).toBe('normal')
    expect(stateForScaleValue(3)).toBe('alert')
    expect(stateForScaleValue(4)).toBe('warn')
    expect(stateForScaleValue(5)).toBe('alarm')
  })

  it('moves the whole ladder with the threshold', () => {
    expect(stateForScaleValue(1, 1)).toBe('alert')
    expect(stateForScaleValue(2, 1)).toBe('warn')
    expect(stateForScaleValue(3, 1)).toBe('alarm')
    expect(stateForScaleValue(5, 1)).toBe('alarm')

    expect(stateForScaleValue(4, 5)).toBe('normal')
    expect(stateForScaleValue(5, 5)).toBe('alert')
  })

  it('never escalates level 0', () => {
    for (let threshold = 1; threshold <= 5; threshold++) {
      expect(stateForScaleValue(0, threshold)).toBe('nominal')
    }
  })
})

describe('zonesForScale', () => {
  it('matches exactly one zone for every possible scale value', () => {
    // The server tests `value >= lower && value < upper`, so an off-by-one on
    // the top bound leaves an Extreme event matching no zone and producing no
    // notification at all.
    for (const letter of ['G', 'S', 'R']) {
      const zones = overTheWire(zonesForScale(letter))
      for (let value = 0; value <= MAX_NOAA_SCALE; value++) {
        const matches = zones.filter(
          (_: any, index: number) => matchZone(zones, value) === index
        )
        expect(
          matchZone(zones, value),
          `${letter}${value}`
        ).toBeGreaterThanOrEqual(0)
        expect(matches.length).toBe(1)
      }
    }
  })

  it('assigns the documented state to each level at the default threshold', () => {
    const zones = overTheWire(zonesForScale('G'))
    const stateFor = (value: number) => zones[matchZone(zones, value)].state
    expect([0, 1, 2, 3, 4, 5].map(stateFor)).toEqual([
      'nominal',
      'normal',
      'normal',
      'alert',
      'warn',
      'alarm'
    ])
  })

  it('honours a configured threshold', () => {
    const zones = overTheWire(zonesForScale('R', 1))
    const stateFor = (value: number) => zones[matchZone(zones, value)].state
    expect(stateFor(0)).toBe('nominal')
    expect(stateFor(1)).toBe('alert')
    expect(stateFor(2)).toBe('warn')
    expect(stateFor(5)).toBe('alarm')
  })

  it('survives the JSON round trip with no null bounds', () => {
    for (const zone of overTheWire(zonesForScale('G'))) {
      expect(zone.lower).not.toBeNull()
      expect(zone.upper).not.toBeNull()
    }
  })
})

describe('zonesForKp', () => {
  it('maps Kp onto the G scale it defines', () => {
    const zones = overTheWire(zonesForKp())
    const stateFor = (kp: number) => {
      const index = matchZone(zones, kp)
      expect(index, `Kp ${kp}`).toBeGreaterThanOrEqual(0)
      return zones[index].state
    }
    expect(stateFor(0)).toBe('nominal')
    expect(stateFor(4.99)).toBe('nominal')
    expect(stateFor(5)).toBe('normal') // G1
    expect(stateFor(6.5)).toBe('normal') // G2
    expect(stateFor(7)).toBe('alert') // G3
    expect(stateFor(8)).toBe('warn') // G4
    expect(stateFor(9)).toBe('alarm') // G5
  })

  it('still matches Kp 9 after serialisation', () => {
    // Infinity is not representable in JSON and arrives at the server as null,
    // which does not trigger the `upper = Infinity` destructuring default. The
    // top zone therefore has to omit `upper` entirely.
    const zones = overTheWire(zonesForKp())
    const top = zones[zones.length - 1]
    expect('upper' in top).toBe(false)
    expect(matchZone(zones, 9)).toBe(zones.length - 1)
    expect(matchZone(zones, 9.99)).toBe(zones.length - 1)
  })

  it('leaves no gap between adjacent zones', () => {
    const zones = overTheWire(zonesForKp())
    for (let i = 1; i < zones.length; i++) {
      expect(zones[i].lower).toBe(zones[i - 1].upper)
    }
  })
})

describe('gScaleForKp', () => {
  it.each([
    [0, 0],
    [4.99, 0],
    [5, 1],
    [5.67, 1],
    [6, 2],
    [7, 3],
    [8, 4],
    [9, 5],
    [12, 5]
  ])('Kp %s -> G%s', (kp, expected) => {
    expect(gScaleForKp(kp)).toBe(expected)
  })

  it('is defensive about non-numeric input', () => {
    expect(gScaleForKp(NaN)).toBe(NoaaScaleValues.NONE)
    expect(gScaleForKp(Infinity)).toBe(NoaaScaleValues.NONE)
  })
})

describe('zoneMethods', () => {
  it('leaves everything up to and including alert silent', () => {
    // A state is informational; the method array is what actually interrupts
    // the user. Only the top two bands are allowed to.
    const methods = zoneMethods(true, true)
    expect(methods.nominalMethod).toEqual([])
    expect(methods.normalMethod).toEqual([])
    expect(methods.alertMethod).toEqual([])
    expect(methods.warnMethod).toEqual(['visual'])
    expect(methods.alarmMethod).toEqual(['visual', 'sound'])
  })

  it('respects the configured notification methods', () => {
    expect(zoneMethods(false, false).alarmMethod).toEqual([])
    expect(zoneMethods(true, false).alarmMethod).toEqual(['visual'])
    expect(zoneMethods(false, true).alarmMethod).toEqual(['sound'])
    expect(zoneMethods(false, true).warnMethod).toEqual([])
  })
})
