// https://services.swpc.noaa.gov/products/noaa-scales.json
import type { Settings } from '../config.js'
import {
  NOAA_SCALE_RANGES,
  SCALES_BASE,
  SCALE_DESCRIPTIONS,
  SCALE_LETTERS,
  XRAY_FLARE_BASE
} from '../paths.js'
import {
  NoaaScaleValues,
  ValueUpdate,
  parseXrayFlare,
  parseXrayFlarePeak,
  transformJsonScaleRange,
  zoneMethods,
  zonesForScale
} from '../parse.js'
import type { Meta } from '../publisher.js'
import { Product } from './types.js'
import { SCALES, XRAY_FLARE_LATEST, XRAY_FLARES_7_DAY } from '../endpoints.js'

const PROBABILITY_META = { units: 'ratio', timeout: 60 * 60 * 4 }

export const scales: Product = {
  name: 'Scales',
  endpoints: [SCALES, XRAY_FLARE_LATEST, XRAY_FLARES_7_DAY],
  intervalMinutes: (settings) => settings.updateInterval,

  metadata(settings: Settings): Meta[] {
    const methods = zoneMethods()
    const metas: Meta[] = []

    for (const range of NOAA_SCALE_RANGES) {
      const base = SCALES_BASE + range.subPath
      for (const letter of SCALE_LETTERS) {
        // Forecast S and R carry probabilities rather than a level.
        if (letter === 'G' || range.isObservation) {
          metas.push({
            path: `${base}.${letter}`,
            value: {
              ...methods,
              displayName: `${SCALE_DESCRIPTIONS[letter]} (${letter})`,
              description: `${range.label} for ${SCALE_DESCRIPTIONS[
                letter
              ].toLowerCase()}s`,
              // No `units`: a scale value is a dimensionless index and the
              // admin UI renders the units string verbatim.
              timeout: 60 * 60 * 4,
              displayScale: {
                lower: NoaaScaleValues.NONE,
                upper: NoaaScaleValues.EXTREME,
                type: 'linear'
              },
              zones: zonesForScale(
                letter,
                settings.alarmLevel,
                settings.popupLevel,
                settings.listLevel
              )
            }
          })
        } else if (letter === 'S') {
          metas.push({
            path: `${base}.S.probability`,
            value: {
              ...PROBABILITY_META,
              displayName: 'S1 or greater probability',
              description: `${range.label} probability of an S1 or greater solar radiation storm`
            }
          })
        } else {
          metas.push({
            path: `${base}.R.minorProbability`,
            value: {
              ...PROBABILITY_META,
              displayName: 'R1-R2 probability',
              description: `${range.label} probability of an R1-R2 radio blackout`
            }
          })
          metas.push({
            path: `${base}.R.majorProbability`,
            value: {
              ...PROBABILITY_META,
              displayName: 'R3 or greater probability',
              description: `${range.label} probability of an R3 or greater radio blackout`
            }
          })
        }
      }
    }
    metas.push({
      path: `${XRAY_FLARE_BASE}.class`,
      value: {
        displayName: 'Latest X-ray flare class',
        description:
          'GOES X-ray classification of the most recent flare at its own' +
          ' peak (e.g. "M2.1") -- the same measurement the R scale buckets' +
          ' into 0-5, at the resolution HF operators actually use.',
        // No `units`: a flare class is a string, and one that looked like a
        // number with a unit would be rendered "M2.1 none" by the admin UI.
        timeout: 60 * 60 * 4
      }
    })
    metas.push({
      path: `${XRAY_FLARE_BASE}.max24h.class`,
      value: {
        displayName: 'Strongest X-ray flare, past 24 hours',
        description:
          'GOES X-ray classification of the strongest flare to peak in the' +
          ' last 24 hours. The finer-grained reading of the same day the R' +
          " scale's 24-hour maximum describes.",
        timeout: 60 * 60 * 4
      }
    })
    return metas
  },

  async refresh({ client, publisher, stopped }) {
    const json = await client.json(SCALES, 'Scales')
    if (stopped()) return

    // Best-effort: a failure here must never block the primary scales
    // publish below.
    //
    // Two endpoints and two values, which is what issue #122 resolved to.
    // `-latest` carries one event and answers "is anything happening now";
    // `-7-day` carries a week of them and answers "what did today do", which
    // is the question the R scale's own 24-hour maximum answers one decimal
    // place coarser. Each is stamped with its own peak time rather than with
    // the poll, so a surface reading one of them gets that flare's clock.
    try {
      const flareJson = await client.json(
        XRAY_FLARE_LATEST,
        'X-ray flare class'
      )
      const flare = parseXrayFlare(flareJson)
      if (flare) {
        publisher.values(
          [{ path: `${XRAY_FLARE_BASE}.class`, value: flare.flareClass }],
          flare.time
        )
      }
    } catch (err) {
      publisher.error(`Failed to fetch X-ray flare class: ${err}`)
    }
    if (stopped()) return

    try {
      const weekJson = await client.json(
        XRAY_FLARES_7_DAY,
        'X-ray flare 24-hour peak'
      )
      const peak = parseXrayFlarePeak(weekJson, new Date())
      // A quiet 24 hours publishes nothing rather than a zero or an empty
      // string: "no flare peaked" is the honest answer and the leaf's own
      // `timeout` is what tells a reader the value has aged out of its
      // window. Inventing a level here would be a number nobody measured.
      if (peak) {
        publisher.values(
          [
            {
              path: `${XRAY_FLARE_BASE}.max24h.class`,
              value: peak.flareClass
            }
          ],
          peak.time
        )
      }
    } catch (err) {
      publisher.error(`Failed to fetch the 24-hour X-ray flare peak: ${err}`)
    }
    if (stopped()) return

    const values: ValueUpdate[] = []
    for (const range of NOAA_SCALE_RANGES) {
      const entry = json?.[range.jsonIndex]
      if (!entry) {
        publisher.error(
          "Json contains no scale entry for index '%s' (%s)",
          range.jsonIndex,
          range.subPath
        )
        continue
      }
      values.push(
        ...transformJsonScaleRange(
          entry,
          SCALES_BASE + range.subPath,
          range.isObservation
        )
      )
    }
    if (values.length === 0) return

    const latest = values.find(
      (v) => v.path === SCALES_BASE + 'observations.latest.time'
    )
    publisher.values(values, latest ? latest.value : new Date().toISOString())
  }
}
