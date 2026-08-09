import { describe, expect, it } from 'vitest'
import { schema, settingsFrom } from '../src/config'

describe('alarmLevel', () => {
  const property: any = (schema.properties as any).alarmLevel

  it('defaults to 5, so only an Extreme event sounds', () => {
    expect(settingsFrom({}).alarmLevel).toBe(5)
    expect(property.default).toBe(5)
  })

  it('uses alarmLevel when present', () => {
    expect(settingsFrom({ alarmLevel: 3 }).alarmLevel).toBe(3)
  })

  it('offers one option per NOAA scale value, quietest first', () => {
    expect(property.oneOf.map((o: any) => o.const)).toEqual([5, 4, 3, 2, 1])
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
