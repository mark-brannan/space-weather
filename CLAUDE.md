# signalk-noaa-space-weather

A Signal K server plugin that publishes NOAA Space Weather Prediction Center
data to a boat's Signal K instance.

## Architecture

```
src/
  index.ts        plugin definition, start/stop, the PRODUCTS registry
  config.ts       JSON schema, typed Settings, normalisation of raw props
  publisher.ts    the ONLY module that touches the Signal K `app` object
  noaa/client.ts  the ONLY outbound network I/O
  paths.ts        every Signal K path this plugin owns, plus the scale tables
  parse.ts        pure parsing and transformation; no I/O, no `app`
  products/       one module per NOAA product
```

**To add a data source: write `src/products/<name>.ts` implementing `Product`,
add it to `PRODUCTS` in `index.ts`.** Nothing else. That is the whole reason
for this shape.

A `Product` declares `schedule` (`observations` or `notifications`), optional
`enabled(settings)` if the user can switch it off, optional `metadata(settings)`
published once per start, and `refresh(ctx)`.

Keep parsing in `parse.ts` and pure. It is what makes the fixtures useful.

## Non-obvious constraints

**Tests must run with no network.** The
[Signal K plugin registry](https://github.com/SignalK/signalk-plugin-registry)
scores this package by cloning the default branch and running `npm ci`,
`npm run build`, then `npm test` under `firejail --net=none` with a **60 second
cap**. `test/offline.test.ts` asserts the no-network property so a stray request
fails locally instead of only in the registry. Always test against a captured
payload in `examples/`, never the live service.

**NOAA changes payload shapes without notice.** This has happened at least
twice and both times it silently broke published data:

- the solar wind summaries went from `{"Bt": 5, "Bz": -3}` to
  `[{"bt": 4, "bz_gsm": -1}]`, which made the plugin publish `NaN` for months
- the planetary K-index forecast alternates between a header-row table and a
  list of records

So: **capture a dated fixture into `examples/` before writing a parser**, and
make the parser accept the old shape as well as the new one. `parseSolarWind`
and `kpRows` in `parse.ts` are the pattern to copy.

**Zone metadata generates notifications.** The server (`signalk-server`
`src/zones.ts`) watches any path with `meta.zones` and raises
`notifications.<path>` on zone *transitions*. Its matcher is half-open —
`value >= lower && value < upper` — and `Infinity` is not representable in
JSON, so a top zone must **omit** `upper` rather than set it to `Infinity`,
or the highest value matches nothing at all.

`alertMethod` / `warnMethod` / `alarmMethod` on the metadata control the
notification's `method` array independently of its `state`. That is how a
level can be visible in the UI without interrupting the user, and it is
load-bearing for the design below.

**Alarm thresholds are deliberately conservative.** NOAA's frequency tables put
a level 1 event on roughly a quarter of all days and a level 5 on about four
days per 11-year solar cycle. Alerting on anything below level 3 is noise on a
boat. Default mapping: 0 `nominal`, 1–2 `normal`, 3 `alert` with an **empty
method array**, 4 `warn` (visual), 5 `alarm` (visual + sound). `zoneAlertThreshold`
moves the pivot. Do not make this louder without a frequency argument.

**Signal K wants SI units.** Solar wind speed in m/s (NOAA gives km/s), Bt and
Bz in Tesla (NOAA gives nT), probabilities as 0–1 ratios with `units: "ratio"`
(NOAA gives whole percents). Dimensionless indices such as the G/S/R levels and
Kp carry **no** `units` key — the admin UI renders the string verbatim, so
`units: "none"` displays as "2 none".

**Never publish `NaN`.** Return `null` from a parser instead. Several fixtures
exist specifically to pin this.

**`main` must stay in package.json.** The server loads plugins with
`require()` on an absolute directory path, and Node's CommonJS resolver ignores
`exports` in that case. Removing `main` reintroduces issue #1.

## Conventions

No semicolons, two-space indent, single quotes — run `npm run format`
(prettier, configured in `.prettierrc`); `npm run format:check` verifies. Comments
explain *why*, not what. Tests assert behaviour — values, states, paths, unit
conversions, boundaries — never display strings.

## Local development

```shell
npm install && npm run build && npm test
```

There is a Signal K server already running in Docker on this machine at
`localhost:3001`, installed from the published npm package — useful for
read-only checks against real, released behavior (it's what backs any
"browse the live server" research), but it runs whatever version is
currently published, not this checkout's uncommitted changes. Don't
restart, reconfigure, or write through it without checking who else might
be using it first.

`~/signalk-server` and `~/.signalk-dev` already exist on this machine and
are meant to stay — **check for them before doing anything else here, don't
re-clone or rebuild from scratch.** `~/signalk-server` is a persistent clone
of the real [SignalK/signalk-server
repo](https://github.com/SignalK/signalk-server), built once
(`npm install && npm run build:all`, per its own
[CONTRIBUTING.md](https://github.com/SignalK/signalk-server/blob/master/CONTRIBUTING.md#running-the-development-server)).
`~/.signalk-dev` is the shared scratch config directory
(`SIGNALK_NODE_CONFIG_DIR`) with `signalk-fixed-position`, `signalk-datetime`,
`signalk-derived-data`, `@meri-imperiumi/signalk-autostate`, and
`signalk-set-gps-timezone` already installed and configured (mirrored from
symphony's own working config) — never a real boat's `~/.signalk`. If
either is genuinely missing (check first — `ls ~/signalk-server/dist
~/.signalk-dev` — don't assume from a failed command), set up
`~/signalk-server` per its own CONTRIBUTING.md
(`git clone https://github.com/SignalK/signalk-server ~/signalk-server &&
cd ~/signalk-server && npm install && npm run build:all`) and
`~/.signalk-dev` as a plain directory with its own `package.json`; otherwise
`git pull` and rebuild only when picking up upstream signalk-server changes,
never a fresh clone.

Wire a plugin in with `npm link` (once from the plugin's own repo directory,
then `npm link <package-name>` from inside `~/.signalk-dev`), then run with a
synthetic moving position instead of an empty config, since aurora (and most
of what this plugin does) needs `navigation.position` to exist. Note
`signalk-fixed-position` is already enabled in `~/.signalk-dev` and will
contend with the sample data below over `navigation.position` — left as-is
on purpose, since two sources racing on one path is exactly the kind of
thing signalk-lint should be catching, not something to route around here:

```shell
cd ~/signalk-server && SIGNALK_NODE_CONFIG_DIR=~/.signalk-dev PORT=3100 bin/nmea-from-file
```

`bin/nmea-from-file` plays back a real NMEA 0183 log (`samples/plaka.log`,
throttled) as the vessel "Volare," publishing a genuinely moving position —
`SIGNALK_NODE_CONFIG_DIR` outranks the sample settings file in signalk-server's
own config-directory resolution, so the linked plugin and the sample data
both take effect together. `bin/n2k-from-file` is the NMEA 2000 equivalent.
Without sample data, `bin/signalk-server` starts with an empty config and no
position source. Run `npm run watch` in `~/signalk-server` for continuous
rebuild if you're also changing the server itself, not just this plugin.

For driving the vessel to a specific place (or moving it) on demand instead
of replaying a fixed log, `~/.signalk-dev/scripts/set-value.mjs` sends a
delta straight over the server's own WS stream — no plugin, no PUT-handler
registration, works for any path:

```shell
node ~/.signalk-dev/scripts/set-value.mjs navigation.position '{"latitude":69.65,"longitude":18.96}'
node ~/.signalk-dev/scripts/set-value.mjs --sweep 69.65,18.96 60.1,24.9 --seconds 60
```

This plugin loads from `dist/`, so rebuild (`npm run build` or `npm run
watch`, in this repo) and restart the server to pick up a change. It's a
single shared server instance, not one per session — port 3000 is Grafana
and 3001 is another Docker container, both already in use on this machine,
so check nothing else is running against `~/.signalk-dev`/port 3100 before
starting it, the same way you'd check before touching a shared branch.
Coordinate with a lock file: before starting the dev server or doing
anything live against `:3001`, check for and create
`~/.signalk-dev/locks/dev-server.lock` or `docker-3001.lock` (one line: who,
when, why) — remove it when done, and treat someone else's lock file as a
hard stop, not a suggestion.

If the admin UI 500s on `/admin/`, npm has hoisted `@signalk/server-admin-ui`
somewhere the server doesn't look; symlink it into
`node_modules/signalk-server/node_modules/@signalk/`.

## Releasing

Publishing happens from CI via npm OIDC trusted publishing — tag `vX.Y.Z` and
push. No npm token should ever live on a developer machine.

Version bumps are automatic in two layers, so a real release never depends on
remembering: `.husky/pre-commit` auto-patch-bumps `package.json` at commit
time if nothing on the branch has already given it an explicit bump (compared
against the latest git tag, not the immediate parent commit). `.github/workflows/auto-version.yml`
then tags and publishes whatever version lands on `main`, whether that came
from the hook or from an explicit `npm version minor`/`major` before
committing. Bump explicitly yourself for anything more than the smallest
change; let the hook cover the rest.
