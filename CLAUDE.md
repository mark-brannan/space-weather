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

**To add a data source: write `src/products/<name>.ts` implementing `Product`,
add it to `PRODUCTS` in `index.ts`.** Nothing else. That is the whole reason
for this shape.

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
controlled only by two ordered thresholds — `alarmLevel` (sounds) and
`popupLevel` (visible, silent).** State is the only input; don't add a
per-method override. `ALERT_FLOOR` (level 3) never turns off; `ALARM_NEVER` is
the one value above the alarm that isn't a mistake. Default mapping: 0
`nominal`, 1–2 `normal`, 3 `alert` (empty method array), 4 `warn` (visual), 5
`alarm` (visual + sound) — don't make it louder without a frequency argument,
and don't derive one threshold from the other
([#71](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/71),
[#120](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/120),
[#126](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/126)
— argument in
[docs/design-decisions.md](docs/design-decisions.md#loudness-is-two-ordered-thresholds-not-one)).

**Zone metadata generates notifications.** signalk-server's `src/zones.ts`
watches any path with `meta.zones` and raises `notifications.<path>` on zone
*transitions*. Its matcher is half-open (`value >= lower && value < upper`)
and `Infinity` is not representable in JSON, so a top zone must **omit**
`upper` rather than set it to `Infinity`, or the highest value matches nothing
at all. The metadata's `alertMethod` / `warnMethod` / `alarmMethod` set the
notification's `method` array independently of its `state`, which is how a
level is visible in the UI without interrupting the user.

**In the panel, the two thresholds are lines drawn across the ladder, not
dropdowns**, and the table showing the consequence of the setting *is* the
setting. `withLevel` is the panel's clamp; `config-panel.test.ts` pins that
nothing it can produce is a pair `settingsFrom` would rewrite. Argument in
[docs/design-decisions.md](docs/design-decisions.md#thresholds-are-lines-on-the-ladder-not-dropdowns).

**Signal K wants SI units.** Solar wind speed in m/s (NOAA gives km/s), Bt and
Bz in Tesla (NOAA gives nT), probabilities as 0–1 ratios with `units: "ratio"`
(NOAA gives whole percents). Dimensionless indices such as the G/S/R levels and
Kp carry **no** `units` key — the admin UI renders the string verbatim, so
`units: "none"` displays as "2 none".

**Never publish `NaN`.** Return `null` from a parser instead. Several fixtures
exist specifically to pin this.

**`auroraEnabled` governs the schedule, not the capability** — `aurora-refresh`
fetches whether or not the product is scheduled, since a press is not the
plugin's own initiative. Four things follow and none are optional: `start()`
only publishes metadata for products it schedules, so when aurora isn't one of
them the `aurora-refresh` route has to publish aurora's `metadata()` itself
before the first value; a successful manual fetch defers the next scheduled
run by a full interval, and `refreshOnce` holds one refresh per product so a
second caller joins it rather than starting its own; a `'not-ready'` result
refunds the cooldown; and a `refresh()` that returns without publishing is not
a success — the route diffs the cache's `fetchedAt` and answers 502 rather
than claim a refresh that didn't happen. The webapp's own polling never turns
into a NOAA fetch; `plugin.test.ts` pins that an on-demand fetch starts no
schedule of its own. Argument in
[docs/design-decisions.md](docs/design-decisions.md#auroraenabled-governs-the-schedule-not-the-capability).

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

`scripts/mock-webapp.mjs` serves `public/` and answers the ten Signal K paths
it understands with fabricated data, so the real
`heroState`/`renderTimer`/`renderKp` decide what renders; a switcher strip
picks between five states that are mostly impractical to reach against a live
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

Publishing happens from CI via npm OIDC trusted publishing — tag `vX.Y.Z` and
push. No npm token should ever live on a developer machine.

The number is decided **before** the merge and the release happens **after**
it. `.husky/pre-commit` writes the patch at commit time (the convenience);
`.github/workflows/version-gate.yml` blocks a pull request that changed what
ships without one (the guarantee, and only while the ruleset requires the
`version` check). `auto-version.yml` catches on `main` what the gate should
have caught, and fails loudly rather than exiting 0. None of them write to
`main`, so the ruleset keeps requiring a pull request and a signed commit for
every change.

**A merge does not publish. `release.yml` does, on a debounce** — hourly, and
it tags `main` only once nothing has merged for `RELEASE_WINDOW_HOURS`; a
`workflow_dispatch` run skips that wait and flushes whatever is pending, and
skips nothing else. **So the gate requires a version ahead of the latest tag —
never merely different from it — and pointedly not past `main`'s own.** A
stale branch differs from the tag too
([#123](https://github.com/mark-brannan/signalk-noaa-space-weather/pull/123));
`main`, between a merge and the window closing, sits at an unshipped version a
second pull request is meant to *join*. Only a tagged version is spent. Do not
reintroduce a check that a pull request be ahead of the base. Argument in
[docs/design-decisions.md](docs/design-decisions.md#a-merge-does-not-publish-releaseyml-does-on-a-debounce).

All of the above read one file, `scripts/publish-impact.sh`, pinned by
`test/publish-impact.test.ts`.
