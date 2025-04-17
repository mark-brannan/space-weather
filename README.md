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

NOAA explains their "scales" and effects for geomagnetic storms ("G"), solar radiation storms ("S"), and radio blackouts ("R") here: <https://www.spaceweather.gov/noaa-scales-explanation>

### Planned

The intent of this project is to eventally also surface:

* The [Kp index](https://en.wikipedia.org/wiki/K-index) (directly underlies the G scales),
* The [solar wind](https://en.wikipedia.org/wiki/Solar_wind) speed, along with [IMF](https://en.wikipedia.org/wiki/Interplanetary_magnetic_field) strength (Bt) and direction (Bz)
* possibly, dashboard images, maps, and data in the form of a signalk webapp or resources

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
