import { describe, expect, it } from 'vitest'
import { LETTERS, scalesCard } from '../public/scales.js'
import { SOLAR_WIND_BASE } from '../src/paths'
import { solarWind } from '../src/products/solarWind'
import {
  FLARE_FIXTURES,
  SCALES_FIXTURES,
  SOLAR_WIND_FIXTURES,
  SYNTHETIC_FLARE_FIXTURES,
  SYNTHETIC_HOSTILE_SCALES_FIXTURES,
  SYNTHETIC_SCALES_FIXTURES,
  fixtureJson,
  publishedScalesTree
} from './fixtures'
import { harness } from './harness'

/**
 * Issue #120: the badge read NOAA's instantaneous scale field, which is 0 in
 * every real capture -- including the day whose 24-hour maximum was G4 -- so
 * the correct output and the broken output were the same bytes and the suite
 * stayed green. `src/` alone cannot catch that: the plugin published both
 * fields correctly, and the wrong one was read one layer up, in the webapp.
 *
 * So this drives the real product over every fixture in `examples/` -- real
 * captures and the invented corpus in `examples/synthetic/` alike -- and asks
 * the webapp's own card module what it draws, then fails if any field is
 * 0-or-absent across the whole corpus. A field that never once moves is not a
 * quiet sky; it is a surface wired to the wrong place.
 *
 * Asking the card rather than the Signal K path is the whole point. #120 was
 * a correct value on a correct path, read from the wrong one a layer above,
 * so a sweep that stops at the path proves only the half that was never
 * broken. Solar wind is the exception below, and says why.
 *
 * It is only ever as good as the corpus. Against an all-quiet one it would
 * pass a card wired to nothing, which is why `scales-render.test.ts` still
 * pins the two storm days by name against NOAA's own words. What this buys is
 * the fields nobody thought to pin individually.
 *
 * `kp` and `aurora` are not swept here. `kp` windows its output against the
 * real clock (see `parseKpForecast`'s `now` argument), so a generic sweep
 * would need a different pinned system time per fixture; `aurora` needs a
 * vessel position and a grid cache neither `examples/` nor this harness
 * carries. Both are candidates for the same treatment, not exempt from it --
 * follow-up work rather than a fit for this harness as it stands.
 */

// The torn-payload pair is deliberately absent: neither holds a complete JSON
// value, so feeding them here would only prove that JSON.parse throws on them.
// `synthetic-fixtures.test.ts` exercises them against `firstJsonValue`, which
// is the thing that actually has to survive them.
const SCALES_CORPUS = [
  ...SCALES_FIXTURES,
  ...SYNTHETIC_SCALES_FIXTURES.map((f) => `synthetic/${f}`),
  ...SYNTHETIC_HOSTILE_SCALES_FIXTURES.map((f) => `synthetic/${f}`)
]

const FLARE_CORPUS = [
  ...FLARE_FIXTURES,
  ...SYNTHETIC_FLARE_FIXTURES.map((f) => `synthetic/${f}`)
]

// The flare class comes from its own endpoint, so the scales half of that
// pairing is irrelevant to it -- any payload that publishes will do.
const ANY_SCALES_FIXTURE = 'noaa-scales.2026_08_01.json'

const isDead = (values: unknown[]) =>
  values.every((v) => v === null || v === undefined || v === 0)

describe('no field a webapp surface draws is dead across the whole fixture corpus', () => {
  it('finds a non-zero Storm Scales reading somewhere in examples/', async () => {
    // No flare fixture paired in: nothing recorded below reads the flare
    // class, and the case below sweeps it over a corpus of its own.
    const cards = await Promise.all(
      SCALES_CORPUS.map(async (f) => scalesCard(await publishedScalesTree(f)))
    )

    // Keyed by label, so a failure names the field rather than the count.
    const drawn: Record<string, unknown[]> = {}
    const record = (label: string, value: unknown) =>
      (drawn[label] ??= []).push(value)
    for (const card of cards) {
      for (const letter of LETTERS)
        record(`observed.${letter}`, card.observed[letter])
      card.forecast.forEach((day, i) => {
        record(`forecast.${i}.G`, day.G)
        record(`forecast.${i}.S`, day.sProbability)
        record(`forecast.${i}.R.minor`, day.rMinorProbability)
        record(`forecast.${i}.R.major`, day.rMajorProbability)
      })
    }

    const dead = Object.entries(drawn)
      .filter(([, values]) => isDead(values))
      .map(([label]) => label)
    expect(dead).toEqual([])
  })

  it('finds a non-empty X-ray flare class somewhere in examples/', async () => {
    const classes = await Promise.all(
      FLARE_CORPUS.map(
        async (f) =>
          scalesCard(await publishedScalesTree(ANY_SCALES_FIXTURE, f))
            .flareClass
      )
    )
    expect(classes.some((v) => typeof v === 'string' && v.length > 0)).toBe(
      true
    )
  })

  it('finds a non-zero solar wind reading somewhere in examples/', async () => {
    // The one sweep that stops at the Signal K path: solar wind has no card
    // module of its own -- `index.html` reads the three leaves directly -- so
    // there is no layer above to ask.
    const drawn: Record<string, unknown[]> = {}
    for (const { speed, magField } of SOLAR_WIND_FIXTURES) {
      const h = harness({
        '/products/summary/solar-wind-speed.json': fixtureJson(speed),
        '/products/summary/solar-wind-mag-field.json': fixtureJson(magField)
      })
      await solarWind.refresh(h.ctx)
      for (const field of ['speed', 'Bt', 'Bz'])
        (drawn[field] ??= []).push(h.valueAt(`${SOLAR_WIND_BASE}.${field}`))
    }

    const dead = Object.entries(drawn)
      .filter(([, values]) => isDead(values))
      .map(([label]) => label)
    expect(dead).toEqual([])
  })
})
