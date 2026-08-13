import { describe, expect, it } from 'vitest'
import {
  ALARM_LEVEL_OPTIONS,
  AURORA_WIRE_KB,
  DAYS_PER_MONTH,
  DEFAULTS,
  OTHER_WIRE_KB,
  STORM_DAYS_PER_YEAR,
  currentConditions,
  dailyKb,
  formatKb,
  gScaleForKp,
  ladderFor,
  methodForState,
  panelSettings,
  settingsDiffer,
  stateForScaleValue,
  verdictFor
} from '../public/config-panel.js'
import { schema, settingsFrom } from '../src/config'
import {
  NotificationStates,
  gScaleForKp as pluginGScaleForKp,
  methodForState as pluginMethodForState,
  stateForScaleValue as pluginStateForScaleValue
} from '../src/parse'

const LEVELS = [0, 1, 2, 3, 4, 5]
const ALARM_LEVELS = [1, 2, 3, 4, 5]

/**
 * The panel is served as plain JavaScript out of public/ and cannot import
 * from dist/, so two rules it depends on are copies. These are what makes a
 * copy safe: both functions are total over a domain small enough to check
 * exhaustively, so a divergence is a test failure rather than a panel that
 * describes something the plugin does not do.
 */
describe('the panel agrees with the plugin about loudness', () => {
  it('maps every level and alarm level to the same state', () => {
    for (const alarmLevel of ALARM_LEVELS) {
      for (const value of LEVELS) {
        expect(stateForScaleValue(value, alarmLevel)).toBe(
          pluginStateForScaleValue(value, alarmLevel)
        )
      }
    }
  })

  it('reads the same G level out of every Kp the forecast can carry', () => {
    for (let tenths = 0; tenths <= 90; tenths++) {
      const kp = tenths / 10
      expect(gScaleForKp(kp)).toBe(pluginGScaleForKp(kp))
    }
    expect(gScaleForKp(NaN)).toBe(pluginGScaleForKp(NaN))
  })

  it('maps every state to the same notification methods', () => {
    for (const state of Object.values(NotificationStates)) {
      expect(methodForState(state)).toEqual(pluginMethodForState(state))
    }
  })
})

describe('the panel agrees with the schema about choices', () => {
  it('defaults an absent key to what the schema would have', () => {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      expect(schema.properties[key].default).toBe(value)
    }
    expect(Object.keys(DEFAULTS).sort()).toEqual(
      Object.keys(schema.properties).sort()
    )
  })

  it('offers exactly the alarm levels the schema offers, in the same order', () => {
    expect(ALARM_LEVEL_OPTIONS.map((option) => option.value)).toEqual(
      schema.properties.alarmLevel.oneOf.map((option: any) => option.const)
    )
  })

  it('quotes each level at the rate the schema quotes it', () => {
    for (const option of ALARM_LEVEL_OPTIONS) {
      const fromSchema = schema.properties.alarmLevel.oneOf.find(
        (candidate: any) => candidate.const === option.value
      )
      expect(fromSchema.title).toContain(option.rate)
    }
  })
})

describe('panelSettings', () => {
  it('produces values settingsFrom reads back unchanged', () => {
    const configurations = [
      {},
      { alarmLevel: 3, auroraEnabled: true, auroraInterval: 15 },
      { updateInterval: 5, sendAdvisoryOutlook: false },
      // Out of range, half-typed and hostile, all of which the number and
      // select controls can produce before a save.
      { alarmLevel: 9, auroraInterval: '', updateInterval: -1 },
      { alarmLevel: 'nonsense', auroraInterval: null }
    ]
    for (const configuration of configurations) {
      const shown = panelSettings(configuration)
      expect(settingsFrom(shown)).toEqual(shown)
    }
  })

  it('leaves a superseded key to the plugin rather than translating it', () => {
    // `zoneAlertThreshold` migrates to alarmLevel 3 in settingsFrom. The panel
    // must not do that itself -- it shows the saved side, and the status route
    // is how it learns the two disagree.
    const saved = { zoneAlertThreshold: 1 }
    expect(panelSettings(saved).alarmLevel).toBe(DEFAULTS.alarmLevel)
    expect(settingsFrom(saved).alarmLevel).toBe(3)
    expect(settingsDiffer(panelSettings(saved), settingsFrom(saved))).toBe(true)
  })
})

describe('settingsDiffer', () => {
  it('says no when the status route has not answered', () => {
    expect(settingsDiffer(panelSettings({}), null)).toBe(false)
  })

  it('says no when the running plugin matches what is shown', () => {
    const saved = { alarmLevel: 4, auroraEnabled: true, auroraInterval: 30 }
    expect(settingsDiffer(panelSettings(saved), settingsFrom(saved))).toBe(
      false
    )
  })

  it('says yes when a default is supplying a value nothing was saved with', () => {
    expect(
      settingsDiffer(panelSettings({}), { ...settingsFrom({}), alarmLevel: 2 })
    ).toBe(true)
  })
})

describe('dailyKb', () => {
  const settings = panelSettings({})

  it('counts nothing for aurora while aurora is off', () => {
    expect(dailyKb(settings).aurora).toBe(0)
    expect(dailyKb(settings).total).toBe(
      dailyKb(settings).other + dailyKb(settings).fixed
    )
  })

  it('charges one wire payload per interval per day', () => {
    const day = dailyKb({ ...settings, auroraEnabled: true })
    expect(day.other).toBeCloseTo((1440 / 60) * OTHER_WIRE_KB)
    expect(day.aurora).toBeCloseTo((1440 / 120) * AURORA_WIRE_KB)
    expect(day.total).toBeCloseTo(day.aurora + day.other + day.fixed)
  })

  it('does not move the bulletins when an interval is halved', () => {
    // The whole point of the row: it is what the plugin costs however far the
    // two intervals are opened up, so it must not scale with either.
    const base = dailyKb(settings)
    const faster = dailyKb({ ...settings, updateInterval: 30 })
    expect(faster.fixed).toBe(base.fixed)
    expect(faster.other).toBeCloseTo(base.other * 2)
  })

  it('drops the weekly bulletin when the advisory outlook is off', () => {
    const on = dailyKb({ ...settings, sendAdvisoryOutlook: true })
    const off = dailyKb({ ...settings, sendAdvisoryOutlook: false })
    expect(off.fixed).toBeLessThan(on.fixed)
    // The daily 27-day outlook is not a setting, so it never reaches zero.
    expect(off.fixed).toBeGreaterThan(0)
  })

  it('doubles when an interval is halved', () => {
    const base = dailyKb({ ...settings, auroraEnabled: true })
    const faster = dailyKb({
      ...settings,
      auroraEnabled: true,
      auroraInterval: 60
    })
    expect(faster.aurora).toBeCloseTo(base.aurora * 2)
  })

  it('charges a cleared interval what the plugin will spend on it', () => {
    // An empty number field means the default, because that is what
    // settingsFrom will make of it -- not zero, and not a division by zero.
    const cleared = dailyKb({
      ...settings,
      auroraEnabled: true,
      auroraInterval: '',
      updateInterval: ''
    })
    expect(cleared).toEqual(dailyKb({ ...settings, auroraEnabled: true }))
  })

  it('is the figure the schema used to quote, at the interval it assumed', () => {
    // The description this panel replaced said "about 1.7 MB a day", true only
    // at the 120-minute default. That number is now computed, and this pins it
    // to the same place the sentence started from.
    const day = dailyKb({ ...settings, auroraEnabled: true })
    expect(day.aurora / 1024).toBeCloseTo(1.7, 1)
  })
})

describe('formatKb', () => {
  it('reports in the unit an airtime plan is sold in', () => {
    expect(formatKb(120)).toBe('120 KB')
    expect(formatKb(1740)).toBe('1.70 MB')
    expect(formatKb(50 * 1024)).toBe('50.0 MB')
    expect(formatKb(2 * 1024 * 1024)).toBe('2.00 GB')
  })
})

describe('ladderFor', () => {
  it('runs loudest first and covers every NOAA level', () => {
    expect(ladderFor(5).map((row) => row.level)).toEqual([5, 4, 3, 2, 1])
  })

  it('places the alarm, the popup and the silent notice at the default', () => {
    const rows = ladderFor(5)
    const at = (level: number) => rows.find((row) => row.level === level)
    expect(at(5).state).toBe('alarm')
    expect(at(5).method).toEqual(['visual', 'sound'])
    expect(at(4).state).toBe('warn')
    expect(at(4).method).toEqual(['visual'])
    expect(at(3).state).toBe('alert')
    expect(at(3).method).toEqual([])
    expect(at(2).state).toBe('normal')
    expect(at(1).state).toBe('normal')
  })

  it('moves the whole ladder down with the alarm level', () => {
    const rows = ladderFor(3)
    const at = (level: number) => rows.find((row) => row.level === level)
    expect([at(5).state, at(4).state, at(3).state]).toEqual([
      'alarm',
      'alarm',
      'alarm'
    ])
    expect(at(2).state).toBe('warn')
    expect(at(1).state).toBe('alert')
  })

  it('leaves no alarm level unable to sound', () => {
    for (const alarmLevel of ALARM_LEVELS) {
      expect(
        ladderFor(alarmLevel).some((row) => row.method.includes('sound'))
      ).toBe(true)
    }
  })

  it('is monotonically louder as the alarm level is lowered', () => {
    let previous = 0
    for (let alarmLevel = 5; alarmLevel >= 1; alarmLevel--) {
      const audible = ladderFor(alarmLevel).filter((row) =>
        row.method.includes('sound')
      ).length
      expect(audible).toBeGreaterThanOrEqual(previous)
      previous = audible
    }
  })

  it('carries a rate for every level, rarer as the level rises', () => {
    const rows = ladderFor(5)
    for (const row of rows) {
      expect(row.stormDaysPerYear).toBe(STORM_DAYS_PER_YEAR[row.level])
    }
    for (let level = 2; level <= 5; level++) {
      expect(STORM_DAYS_PER_YEAR[level]).toBeLessThan(
        STORM_DAYS_PER_YEAR[level - 1]
      )
    }
  })
})

describe('a month', () => {
  it('is short enough that every calendar month has one', () => {
    expect(DAYS_PER_MONTH).toBeLessThanOrEqual(28 + 2)
  })
})

/** A Signal K leaf, as the data API serves one. */
const leaf = (value: any) => ({ value, timestamp: '2026-08-13T09:00:00.000Z' })

describe('currentConditions', () => {
  it('says nothing rather than "quiet" when nothing has been published', () => {
    expect(currentConditions(null, null)).toBeNull()
    // A path described at startup but never published carries meta and no
    // value, which is a product that failed rather than a level of zero.
    expect(currentConditions({ G: { meta: {} } }, null)).toBeNull()
  })

  it('reports only the scales that have a value', () => {
    const now = currentConditions({ G: leaf(2), S: leaf(0) }, null)
    expect(now.levels).toEqual({ G: 2, S: 0 })
    expect(now.worst).toEqual({ letter: 'G', level: 2 })
  })

  it('leads with the scale that costs a boat the most on a tie', () => {
    expect(
      currentConditions({ G: leaf(3), R: leaf(3), S: leaf(3) }, null).worst
    ).toEqual({ letter: 'G', level: 3 })
    expect(currentConditions({ R: leaf(3), S: leaf(3) }, null).worst).toEqual({
      letter: 'R',
      level: 3
    })
  })

  it('carries the forecast peak as the G level it would reach', () => {
    const now = currentConditions(null, {
      observed: leaf(6.33),
      forecast: { max24h: leaf(5.67) }
    })
    expect(now.observedKp).toBe(6.33)
    // 5.67 is 6-, the bottom of NOAA's Kp 6 band, so G2 rather than G1.
    expect(now.forecast).toEqual({ kp: 5.67, level: 2 })
    expect(now.worst).toBeNull()
  })
})

describe('verdictFor', () => {
  it('is vacuous at level 0, which is why the panel does not quote it', () => {
    // `nominal` -- nothing, at every alarm level. Rendering "the worst in
    // force is G0, which at this setting is nominal" both claims something is
    // in force when nothing is, and implies the setting decided it.
    for (const alarmLevel of ALARM_LEVELS) {
      expect(verdictFor(0, alarmLevel)).toEqual({
        state: 'nominal',
        method: [],
        effect: 'nothing'
      })
    }
  })

  it('names the ladder row a level is sitting on', () => {
    for (const alarmLevel of ALARM_LEVELS) {
      for (const level of LEVELS) {
        const verdict = verdictFor(level, alarmLevel)
        const row = ladderFor(alarmLevel).find((r) => r.level === level)
        expect(verdict.state).toBe(stateForScaleValue(level, alarmLevel))
        if (row) {
          expect(verdict).toEqual({
            state: row.state,
            method: row.method,
            effect: row.effect
          })
        }
      }
    }
  })
})
