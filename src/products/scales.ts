// https://services.swpc.noaa.gov/products/noaa-scales.json
import { Settings } from '../config.js'
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
  transformJsonScaleRange,
  zoneMethods,
  zonesForScale
} from '../parse.js'
import { Meta } from '../publisher.js'
import { Product } from './types.js'

const PROBABILITY_META = { units: 'ratio', timeout: 60 * 60 * 4 }

export const scales: Product = {
  name: 'Scales',
  intervalMinutes: (settings) => settings.observationsInterval,

  metadata(settings: Settings): Meta[] {
    const methods = zoneMethods(
      settings.notificationVisual,
      settings.notificationSound
    )
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
              zones: zonesForScale(letter, settings.zoneAlertThreshold)
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
        displayName: 'X-ray flare class',
        description:
          'GOES X-ray classification of the most recent flare (e.g. "M2.1")' +
          ' -- the same measurement the R scale buckets into 0-5, at the' +
          ' resolution HF operators actually use.',
        timeout: 60 * 60 * 4
      }
    })
    return metas
  },

  async refresh({ client, publisher, stopped }) {
    const json = await client.json('/products/noaa-scales.json', 'Scales')
    if (stopped()) return

    // Best-effort: a failure here must never block the primary scales
    // publish below, and NOAA has no JSON form of this beyond the
    // single-event array already handled by parseXrayFlare.
    try {
      const flareJson = await client.json(
        '/json/goes/primary/xray-flares-latest.json',
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
