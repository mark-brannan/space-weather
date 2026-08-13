import { describe, expect, it } from 'vitest'
import {
  ALARM_NEVER,
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
  it('keeps routine levels below the alarm level out of alarm states', () => {
    expect(stateForScaleValue(0)).toBe('nominal')
    expect(stateForScaleValue(1)).toBe('normal')
    expect(stateForScaleValue(2)).toBe('normal')
    expect(stateForScaleValue(3)).toBe('alert')
    expect(stateForScaleValue(4)).toBe('warn')
    expect(stateForScaleValue(5)).toBe('alarm')
  })

  it('moves the whole ladder when only the alarm level is given', () => {
    // With no popup level the band sits one below the alarm, which is the
    // ladder this had when there was a single setting.
    expect([1, 2, 3, 4, 5].map((v) => stateForScaleValue(v, 3))).toEqual([
      'alert',
      'warn',
      'alarm',
      'alarm',
      'alarm'
    ])
    expect([1, 2, 3, 4, 5].map((v) => stateForScaleValue(v, 1))).toEqual([
      'alarm',
      'alarm',
      'alarm',
      'alarm',
      'alarm'
    ])
  })

  it('sounds nothing at ALARM_NEVER, and still shows the top levels', () => {
    // The one alarm setting that deliberately cannot sound. G5 still pops up
    // and G4 and G3 are still listed, so the loudest events remain visible --
    // the bug the test below guards against was a choice that looked loud and
    // was silent.
    expect(stateForScaleValue(5, ALARM_NEVER)).toBe('warn')
    expect(stateForScaleValue(4, ALARM_NEVER)).toBe('alert')
    expect(stateForScaleValue(3, ALARM_NEVER)).toBe('alert')
    expect(
      [1, 2, 3, 4, 5].map((v) => stateForScaleValue(v, ALARM_NEVER))
    ).not.toContain('alarm')
  })

  it('takes a popup level independent of the alarm level', () => {
    // The whole reason there are two: at the default the popup band is one
    // level wide, and moving the alarm out of the way widens it rather than
    // dragging it down. Under the single anchor this replaced, silencing the
    // alarm also took G4's popup away.
    expect([3, 4, 5].map((v) => stateForScaleValue(v, ALARM_NEVER, 4))).toEqual(
      ['alert', 'warn', 'warn']
    )
    expect([3, 4, 5].map((v) => stateForScaleValue(v, 5, 3))).toEqual([
      'warn',
      'warn',
      'alarm'
    ])
  })

  it('lists Strong and above however quiet the two thresholds are', () => {
    // A G3 is several a year, not several a day. There is no setting at which
    // one should leave no trace: `alert` carries an empty method array, so
    // this costs the user nothing but a line in the notification list.
    for (const value of [3, 4, 5]) {
      expect(
        stateForScaleValue(value, ALARM_NEVER, ALARM_NEVER),
        `value ${value}`
      ).toBe('alert')
    }
    expect(stateForScaleValue(2, ALARM_NEVER, ALARM_NEVER)).toBe('normal')
    expect(stateForScaleValue(1, ALARM_NEVER, ALARM_NEVER)).toBe('normal')
  })

  it('keeps the quiet rung against the popup band below the floor', () => {
    // Below ALERT_FLOOR the listed rung follows the popup down instead of
    // leaving a gap of `normal` between two adjacent bands.
    expect([1, 2, 3].map((v) => stateForScaleValue(v, 5, 2))).toEqual([
      'alert',
      'warn',
      'warn'
    ])
  })

  it('leaves the quiet rung at the floor when there is no popup band', () => {
    // The rung follows the popup band down so the two are never separated by a
    // gap of `normal`. A popup of ALARM_NEVER opens no band for it to stay
    // against, so it stays where ALERT_FLOOR puts it -- which is why the two
    // are not interchangeable once the alarm is low enough to notice.
    expect(stateForScaleValue(2, 3, ALARM_NEVER)).toBe('normal')
    expect(stateForScaleValue(2, 3, 3)).toBe('alert')
  })

  it('is monotonically louder as the popup level comes down', () => {
    const loud = (popupLevel: number) =>
      [1, 2, 3, 4, 5].filter((v) =>
        ['warn', 'alarm'].includes(stateForScaleValue(v, 5, popupLevel))
      ).length
    expect([ALARM_NEVER, 5, 4, 3, 2, 1].map(loud)).toEqual([1, 1, 2, 3, 4, 5])
  })

  it('leaves no threshold pair that silences the level it names', () => {
    // The failure mode this whole arrangement exists to avoid: a setting that
    // reads as a choice about loudness and turns out to be inert.
    for (let alarmLevel = 1; alarmLevel <= 5; alarmLevel++) {
      expect(
        stateForScaleValue(alarmLevel, alarmLevel),
        `alarm ${alarmLevel}`
      ).toBe('alarm')
      for (let popupLevel = 1; popupLevel <= alarmLevel; popupLevel++) {
        const state = stateForScaleValue(popupLevel, alarmLevel, popupLevel)
        expect(state, `alarm ${alarmLevel}, popup ${popupLevel}`).toMatch(
          /^(warn|alarm)$/
        )
      }
    }
  })

  it('leaves no alarm level that cannot sound', () => {
    // The reason each threshold names the level its own band opens at rather
    // than deriving from an attention threshold below it. Deriving upward, a
    // pivot of 4 could never reach `alarm` and a pivot of 5 could not even
    // reach `warn` -- the two loudest-looking choices silenced the plugin.
    // ALARM_NEVER is exempt by name rather than by the loop bound: it is the
    // one silent setting, and it is labelled as one.
    for (let alarmLevel = 1; alarmLevel <= 5; alarmLevel++) {
      const states = [1, 2, 3, 4, 5].map((v) =>
        stateForScaleValue(v, alarmLevel)
      )
      expect(states, `alarmLevel ${alarmLevel}`).toContain('alarm')
    }
  })

  it('is monotonically louder as the alarm level comes down', () => {
    const alarms = (alarmLevel: number) =>
      [1, 2, 3, 4, 5].filter(
        (v) => stateForScaleValue(v, alarmLevel) === 'alarm'
      ).length
    expect([5, 4, 3, 2, 1].map(alarms)).toEqual([1, 2, 3, 4, 5])
  })

  it('never escalates level 0', () => {
    for (let alarmLevel = 1; alarmLevel <= 5; alarmLevel++) {
      expect(stateForScaleValue(0, alarmLevel)).toBe('nominal')
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

  it('assigns the documented state to each level at the default alarm level', () => {
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

  it('honours a configured alarm level', () => {
    const zones = overTheWire(zonesForScale('R', 3))
    const stateFor = (value: number) => zones[matchZone(zones, value)].state
    expect(stateFor(0)).toBe('nominal')
    expect(stateFor(1)).toBe('alert')
    expect(stateFor(2)).toBe('warn')
    expect(stateFor(3)).toBe('alarm')
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
    expect(stateFor(4.33)).toBe('nominal')
    expect(stateFor(5)).toBe('normal') // G1
    expect(stateFor(6.5)).toBe('normal') // G2
    expect(stateFor(7)).toBe('alert') // G3
    expect(stateFor(8)).toBe('warn') // G4
    expect(stateFor(9)).toBe('alarm') // G5
  })

  it('opens each band a third below the Kp NOAA names it after', () => {
    // NOAA's `G4 = Kp 8` means the whole 8 band, so 8- belongs to G4 and the
    // value below it to G3. The zone list is [below storm, G1..G5], so the
    // matched index is the G level -- and unlike the state it tells G1 and G2
    // apart, which at the default alarm level are both `normal`.
    const zones = overTheWire(zonesForKp())
    const bandFor = (kp: number) => matchZone(zones, kp)
    // Each pair is a band floor and the highest Kp NOAA publishes below it.
    expect(bandFor(4.33)).toBe(0)
    expect(bandFor(4.667)).toBe(1)
    expect(bandFor(5.33)).toBe(1)
    expect(bandFor(5.667)).toBe(2)
    expect(bandFor(6.33)).toBe(2)
    expect(bandFor(6.667)).toBe(3)
    expect(bandFor(7.33)).toBe(3)
    expect(bandFor(7.667)).toBe(4)
    expect(bandFor(8.33)).toBe(4)
    expect(bandFor(8.667)).toBe(5)
  })

  it('bands a third however NOAA spells it', () => {
    // The one value reaches us as 7.67 from the JSON products and 7.667 from
    // the GFZ archive, so the floor cannot be rounded to either precision
    // without excluding the other.
    const zones = overTheWire(zonesForKp())
    for (const [rounded, exact] of [
      [4.67, 4.667],
      [5.67, 5.667],
      [6.67, 6.667],
      [7.67, 7.667],
      [8.67, 8.667]
    ]) {
      expect(matchZone(zones, rounded), `Kp ${rounded}`).toBe(
        matchZone(zones, exact)
      )
    }
  })

  it('still matches Kp 9 after serialisation', () => {
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
    [4.33, 0],
    [4.667, 1],
    [5, 1],
    [5.33, 1],
    [5.667, 2],
    [6, 2],
    [6.33, 2],
    [6.667, 3],
    [7, 3],
    [7.33, 3],
    [7.667, 4],
    [8, 4],
    [8.33, 4],
    [8.667, 5],
    [9, 5],
    [12, 5]
  ])('Kp %s -> G%s', (kp, expected) => {
    expect(gScaleForKp(kp)).toBe(expected)
  })

  it('agrees with the zones for every Kp a NOAA feed can carry', () => {
    // Two derivations of one banding: a value published as G4 must not land in
    // the G3 zone, or the webapp and the notification disagree about the same
    // storm.
    const zones = overTheWire(zonesForKp())
    for (let third = 0; third <= 27; third++) {
      const kp = third / 3
      expect(matchZone(zones, kp), `Kp ${kp}`).toBe(gScaleForKp(kp))
    }
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
    const methods = zoneMethods()
    expect(methods.nominalMethod).toEqual([])
    expect(methods.normalMethod).toEqual([])
    expect(methods.alertMethod).toEqual([])
    expect(methods.warnMethod).toEqual(['visual'])
    expect(methods.alarmMethod).toEqual(['visual', 'sound'])
  })

  it('escalates emergency the same as alarm', () => {
    expect(zoneMethods().emergencyMethod).toEqual(['visual', 'sound'])
  })

  it('takes no arguments, so state is the only thing that sets loudness', () => {
    // Pins that a per-method override cannot come back as a positional
    // argument by accident.
    expect(zoneMethods.length).toBe(0)
  })
})
