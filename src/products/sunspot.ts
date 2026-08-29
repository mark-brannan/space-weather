/**
 * https://services.swpc.noaa.gov/text/daily-solar-indices.txt
 *
 * The SESC sunspot number, the fourth term of the phrase HF operators read
 * conditions in and the only one of them that speaks to the solar cycle
 * rather than to today: whether the high bands are open at all this month.
 *
 * The daily observed number rather than the monthly smoothed one. Smoothed
 * SSN is the truer cycle-context figure, but SWPC only publishes it inside a
 * record running back to 1749, and buying the whole record every poll for one
 * current number costs orders of magnitude more on the wire than this table
 * does (docs/noaa-products.md carries both). Daily answers the same question
 * -- are the high bands open this month -- at a price a metered link can pay.
 *
 * One row a day, so polled on f107's argument and at its cadence: the value
 * moves slower than the poll either way, and a dial for it would be a setting
 * nobody has cause to touch.
 */
import { SUNSPOT_BASE } from '../paths.js'
import { parseDailySolarIndices } from '../parse.js'
import { Meta } from '../publisher.js'
import { Product } from './types.js'
import { SUNSPOT } from '../endpoints.js'

const INTERVAL_MINUTES = 240
/** Same reason, and the same number, as the A index product. */
const DELTA_TIMEOUT_SECONDS = 60 * 60 * 54

export const sunspot: Product = {
  name: 'Sunspot Number',
  endpoints: [SUNSPOT],
  intervalMinutes: () => INTERVAL_MINUTES,

  metadata(): Meta[] {
    return [
      {
        path: SUNSPOT_BASE,
        value: {
          displayName: 'Sunspot Number',
          shortName: 'SSN',
          description:
            'The SESC sunspot number for the most recent complete UTC day.' +
            ' Tracks where the solar cycle is, and with it whether the high' +
            ' HF bands (15, 12 and 10 metres) open at all.',
          // Dimensionless count, so no `units`; see the A index product.
          timeout: DELTA_TIMEOUT_SECONDS
        }
      }
    ]
  },

  async refresh({ client, publisher, stopped }) {
    const text = await client.text(SUNSPOT, 'Daily Solar Indices')
    if (stopped()) return

    const latest = parseDailySolarIndices(text)
    if (!latest) {
      publisher.error('No sunspot number found in payload')
      return
    }
    // Unchanged rows are not rebroadcast; the A index product says why, why
    // the server is asked rather than a variable here, and why the day is
    // compared alongside the value.
    const publishedValue = publisher.selfPath(`${SUNSPOT_BASE}.value`)
    const publishedDay = publisher.selfPath(`${SUNSPOT_BASE}.timestamp`)
    if (
      publishedValue === latest.sunspotNumber &&
      publishedDay === latest.day
    ) {
      return
    }
    publisher.value(SUNSPOT_BASE, latest.sunspotNumber, latest.day)
  }
}
