// https://services.swpc.noaa.gov/products/alerts.json
// Message codes: http://www.spaceweather.org/ISES/code/fmt/exam.html
import { notificationMethod } from '../config.js'
import { NOTIFICATIONS_BASE } from '../paths.js'
import { parseAlert } from '../parse.js'
import { Product } from './types.js'

export const alerts: Product = {
  name: 'Alerts, Watches, and Warnings',
  schedule: 'notifications',
  enabled: (settings) => settings.sendAlertsWatchesWarnings,

  async refresh({ client, publisher, settings, stopped }) {
    const json = await client.json(
      '/products/alerts.json',
      'Alerts, Watches, and Warnings'
    )
    if (stopped()) return

    if (!Array.isArray(json)) {
      publisher.error('Alerts payload was not an array')
      return
    }

    const method = notificationMethod(settings)
    let skipped = 0

    for (const alert of json) {
      const parsed = parseAlert(alert, settings.minScaleAlert)
      if (!parsed) {
        skipped++
        continue
      }
      const path = `${NOTIFICATIONS_BASE}.sn:${parsed.serialNumber}`
      publisher.value(
        path,
        {
          id: path,
          issued: parsed.issued.toISOString(),
          message: parsed.mainMessage,
          description: alert.message,
          alertLevel: parsed.alertLevel,
          scale: parsed.scaleText,
          state: parsed.state,
          method
        },
        parsed.issued.toISOString()
      )
    }

    if (skipped > 0) {
      publisher.error(
        'Skipped %d unparseable alert(s) of %d',
        skipped,
        json.length
      )
    }
  }
}
