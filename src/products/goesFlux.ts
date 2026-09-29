/**
 * https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json
 * https://services.swpc.noaa.gov/json/goes/primary/integral-protons-6-hour.json
 *
 * `-6-hour` over `-1-day`/`-3-day`: docs/noaa-products.md measured the wider
 * windows at 4x/12x the bytes for the same latest value this product
 * publishes -- see "GOES X-ray and proton flux time series (#83)".
 */
import { PROTON_FLUX_BASE, XRAY_FLUX_BASE } from '../paths.js'
import {
  FluxPoint,
  ValueUpdate,
  coarsenFluxSeries,
  mergeFluxSeries,
  parseGoesFlux,
  parseGoesFluxSeries,
  xrayFluxTrend
} from '../parse.js'
import type { Meta, Publisher } from '../publisher.js'
import { Product } from './types.js'
import { GOES_PROTONS_6_HOUR, GOES_XRAYS_6_HOUR } from '../endpoints.js'
import {
  readGoesFluxCache,
  writeGoesFluxCache
} from '../cache/goesFluxCache.js'

/**
 * The buckets the flux history is drawn at, and how much of it is kept.
 *
 * Fifteen minutes over the newest day, because that day is the observed
 * stretch of the Kp chart's 72-hour span -- a few hundred pixels for 96 hours,
 * so a 1-per-minute trace there is several samples per pixel, all of it paid
 * for in delta traffic to every connected client on every poll. Three hours
 * behind that, back to three days, because that is as far as the observed Kp
 * on the same axis reaches, and three hours is the Kp bin it is drawn in.
 * Not a rotation: the 27-day outlook repeats coronal-hole geomagnetic
 * activity, which neither of these channels measures, and a month of
 * history is delta traffic a Pi on battery pays for an answer nobody asked
 * (Solace, 2026-09-27). Each bucket is its window's maximum, so coarsening
 * keeps every flare's peak and loses only when inside the three hours it
 * came.
 */
const SERIES_BUCKET_MS = 15 * 60 * 1000
const SERIES_FINE_MS = 24 * 60 * 60 * 1000
const SERIES_COARSE_BUCKET_MS = 3 * 60 * 60 * 1000
const SERIES_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

type Held = { xray: FluxPoint[]; proton: FluxPoint[] }

/**
 * What the plugin has seen, which is the only history there is --
 * `publisher.ts` writes values, never a series, and the `-6-hour` endpoint the
 * poll already pays for carries a fraction of the window. See
 * `mergeFluxSeries`: successive six-hour payloads overlap, so the retained
 * window widens on its own and no wider endpoint has to be fetched.
 *
 * Keyed by publisher rather than held in one module variable: a publisher is
 * one server's lifetime, so its first refresh is the start the cache is read
 * back on, and two of them (tests, a second tab) never share a history.
 */
const retained = new WeakMap<Publisher, Held>()

function restore(publisher: Publisher): Held {
  let held = retained.get(publisher)
  if (held) return held
  const cached = readGoesFluxCache(publisher)
  held = { xray: cached?.xray ?? [], proton: cached?.proton ?? [] }
  retained.set(publisher, held)
  // Published before the fetch, so a restart whose first poll fails still
  // shows the history it came up with rather than nothing until the next.
  const values: ValueUpdate[] = []
  if (held.xray.length > 0)
    values.push({ path: `${XRAY_FLUX_BASE}.series`, value: held.xray })
  if (held.proton.length > 0)
    values.push({ path: `${PROTON_FLUX_BASE}.series`, value: held.proton })
  if (cached && values.length > 0) publisher.values(values, cached.fetchedAt)
  return held
}

export const goesFlux: Product = {
  name: 'GOES X-ray and Proton Flux',
  endpoints: [GOES_XRAYS_6_HOUR, GOES_PROTONS_6_HOUR],
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
        // A child of a leaf, as `.trend` is and for the same reason: it is
        // the same measurement over time, not a second one.
        path: `${XRAY_FLUX_BASE}.series`,
        value: {
          displayName: 'GOES X-ray Flux history',
          shortName: 'X-ray history',
          description:
            'Long-channel (0.1-0.8nm) X-ray flux over the last 3 days as an' +
            " array of {time, value}, each point its window's maximum: one per" +
            ' 15 minutes over the newest 24 hours, one per 3 hours before that.' +
            ' Not a scalar path -- intended for drawing a timeline rather than' +
            ' a gauge. Only as wide as the plugin has been polling.',
          units: 'W/m2',
          timeout: 60 * 60 * 6
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
      },
      {
        path: `${PROTON_FLUX_BASE}.series`,
        value: {
          displayName: 'GOES Proton Flux history',
          shortName: 'Proton history',
          description:
            'Integral proton flux, >=10 MeV channel, over the last 3 days as' +
            " an array of {time, value}, each point its window's maximum: one" +
            ' per 15 minutes over the newest 24 hours, one per 3 hours before' +
            ' that. Not a scalar path -- intended for drawing a timeline rather' +
            ' than a gauge. Only as wide as the plugin has been polling.',
          units: 'm-2.s-1.sr-1',
          timeout: 60 * 60 * 6
        }
      }
    ]
  },

  async refresh({ client, publisher, stopped }) {
    const held = restore(publisher)
    const [xrayJson, protonJson] = await Promise.all([
      client.json(GOES_XRAYS_6_HOUR, 'GOES X-ray Flux'),
      client.json(GOES_PROTONS_6_HOUR, 'GOES Proton Flux')
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

    // The history the webapp's chart draws, out of the very payloads above --
    // no second fetch, no wider window. Published outside the unchanged-value
    // skip for the same reason `.trend` is: the newest sample can repeat while
    // the window behind it rolls forward.
    const fresh = parseGoesFluxSeries(xrayJson, protonJson, SERIES_BUCKET_MS)
    let moved = false
    for (const [channel, base] of [
      ['xray', XRAY_FLUX_BASE],
      ['proton', PROTON_FLUX_BASE]
    ] as const) {
      const merged = coarsenFluxSeries(
        mergeFluxSeries(held[channel], fresh[channel], SERIES_WINDOW_MS),
        SERIES_FINE_MS,
        SERIES_COARSE_BUCKET_MS
      )
      if (merged.length === 0) continue
      // Every point, not just the newest: a merge can raise a bucket behind
      // the newest one, and a roll can drop one and add one at equal length.
      const unchanged =
        merged.length === held[channel].length &&
        merged.every(
          (point, i) =>
            point.time === held[channel][i].time &&
            point.value === held[channel][i].value
        )
      if (unchanged) continue
      held[channel] = merged
      moved = true
      values.push({ path: `${base}.series`, value: merged })
    }
    if (moved) {
      try {
        writeGoesFluxCache(publisher, held)
      } catch (err) {
        publisher.error(`Failed to cache the GOES flux history: ${err}`)
      }
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
