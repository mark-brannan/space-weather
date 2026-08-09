/**
 * https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json
 * https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json
 */
import { SOLAR_WIND_BASE } from '../paths.js'
import { ValueUpdate, parseSolarWind } from '../parse.js'
import { Meta } from '../publisher.js'
import { Product } from './types.js'

export const solarWind: Product = {
  name: 'Solar Wind Summary',
  intervalMinutes: (settings) => settings.updateInterval,

  metadata(): Meta[] {
    return [
      {
        path: `${SOLAR_WIND_BASE}.speed`,
        value: {
          displayName: 'Solar Wind Speed',
          shortName: 'SWS',
          description:
            'The solar wind speed; typical values are around 400 km/s',
          units: 'm/s',
          timeout: 60 * 60
        }
      },
      {
        path: `${SOLAR_WIND_BASE}.Bt`,
        value: {
          displayName: 'IMF strength (Bt)',
          shortName: 'Bt',
          description: 'The strength of the interplanetary magnetic field',
          units: 'T',
          timeout: 60 * 60
        }
      },
      {
        path: `${SOLAR_WIND_BASE}.Bz`,
        value: {
          displayName: 'IMF orientation (Bz)',
          shortName: 'Bz',
          description:
            'The north-south component of the interplanetary magnetic field in GSM' +
            ' coordinates. Sustained negative (southward) Bz couples the solar wind to' +
            " Earth's magnetosphere and drives geomagnetic storms.",
          units: 'T',
          timeout: 60 * 60
        }
      }
    ]
  },

  async refresh({ client, publisher, stopped }) {
    const [speedJson, magJson] = await Promise.all([
      client.json(
        '/products/summary/solar-wind-speed.json',
        'Solar Wind Speed'
      ),
      client.json(
        '/products/summary/solar-wind-mag-field.json',
        'Solar Wind Magnetic Field'
      )
    ])
    if (stopped()) return

    const wind = parseSolarWind(speedJson, magJson)
    const values: ValueUpdate[] = []
    if (wind.speed !== null)
      values.push({ path: `${SOLAR_WIND_BASE}.speed`, value: wind.speed })
    if (wind.bt !== null)
      values.push({ path: `${SOLAR_WIND_BASE}.Bt`, value: wind.bt })
    if (wind.bz !== null)
      values.push({ path: `${SOLAR_WIND_BASE}.Bz`, value: wind.bz })

    if (values.length === 0) {
      publisher.error('Solar wind payloads contained no recognised fields')
      return
    }
    publisher.debug('Solar wind values: %j', values)
    publisher.values(values, wind.timestamp ?? new Date().toISOString())
  }
}
