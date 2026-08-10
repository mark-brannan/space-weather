import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsFrom } from '../src/config'
import { ALERTS_BASE, NOTIFICATIONS_BASE } from '../src/paths'
import {
  MAX_ALERT_NOTIFICATIONS,
  currentAlertNotifications
} from '../src/parse'
import { alerts } from '../src/products/alerts'
import { ALERT_FIXTURES, fixtureJson } from './fixtures'

const HOUR_MS = 60 * 60 * 1000

/** The moment the payload was captured: its most recent issue time. */
function captureTime(payload: any[]): Date {
  return new Date(
    Math.max(
      ...payload.map((a: any) => new Date(a.issue_datetime + 'Z').getTime())
    )
  )
}

/**
 * The payload as a poll at `now` would have seen it.
 *
 * A fixture is a 30-day archive, so picking a moment inside a storm otherwise
 * hands the selection messages issued days later — harmless against the real
 * clock, where NOAA cannot issue into the future, but it makes any test that
 * moves `now` backwards meaningless.
 */
function asOf(payload: any[], now: Date): any[] {
  return payload.filter(
    (a: any) => new Date(a.issue_datetime + 'Z').getTime() <= now.getTime()
  )
}

function select(name: string, overrides: Record<string, any> = {}) {
  const payload = fixtureJson(name)
  return currentAlertNotifications(payload, {
    now: captureTime(payload),
    maxAgeMs: 24 * HOUR_MS,
    alertThreshold: 3,
    ...overrides
  })
}

/**
 * A fake publisher backed by a mutable model, so a refresh can see what the
 * previous one published. `selfPath` mimics the server's own shape: a leaf
 * request returns the value, a branch request returns its children.
 */
/**
 * The product asks the real clock what "in force" means, so a fixture from
 * 2025 selects nothing at all unless the clock is moved to when it was
 * captured. Only Date is faked -- the refresh awaits real promises.
 */
function atCaptureTime(payload: any[]) {
  vi.useFakeTimers({ now: captureTime(payload), toFake: ['Date'] })
}

function harness(payload: any, existing: Record<string, any> = {}) {
  const model: Record<string, any> = { ...existing }
  const published: { path: string; value: any; timestamp: string }[] = []

  const publisher = {
    meta: () => {},
    values: () => {},
    value(path: string, value: any, timestamp: string) {
      published.push({ path, value, timestamp })
      model[path] = value
    },
    selfPath(path: string) {
      if (path.endsWith('.value')) return model[path.slice(0, -'.value'.length)]
      const prefix = path + '.'
      const children: Record<string, any> = {}
      for (const [key, value] of Object.entries(model)) {
        if (!key.startsWith(prefix)) continue
        const leaf = key.slice(prefix.length)
        if (leaf.includes('.')) continue
        children[leaf] = { value }
      }
      return Object.keys(children).length > 0 ? children : undefined
    },
    status: () => {},
    fail: () => {},
    error: () => {},
    debug: () => {},
    dataDirPath: () => '/nonexistent'
  }

  const ctx = {
    client: { json: async () => payload, text: async () => '' },
    publisher,
    settings: settingsFrom({ sendAlertsWatchesWarnings: true }),
    stopped: () => false
  }

  return {
    ctx,
    model,
    published,
    at: (path: string) => model[path],
    paths: () => published.map((p) => p.path)
  }
}

describe('currentAlertNotifications', () => {
  it('reduces a 30-day archive to the handful of live conditions', () => {
    // The defect behind issue #45: every message in the payload became its own
    // permanent notification. 118-200 messages per capture, all raised at once.
    for (const name of ALERT_FIXTURES) {
      const payload = fixtureJson(name)
      const { inForce } = select(name)

      expect(payload.length, name).toBeGreaterThan(100)
      expect(inForce.length, name).toBeGreaterThan(0)
      expect(inForce.length, name).toBeLessThanOrEqual(10)
    }
  })

  it('never exceeds the safety limit', () => {
    for (const name of ALERT_FIXTURES) {
      const { inForce, dropped } = select(name)
      expect(inForce.length).toBeLessThanOrEqual(MAX_ALERT_NOTIFICATIONS)
      // No real payload should be anywhere near it.
      expect(dropped, name).toBe(0)
    }
  })

  it('raises at most one notification per NOAA message code', () => {
    // NOAA mints a new serial number every time it extends or continues a
    // condition -- WARK04 appears 19 times in one capture -- so keying the path
    // on the serial number made one ongoing warning into 19 permanent paths.
    for (const name of ALERT_FIXTURES) {
      const { inForce } = select(name, { maxAgeMs: 30 * 24 * HOUR_MS })
      const codes = inForce.map((a) => a.code)
      expect(new Set(codes).size, name).toBe(codes.length)
    }
  })

  it('keeps the newest message for a code, whatever order it arrives in', () => {
    // NOAA returns the archive newest-first, but nothing promises that, and
    // "the most recent message for this condition" is the whole contract of a
    // per-code path.
    const entry = (serial: number, issued: string) => ({
      product_id: 'K04W',
      issue_datetime: issued,
      message:
        `Space Weather Message Code: WARK04\nSerial Number: ${serial}\n` +
        'Issue Time: 2026 Aug 01 1200 UTC\n\nWARNING: test\n'
    })
    const now = new Date('2026-08-01T13:00:00Z')
    const pick = (payload: any[]) =>
      currentAlertNotifications(payload, { now, maxAgeMs: 6 * HOUR_MS }).inForce

    const older = entry(1, '2026-08-01 11:00:00.000')
    const newer = entry(2, '2026-08-01 12:00:00.000')
    expect(pick([older, newer])).toHaveLength(1)
    expect(pick([older, newer])[0].serialNumber).toBe('2')
    expect(pick([newer, older])[0].serialNumber).toBe('2')

    // A reissue can share the millisecond; the serial is monotonic per code.
    expect(
      pick([entry(7, '2026-08-01 12:00:00.000'), newer])[0].serialNumber
    ).toBe('7')
  })

  it('drops messages whose stated validity has passed', () => {
    const payload = fixtureJson('alerts.2025_04_17.json')
    const now = captureTime(payload)
    const { inForce } = currentAlertNotifications(payload, {
      now,
      maxAgeMs: 30 * 24 * HOUR_MS
    })

    const expired = inForce.filter(
      (a) => a.validUntil && a.validUntil.getTime() <= now.getTime()
    )
    expect(expired).toEqual([])
    // The window is wide open, so anything held back was held back on its own
    // stated expiry rather than on age.
    expect(inForce.some((a) => a.validUntil !== null)).toBe(true)
  })

  it('bounds a message that states no validity by age instead', () => {
    const payload = fixtureJson('alerts.2026_08_01.json')
    const now = captureTime(payload)
    const wide = currentAlertNotifications(payload, {
      now,
      maxAgeMs: 72 * HOUR_MS
    }).inForce
    const narrow = currentAlertNotifications(payload, {
      now,
      maxAgeMs: 6 * HOUR_MS
    }).inForce

    expect(narrow.length).toBeLessThan(wide.length)
    for (const alert of narrow) {
      const age = now.getTime() - alert.issued.getTime()
      expect(alert.validUntil !== null || age < 6 * HOUR_MS).toBe(true)
    }
  })

  it('gives an informational message no method at all', () => {
    // This is the beeping in issue #45: ~110 of the 118 messages in a capture
    // are below the threshold, and every one of them carried visual+sound.
    for (const name of ALERT_FIXTURES) {
      for (const alert of select(name).inForce) {
        if (alert.state === 'normal' || alert.state === 'alert') {
          expect(alert.method, `${name} ${alert.code}`).toEqual([])
        }
      }
    }
  })

  it('reserves sound for the alarm level, and honours the user ceiling', () => {
    // At the peak of the 16 April storm: ALTK08 was issued at 2054 and the
    // next lower reading only at 2140, so the G4 is genuinely current here.
    const now = new Date('2025-04-16T21:00:00Z')
    const payload = asOf(fixtureJson('alerts.2025_04_17.json'), now)
    const loud = currentAlertNotifications(payload, {
      now,
      maxAgeMs: 24 * HOUR_MS,
      alertThreshold: 1
    }).inForce
    const alarms = loud.filter((a) => a.state === 'alarm')

    expect(alarms.length).toBeGreaterThan(0)
    for (const alert of alarms)
      expect(alert.method).toEqual(['visual', 'sound'])

    const muted = currentAlertNotifications(payload, {
      now,
      maxAgeMs: 24 * HOUR_MS,
      alertThreshold: 1,
      sound: false
    }).inForce
    for (const alert of muted) expect(alert.method).not.toContain('sound')
  })

  it('resolves a cancellation to normal and silent', () => {
    const payload = fixtureJson('alerts.2026_08_01.json')
    const cancel = payload.find((a: any) =>
      a.message.includes('CANCEL WARNING')
    )
    expect(cancel).toBeDefined()

    const { inForce } = currentAlertNotifications([cancel], {
      now: new Date(cancel.issue_datetime + 'Z'),
      maxAgeMs: HOUR_MS,
      alertThreshold: 1
    })
    expect(inForce).toHaveLength(1)
    expect(inForce[0].state).toBe('normal')
    expect(inForce[0].method).toEqual([])
  })

  it('stands a level down when NOAA reports a lower one for the same phenomenon', () => {
    // The gap cancellations and observed-value zones both miss: an ALT message
    // carries no stated expiry, so a G3 stays raised for a full day after the
    // next synoptic period has already reported the storm easing.
    const now = new Date('2026-07-04T15:00:00Z')
    const payload = asOf(fixtureJson('alerts.2026_08_01.json'), now)
    const codes = (p: any[]) =>
      currentAlertNotifications(p, {
        now,
        maxAgeMs: 24 * HOUR_MS,
        alertThreshold: 3
      }).inForce.map((a) => a.code)

    // ALTK07 was issued at 0510 and the last ALTK06 at 1358, both inside the
    // 24-hour window. Only the lower one describes the present.
    expect(codes(payload)).toContain('ALTK06')
    expect(codes(payload)).not.toContain('ALTK07')

    // Without any later lower reading it stays up: this is a downgrade rule,
    // not a blanket age cut.
    const noLowerReadings = payload.filter(
      (a: any) => !/Message Code: ALTK0[456]/.test(a.message)
    )
    expect(codes(noLowerReadings)).toContain('ALTK07')
  })

  it('keeps a level that a lower one only preceded', () => {
    // A storm ramping up issues K4, then K5, then K6. Every lower message is
    // older, and standing the top of the ladder down on those would silence
    // the plugin exactly when it matters.
    const entry = (code: string, issued: string) => ({
      product_id: code,
      issue_datetime: issued,
      message:
        `Space Weather Message Code: ${code}\nSerial Number: 1\n` +
        'Issue Time: 2026 Aug 01 1200 UTC\n\nALERT: test\n'
    })
    const { inForce } = currentAlertNotifications(
      [
        entry('ALTK04', '2026-08-01 10:00:00.000'),
        entry('ALTK05', '2026-08-01 11:00:00.000'),
        entry('ALTK07', '2026-08-01 12:00:00.000')
      ],
      { now: new Date('2026-08-01T13:00:00Z'), maxAgeMs: 24 * HOUR_MS }
    )
    expect(inForce.map((a) => a.code).sort()).toEqual([
      'ALTK04',
      'ALTK05',
      'ALTK07'
    ])
  })

  it('leaves a shared prefix that is not a severity ladder alone', () => {
    // ALTTP2 and ALTTP4 are Type II and Type IV radio bursts -- unrelated
    // emissions, not rungs. Grouping them by prefix stood a live Type IV
    // burst down when a Type II arrived 45 seconds later.
    const now = new Date('2026-07-30T18:00:00Z')
    const payload = asOf(fixtureJson('alerts.2026_08_01.json'), now)
    const codes = currentAlertNotifications(payload, {
      now,
      maxAgeMs: 24 * HOUR_MS,
      alertThreshold: 3
    }).inForce.map((a) => a.code)

    expect(codes).toContain('ALTTP2')
    expect(codes).toContain('ALTTP4')
  })

  it('keeps codes that only look like one phenomenon', () => {
    // ALTPC0 and ALTPX1 are different particle measurements, and a code with
    // no number at all is on no ladder.
    const entry = (code: string, issued: string) => ({
      product_id: code,
      issue_datetime: issued,
      message:
        `Space Weather Message Code: ${code}\nSerial Number: 1\n` +
        'Issue Time: 2026 Aug 01 1200 UTC\n\nALERT: test\n'
    })
    const { inForce } = currentAlertNotifications(
      [
        entry('ALTPX1', '2026-08-01 10:00:00.000'),
        entry('ALTPC0', '2026-08-01 12:00:00.000'),
        entry('ALTXMF', '2026-08-01 12:00:00.000')
      ],
      { now: new Date('2026-08-01T13:00:00Z'), maxAgeMs: 24 * HOUR_MS }
    )
    expect(inForce).toHaveLength(3)
  })

  it('leaves no stale K-index level raised in any fixture', () => {
    // Named families rather than the implementation's own regex: an invariant
    // written in terms of the rule it is checking passes by construction.
    for (const name of ALERT_FIXTURES) {
      const kIndex = (code: string) => /^(ALTK|WARK)(\d+)$/.exec(code)
      const { inForce } = select(name)
      for (const a of inForce)
        for (const b of inForce) {
          const [ra, rb] = [kIndex(a.code), kIndex(b.code)]
          if (!ra || !rb || ra[1] !== rb[1]) continue
          const stale = Number(ra[2]) > Number(rb[2]) && a.issued < b.issued
          expect(stale, `${name} ${a.code} under ${b.code}`).toBe(false)
        }
    }
  })

  it('counts unparseable entries rather than throwing on them', () => {
    const { inForce, unparseable } = currentAlertNotifications(
      [null, {}, { message: 'nonsense' }],
      { now: new Date(), maxAgeMs: HOUR_MS }
    )
    expect(inForce).toEqual([])
    expect(unparseable).toBe(3)
  })
})

describe('alerts product', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('publishes one path per code under the alerts base', async () => {
    const payload = fixtureJson('alerts.2025_04_17.json')
    atCaptureTime(payload)
    const h = harness(payload)
    await alerts.refresh(h.ctx as any)

    expect(h.paths().length).toBeGreaterThan(0)
    for (const path of h.paths()) {
      expect(path.startsWith(ALERTS_BASE + '.')).toBe(true)
      expect(path).not.toContain('sn:')
    }
  })

  it('publishes nothing at all once the payload has gone stale', async () => {
    // Every message in a 30-day archive eventually falls out of force, and the
    // right number of notifications for that is zero, not 200.
    const payload = fixtureJson('alerts.2025_04_17.json')
    const h = harness(payload)
    await alerts.refresh(h.ctx as any)
    expect(h.published).toEqual([])
  })

  it('republishes nothing when the payload has not changed', async () => {
    // The old code re-emitted every notification on every poll, so a client
    // resynced the whole set hourly for as long as the server ran.
    const payload = fixtureJson('alerts.2025_04_17.json')
    atCaptureTime(payload)
    const h = harness(payload)
    await alerts.refresh(h.ctx as any)
    expect(h.published.length).toBeGreaterThan(0)

    h.published.length = 0
    await alerts.refresh(h.ctx as any)
    expect(h.published).toEqual([])
  })

  it('stands down a code that is no longer in force', async () => {
    const payload = fixtureJson('alerts.2026_08_01.json')
    atCaptureTime(payload)
    const stale = `${ALERTS_BASE}.WATA50`
    const h = harness(payload, {
      [stale]: {
        id: 'noaa_swpc_alert_WATA50',
        serialNumber: '999',
        state: 'alarm',
        method: ['visual', 'sound']
      }
    })
    await alerts.refresh(h.ctx as any)

    expect(h.at(stale).state).toBe('normal')
    expect(h.at(stale).method).toEqual([])
  })

  it('clears the per-serial paths left behind by earlier versions', async () => {
    // Upgrading cannot delete a Signal K path, so the ~200 notifications the
    // old code raised stay up, still asking for a sound, until something
    // explicitly stands them down.
    const payload = fixtureJson('alerts.2026_08_01.json')
    atCaptureTime(payload)
    const old = `${NOTIFICATIONS_BASE}.sn:3713`
    const h = harness(payload, {
      [old]: {
        id: old,
        message: 'ALERT: Electron 2MeV Integral Flux exceeded 1000pfu',
        state: 'normal',
        method: ['visual', 'sound']
      }
    })
    await alerts.refresh(h.ctx as any)

    expect(h.at(old).method).toEqual([])
  })

  it('declares a timeout so clients expire the notification themselves', () => {
    const settings = settingsFrom({ alertMaxAgeHours: 12 })
    const meta = alerts.metadata!(settings)
    expect(meta).toHaveLength(1)
    expect(meta[0].path).toBe(ALERTS_BASE)
    expect(meta[0].value.timeout).toBe(12 * 60 * 60)
  })

  it('reports a payload that is not an array instead of publishing', async () => {
    const h = harness({ error: 'nope' })
    await alerts.refresh(h.ctx as any)
    expect(h.published).toEqual([])
  })
})
