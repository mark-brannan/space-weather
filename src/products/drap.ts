/**
 * https://services.swpc.noaa.gov/text/drap_global_frequencies.txt
 *
 * NOAA's D-RAP model as a global grid of the highest frequency currently
 * degraded by >=1dB (the "band is dead" threshold). A global grid is not
 * useful on a boat, so this publishes a single number: the value at the
 * vessel's own position -- the same treatment aurora.ts gives OVATION, for
 * the same reason. The map overlay the issue also proposes is a separate,
 * much larger piece of work (a second tile layer) and is not part of this.
 */
import { DRAP_BASE } from '../paths.js'
import { drapFrequencyAt, parseDrapGrid } from '../parse.js'
import { Meta } from '../publisher.js'
import { vesselPosition } from './aurora.js'
import { Product } from './types.js'

const MHZ_TO_HZ = 1e6

export const drap: Product = {
  name: 'D-RAP',
  intervalMinutes: (settings) => settings.updateInterval,

  metadata(): Meta[] {
    return [
      {
        path: `${DRAP_BASE}.highest_affected_frequency`,
        value: {
          displayName: 'D-RAP highest affected frequency',
          shortName: 'D-RAP',
          description:
            'Highest HF frequency degraded by 1dB or more of D-region' +
            " absorption at the vessel's position, from NOAA's D-RAP model." +
            ' A value of 0 means no degradation is predicted here.',
          units: 'Hz',
          timeout: 60 * 60
        }
      },
      {
        path: `${DRAP_BASE}.validTime`,
        value: {
          displayName: 'D-RAP valid time',
          description:
            'Time the D-RAP grid this reading came from is valid for',
          timeout: 60 * 60
        }
      }
    ]
  },

  async refresh({ client, publisher, stopped }) {
    // Check for a position before spending a fetch on a grid we cannot index
    // into -- the same reasoning aurora.ts uses.
    const position = vesselPosition(publisher)
    if (!position) {
      publisher.debug('No vessel position yet; deferring the D-RAP fetch')
      return 'not-ready'
    }

    const text = await client.text('/text/drap_global_frequencies.txt', 'D-RAP')
    if (stopped()) return

    const grid = parseDrapGrid(text)
    if (!grid) {
      publisher.error('D-RAP payload contained no usable grid')
      return
    }

    const frequencyMHz = drapFrequencyAt(
      grid,
      position.latitude,
      position.longitude
    )
    if (frequencyMHz === null) {
      publisher.error(
        'Could not resolve a D-RAP frequency for position %j',
        position
      )
      return
    }

    // A boat sitting in one spot commonly reads the same grid cell across
    // several polls even while the wider grid keeps moving (the grid itself
    // changes fast -- docs/noaa-products.md -- but one cell need not).
    // Skip the republish rather than re-broadcasting an unmoved reading to
    // every connected client, the same rule aIndex.ts and sunspot.ts apply.
    const frequencyHz = frequencyMHz * MHZ_TO_HZ
    const publishedFrequency = publisher.selfPath(
      `${DRAP_BASE}.highest_affected_frequency.value`
    )
    const publishedValidTime = publisher.selfPath(
      `${DRAP_BASE}.validTime.value`
    )
    if (
      publishedFrequency === frequencyHz &&
      publishedValidTime === grid.validTime
    ) {
      return
    }

    publisher.debug(
      'D-RAP %s MHz at %s, %s',
      frequencyMHz,
      position.latitude,
      position.longitude
    )

    publisher.values(
      [
        { path: `${DRAP_BASE}.highest_affected_frequency`, value: frequencyHz },
        { path: `${DRAP_BASE}.validTime`, value: grid.validTime }
      ],
      grid.validTime
    )
  }
}
