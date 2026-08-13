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
* The [27-day outlook](https://www.swpc.noaa.gov/products/27-day-outlook-107-cm-radio-flux-and-geomagnetic-indices) under `environment.noaa.swpc.outlook_27day` — the peak Kp expected over the next solar rotation, the day it falls on, the first day forecast to reach storm level, and the full daily series (`series`) of 10.7cm flux, planetary A index and largest Kp — see [The 27-day outlook](#the-27-day-outlook)
* Aurora probability at the vessel's own position (`environment.noaa.swpc.aurora.probability`), from NOAA's OVATION model — off by default on bandwidth, see [Configuration](#configuration)

NOAA explains their "scales" and effects for geomagnetic storms ("G"), solar radiation storms ("S"), and radio blackouts ("R") here: <https://www.spaceweather.gov/noaa-scales-explanation>

### Why the Kp forecast is the useful one

The G scale is defined directly in terms of Kp (G1 = Kp5 through G5 = Kp9). NOAA's `noaa-scales.json` gives one G value per forecast *day*; the planetary K-index forecast gives a value every three hours out to three days. It is the feed that tells you **when**, which is the part you can actually plan a passage around.

### The 27-day outlook

**These paths are provisional and may move without a deprecation window.** The
outlook is arguably just the Kp forecast further out, and it may end up under
`environment.noaa.swpc.kp.forecast` rather than its own base — see
[#57](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/57).
Everything else the plugin publishes is stable; treat these six as pre-release
and expect to follow a rename.

Everything else here stops at 72 hours. The 27-day outlook runs a full solar rotation at one row per UTC day, which is the only thing in the plugin that speaks to *next week* — whether a passage a fortnight out is likely to fall in a disturbed stretch.

It buys that horizon by being a **recurrence** forecast. 27 days is the solar rotation period, so the outlook is largely the last rotation repeated, on the assumption that the same coronal holes come back around. It has far less skill than the 3-day products and gives a whole-day maximum rather than a time.

So none of it carries `zones`, and **none of it will ever raise a notification or sound an alarm**. A G1 day turns up somewhere in a 27-day window roughly monthly; alarming on that would fire constantly on low-confidence data and drown out the 3-day alerts that are worth waking up for. Read the outlook; be woken by the Kp forecast.

### Alarm zones

Every scale and Kp path except the 27-day outlook carries Signal K [`zones`](https://signalk.org/specification/) metadata, so a gauge in KIP or Freeboard colours itself with no extra configuration.

Zones also cause the server to raise notifications on your behalf, so the default is deliberately quiet. NOAA's published event frequencies over an 11-year solar cycle, and what each level does at the defaults:

| Level | Geomagnetic (G) | Radio blackout (R) | Radiation storm (S) | At the default |
| ----- | --------------- | ------------------ | ------------------- | -------------- |
| 1 (Minor)    | 900 days | 950 days | 50 events | recorded |
| 2 (Moderate) | 360 days | 300 days | 25 events | recorded |
| 3 (Strong)   | 130 days | 140 days | 10 events | listed, silent |
| 4 (Severe)   | 60 days  | 8 days   | 3 events  | popup |
| 5 (Extreme)  | 4 days   | 1 day    | 1 event   | popup + sound |

The three scales are not interchangeable; [docs/noaa-products.md](docs/noaa-products.md) compares them.

Those are counts per cycle, which is how NOAA publishes them. The settings dropdown quotes something different — geomagnetic storm days in a **median year**, measured from the Kp archive — because dividing a per-cycle count by eleven describes an average cycle rather than the year you are living in, and runs about twice the rate an ordinary year actually sees. [`docs/noaa-products.md`](docs/noaa-products.md#event-frequency-by-scale) has the measured numbers, the method, and `scripts/measure-kp.mjs` regenerates them.

Two settings move that last column, and each one names the level its own band starts at. `alarmLevel` (default 5) is where an event becomes visible **and audible**; `popupLevel` (default 4) is where it becomes visible and stays silent. Set the alarm to 3 and Strong, Severe and Extreme all sound. Set the alarm to "Never" and nothing sounds at all, while Extreme still pops up — the popup setting is untouched by it, which is the point of there being two.

Lower is always louder in both, and alarming on a level 1 would be near-constant noise, which is why the defaults sit where they do.

**Strong (3) and above is always listed**, whatever the two are set to. Turning this plugin down is a decision about being interrupted, and a listed notification interrupts nobody — it carries an empty `method` array, so it appears in the notification list and does nothing else. A G3 is a real storm, and there is no setting at which one should leave no trace.

NOAA writes `G3 or greater` when it won't say how bad a storm will get. That counts as G3 here. Treating it as G5 made an uncertain forecast louder than a confirmed G4, which is backwards.

Every notification follows that same ladder, whether it comes from a zone transition or a NOAA message. How bad the event is decides how loud it gets, and those two thresholds are the only settings that change it. There is deliberately no separate "mute sounds" checkbox: it would silence every product at once, which is something to fix in your notification client, not here.

### Alerts, watches and warnings

NOAA's individual message products are published one Signal K path per message code:

```
notifications.noaa.swpc.alerts.WARK05    WARNING: Geomagnetic K-index of 5 expected
notifications.noaa.swpc.alerts.ALTEF3    ALERT: Electron 2MeV Integral Flux exceeded 1000pfu
```

Two things about this are worth knowing, because the obvious implementation of both is wrong and shipped that way until 0.12.0 ([#45](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/45)):

**NOAA's feed is a 30-day archive, not a list of live conditions.** Every payload carries a couple of hundred messages, nearly all describing events that ended weeks ago. Only those still in force are raised. Warnings and watches state their own expiry and are cleared when it passes; event summaries expire at the event's end time; plain alerts state no expiry, and a fixed 24 hours bounds those. In practice that means a handful of notifications: see [docs/noaa-products.md](docs/noaa-products.md) for the counts measured against the captured payloads.

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

Six settings, all optional, all with working defaults:

* `alarmLevel` (default 5, "Extreme") — which NOAA level is visible **and audible**. "Never" removes the sound without hiding the storm.
* `popupLevel` (default 4, "Severe") — which NOAA level is visible and silent. Never louder than `alarmLevel`; moving one past the other takes it along, except a "Never" popup, which leaves the alarm where it is. Both apply to the G, S and R scales and to Kp. See [Alarm zones](#alarm-zones).

In the plugin's own configuration screen these two are lines you drag across the ladder — the band is everything above the line, and pushing one above Extreme empties it, which is "Never". Arrow keys work too. On a server that renders the generated form instead, they are two dropdowns labelled with how often each level happens.
* `sendAdvisoryOutlook` (default on) — NOAA's weekly outlook bulletin, as a single `alert`-state notification with no popup and no sound.
* `auroraEnabled` (default off) — publishes `aurora.probability`. Off by default because the payload is 145 KB per fetch, about thirty times everything else this plugin downloads combined; needs a vessel position.
* `updateInterval` — how often to fetch from NOAA, in minutes, 60 by default. Covers observations, forecasts and alerts alike.
* `auroraInterval` — separate poll interval for the aurora payload, 120 minutes by default.

On a server new enough to load it, these are edited on the plugin's own configuration screen rather than the form Signal K generates from the JSON schema. Same five settings, saving the same values, with a running total underneath the two interval fields of what they cost per day and per month — it moves as you type, so the price of a tighter aurora interval is visible before you commit to it. The generated form is still there and is what an older server, or a failed load, falls back to.

Five settings were removed in 0.13.0. Configs that set the old keys still work — the intervals carry over, the rest are ignored.

* `zoneAlertThreshold` — replaced by `alarmLevel`, which names the level that sounds rather than the level worth noticing. A saved value carries over and keeps behaving the same way. A config saved before `popupLevel` existed gets the band one below its alarm level, which is the ladder it already had.
* `notificationVisual` / `notificationSound` — see [Alarm zones](#alarm-zones).
* `alertMaxAgeHours` — now a fixed 24 hours.
* `observationsInterval` / `notificationsInterval` — now one `updateInterval`.
* `sendAlertsWatchesWarnings` — the alerts product is always on. Neither justification for a switch survived being measured: severity is `alarmLevel`'s job, and the bandwidth is ~5 KB gzipped per poll, about 120 KB a day at the default interval, because NOAA serves this endpoint gzipped.

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
* <https://services.swpc.noaa.gov/text/27-day-outlook.txt>
* <https://services.swpc.noaa.gov/text/current-space-weather-indices.txt>
* <https://services.swpc.noaa.gov/text/3-day-forecast.txt>

### Other resources

* <http://www.spaceweather.org/ISES/code/fmt/exam.html>

## Webapp

The plugin ships a companion webapp — no configuration needed, it reads whatever the plugin has already published. Open it from the Signal K admin **Webapps** menu, or at `/signalk-noaa-space-weather/` on your server. If your server has `allow_readonly` off (data reads require login), the webapp shows a banner and a login link rather than a silently blank page.

![The companion webapp](docs/screenshots/webapp.png)

### The banner, in the states you don't see most days

The banner answers one question — is anything happening right now? — and a quiet page has to mean a quiet sky rather than a plugin that stopped fetching. The clock always counts to whatever changes next.

| | |
| --- | --- |
| ![A storm in force](docs/screenshots/hero-storm.png) | ![A storm forecast](docs/screenshots/hero-brewing.png) |
| A storm in force. Any other scale at level 3 or above gets named alongside it, so a radiation storm doesn't hide behind a geomagnetic one. | Quiet now, storm forecast — counting down to the window it opens in. |
| ![Quiet after a storm](docs/screenshots/hero-all-clear.png) | ![Stale data](docs/screenshots/hero-stale.png) |
| Quiet, and specific about what the last 24 hours actually held. | No update in three hours. Not an all-clear — go look at the server log. |

The Aurora tile has a **Show map** button that draws probability near your position from the plugin's own cached NOAA fetch, only loaded when you click it. Both the tile and the map have a **Refresh** button to fetch fresh data on demand instead of waiting for the next scheduled interval; it's rate-limited to once a minute.

![The aurora map](docs/screenshots/aurora-map.png)

## Screenshots

| | |
| --- | --- |
| ![Plugin configuration](docs/screenshots/plugin-configuration.png) | ![Data browser](docs/screenshots/data-browser.png) |
| Plugin configuration | The published paths in the data browser |

![Notifications](docs/screenshots/notifications.png)
