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

**Zone metadata generates notifications.** The server (`signalk-server`
`src/zones.ts`) watches any path with `meta.zones` and raises
`notifications.<path>` on zone *transitions*. Its matcher is half-open —
`value >= lower && value < upper` — and `Infinity` is not representable in
JSON, so a top zone must **omit** `upper` rather than set it to `Infinity`,
or the highest value matches nothing at all. `alertMethod` / `warnMethod` /
`alarmMethod` on the metadata control the notification's `method` array
independently of its `state` — that's how a level can be visible in the UI
without interrupting the user.

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
only publishes metadata for products it schedules, so when aurora isn't one
of them the `aurora-refresh` route has to publish aurora's `metadata()`
itself, before the first value; a successful manual fetch defers the next
scheduled run by a full interval, and `refreshOnce` holds one refresh per
product so a second caller joins it rather than starting its own; a
`'not-ready'` result refunds the cooldown; and a `refresh()` that returns
without publishing is not a success — the route diffs the cache's
`fetchedAt` and answers 502 rather than claim a refresh that didn't happen.
The webapp's own polling never turns into a NOAA fetch; `plugin.test.ts`
pins that an on-demand fetch starts no schedule of its own.
Argument in
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

**The icon lives in two places for two different readers, and the second copy
is generated.** The App Store resolves `signalk.appIcon` server-side, but the
admin Webapps page loads the top-level `appIcon` as a plain URL from the
browser, so it also needs `public/icon.svg`. `scripts/sync-icon.mjs` generates
that copy on `prebuild` and `prepare` — it is gitignored like `dist/`, and
`icon.test.ts` fails if the wiring comes undone. Don't commit a second copy,
and don't reintroduce a symlink: npm's packlist skips symlinked files, so it
would go missing from the tarball. Argument in
[docs/design-decisions.md](docs/design-decisions.md#the-icon-lives-in-two-places-and-the-second-copy-is-generated).

## Conventions

No semicolons, two-space indent, single quotes — run `npm run format`
(prettier, configured in `.prettierrc`); `npm run format:check` verifies. Comments
explain *why*, not what. Tests assert behaviour — values, states, paths, unit
conversions, boundaries — never display strings.

## Local development

```shell
npm install && npm run build && npm test
```

A Docker Signal K installed from the published npm package backs any
"browse the live server" research — read-only checks against real, released
behavior, not this checkout's uncommitted changes. Don't restart,
reconfigure, or write through it without checking who else might be using
it first.

**Ports 3000 and 3001 belong to `~/symphony`, and its compose files are the
authority — read them, don't guess.** `compose-signalk.yml` publishes Signal K
on **3000** (the SignalK convention; mDNS and clients default to it) and
`compose-grafana.yml` publishes Grafana on **3001**. That allocation is
deliberate and each file carries the reason inline. A running container can
lag it — port bindings are fixed when a container is *created*, so a
`docker start` on an old container keeps the old mapping and the live box
disagrees with the committed intent until it is recreated. Trust the compose
file over `docker ps`, and check both before concluding anything about a port.

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
directory, so plain `bin/signalk-server` uses it with no environment variables
at all. **It listens on 3010**, set as `port` in its own `settings.json` —
clear of both 3000 and 3001 whichever way symphony's stack is currently
running, which is the whole point of picking it. 3000 is the signalk-server
default and collides with too much else, so nothing here should be on it.
`PORT` still overrides, which is what the `nmea-from-file`
recipe below relies on. Feature work here is almost always additive —
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

**`~/.signalk/node_modules/signalk-noaa-space-weather` is a symlink to this
repo, and it should stay one.** A rebuild here reaches the server with no
reinstall, which is the whole point. Recreate it with `ln -s` if something
replaces it — an `npm install` in that directory will, since the `file:`
dependency entry installs as a *copy* of the packed files instead. (Don't
"fix" that with `npm link`: it writes a `link:` spec that npm 9 refuses to
install at all with `EUNSUPPORTEDPROTOCOL`, which is what broke
`~/.signalk-dev`.) Check which one you have before wondering why a change
did not show up.

The corollary, and it bites across parallel sessions: **the server runs
whatever branch this repo has checked out**, from whatever is in `dist/`
(gitignored, so a branch switch leaves the previous build in place until you
rebuild). So leave the repo on `main` and rebuilt when you finish, do feature
work on a branch knowing the shared server follows you onto it, and never
leave it parked on a branch with a broken build.

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
These are shared instances, not one per session: 3010 is the `~/.signalk`
server, and the published-package Docker instance is whatever port symphony
currently publishes Signal K on. Neither is reliably up — check what is
actually listening before starting anything, the same way you'd check before
touching a shared branch. Coordinate with a lock file: before starting a
server or doing anything live against the Docker instance, check for and
create `~/.signalk/locks/dev-server.lock` or `docker-signalk.lock` (one line:
who, when, why) — remove it when done, and treat someone else's lock file as a
hard stop, not a suggestion. The lock records who is using the server and why; it is not
the place to write down which port a conflict pushed you onto. If a port
collides, fix the port.

Start it detached, or it dies with the shell that launched it:

```shell
cd ~/signalk-server && setsid nohup node bin/signalk-server > /tmp/sk.log 2>&1 < /dev/null &
```

Don't leave a `while true; do npm start; done` supervisor behind. One got
orphaned that way and spent an afternoon respawning every two seconds, losing
on `EADDRINUSE` against the real server and making every port question harder
to answer.

`~/.signalk` has `allow_readonly` **on**, matching `~/symphony/signalk` — check
`allow_readonly` in the relevant `security.json` rather than assuming, since
this has already been documented backwards once. So a plain GET against the
data API needs no token at all.

Writes and the admin API still do. There is an approved read-only device
`claude-dev-tools` in `~/.signalk/security.json`, and
`bin/signalk-generate-token` only signs user ids, not device ids, so getting a
working token is a real step — ask rather than minting an admin one.

If the admin UI 500s on `/admin/`, npm has hoisted `@signalk/server-admin-ui`
somewhere the server doesn't look; symlink it into
`node_modules/signalk-server/node_modules/@signalk/`.

## Working on the webapp without a server

```shell
npm run dev:webapp        # http://127.0.0.1:8731, or pass a port
```

`scripts/mock-webapp.mjs` serves `public/` with a state switcher appended and
answers the ten Signal K paths it understands with fabricated data, so the real
`heroState`/`renderTimer`/`renderKp` decide what renders. A strip at the
bottom of the page switches between five states: quiet, G3 forecast, G4+S4,
stale, and no-data-since-start. Four of those are impractical to reach
against a live server -- a G4 happens a few times a solar cycle, and the last
one means breaking the plugin on purpose -- which is the whole reason the
file exists. Reach for it instead of hand-editing the DOM in devtools, and
add a state there rather than faking one in the console.

It has no dependencies and nothing imports it. Keep it that way: the plugin
registry clones this repo and runs `npm ci`, `npm run build` and `npm test`
under `firejail --net=none` with a 60 second cap, and this script has to stay
invisible to all three.

The aurora map is deliberately not mocked -- it needs a real grid cache to
draw, and faking one would be mocking `tiles.ts` rather than the webapp -- so
that tile renders its own empty state.

`--upstream <base-url>` trades the five fabricated states for a running
server's real numbers: the same ten paths are proxied there verbatim instead
of going through `payload()`, so a branch's `public/` -- a changed card, new
copy -- can be checked against genuine data without repointing
`~/.signalk/node_modules/signalk-noaa-space-weather` at this worktree, which
would move every other session on that shared server onto this branch's
build too.

```shell
node scripts/mock-webapp.mjs --upstream http://127.0.0.1:3010
```

3010 is the shared dev server described above -- check
`~/.signalk/locks/dev-server.lock` before relying on it being idle, same as
any other use of that instance. `--upstream` and the state switcher are
mutually exclusive; passing it replaces the switcher strip with one naming
the upstream instead.

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

It defaults to the dev server on `http://localhost:3010`, hard-coded in
`capture.mjs`; `SK_URL` or `--url` points it somewhere else. `--only
webapp,aurora-map` limits the run. Which one you want is a real choice, and the
default takes the side of feature work: shots are part of the change that alters
the UI, so capturing them against the published package means a PR that rewrote
a panel ships a picture of the old one. Point `--url` at the published-package
Docker instance when the point is to match what a registry installer sees
instead — and read symphony's compose files for its port rather than assuming
one.

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

## Pictures for a webapp pull request

`scripts/screenshots/states.mjs` is the other half of that package, and the two
answer different questions. `capture.mjs` shoots a live server and rewrites the
five PNGs the README ships; `states.mjs` starts `scripts/mock-webapp.mjs`
itself, walks every state it declares, and writes a gitignored
`.hero-states/` with the PNGs and an `index.html` contact sheet. Nothing is
committed — these are review material for one pull request, and pinning them
would mean recapturing on every unrelated change to the page.

```shell
node scripts/screenshots/states.mjs        # --out, --port, --theme
```

Defaults to dark only, since that's the only rendering worth reviewing on a
pull request; pass `--theme light` for a one-off check of the light theme,
which the app still supports.

It reads the state list off the mock's own startup line rather than importing
it, so a state added there appears here with no second edit. The clip is the
statusbar and the hero tile together, never one without the other: the chip and
the countdown live in the first and the words in the second, and #126 was
precisely a disagreement between the two.

## Releasing

Publishing happens from CI via npm OIDC trusted publishing — tag `vX.Y.Z` and
push. No npm token should ever live on a developer machine.

The number is decided **before** the merge and the release happens **after** it,
and those are deliberately not the same moment. `.husky/pre-commit` writes the
patch at commit time; `.github/workflows/version-gate.yml` blocks a pull request
that changed what ships without one. The hook is the convenience, the gate is
the guarantee — and only while the ruleset requires the `version` check, since a
red gate nothing requires can be merged past. `auto-version.yml` catches on
`main` what the gate should have caught, and fails loudly rather than exiting 0.
None of them write to `main`, so the ruleset keeps requiring a pull request and
a signed commit for every change.

**Ahead of the latest tag, never merely different from it.** A stale branch
differs from it too, which is how #123 squash-merged at a version already on
npm and never published.

**A merge does not publish. `release.yml` does, on a debounce.** It runs hourly
and tags `main` only once nothing has merged for `RELEASE_WINDOW_HOURS`, so a
busy afternoon ships one release when the afternoon ends instead of one per
pull request — 59 releases in the first 24 days is what the merge-publishes
design cost. A `workflow_dispatch` run skips the wait and flushes whatever is
pending immediately; it skips nothing else, since the tag is still what says
what has already been published.

**So the gate requires a version past the latest tag and pointedly not past
`main`'s own.** Between a merge and the window closing, `main` sits at a version
that has not shipped, and a second pull request is meant to *join* it there.
That shared number is the batching, and it is why released versions stay
contiguous instead of skipping the ones a second concurrent branch would
otherwise have minted. Only a tagged version is spent. Do not reintroduce a
check that a pull request be ahead of the base — it was there when every merge
published, and under the window it is exactly what puts the gaps back.

All of the above read one file, `scripts/publish-impact.sh`, pinned by
`test/publish-impact.test.ts`.
