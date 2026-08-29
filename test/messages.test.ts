import { describe, expect, it } from 'vitest'
import {
  RECENT_MS,
  messagesInForce,
  messagesSummary,
  messagesTitle
} from '../public/messages.js'

const NOW = Date.parse('2026-08-29T12:00:00.000Z')
const HOUR = 60 * 60 * 1000

/** One leaf of the alerts subtree, shaped as products/alerts.ts publishes it. */
function leaf(code: string, over: Record<string, unknown> = {}) {
  return {
    value: {
      id: `noaa_swpc_alert_${code}`,
      serialNumber: '1',
      issued: new Date(NOW - HOUR).toISOString(),
      validUntil: null,
      message: `ALERT: something at ${code}`,
      description: `Space Weather Message Code: ${code}\n\nbody`,
      alertLevel: 'ALERT',
      scale: 'G2 - Moderate',
      state: 'warn',
      method: [],
      predictedByDay: [],
      ...over
    }
  }
}

describe('messagesInForce', () => {
  it('reads a published alert leaf into a row the list can draw', () => {
    const [row] = messagesInForce({ ALTK06: leaf('ALTK06') }, NOW)
    expect(row).toMatchObject({
      code: 'ALTK06',
      verb: 'ALERT',
      scale: 'G2 - Moderate',
      level: 2,
      inForce: true
    })
    expect(row.text).toContain('body')
  })

  it('is empty when nothing has ever been published', () => {
    expect(messagesInForce(undefined, NOW)).toEqual([])
    expect(messagesInForce({}, NOW)).toEqual([])
  })

  it('keeps a stood-down message, marked as no longer in force', () => {
    // The plugin sets a withdrawn message back to `normal` rather than
    // deleting it, and the sequence -- watch, warning, summary -- is the only
    // history this page has.
    const [row] = messagesInForce(
      { WATA30: leaf('WATA30', { state: 'normal' }) },
      NOW
    )
    expect(row.inForce).toBe(false)
  })

  it('drops a stood-down message once it is old news', () => {
    const stale = leaf('WATA30', {
      state: 'normal',
      issued: new Date(NOW - RECENT_MS - HOUR).toISOString()
    })
    expect(messagesInForce({ WATA30: stale }, NOW)).toEqual([])
    // Still in force at the same age, it stays: NOAA saying so outranks the
    // window, which only ever bounds what is *not* in force.
    const old = leaf('WARK07', {
      issued: new Date(NOW - RECENT_MS - HOUR).toISOString()
    })
    expect(messagesInForce({ WARK07: old }, NOW)[0]?.code).toBe('WARK07')
  })

  it('drops a stood-down message it cannot date', () => {
    // Otherwise there is no age to compare, and the row sits on the list for
    // as long as the plugin runs.
    const undated = leaf('WATA30', { state: 'normal', issued: 'not a date' })
    expect(messagesInForce({ WATA30: undated }, NOW)).toEqual([])
    // In force, the window never applies -- an unreadable date changes nothing.
    const live = leaf('WARK07', { issued: 'not a date' })
    expect(messagesInForce({ WARK07: live }, NOW)[0]?.issued).toBeNull()
  })

  it('puts what is true now first, then NOAA’s strongest verb', () => {
    const rows = messagesInForce(
      {
        SUM10R: leaf('SUM10R', { alertLevel: 'SUMMARY' }),
        WATA30: leaf('WATA30', {
          alertLevel: 'WATCH',
          state: 'normal',
          issued: new Date(NOW - 1).toISOString()
        }),
        WARK07: leaf('WARK07', { alertLevel: 'WARNING' })
      },
      NOW
    )
    // The stood-down watch is the newest message and still goes last: what
    // happened last is not the question the list answers.
    expect(rows.map((row) => row.code)).toEqual(['WARK07', 'SUM10R', 'WATA30'])
  })

  it('ranks an observed alert above a warning of what is still coming', () => {
    const rows = messagesInForce(
      {
        WARK07: leaf('WARK07', { alertLevel: 'WARNING' }),
        ALTK08: leaf('ALTK08', {
          alertLevel: 'ALERT',
          issued: new Date(NOW - 3 * HOUR).toISOString()
        })
      },
      NOW
    )
    // Older, and still first: what NOAA has measured outranks what it expects.
    expect(rows.map((row) => row.code)).toEqual(['ALTK08', 'WARK07'])
  })

  it('marks a watch day as ahead until the end of that day', () => {
    const day = (offsetMs: number) => ({
      date: new Date(NOW + offsetMs).toISOString(),
      letter: 'G',
      level: 2
    })
    const rows = messagesInForce(
      {
        WATA30: leaf('WATA30', {
          alertLevel: 'WATCH',
          predictedByDay: [day(-30 * HOUR), day(-6 * HOUR), day(18 * HOUR)]
        })
      },
      NOW
    )
    // Same rule as watchAhead in hero.js: a storm predicted for today is
    // still a prediction at 0600 on that day.
    expect(rows[0].days.map((d: any) => d.ahead)).toEqual([false, true, true])
  })

  it('colours a watch by its worst day when it names no scale', () => {
    const rows = messagesInForce(
      {
        WATA30: leaf('WATA30', {
          scale: '',
          predictedByDay: [
            { date: new Date(NOW).toISOString(), letter: 'G', level: 1 },
            { date: new Date(NOW + HOUR).toISOString(), letter: 'G', level: 3 }
          ]
        })
      },
      NOW
    )
    expect(rows[0].level).toBe(3)
  })

  it('ignores a leaf carrying no message at all', () => {
    // A path can exist with a partial value -- a stand-down writes the whole
    // object back, but nothing guarantees what an older plugin version left.
    expect(messagesInForce({ ALTK06: { value: { id: 'x' } } }, NOW)).toEqual([])
  })
})

describe('messagesSummary', () => {
  it('counts only what is in force', () => {
    const rows = messagesInForce(
      {
        WARK07: leaf('WARK07'),
        WATA30: leaf('WATA30', { state: 'normal' })
      },
      NOW
    )
    expect(messagesSummary(rows)).toBe('1 NOAA message in force — read it')
    expect(messagesTitle(rows)).toBe('Messages in force')
  })

  it('offers the recent ones when nothing is in force', () => {
    const rows = messagesInForce(
      { WATA30: leaf('WATA30', { state: 'normal' }) },
      NOW
    )
    expect(messagesSummary(rows)).toBe('Recent NOAA messages — read them')
    expect(messagesTitle(rows)).toBe('Recent messages')
  })

  it('says nothing when there is nothing to say', () => {
    expect(messagesSummary([])).toBe(null)
  })
})
