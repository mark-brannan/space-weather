/**
 * https://services.swpc.noaa.gov/text/wwv.txt
 *
 * The Geophysical Alert Message: the bulletin broadcast on WWV and WWVH at 18
 * minutes past each hour, and the way HF operators have read conditions for
 * decades. This publishes the one index in it the plugin did not already have
 * -- the estimated planetary A -- so that "SFI, A, K" can be answered from the
 * boat's own server; parseGeophysicalAlert says why the other two are left to
 * the products that already own them.
 *
 * Reissued every three hours, so polled at that cadence rather than given a
 * setting: the payload is among the smallest NOAA publishes (see
 * docs/noaa-products.md) and the value behind it moves once a day, so there is
 * nothing here for a dial to save.
 */
import { A_INDEX_BASE } from '../paths.js'
import { parseGeophysicalAlert } from '../parse.js'
import { Meta } from '../publisher.js'
import { Product } from './types.js'

const INTERVAL_MINUTES = 180
/**
 * A client measures `timeout` from the delta's own timestamp, and this product
 * stamps the start of the UTC day the bulletin describes rather than the hour
 * it was reissued -- eight bulletins a day carry the same daily average, and
 * dating them by issue time would claim eight readings where there is one. So
 * the last bulletin of the following day republishes a timestamp already close
 * to 48 hours old, and the next poll can be a whole interval after that.
 * Anything tighter expires a value that is perfectly current.
 */
const DELTA_TIMEOUT_SECONDS = 60 * 60 * 54

export const aIndex: Product = {
  name: 'Planetary A Index',
  intervalMinutes: () => INTERVAL_MINUTES,

  metadata(): Meta[] {
    return [
      {
        path: A_INDEX_BASE,
        value: {
          displayName: 'Planetary A Index',
          shortName: 'A index',
          description:
            'The estimated planetary A index: a daily average of geomagnetic' +
            ' activity, derived from the 3-hourly K index. Below 10 is a' +
            ' quiet field; above 30 is a disturbed one, with degraded' +
            ' high-latitude HF paths and noisy bands.',
          // Dimensionless index, so no `units`: the admin UI renders the
          // string verbatim and "20 none" is worse than no unit at all.
          timeout: DELTA_TIMEOUT_SECONDS
        }
      }
    ]
  },

  async refresh({ client, publisher, stopped }) {
    const text = await client.text('/text/wwv.txt', 'Geophysical Alert')
    if (stopped()) return

    const alert = parseGeophysicalAlert(text)
    if (!alert) {
      publisher.error('No planetary A index found in payload')
      return
    }
    // Eight bulletins a day carry one daily average, and the delta is stamped
    // with the day rather than the fetch -- so a republish of the same day is
    // the same value at the same timestamp, reaching every connected client
    // for nothing. Asked of the server rather than remembered here, the way
    // alerts and the advisory outlook do it: a restart then republishes, which
    // is the one case where the delta is not redundant.
    //
    // The day is half the comparison, not a detail. A quiet spell repeats a
    // value across days, and suppressing on the value alone would leave the
    // timestamp on the first of them until it aged past `timeout` and a client
    // nulled a reading that was still current.
    const publishedValue = publisher.selfPath(`${A_INDEX_BASE}.value`)
    const publishedDay = publisher.selfPath(`${A_INDEX_BASE}.timestamp`)
    if (publishedValue === alert.aIndex && publishedDay === alert.day) return
    publisher.value(A_INDEX_BASE, alert.aIndex, alert.day)
  }
}
