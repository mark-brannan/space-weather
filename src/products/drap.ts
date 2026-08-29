/**
 * https://services.swpc.noaa.gov/text/drap_global_frequencies.txt
 *
 * NOAA's D-RAP model as a global grid of the highest frequency currently
 * degraded by >=1dB (the "band is dead" threshold). A global grid is not
 * useful on a boat, so this publishes a single number: the value at the
 * vessel's own position -- the same treatment aurora.ts gives OVATION, for
 * the same reason.
 *
 * And like aurora, the fetch itself does not wait for a position. One grid
 * covers the whole globe, so the payload is identical wherever the boat is;
 * it is cached parsed (src/cache/drapCache.ts) and the point value is
 * published out of the cache, either straight away or when a fix arrives.
 */
import { DRAP_BASE } from '../paths.js'
import { readDrapCache, writeDrapCache } from '../cache/drapCache.js'
import {
  DrapGrid,
  drapFrequencyAt,
  parseDrapGrid,
  zoneMethods,
  zonesForDrap
} from '../parse.js'
import type { Meta, Publisher } from '../publisher.js'
import { vesselPosition } from './aurora.js'
import { Product } from './types.js'
import { DRAP } from '../endpoints.js'

const MHZ_TO_HZ = 1e6

export const drap: Product = {
  name: 'D-RAP',
  endpoints: [DRAP],
  intervalMinutes: (settings) => settings.drapInterval,
  enabled: (settings) => settings.drapEnabled,

  metadata(): Meta[] {
    return [
      {
        path: `${DRAP_BASE}.highest_affected_frequency`,
        value: {
          ...zoneMethods(),
          displayName: 'D-RAP highest affected frequency',
          shortName: 'D-RAP',
          description:
            'Highest HF frequency degraded by 1dB or more of D-region' +
            " absorption at the vessel's position, from NOAA's D-RAP model." +
            ' A value of 0 means no degradation is predicted here.',
          units: 'Hz',
          timeout: 60 * 60,
          // Published even though the webapp draws the band strip from the
          // raw number instead: a zone ladder on a path is what Freeboard,
          // Grafana, another plugin or a script reads, none of which have
          // this plugin's tile. zonesForDrap carries why it buckets by band
          // and why it stays quiet.
          zones: zonesForDrap()
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
    const text = await client.text(DRAP, 'D-RAP')
    if (stopped()) return

    const grid = parseDrapGrid(text)
    if (!grid) {
      publisher.error('D-RAP payload contained no usable grid')
      return
    }

    // Best effort, same as aurora's: a disk write failing here should not stop
    // the value below from publishing.
    try {
      writeDrapCache(publisher, grid)
    } catch (err) {
      publisher.error(`Failed to cache the D-RAP grid: ${err}`)
    }

    return publishFrequency(publisher, grid) ? undefined : 'awaiting-position'
  },

  publishFromCache({ publisher }) {
    const cached = readDrapCache(publisher)
    if (!cached) return true
    return publishFrequency(publisher, cached.grid)
  }
}

/**
 * The absorption cutoff at the vessel's position, from an already-fetched
 * grid. False only when there is no position to index with, which is the one
 * state worth being asked about again.
 */
function publishFrequency(publisher: Publisher, grid: DrapGrid): boolean {
  const position = vesselPosition(publisher)
  if (!position) {
    publisher.debug('No vessel position yet; holding the D-RAP frequency')
    return false
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
    return true
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
  const publishedValidTime = publisher.selfPath(`${DRAP_BASE}.validTime.value`)
  if (
    publishedFrequency === frequencyHz &&
    publishedValidTime === grid.validTime
  ) {
    return true
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
  return true
}
