// https://services.swpc.noaa.gov/text/advisory-outlook.txt
import { ADVISORY_BASE, ADVISORY_VALUE_BASE } from '../paths.js'
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
const DAY_MS = 24 * 60 * 60 * 1000
const PRE_WINDOW_MS = 6 * 60 * 60 * 1000
const TIGHT_POLL_MINUTES = 15
const MAX_SLEEP_MINUTES = 24 * 60
// An outlook describes the week it was issued for. If nothing has replaced
// it by the time that week is fully up -- NOAA changed the payload shape
// under the parser, or the network's been down -- it has to stop reading as
// current rather than sit there indefinitely. Not WEEK_MS flat: our own
// fixtures show consecutive issue dates as much as 7d3h25m apart, so a flat
// week trips on a perfectly healthy install, stands the notification down,
// then re-raises it an hour or three later once the tight poll catches the
// (now late) bulletin -- a spurious weekly flap. Two days of slack covers
// every gap we've measured; the argument is "NOAA is late", not "the week
// is up".
const EXPIRY_MS = WEEK_MS + 2 * DAY_MS
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
  // No `enabled`: `sendAdvisoryOutlook` governs the notification, not the
  // fetch, and this product has no manual-refresh route to reveal a frozen
  // bulletin. Argument in docs/design-decisions.md.

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
      },
      {
        path: ADVISORY_VALUE_BASE,
        value: {
          displayName: 'Advisory Outlook',
          description:
            'The current NOAA Space Weather Advisory Outlook bulletin,' +
            ' fetched and published on the same weekly schedule as the' +
            ` notification at ${ADVISORY_BASE} -- but always, regardless of` +
            ' whether that notification is turned on. The full bulletin' +
            ' text is served over this plugin’s own HTTP route, not in' +
            ' this value.',
          timeout: 60 * 60 * 24 * 7
        }
      }
    ]
  },

  async refresh({ client, publisher, settings, stopped }) {
    const now = new Date()

    // Best-effort: a cache read failing here should not block the fetch
    // below, only fall back to treating this as "nothing cached yet".
    let lastIssued: Date | null = null
    try {
      const cached = readAdvisoryCache(publisher.dataDirPath())
      lastIssued = cached ? new Date(cached.issued) : null
    } catch (err) {
      publisher.error(`Failed to read the advisory outlook cache: ${err}`)
    }

    // Checked before the fetch below, and unconditionally, so it still runs
    // on a tick where the fetch throws or the parse fails -- the two cases
    // `EXPIRY_MS` exists for in the first place.
    expireIfStale(publisher, settings, now)

    const text = await client.text(
      '/text/advisory-outlook.txt',
      'Advisory Outlook'
    )
    if (stopped()) return

    const outlook = parseAdvisoryOutlook(text)
    if (!outlook) {
      publisher.error('Failed to parse the advisory outlook text product')
      return { nextDelayMinutes: nextAdvisoryDelayMinutes(now, lastIssued) }
    }

    const { idLine, shortId, issued, outlookTeaser } = outlook

    const summary = {
      id: ID,
      // The week's bulletin number, which used to be the last path segment.
      // It identifies the issue, not the condition, so it belongs in the
      // value the same way an alert's serial number does -- a client that
      // wants to know whether this is a bulletin it has already seen reads
      // this field rather than watching a path appear and disappear.
      shortId,
      issued: issued.toISOString(),
      teaser: outlookTeaser,
      message: `${idLine} for ${issued.toDateString()}`
    }

    // Plain data, kept current regardless of `sendAdvisoryOutlook`. Deduped
    // against the cache rather than this path's own last value: the value
    // path is only ever touched here, so on an install that has had the
    // flag off since it was added, the cache is the one place that reliably
    // recorded the last bulletin this plugin actually saw. The dedupe is
    // skipped on an install upgrading straight into this feature -- its
    // cache already holds today's bulletin from before ADVISORY_VALUE_BASE
    // existed, so without this check the new path would sit empty until
    // next Monday.
    const valueIsNew = !lastIssued || issued.getTime() !== lastIssued.getTime()
    const valuePathEmpty =
      publisher.selfPath(`${ADVISORY_VALUE_BASE}.value`) === undefined
    if (valueIsNew || valuePathEmpty) {
      publisher.value(ADVISORY_VALUE_BASE, summary, issued.toISOString())
    }

    // Age-gated independently of `sendAdvisoryOutlook`: a bulletin already
    // past `EXPIRY_MS` should never be raised as a live alert, however it
    // got here. Without this, a NOAA fetch that keeps turning up the same
    // stale bulletin flaps forever -- `expireIfStale` stands the
    // notification down once it ages out, and the very next tick's
    // `alreadyCurrent` check would otherwise see `state !== ALERT` and
    // re-raise the identical stale bulletin right back.
    const bulletinExpired = now.getTime() - issued.getTime() >= EXPIRY_MS
    if (settings.sendAdvisoryOutlook && !bulletinExpired) {
      const existing = publisher.selfPath(`${ADVISORY_BASE}.value`) as
        { shortId?: string; state?: unknown } | undefined
      // The tight poll runs every 15 minutes through the pre-issuance window
      // and re-reads the same bulletin each time; republishing it would put
      // a delta out to every connected client for a value that has not
      // moved. Checking `state` too, not just `shortId`, is what makes
      // turning the flag back on on the same bulletin `expireIfStale` (or a
      // prior "flag was off") stood down re-raise it, rather than leaving it
      // parked at `normal` until next week's issue.
      const alreadyCurrent =
        existing?.shortId === shortId &&
        existing?.state === NotificationStates.ALERT
      if (!alreadyCurrent) {
        const current = {
          ...summary,
          description: text,
          state: NotificationStates.ALERT,
          // A weekly informational bulletin, so `alert` and therefore silent
          // by the same policy the scale zones use: visible in the
          // notifications UI, no popup and no sound. Until 0.12.0 this one
          // sounded an alarm every Monday on a default install.
          method: methodForState(NotificationStates.ALERT)
        }
        publisher.value(ADVISORY_BASE, current, issued.toISOString())
        publisher.debug('Sending %s: %s', ID, current.message)
      }
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

    return { nextDelayMinutes: nextAdvisoryDelayMinutes(now, issued) }
  }
}

/**
 * Stand the notification down once it can no longer be trusted to describe
 * the current week: either the operator does not want it at all right now,
 * or nothing has refreshed it since the outlook it holds expired. Runs on
 * every tick, ahead of the fetch, so a broken parse or a dead network cannot
 * keep it from firing -- both are exactly the case `EXPIRY_MS` is for.
 */
function expireIfStale(
  publisher: Publisher,
  settings: { sendAdvisoryOutlook: boolean },
  now: Date
): void {
  const existing = publisher.selfPath(`${ADVISORY_BASE}.value`) as
    { issued?: string; state?: unknown; method?: unknown } | undefined
  if (!existing || !isRaised(existing)) return

  let reason: string | null = null
  if (!settings.sendAdvisoryOutlook) {
    reason = 'sendAdvisoryOutlook is off'
  } else {
    const issuedAt = existing.issued ? new Date(existing.issued) : null
    if (
      issuedAt &&
      !isNaN(issuedAt.getTime()) &&
      now.getTime() - issuedAt.getTime() >= EXPIRY_MS
    ) {
      reason = `past its effective week (issued ${existing.issued})`
    }
  }
  if (!reason) return

  publisher.debug('Standing down the advisory outlook notification: %s', reason)
  publisher.value(
    ADVISORY_BASE,
    {
      ...existing,
      state: NotificationStates.NORMAL,
      method: methodForState(NotificationStates.NORMAL)
    },
    now.toISOString()
  )
}

/**
 * Stand down the per-bulletin notifications this plugin raised before 0.25.0
 * (`notifications.noaa.swpc.advisory_outlook.#26-30`, one path per week,
 * keyed on the raw bulletin number straight from NOAA's header -- `#`
 * included, since nothing sanitized it back then).
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
      {
        ...value,
        state: NotificationStates.NORMAL,
        method: methodForState(NotificationStates.NORMAL)
      },
      now.toISOString()
    )
  }
}
