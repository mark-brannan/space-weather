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
      settingsFrom({ zoneAlertThreshold: 4, minScaleAlert: 2 }).zoneAlertThreshold
    ).toBe(4)
  })

  it('defaults to 3 (strong) when neither is set', () => {
    expect(settingsFrom({}).zoneAlertThreshold).toBe(3)
  })
})

describe('auroraInterval default', () => {
  it('defaults to 120 minutes, longer than the other poll intervals', () => {
    const settings = settingsFrom({})
    expect(settings.auroraInterval).toBe(120)
    expect(settings.auroraInterval).toBeGreaterThan(settings.observationsInterval)
  })
})
