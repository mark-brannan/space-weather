// https://services.swpc.noaa.gov/text/advisory-outlook.txt
import { ADVISORY_BASE } from '../paths.js'
import {
  NotificationStates,
  methodForState,
  parseAdvisoryOutlook
} from '../parse.js'
import {
  readAdvisoryCache,
  writeAdvisoryCache
} from '../cache/advisoryCache.js'
import { Meta } from '../publisher.js'
import { Product } from './types.js'

const ID_PREFIX = 'space_weather_advisory_outlook'

// This bulletin is genuinely weekly (every captured fixture is issued on a
// Monday, ~0100-0400 UTC), so a flat interval either chatters all week for
// nothing or misses same-day pickup. Instead: sleep until shortly before the
// next expected issuance, then poll tightly until the new one actually shows
// up. The tight poll is affordable because the bulletin is small; see
// docs/noaa-products.md for the size, and for why a 304 is not what makes it
// cheap.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const PRE_WINDOW_MS = 6 * 60 * 60 * 1000
const TIGHT_POLL_MINUTES = 15
const MAX_SLEEP_MINUTES = 24 * 60
// Used only before the first successful fetch, or after a network failure --
// refresh()'s own nextDelayMinutes governs every other tick.
const FALLBACK_MINUTES = 60

export function nextAdvisoryDelayMinutes(
  now: Date,
  lastIssued: Date | null
): number {
  const expectedNext = lastIssued
    ? new Date(lastIssued.getTime() + WEEK_MS)
    : now
  const windowStart = new Date(expectedNext.getTime() - PRE_WINDOW_MS)
  if (now.getTime() >= windowStart.getTime()) return TIGHT_POLL_MINUTES
  const minutes = Math.ceil((windowStart.getTime() - now.getTime()) / 60000)
  return Math.min(minutes, MAX_SLEEP_MINUTES)
}

export const advisory: Product = {
  name: 'Advisory Outlook',
  intervalMinutes: () => FALLBACK_MINUTES,
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

  async refresh({ client, publisher, stopped }) {
    // Best-effort: a cache read failing here should not block the fetch
    // below, only fall back to treating this as "nothing cached yet".
    let lastIssued: Date | null = null
    try {
      const cached = readAdvisoryCache(publisher.dataDirPath())
      lastIssued = cached ? new Date(cached.issued) : null
    } catch (err) {
      publisher.error(`Failed to read the advisory outlook cache: ${err}`)
    }

    const text = await client.text(
      '/text/advisory-outlook.txt',
      'Advisory Outlook'
    )
    if (stopped()) return

    const outlook = parseAdvisoryOutlook(text)
    if (!outlook) {
      publisher.error('Failed to parse the advisory outlook text product')
      return {
        nextDelayMinutes: nextAdvisoryDelayMinutes(new Date(), lastIssued)
      }
    }

    const { idLine, shortId, issued, outlookTeaser } = outlook
    const path = `${ADVISORY_BASE}.${shortId}`
    const existing = publisher.selfPath(`${path}.value`)
    const id = ID_PREFIX + shortId

    const current = {
      id,
      issued: issued.toISOString(),
      message: `${idLine} for ${issued.toDateString()}`,
      description: text,
      state: NotificationStates.ALERT,
      // A weekly informational bulletin, so `alert` and therefore silent by
      // the same policy the scale zones use: visible in the notifications UI,
      // no popup and no sound. Until 0.12.0 this one sounded an alarm every
      // Monday on a default install.
      method: methodForState(NotificationStates.ALERT)
    }
    publisher.value(path, current, issued.toISOString())

    if (!existing || existing.state === NotificationStates.NORMAL) {
      publisher.debug('Sending %s: %s', id, current.message)
    }

    // Clear any advisory from a previous week that is still raised.
    const previous = publisher.selfPath(ADVISORY_BASE)
    if (previous) {
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

    // Cached separately from the notification path above so the webapp can
    // read the raw bulletin back over this plugin's own HTTP route, rather
    // than depending on a Signal K path shape. Best-effort: a disk write
    // failing here should not stop the notification above from having gone
    // out.
    try {
      writeAdvisoryCache(publisher.dataDirPath(), {
        issued: issued.toISOString(),
        idLine,
        teaser: outlookTeaser,
        text
      })
    } catch (err) {
      publisher.error(`Failed to cache the advisory outlook: ${err}`)
    }

    return { nextDelayMinutes: nextAdvisoryDelayMinutes(new Date(), issued) }
  }
}
