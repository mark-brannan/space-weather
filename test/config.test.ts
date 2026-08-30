import { describe, expect, it } from 'vitest'
import { schema, settingsFrom } from '../src/config'
import { ALARM_NEVER } from '../src/parse'

describe('alarmLevel', () => {
  const property: any = (schema.properties as any).alarmLevel

  it('defaults to 5, so only an Extreme event sounds', () => {
    expect(settingsFrom({}).alarmLevel).toBe(5)
    expect(property.default).toBe(5)
  })

  it('uses alarmLevel when present', () => {
    expect(settingsFrom({ alarmLevel: 3 }).alarmLevel).toBe(3)
  })

  it('offers never, then one option per NOAA scale value, quietest first', () => {
    // ALARM_NEVER sits first because the list reads as a volume control: down
    // the list is louder, and off is quieter than the quietest level.
    expect(property.oneOf.map((o: any) => o.const)).toEqual([
      ALARM_NEVER,
      5,
      4,
      3,
      2,
      1
    ])
  })

  it('matches by number, not string', () => {
    // RJSF `const` matching is exact and typed: "3" would never select.
    for (const option of property.oneOf)
      expect(typeof option.const).toBe('number')
  })

  it('keeps type and default, which RJSF needs for different reasons', () => {
    // Without `type` the field renders as nothing at all. Without `default`,
    // RJSF picks option one on a fresh install -- it uses `default` to select
    // the initial option rather than as a value.
    expect(property.type).toBe('number')
  })

  it('resolves an out-of-range saved value to the default', () => {
    // The admin form renders 0 or 7 as a blank select with no error and saves
    // it back unchanged, so this is the only thing standing between a
    // hand-edited config and a level nothing can reach.
    for (const bad of [0, 7, 3.5, -1, 'loud', null])
      expect(settingsFrom({ alarmLevel: bad }).alarmLevel).toBe(5)
  })
})

describe('popupLevel', () => {
  const property: any = (schema.properties as any).popupLevel

  it('defaults to 4, one below the alarm', () => {
    expect(settingsFrom({}).popupLevel).toBe(4)
    expect(property.default).toBe(4)
  })

  it('offers the same choices as the alarm level', () => {
    // Both are thresholds on the same scale. Neither range is clipped: a popup
    // at Minor is not a setting anyone should want, but it is a defensible
    // thing to want, and clipping would also strand a config that asked for it.
    expect(property.oneOf).toEqual((schema.properties as any).alarmLevel.oneOf)
  })

  it('uses popupLevel when present', () => {
    expect(settingsFrom({ alarmLevel: 5, popupLevel: 2 }).popupLevel).toBe(2)
  })

  it('is never louder than the alarm', () => {
    // Above the alarm it would name a band the alarm has already taken, so the
    // setting would be inert while still reading as a choice.
    expect(settingsFrom({ alarmLevel: 3, popupLevel: 5 }).popupLevel).toBe(3)
    expect(settingsFrom({ alarmLevel: 1, popupLevel: 4 }).popupLevel).toBe(1)
  })

  it('follows a saved alarm level down when absent', () => {
    // What the ladder did when there was only one setting, so a config saved
    // before the split keeps the behaviour it already had.
    expect(settingsFrom({ alarmLevel: 3 }).popupLevel).toBe(2)
    expect(settingsFrom({ alarmLevel: 1 }).popupLevel).toBe(1)
  })

  it('gives a saved ALARM_NEVER the popup band it used to shift into', () => {
    // 0.18 expressed "never sound" by sliding the whole ladder down one, so
    // Extreme popped up. That is now said outright rather than derived.
    const settings = settingsFrom({ alarmLevel: ALARM_NEVER })
    expect(settings.alarmLevel).toBe(ALARM_NEVER)
    expect(settings.popupLevel).toBe(5)
  })

  it('keeps an explicit Never whatever the alarm level is', () => {
    // The one value above the alarm that is not a mistake: the others name a
    // band the alarm has already taken and are inert by accident, this one asks
    // for no popup band at all. Clamping it would redraw a chosen "Never" as a
    // level on the next load, which is the bug the two thresholds exist to fix.
    for (const alarmLevel of [1, 2, 3, 4, 5, ALARM_NEVER])
      expect(
        settingsFrom({ alarmLevel, popupLevel: ALARM_NEVER }).popupLevel
      ).toBe(ALARM_NEVER)
  })

  it('reads its own output back unchanged, for every pair', () => {
    // What the panel saves is what `settingsFrom` produced, so anything it
    // rewrites on a second pass is a value the user sees change under them.
    for (const alarmLevel of [1, 2, 3, 4, 5, ALARM_NEVER])
      for (const popupLevel of [1, 2, 3, 4, 5, ALARM_NEVER]) {
        const settings = settingsFrom({ alarmLevel, popupLevel })
        expect(settingsFrom(settings)).toEqual(settings)
      }
  })

  it('resolves an out-of-range saved value against the alarm level', () => {
    for (const bad of [0, 7, 3.5, -1, 'loud', null])
      expect(settingsFrom({ alarmLevel: 5, popupLevel: bad }).popupLevel).toBe(
        4
      )
  })
})

describe('listLevel', () => {
  const property: any = (schema.properties as any).listLevel

  it('defaults to 3, one below the popup level', () => {
    expect(settingsFrom({}).listLevel).toBe(3)
    expect(property.default).toBe(3)
  })

  it('offers the same choices as the other two thresholds', () => {
    expect(property.oneOf).toEqual((schema.properties as any).alarmLevel.oneOf)
  })

  it('uses listLevel when present', () => {
    expect(
      settingsFrom({ alarmLevel: 5, popupLevel: 4, listLevel: 2 }).listLevel
    ).toBe(2)
  })

  it('is never louder than the popup level', () => {
    // Above it, it would name a band the popup already claimed, so it would
    // be inert while still reading as a choice -- the same reason the popup
    // level cannot outrank the alarm.
    expect(
      settingsFrom({ alarmLevel: 5, popupLevel: 3, listLevel: 5 }).listLevel
    ).toBe(3)
    expect(
      settingsFrom({ alarmLevel: 5, popupLevel: 1, listLevel: 4 }).listLevel
    ).toBe(1)
  })

  it('follows a saved popup level down when absent', () => {
    // There is no old key to migrate here -- this is the setting's own
    // default ladder, mirroring what popupLevel does against the alarm.
    expect(settingsFrom({ alarmLevel: 5, popupLevel: 3 }).listLevel).toBe(2)
    expect(settingsFrom({ alarmLevel: 5, popupLevel: 1 }).listLevel).toBe(1)
  })

  it('keeps an explicit Never whatever the popup level is', () => {
    // The one value above the popup level that is not a mistake: it asks for
    // no list band at all, rather than naming a band already taken.
    for (const popupLevel of [1, 2, 3, 4, 5, ALARM_NEVER])
      expect(
        settingsFrom({ alarmLevel: 5, popupLevel, listLevel: ALARM_NEVER })
          .listLevel
      ).toBe(ALARM_NEVER)
  })

  it('reads its own output back unchanged, for every triple', () => {
    for (const alarmLevel of [1, 2, 3, 4, 5, ALARM_NEVER])
      for (const popupLevel of [1, 2, 3, 4, 5, ALARM_NEVER])
        for (const listLevel of [1, 2, 3, 4, 5, ALARM_NEVER]) {
          const settings = settingsFrom({ alarmLevel, popupLevel, listLevel })
          expect(settingsFrom(settings)).toEqual(settings)
        }
  })

  it('resolves an out-of-range saved value against the popup level', () => {
    for (const bad of [0, 7, 3.5, -1, 'loud', null])
      expect(
        settingsFrom({ alarmLevel: 5, popupLevel: 4, listLevel: bad }).listLevel
      ).toBe(3)
  })
})

describe('the schema survives the round trip the server puts it through', () => {
  // The server stores the schema as JSON, and the Signal K plugin CI walks it
  // rejecting anything JSON.stringify would drop or choke on. Its reachability
  // check is by object identity, so two properties sharing one `oneOf` array
  // read as a cycle even though nothing is circular and stringify copes -- and
  // that failed every platform in the matrix once both thresholds offered the
  // same choices. Cheaper to give each property its own copy than to argue.
  const objects = (node: any, path: string, seen = new WeakSet()): string[] => {
    if (node === null || typeof node !== 'object') return []
    if (seen.has(node)) return [path]
    seen.add(node)
    return Object.entries(node).flatMap(([key, value]) =>
      objects(value, `${path}.${key}`, seen)
    )
  }

  it('reaches no object twice', () => {
    expect(objects(schema, 'schema')).toEqual([])
  })

  it('holds nothing JSON.stringify would drop', () => {
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema)
  })
})

describe('migrating a saved zoneAlertThreshold / minScaleAlert', () => {
  // The old setting named the lowest level worth attention and put `alarm` two
  // levels above it, so the equivalent alarm level is the old value plus two.
  it('moves the old default onto the new one, unchanged in behaviour', () => {
    expect(settingsFrom({ zoneAlertThreshold: 3 }).alarmLevel).toBe(5)
  })

  it('carries a quieter old customisation across', () => {
    expect(settingsFrom({ zoneAlertThreshold: 1 }).alarmLevel).toBe(3)
    expect(settingsFrom({ zoneAlertThreshold: 2 }).alarmLevel).toBe(4)
  })

  it('clamps the two old values that could never sound', () => {
    expect(settingsFrom({ zoneAlertThreshold: 4 }).alarmLevel).toBe(5)
    expect(settingsFrom({ zoneAlertThreshold: 5 }).alarmLevel).toBe(5)
  })

  it('still reads the pre-0.8.0 minScaleAlert', () => {
    expect(settingsFrom({ minScaleAlert: 1 }).alarmLevel).toBe(3)
  })

  it('prefers an explicit alarmLevel over either old key', () => {
    expect(
      settingsFrom({ alarmLevel: 2, zoneAlertThreshold: 3, minScaleAlert: 1 })
        .alarmLevel
    ).toBe(2)
  })

  it('no longer exposes either old key', () => {
    expect(schema.properties).not.toHaveProperty('zoneAlertThreshold')
    expect(schema.properties).not.toHaveProperty('minScaleAlert')
  })
})

describe('sendAlertsWatchesWarnings is no longer a setting', () => {
  it('is gone from the schema and from the resolved settings', () => {
    expect(schema.properties).not.toHaveProperty('sendAlertsWatchesWarnings')
    expect(
      (settingsFrom({ sendAlertsWatchesWarnings: false }) as any)
        .sendAlertsWatchesWarnings
    ).toBeUndefined()
  })
})

describe('removed settings', () => {
  // These were a ceiling on methodForState. Severity is the only input now, so
  // a leftover schema property would be a dial that visibly does nothing.
  it('does not expose notificationVisual / notificationSound', () => {
    expect(schema.properties).not.toHaveProperty('notificationVisual')
    expect(schema.properties).not.toHaveProperty('notificationSound')
  })

  it('does not expose alertMaxAgeHours', () => {
    expect(schema.properties).not.toHaveProperty('alertMaxAgeHours')
  })

  it('ignores all three if a saved config still carries them', () => {
    const settings: any = settingsFrom({
      notificationVisual: false,
      notificationSound: false,
      alertMaxAgeHours: 168
    })
    expect(settings.notificationVisual).toBeUndefined()
    expect(settings.notificationSound).toBeUndefined()
    expect(settings.alertMaxAgeHours).toBeUndefined()
  })
})

describe('updateInterval', () => {
  it('defaults to 60 minutes', () => {
    expect(settingsFrom({}).updateInterval).toBe(60)
  })

  it('uses updateInterval when present', () => {
    expect(settingsFrom({ updateInterval: 30 }).updateInterval).toBe(30)
  })

  it('no longer exposes either of the settings it replaced', () => {
    expect(schema.properties).not.toHaveProperty('observationsInterval')
    expect(schema.properties).not.toHaveProperty('notificationsInterval')
  })

  it('falls back to a saved observationsInterval', () => {
    expect(settingsFrom({ observationsInterval: 15 }).updateInterval).toBe(15)
  })

  it('falls back to a saved notificationsInterval', () => {
    expect(settingsFrom({ notificationsInterval: 20 }).updateInterval).toBe(20)
  })

  it('takes the lower of the two when an old config set both', () => {
    // The install was already fetching that often, so keep its cadence rather
    // than quietly slowing one half of the plugin down.
    expect(
      settingsFrom({ observationsInterval: 45, notificationsInterval: 90 })
        .updateInterval
    ).toBe(45)
    expect(
      settingsFrom({ observationsInterval: 90, notificationsInterval: 45 })
        .updateInterval
    ).toBe(45)
  })

  it('prefers updateInterval over both old keys', () => {
    expect(
      settingsFrom({
        updateInterval: 10,
        observationsInterval: 45,
        notificationsInterval: 90
      }).updateInterval
    ).toBe(10)
  })

  it('rejects junk and zero in the old keys as well as the new one', () => {
    expect(settingsFrom({ updateInterval: 'soon' }).updateInterval).toBe(60)
    expect(settingsFrom({ observationsInterval: 0 }).updateInterval).toBe(60)
    expect(settingsFrom({ notificationsInterval: -5 }).updateInterval).toBe(60)
    expect(
      settingsFrom({ observationsInterval: 0, notificationsInterval: 30 })
        .updateInterval
    ).toBe(30)
  })
})

describe('auroraInterval default', () => {
  it('defaults to 120 minutes, longer than the other poll intervals', () => {
    const settings = settingsFrom({})
    expect(settings.auroraInterval).toBe(120)
    expect(settings.auroraInterval).toBeGreaterThan(settings.updateInterval)
  })
})

describe('drapInterval', () => {
  it('defaults to 60 minutes', () => {
    expect(settingsFrom({}).drapInterval).toBe(60)
  })

  it('uses drapInterval when present', () => {
    expect(settingsFrom({ drapInterval: 15 }).drapInterval).toBe(15)
  })

  it('falls back to updateInterval for a config saved before the split', () => {
    expect(settingsFrom({ updateInterval: 30 }).drapInterval).toBe(30)
  })

  it('falls back to the resolved legacy observations/notifications cadence', () => {
    // Not the raw, absent `updateInterval` prop -- the value `settingsFrom`
    // actually derives from it, which is what a pre-split install was really
    // fetching D-RAP at.
    expect(
      settingsFrom({ observationsInterval: 15, notificationsInterval: 20 })
        .drapInterval
    ).toBe(15)
  })

  it('an explicit invalid drapInterval falls back to 60, not to updateInterval', () => {
    // It names its own setting, wrong value and all -- borrowing a different
    // field's value would be a second guess nobody asked for.
    expect(
      settingsFrom({ drapInterval: 'soon', updateInterval: 30 }).drapInterval
    ).toBe(60)
  })

  it('prefers drapInterval over updateInterval', () => {
    expect(
      settingsFrom({ drapInterval: 10, updateInterval: 30 }).drapInterval
    ).toBe(10)
  })

  it('rejects junk and falls back to 60', () => {
    expect(settingsFrom({ drapInterval: 'soon' }).drapInterval).toBe(60)
    expect(settingsFrom({ drapInterval: 0 }).drapInterval).toBe(60)
  })
})

describe('goesFluxEnabled', () => {
  it('is off unless the config asks for it', () => {
    // Opt-in, like aurora and unlike D-RAP: 775 KB a day is not something to
    // charge a boat that has never opened the configuration screen. The cost
    // is that an install upgrading across this release stops publishing
    // xray_flux, its trend and proton_flux until the box is ticked.
    expect(settingsFrom({}).goesFluxEnabled).toBe(false)
    expect(settingsFrom({ goesFluxEnabled: true }).goesFluxEnabled).toBe(true)
    expect(settingsFrom({ goesFluxEnabled: false }).goesFluxEnabled).toBe(false)
  })

  it('treats anything but a real `true` as off', () => {
    // Same rule as auroraEnabled: the expensive default is never reached by
    // accident, only by a value that actually says yes.
    expect(settingsFrom({ goesFluxEnabled: 'yes' }).goesFluxEnabled).toBe(false)
    expect(settingsFrom({ goesFluxEnabled: 1 }).goesFluxEnabled).toBe(false)
  })
})

describe('goesFluxInterval', () => {
  it('defaults to 60 minutes', () => {
    // The paths declare a one-hour `timeout`, so anything slower publishes a
    // reading Signal K itself marks stale.
    expect(settingsFrom({}).goesFluxInterval).toBe(60)
  })

  it('uses goesFluxInterval when present', () => {
    expect(settingsFrom({ goesFluxInterval: 180 }).goesFluxInterval).toBe(180)
  })

  it('falls back to updateInterval for a config saved before the split', () => {
    expect(settingsFrom({ updateInterval: 30 }).goesFluxInterval).toBe(30)
  })

  it('falls back to the resolved legacy observations/notifications cadence', () => {
    expect(
      settingsFrom({ observationsInterval: 15, notificationsInterval: 20 })
        .goesFluxInterval
    ).toBe(15)
  })

  it('an explicit invalid goesFluxInterval falls back to 60', () => {
    expect(
      settingsFrom({ goesFluxInterval: 'soon', updateInterval: 30 })
        .goesFluxInterval
    ).toBe(60)
  })

  it('rejects junk and falls back to 60', () => {
    expect(settingsFrom({ goesFluxInterval: 'soon' }).goesFluxInterval).toBe(60)
    expect(settingsFrom({ goesFluxInterval: 0 }).goesFluxInterval).toBe(60)
  })
})
