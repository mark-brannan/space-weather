/**
 * https://services.swpc.noaa.gov/text/27-day-outlook.txt
 *
 * Every other forecast here stops at 72 hours. This one runs a full solar
 * rotation at one row per UTC day, which is the only thing in the plugin that
 * answers "is next week likely to be disturbed" -- the question a passage plan
 * actually asks.
 *
 * It buys that horizon by being a *recurrence* forecast: 27 days is the
 * rotation period, so the outlook is largely the last rotation repeated on the
 * assumption the same coronal holes come back around. Lower skill than the
 * 3-day products, and a daily maximum rather than a 3-hourly value. So nothing
 * here carries `zones` and nothing raises a notification -- a G1 day turns up
 * in the window roughly monthly, and alarming on that would dilute the 3-day
 * alerts that are worth interrupting for. This is data to look at, not to be
 * woken by.
 *
 * Issued weekly, not daily: the table is part of NOAA's Weekly Highlights and
 * Forecasts bulletin and carries that bulletin's issue timestamp. So it takes
 * a fixed cadence rather than `updateInterval` -- polling faster than the data
 * moves is bandwidth for nothing, and a dial for it is a knob nobody would
 * ever have cause to turn. See docs/noaa-products.md for the observed day and
 * time, and for how far that has actually been checked.
 */
import { OUTLOOK27_BASE } from '../paths.js'
import { NoaaScaleValues, parse27DayOutlook } from '../parse.js'
import type { Meta } from '../publisher.js'
import { Product } from './types.js'
import { OUTLOOK_27_DAY } from '../endpoints.js'

/**
 * Once a day against a weekly issue, which is deliberately unsynchronised
 * with it. Chasing the issue time -- sleeping until just before it, then
 * polling tightly, the way `advisory` does -- would cost about four times the
 * bytes to buy same-morning pickup of a product whose value is entirely at
 * the far end of its window. A day late means holding the previous issue for
 * one day in seven, and consecutive issues overlap by 20 of their 27 days.
 * Where staleness would actually matter is the next 72 hours, and `kp` and
 * `scales` already cover that at far higher resolution and skill.
 */
const INTERVAL_MINUTES = 1440

/**
 * Well past the reissue interval. A stale outlook is still the best available
 * answer for most of the window it covers -- the far end of it barely moves
 * between issues -- so this is deliberately looser than the six hours the
 * real-time products use.
 */
const TIMEOUT_SECONDS = 60 * 60 * 36

export const outlook27: Product = {
  name: '27-day Outlook',
  endpoints: [OUTLOOK_27_DAY],
  intervalMinutes: () => INTERVAL_MINUTES,

  metadata(): Meta[] {
    // Kp is dimensionless, so no `units` -- and no `zones` either, on any
    // path here; see the note at the top of the file.
    const kpScale = { displayScale: { lower: 0, upper: 9, type: 'linear' } }
    const recurrence =
      ' Recurrence forecast at daily resolution -- lower confidence than the' +
      ' 3-day Kp forecast, and a whole-day maximum rather than a time.'

    return [
      {
        path: `${OUTLOOK27_BASE}.maxKp`,
        value: {
          ...kpScale,
          timeout: TIMEOUT_SECONDS,
          displayName: 'Peak Kp (27-day outlook)',
          shortName: 'Kp 27d',
          description:
            'Highest daily-maximum planetary K-index in the 27-day outlook.' +
            recurrence
        }
      },
      {
        path: `${OUTLOOK27_BASE}.maxKpTime`,
        value: {
          timeout: TIMEOUT_SECONDS,
          displayName: 'Peak Kp day (27-day outlook)',
          description:
            'Start of the first UTC day in the 27-day outlook reaching the' +
            ' peak forecast K-index.'
        }
      },
      {
        path: `${OUTLOOK27_BASE}.maxNoaaScale`,
        value: {
          timeout: TIMEOUT_SECONDS,
          displayName: 'Peak G scale (27-day outlook)',
          description:
            'NOAA G scale value for the peak K-index in the 27-day outlook.' +
            recurrence,
          displayScale: {
            lower: NoaaScaleValues.NONE,
            upper: NoaaScaleValues.EXTREME,
            type: 'linear'
          }
        }
      },
      {
        path: `${OUTLOOK27_BASE}.nextStormTime`,
        value: {
          timeout: TIMEOUT_SECONDS,
          displayName: 'Next outlook storm day',
          description:
            'Start of the first UTC day in the 27-day outlook forecast to' +
            ' reach Kp 5 (G1), if any.'
        }
      },
      {
        path: `${OUTLOOK27_BASE}.nextStormKp`,
        value: {
          ...kpScale,
          timeout: TIMEOUT_SECONDS,
          displayName: 'Next outlook storm Kp',
          description:
            'Planetary K-index forecast for the next storm day in the 27-day' +
            ' outlook.'
        }
      },
      {
        path: `${OUTLOOK27_BASE}.series`,
        value: {
          timeout: TIMEOUT_SECONDS,
          displayName: '27-day outlook',
          description:
            'One entry per UTC day for a full solar rotation, as an array of' +
            ' {time, f107, aIndex, kp}: 10.7cm radio flux in sfu, planetary A' +
            ' index, and the largest K-index expected that day. Not a scalar' +
            ' path -- intended for drawing a timeline rather than a gauge.' +
            recurrence
        }
      }
    ]
  },

  async refresh({ client, publisher, stopped }) {
    const text = await client.text(OUTLOOK_27_DAY, '27-day Outlook')
    if (stopped()) return

    const outlook = parse27DayOutlook(text)
    if (!outlook) {
      publisher.error('The 27-day outlook contained no usable rows')
      return
    }

    if (outlook.rejected > 0) {
      // NOAA has shipped a corrupt column and corrected it by reissuing (see
      // parse.ts). Dropping it silently would leave a hole in the series that
      // reads exactly like a column NOAA never sent.
      publisher.error(
        `The 27-day outlook carried ${outlook.rejected} implausible ` +
          'value(s); those columns were dropped'
      )
    }

    publisher.debug(
      '27-day outlook days=%s maxKp=%s on %s nextStorm=%s',
      outlook.days.length,
      outlook.maxKp,
      outlook.maxKpTime,
      outlook.nextStormTime
    )

    publisher.values(
      [
        { path: `${OUTLOOK27_BASE}.maxKp`, value: outlook.maxKp },
        { path: `${OUTLOOK27_BASE}.maxKpTime`, value: outlook.maxKpTime },
        {
          path: `${OUTLOOK27_BASE}.maxNoaaScale`,
          value: outlook.maxNoaaScale
        },
        {
          path: `${OUTLOOK27_BASE}.nextStormTime`,
          value: outlook.nextStormTime
        },
        { path: `${OUTLOOK27_BASE}.nextStormKp`, value: outlook.nextStormKp },
        { path: `${OUTLOOK27_BASE}.series`, value: outlook.days }
      ],
      (outlook.issued ?? new Date()).toISOString()
    )
  }
}
