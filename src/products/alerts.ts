// https://services.swpc.noaa.gov/products/alerts.json
// Message codes: http://www.spaceweather.org/ISES/code/fmt/exam.html
import { ALERTS_BASE, NOTIFICATIONS_BASE, STORM_BASE } from '../paths.js'
import {
  ALERT_MAX_AGE_MS,
  AlertNotification,
  NOAA_MESSAGE_CODE_REGEX,
  NoaaScaleNames,
  NotificationStates,
  StormState,
  currentAlertNotifications,
  isRaised,
  methodForState,
  stateForScaleValue,
  stormLevelInForce,
  stormTransition
} from '../parse.js'
import { readStormCache, writeStormCache } from '../cache/stormCache.js'
import type { Settings } from '../config.js'
import type { Meta, Publisher } from '../publisher.js'
import { Product } from './types.js'
import { ALERTS } from '../endpoints.js'

const ID_PREFIX = 'noaa_swpc_alert_'

export const alerts: Product = {
  name: 'Alerts, Watches, and Warnings',
  endpoints: [ALERTS],
  intervalMinutes: (settings) => settings.updateInterval,
  // No `enabled`: there is nothing left for a switch to decide. Loudness is
  // `alarmLevel`'s job, and this payload is small on the wire despite the size
  // of the fixtures on disk. Both measured in docs/noaa-products.md -- don't
  // reason about either from the fixture sizes.

  metadata(): Meta[] {
    return [
      {
        path: ALERTS_BASE,
        value: {
          name: 'NOAA SWPC alerts, watches and warnings',
          description:
            'One notification per NOAA space weather message code, carrying the' +
            ' most recent message for that condition while it is in force.',
          // The delta timestamp on each of these is the NOAA issue time, so a
          // client honouring the timeout expires the notification at the same
          // moment this plugin would stop republishing it.
          timeout: ALERT_MAX_AGE_MS / 1000
        }
      },
      {
        path: STORM_BASE,
        value: {
          name: 'NOAA SWPC geomagnetic storm (G3 and above)',
          description:
            'One notification raised while a Strong (G3) or greater' +
            ' geomagnetic storm is in force, whichever message codes are' +
            ' carrying it, standing down once the storm has been below G3' +
            ' for six hours.',
          timeout: ALERT_MAX_AGE_MS / 1000
        }
      }
    ]
  },

  async refresh({ client, publisher, settings, stopped }) {
    const json = await client.json(ALERTS, 'Alerts, Watches, and Warnings')
    if (stopped()) return

    if (!Array.isArray(json)) {
      publisher.error('Alerts payload was not an array')
      return
    }

    const now = new Date()
    const { inForce, unparseable, dropped } = currentAlertNotifications(json, {
      now,
      alarmLevel: settings.alarmLevel,
      popupLevel: settings.popupLevel,
      listLevel: settings.listLevel
    })

    let raised = 0
    for (const alert of inForce) {
      if (publishAlert(publisher, alert)) raised++
    }

    const live = new Set(inForce.map((alert) => alert.code))
    const cleared =
      clearWithdrawn(publisher, live, now) +
      clearSerialNumberPaths(publisher, now)

    publishStorm(publisher, inForce, settings, now)

    publisher.debug(
      '%d of %d NOAA messages in force; %d raised or changed, %d cleared',
      inForce.length,
      json.length,
      raised,
      cleared
    )

    if (unparseable > 0) {
      publisher.error(
        'Skipped %d unparseable alert(s) of %d',
        unparseable,
        json.length
      )
    }
    // Never seen in a real payload. If it fires, the message code capture in
    // parseAlert has stopped matching what NOAA sends.
    if (dropped > 0) {
      publisher.error(
        'Withheld %d alert notification(s) over the safety limit; ' +
          'the NOAA payload shape may have changed',
        dropped
      )
    }
  }
}

/**
 * Publish one code's current message, unless the path already holds it.
 *
 * Skipping the unchanged ones is the difference between a delta per condition
 * per change and the whole in-force set re-broadcast to every connected client
 * on every poll, forever. The serial number covers it on its own: NOAA issues
 * a new one for every extension, continuation and cancellation.
 */
function publishAlert(publisher: Publisher, alert: AlertNotification): boolean {
  // `code` becomes part of the path below. Check its shape before writing it.
  if (!NOAA_MESSAGE_CODE_REGEX.test(alert.code)) {
    publisher.error('Refusing to publish malformed alert code %j', alert.code)
    return false
  }

  const path = `${ALERTS_BASE}.${alert.code}`
  const existing = publisher.selfPath(`${path}.value`)
  if (
    existing &&
    existing.serialNumber === alert.serialNumber &&
    existing.state === alert.state
  ) {
    return false
  }

  publisher.value(
    path,
    {
      id: ID_PREFIX + alert.code,
      serialNumber: alert.serialNumber,
      issued: alert.issued.toISOString(),
      validUntil: alert.validUntil ? alert.validUntil.toISOString() : null,
      message: alert.mainMessage,
      description: alert.description,
      alertLevel: alert.alertLevel,
      scale: alert.scaleText,
      state: alert.state,
      method: alert.method,
      // Empty for everything but a watch. It is the only forward-looking
      // thing NOAA publishes with a date on it, and the webapp's hero reads
      // it: see `watchAhead` in public/hero.js.
      predictedByDay: alert.predictedByDay
    },
    alert.issued.toISOString()
  )
  return true
}

const STORM_ID = 'noaa_swpc_storm'

/**
 * The collapsed G3+ storm notification: a derived view over the same in-force
 * set the per-code paths are published from, not a second reading of NOAA.
 *
 * The per-code stream republishes on every fresh serial number, which during
 * a real storm is most of what NOAA issues (16 of Gannon's 26 path deltas —
 * the replay in #297/#298). This path publishes a delta only when the storm's
 * G level actually changes, in either direction, and stands down only after
 * the in-force set has been quiet for {@link STORM_HOLD_MS}, riding out the
 * dips between K-index synoptic periods. Loudness runs through the same two
 * thresholds as everything else — tentative, being revisited in #298 along
 * with the path name.
 *
 * The cache, not the model, holds the state machine: a server restart empties
 * the model mid-storm, and rereading the level from the path would then
 * re-alarm at an unchanged level. The model is only healed to match.
 */
function publishStorm(
  publisher: Publisher,
  inForce: AlertNotification[],
  settings: Settings,
  now: Date
): void {
  const cached = readStormCache(publisher)
  const existing = publisher.selfPath(`${STORM_BASE}.value`)

  if (!settings.stormAlertsEnabled) {
    // Signal K cannot delete a path, so switching the feature off while the
    // path is raised has to stand it down or it stays raised forever.
    if (existing && isRaised(existing)) {
      standDown(publisher, STORM_BASE, existing, now)
    }
    if (cached && (cached.level > 0 || cached.belowSince !== null)) {
      writeCache(
        publisher,
        { level: 0, belowSince: null },
        cached.message,
        cached.issued
      )
    }
    return
  }

  const prev: StormState | null = cached
    ? { level: cached.level, belowSince: cached.belowSince }
    : null
  const { level, driver } = stormLevelInForce(inForce)
  const { next, changed } = stormTransition(prev, level, now)

  // The driver names the current level while one is in force; through the
  // hold and the stand-down the last raised message is what a client reads.
  const fromDriver = driver !== null && next.level > 0
  const message = fromDriver ? driver.mainMessage : (cached?.message ?? '')
  const issued = fromDriver
    ? driver.issued.toISOString()
    : (cached?.issued ?? now.toISOString())

  if (
    !cached ||
    cached.level !== next.level ||
    cached.belowSince !== next.belowSince ||
    cached.message !== message
  ) {
    writeCache(publisher, next, message, issued)
  }

  const state =
    next.level === 0
      ? NotificationStates.NORMAL
      : stateForScaleValue(next.level, settings.alarmLevel, settings.popupLevel)

  // Publish on a transition, and heal a model that lost the delta (a server
  // restart empties it); otherwise stay silent — an unchanged value
  // re-broadcast every poll is what issue #45 was made of.
  const inSync =
    existing && existing.level === next.level && existing.state === state
  const nothingToSay = next.level === 0 && (!existing || !isRaised(existing))
  if (!changed && (inSync || nothingToSay)) return

  publisher.value(
    STORM_BASE,
    {
      id: STORM_ID,
      level: next.level,
      scale:
        next.level === 0
          ? null
          : `G${next.level} - ${NoaaScaleNames[next.level]}`,
      message,
      issued,
      state,
      method: methodForState(state)
    },
    next.level === 0 ? now.toISOString() : issued
  )
}

function writeCache(
  publisher: Publisher,
  state: StormState,
  message: string,
  issued: string
): void {
  try {
    writeStormCache(publisher, {
      level: state.level,
      belowSince: state.belowSince,
      message,
      issued
    })
  } catch (err) {
    publisher.error(`Failed to cache the storm notification state: ${err}`)
  }
}

/** `{ ...value, quiet }` -- keeps the message so a client can still read it. */
function standDown(publisher: Publisher, path: string, value: any, now: Date) {
  publisher.value(
    path,
    { ...value, state: NotificationStates.NORMAL, method: [] },
    now.toISOString()
  )
}

/**
 * Return any code no longer in force to `normal`.
 *
 * Signal K has no way to delete a path, so a notification that is simply
 * dropped from the next poll stays raised in the model and in every client
 * that has ever seen it. It has to be actively stood down. Same shape as
 * `clearShortIdPaths` in the advisory product.
 */
function clearWithdrawn(
  publisher: Publisher,
  live: Set<string>,
  now: Date
): number {
  const existing = publisher.selfPath(ALERTS_BASE)
  if (!existing) return 0

  let cleared = 0
  for (const [code, entry] of Object.entries(existing as Record<string, any>)) {
    const value = entry?.value
    // Skips the `meta` sibling as well as anything not ours.
    if (!value?.id || live.has(code)) continue
    // Skip if it does not match the well-defined format for NOAA message codes.
    if (!NOAA_MESSAGE_CODE_REGEX.test(code)) continue
    if (!isRaised(value)) continue
    standDown(publisher, `${ALERTS_BASE}.${code}`, value, now)
    cleared++
  }
  return cleared
}

/**
 * Stand down the per-serial-number notifications this plugin raised before
 * 0.12.0 (`notifications.noaa.swpc.sn:3713`).
 *
 * Upgrading does not remove them: they are already in the server's model and
 * in every client that subscribed, still asking for a sound, and there are up
 * to 200 of them. Without this, the fix for issue #45 does nothing for the
 * people who already hit it short of deleting the server's data. Idempotent,
 * and a no-op on any install that never ran the old code.
 */
function clearSerialNumberPaths(publisher: Publisher, now: Date): number {
  const existing = publisher.selfPath(NOTIFICATIONS_BASE)
  if (!existing) return 0

  let cleared = 0
  for (const [leaf, entry] of Object.entries(existing as Record<string, any>)) {
    if (!leaf.startsWith('sn:')) continue
    const value = entry?.value
    if (!value || !isRaised(value)) continue
    standDown(publisher, `${NOTIFICATIONS_BASE}.${leaf}`, value, now)
    cleared++
  }
  return cleared
}
