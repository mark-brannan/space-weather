// https://services.swpc.noaa.gov/text/advisory-outlook.txt
import { notificationMethod } from '../config.js'
import { ADVISORY_BASE } from '../paths.js'
import { NotificationStates, parseAdvisoryOutlook } from '../parse.js'
import { Meta } from '../publisher.js'
import { Product } from './types.js'

const ID_PREFIX = 'space_weather_advisory_outlook'

export const advisory: Product = {
  name: 'Advisory Outlook',
  schedule: 'notifications',
  enabled: (settings) => settings.sendAdvisoryOutlook,

  metadata(): Meta[] {
    return [
      {
        path: ADVISORY_BASE,
        value: {
          name: 'NOAA Space Weather Advisory Outlook',
          description:
            'Issued every Monday, the Advisory provides general descriptions' +
            ' of space weather conditions during the past week and an outlook for the next 7 days.' +
            ' Outlooks are based on the NOAA Space Weather Scales.',
          timeout: 60 * 60 * 24 * 7
        }
      }
    ]
  },

  async refresh({ client, publisher, settings, stopped }) {
    const text = await client.text('/text/advisory-outlook.txt', 'Advisory Outlook')
    if (stopped()) return

    const outlook = parseAdvisoryOutlook(text)
    if (!outlook) {
      publisher.error('Failed to parse the advisory outlook text product')
      return
    }

    const { idLine, shortId, issued } = outlook
    const path = `${ADVISORY_BASE}.${shortId}`
    const existing = publisher.selfPath(`${path}.value`)
    const id = ID_PREFIX + shortId

    const current = {
      id,
      issued: issued.toISOString(),
      message: `${idLine} for ${issued.toDateString()}`,
      description: text,
      state: NotificationStates.ALERT,
      method: notificationMethod(settings)
    }
    publisher.value(path, current, issued.toISOString())

    if (!existing || existing.state === NotificationStates.NORMAL) {
      publisher.debug('Sending %s: %s', id, current.message)
    }

    // Clear any advisory from a previous week that is still raised.
    const previous = publisher.selfPath(ADVISORY_BASE)
    if (!previous) return
    for (const entry of Object.values(previous) as any[]) {
      if (!entry?.value?.id) continue
      if (
        entry.value.id === current.id ||
        entry.value.state === NotificationStates.NORMAL
      ) {
        continue
      }
      const staleShortId = entry.value.id.slice(ID_PREFIX.length)
      publisher.debug('Clearing ' + entry.value.id)
      publisher.value(
        `${ADVISORY_BASE}.${staleShortId}`,
        { ...entry.value, state: NotificationStates.NORMAL },
        issued.toISOString()
      )
    }
  }
}
