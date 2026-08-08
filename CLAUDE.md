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
  tiles.ts        pure rendering: the aurora grid to PNG map tiles
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

**Tile rendering must not block the event loop.** Measured on a 20-tile
screenful: `zlib.deflateSync` back-to-back blocks for the whole 75ms with zero
timer ticks, while awaiting the async form one tile at a time holds the worst
lag to ~2.5ms for 11ms more wall clock. `Promise.all` over tiles is worse than
either — it runs every rasterize synchronously before awaiting anything. This
is a plugin inside somebody's navigation server; it does not get to stall it.

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

`~/signalk-server` and `~/.signalk` already exist on this machine and are
meant to stay — **check for them before doing anything else here, don't
re-clone or rebuild from scratch.** `~/signalk-server` is a persistent clone
of the real [SignalK/signalk-server
repo](https://github.com/SignalK/signalk-server), built once
(`npm install && npm run build:all`, per its own
[CONTRIBUTING.md](https://github.com/SignalK/signalk-server/blob/master/CONTRIBUTING.md#running-the-development-server)).
If it is genuinely missing (check first — `ls ~/signalk-server/dist` — don't
assume from a failed command), set it up per that CONTRIBUTING.md; otherwise
`git pull` and rebuild only when picking up upstream changes, never a fresh
clone.

**`~/.signalk` is the integration environment.** It is the default config
directory, so plain `bin/signalk-server` (port 3000) uses it with no
environment variables at all. Feature work here is almost always additive —
one more position source, one more chart provider, one more sample log — and
a fresh scratch directory silently loses the settings that make the last
feature testable. So work in `~/.signalk` and add to it. Scratch directories
are still right for genuinely destructive experiments, but they are not the
default.

Two other configs exist and are not for writing through: symphony's own
config, which mirrors the real boat and is reference-only, and
`~/.signalk-dev`, an earlier alternative being consolidated into `~/.signalk`.
Anything in `~/.signalk-dev` should be treated as stale.

`~/.signalk` already has `signalk-fixed-position`, `signalk-datetime`,
`signalk-derived-data`, `@meri-imperiumi/signalk-autostate`,
`signalk-set-gps-timezone`, `@signalk/freeboard-sk`, `@signalk/charts-plugin`
and `signalk-charts-provider-simple` installed. Look before assuming — that
list grows.

**The server finds plugins by scanning `node_modules/`, not by reading
`package.json`.** `findModulesInDir` in signalk-server's `src/modules.ts`
walks each directory under `<configPath>/node_modules/` and checks that
package's own `keywords` for `signalk-node-server-plugin`. So a symlink
dropped into `~/.signalk/node_modules/` is enough to wire this plugin in, with
no dependency entry and no `npm install` — which matters, because installing
anything in that directory re-resolves every caret range in it and can upgrade
plugins you weren't touching.

Note the dependency entry that is there now is `file:`, and npm installed it
as a **copy**, not a symlink — so a rebuild in this repo does not reach the
server until it is reinstalled. Check whether
`~/.signalk/node_modules/signalk-noaa-space-weather` is a symlink or a
directory before wondering why a change did not show up. (`npm link` writes a
`link:` spec, which npm 9 then refuses to install at all with
`EUNSUPPORTEDPROTOCOL` — that is what broke `~/.signalk-dev`.)

Most of what this plugin does needs `navigation.position` to exist.
`signalk-fixed-position` is enabled in `~/.signalk` and will contend with any
sample-data playback over that path — left as-is on purpose, since two sources
racing on one path is exactly the kind of thing signalk-lint should be
catching, not something to route around here. For a genuinely moving vessel,
override the config directory and port so the default instance is left alone:

```shell
cd ~/signalk-server && SIGNALK_NODE_CONFIG_DIR=~/.signalk PORT=3100 bin/nmea-from-file
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
of replaying a fixed log, `~/.signalk/scripts/set-value.mjs` sends a
delta straight over the server's own WS stream — no plugin, no PUT-handler
registration, works for any path:

```shell
node ~/.signalk/scripts/set-value.mjs navigation.position '{"latitude":69.65,"longitude":18.96}'
node ~/.signalk/scripts/set-value.mjs --sweep 69.65,18.96 60.1,24.9 --seconds 60
```

This plugin loads from `dist/`, so rebuild (`npm run build` or `npm run
watch`, in this repo) and restart the server to pick up a change — and see
the copy-versus-symlink note above before concluding the change didn't work.
These are shared instances, not one per session: port 3000 is the `~/.signalk`
server and 3001 is a Docker container running the published package, both
usually already up. Check before starting anything, the same way you'd check
before touching a shared branch. Coordinate with a lock file: before starting
a server or doing anything live against `:3001`, check for and create
`~/.signalk/locks/dev-server.lock` or `docker-3001.lock` (one line: who, when,
why) — remove it when done, and treat someone else's lock file as a hard stop,
not a suggestion.

`~/.signalk` has `allow_readonly` off, so every API read needs a token. There
is an approved read-only device `claude-dev-tools` registered in its
`security.json`; `bin/signalk-generate-token` only signs user ids, not device
ids, so getting a working token is a real step — ask rather than minting an
admin one.

If the admin UI 500s on `/admin/`, npm has hoisted `@signalk/server-admin-ui`
somewhere the server doesn't look; symlink it into
`node_modules/signalk-server/node_modules/@signalk/`.

## Regenerating the README screenshots

`scripts/screenshots/capture.mjs` rewrites all five PNGs in `docs/screenshots/`
against a running server. It is a **separate npm package** on purpose —
Playwright would blow both the offline `npm ci` and the 60 second cap the
registry scores this repo with — so install it on its own:

```shell
npm install --prefix scripts/screenshots
npx --prefix scripts/screenshots playwright install chromium
SK_USERNAME=... SK_PASSWORD=... node scripts/screenshots/capture.mjs
```

It defaults to the Docker instance on `localhost:3001`; `SK_URL` or `--url`
points it at a dev server instead. `--only webapp,aurora-map` limits the run.
Which one you want is a real choice: 3001 runs the published package, so its
shots match what someone installing from the registry sees, while a dev server
shows UI that has not shipped yet.

Four of the five shots need only a **readonly** login. Just `plugin-configuration`
needs admin, because `/skServer/plugins` is admin-gated — with a readonly session
that one shot is skipped and the others still render. Note the plugin's own data
endpoints are readable by a readonly user only because they are mounted under
`/signalk/v1/api/*` rather than `/plugins/*`; see the comment in `src/index.ts`.

To get an account without handing over an admin password, POST
`{"userId":..., "password":...}` to `/signalk/v1/access/requests` (unauthenticated,
returns 202) and approve it in the admin UI under Security → Access Requests,
picking the permission level there. Delete the user again at Security → Users.

Two things about the admin UI that cost an afternoon, so don't rediscover them:
its sidebar section toggles are all `href="#"` with the routing done in JS, and
their labels absorb count badges ("Data" is really "Data1") — so the script moves
`window.location.hash` on the already-loaded SPA instead of clicking through. A
*hard* navigation straight to a deep route still doesn't work, which is why it
loads `/admin/` first.

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
