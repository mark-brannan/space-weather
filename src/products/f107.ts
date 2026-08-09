/**
 * https://services.swpc.noaa.gov/json/f107_cm_flux.json
 *
 * Daily solar radio flux at 10.7cm -- a slow-moving, whole-solar-cycle
 * activity index (correlates with sunspot number / solar UV-EUV output),
 * not a live HF-usability number the way the R scale or X-ray flare class
 * are. A high reading means the Sun is in a generally active phase this
 * month, not that HF propagation is good or bad right now.
 *
 * The underlying data only changes once a day (the "Noon" reading), so this
 * deliberately does not use `updateInterval`: giving it its own
 * settings dial would be one more knob nobody needs to touch for a number
 * that moves this slowly. Hard-coded well below daily is already far more
 * often than the data itself changes; if NOAA is late publishing, the last
 * good reading just stays up a little longer, same as every other product
 * here between polls -- no retry logic, nothing to explain.
 */
import { F107_BASE } from '../paths.js'
import { parseF107 } from '../parse.js'
import { Meta } from '../publisher.js'
import { Product } from './types.js'

const INTERVAL_MINUTES = 240 // four times a day

export const f107: Product = {
  name: 'F10.7 Solar Flux',
  intervalMinutes: () => INTERVAL_MINUTES,

  metadata(): Meta[] {
    return [
      {
        path: F107_BASE,
        value: {
          displayName: '10.7cm Solar Radio Flux',
          shortName: 'F10.7',
          description:
            "The Sun's radio emission at 10.7cm wavelength, measured daily" +
            ' at local noon. Tracks solar-cycle-scale activity, not' +
            ' real-time conditions.',
          // Deliberately no `units`: this is a real physical unit (solar
          // flux units, 1 sfu = 1e-22 W/m^2/Hz) rather than a dimensionless
          // index like Kp/G/S/R, so it doesn't fit either of this plugin's
          // existing conventions cleanly. Converting to W/m^2/Hz would be
          // technically SI but not a unit anyone in this domain thinks in.
          // Publishing the raw sfu number until that's decided.
          timeout: 60 * 60 * 6
        }
      }
    ]
  },

  async refresh({ client, publisher, stopped }) {
    const json = await client.json(
      '/json/f107_cm_flux.json',
      'F10.7 Solar Flux'
    )
    if (stopped()) return

    const latest = parseF107(json)
    if (!latest) {
      publisher.error('No Noon F10.7 reading found in payload')
      return
    }
    publisher.value(F107_BASE, latest.flux, latest.time + 'Z')
  }
}
