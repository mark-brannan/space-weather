# signalk-noaa-space-weather

[![The browser demo: NOAA's radio-blackout model and the aurora oval on a globe](docs/screenshots/demo.png)](https://mark-brannan.github.io/signalk-noaa-space-weather/)

**[Try it in your browser](https://mark-brannan.github.io/signalk-noaa-space-weather/)** — the plugin's map on a saved NOAA snapshot. No boat, no server, nothing to install.

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
* The [27-day outlook](https://www.swpc.noaa.gov/products/27-day-outlook-107-cm-radio-flux-and-geomagnetic-indices) under `environment.noaa.swpc.kp.forecast.outlook27` — the peak Kp expected over the next solar rotation, the day it falls on, the first day forecast to reach storm level, and the full daily series (`series`) of 10.7cm flux, planetary A index and largest Kp — see [The 27-day outlook](#the-27-day-outlook)
* The [planetary A index](https://www.swpc.noaa.gov/products/geophysical-alert-wwv-text) at `environment.noaa.swpc.a_index` and the [sunspot number](https://www.swpc.noaa.gov/products/solar-cycle-progression) at `environment.noaa.swpc.sunspot_number` — with the 10.7cm flux and Kp above, the four numbers HF operators read conditions in, see [Reading conditions like an HF operator](#reading-conditions-like-an-hf-operator)
* Aurora probability at the vessel's own position (`environment.noaa.swpc.aurora.probability`), from NOAA's OVATION model — not fetched on a schedule by default, on bandwidth, and fetchable on demand from the webapp even then, see [Configuration](#configuration)
* The highest HF frequency D-region absorption is blocking at the vessel's own position (`environment.noaa.swpc.drap.highest_affected_frequency`, in Hz), from NOAA's [D-RAP model](https://www.swpc.noaa.gov/products/d-region-absorption-predictions-d-rap), with the grid's own validity time at `drap.validTime`. Frequencies below it are absorbed; those above it should get through, barring other factors this doesn't measure. Zoned by which marine SSB bands fall under the cutoff, because the number is a frequency rather than a severity — 9.9 MHz absorbed ends the working day for someone on 8 MHz and means nothing to someone on 22

NOAA explains their "scales" and effects for geomagnetic storms ("G"), solar radiation storms ("S"), and radio blackouts ("R") here: <https://www.spaceweather.gov/noaa-scales-explanation>

### Why the Kp forecast is the useful one

The G scale is defined directly in terms of Kp (G1 = Kp5 through G5 = Kp9). NOAA's `noaa-scales.json` gives one G value per forecast *day*; the planetary K-index forecast gives a value every three hours out to three days. It is the feed that tells you **when**, which is the part you can actually plan a passage around.

### The 27-day outlook

Everything else here stops at 72 hours. The 27-day outlook runs a full solar rotation at one row per UTC day, which is the only thing in the plugin that speaks to *next week* — whether a passage a fortnight out is likely to fall in a disturbed stretch.

It buys that horizon by being a **recurrence** forecast. 27 days is the solar rotation period, so the outlook is largely the last rotation repeated, on the assumption that the same coronal holes come back around. It has far less skill than the 3-day products and gives a whole-day maximum rather than a time.

So none of it carries `zones`, and **none of it will ever raise a notification or sound an alarm**. A G1 day turns up somewhere in a 27-day window roughly monthly; alarming on that would fire constantly on low-confidence data and drown out the 3-day alerts that are worth waking up for. Read the outlook; be woken by the Kp forecast.

These six paths sit under the Kp forecast rather than on a base of their own, because the outlook is the same index and the same G mapping at a third horizon: asking "what is the worst Kp coming" should not mean knowing which NOAA product answered. They are a branch under `forecast` rather than siblings of `max24h` and `max72h`, because a whole-day maximum from a recurrence forecast is not interchangeable with a 3-hourly value.

### Reading conditions like an HF operator

Hams state propagation as one phrase — **"SFI 145, A 8, K 2"** — and it is how
every club bulletin, contest forecast and the
[WWV geophysical alert](https://www.swpc.noaa.gov/products/geophysical-alert-wwv-text)
broadcast at 18 minutes past the hour says it. The plugin publishes all of it,
and the webapp's status bar shows the phrase with the sunspot number on the
end:

* **SFI** — 10.7cm solar radio flux, `environment.noaa.swpc.f107`
* **A** — the estimated planetary A index, `environment.noaa.swpc.a_index`
* **K** — the observed planetary K index, `environment.noaa.swpc.kp.observed`
* **SSN** — the SESC sunspot number, `environment.noaa.swpc.sunspot_number`

A and K are the same geomagnetic field seen at two speeds: K is a 3-hourly
sample on a quasi-logarithmic scale, A the linearised daily average of it. A
below 10 is a quiet field; above 30 is a disturbed one, with degraded
high-latitude paths and noisy bands — and it stays high after K has dropped,
which is why operators read both. SSN is the slow variable: it says whether the
high bands (15, 12 and 10 metres) open at all this month, not what happens
today.

A and SSN carry no `zones`, so neither ever raises a notification: both
describe a day that has mostly already happened, and the storm worth waking for
is the one the Kp forecast and the alerts are already shouting about. K is the
exception and keeps the zones it has always had — see
[Alarm zones](#alarm-zones) — because it is the only one of the four that says
what the field is doing *now*.

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

### Aurora and HF absorption on your chart plotter

Both global grids are also served as Web Mercator map tiles, so the auroral oval and the HF absorption footprint can be drawn over your actual chart instead of only in this plugin's webapp:

```
http://<your-server>:3000/signalk/v1/api/signalk-noaa-space-weather/aurora-tile/{z}/{x}/{y}.png
http://<your-server>:3000/signalk/v1/api/signalk-noaa-space-weather/drap-tile/{z}/{x}/{y}.png
```

The D-RAP layer is coloured by which marine SSB bands the absorption cutoff has taken, not by a smooth frequency scale — the published number is a frequency, and what changes for you is a band going under. Nothing is drawn where the cutoff is below the lowest marine band.

Add either URL in [`@signalk/charts-plugin`](https://github.com/SignalK/charts-plugin) as an online chart source (chart format `png`, zoom 0–8), and it appears as a selectable layer in Freeboard-SK. Tiles are transparent everywhere the layer has nothing to report, so they overlay a real chart rather than covering it.

Tiles are drawn on demand from the same cached fetches the webapp reads — enabling this costs no extra NOAA traffic — and are re-rendered automatically when a new grid arrives. Zoom is capped at 8 because the source grids are 1° and 2°×4°; beyond that there is nothing more to show.

Each tile carries `Last-Modified` from the fetch behind it, so a client can tell how old the picture is. That matters with the recurring fetch off, where the grid only moves when someone asks for one: the plugin serves the last one it has and lets you judge it, rather than picking an expiry on your behalf.

### Planned

* Registering the overlay as a Signal K `charts` resource, so it appears in Freeboard-SK with no chart-source configuration at all

## Installation

Search for **signalk-noaa-space-weather** in the Signal K server's AppStore and
install it from there, then enable it under *Server → Plugin Config*. Or, from
a shell on the server: `npm install signalk-noaa-space-weather` in `~/.signalk`,
restart, then enable it under *Server → Plugin Config* the same way.

## Configuration

Nine settings, all optional, all with working defaults:

* `alarmLevel` (default 5, "Extreme") — which NOAA level is visible **and audible**. "Never" removes the sound without hiding the storm.
* `popupLevel` (default 4, "Severe") — which NOAA level is visible and silent. Never louder than `alarmLevel`; moving one past the other takes it along, except a "Never" popup, which leaves the alarm where it is. Both apply to the G, S and R scales and to Kp. See [Alarm zones](#alarm-zones).

In the plugin's own configuration screen these two are lines you drag across the ladder — the band is everything above the line, and pushing one above Extreme empties it, which is "Never". Arrow keys work too. On a server that renders the generated form instead, they are two dropdowns labelled with how often each level happens.
* `sendAdvisoryOutlook` (default on) — NOAA's weekly outlook bulletin, as a single `alert`-state notification with no popup and no sound.
* `auroraEnabled` (default off) — fetches the OVATION grid every `auroraInterval`, publishing `aurora.probability` and keeping the chart overlay tiles current. Off by default because the payload is 144 KB per fetch, about three and a half times what one poll of everything else costs — roughly 1.7 MB a day at the default interval, against about 1.1 MB for the whole of the rest of the plugin. It governs the recurring fetch and nothing else: with it off, the webapp can still fetch the grid once, when you ask it to.
* `drapEnabled` (default on) — fetches NOAA's D-RAP grid every `drapInterval`, publishing the highest frequency D-region absorption is blocking at your position. One grid covers the whole globe, so it costs the same everywhere: about 2.1 KB per fetch, against about 10 KB for a poll of everything else. Same bargain as `auroraEnabled` — it governs the recurring fetch, and with it off the webapp can still fetch the grid once, when you ask it to.
* `goesFluxEnabled` (**default off**) — fetches the two GOES flux time series every `goesFluxInterval`, publishing `xray_flux`, its trend, and `proton_flux`. Off by default on bandwidth, like `auroraEnabled`: ticking it is much the largest thing you can add to the recurring poll, about 32 KB per fetch against about 10 KB for everything else on it — roughly 775 KB a day at the hourly default, on top of about 300 KB for the whole of the rest of the plugin. Ticking it is also what fills the proton flux and X-ray trend rows of the webapp's HF tile. Same bargain as the other two: it governs the recurring fetch, and with it off the series can still be fetched once on demand.
* `updateInterval` — how often to fetch from NOAA, in minutes, 60 by default. Covers observations, forecasts and alerts alike, about 10 KB per poll now that the two expensive products on it have their own rates.
* `auroraInterval` — separate poll interval for the aurora payload, 120 minutes by default.
* `drapInterval` — separate poll interval for the D-RAP grid, 60 minutes by default.
* `goesFluxInterval` — separate poll interval for the GOES flux pair, 60 minutes by default, and only used while `goesFluxEnabled` is on. NOAA republishes both series about once a minute, so nothing here polls faster than the source; both paths declare a one-hour timeout, so a rate above 60 publishes readings Signal K itself marks stale.

On a server new enough to load it, these are edited on the plugin's own configuration screen rather than the form Signal K generates from the JSON schema. Same settings, saving the same values, with a running total underneath the two interval fields of what they cost per day and per month — it moves as you type, so the price of a tighter aurora interval is visible before you commit to it. The generated form is still there and is what an older server, or a failed load, falls back to.

**Upgrading from 0.29.x or earlier: `goesFluxEnabled` defaults off, and that is a behaviour change.** Installs that already had `environment.noaa.swpc.xray_flux`, `xray_flux.trend` and `proton_flux` stop publishing them until the box is ticked, and the webapp's HF tile shows a dash for proton flux and X-ray trend. Nothing migrates the old behaviour forward, because the setting exists precisely for the boat that never opens this screen — a metered link paying 775 KB a day for data it did not ask for. If you want those paths back, tick **Publish GOES X-ray and proton flux**; nothing else changes. The R and S scale levels, the flare class and the 24-hour peak come from other endpoints and are unaffected.

Five legacy settings are no longer supported. Configs that set the old keys still work — the intervals carry over, the rest are ignored — and the plugin's own configuration screen writes the current keys and nothing else, so saving once clears the old ones out of the file. It cannot change what the plugin is running: every current key is written explicitly, so a dropped key had nothing left to say.

* `zoneAlertThreshold` — replaced by `alarmLevel`, which names the level that sounds rather than the level worth noticing. A saved value carries over and keeps behaving the same way. A config saved before `popupLevel` existed gets the band one below its alarm level, which is the ladder it already had.
* `notificationVisual` / `notificationSound` — see [Alarm zones](#alarm-zones).
* `alertMaxAgeHours` — now a fixed 24 hours.
* `observationsInterval` / `notificationsInterval` — now one `updateInterval`.
* `sendAlertsWatchesWarnings` — the alerts product is always on. Neither justification for a switch survived being measured: severity is `alarmLevel`'s job, and the bandwidth is ~5 KB gzipped per poll, about 128 KB a day at the default interval, because NOAA serves this endpoint gzipped.

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
* <https://services.swpc.noaa.gov/text/wwv.txt>
* <https://services.swpc.noaa.gov/text/daily-solar-indices.txt>

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

The **Map** tile draws both grids on one canvas — the aurora oval and HF absorption — from the plugin's own cached NOAA fetches, and it only loads when you press **Show map**. A toolbar turns either layer off, switches between a view centred on your boat — where a straight line across the map is a great circle, so it's the path your signal takes — and the flat rectangle NOAA publishes, and zooms from your own patch of ocean out to the whole world. With absorption showing, **Band edges** draws a line around where each marine SSB band has gone under the cutoff, and clicking anywhere on the map scores the absorption along the path from your boat to that point. The Aurora tile, the map and the HF Radio tile each have a button to fetch fresh data on demand instead of waiting for the next scheduled interval; it's rate-limited to once a minute.

Those buttons work whether or not `auroraEnabled` and `drapEnabled` are on, and with one off — where the button reads **Fetch once** — pressing it is the only thing that ever fetches that grid. So the aurora is available on a boat that has decided not to spend 145 KB every couple of hours on it: leave the recurring fetch off, and ask for a reading on the night you want one. Nothing else on the page reaches NOAA; the map draws from whatever the plugin last cached, and the periodic poll only reads your own server.

![The map](docs/screenshots/space-map.png)

The coastline under that map costs 8 KB for the whole world, which is why the
webapp can afford to ship its own instead of needing a chart server. Skeptical?
[Drag the slider that proves it](https://mark-brannan.github.io/portolani/).

## Screenshots

| | |
| --- | --- |
| ![Plugin configuration](docs/screenshots/plugin-configuration.png) | ![Data browser](docs/screenshots/data-browser.png) |
| Plugin configuration | The published paths in the data browser |

![Notifications](docs/screenshots/notifications.png)

## Bugs, ideas and contributions

Reports from people actually sailing with this are the most useful thing here.

- **Something is wrong** — [open an issue](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/new/choose). The bug form asks for the plugin version, the Signal K server version, the hardware and the log; those are what makes a report actionable.
- **Something is missing** — the [feature form](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/new?template=feature_request.yml). A new NOAA data source is cheap here by design; a new setting is not.
- **You found a security problem** — report it privately, per [SECURITY.md](SECURITY.md). Not as an issue.
- **You want to send a patch** — [CONTRIBUTING.md](CONTRIBUTING.md) has the setup and the short version of the rules; [AGENTS.md](AGENTS.md) has the full ones and [CLAUDE.md](CLAUDE.md) has the constraints that will bite you.

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

[AGPL-3.0-or-later](LICENSE). Copyright (c) 2025 Mark Brannan.
