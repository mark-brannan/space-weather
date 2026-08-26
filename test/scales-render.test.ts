import { describe, expect, it } from 'vitest'
import { ENDPOINTS, leafValue } from '../public/signalk.js'
import { LETTERS, SCALES_CARD_SOURCES, scalesCard } from '../public/scales.js'
import { scales } from '../src/products/scales.js'
import { ValueUpdate } from '../src/parse.js'
import { SCALES_FIXTURES, fixture, fixtureJson } from './fixtures.js'
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

/**
 * Everything above states its expectation as a numeral. A numeral in a test
 * is indistinguishable from a numeral pasted out of a failing run, and issue
 * #121 names that as the root cause of #120: every input in this repo was
 * hand-built by whoever wrote the code, so the suite could only ever agree
 * with the code's assumptions.
 *
 * So these blocks take their expectations from NOAA instead. None of them
 * knows what the transform does; all would still be right if this plugin had
 * never been written.
 */

/**
 * NOAA's severity words for its own scales, from
 * https://www.swpc.noaa.gov/noaa-scales-explanation. `none` is not on that
 * page -- it is the word the payloads use for "no event in force", the
 * level the page describes by leaving off its bottom.
 *
 * Deliberately not `NoaaScaleNames` from `src/parse.ts`, even though this
 * file already imports from that module for `ValueUpdate`: the whole point
 * of this block is an expectation sourced outside the codebase, and reading
 * the plugin's own vocabulary table would make a typo in it self-confirming.
 */
const NOAA_SEVERITY_WORDS = [
  'none',
  'minor',
  'moderate',
  'strong',
  'severe',
  'extreme'
]

/**
 * The level NOAA's own prose gives for one scale in a captured payload, or
 * `null` when the payload carries no `Text` at all for that scale -- a
 * genuinely absent field, not a word this list fails to recognise.
 *
 * `Text` sits beside `Scale` in every entry and `transformJsonScaleRange`
 * never reads it, so it is a second, independent statement of the same fact
 * inside the same bytes. If the card were wired to the wrong path, the
 * numeral it drew would stop matching the word NOAA printed next to it.
 *
 * Throws, rather than returning null, when `Text` is present but not in
 * `NOAA_SEVERITY_WORDS`: this oracle exists precisely because nothing else
 * in the suite would notice if NOAA renamed its own words, so a silent null
 * here is that exact failure mode, not a safe default.
 */
function levelNoaaCalls(fixtureName: string, letter: string): number | null {
  // "-1" is NOAA's key for the rolling 24-hour maximum -- the window its
  // front page and the WWV bulletin report as the day's condition.
  const text = fixtureJson(fixtureName)['-1']?.[letter]?.Text
  if (typeof text !== 'string') return null
  const level = NOAA_SEVERITY_WORDS.indexOf(text.trim().toLowerCase())
  if (level === -1)
    throw new Error(
      `unrecognised NOAA severity word "${text}" for ${letter} in ${fixtureName}`
    )
  return level
}

describe('the badge reads the level NOAA states in words', () => {
  // The G4 day issue #121 names. NOAA prints "severe" beside it; "severe" is
  // level 4 on NOAA's published scale, so the badge must read 4. Nothing
  // here was copied from a run of this code.
  it.each(SCALES_FIXTURES)('agrees with NOAA throughout %s', async (f) => {
    const card = scalesCard(await publishedFrom(f))
    for (const letter of LETTERS) {
      const stated = levelNoaaCalls(f, letter)
      if (stated === null) continue
      expect(card.observed[letter], `${letter} in ${f}`).toBe(stated)
    }
  })

  it('pins the storm days by name, so a quiet corpus cannot pass it', () => {
    expect(levelNoaaCalls('noaa-scales.2025_04_16.json', 'G')).toBe(4)
    expect(levelNoaaCalls('noaa-scales.2026_08_25.json', 'R')).toBe(2)
    // Both read 0 in the instantaneous sample, which is what #120 drew.
    for (const [f, letter] of [
      ['noaa-scales.2025_04_16.json', 'G'],
      ['noaa-scales.2026_08_25.json', 'R']
    ]) {
      expect(fixtureJson(f)['0'][letter].Scale).toBe('0')
    }
  })

  it('corroborates every cell the corpus carries a Text field for', () => {
    let corroborated = 0
    for (const f of SCALES_FIXTURES)
      for (const letter of LETTERS)
        if (levelNoaaCalls(f, letter) !== null) corroborated++
    // Every cell the corpus carries a Text field for resolves today.
    // `agrees with NOAA throughout %s` skips a null silently -- by design,
    // since `Text` is genuinely absent for some payloads -- so this is the
    // count that notices if NOAA stopped sending the field somewhere it
    // used to, rather than everything above quietly corroborating nothing.
    expect(corroborated).toBe(SCALES_FIXTURES.length * LETTERS.length)
  })
})

/**
 * The strongest cross-source check the repo has: a human-language bulletin,
 * on a different endpoint, saying in words what the badge should say in a
 * numeral.
 *
 * `wwv.txt` is the Geophysical Alert Message -- what NOAA broadcasts over
 * WWV/WWVH radio for anyone without a browser. `aIndex.ts` reads its solar
 * flux and K-index lines and nothing else, so the storm sentences below are
 * untouched by any code in this plugin.
 *
 * The pair: `wwv.2026_08_25.txt` says "Radio blackouts reaching the R2 level
 * occurred" of the preceding 24 hours; `noaa-scales.2026_08_25.json`
 * summarises the same window. That is issue #120's payload, and NOAA states
 * its answer in English before the JSON we transform.
 *
 * Only "occurred" counts. The same bulletin predicts R2 for the *next* 24
 * hours in a sentence of identical shape, and the observed badge must not
 * draw a forecast -- which is a mistake of exactly #120's family.
 */
const WWV_OBSERVED = /reaching the ([GSR])(\d) level occurred/gi

/** The highest level each scale reached, per a WWV bulletin's own prose. */
function levelsWwvReports(fixtureName: string) {
  const highest: Record<string, number> = {}
  for (const [, letter, level] of fixture(fixtureName).matchAll(WWV_OBSERVED)) {
    const key = letter.toUpperCase()
    highest[key] = Math.max(highest[key] ?? 0, Number(level))
  }
  return highest
}

describe('the badge agrees with the WWV radio bulletin', () => {
  it('reads R2 out of the bulletin, in words, for the #120 window', () => {
    expect(levelsWwvReports('wwv.2026_08_25.txt')).toEqual({ R: 2 })
  })

  it('draws every level the bulletin says occurred', async () => {
    const card = scalesCard(await publishedFrom('noaa-scales.2026_08_25.json'))
    for (const [letter, level] of Object.entries(
      levelsWwvReports('wwv.2026_08_25.txt')
    )) {
      expect(card.observed[letter], letter).toBe(level)
    }
  })

  it("does not mistake the bulletin's forecast for what occurred", () => {
    // The same file predicts R2 for the next 24 hours. If the matcher were
    // loose enough to take that sentence too, a bulletin forecasting a storm
    // that never came would demand the badge draw it.
    const text = fixture('wwv.2026_08_25.txt')
    expect(text).toContain('R2 level are likely')
    expect(text.match(WWV_OBSERVED)).toHaveLength(1)
  })
})

/**
 * A second cross-source check, on a machine-readable endpoint.
 *
 * `/products/alerts.json` is a different NOAA endpoint, written by a
 * different pipeline, and its messages carry their own `NOAA Scale:` line.
 * Where a captured alerts archive overlaps the 24-hour window a captured
 * scales payload summarises, the two are independent statements of what the
 * badge should say -- the situation #121 asks for.
 *
 * Only observed messages count. A WATCH or a WARNING names a level NOAA
 * expects, often days out and often higher than anything that happened; the
 * card draws what occurred. `CONTINUED ALERT` counts too -- it is a proton
 * event still in force, not a forecast, and excluding it would make the
 * oracle under-report by construction on a day whose peak is only on record
 * as a continuation.
 */
const OBSERVED_ALERT = /^(ALERT|SUMMARY|CONTINUED ALERT):/m
// `parse.ts` documents "Predicted NOAA Scale:" as a form NOAA actually sends
// -- a forecast line, not what happened -- so it must not feed this oracle
// the way an unguarded match would.
const STATED_SCALE = /(?<!Predicted )NOAA Scale:\s*([GSR])(\d)/gi

/** The highest level each scale reached, per the alerts archive, on `date`. */
function levelsAlertsReport(fixtureName: string, date: string) {
  const highest: Record<string, number> = {}
  for (const entry of fixtureJson(fixtureName)) {
    if (!String(entry.issue_datetime ?? '').startsWith(date)) continue
    const message = String(entry.message ?? '')
    if (!OBSERVED_ALERT.test(message)) continue
    for (const [, letter, level] of message.matchAll(STATED_SCALE)) {
      const key = letter.toUpperCase()
      highest[key] = Math.max(highest[key] ?? 0, Number(level))
    }
  }
  return highest
}

describe('the badge agrees with a second NOAA endpoint', () => {
  // 2026-07-31 is the day noaa-scales.2026_08_01.json summarises in its
  // 24-hour maximum, and the day alerts.2026_08_01.json still holds the
  // messages for. A proton event ran through it.
  const DATE = '2026-07-31'

  it('finds an observed event in the alerts archive for that day', () => {
    expect(levelsAlertsReport('alerts.2026_08_01.json', DATE)).toEqual({ S: 1 })
  })

  it('does not mistake a predicted scale line for what occurred', () => {
    // WARPX1 #600, in a different archive, predicts S1 while warning of an
    // oncoming proton event -- a forecast line, not an observation. If the
    // matcher were loose enough to take it, a predicted event that never
    // materialised would demand the badge draw it.
    const entries: { message: string }[] = fixtureJson('alerts.2025_04_11.json')
    const message = entries.find((e) =>
      e.message.includes('Predicted NOAA Scale: S1')
    )?.message
    expect(message).toContain('Predicted NOAA Scale: S1')
    expect([...message.matchAll(STATED_SCALE)]).toHaveLength(0)
  })

  it('draws every level the alerts archive observed', async () => {
    const card = scalesCard(await publishedFrom('noaa-scales.2026_08_01.json'))
    for (const [letter, level] of Object.entries(
      levelsAlertsReport('alerts.2026_08_01.json', DATE)
    )) {
      // At least: the archive is a 30-day file cut at capture time, so it can
      // hold fewer messages than the window saw, never more.
      expect(card.observed[letter], letter).toBeGreaterThanOrEqual(level)
    }
  })
})
