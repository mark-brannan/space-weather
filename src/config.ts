/** Plugin settings: the JSON schema, and normalisation of what comes back. */
import { NoaaScaleValues } from './parse.js'

export interface Settings {
  sendAdvisoryOutlook: boolean
  sendAlertsWatchesWarnings: boolean
  auroraEnabled: boolean
  auroraInterval: number
  notificationVisual: boolean
  notificationSound: boolean
  zoneAlertThreshold: number
  observationsInterval: number
  notificationsInterval: number
}

export const schema = {
  type: 'object',
  properties: {
    sendAdvisoryOutlook: {
      type: 'boolean',
      title:
        'Send notifications for weekly "Advisory Outlook" (as notification state="alert")',
      default: true
    },
    sendAlertsWatchesWarnings: {
      type: 'boolean',
      title:
        'Send notifications for alerts, watches, and warnings (state "alert" or "normal")',
      default: false
    },
    notificationVisual: {
      type: 'boolean',
      title: 'Notification Method Visual',
      default: true
    },
    notificationSound: {
      type: 'boolean',
      title: 'Notification Method Sound',
      default: true
    },
    zoneAlertThreshold: {
      type: 'number',
      title: 'Lowest NOAA "scale" value this plugin treats as worth your attention',
      description:
        '1-5. Governs both the alarm zone on observed/forecast scale and Kp values,' +
        ' and the state of NOAA alert/watch/warning notifications (was two separate' +
        ' settings before 0.8.0; one number now drives both). Levels below this are' +
        ' "normal". This level is "alert" (no popup or sound), one above is "warn"' +
        ' (visual), and higher is "alarm" (visual and sound). The default of 3' +
        ' reflects NOAA event frequencies: level 1 occurs on roughly a quarter of all' +
        ' days, level 3 about monthly, level 5 four times per solar cycle.',
      default: NoaaScaleValues.STRONG
    },
    auroraEnabled: {
      type: 'boolean',
      title: 'Publish aurora visibility at the vessel position',
      description:
        "Requires a position. Off by default because NOAA's aurora grid is" +
        ' roughly 900 KB per fetch, which is significant on a metered' +
        ' satellite link.',
      default: false
    },
    auroraInterval: {
      type: 'number',
      title: 'Aurora fetch interval',
      description:
        'in minutes. Kept separate from the observations interval because of' +
        ' the payload size (~900 KB). Defaults longer than the other intervals' +
        ' on purpose: aurora is a glance-at-it feature, not a value that needs' +
        ' to track in real time, so there is little reason to spend the bandwidth' +
        ' more than a couple of times an hour.',
      default: 120
    },
    observationsInterval: {
      type: 'number',
      title: 'Interval for observations and forecasts',
      description: 'in minutes',
      default: 60
    },
    notificationsInterval: {
      type: 'number',
      title: 'Notifications Interval',
      description: 'in minutes',
      default: 60
    }
  }
}

function scaleValue(raw: any, fallback: number): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 5 ? parsed : fallback
}

function minutes(raw: any, fallback: number): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function settingsFrom(props: any): Settings {
  const p = props ?? {}
  return {
    sendAdvisoryOutlook: p.sendAdvisoryOutlook !== false,
    sendAlertsWatchesWarnings: p.sendAlertsWatchesWarnings === true,
    auroraEnabled: p.auroraEnabled === true,
    auroraInterval: minutes(p.auroraInterval, 120),
    // An explicitly absent notificationVisual has always meant "both methods".
    notificationVisual:
      typeof p.notificationVisual === 'undefined' ? true : !!p.notificationVisual,
    notificationSound:
      typeof p.notificationVisual === 'undefined' ? true : !!p.notificationSound,
    // Before 0.8.0 this was two separate settings (minScaleAlert and
    // zoneAlertThreshold) that happened to share the same default and the
    // same purpose -- "how bad before this plugin makes noise about it" --
    // and had no reason to ever be set differently. `minScaleAlert` is
    // accepted here only so an old saved config that customised it isn't
    // silently ignored; it no longer appears in the schema.
    zoneAlertThreshold: scaleValue(
      p.zoneAlertThreshold ?? p.minScaleAlert,
      NoaaScaleValues.STRONG
    ),
    observationsInterval: minutes(p.observationsInterval, 60),
    notificationsInterval: minutes(p.notificationsInterval, 60)
  }
}

/** The method array attached to notifications the plugin raises itself. */
export function notificationMethod(settings: Settings): string[] {
  const method: string[] = []
  if (settings.notificationVisual) method.push('visual')
  if (settings.notificationSound) method.push('sound')
  return method
}
