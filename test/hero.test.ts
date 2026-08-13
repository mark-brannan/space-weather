import { describe, expect, it } from 'vitest'
import {
  STARTUP_GRACE_MS,
  gScaleForKp,
  heroState,
  kpFloorForG,
  timerFor,
  uncapitalise
} from '../public/hero.js'

const NOW = Date.parse('2026-08-12T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const STALE_MS = 3 * HOUR

/** Kp forecast points at three-hour spacing, as NOAA publishes them. */
function series(...kps: number[]) {
  return kps.map((kp, i) => ({
    time: new Date(NOW + (i + 1) * 3 * HOUR).toISOString(),
    kp,
    forecast: true
  }))
}

function state(input: any) {
  return heroState(
    {
      observed: {},
      peak24h: {},
      series: [],
      observedAt: new Date(NOW).toISOString(),
      startedAt: new Date(NOW - HOUR).toISOString(),
      staleAfterMs: STALE_MS,
      ...input
    },
    NOW
  )
}

describe('heroState', () => {
  it('is starting up while nothing has arrived inside the grace period', () => {
    const result = state({
      observed: {},
      startedAt: new Date(NOW - 60_000).toISOString()
    })
    expect(result.kind).toBe('starting')
  })

  it('stops calling it start-up once the plugin has been running a while', () => {
    const result = state({
      observed: {},
      startedAt: new Date(NOW - STARTUP_GRACE_MS - 1000).toISOString()
    })
    expect(result.kind).toBe('silent')
    expect(result.timer.kind).toBe('since-start')
  })

  it('treats an unknown start time as start-up rather than as failure', () => {
    expect(state({ observed: {}, startedAt: null }).kind).toBe('starting')
  })

  it('calls values older than the stale window stale, whatever they say', () => {
    const result = state({
      observed: { G: 0, S: 0, R: 0 },
      observedAt: new Date(NOW - STALE_MS - 1000).toISOString()
    })
    expect(result.kind).toBe('stale')
    expect(result.timer.kind).toBe('since-update')
  })

  it('leads with the worst scale in force', () => {
    const result = state({ observed: { G: 1, S: 4, R: 0 } })
    expect(result.kind).toBe('storm')
    expect(result.letter).toBe('S')
    expect(result.level).toBe(4)
  })

  it('breaks a tie G before R before S', () => {
    expect(state({ observed: { G: 3, S: 3, R: 3 } }).letter).toBe('G')
    expect(state({ observed: { S: 3, R: 3 } }).letter).toBe('R')
    expect(state({ observed: { S: 3 } }).letter).toBe('S')
  })

  it('keeps every other scale in force alongside the one it leads with', () => {
    const result = state({ observed: { G: 4, S: 4, R: 3 } })
    expect(result.letter).toBe('G')
    expect(result.also).toEqual([
      { letter: 'R', level: 3 },
      { letter: 'S', level: 4 }
    ])
  })

  it('does not read the Kp forecast as an easing time for another scale', () => {
    // The series is geomagnetic. An R4 with a quiet sky ahead must not
    // produce a time at which the radio blackout supposedly eases.
    const result = state({
      observed: { R: 4, G: 0, S: 0 },
      series: series(2, 2, 2)
    })
    expect(result.letter).toBe('R')
    expect(result.timer.kind).toBe('forecast-clear')
  })

  it('still counts an inbound G storm while another scale leads', () => {
    const result = state({
      observed: { R: 4, G: 0, S: 0 },
      series: series(2, 8, 8)
    })
    expect(result.letter).toBe('R')
    expect(result.timer).toEqual({
      kind: 'until-level',
      level: 4,
      at: new Date(NOW + 6 * HOUR).toISOString()
    })
  })

  it('does not list a scale below the level worth surfacing', () => {
    const result = state({ observed: { G: 3, S: 2, R: 1 } })
    expect(result.also).toEqual([])
  })

  it('is brewing when now is quiet but the forecast is not', () => {
    const result = state({
      observed: { G: 1, S: 0, R: 0 },
      series: series(4, 5, 7)
    })
    expect(result.kind).toBe('brewing')
    expect(result.level).toBe(3)
    expect(result.timer).toEqual({
      kind: 'until-level',
      level: 3,
      at: new Date(NOW + 9 * HOUR).toISOString()
    })
  })

  it('prefers a storm still coming over one already gone', () => {
    const result = state({
      observed: { G: 1 },
      peak24h: { G: 4 },
      series: series(7)
    })
    expect(result.kind).toBe('brewing')
  })

  it('says so when a real storm has passed and nothing is coming', () => {
    const result = state({
      observed: { G: 1 },
      peak24h: { G: 3 },
      series: series(2, 3)
    })
    expect(result.kind).toBe('all-clear')
    expect(result.peak).toEqual({ letter: 'G', level: 3 })
  })

  it('is quiet after a G1 or G2, which is an ordinary day', () => {
    const result = state({ observed: { G: 1 }, peak24h: { G: 2 } })
    expect(result.kind).toBe('quiet')
    expect(result.peak).toEqual({ letter: 'G', level: 2 })
  })

  it('carries no peak when nothing rose above background', () => {
    const result = state({ observed: { G: 0 }, peak24h: { G: 0, S: 0, R: 0 } })
    expect(result.kind).toBe('quiet')
    expect(result.peak).toBeNull()
  })
})

describe('kpFloorForG', () => {
  it('puts each band a third below the Kp it is named after', () => {
    // Exported because index.html draws the chart's threshold lines from it.
    // The page used to carry its own copy on the integers, which put the
    // chart's "G4 starts here" rule above the level its own banner reported.
    expect([1, 2, 3, 4, 5].map(kpFloorForG)).toEqual([
      5 - 1 / 3,
      6 - 1 / 3,
      7 - 1 / 3,
      8 - 1 / 3,
      9 - 1 / 3
    ])
  })

  it('agrees with the G level the banner reads off the same value', () => {
    for (let g = 1; g <= 5; g++) {
      expect(gScaleForKp(kpFloorForG(g)), `G${g}`).toBe(g)
      expect(gScaleForKp(kpFloorForG(g) - 1 / 3), `below G${g}`).toBe(g - 1)
    }
  })
})

describe('uncapitalise', () => {
  it('lowers an ordinary opening word', () => {
    expect(uncapitalise('Intermittent GNSS problems.')).toBe(
      'intermittent GNSS problems.'
    )
  })

  it('leaves an acronym alone', () => {
    expect(uncapitalise('HF blackout.')).toBe('HF blackout.')
    expect(uncapitalise('GNSS degraded.')).toBe('GNSS degraded.')
  })
})

describe('timerFor', () => {
  it('counts to the level above the one in force during a storm', () => {
    const timer = timerFor(series(7, 8, 6), 3, NOW)
    expect(timer).toEqual({
      kind: 'until-level',
      level: 4,
      at: new Date(NOW + 6 * HOUR).toISOString()
    })
  })

  it('bands Kp on NOAA thirds, so 8- escalates a G3', () => {
    // Kp 7.67 is 8-, the bottom of NOAA's Kp 8 band and so G4. The webapp
    // mirrors kpFloorForG rather than importing it, and the two grading the
    // same storm differently is what that mirror exists to avoid.
    const timer = timerFor(series(7.67), 3, NOW)
    expect(timer).toEqual({
      kind: 'until-level',
      level: 4,
      at: new Date(NOW + 3 * HOUR).toISOString()
    })
  })

  it('counts to the drop when the storm only eases from here', () => {
    const timer = timerFor(series(7, 6, 4), 3, NOW)
    expect(timer).toEqual({
      kind: 'until-easing',
      at: new Date(NOW + 6 * HOUR).toISOString()
    })
  })

  it('counts the clear window when nothing ahead reaches storm level', () => {
    const timer = timerFor(series(2, 3, 4), 0, NOW)
    expect(timer).toEqual({
      kind: 'forecast-clear',
      at: new Date(NOW + 9 * HOUR).toISOString()
    })
  })

  it('ignores points that have already passed', () => {
    const past = [
      { time: new Date(NOW - HOUR).toISOString(), kp: 9, forecast: false }
    ]
    expect(timerFor([...past, ...series(2)], 0, NOW).kind).toBe(
      'forecast-clear'
    )
  })

  it('reports nothing to count rather than inventing a time', () => {
    expect(timerFor([], 0, NOW)).toEqual({ kind: 'unknown' })
  })
})
