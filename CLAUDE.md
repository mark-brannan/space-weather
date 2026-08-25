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

**NOAA changes payload shapes without notice.** This has happened at least
twice and both times it silently broke published data:

- the solar wind summaries went from `{"Bt": 5, "Bz": -3}` to
  `[{"bt": 4, "bz_gsm": -1}]`, which made the plugin publish `NaN` for months
- the planetary K-index forecast alternates between a header-row table and a
  list of records

So: **capture a dated fixture into `examples/` before writing a parser**, and
make the parser accept the old shape as well as the new one. `parseSolarWind`
and `kpRows` in `parse.ts` are the pattern to copy.

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
conditions.** A couple of hundred messages per payload (docs/noaa-products.md
has the counts), nearly all describing events that ended weeks ago, and NOAA
mints a fresh serial number every time it extends or continues one condition.
Publishing a notification per entry keyed on the serial number — which is what
0.11 and earlier did — raised a permanent notification for every one of them at
once and made a Pi 5 unusable (issue #45). So: one path per
**message code** under `ALERTS_BASE`, only while the message is in force, and
withdrawn ones actively set back to `normal`. `currentAlertNotifications` in
`parse.ts` owns all of that and is the thing to change; don't reintroduce a
per-message loop in the product.

**Every notification goes through `methodForState`.** It is the single policy
for whether a state interrupts the user, and `zoneMethods` is derived from it
so a NOAA level reads the same whether it arrives as a zone transition or as a
message. **State is its only input**, and the two thresholds below are the only
control over loudness. Don't add a per-method override: it mutes every product
at once, it is a preference about the notification client rather than about
space weather, and measured against the fixtures a pair of visual/sound
checkboxes changed 0 of 4 notifications on a quiet day.

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
days per 11-year solar cycle. Alarming below level 3 is noise on a boat. Default
mapping: 0 `nominal`, 1–2 `normal`, 3 `alert` with an **empty method array**, 4
`warn` (visual), 5 `alarm` (visual + sound). Do not make this louder without a
frequency argument.

**That conservatism is about notifications, never about what the page says.**
The webapp describes conditions in NOAA's own vocabulary — None / Minor /
Moderate / Strong / Severe / Extreme, `SEV_WORDS` in `index.html`, mirroring
`SCALE_WORDS` in `parse.ts` — because "what is the sky doing" is a fact and
"how loud should this be" is a preference. The two got answered with one word
once: the banner carried the notification-state ladder, so an R2 that NOAA's
front page and the WWV bulletin both called *moderate* rendered as **Quiet**,
in the quiet green, with `Normal` under the badge (issue #126). So `heroState`
describes any level in force, `ALERT_FLOOR` only decides precedence there, and
level 2 has a colour step of its own. `quiet` means level 0 in force *and*
level 0 over 24 hours, and `hero.test.ts` pins that nothing else reaches it.

**The hero reads both observed scale paths, and needs both.**
`observations/latest` is an instantaneous sample that is 0 in every payload in
`examples/`, including the day whose 24-hour maximum was G4 (issue #120);
`observations/24_hours_maximums` is what NOAA's front page and WWV report as
the day's condition. So the maximum decides what the banner *says* and the
instantaneous reading decides whether it is still running — `storm` versus
`recent`, or above the floor, `storm` versus `all-clear`. Leading from either
one alone puts the page back to reporting R0 through an R2.

**Loudness is two thresholds, each naming the level its own band opens at** —
`alarmLevel` sounds, `popupLevel` is visible and silent. Both are boundaries,
and that is the point of there being two: **a single anchor with the quieter
rungs derived from it cannot be labelled honestly**, because whatever the
dropdown claims, the level below it is doing something too. Every candidate
wording for the old one-knob control was false somewhere — "Notify me from 5"
notified from 3, and "Sound an alarm at…" named a sound the "Never" option had
just removed (issue #71). Don't collapse them back into one.

The two are ordered — `popupLevel` is never louder than `alarmLevel`, since
above it the popup band would name levels the alarm has already taken — and
`settingsFrom` clamps the pair on the way in whatever the panel saved. Both
offer the full scale plus `ALARM_NEVER`. Neither range is clipped to the levels
a skipper would sensibly pick: clipping would also strand an existing config
that asked for something outside it.

**`ALARM_NEVER` is exempt from that clamp on `popupLevel`**, and the panel does
not drag the alarm up to meet it either. It is the one value above the alarm
that is not a mistake: the rest are inert by accident, that one asks for no
popup band at all. Clamping it redraws a chosen "Never" as a level on the next
load — the exact dishonest control the split was for — and, below `ALERT_FLOOR`
where the quiet rung follows the popup band down, it changes behaviour too.

**`ALERT_FLOOR` is level 3, and nothing turns it off.** A G3 is several a year,
so there is no setting at which one should leave no trace — and `alert` carries
an empty method array, so being listed costs the user nothing but a line. The
quiet rung also follows the popup band down below the floor, rather than
leaving a gap of `normal` between two adjacent bands.

`ALARM_NEVER` is a value one past the scale, so no level reaches that band: on
`alarmLevel` it removes the sound, on `popupLevel` the popup. It is named
"Never" in both dropdowns and needs no explanation of what still happens, which
is exactly what the split bought — the other dropdown says so in its own words.

**In the panel the two thresholds are lines drawn across the ladder, not
dropdowns.** A threshold is a boundary, so it is drawn as one: the line rests on
the bottom edge of the row its band opens at, and the band is everything above
it. `ALARM_NEVER` rests above the top row, where the band is empty — "Never" is
reached by running out of storms rather than by picking a word for it. The table
that showed the consequence of the setting *is* the setting, so nothing on
screen is neither a decision nor a result of one.

Two things about that are load-bearing. **The line is a CSS border on the cells
of its row**, so the browser places it and nothing measures a row height or
listens for a resize; it goes on the cells rather than the `tr` because
Bootstrap draws table borders cell by cell and a border on the row loses to it.
And **the grips sit in a lane per kind**, so two lines landing on one row sit
side by side rather than on top of each other, and neither grip slides sideways
as it moves up and down.

The grips are `role="slider"` with `aria-valuetext`, because the value is on a
scale and "5" on its own says nothing about what happens at 5. `stepLevel`
returns `null` for any key the grip does not claim, which is what keeps Tab
working — a boundary that swallowed it would be a keyboard trap. The dropdowns
still exist in the JSON schema and are what a server renders when the panel
fails to load, so both controls have to resolve a pair the same way:
`withLevel` is the panel's clamp and `config-panel.test.ts` pins that nothing it
can produce is a pair `settingsFrom` would rewrite.

Do not reintroduce a control that derives *upward* from a "worth your
attention" pivot. That runs off the end of a five-level scale: the pivot at 4
could never reach `alarm`, and at 5 never even `warn`, so the two
loudest-*sounding* choices in the dropdown were the two that silenced the
plugin. `stateForScaleValue` carries the argument, and `zones.test.ts` pins
that no threshold pair silences the level it names and that lowering either one
is monotonically louder.

**Signal K wants SI units.** Solar wind speed in m/s (NOAA gives km/s), Bt and
Bz in Tesla (NOAA gives nT), probabilities as 0–1 ratios with `units: "ratio"`
(NOAA gives whole percents). Dimensionless indices such as the G/S/R levels and
Kp carry **no** `units` key — the admin UI renders the string verbatim, so
`units: "none"` displays as "2 none".

**Never publish `NaN`.** Return `null` from a parser instead. Several fixtures
exist specifically to pin this.

**`auroraEnabled` governs the schedule, not the capability.** It says what the
plugin may spend on its own initiative; a press is not the plugin's own
initiative. So `aurora-refresh` fetches whether or not the product is
scheduled, and the setting being off is exactly the case it exists for —
otherwise the only route to one aurora reading is to turn the recurring fetch
on, wait out an interval, and turn it off again, which is four steps and leaves
a recurring cost behind when the last one is forgotten. Three things fall out of
that and none are optional:

- `start()` publishes `metadata()` only for the products it schedules, so the
  route publishes aurora's itself before the first value. Without it the
  probability lands on a path with no units, no zones and no display name.
- A successful manual fetch defers the next scheduled run by a full interval.
  The payload has just been bought; a refresh a minute before the tick must not
  buy it twice, which is the same argument the two-hour default rests on.
  Deferring cannot cover a run whose timer has already fired, so `refreshOnce`
  holds one refresh per product and a second caller joins it rather than
  starting its own.
- The cooldown counts fetches, not presses — a scheduled one holds it down too
  — and `'not-ready'` refunds it: the position check is ahead of the fetch, so
  nothing went to NOAA and there is nothing to bound. That case lands on a boat
  still waiting for its first fix, which is the worst one to make wait another
  minute.
- A `refresh()` that returns without publishing is not a success. It returns
  normally when the payload carried no usable grid, so the route compares the
  cache's `fetchedAt` across the call and answers 502 when nothing new landed;
  otherwise the button reports a refresh that did not happen, over a reading
  that has not moved.

The webapp may never turn its own polling into a NOAA fetch — the map draws
from cache, the poll reads Signal K, and only a press reaches NOAA.
`plugin.test.ts` pins that an on-demand fetch starts no schedule of its own.

**Tile rendering must not block the event loop.** Measured on a 20-tile
screenful: `zlib.deflateSync` back-to-back blocks for the whole 75ms with zero
timer ticks, while awaiting the async form one tile at a time holds the worst
lag to ~2.5ms for 11ms more wall clock. `Promise.all` over tiles is worse than
either — it runs every rasterize synchronously before awaiting anything. This
is a plugin inside somebody's navigation server; it does not get to stall it.

**`main` must stay in package.json.** The server loads plugins with
`require()` on an absolute directory path, and Node's CommonJS resolver ignores
`exports` in that case. Removing `main` reintroduces issue #1.

**The icon lives in two places for two different readers, and the second copy
is generated.** The App Store resolves `signalk.appIcon` server-side against
the package root, so `./icon.svg` works there. The admin Webapps page reads the
*top-level* `appIcon` and loads it as a plain URL from the browser, and
`mountWebModules` in signalk-server serves `public/` as the webapp's root when
that directory exists — so the file has to be at `public/icon.svg` or the page
renders a broken image. **A symlink cannot be that file**: npm's packlist skips
symlinked files instead of following them, and the copy is simply missing from
the tarball. `scripts/sync-icon.mjs` generates it on `prebuild` and `prepare`;
it is gitignored like `dist/`, and `icon.test.ts` fails if the wiring comes
undone. Don't commit a second copy, and don't reintroduce the symlink.

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
itself, walks every state it declares in both themes, and writes a gitignored
`.hero-states/` with the PNGs and an `index.html` contact sheet. Nothing is
committed — these are review material for one pull request, and pinning them
would mean recapturing on every unrelated change to the page.

```shell
node scripts/screenshots/states.mjs        # --out, --port, --theme
```

It reads the state list off the mock's own startup line rather than importing
it, so a state added there appears here with no second edit. The clip is the
statusbar and the hero tile together, never one without the other: the chip and
the countdown live in the first and the words in the second, and #126 was
precisely a disagreement between the two.

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
