import { describe, expect, it } from 'vitest'
import {
  ALARM_NEVER,
  AURORA_WIRE_KB,
  LEVEL_OPTIONS,
  levelOptionLabel,
  DAYS_PER_MONTH,
  DEFAULTS,
  OTHER_WIRE_KB,
  RATE,
  currentConditions,
  A_INDEX_WIRE_KB,
  F107_WIRE_KB,
  OUTLOOK27_WIRE_KB,
  SUNSPOT_WIRE_KB,
  dailyKb,
  DRAP_WIRE_KB,
  formatKb,
  gScaleForKp,
  ladderFor,
  lineUnder,
  methodForState,
  nearestLevel,
  panelSettings,
  settingsDiffer,
  stateForScaleValue,
  stepLevel,
  verdictFor,
  withLevel
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
const THRESHOLDS = [1, 2, 3, 4, 5, ALARM_NEVER]

/**
 * The panel is served as plain JavaScript out of public/ and cannot import
 * from dist/, so two rules it depends on are copies. These are what makes a
 * copy safe: both functions are total over a domain small enough to check
 * exhaustively, so a divergence is a test failure rather than a panel that
 * describes something the plugin does not do.
 */
describe('the panel agrees with the plugin about loudness', () => {
  it('maps every level and pair of thresholds to the same state', () => {
    // Both thresholds, over their whole range including ALARM_NEVER and the
    // pairs the clamp would never produce: the panel holds a copy of the rule,
    // and a copy that only matches on the reachable half is not a copy.
    for (const alarmLevel of THRESHOLDS) {
      for (const popupLevel of THRESHOLDS) {
        for (const value of LEVELS) {
          expect(
            stateForScaleValue(value, alarmLevel, popupLevel),
            `value ${value}, alarm ${alarmLevel}, popup ${popupLevel}`
          ).toBe(pluginStateForScaleValue(value, alarmLevel, popupLevel))
        }
      }
    }
  })

  it('derives the same popup level when only the alarm is given', () => {
    for (const alarmLevel of THRESHOLDS) {
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

  it('offers exactly the levels the schema offers, in the same order', () => {
    // Both thresholds draw on the same list, in both copies.
    for (const key of ['alarmLevel', 'popupLevel']) {
      expect(
        LEVEL_OPTIONS.map((option) => option.value),
        key
      ).toEqual(schema.properties[key].oneOf.map((option: any) => option.const))
    }
  })

  it('quotes each level at the rate the schema quotes it', () => {
    // ALARM_NEVER has no rate -- it does not happen at a frequency -- so it
    // is the one option with nothing to check here.
    for (const option of LEVEL_OPTIONS.filter((o: any) => o.rate)) {
      const fromSchema = schema.properties.alarmLevel.oneOf.find(
        (candidate: any) => candidate.const === option.value
      )
      expect(fromSchema.title).toContain(option.rate)
    }
  })
})

describe('levelOptionLabel', () => {
  it('names every NOAA level and never calls the last one a severity', () => {
    const labels = LEVEL_OPTIONS.map(levelOptionLabel)
    expect(labels.every((label) => !label.includes('undefined'))).toBe(true)
    const never = levelOptionLabel(
      LEVEL_OPTIONS.find((o) => o.value === ALARM_NEVER)
    )
    expect(never).toMatch(/^Never/)
    expect(never).not.toMatch(/\(6\)/)
  })

  it('reads the same in the panel as in both fallback dropdowns', () => {
    // The copies are the same dropdowns to a user, who may well see the
    // generated form -- the panel is not guaranteed to load.
    for (const key of ['alarmLevel', 'popupLevel']) {
      for (const option of LEVEL_OPTIONS) {
        const fromSchema = schema.properties[key].oneOf.find(
          (candidate: any) => candidate.const === option.value
        )
        expect(levelOptionLabel(option), key).toBe(fromSchema.title)
      }
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
      { alarmLevel: 'nonsense', auroraInterval: null },
      // Every threshold pair the two selects can produce, including the ones
      // where the popup is quieter than the alarm and the ones where it is
      // louder. The panel and the plugin have to resolve each the same way, or
      // the screen describes a ladder the plugin is not running.
      ...THRESHOLDS.flatMap((alarmLevel) =>
        THRESHOLDS.map((popupLevel) => ({ alarmLevel, popupLevel }))
      )
    ]
    for (const configuration of configurations) {
      const shown = panelSettings(configuration)
      expect(settingsFrom(shown)).toEqual(shown)
    }
  })

  it('shows the same drapInterval the plugin would actually run', () => {
    // The panel and settingsFrom resolve the fallback independently; both have
    // to land on the same number for the screen to describe what is running.
    for (const configuration of [
      { updateInterval: 30 },
      { drapInterval: 10, updateInterval: 30 },
      { drapInterval: 'soon', updateInterval: 30 },
      // A config with no updateInterval at all, only the two keys it
      // replaced -- the case where the panel's own fallback used to stop
      // short of `settingsFrom`'s migration.
      { observationsInterval: 15, notificationsInterval: 20 }
    ]) {
      expect(panelSettings(configuration).drapInterval).toBe(
        settingsFrom(configuration).drapInterval
      )
      expect(panelSettings(configuration).updateInterval).toBe(
        settingsFrom(configuration).updateInterval
      )
    }
  })

  // What the panel saves replaces the saved configuration rather than patching
  // it, so this is exactly what ends up in the file on disk.
  describe('as the whole saved configuration', () => {
    // Every removed and superseded key this plugin has ever had, alongside the
    // current ones an install of that vintage would also be carrying.
    const stale = {
      sendAdvisoryOutlook: true,
      alarmLevel: 5,
      auroraEnabled: false,
      auroraInterval: 480,
      updateInterval: 60,
      minScaleAlert: 3,
      zoneAlertThreshold: 3,
      observationsInterval: 60,
      notificationsInterval: 60,
      notificationVisual: true,
      notificationSound: true,
      alertMaxAgeHours: 24,
      sendAlertsWatchesWarnings: true
    }

    it('carries nothing the schema does not declare', () => {
      // A key the plugin no longer reads that survived a save would sit in the
      // file for the life of the install, where the next person to open it
      // cannot tell it from a setting in force.
      expect(Object.keys(panelSettings(stale)).sort()).toEqual(
        Object.keys(schema.properties).sort()
      )
    })

    it('leaves the plugin running exactly what it was running', () => {
      // What makes dropping the rest safe: a superseded key only ever spoke for
      // one of the keys the panel writes explicitly, so `settingsFrom` reads
      // the same settings whether or not the old one is still there.
      for (const configuration of [
        stale,
        // The superseded keys alone, with nothing current to defer to -- where
        // the migration in `settingsFrom` is the only thing keeping the
        // install's own cadence and threshold.
        { minScaleAlert: 1, observationsInterval: 15 },
        { zoneAlertThreshold: 2, notificationsInterval: 20 }
      ]) {
        const saved = panelSettings(configuration)
        expect(settingsFrom({ ...configuration, ...saved })).toEqual(
          settingsFrom(saved)
        )
      }
    })
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

describe('moving a boundary line', () => {
  const pairs = THRESHOLDS.flatMap((alarmLevel) =>
    THRESHOLDS.map((popupLevel) => ({ alarmLevel, popupLevel }))
  )

  it('never produces a pair the plugin would rewrite', () => {
    // The strong property, and the reason this is worth its own function: a
    // grip that could put the panel in a state `settingsFrom` pulls back would
    // show the user a ladder the plugin is not running.
    for (const pair of pairs)
      for (const key of ['alarmLevel', 'popupLevel'])
        for (const value of THRESHOLDS) {
          const moved = withLevel(pair, key, value)
          expect(settingsFrom(moved)).toMatchObject(moved)
        }
  })

  it('puts the moved threshold exactly where it was asked to go', () => {
    // The other one may follow; the one under the pointer never argues back.
    for (const pair of pairs)
      for (const key of ['alarmLevel', 'popupLevel'])
        for (const value of THRESHOLDS)
          expect(withLevel(pair, key, value)[key]).toBe(value)
  })

  it('lets a Never popup keep the alarm where it is', () => {
    // Both directions: choosing it, and moving the alarm afterwards. Dragging
    // the alarm up to meet it would silence a plugin the user had only asked
    // to stop popping up.
    expect(
      withLevel({ alarmLevel: 5, popupLevel: 4 }, 'popupLevel', ALARM_NEVER)
    ).toEqual({ alarmLevel: 5, popupLevel: ALARM_NEVER })
    expect(
      withLevel({ alarmLevel: 5, popupLevel: ALARM_NEVER }, 'alarmLevel', 3)
    ).toEqual({ alarmLevel: 3, popupLevel: ALARM_NEVER })
  })

  it('takes the other line along rather than refusing the move', () => {
    expect(
      withLevel({ alarmLevel: 5, popupLevel: 4 }, 'alarmLevel', 2)
    ).toEqual({ alarmLevel: 2, popupLevel: 2 })
    expect(
      withLevel({ alarmLevel: 3, popupLevel: 2 }, 'popupLevel', 5)
    ).toEqual({ alarmLevel: 5, popupLevel: 5 })
  })

  it('leaves the rest of the settings alone', () => {
    const settings = { alarmLevel: 5, popupLevel: 4, updateInterval: 30 }
    expect(withLevel(settings, 'alarmLevel', 3).updateInterval).toBe(30)
  })
})

describe('driving a boundary from the keyboard', () => {
  it('is quieter upward and louder downward', () => {
    // Up raises the line, so the band above it loses its bottom row and one
    // more level stops interrupting.
    expect(stepLevel(3, 'ArrowUp')).toBe(4)
    expect(stepLevel(3, 'ArrowDown')).toBe(2)
    expect(stepLevel(3, 'ArrowRight')).toBe(4)
    expect(stepLevel(3, 'ArrowLeft')).toBe(2)
  })

  it('stops at the ends of the range the grip reports', () => {
    expect(stepLevel(ALARM_NEVER, 'ArrowUp')).toBe(ALARM_NEVER)
    expect(stepLevel(1, 'ArrowDown')).toBe(1)
    expect(stepLevel(3, 'Home')).toBe(1)
    expect(stepLevel(3, 'End')).toBe(ALARM_NEVER)
  })

  it('reaches every level, including the two below the alert floor', () => {
    // Unlikely settings, not forbidden ones: restricting the control to 3-5
    // would strand a saved config that asked for something quieter.
    const walked = [ALARM_NEVER]
    while (walked[0] > 1) walked.unshift(stepLevel(walked[0], 'ArrowDown'))
    expect(walked).toEqual([1, 2, 3, 4, 5, ALARM_NEVER])
  })

  it('claims no other key, so the grip is not a keyboard trap', () => {
    for (const key of ['Tab', 'Enter', ' ', 'a', 'Escape', 'PageUp'])
      expect(stepLevel(3, key)).toBeNull()
  })
})

describe('dragging a boundary line', () => {
  // Rows are laid out top to bottom, loudest first, so a level's edge is the
  // bottom of its row and ALARM_NEVER's is the top of the first one.
  const edges = { [ALARM_NEVER]: 0, 5: 20, 4: 40, 3: 60, 2: 80, 1: 100 }

  it('snaps to the nearest edge rather than the row under the pointer', () => {
    // Nearest is what lets a grip reach the line above the top row at all --
    // there is no row above it to be inside of.
    expect(nearestLevel(edges, 0)).toBe(ALARM_NEVER)
    expect(nearestLevel(edges, -30)).toBe(ALARM_NEVER)
    expect(nearestLevel(edges, 21)).toBe(5)
    expect(nearestLevel(edges, 29)).toBe(5)
    expect(nearestLevel(edges, 31)).toBe(4)
    expect(nearestLevel(edges, 400)).toBe(1)
  })

  it('reaches every level the keyboard does', () => {
    for (const [level, at] of Object.entries(edges))
      expect(nearestLevel(edges, at)).toBe(Number(level))
  })
})

describe('where a boundary line is drawn', () => {
  it('rests under the row its band opens at', () => {
    for (const level of [1, 2, 3, 4, 5]) expect(lineUnder(level)).toBe(level)
  })

  it('has no row of its own at Never', () => {
    // Which is what puts it above the ladder, where the band is empty.
    expect(lineUnder(ALARM_NEVER)).toBeNull()
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
      dailyKb(settings).other + dailyKb(settings).drap + dailyKb(settings).fixed
    )
  })

  it('charges one wire payload per interval per day', () => {
    const day = dailyKb({ ...settings, auroraEnabled: true })
    expect(day.other).toBeCloseTo((1440 / 60) * OTHER_WIRE_KB)
    expect(day.aurora).toBeCloseTo((1440 / 120) * AURORA_WIRE_KB)
    expect(day.drap).toBeCloseTo((1440 / 60) * DRAP_WIRE_KB)
    expect(day.total).toBeCloseTo(day.aurora + day.other + day.drap + day.fixed)
  })

  it('drops D-RAP from the bill when it is switched off', () => {
    // The reason it gets a switch at all: it is a large enough share of the
    // poll that turning it off has to show up in the figure.
    const on = dailyKb(settings)
    const off = dailyKb({ ...settings, drapEnabled: false })
    expect(off.drap).toBe(0)
    expect(on.total - off.total).toBeCloseTo(on.drap)
    expect(off.other).toBe(on.other)
  })

  it('scales D-RAP with its own interval, not the "everything else" one', () => {
    const base = dailyKb(settings)
    const fasterOther = dailyKb({ ...settings, updateInterval: 30 })
    expect(fasterOther.drap).toBeCloseTo(base.drap)
    const fasterDrap = dailyKb({ ...settings, drapInterval: 30 })
    expect(fasterDrap.drap).toBeCloseTo(base.drap * 2)
  })

  it('does not move the bulletins when an interval is halved', () => {
    // The whole point of the row: it is what the plugin costs however far the
    // two intervals are opened up, so it must not scale with either.
    const base = dailyKb(settings)
    const faster = dailyKb({ ...settings, updateInterval: 30 })
    expect(faster.fixed).toBe(base.fixed)
    expect(faster.other).toBeCloseTo(base.other * 2)
  })

  it('prices every fixed-cadence fetch, none of which a setting reaches', () => {
    // They are small, but they are four more fetches on the fixed row and the
    // panel's claim is that the figure is arithmetic rather than a sentence.
    const off = dailyKb({ ...settings, sendAdvisoryOutlook: false })
    expect(off.fixed).toBeCloseTo(
      OUTLOOK27_WIRE_KB +
        6 * F107_WIRE_KB +
        8 * A_INDEX_WIRE_KB +
        6 * SUNSPOT_WIRE_KB
    )
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

  it('leaves no alarm level unable to sound, except the one that says so', () => {
    for (const alarmLevel of ALARM_LEVELS) {
      expect(
        ladderFor(alarmLevel).some((row) => row.method.includes('sound'))
      ).toBe(true)
    }
    expect(
      ladderFor(ALARM_NEVER).some((row) => row.method.includes('sound'))
    ).toBe(false)
  })

  it('still shows the top two levels at ALARM_NEVER', () => {
    // "Never" removes the sound, not the storm: a G5 has to stay visible.
    const rows = ladderFor(ALARM_NEVER)
    const at = (level: number) => rows.find((row) => row.level === level)
    expect(at(5).state).toBe('warn')
    expect(at(5).method).toEqual(['visual'])
    expect(at(4).state).toBe('alert')
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

  it('carries a rate for every level', () => {
    for (const row of ladderFor(5)) expect(row.rate).toBe(RATE[row.level])
  })

  it('quotes the same rate the fallback dropdown quotes', () => {
    // The ladder and the dropdown are the same choice to a user, who may well
    // see either -- the panel is not guaranteed to load. Two lists of words
    // would drift; one list read twice cannot.
    for (const option of LEVEL_OPTIONS)
      expect(option.rate).toBe(
        option.value === ALARM_NEVER ? undefined : RATE[option.value]
      )
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
