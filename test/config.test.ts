import { describe, expect, it } from 'vitest'
import { schema, settingsFrom } from '../src/config'

describe('zoneAlertThreshold / minScaleAlert merge (0.8.0)', () => {
  it('no longer exposes minScaleAlert as a separate setting', () => {
    expect(schema.properties).not.toHaveProperty('minScaleAlert')
  })

  it('uses zoneAlertThreshold when present', () => {
    expect(settingsFrom({ zoneAlertThreshold: 4 }).zoneAlertThreshold).toBe(4)
  })

  it('falls back to a saved minScaleAlert so an old customisation is not silently dropped', () => {
    expect(settingsFrom({ minScaleAlert: 4 }).zoneAlertThreshold).toBe(4)
  })

  it('prefers zoneAlertThreshold when both are present', () => {
    expect(
      settingsFrom({ zoneAlertThreshold: 4, minScaleAlert: 2 })
        .zoneAlertThreshold
    ).toBe(4)
  })

  it('defaults to 3 (strong) when neither is set', () => {
    expect(settingsFrom({}).zoneAlertThreshold).toBe(3)
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
