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

Against a real server:

```shell
mkdir -p ~/signalk-dev/server ~/signalk-dev/config/node_modules
cd ~/signalk-dev/server && npm install signalk-server
ln -s /path/to/this/repo ~/signalk-dev/config/node_modules/signalk-noaa-space-weather
SIGNALK_NODE_CONFIG_DIR=~/signalk-dev/config PORT=3100 ./node_modules/.bin/signalk-server
```

The server loads from `dist/`, so rebuild and restart to pick up a change. Use a
separate config directory — never a real boat's `~/.signalk`.

On this machine, port 3000 is a Grafana container and 3001 is a Signal K
Docker container, both in use; the dev server uses 3100.

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
