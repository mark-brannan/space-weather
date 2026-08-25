import { describe, expect, it } from 'vitest'
import { ENDPOINTS, leafValue } from '../public/signalk.js'
import { LETTERS, SCALES_CARD_SOURCES, scalesCard } from '../public/scales.js'
import { scales } from '../src/products/scales.js'
import { ValueUpdate } from '../src/parse.js'
import { SCALES_FIXTURES, fixtureJson } from './fixtures.js'
import { harness } from './harness.js'

/**
 * The gap issue #121 names: `hero.test.ts` proves the decision is right from
 * hand-built objects, and nothing proved which endpoint fills them. These run
 * the real product over a captured payload, serve the result the way the
 * Signal K API would, and ask the card what the badges read.
 */

const SCALES_ENDPOINT = '/products/noaa-scales.json'

type Leaf = { value: unknown; timestamp: string }

/** A GET on a non-leaf path returns the subtree below it, leaves and all. */
type ApiNode = Leaf | { [key: string]: ApiNode }

/** The dotted path a vessel URL addresses; `null` for the plugin's own routes. */
function pathOf(url: string): string | null {
  const vessel = '/signalk/v1/api/vessels/self/'
  return url.startsWith(vessel)
    ? url.slice(vessel.length).replace(/\//g, '.')
    : null
}

/**
 * What a GET on each endpoint would return, built from what the product
 * published. A path it never published 404s, reaching the webapp as `null`.
 */
function apiTree(
  values: ValueUpdate[],
  timestamp: string
): Record<string, ApiNode | null> {
  const data: Record<string, ApiNode | null> = {}
  for (const [id, url] of Object.entries<string>(ENDPOINTS)) {
    const base = pathOf(url)
    if (base === null) continue
    let node: ApiNode | null = null
    for (const { path, value } of values) {
      if (path !== base && !path.startsWith(base + '.')) continue
      const rest = path === base ? [] : path.slice(base.length + 1).split('.')
      const leaf: Leaf = { value, timestamp }
      if (rest.length === 0) {
        node = leaf
        continue
      }
      node ??= {}
      let cursor = node as Record<string, ApiNode>
      for (const key of rest.slice(0, -1))
        cursor = (cursor[key] ??= {}) as Record<string, ApiNode>
      cursor[rest[rest.length - 1]] = leaf
    }
    data[id] = node
  }
  return data
}

// The flare endpoint is left unstubbed: no fixture pairs one with a scales
// payload, and the product treats a failure there as best-effort.
async function publishedFrom(fixture: string) {
  const h = harness({ [SCALES_ENDPOINT]: fixtureJson(fixture) })
  await scales.refresh(h.ctx)
  const last = h.published[h.published.length - 1]
  return apiTree(
    h.published.flatMap((p) => p.values),
    last ? last.timestamp : ''
  )
}

describe('the Storm Scales card, from NOAA payload to badge', () => {
  it('reads G4 on the day whose 24-hour maximum was G4', async () => {
    const card = scalesCard(await publishedFrom('noaa-scales.2025_04_16.json'))
    expect(card.observed.G).toBe(4)
  })

  // Issue #120 as it was reported: a live R2, drawn as R0.
  it('reads R2 on the day a live R2 was reported', async () => {
    const card = scalesCard(await publishedFrom('noaa-scales.2026_08_25.json'))
    expect(card.observed.R).toBe(2)
  })

  it('takes its levels from the 24-hour maximum, not the instantaneous sample', () => {
    expect(SCALES_CARD_SOURCES.observed).toBe('scalesObserved')
    // The pairing the card resolves has to be one the webapp actually fetches.
    for (const id of Object.values(SCALES_CARD_SOURCES)) {
      expect(Object.keys(ENDPOINTS)).toContain(id)
    }
  })

  it('converts NOAA probabilities out of the ratio Signal K publishes', async () => {
    // NOAA states this payload's first day as S "Prob": "1" and R
    // "MinorProb": "60", in whole percents; Signal K carries the ratio.
    const data = await publishedFrom('noaa-scales.2025_04_16.json')
    expect(
      leafValue(data.scalesForecast?.['1day']?.S?.probability)
    ).toBeCloseTo(0.01, 10)

    const card = scalesCard(data)
    expect(card.forecast[0].sProbability).toBeCloseTo(1, 10)
    expect(card.forecast[0].rMinorProbability).toBeCloseTo(60, 10)
  })

  it('leaves a missing reading null rather than zero', () => {
    const card = scalesCard({})
    for (const letter of LETTERS) expect(card.observed[letter]).toBeNull()
    expect(card.forecast).toHaveLength(3)
    expect(card.forecast[0].G).toBeNull()
    expect(card.forecast[0].sProbability).toBeNull()
  })
})

/**
 * A canary over the fixture corpus, not a property of the card, and worth
 * keeping as its own case: `examples/` holds a G4 day and an R2 day, so a
 * field that is 0-or-absent in every payload is drawing from somewhere the
 * storms never reach. That is what #120 was. It is only as good as the
 * corpus -- against an all-quiet one it would pass a card wired to nothing,
 * which is why the two storm days are asserted by name above. What it buys
 * is the fields nobody thought to pin individually.
 */
describe('no number the card draws is dead across the whole corpus', () => {
  it('finds a non-zero reading for every one of them', async () => {
    const cards = await Promise.all(
      SCALES_FIXTURES.map(publishedFrom).map(async (d) => scalesCard(await d))
    )

    // Keyed by label, so a failure names the field rather than the count.
    const drawn: Record<string, (number | null)[]> = {}
    const record = (label: string, value: number | null) =>
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
      .filter(([, values]) => values.every((v) => v === null || v === 0))
      .map(([label]) => label)
    expect(dead).toEqual([])
  })
})
