import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NOAA_SCALE_RANGES } from '../src/paths.js'
import {
  firstJsonValue,
  parseXrayFlare,
  transformJsonScaleRange
} from '../src/parse.js'
import {
  SYNTHETIC_FLARE_FIXTURES,
  SYNTHETIC_HOSTILE_SCALES_FIXTURES,
  SYNTHETIC_SCALES_FIXTURES,
  SYNTHETIC_TEXT_FIXTURES,
  SYNTHETIC_TORN_FIXTURE,
  SYNTHETIC_TRUNCATED_FIXTURE,
  fixture,
  fixtureJson
} from './fixtures.js'

/**
 * The invented payloads in `examples/synthetic/`.
 *
 * #120 shipped because the corpus had no payload that disagreed with the code:
 * where two slots hold the same value, "correct" and "reading the wrong slot"
 * produce identical output and the suite stays green. Waiting for a storm does
 * not fix that, because the slots a surface confuses agree with each other on
 * an ordinary day by their nature.
 *
 * These files exist to disagree. Each one puts a different value in every slot
 * a surface reads, so a wrong slot produces a wrong number instead of a
 * coincidentally right one.
 */

const synthetic = (name: string) => fixture(`synthetic/${name}`)
const syntheticJson = (name: string) => fixtureJson(`synthetic/${name}`)

function publish(json: Record<string, unknown>): Map<string, unknown> {
  const values = new Map<string, unknown>()
  for (const range of NOAA_SCALE_RANGES) {
    const slot = json[range.jsonIndex]
    if (!slot) continue
    for (const update of transformJsonScaleRange(
      slot,
      range.subPath,
      range.isObservation
    )) {
      values.set(update.path, update.value)
    }
  }
  return values
}

describe('synthetic fixtures', () => {
  it('names every file in examples/synthetic/', () => {
    const onDisk = readdirSync(
      fileURLToPath(new URL('../examples/synthetic', import.meta.url))
    )
      // README.md documents the directory; it is not a payload.
      .filter((name) => name !== 'README.md')
      .sort()
    const named = [
      ...SYNTHETIC_SCALES_FIXTURES,
      ...SYNTHETIC_HOSTILE_SCALES_FIXTURES,
      ...SYNTHETIC_FLARE_FIXTURES,
      ...SYNTHETIC_TEXT_FIXTURES,
      SYNTHETIC_TRUNCATED_FIXTURE,
      SYNTHETIC_TORN_FIXTURE
    ].sort()
    // A fixture nobody reads is how #120 survived: the evidence was in
    // examples/ the whole time and no test looked at it.
    expect(onDisk).toEqual(named)
  })

  describe('all-slots-distinct', () => {
    const values = publish(syntheticJson('noaa-scales.all-slots-distinct.json'))

    it('gives the two observed slots different G levels', () => {
      // The exact confusion in #120: these are the same shape and the same
      // type, and in every real capture they are also the same value.
      expect(values.get('observations.24_hours_maximums.G')).toBe(2)
      expect(values.get('observations.latest.G')).toBe(0)
    })

    it('gives the two observed slots different S and R levels', () => {
      expect(values.get('observations.24_hours_maximums.S')).toBe(1)
      expect(values.get('observations.latest.S')).toBe(0)
      expect(values.get('observations.24_hours_maximums.R')).toBe(2)
      expect(values.get('observations.latest.R')).toBe(1)
    })

    it('gives all three forecast days different R probabilities', () => {
      // Real captures repeat one probability across days 1, 2 and 3, so
      // drawing day 3's cell in day 1's is undetectable without this file.
      const minor = ['1day', '2day', '3day'].map((day) =>
        values.get(`forecast.${day}.R.minorProbability`)
      )
      expect(minor).toEqual([0.6, 0.4, 0.15])
      expect(new Set(minor).size).toBe(3)
    })

    it('gives all three forecast days different S probabilities and G levels', () => {
      const probabilities = ['1day', '2day', '3day'].map((day) =>
        values.get(`forecast.${day}.S.probability`)
      )
      expect(probabilities).toEqual([0.3, 0.1, 0.01])
      expect(
        ['1day', '2day', '3day'].map((day) => values.get(`forecast.${day}.G`))
      ).toEqual([1, 3, 0])
    })

    it('leaves no two slots publishing the same set of values', () => {
      const perSlot = NOAA_SCALE_RANGES.map((range) => {
        const slot = syntheticJson('noaa-scales.all-slots-distinct.json')[
          range.jsonIndex
        ]
        return JSON.stringify(
          transformJsonScaleRange(slot, range.subPath, range.isObservation).map(
            (update) => update.value
          )
        )
      })
      expect(new Set(perSlot).size).toBe(NOAA_SCALE_RANGES.length)
    })
  })

  it('distinguishes a storm in progress from one that has passed', () => {
    const values = publish(syntheticJson('noaa-scales.storm-in-progress.json'))
    // Peaked at G4, still running at G2. Both non-zero, and the pair is the
    // only thing that says which of the two is happening.
    expect(values.get('observations.24_hours_maximums.G')).toBe(4)
    expect(values.get('observations.latest.G')).toBe(2)
  })

  it('keeps a quiet sky distinct from a quiet sky with a forecast', () => {
    const values = publish(
      syntheticJson('noaa-scales.quiet-with-forecast.json')
    )
    expect(values.get('observations.24_hours_maximums.G')).toBe(0)
    expect(values.get('observations.latest.G')).toBe(0)
    expect(values.get('forecast.1day.R.minorProbability')).toBe(0.55)
    expect(values.get('forecast.2day.G')).toBe(2)
  })

  it('does not let S read as G', () => {
    const values = publish(
      syntheticJson('noaa-scales.solar-radiation-only.json')
    )
    expect(values.get('observations.24_hours_maximums.S')).toBe(3)
    expect(values.get('observations.24_hours_maximums.G')).toBe(0)
    expect(values.get('observations.24_hours_maximums.R')).toBe(0)
  })

  it('carries level 5 through, which no real fixture does', () => {
    const values = publish(syntheticJson('noaa-scales.extreme-all.json'))
    for (const letter of ['G', 'S', 'R']) {
      expect(values.get(`observations.24_hours_maximums.${letter}`)).toBe(5)
    }
    expect(values.get('forecast.1day.S.probability')).toBe(0.99)
  })

  describe('hostile shapes', () => {
    for (const name of SYNTHETIC_HOSTILE_SCALES_FIXTURES) {
      it(`survives ${name} without throwing or publishing NaN`, () => {
        const values = publish(syntheticJson(name))
        for (const [path, value] of values) {
          if (value === null) continue
          if (path.endsWith('.time')) continue
          expect(
            Number.isFinite(value),
            `${path} published ${String(value)}`
          ).toBe(true)
        }
      })
    }

    it('reads a level given as a JSON number, not only as a string', () => {
      // NOAA has changed a payload's types without notice twice. A level that
      // arrives as 3 rather than "3" must not become null.
      const values = publish(syntheticJson('noaa-scales.hostile-types.json'))
      expect(values.get('observations.24_hours_maximums.G')).toBe(3)
      expect(values.get('observations.24_hours_maximums.R')).toBe(2)
    })

    it('publishes nothing rather than 0 when the observed slot is missing', () => {
      // "We do not know" published as 0 is #120 again, by a different route.
      const values = publish(
        syntheticJson('noaa-scales.hostile-missing-observed.json')
      )
      expect(values.has('observations.24_hours_maximums.G')).toBe(false)
      expect(values.get('observations.latest.G')).toBe(1)
    })

    it('turns an unparseable level into null, never NaN', () => {
      const values = publish(
        syntheticJson('noaa-scales.hostile-out-of-range.json')
      )
      expect(values.get('observations.24_hours_maximums.G')).toBeNull()
      expect(values.get('forecast.1day.S.probability')).toBeNull()
    })
  })

  describe('a read that landed mid-rewrite', () => {
    it('recovers the complete leading value when a stale tail follows it', () => {
      // NOAA rewrites these files in place, so a shorter new payload leaves
      // the tail of the longer old one behind. The leading value is whole and
      // is the one to publish.
      const torn = synthetic(SYNTHETIC_TORN_FIXTURE)
      expect(() => JSON.parse(torn)).toThrow()

      const parsed = JSON.parse(firstJsonValue(torn) as string)
      expect(parsed['-1']['G']['Scale']).toBe('1')
      expect(parsed['-1']['R']['Scale']).toBe('2')
      // Nothing from the tail may survive. It is the only part of the file
      // dated 2026-07-31, so that string appearing anywhere in the recovered
      // value means a leak the missing key alone would not catch.
      expect(parsed['1']).toBeUndefined()
      expect(JSON.stringify(parsed)).not.toContain('2026-07-31')
    })

    it('refuses to recover a value that is merely truncated', () => {
      // There is no complete value here, and publishing half a payload as
      // though it were whole is worse than skipping the poll. See CLAUDE.md.
      const truncated = synthetic(SYNTHETIC_TRUNCATED_FIXTURE)
      expect(() => JSON.parse(truncated)).toThrow()
      expect(firstJsonValue(truncated)).toBeNull()
    })
  })

  describe('flares', () => {
    it('reads a current class above B, which no real fixture has', () => {
      expect(
        parseXrayFlare(syntheticJson('xray-flares-latest.x-class-peaked.json'))
          ?.flareClass
      ).toBe('M2.1')
    })

    it('holds a decayed flare and a rising one, which differ only in max', () => {
      // No parser reads `max_class` yet, so this asserts the pair's shape
      // rather than any behaviour: a fix for #122 needs a payload where
      // current and max disagree, and the one real capture has none.
      const peaked = syntheticJson('xray-flares-latest.x-class-peaked.json')
      expect(peaked[0].current_class).not.toBe(peaked[0].max_class)
      const rising = syntheticJson('xray-flares-latest.x-class-rising.json')
      expect(rising[0].current_class).toBe(rising[0].max_class)
      expect(parseXrayFlare(rising)?.flareClass).toBe('X2.4')
    })

    it('returns null for an empty feed rather than throwing', () => {
      expect(
        parseXrayFlare(syntheticJson('xray-flares-latest.hostile-empty.json'))
      ).toBeNull()
    })

    it('returns null when the classes are null', () => {
      expect(
        parseXrayFlare(syntheticJson('xray-flares-latest.hostile-nulls.json'))
      ).toBeNull()
    })
  })

  describe('text bulletins', () => {
    it('states quiet positively rather than going silent', () => {
      // The whole quiet-day argument for a cross-source check rests on this:
      // WWV makes a claim about the last 24 hours every day, so 0 is checked
      // against a statement rather than against an absence.
      const quiet = synthetic('wwv.no-storms.txt')
      expect(quiet).toMatch(/No space weather storms were observed/)
      expect(quiet).not.toMatch(/reaching the/)
    })

    it('carries all three storm sentences at once', () => {
      const stormy = synthetic('wwv.all-three-storms.txt')
      expect(stormy).toMatch(/Geomagnetic storms reaching the G5 level/)
      expect(stormy).toMatch(/Solar radiation storms reaching the S3 level/)
      expect(stormy).toMatch(/Radio blackouts reaching the R3 level/)
    })

    it('carries a DRAP warning and a recovery time, which no capture does', () => {
      const warned = synthetic('drap-global-frequencies.warning-in-force.txt')
      expect(warned).toMatch(/X-RAY Warning : X-ray Warning in effect/)
      expect(warned).toMatch(/Estimated Recovery Time : 2026-06-15 18:20 UTC/)
      // Still a parseable DRAP table, not just a header: the grid has to
      // survive the header change or the fixture proves nothing.
      expect(warned).toMatch(/^ 89 \|/m)
    })
  })
})
