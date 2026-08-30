# NOAA Space Weather for Signal K

**[Try it in your browser](https://mark-brannan.github.io/signalk-noaa-space-weather/)** using data from a saved NOAA snapshot, or **[run it on live NOAA data](https://mark-brannan.github.io/signalk-noaa-space-weather/?live)**.

[![The browser demo: NOAA's radio-blackout model and the aurora oval on a globe](docs/screenshots/demo.png)](https://mark-brannan.github.io/signalk-noaa-space-weather/)

## Why a sailor should care

"Space weather" means the sun's activity — solar flares and the geomagnetic
storms that follow them — and what it does to radio and navigation here on
Earth.

- **HF (SSB) radio is the first casualty.** A strong flare can black out HF
  on the daylight side of Earth for an hour or more. A geomagnetic storm can
  leave the bands noisy and unreliable for days.
- **GPS suffers in storms too.** While the ionosphere is disturbed, positions
  can wander or drop out. Small glitches might be noticed at G3, and at G4
  navigation can be disrupted for several hours with widespread positioning errors.
- Low earth orbit satellite services such as Starlink also begin to degrade at
  levels noticeable to individual users around G3.
- **VHF and AIS are mostly safe, but not untouchable.** Marine VHF is
  line-of-sight, so the absorption that silences HF never reaches 156 MHz.
  The strongest flares, though, can raise the daytime noise floor across VHF
  for minutes to an hour — the sun briefly becomes a transmitter — and a
  storm can degrade the GPS positions that AIS depends on. A coastal boat
  with no SSB still has a stake in this.
- In the most severe storms, induced currents might damage electronics or power systems.
  Severe storms do affect power grids but it is unclear how likely this is for the shorter wire runs on boats.
- Note that long-range over-the-horizon radar is affected even at G1 levels (and severely disrupted at G3),
  but line-of-sight marine radar would not be expected to suffer, even in severe storms.

Activity follows the sun's roughly 11-year cycle, so busy years are somewhat
predictable. It isn't all bad news either: a storm at high latitudes can mean
an [aurora](https://www.spaceweather.gov/communities/aurora-dashboard-experimental)
worth staying up for.

More background: [NOAA's Space Weather Impacts](https://www.spaceweather.gov/impacts),
the USGS story [5 Geomagnetic Storms That Reshaped Society](https://www.usgs.gov/news/featured-story/5-geomagnetic-storms-reshaped-society),
and the [Carrington Event](https://en.wikipedia.org/wiki/Carrington_Event).

## What you get

The plugin *judiciously* polls NOAA's [Space Weather Prediction Center](https://www.swpc.noaa.gov/)
endpoints and publishes to Signal K paths under `environment.noaa.swpc` and
`notifications.noaa.swpc`.

- NOAA's weekly [advisory outlook](https://www.spaceweather.gov/products/space-weather-advisory-outlook)
- NOAA's G/S/R storm scales — current level, the last 24 hours' maximums,
  and a 3-day forecast. NOAA explains the scales in its
  [scale explanation](https://www.spaceweather.gov/noaa-scales-explanation).
- NOAA alerts, watches and warnings as Signal K notifications, one path per
  message code (for example `notifications.noaa.swpc.alerts.WARK05`),
  carrying only the conditions currently in force. A reissued warning
  updates its path in place; a cancelled one clears it.
- The [Kp index](https://en.wikipedia.org/wiki/K-index): the latest observed
  value, the peak expected in the next 24 and 72 hours, and the full
  3-hourly forecast series for plotting a timeline. The G scale is defined
  in terms of Kp (G1 = Kp5 up to G5 = Kp9), so the Kp forecast is a feed
  that you could use for near-term planning.
- The [27-day outlook](https://www.swpc.noaa.gov/products/27-day-outlook-107-cm-radio-flux-and-geomagnetic-indices),
  one row per day for a full solar rotation.  This is much less accurate than the 72 hour data, but provides the longest forecast in the entire data set.
- The [solar wind](https://en.wikipedia.org/wiki/Solar_wind) speed, and the
  interplanetary magnetic field strength (Bt) and direction (Bz).
- The GOES X-ray flare class of the most recent event (for example `M2.1`)
  — the same measurement the R scale buckets into 0–5, at finer grain.

**What does it mean for my radio, right where I am?**

- The four numbers HF operators read conditions in — SFI, A, K and the
  sunspot number — see
  [Reading conditions like an HF operator](#reading-conditions-like-an-hf-operator).
- The highest frequency that D-region absorption is blocking at your
  position, from NOAA's [D-RAP model](https://www.swpc.noaa.gov/products/d-region-absorption-predictions-d-rap).
  Frequencies below it are absorbed; those above should get through, barring
  other factors this doesn't measure. It's zoned by which marine SSB bands
  fall under the cutoff — 9.9 MHz absorbed ends the working day on 8 MHz
  and means nothing on 22.
- Aurora probability at your position, from NOAA's OVATION model.

**What does it mean for my data consumption?**

Every path, with units and metadata, is visible in the Signal K Data
Browser once the plugin runs. The NOAA endpoints backing these
are measured in [docs/noaa-products.md](docs/noaa-products.md).
This details the payload sizes over the wire along with cadences and quirks.

## The webapp

The plugin ships a companion webapp to present the underlying data in a useful format, with some informational links on some of the items. No configuration is needed.

![Companion Webapp](docs/screenshots/webapp.png)

The banner answers one question — is anything happening right now? — and a
quiet page has to mean a quiet sky, not a plugin that stopped fetching. The
clock always counts to whatever changes next.

| | |
| --- | --- |
| ![A storm in force](docs/screenshots/hero-storm.png) | ![A storm forecast](docs/screenshots/hero-brewing.png) |
| A storm in force. Any other scale at level 3 or above is named alongside it. | Quiet now, storm forecast — counting down to the window it opens in. |
| ![Quiet after a storm](docs/screenshots/hero-all-clear.png) | ![Stale data](docs/screenshots/hero-stale.png) |
| Quiet, and specific about what the last 24 hours held. | No update in three hours. Not an all-clear — go look at the server log. |

The **Map** tile draws the aurora oval and HF absorption on one canvas, from
the plugin's own cached NOAA data. It loads only when you press **Show
map**. A toolbar switches layers, zooms from your patch of ocean to the
whole world, and swaps between two views: a globe centred on your boat —
where a straight line is a great circle, the path your signal takes — and
the flat rectangle NOAA publishes. With absorption showing, **Band edges**
outlines where each marine SSB band has gone under the cutoff, and clicking
anywhere scores the absorption along the path from your boat to that point.

![The map](docs/screenshots/space-map.png)

The Aurora tile, the map and the HF Radio tile each have a button to fetch
fresh NOAA data on demand (rate-limited to once a minute). Those buttons
work even for products whose scheduled fetch is switched off — so a boat on
a metered link can leave the recurring aurora fetch off and ask for one
reading on the night it matters. Nothing else on the page reaches NOAA.

The world coastline under the map is an 8 KB asset the webapp ships itself,
which is why it needs no chart server. This is a
[small demo](https://mark-brannan.github.io/portolani/) of the storage trade-off.

## Aurora and HF absorption on your chart plotter

Both global grids are also served as Web Mercator map tiles, so the layers
can be drawn over your actual charts:

```text
http://<your-server>:3000/signalk/v1/api/signalk-noaa-space-weather/aurora-tile/{z}/{x}/{y}.png
http://<your-server>:3000/signalk/v1/api/signalk-noaa-space-weather/drap-tile/{z}/{x}/{y}.png
```

Add either URL in [`@signalk/charts-plugin`](https://github.com/SignalK/charts-plugin)
as an online chart source (format `png`, zoom 0–8) and it appears as a
selectable layer in Freeboard-SK. Tiles are transparent wherever there is
nothing to report, and they're rendered from the same cached fetches the
webapp reads, so enabling this costs no extra NOAA traffic. Zoom stops at 8
because the source grids are coarse; beyond that there is nothing more to
show. Each tile carries `Last-Modified` from the fetch behind it, so a
client can tell how old the picture is.

## Installation

Search for **signalk-noaa-space-weather** in the Signal K AppStore, install,
and enable it under *Server → Plugin Config*. Or from a shell:
`npm install signalk-noaa-space-weather` in `~/.signalk`, restart, then
enable it the same way.

## Configuration

Eleven settings, all optional, all with working defaults:

- `alarmLevel` (default 5, "Extreme") — the NOAA level that becomes visible
  **and audible**. "Never" removes the sound without hiding the storm.
- `popupLevel` (default 4, "Severe") — the level that becomes visible and
  stays silent. Never louder than `alarmLevel`.
- `listLevel` (default 3, "Strong") — the level that appears in the
  notification list with no popup and no sound. Never louder than
  `popupLevel`. All three apply to the G, S and R scales and to Kp — see
  [Alarm zones](#alarm-zones).
- `sendAdvisoryOutlook` (default on) — NOAA's weekly outlook bulletin as a
  single quiet notification.
- `drapEnabled` (default on) — fetch the D-RAP absorption grid, about 2 KB
  per fetch.
- `auroraEnabled` (default off) — fetch the OVATION aurora grid. Off by
  default because it's 144 KB per fetch, several times the cost of
  everything else put together. With it off, the webapp can still fetch the
  grid once, when you ask.
- `goesFluxEnabled` (default off) — fetch the GOES X-ray and proton flux
  time series, which fill the trend rows of the webapp's HF tile. The
  largest thing you can add to the poll, about 32 KB per fetch, so it's off
  by default on bandwidth too. Same bargain: off means on-demand only.
- `updateInterval` (default 60 minutes) — the poll for everything above
  except the three products, about 10 KB per poll.
- `auroraInterval` (default 120), `drapInterval` (default 60),
  `goesFluxInterval` (default 60) — separate poll rates for the three
  products that have their own switch.

The plugin has its own configuration screen, with a running total under the
interval fields of what your choices cost per day and per month — it moves
as you type. On an older server, the generated form appears instead, with
the same settings.

Configs saved by versions before 0.30 keep working; obsolete keys carry
over or are ignored, and saving once from the configuration screen writes
only the current ones.

## Alarm zones

The storm scales and short-term Kp paths carry Signal K
[`zones`](https://signalk.org/specification/) metadata, so a gauge in KIP or
Freeboard colours itself with no extra setup.

Similarly, notification thresholds on the storm scales are set by defaults at
deliberately quiet levels. NOAA's published event counts per 11-year solar cycle,
and what each level does at the defaults:

| Level | Geomagnetic (G) | Radio blackout (R) | Radiation storm (S) | At the default |
| ----- | --------------- | ------------------ | ------------------- | -------------- |
| 1 (Minor)    | 900 days | 950 days | 50 events | recorded |
| 2 (Moderate) | 360 days | 300 days | 25 events | recorded |
| 3 (Strong)   | 130 days | 140 days | 10 events | listed, silent |
| 4 (Severe)   | 60 days  | 8 days   | 3 events  | popup |
| 5 (Extreme)  | 4 days   | 1 day    | 1 event   | popup + sound |

`alarmLevel`, `popupLevel` and `listLevel` move that last column.
Set the alarm to 3 and Strong, Severe and Extreme all sound; set it
to "Never" and nothing sounds but higher storms can still pop up. At the
defaults, Strong (3) and above is at least listed — lower `listLevel` to
list Moderate or Minor too, or raise it if you'd rather not see even a
listed Strong storm.

When NOAA writes "G3 or greater" it is interpreted here as just G3,
since they leave it ambiguous, but in reality it could end up as a G4 or G5.

## Reading conditions like an HF operator

Hams state propagation as one phrase — **"SFI 145, A 8, K 2"** — and it's
how every club bulletin and the
[WWV geophysical alert](https://www.swpc.noaa.gov/products/geophysical-alert-wwv-text)
at 18 minutes past the hour say it. The plugin publishes all four numbers,
and the webapp's status bar shows the phrase with the sunspot number on the
end:

- **SFI** — 10.7 cm solar radio flux, `environment.noaa.swpc.f107`
- **A** — the estimated planetary A index, `environment.noaa.swpc.a_index`
- **K** — the observed planetary K index, `environment.noaa.swpc.kp.observed`
- **SSN** — the SESC sunspot number, `environment.noaa.swpc.sunspot_number`

A and K are the same geomagnetic field seen at two speeds. K is a 3-hourly
sample; A is the daily average of it, on a linear scale. An A below 10 is a
quiet field. Above 30 is a disturbed one — noisy bands, weak high-latitude
paths — and A stays high after K has dropped, which is why operators read
both. SSN is the slow variable: it says whether the high bands open at all
this month, not what happens today.

Of the four, only K raises notifications (through the zones above), because
only K says what the field is doing *now*. A and SSN describe a day that
has mostly already happened.

## Bugs, ideas and contributions

Reports from people actually sailing with this are the most useful thing
here.

- **Something is wrong** — [open an issue](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/new/choose).
- **Something is missing** — the [feature form](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/new?template=feature_request.yml).
- **You found a security problem** — report it privately, per
  [SECURITY.md](SECURITY.md), not as a public GitHub issue.
- **You want to send a patch** — [CONTRIBUTING.md](CONTRIBUTING.md) has the
  setup; [AGENTS.md](AGENTS.md) has the full rules and [CLAUDE.md](CLAUDE.md)
  the constraints that will bite you.

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

[AGPL-3.0-or-later](LICENSE). Copyright (c) 2025 Mark Brannan.
