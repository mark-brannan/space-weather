import { describe, expect, it } from 'vitest'
import { ENDPOINTS } from '../public/signalk.js'
import { HERO_SOURCES, heroInputFrom, heroState } from '../public/hero.js'
import { publishedScalesTree } from './fixtures.js'

/**
 * The gap issue #121 names for the hero: `hero.test.ts` proves `heroState`
 * decides correctly from hand-built `observed`/`peak24h` objects, but
 * nothing proved which endpoint fills either one. `scales-render.test.ts`
 * closes the same gap for the Storm Scales badges; this is its sibling for
 * the banner, which reads the same two endpoints for the opposite purpose --
 * `scalesNow` answers "is a storm running right now", `scalesObserved`
 * answers "what was the day's worst" -- so swapping them here is issue #120
 * one tile over, not a repeat of it.
 */
describe('what the hero reads its observed and peak24h from', () => {
  it('resolves to endpoints the webapp actually fetches', () => {
    expect(Object.keys(ENDPOINTS)).toContain(HERO_SOURCES.observed)
    expect(Object.keys(ENDPOINTS)).toContain(HERO_SOURCES.peak24h)
  })

  // The instantaneous sample must never fill the 24-hour peak, and the
  // 24-hour maximum must never answer "is it happening now" -- the same
  // swap issue #120 made for the badges.
  it('never points peak24h at the endpoint that never fills it', () => {
    expect(HERO_SOURCES.observed).toBe('scalesNow')
    expect(HERO_SOURCES.peak24h).toBe('scalesObserved')
  })

  // Issue #120's own payload, driven through the real scales product and
  // `heroInputFrom` -- not a hand-built object -- into `heroState`. The
  // instantaneous reading is R0 throughout this capture (scales-source.test
  // asserts that of every fixture); the 24-hour maximum is R2. If the two
  // sources were swapped, the lead would read R2 "now" (a storm state, not
  // recent) instead of a quiet present with an R2 in the last 24 hours.
  it('reports the R2 that was live when #120 was filed as recent, not current', async () => {
    const data = await publishedScalesTree('noaa-scales.2026_08_25.json')
    const now = Date.now()
    const input = heroInputFrom(data, undefined, undefined, undefined, now)

    expect(input.observed).toEqual({ G: 0, R: 0, S: 0 })
    expect(input.peak24h).toEqual({ G: 0, R: 2, S: 0 })

    const state = heroState(input, now)
    expect(state.kind).toBe('recent')
    expect(state.peak).toEqual({ letter: 'R', level: 2 })
  })
})
