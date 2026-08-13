/**
 * https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json
 *
 * This feed is 3-hourly out to three days, versus one G value per forecast day
 * in noaa-scales.json — so it is the one that says *when*.
 */
import { Settings } from '../config.js'
import { KP_BASE } from '../paths.js'
import {
  NoaaScaleValues,
  parseKpForecast,
  zoneMethods,
  zonesForKp,
  zonesForScale
} from '../parse.js'
import { Meta } from '../publisher.js'
import { Product } from './types.js'

export const kp: Product = {
  name: 'Planetary K-index Forecast',
  intervalMinutes: (settings) => settings.updateInterval,

  metadata(settings: Settings): Meta[] {
    const methods = zoneMethods()
    const zones = zonesForKp(settings.alarmLevel, settings.popupLevel)
    // Kp is a dimensionless index, so no `units`.
    const common = {
      timeout: 60 * 60 * 6,
      displayScale: { lower: 0, upper: 9, type: 'linear' }
    }

    return [
      {
        path: `${KP_BASE}.observed`,
        value: {
          ...common,
          ...methods,
          zones,
          displayName: 'Planetary K-index',
          shortName: 'Kp',
          description:
            'Most recent observed or estimated planetary K-index. Kp 5 and above is a' +
            ' geomagnetic storm (G1 = Kp5 ... G5 = Kp9).'
        }
      },
      {
        path: `${KP_BASE}.forecast.max24h`,
        value: {
          ...common,
          ...methods,
          zones,
          displayName: 'Max forecast Kp (24h)',
          description:
            'Highest planetary K-index forecast within the next 24 hours'
        }
      },
      {
        path: `${KP_BASE}.forecast.max72h`,
        value: {
          ...common,
          ...methods,
          zones,
          displayName: 'Max forecast Kp (72h)',
          description:
            'Highest planetary K-index forecast within the next 72 hours'
        }
      },
      {
        path: `${KP_BASE}.forecast.maxNoaaScale`,
        value: {
          ...methods,
          timeout: 60 * 60 * 6,
          displayName: 'Max forecast G scale (72h)',
          description:
            'NOAA G scale value corresponding to the highest Kp forecast in the next 72 hours',
          displayScale: {
            lower: NoaaScaleValues.NONE,
            upper: NoaaScaleValues.EXTREME,
            type: 'linear'
          },
          zones: zonesForScale('G', settings.alarmLevel, settings.popupLevel)
        }
      },
      {
        path: `${KP_BASE}.forecast.nextStormTime`,
        value: {
          timeout: 60 * 60 * 6,
          displayName: 'Next forecast storm onset',
          description:
            'Timestamp of the first forecast interval reaching Kp 5 (G1) or above, if any'
        }
      },
      {
        path: `${KP_BASE}.forecast.nextStormKp`,
        value: {
          ...common,
          displayName: 'Next forecast storm Kp',
          description: 'Planetary K-index at the next forecast storm onset'
        }
      },
      {
        path: `${KP_BASE}.forecast.series`,
        value: {
          displayName: 'Kp timeline',
          description:
            '3-hourly planetary K-index from 24 hours in the past to 72 hours' +
            ' ahead, as an array of {time, kp, forecast}. Not a scalar path --' +
            ' intended for drawing a timeline rather than a gauge.',
          timeout: 60 * 60 * 6
        }
      }
    ]
  },

  async refresh({ client, publisher, stopped }) {
    const json = await client.json(
      '/products/noaa-planetary-k-index-forecast.json',
      'Planetary K-index Forecast'
    )
    if (stopped()) return

    const summary = parseKpForecast(json)
    if (summary.observed === null && summary.max72h === null) {
      publisher.error('Planetary K-index forecast contained no usable rows')
      return
    }

    publisher.debug(
      'Kp observed=%s max24h=%s max72h=%s nextStorm=%s',
      summary.observed,
      summary.max24h,
      summary.max72h,
      summary.nextStormTime
    )

    publisher.values(
      [
        { path: `${KP_BASE}.observed`, value: summary.observed },
        { path: `${KP_BASE}.forecast.max24h`, value: summary.max24h },
        { path: `${KP_BASE}.forecast.max72h`, value: summary.max72h },
        {
          path: `${KP_BASE}.forecast.maxNoaaScale`,
          value: summary.maxNoaaScale
        },
        {
          path: `${KP_BASE}.forecast.nextStormTime`,
          value: summary.nextStormTime
        },
        { path: `${KP_BASE}.forecast.nextStormKp`, value: summary.nextStormKp },
        { path: `${KP_BASE}.forecast.series`, value: summary.series }
      ],
      summary.observedTime ?? new Date().toISOString()
    )
  }
}
