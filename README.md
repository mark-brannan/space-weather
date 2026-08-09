# signalk-noaa-space-weather

## Why should I care about space weather?

**Q:** *Why would I, a mere **sailor**, care about "space weather"*?

A: Space weather such as solar activity and geomagnetic storms can directly effect satellite communication, satellite navigation, HF radio (frequently), and even VHF radio (rarely).  The most severe storm events have the potential to completely disrupt radio communications, completely disrupt GPS/GNSS navigation, damage sensitive onboard electronics systems, and even induce stray electrical currents that can disrupt power delivery systems onboard or on land!

For more information on impact and risks, see:

* [NOAA's Space Weather Impacts](https://www.spaceweather.gov/impacts)
* This USGS story [5 Geomagnetic Storms That Reshaped Society](https://www.usgs.gov/news/featured-story/5-geomagnetic-storms-reshaped-society)
* The [Carrington Event](https://en.wikipedia.org/wiki/Carrington_Event) on wikipedia

It is worth noting that *"[Solar cycles](https://en.wikipedia.org/wiki/Solar_cycle) have an average duration of about 11 years"*, and that periods of increased solar activity (and impact) are fortunately somewhat *predictable*.

In addition, if you're crusing near the northern (or southern) polar regions then you might just want to get a good view of the [Aurora](https://www.spaceweather.gov/communities/aurora-dashboard-experimental)!

## What info does the plugin surface?

The plugin currently surfaces:

* The weekly ["outlook advisory"](https://www.spaceweather.gov/products/space-weather-advisory-outlook) as a signalk notification
* The G/S/R storm "scales" for latest observed, prior 24-hour observed maximums, and a 3 day forecast (e.g `environment.noaa.swpc.scales.observations.24_hours_maximums.G`)
* The GOES X-ray flare class of the most recent event (e.g. `M2.1`) at `environment.noaa.swpc.xray_flare.class` — the same measurement the R scale buckets into 0-5, at the resolution HF operators actually use
* NOAA SWPC Alerts, Warnings, and Watches as signalk notifications, one per message code under `notifications.noaa.swpc.alerts` (e.g. `alerts.WARK05`), carrying only the conditions currently in force — see [Alerts, watches and warnings](#alerts-watches-and-warnings)
* The [solar wind](https://en.wikipedia.org/wiki/Solar_wind) speed, along with [IMF](https://en.wikipedia.org/wiki/Interplanetary_magnetic_field) strength (Bt) and direction (Bz)
* The [Kp index](https://en.wikipedia.org/wiki/K-index) — most recent observed value, a forecast summary under `environment.noaa.swpc.kp.forecast` (the peak Kp expected in the next 24 and 72 hours, and the time the next storm-level interval begins), and the full 3-hourly series (`forecast.series`) from 24h in the past to 72h ahead for plotting a timeline
* Aurora probability at the vessel's own position (`environment.noaa.swpc.aurora.probability`), from NOAA's OVATION model — off by default, since the payload is roughly 900 KB per fetch

NOAA explains their "scales" and effects for geomagnetic storms ("G"), solar radiation storms ("S"), and radio blackouts ("R") here: <https://www.spaceweather.gov/noaa-scales-explanation>

### Why the Kp forecast is the useful one

The G scale is defined directly in terms of Kp (G1 = Kp5 through G5 = Kp9). NOAA's `noaa-scales.json` gives one G value per forecast *day*; the planetary K-index forecast gives a value every three hours out to three days. It is the feed that tells you **when**, which is the part you can actually plan a passage around.

### Alarm zones

Every scale and Kp path carries Signal K [`zones`](https://signalk.org/specification/) metadata, so a gauge in KIP or Freeboard colours itself with no extra configuration.

Zones also cause the server to raise notifications on your behalf, so the default mapping is deliberately quiet. NOAA's published event frequencies over an 11-year solar cycle are roughly:

| Level | Days per cycle | Share of all days |
| ----- | -------------- | ----------------- |
| 1 (Minor)    | 900–950 | ~23% |
| 2 (Moderate) | 300–360 | ~8%  |
| 3 (Strong)   | 130–140 | ~3%  |
| 4 (Severe)   | 8–60    | ~1%  |
| 5 (Extreme)  | ~4      | ~0.1% |

Alerting on a level 1 would mean an interruption every four or five days, forever. So by default levels 1–2 are `normal`, level 3 is `alert` **with no visual or sound method** (it shows in the UI but does not interrupt), level 4 is `warn` (visual), and level 5 is `alarm` (visual and sound). Set `zoneAlertThreshold` to move that pivot.

A level NOAA states as "G3 or greater" grades at 3, not at 5. "Or greater" is a floor NOAA is asserting rather than a ceiling it is predicting, and reading it as 5 inverts the ladder: a hedged *forecast* outranks an *observed* G4.

Every notification this plugin raises follows that same ladder, whether it comes from a zone transition or from a NOAA message. Severity is the only thing that decides loudness, and `zoneAlertThreshold` is the only setting that changes it — raise it and the whole ladder moves with it. A per-method mute would cut across every product at once, which is a preference about your notification client rather than about space weather.

### Alerts, watches and warnings

NOAA's individual message products are published one Signal K path per message code:

```
notifications.noaa.swpc.alerts.WARK05    WARNING: Geomagnetic K-index of 5 expected
notifications.noaa.swpc.alerts.ALTEF3    ALERT: Electron 2MeV Integral Flux exceeded 1000pfu
```

Two things about this are worth knowing, because the obvious implementation of both is wrong and shipped that way until 0.12.0 ([#45](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/45)):

**NOAA's feed is a 30-day archive, not a list of live conditions.** Every payload carries 88–200 messages, nearly all describing events that ended weeks ago. Only those still in force are raised. Warnings and watches state their own expiry and are cleared when it passes; event summaries expire at the event's end time; plain alerts state no expiry, and a fixed 24 hours bounds those. In practice that means a handful of notifications — one to three on a quiet day, eight during the April 2025 G4 storm.

**A message code is the condition; a serial number is just one telling of it.** NOAA issues a new serial every time it extends, continues or cancels a condition, so keying paths on the serial number turned a single ongoing warning into 19 permanent notifications in a month. Keying on the code means a reissue updates the path in place, a cancellation clears it, and the number of paths stays bounded no matter how long the server runs.

### Aurora on your chart plotter

The aurora grid is also served as Web Mercator map tiles, so the oval can be drawn over your actual chart instead of only in this plugin's webapp:

```
http://<your-server>:3000/signalk/v1/api/signalk-noaa-space-weather/aurora-tile/{z}/{x}/{y}.png
```

Add that in [`@signalk/charts-plugin`](https://github.com/SignalK/charts-plugin) as an online chart source (chart format `png`, zoom 0–8), and it appears as a selectable layer in Freeboard-SK. Tiles are transparent everywhere the model gives no probability, so it overlays a real chart rather than covering it.

Tiles are drawn on demand from the same cached fetch the webapp reads — enabling this costs no extra NOAA traffic — and are re-rendered automatically when a new grid arrives. Zoom is capped at 8 because the source grid is 1°; beyond that there is nothing more to show.

### Planned

* Registering the overlay as a Signal K `charts` resource, so it appears in Freeboard-SK with no chart-source configuration at all

## Configuration

Five settings, all optional, all with working defaults:

* `zoneAlertThreshold` (default 3, "strong") — lowest scale value this plugin treats as worth your attention. Governs both the alarm zone on the observed/forecast paths and NOAA alert/watch/warning notifications, and it is the one control over how loud this plugin gets. See [Alarm zones](#alarm-zones) above for why 3.
* `sendAdvisoryOutlook` (default on) — NOAA's weekly outlook bulletin, as a single `alert`-state notification with no popup and no sound.
* `auroraEnabled` (default off) — publishes `aurora.probability`. Off by default because the payload dwarfs everything else this plugin fetches; needs a vessel position.
* `updateInterval` — how often to fetch from NOAA, in minutes, 60 by default. Covers observations, forecasts and alerts alike.
* `auroraInterval` — separate poll interval for the aurora payload, 120 minutes by default.

Five settings were removed in 0.13.0. Configs that set the old keys still work — the intervals carry over, the rest are ignored.

* `notificationVisual` / `notificationSound` — see [Alarm zones](#alarm-zones).
* `alertMaxAgeHours` — now a fixed 24 hours.
* `observationsInterval` / `notificationsInterval` — now one `updateInterval`.
* `sendAlertsWatchesWarnings` — the alerts product is always on. Neither justification for a switch survived being measured: severity is `zoneAlertThreshold`'s job, and the bandwidth is ~5 KB per poll, because NOAA serves this endpoint gzipped and an unchanged payload comes back as a 304 with no body.

## References

### NOAA Dashboards of interest

* <https://www.spaceweather.gov/communities/radio-communications>
* <https://www.spaceweather.gov/communities/global-positioning-system-gps-community-dashboard>
* <https://www.spaceweather.gov/communities/aurora-dashboard-experimental>
* <https://www.swpc.noaa.gov/products/planetary-k-index>

### NOAA json resources of interest

* <https://services.swpc.noaa.gov/products/noaa-scales.json>
* <https://services.swpc.noaa.gov/products/alerts.json>
* <https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json>
* <https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json>
* <https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json>
* <https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json>
* <https://services.swpc.noaa.gov/json/icao-space-weather-advisories.json>

### NOAA text resources of interest

Note that the outlook advisory is not available as json, so the plugin is doing some parsing of raw text.

* <https://services.swpc.noaa.gov/text/advisory-outlook.txt>
* <https://services.swpc.noaa.gov/text/current-space-weather-indices.txt>
* <https://services.swpc.noaa.gov/text/3-day-forecast.txt>

### Other resources

* <http://www.spaceweather.org/ISES/code/fmt/exam.html>

## Webapp

The plugin ships a companion webapp — no configuration needed, it reads whatever the plugin has already published. Open it from the Signal K admin **Webapps** menu, or at `/signalk-noaa-space-weather/` on your server. If your server has `allow_readonly` off (data reads require login), the webapp shows a banner and a login link rather than a silently blank page.

![The companion webapp](docs/screenshots/webapp.png)

The Aurora tile has a **Show map** button that draws probability near your position from the plugin's own cached NOAA fetch, only loaded when you click it. Both the tile and the map have a **Refresh** button to fetch fresh data on demand instead of waiting for the next scheduled interval; it's rate-limited to once a minute.

![The aurora map](docs/screenshots/aurora-map.png)

## Screenshots

| | |
| --- | --- |
| ![Plugin configuration](docs/screenshots/plugin-configuration.png) | ![Data browser](docs/screenshots/data-browser.png) |
| Plugin configuration | The published paths in the data browser |

![Notifications](docs/screenshots/notifications.png)
