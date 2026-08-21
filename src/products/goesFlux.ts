/**
 * https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json
 * https://services.swpc.noaa.gov/json/goes/primary/integral-protons-6-hour.json
 *
 * `-6-hour` over `-1-day`/`-3-day`: docs/noaa-products.md measured the wider
 * windows at 4x/12x the bytes for the same latest value this product
 * publishes -- see "GOES X-ray and proton flux time series (#83)".
 */
import { PROTON_FLUX_BASE, XRAY_FLUX_BASE } from '../paths.js'
import { ValueUpdate, parseGoesFlux } from '../parse.js'
import { Meta } from '../publisher.js'
import { Product } from './types.js'

export const goesFlux: Product = {
  name: 'GOES X-ray and Proton Flux',
  intervalMinutes: (settings) => settings.updateInterval,

  metadata(): Meta[] {
    return [
      {
        path: XRAY_FLUX_BASE,
        value: {
          displayName: 'GOES X-ray Flux',
          shortName: 'X-ray',
          description:
            'GOES XRS long-channel (0.1-0.8nm) X-ray flux -- the measurement' +
            ' the R (radio blackout) scale and the flare class are bucketed from',
          units: 'W/m2',
          timeout: 60 * 60
        }
      },
      {
        path: PROTON_FLUX_BASE,
        value: {
          displayName: 'GOES Proton Flux',
          shortName: 'Proton',
          description:
            'GOES integral proton flux, >=10 MeV channel -- the measurement' +
            ' the S (radiation storm) scale is bucketed from. Drives polar cap' +
            ' HF absorption, which can last days.',
          units: 'm-2.s-1.sr-1',
          timeout: 60 * 60
        }
      }
    ]
  },

  async refresh({ client, publisher, stopped }) {
    const [xrayJson, protonJson] = await Promise.all([
      client.json('/json/goes/primary/xrays-6-hour.json', 'GOES X-ray Flux'),
      client.json(
        '/json/goes/primary/integral-protons-6-hour.json',
        'GOES Proton Flux'
      )
    ])
    if (stopped()) return

    const flux = parseGoesFlux(xrayJson, protonJson)
    if (flux.xrayFlux === null && flux.protonFlux === null) {
      publisher.error('GOES flux payloads contained no recognised fields')
      return
    }

    // Each channel polls on its own cadence (X-ray ~1 min, proton ~5 min),
    // so a channel that hasn't moved since the last publish is common, not
    // an edge case -- skip it rather than re-broadcasting the same reading
    // to every connected client on every poll.
    const publishedXray = publisher.selfPath(`${XRAY_FLUX_BASE}.value`)
    const publishedProton = publisher.selfPath(`${PROTON_FLUX_BASE}.value`)
    const values: ValueUpdate[] = []
    if (flux.xrayFlux !== null && flux.xrayFlux !== publishedXray)
      values.push({ path: XRAY_FLUX_BASE, value: flux.xrayFlux })
    if (flux.protonFlux !== null && flux.protonFlux !== publishedProton)
      values.push({ path: PROTON_FLUX_BASE, value: flux.protonFlux })

    if (values.length === 0) return
    publisher.debug('GOES flux values: %j', values)
    // Two independent channels on different cadences (X-ray ~1 min, proton
    // ~5 min) sharing one publish call -- the X-ray timestamp wins because
    // that channel is what's actually changing minute to minute.
    publisher.values(
      values,
      flux.xrayTimestamp ?? flux.protonTimestamp ?? new Date().toISOString()
    )
  }
}
