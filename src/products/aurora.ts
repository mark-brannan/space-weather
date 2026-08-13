/**
 * https://services.swpc.noaa.gov/json/ovation_aurora_latest.json
 *
 * NOAA's OVATION model as a global 1-degree grid of aurora probability. A
 * global grid is not useful on a boat, so this publishes a single number: the
 * probability at the vessel's own position. "Can I see it from here" is the
 * question a sailor actually has.
 */
import { AURORA_BASE } from '../paths.js'
import {
  auroraProbabilityAt,
  parseAuroraPayload,
  zonesForAurora
} from '../parse.js'
import { writeAuroraCache } from '../cache/auroraCache.js'
import { Meta, Publisher } from '../publisher.js'
import { Product } from './types.js'

interface Position {
  latitude: number
  longitude: number
}

/**
 * The server exposes the vessel position at `navigation.position.value`, but
 * has historically also handed back a bare value. Accept either rather than
 * silently publishing nothing on one of them.
 */
export function vesselPosition(publisher: Publisher): Position | null {
  const candidates = [
    publisher.selfPath('navigation.position.value'),
    publisher.selfPath('navigation.position')
  ]
  for (const candidate of candidates) {
    const node = candidate?.value ?? candidate
    if (
      node &&
      Number.isFinite(Number(node.latitude)) &&
      Number.isFinite(Number(node.longitude))
    ) {
      return {
        latitude: Number(node.latitude),
        longitude: Number(node.longitude)
      }
    }
  }
  return null
}

export const aurora: Product = {
  name: 'Aurora (OVATION)',
  intervalMinutes: (settings) => settings.auroraInterval,
  enabled: (settings) => settings.auroraEnabled,

  metadata(): Meta[] {
    return [
      {
        path: `${AURORA_BASE}.probability`,
        value: {
          displayName: 'Aurora probability',
          shortName: 'Aurora',
          description:
            "Probability of visible aurora at the vessel's position, from NOAA's" +
            ' OVATION model. Note that this is a probability of aurora being' +
            ' present, not of it being observable — darkness and cloud cover are' +
            ' not accounted for.',
          units: 'ratio',
          timeout: 60 * 60 * 2,
          displayScale: { lower: 0, upper: 1, type: 'linear' },
          zones: zonesForAurora(),
          // Aurora is an opportunity, not a hazard. Nothing here is allowed to
          // make a noise, at any probability.
          nominalMethod: [],
          normalMethod: [],
          alertMethod: [],
          warnMethod: ['visual'],
          alarmMethod: [],
          emergencyMethod: []
        }
      },
      {
        path: `${AURORA_BASE}.observationTime`,
        value: {
          displayName: 'Aurora observation time',
          description:
            'Time of the observation the OVATION forecast is based on',
          timeout: 60 * 60 * 2
        }
      },
      {
        path: `${AURORA_BASE}.forecastTime`,
        value: {
          displayName: 'Aurora forecast time',
          description: 'Time the OVATION forecast is valid for',
          timeout: 60 * 60 * 2
        }
      }
    ]
  },

  async refresh({ client, publisher, stopped }) {
    // Check for a position before spending what may be a metered satellite
    // link on the largest payload here, for a grid we cannot index into.
    const position = vesselPosition(publisher)
    if (!position) {
      // Not an error: a GPS fix can take minutes after boot, and a position
      // source plugin may not have emitted yet. Ask to be retried rather than
      // going silent until the next interval.
      publisher.debug('No vessel position yet; deferring the aurora fetch')
      return 'not-ready'
    }

    const json = await client.json('/json/ovation_aurora_latest.json', 'Aurora')
    if (stopped()) return

    const forecast = parseAuroraPayload(json)
    if (!forecast) {
      publisher.error('Aurora payload contained no usable grid')
      return
    }

    // Cache the raw grid so the webapp's map can read it back over this
    // plugin's own HTTP route instead of fetching NOAA a second time. Best
    // effort: a disk write failing here should not stop the probability
    // value below from publishing.
    try {
      writeAuroraCache(publisher.dataDirPath(), json)
    } catch (err) {
      publisher.error(`Failed to cache the aurora grid: ${err}`)
    }

    const probability = auroraProbabilityAt(
      forecast,
      position.latitude,
      position.longitude
    )
    if (probability === null) {
      publisher.error(
        'Could not resolve an aurora probability for position %j',
        position
      )
      return
    }

    publisher.debug(
      'Aurora %s%% at %s, %s',
      (probability * 100).toFixed(1),
      position.latitude,
      position.longitude
    )

    publisher.values(
      [
        { path: `${AURORA_BASE}.probability`, value: probability },
        {
          path: `${AURORA_BASE}.observationTime`,
          value: forecast.observationTime
        },
        { path: `${AURORA_BASE}.forecastTime`, value: forecast.forecastTime }
      ],
      forecast.forecastTime ?? new Date().toISOString()
    )
  }
}
