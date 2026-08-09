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

describe('notificationVisual / notificationSound', () => {
  // Until 0.12.1 the sound branch tested `notificationVisual`, so each
  // setting's default was gated on the other one's presence.
  it('defaults both on when neither is saved', () => {
    const settings = settingsFrom({})
    expect(settings.notificationVisual).toBe(true)
    expect(settings.notificationSound).toBe(true)
  })

  it('honours sound:false when visual is absent', () => {
    // The case that mattered: turning the sound off did nothing at all unless
    // the visual checkbox happened to be saved too.
    expect(settingsFrom({ notificationSound: false }).notificationSound).toBe(
      false
    )
  })

  it('keeps sound on when only visual is turned off', () => {
    const settings = settingsFrom({ notificationVisual: false })
    expect(settings.notificationVisual).toBe(false)
    expect(settings.notificationSound).toBe(true)
  })

  it('resolves each field from its own value when both are saved', () => {
    const settings = settingsFrom({
      notificationVisual: true,
      notificationSound: false
    })
    expect(settings.notificationVisual).toBe(true)
    expect(settings.notificationSound).toBe(false)
  })
})

describe('auroraInterval default', () => {
  it('defaults to 120 minutes, longer than the other poll intervals', () => {
    const settings = settingsFrom({})
    expect(settings.auroraInterval).toBe(120)
    expect(settings.auroraInterval).toBeGreaterThan(
      settings.observationsInterval
    )
  })
})
