# signalk-noaa-space-weather

A SignalK plugin to get *space* weather observations, forecasts, and alerts from the NOAA Space Weather Prediction Center.

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
* NOAA SWPC Alerts, Warnings, and Watches as signalk notifications with a configurable threshold (default 3, "strong")
* The [solar wind](https://en.wikipedia.org/wiki/Solar_wind) speed, along with [IMF](https://en.wikipedia.org/wiki/Interplanetary_magnetic_field) strength (Bt) and direction (Bz)
* The [Kp index](https://en.wikipedia.org/wiki/K-index) — most recent observed value, plus a forecast summary under `environment.noaa.swpc.kp.forecast`: the peak Kp expected in the next 24 and 72 hours, and the time the next storm-level interval (Kp 5 / G1 or above) begins
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

### Planned

* Dashboard images, maps, and data in the form of a signalk webapp or resources

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

## Screenshots

| | |
| --- | --- |
| ![Plugin configuration](docs/screenshots/plugin-configuration.png) | ![Data browser](docs/screenshots/data-browser.png) |
| Plugin configuration | The published paths in the data browser |

![Notifications](docs/screenshots/notifications.png)

## Development

```shell
npm install
npm run build
npm test
```

The tests run entirely against the captured NOAA payloads in `examples/` and
make no network requests, so they work offline and in a sandbox. If you add a
parser, add a captured payload alongside it rather than reaching for the live
service — NOAA has changed the shape of these products more than once, and the
committed captures are what makes that visible.

To try a change against a real server, install Signal K somewhere separate,
point it at its own config directory, and symlink this checkout into it:

```shell
mkdir -p ~/signalk-dev/server ~/signalk-dev/config/node_modules
cd ~/signalk-dev/server && npm install signalk-server
ln -s /path/to/signalk-noaa-space-weather ~/signalk-dev/config/node_modules/signalk-noaa-space-weather
SIGNALK_NODE_CONFIG_DIR=~/signalk-dev/config ./node_modules/.bin/signalk-server
```

The server loads the plugin from `dist/`, so run `npm run build` (or
`npm run watch`) and restart the server to pick up a change. Using a separate
config directory keeps the experiment away from a real boat's configuration.
