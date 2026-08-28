/**
 * https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json
 * https://services.swpc.noaa.gov/json/goes/primary/integral-protons-6-hour.json
 *
 * `-6-hour` over `-1-day`/`-3-day`: docs/noaa-products.md measured the wider
 * windows at 4x/12x the bytes for the same latest value this product
 * publishes -- see "GOES X-ray and proton flux time series (#83)".
 */
import { PROTON_FLUX_BASE, XRAY_FLUX_BASE } from '../paths.js'
import { ValueUpdate, parseGoesFlux, xrayFluxTrend } from '../parse.js'
import { Meta } from '../publisher.js'
import { Product } from './types.js'

export const goesFlux: Product = {
  name: 'GOES X-ray and Proton Flux',
  intervalMinutes: (settings) => settings.goesFluxInterval,
  enabled: (settings) => settings.goesFluxEnabled,

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
        // A child of a leaf, which is unusual here and deliberate: the ratio
        // is derived from the same series `xray_flux` samples, so hanging it
        // anywhere else would invite reading the two as independent
        // measurements. The full model tolerates a node that carries both a
        // value and children, and a client that only ever reads `.value` sees
        // no change.
        path: `${XRAY_FLUX_BASE}.trend`,
        value: {
          displayName: 'GOES X-ray Flux trend',
          shortName: 'X-ray trend',
          description:
            'X-ray flux now divided by the flux around 30 minutes ago,' +
            ' as the median of two adjacent 15-minute windows. Above 1 the' +
            ' D-region absorption floor is rising and HF is getting worse;' +
            ' below 1 a blackout is clearing. Says nothing about the F2' +
            ' ceiling -- the X-ray channel acts on the D region only.',
          // `'ratio'` despite being unbounded above 1. Signal K's own
          // vocabulary defines it as "relative value compared to reference or
          // normal value", and its keys carrying it are not all 0-1:
          // `propulsion.*.transmission.gearRatio` and `alternators.*.pulleyRatio`
          // are open-ended quotients of two same-dimension quantities, which is
          // exactly this. The 0-1 cases in this plugin are a property of
          // probabilities, not of the units string. Its `display` is the empty
          // string, so this does not reintroduce the `units: 'none'` problem
          // that keeps Kp and G/S/R unitless.
          units: 'ratio',
          timeout: 60 * 60
          // No `zones`, deliberately. A rate is not a condition: a ratio of 3
          // is alarming from an M-class floor and meaningless from a B-class
          // one, so the same number would have to mean two different things.
          // The R scale already carries a zone ladder for the level itself.
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
          // No `zones` on either flux path, deliberately, and for the reason
          // A_INDEX_BASE has none: the S and R scale paths already carry a
          // ladder over the same two measurements, built from the user's own
          // alarm thresholds. A second ladder here would raise a second
          // notification for one condition, and the two would disagree the
          // moment those thresholds moved.
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

    // Derived from the same ~700-record payload the reading above comes
    // from, so the direction of the floor costs no second fetch. Published
    // outside the unchanged-value skip: the newest sample can repeat while
    // the window behind it rolls forward, which moves the ratio.
    const trend = xrayFluxTrend(xrayJson)
    if (trend) {
      const publishedTrend = publisher.selfPath(`${XRAY_FLUX_BASE}.trend.value`)
      if (publishedTrend !== trend.ratio)
        values.push({ path: `${XRAY_FLUX_BASE}.trend`, value: trend.ratio })
    }

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
