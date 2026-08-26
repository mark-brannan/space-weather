// https://services.swpc.noaa.gov/text/advisory-outlook.txt
import { ADVISORY_BASE } from '../paths.js'
import {
  NotificationStates,
  isRaised,
  methodForState,
  parseAdvisoryOutlook
} from '../parse.js'
import {
  readAdvisoryCache,
  writeAdvisoryCache
} from '../cache/advisoryCache.js'
import { Meta, Publisher } from '../publisher.js'
import { Product } from './types.js'

// There is only ever one current advisory, so this identifies the path, not
// the week. The bulletin number lives in the value's `shortId` instead.
const ID = 'space_weather_advisory_outlook'

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
    const existing = publisher.selfPath(`${ADVISORY_BASE}.value`) as
      { shortId?: string } | undefined

    const current = {
      id: ID,
      // The week's bulletin number, which used to be the last path segment.
      // It identifies the issue, not the condition, so it belongs in the
      // value the same way an alert's serial number does -- a client that
      // wants to know whether this is a bulletin it has already seen reads
      // this field rather than watching a path appear and disappear.
      shortId,
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

    // The tight poll runs every 15 minutes through the pre-issuance window
    // and re-reads the same bulletin each time; republishing it would put a
    // delta out to every connected client for a value that has not moved.
    if (!existing || existing.shortId !== shortId) {
      publisher.value(ADVISORY_BASE, current, issued.toISOString())
      publisher.debug('Sending %s: %s', ID, current.message)
    }

    clearShortIdPaths(publisher, issued)

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

/**
 * Stand down the per-bulletin notifications this plugin raised before 0.25.0
 * (`notifications.noaa.swpc.advisory_outlook.SWO25-034`).
 *
 * Every week minted a fresh path, so a client that subscribed to one stopped
 * hearing anything the following Monday (issue #104), and upgrading does not
 * remove the old ones -- they are already in the server's model and in every
 * client that saw them. Idempotent, and a no-op on an install that never ran
 * the old code.
 */
function clearShortIdPaths(publisher: Publisher, now: Date) {
  // `selfPath` is untyped, and the leaf holds its own `value`/`meta` keys
  // alongside whatever legacy children are left, so the entries are only
  // known to maybe carry a notification.
  const existing = publisher.selfPath(ADVISORY_BASE) as
    | Record<
        string,
        | { value?: { id?: string; state?: unknown; method?: unknown } }
        | undefined
      >
    | undefined
  if (!existing) return

  for (const [leaf, entry] of Object.entries(existing)) {
    // Skips `value`, `meta` and the rest of the leaf's own keys, which carry
    // no `id` of ours now that ADVISORY_BASE is itself the notification.
    const value = entry?.value
    if (!value?.id) continue
    if (!isRaised(value)) continue
    publisher.debug('Clearing the stale per-bulletin path %s', leaf)
    publisher.value(
      `${ADVISORY_BASE}.${leaf}`,
      { ...value, state: NotificationStates.NORMAL, method: [] },
      now.toISOString()
    )
  }
}
