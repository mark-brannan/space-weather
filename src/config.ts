/** Plugin settings: the JSON schema, and normalisation of what comes back. */
import { NoaaScaleValues } from './parse.js'

export interface Settings {
  sendAdvisoryOutlook: boolean
  sendAlertsWatchesWarnings: boolean
  auroraEnabled: boolean
  auroraInterval: number
  notificationVisual: boolean
  notificationSound: boolean
  minScaleAlert: number
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
    minScaleAlert: {
      type: 'number',
      title:
        'Minimum NOAA "scale" value to trigger "alert" notifications (will use state="normal" below this)',
      description: '1-5 (minor, moderate, strong, severe, extreme)',
      default: NoaaScaleValues.STRONG
    },
    zoneAlertThreshold: {
      type: 'number',
      title:
        'Lowest NOAA "scale" value that raises an alarm zone on observed and forecast values',
      description:
        '1-5. Levels below this are "normal". This level is "alert" (no popup or sound),' +
        ' one above is "warn" (visual), and higher is "alarm" (visual and sound).' +
        ' The default of 3 reflects NOAA event frequencies: level 1 occurs on roughly a' +
        ' quarter of all days, level 3 about monthly, level 5 four times per solar cycle.',
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
        ' the payload size; NOAA regenerates this product about every 30' +
        ' minutes, so there is little value in going below that.',
      default: 60
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
    auroraInterval: minutes(p.auroraInterval, 60),
    // An explicitly absent notificationVisual has always meant "both methods".
    notificationVisual:
      typeof p.notificationVisual === 'undefined' ? true : !!p.notificationVisual,
    notificationSound:
      typeof p.notificationVisual === 'undefined' ? true : !!p.notificationSound,
    minScaleAlert: scaleValue(p.minScaleAlert, NoaaScaleValues.STRONG),
    zoneAlertThreshold: scaleValue(p.zoneAlertThreshold, NoaaScaleValues.STRONG),
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
