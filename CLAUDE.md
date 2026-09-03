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
  browser/        the page's data layer with no server under it:
                  live.ts runs the products in a tab, seam.ts serves
                  the page out of the document they publish
```

The same page ships three ways, and none of them is a fork of it:

```
public/index.html   + public/signalk.js   -> the Signal K webapp
                    + demo/signalk.js     -> the GitHub Pages demo   (npm run demo:build)
                    + app/signalk.js      -> the standalone PWA      (npm run app:build)
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

A `Product` declares `schedule` (`observations` or `notifications`), optional
`enabled(settings)` if the user can switch it off, optional `metadata(settings)`
published once per start, and `refresh(ctx)`. Keep parsing in `parse.ts` and
pure — it is what makes the fixtures useful.

## Non-obvious constraints

Settled, not obvious, and has cost a release when violated. Argument for each
is in [docs/design-decisions.md](docs/design-decisions.md) (`[↳]`); this list
is the rule only.

- Tests run with no network, inside 60s (`test/offline.test.ts`). Fixture
  new payload shapes into `examples/` before writing a parser.
- `main` requires signed commits; cloud sessions have no key — run
  `resign-branch.sh <branch>` from a keyed machine, or flag it in the PR body.
- NOAA changes payload shapes with no notice — accept old and new shapes
  (`parseSolarWind`, `kpRows`). [↳](docs/design-decisions.md#noaa-changes-payload-shapes-without-notice)
- Measured NOAA behaviour lives only in
  [docs/noaa-products.md](docs/noaa-products.md) — re-measure with
  `scripts/measure-noaa.mjs`, don't guess or restate it elsewhere.
- `firstJsonValue`/`readJson` recover a torn payload's complete leading
  value, never a truncated one.
- `/products/alerts.json` is a rolling archive, not current conditions — one
  path per message code (`currentAlertNotifications`), never per-message.
  [↳](docs/design-decisions.md#alerts-are-keyed-by-message-code-not-serial-number)
- The collapsed storm notification (`STORM_BASE`) transitions both
  directions, six-hour hold to stand down; watches never raise it.
  [↳](docs/design-decisions.md#the-storm-notification-collapses-by-level-and-rides-a-six-hour-hold)
- Loudness is only three ordered thresholds (`alarmLevel`/`popupLevel`/
  `listLevel`) via `methodForState`; default 3=alert(silent), 4=warn(visual),
  5=alarm(sound) — don't go louder without a frequency argument.
  [↳](docs/design-decisions.md#loudness-is-three-ordered-thresholds-not-one)
- `meta.zones` raises notifications via a half-open matcher — top zone
  omits `upper`, never sets `Infinity`.
  [↳](docs/design-decisions.md#zone-metadata-is-what-turns-a-reading-into-a-notification)
- Config-panel thresholds are lines on a ladder, not dropdowns.
  [↳](docs/design-decisions.md#thresholds-are-lines-on-the-ladder-not-dropdowns)
- SI units only: m/s, Tesla, 0–1 `ratio`; G/S/R/Kp carry **no** `units` key.
  Never publish `NaN` — return `null` instead.
- The grid fetches regardless of vessel position; retries go through
  `publishFromCache()`, never `refresh()`.
  [↳](docs/design-decisions.md#a-global-grid-is-worth-fetching-before-there-is-anywhere-to-index-it)
- `auroraEnabled`/`drapEnabled` gate the schedule, not a manual refresh,
  which always fetches and defers the next scheduled run.
  [↳](docs/design-decisions.md#auroraenabled-and-drapenabled-govern-the-schedule-not-the-capability)
- The advisory outlook publishes as data regardless of
  `sendAdvisoryOutlook`; `expireIfStale` gates both expiry and re-raising.
  [↳](docs/design-decisions.md#the-advisory-outlook-is-also-published-as-plain-data)
- Predicted-vs-measured (webapp only): ±50%/endpoint, ±25%/total, not judged
  until a 24h window fills; `estimated`-bytes rows compare against nothing.
  [↳](docs/design-decisions.md#predicted-vs-measured-has-two-thresholds-and-one-window-gate)
- The Kp chart is one time axis at two spans — a daily bar max must never
  read as a 3-hourly sample; summary from `outlookAhead`, not `…maxKp`.
  [↳](docs/design-decisions.md#the-kp-chart-is-one-time-axis-at-two-spans-not-two-charts)
- The map draws through `mapRaster.js`; projection is a parameter, ground
  is dark in both themes, D-RAP bands are contours over NOAA's colorbar.
  [↳1](docs/design-decisions.md#one-map-the-products-are-layers-the-projection-is-a-control)
  [↳2](docs/design-decisions.md#the-map-draws-on-its-own-dark-ground)
  [↳3](docs/design-decisions.md#both-d-rap-surfaces-draw-noaas-colorbar-the-bands-are-contours-over-it)
- The page is three views over one state object; renderers take their
  container as a parameter, never look one up by id.
  [↳](docs/design-decisions.md#the-page-is-three-views-over-one-state-object-not-three-copies-of-it)
- `radiusDeg` is honoured on the map's shorter axis, clip at the antipode.
  [↳](docs/design-decisions.md#on-the-map-radiusdeg-is-honoured-on-the-shorter-axis-the-clip-is-at-the-antipode)
- Map geography comes only from `geo.js`; `tiles.ts` and the chart overlay
  draw no coastline of their own.
  [↳](docs/design-decisions.md#every-webapp-map-draws-its-own-coastline-the-chart-overlay-draws-none)
- The browser demo is the shipping page: `build-demo.mjs` copies
  `index.html` verbatim through one seam (`test/webapp-seam.test.ts`). Never
  fork it or hand-list its files.
  [↳](docs/design-decisions.md#the-demo-is-the-shipping-page-not-a-copy-of-it)
- The standalone app is the same seam with the device's own position,
  never reaching NOAA on a redraw; its worker precaches the shell only.
  [↳](docs/design-decisions.md#the-standalone-app-is-the-fourth-thing-behind-the-same-seam)
- Tile rendering must stay async, one at a time — never `Promise.all`
  ([↳](docs/design-decisions.md#tile-rendering-must-not-block-the-event-loop)).
  `main` must stay in `package.json` — `require()` on an absolute path
  ignores `exports`
  ([↳](docs/design-decisions.md#main-must-stay-in-packagejson)).
  `public/icon.svg` is generated and gitignored — never commit a second copy
  or a symlink
  ([↳](docs/design-decisions.md#the-icon-lives-in-two-places-and-the-second-copy-is-generated)).

## Conventions

No semicolons, two-space indent, single quotes — `npm run format`
(`npm run format:check` verifies). Comments explain *why*, not what.

- **Scope.** YAGNI/DRY/KISS. No error handling for cases that can't happen;
  validate at the boundaries (NOAA payload, saved config, HTTP request) only.
- **Docs.** Measured facts live only in `docs/noaa-products.md`, never in a
  comment. Docs describe current state, not history — that's `CHANGELOG.md`.
- **Type safety.** `tsconfig.json` has `strict: false` for historical
  reasons — treat it as a convention anyway: no `any` in new code, narrow
  over cast.
- **Performance.** Runs on a Pi 3-5, often on battery. Guard `debug()`
  arguments; publish deltas only when a value changed
  ([#45](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/45)).
- **Configuration.** A setting earns its place only when a sensible default
  would be wrong for someone who can tell the difference. Measure bandwidth
  (gzipped wire bytes, not fixture size on disk) and loudness (notifications
  actually raised) before adding or defending one; `settingsFrom` is the real
  validation, not the schema.
- **Commits.** `<type>(<scope>): <subject>`,
  `feat|fix|docs|style|refactor|test|chore|perf`, imperative, ≤50 chars. One
  logical change per commit.

## Pull requests

`main` is branch-protected — every change lands via a PR;
`~/.claude/rules/code.md`'s branch-vs-main thresholds don't apply here (this
repo can't push straight to `main`). Otherwise same rule as `code.md`'s "PR
ownership": never a draft, never handed over red.

- Branch from latest `main`; `npm run format` and `npm test` must pass.
- One logical change per PR. Title as the release note — it becomes one.
  Rebase onto `main`, never merge it in.
- A PR touching the webapp carries pictures: `node
  scripts/screenshots/states.mjs`, both themes, attach the states touched.
- **Temporary, delete when [#67](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/67)
  closes:** every scannable PR carries a failing, **empty**-output
  `github-advanced-security` check (`CAPIError: 400`, a Copilot-plan issue,
  not a finding, and not required). Read the log; anything else in it is real.
- **Never touch version numbers.** `release-please` owns them (see
  Releasing). Commit `type` is the only input; `bump-patch-for-minor-pre-major`
  makes the anti-minor bias a config setting — decline a reviewer's
  strict-semver argument and point at the config.

**Board-only PRs merge themselves**, per `code.md`'s "A board-only PR merges
itself" — wired here via `paths-ignore`/`path_filters` in
`.github/workflows/claude-review.yml` and `.coderabbit.yaml`, gated through a
`changes`+`ci-gate` job rather than `paths-ignore` on CI itself (that leaves a
required context pending forever, not passing).
[↳](docs/design-decisions.md#a-board-only-pr-skips-the-matrix-through-a-gate-job-not-a-paths-ignore)

## Local development

```shell
npm install && npm run build && npm test
```

Full procedures — the shared dev server and its lock files, the webapp mocks,
the browser demo and standalone app builds, the screenshot scripts — are in
[docs/development.md](docs/development.md). Read it before starting a server
or working against a shared instance; `~/.signalk` and `~/symphony` are
shared, not one per session.

## Releasing

`release-please` owns the version, the changelog and the tag; merging its
standing `chore: release` PR is the release. Squash-merge it (its commits are
unsigned; a squash gets GitHub's signature, a merge commit doesn't). Full
mechanics, including why publishing is dispatched explicitly rather than on
the tag push, are in
[docs/development.md#releasing](docs/development.md#releasing).
