# signalk-noaa-space-weather

A Signal K server plugin that publishes NOAA Space Weather Prediction Center
data to a boat's Signal K instance.

**Read [AGENTS.md](AGENTS.md) too.** It holds the conventions — scope, comments,
tests, commits, pull requests, and the bar a new config setting has to clear.
This file is what the codebase *is*; that one is how to work in it.

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

The webapp's map stack:

```
public/
  projection.js   the two projections, and the viewport that turns one to pixels
  mapRaster.js    grid samplers, and the destination-pixel rasteriser
  spaceMap.js     the drawing: raster, contours, graticule, coastline, marks
  drap-colors.js  NOAA's D-RAP colorbar, mirrored from tiles.ts
  geo.js          the coastline, decoded and drawn
  signalk.js      the ONLY module the page reaches the server through
```

**To add a data source: write `src/products/<name>.ts` implementing `Product`,
add it to `PRODUCTS` in `index.ts`.** Nothing else. That is the whole reason
for this shape.

**Every endpoint a product fetches is declared in `src/endpoints.ts`, with its
measured wire size**, and the client refuses to fetch anything else. That table
is what `config.ts`'s form descriptions and `public/config-panel.js`'s daily
bill are computed from, so a new endpoint is priced by adding it and nothing
else — and an undeclared one is a test failure rather than traffic nobody was
told about. `test/endpoints.test.ts` holds the declarations against
`docs/noaa-products.md` byte for byte, so re-measuring means updating both.
This exists because "together about 5 KB per poll" outlived a product growing
from one endpoint to three, and #223 had to go and re-measure to find it. The
correction was one release; the declarations are what stop the next one.

A `Product` declares `schedule` (`observations` or `notifications`), optional
`enabled(settings)` if the user can switch it off, optional `metadata(settings)`
published once per start, and `refresh(ctx)`. Keep parsing in `parse.ts` and
pure — it is what makes the fixtures useful.

## Non-obvious constraints

**Tests must run with no network.** The
[Signal K plugin registry](https://github.com/SignalK/signalk-plugin-registry)
scores this package by cloning the default branch and running `npm ci`,
`npm run build`, then `npm test` under `firejail --net=none` with a **60 second
cap**. `test/offline.test.ts` asserts the no-network property, so a stray
request fails locally instead of only in the registry.

**NOAA changes payload shapes without notice.** Capture a dated fixture into
`examples/` before writing a parser, and make the parser accept the old shape
as well as the new one — `parseSolarWind` and `kpRows` in `parse.ts` are the
pattern to copy. It has silently broken published data twice before; history
in
[docs/design-decisions.md](docs/design-decisions.md#noaa-changes-payload-shapes-without-notice).

**How NOAA's endpoints actually behave is measured in
[docs/noaa-products.md](docs/noaa-products.md)** — wire sizes, publish cadence,
the fact that conditional GET never returns a 304 at a realistic poll interval,
and that files are rewritten in place so a read can land mid-write. That file is
the source of truth and carries the date of each measurement. Don't restate its
numbers here or in a source comment, and don't reason about what NOAA probably
does: re-run `scripts/measure-noaa.mjs`.

The one invariant worth stating outside it: `firstJsonValue` in `parse.ts`
recovers the complete leading value of a torn payload and `readJson` in
`noaa/client.ts` uses it as a fallback after a strict parse fails. **Never
extend that to recover a truncated value.** There is no complete value to
recover, and publishing half a payload as though it were whole is worse than
skipping a poll.

**`/products/alerts.json` is a rolling 30-day archive, not a list of current
conditions.** Publish one path per **message code** under `ALERTS_BASE`, only
while the message is in force, and set withdrawn ones back to `normal`.
`currentAlertNotifications` in `parse.ts` owns that; don't reintroduce a
per-message loop in the product
([#45](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/45) —
argument in
[docs/design-decisions.md](docs/design-decisions.md#alerts-are-keyed-by-message-code-not-serial-number)).

**Every notification goes through `methodForState`, and loudness is
controlled only by three ordered thresholds — `alarmLevel` (sounds),
`popupLevel` (visible, silent) and `listLevel` (listed, silent).** State is
the only input; don't add a per-method override. `ALARM_NEVER` is the one
value above a threshold that isn't a mistake. Default mapping: 0 `nominal`,
1–2 `normal`, 3 `alert` (empty method array), 4 `warn` (visual), 5 `alarm`
(visual + sound) — don't make it louder without a frequency argument. Keep
explicit thresholds independent; derive an absent threshold from the level
above
([#71](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/71),
[#120](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/120),
[#126](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/126)
— argument in
[docs/design-decisions.md](docs/design-decisions.md#loudness-is-three-ordered-thresholds-not-one)).

**Zone metadata generates notifications.** signalk-server's `src/zones.ts`
watches any path with `meta.zones` and raises `notifications.<path>` on zone
*transitions*. Its matcher is half-open (`value >= lower && value < upper`)
and `Infinity` is not representable in JSON, so a top zone must **omit**
`upper` rather than set it to `Infinity`, or the highest value matches nothing
at all. The metadata's `alertMethod` / `warnMethod` / `alarmMethod` set the
notification's `method` array independently of its `state`, which is how a
level is visible in the UI without interrupting the user.

**In the panel, the three thresholds are lines drawn across the ladder, not
dropdowns**, and the table showing the consequence of the setting *is* the
setting. `withLevel` is the panel's clamp; `config-panel.test.ts` pins that
nothing it can produce is a triple `settingsFrom` would rewrite. Argument in
[docs/design-decisions.md](docs/design-decisions.md#thresholds-are-lines-on-the-ladder-not-dropdowns).

**Signal K wants SI units.** Solar wind speed in m/s (NOAA gives km/s), Bt and
Bz in Tesla (NOAA gives nT), probabilities as 0–1 ratios with `units: "ratio"`
(NOAA gives whole percents). Dimensionless indices such as the G/S/R levels and
Kp carry **no** `units` key — the admin UI renders the string verbatim, so
`units: "none"` displays as "2 none".

**Never publish `NaN`.** Return `null` from a parser instead. Several fixtures
exist specifically to pin this.

**A global grid is fetched whether or not the vessel has a position.** Aurora
and D-RAP both buy one grid covering the whole globe, so nothing about the
fetch waits on a fix. The grid is cached (`src/cache/`) and the value at the
vessel is published *out of* it: `refresh()` returns `'awaiting-position'`, and
the scheduler retries through `publishFromCache()` rather than `refresh()`, so
waiting for GPS never becomes repeat NOAA traffic. Those retry timers are a
separate map from `productTimers`, because membership of that map is what says
a product is scheduled and a manual refresh must not make it one. Argument in
[docs/design-decisions.md](docs/design-decisions.md#a-global-grid-is-worth-fetching-before-there-is-anywhere-to-index-it).

**`auroraEnabled` and `drapEnabled` govern the schedule, not the capability** —
`aurora-refresh` and `drap-refresh` fetch whether or not the product is
scheduled, since a press is not the plugin's own initiative. Three things
follow and none are optional: `start()` only publishes metadata for products it
schedules, so an unscheduled product's refresh route publishes its own
`metadata()` before the first value; a successful manual fetch defers the next
scheduled run by a full interval, and `refreshOnce` holds one refresh per
product so a second caller joins it rather than starting its own; and a
`refresh()` that returns without publishing is not a success — the route diffs
the cache's `fetchedAt` and answers 502 rather than claim a refresh that didn't
happen. The webapp's own polling never turns into a NOAA fetch;
`plugin.test.ts` pins that an on-demand fetch starts no schedule of its own.
Argument in
[docs/design-decisions.md](docs/design-decisions.md#auroraenabled-and-drapenabled-govern-the-schedule-not-the-capability).

**The advisory outlook is also published as plain data.**
Beyond the notification-vs-fetch split above, each new bulletin publishes
plain data to `environment.noaa.swpc.advisory_outlook` regardless of
`sendAdvisoryOutlook` (deduped against the cache, so the 15-minute tight poll
doesn't republish an unchanged bulletin — except once, forced, if the path is
still empty, so an install upgrading straight into this feature isn't left
waiting for next Monday). `expireIfStale` stands the notification down once
it is more than `WEEK_MS + 2 * DAY_MS` past its own issue date, not flat
`WEEK_MS`: our own fixtures show consecutive issues up to 7d3h25m apart, so a
flat week flaps the notification weekly on a healthy install. The same age
check gates re-raising, not just expiry — a fetch that keeps turning up the
same already-expired bulletin must not undo `expireIfStale`'s stand-down on
the very next tick. Argument in
[docs/design-decisions.md](docs/design-decisions.md#the-advisory-outlook-is-also-published-as-plain-data).

**Predicted-vs-measured is compared in the webapp, not in the plugin, and its
verdict waits for a full 24 hours.** `src/telemetry.ts` serves the two halves
of the cross-check keyed by the same `subPath` and compares nothing; where the
line falls is a presentation decision, and `public/diagnostics.js` owns it.
There are two thresholds and they are not interchangeable: **±50% on one
endpoint's bytes-per-fetch** (no 24-hour gate, but three successful fetches
required before a row is judged; set loose because the flares and alerts
payloads genuinely track the weather) and **±25% on the
total** (set tight, because the total's only real movers are structural).
**The total is not judged until `hoursCovered` reads 24** — the meter starts
empty at every plugin start and the aurora grid arrives in 147 KB lumps, so
judging a partial window would raise the alarm after every restart, and
pro-rating does not fix it. A row whose `wireBytes` came back
`estimated` — no `Content-Length`, so a decoded size stood in, which is every
JSON endpoint in a browser — is compared against nothing at all, and one of
those suppresses the total's verdict too: a decoded size is roughly ten times a
cost, and judging one against a declared wire size reports a tenfold
over-fetch on a healthy plugin. Don't collapse the two thresholds into one,
don't move the comparison into the route, don't drop the window gate, and don't
compare an estimated size to a declared one. Argument in
[docs/design-decisions.md](docs/design-decisions.md#predicted-vs-measured-has-two-thresholds-and-one-window-gate).

**The map's data goes through `public/mapRaster.js`; everything with a
measurable edge is drawn vectorially over it.** One canvas — the products are
layers, the projection and the extent are controls — and the rasteriser walks
destination pixels back through the projection, which is what keeps the
projection a parameter rather than an assumption
([one map](docs/design-decisions.md#one-map-the-products-are-layers-the-projection-is-a-control)).
The panel paints its own dark ground, not the page's, because NOAA's colorbar
was sampled against a black globe
([dark ground](docs/design-decisions.md#the-map-draws-on-its-own-dark-ground));
both D-RAP surfaces draw that colorbar, with the marine SSB band edges as
contours over it rather than as a palette
([colorbar](docs/design-decisions.md#both-d-rap-surfaces-draw-noaas-colorbar-the-bands-are-contours-over-it)).

**The webapp's map takes its geography from `public/geo.js`; `tiles.ts` draws
none.** A grid of numbers without geography is not a map, and no chart
source Signal K can offer works here — they are all Web Mercator, which cannot
show a pole. The chart overlay is the opposite case: it sits on the user's own
charts, so a second coastline on top of theirs would be a bug. The asset is
the `coastlines` and `coast-wright` packages (extracted from this plugin),
vendored into `public/` on `prebuild`/`prepare` by `scripts/sync-coastline.mjs`
in the icon pattern; `test/coastline.test.ts` pins its size
ceiling, which is the whole argument for shipping it
([#32](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/32)).
Drawing it splits in two: coast-wright's `limn` takes `x(lon)` and `y(lat)` as
*separate* functions, which only a cylindrical projection can satisfy, so the
flat view goes through the library and `strokeRings` in `public/spaceMap.js`
strokes the azimuthal one against the antipode instead. Argument in
[docs/design-decisions.md](docs/design-decisions.md#every-webapp-map-draws-its-own-coastline-the-chart-overlay-draws-none).

**The browser demo is the shipping page, not a copy of it.**
`scripts/build-demo.mjs` copies `public/index.html` itself and substitutes
`demo/signalk.js` for `signalk.js` — that one seam is why the demo runs the
real page unchanged, and `test/webapp-seam.test.ts` fails if the page regrows
a `fetch`, a `WebSocket` or a server URL of its own. **Three things sit behind
that seam, not two**: a Signal K server, the saved capture, and — on `?live` —
the plugin's own compiled product modules fetching NOAA from the visitor's tab
(`src/browser/`, copied into the site under `plugin/` from `dist/`). Live is
opt-in and the snapshot stays the default, because a public page must not spend
a fresh 927 KB aurora grid per visit; the import is dynamic so a snapshot
visitor downloads none of it. The browser drives `PRODUCTS` out of
`src/products/registry.ts` rather than `index.ts`, which owns the filesystem
through the routes and the tile renderer — `test/browser-closure.test.ts` walks
`src/browser/` and fails if that edge comes back. The browser client is
`createClient` with `conditionalGet` and `userAgent` off, never a second
implementation. **Don't fork
`index.html`, and don't hand-list the copied files** — the demo's framing is
*appended* as one script tag (`demo/chrome.js`, which may say what the page is
and may not change what it draws), and the file set is the page's transitive
import closure. The snapshot carries plugin **route bodies** (`grids`,
`routes`) as well as vessel-tree `values`, because the routes' shapes are not
the published paths' shapes. The capture runs from a fixed demo position, and
that position is a stated viewpoint, not a boat. It runs with the aurora,
D-RAP and GOES flux products switched **on** and saves those settings as the
`/status` body, because the page reads `status.settings` to describe how
the plugin is running — a snapshot that carries a product's data while claiming
its switch is off states the opposite of the truth. And **`demo/signalk.js`
owns the page's clock**: it shifts `Date.now()` and the bare `new Date()` onto
the captured instant, leaving `new Date(iso)` alone, or the page's own
three-hour `STALE_MS` brands the demo "STALE DATA" from one afternoon after
capture onwards
([#199](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/199),
[#239](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/239)
— argument in
[docs/design-decisions.md](docs/design-decisions.md#the-demo-is-the-shipping-page-not-a-copy-of-it)
and
[the demo owns the clock](docs/design-decisions.md#the-demo-owns-the-clock)).

**Tile rendering must not block the event loop.** Render tiles async, one at a
time — `Promise.all` over tiles is worse than a blocking loop, since it runs
every rasterize synchronously before awaiting anything. This is a plugin
inside somebody's navigation server; it does not get to stall it. Measurements
in
[docs/design-decisions.md](docs/design-decisions.md#tile-rendering-must-not-block-the-event-loop).

**`main` must stay in package.json.** The server loads plugins with
`require()` on an absolute directory path, and Node's CommonJS resolver
ignores `exports` in that case. Removing `main` reintroduces
[#1](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/1) —
argument in
[docs/design-decisions.md](docs/design-decisions.md#main-must-stay-in-packagejson).

**The icon lives in two places for two different readers, and
`public/icon.svg` is the generated one** — `scripts/sync-icon.mjs` writes it on
`prebuild` and `prepare`, and it is gitignored like `dist/`. Don't commit a
second copy, and don't reintroduce a symlink: npm's packlist skips symlinked
files. `icon.test.ts` fails if the wiring comes undone; argument in
[docs/design-decisions.md](docs/design-decisions.md#the-icon-lives-in-two-places-and-the-second-copy-is-generated).

## Conventions

No semicolons, two-space indent, single quotes — run `npm run format`
(prettier, configured in `.prettierrc`); `npm run format:check` verifies.
Comments explain *why*, not what. The rest is in [AGENTS.md](AGENTS.md).

## Local development

```shell
npm install && npm run build && npm test
```

**The procedures — running against a real server, the webapp mocks, the
screenshot scripts — are in [docs/development.md](docs/development.md). Read
it before starting a server or working against a shared instance.** What
follows is only what bites before you get that far.

**`~/signalk-server` and `~/.signalk` already exist on this machine and are
meant to stay.** Check (`ls ~/signalk-server/dist`) before doing anything else
here; don't re-clone or rebuild from scratch, and don't start a fresh scratch
config directory rather than adding to `~/.signalk`. `~/.signalk` is the
integration environment; symphony's config mirrors the real boat and is
reference-only; `~/.signalk-dev` is stale. A Docker Signal K installed from
the published npm package is the third, and answers a different question —
real released behaviour, not this checkout's.

**These are shared instances, not one per session.** `~/.signalk` listens on
**3010**; **3000** and **3001** belong to `~/symphony` (Signal K and Grafana),
whose compose files are the authority — a running container can lag them.
Before starting a server or working against the Docker instance, check for and
create `~/.signalk/locks/dev-server.lock` or `docker-signalk.lock` (one line:
who, when, why), remove it when done, and treat someone else's as a hard stop
rather than a suggestion. The lock says who is using the server and why, not
which port a conflict pushed you onto — if a port collides, fix the port.
Start detached, or the server dies with the shell that launched it, and never
leave a `while true; do npm start; done` supervisor behind.

**The shared server runs whatever branch this repo has checked out**, from
whatever is in `dist/` — gitignored, so a branch switch leaves the previous
build in place until you rebuild. Leave the repo on `main` and rebuilt when
you finish, do feature work on a branch knowing the shared server follows you
onto it, and never leave it parked on a branch with a broken build.

**`~/.signalk/node_modules/signalk-noaa-space-weather` is a symlink to this
repo, and it should stay one.** The server finds plugins by scanning
`node_modules/`, not by reading `package.json`, so a rebuild here reaches it
with no reinstall. Don't run `npm install` in that directory: it replaces the
symlink with a copy, and it re-resolves every caret range in there and can
upgrade plugins you weren't touching. Check which one you have before
wondering why a change did not show up. Argument in
[docs/design-decisions.md](docs/design-decisions.md#the-dev-server-finds-this-plugin-by-symlink).

## The webapp without a server

```shell
npm run dev:webapp        # http://127.0.0.1:8731, or pass a port
```

`scripts/mock-webapp.mjs` serves `public/` and answers the Signal K paths it
understands with fabricated data, so the real
`heroState`/`renderTimer`/`renderKp` decide what renders; a switcher strip
picks between seven states that are mostly impractical to reach against a live
server. `--upstream <base-url>` trades those for a running server's real
numbers. `scripts/screenshots/` is a **separate npm package** — Playwright
would blow the registry's offline `npm ci` and its 60 second cap — and holds
`capture.mjs`, which rewrites the five README PNGs against a live server, and
`states.mjs`, which walks every mock state into a gitignored `.hero-states/`
contact sheet. All of it is in
[docs/development.md](docs/development.md#working-on-the-webapp-without-a-server).

**`scripts/mock-webapp.mjs` must keep having no dependencies and no
importers** — it has to stay invisible to the registry's offline `npm ci`,
build and test run. Reach for it instead of hand-editing the DOM in devtools,
and add a state there rather than faking one in the console.

## Releasing

**No pull request carries a version.** `release-please` owns the number, the
CHANGELOG and the tag, from `.github/workflows/release-please.yml` and
`release-please-config.json`. Nothing else in the repo knows about releasing.

A merge to `main` updates a standing `chore: release` pull request — the bump
and the changelog entry, assembled from Conventional Commit subjects since the
last tag. **Merging that pull request is the release.** Work batches into it
until you do; there is no timer and nothing decides on your behalf. Edit its
CHANGELOG diff before merging when a release deserves notes written rather than
assembled.

**Squash-merge it.** `main` requires signed commits and release-please's are
unsigned; a squash replaces them with one commit signed by GitHub's key. A
merge commit carries the unsigned originals through and is rejected.

The version policy is two config keys, not prose:
`bump-patch-for-minor-pre-major` keeps `feat` a patch and
`bump-minor-pre-major` makes a breaking change a minor, for as long as this is
pre-1.0 — the standing bias against minting minors, enforced instead of asked
for. See [AGENTS.md](AGENTS.md).

Publishing is still npm OIDC trusted publishing with no token anywhere.
release-please runs as a GitHub App (not the default `GITHUB_TOKEN`) so its
own release pull request gets real CI, and its tag push therefore *does*
trigger workflows — which is exactly why `publish.yml` has no `push: tags`
listener of its own: one would race the explicit dispatch.
`release-please.yml` creates the tag and the GitHub Release, then dispatches
`publish.yml` explicitly, the same path a human uses by hand. Argument in
[docs/design-decisions.md](docs/design-decisions.md#release-please-owns-the-version-no-pull-request-does).
