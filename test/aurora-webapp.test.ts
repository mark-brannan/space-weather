import { describe, expect, it } from 'vitest'
import {
  auroraCardState,
  refreshFailure,
  retryAfterSeconds
} from '../public/aurora.js'

describe('auroraCardState', () => {
  it('shows the value whenever there is one', () => {
    expect(auroraCardState({ probability: 0.42, scheduled: true })).toBe(
      'value'
    )
    // Off the schedule the reading came from somebody pressing the button, and
    // it is still a reading.
    expect(auroraCardState({ probability: 0.42, scheduled: false })).toBe(
      'value'
    )
  })

  it('counts a zero probability as a reading', () => {
    // The quiet answer to "can I see it from here" is a real answer, and most
    // nights it is the one NOAA gives.
    expect(auroraCardState({ probability: 0, scheduled: false })).toBe('value')
  })

  it('separates waiting for the schedule from having no schedule', () => {
    // The difference is whether waiting will ever produce anything.
    expect(auroraCardState({ probability: null, scheduled: true })).toBe(
      'waiting'
    )
    expect(auroraCardState({ probability: null, scheduled: false })).toBe(
      'idle'
    )
    expect(auroraCardState({ probability: undefined, scheduled: false })).toBe(
      'idle'
    )
  })

  it('does not read a plugin that never answered as one with updates off', () => {
    // The settings are missing either way, and only one of the two is
    // something the reader can fix by pressing the button.
    expect(
      auroraCardState({ probability: null, scheduled: false, running: false })
    ).toBe('stopped')
    expect(
      auroraCardState({ probability: 0.42, scheduled: false, running: false })
    ).toBe('value')
  })
})

describe('refreshFailure', () => {
  it('keeps the refusals the user can act on apart', () => {
    expect(refreshFailure({ auth: true }).kind).toBe('auth')
    expect(refreshFailure({ status: 429 }).kind).toBe('cooldown')
    expect(refreshFailure({ status: 503 }).kind).toBe('stopped')
    expect(refreshFailure({ status: 502 }).kind).toBe('upstream')
  })

  it('carries the wait when the server said how long', () => {
    expect(refreshFailure({ status: 429, retryAfterSeconds: 42 })).toEqual({
      kind: 'cooldown',
      retryAfterSeconds: 42
    })
    // Still a cooldown without one; the caller has a wording for that case.
    expect(
      refreshFailure({ status: 429, retryAfterSeconds: null })
    ).not.toHaveProperty('retryAfterSeconds')
  })

  it('falls back for anything it does not recognise', () => {
    expect(refreshFailure({ status: 418 }).kind).toBe('failed')
    expect(refreshFailure(undefined).kind).toBe('failed')
    expect(refreshFailure(new Error('offline')).kind).toBe('failed')
  })

  it('reads authentication before the status code', () => {
    // A 403 arrives as an AuthRequiredError, and "log in" is what to do about
    // it whatever else the response carried.
    expect(refreshFailure({ auth: true, status: 502 }).kind).toBe('auth')
  })
})

describe('retryAfterSeconds', () => {
  it('reads the seconds the route sends', () => {
    expect(retryAfterSeconds('42')).toBe(42)
  })

  it('rounds a fractional wait up, so the countdown never expires early', () => {
    expect(retryAfterSeconds('1.2')).toBe(2)
  })

  it('has nothing to count down from without a usable header', () => {
    // A proxy may drop the header, and HTTP also allows a date form, which is
    // not worth parsing for a countdown that has a fallback wording.
    expect(retryAfterSeconds(null)).toBe(null)
    expect(retryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT')).toBe(null)
    expect(retryAfterSeconds('0')).toBe(null)
    expect(retryAfterSeconds('-5')).toBe(null)
  })
})
