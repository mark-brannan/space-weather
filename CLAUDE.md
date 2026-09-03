# space-weather

The core of the NOAA space-weather stack: the parsers, the products, the
publisher contract and the map webapp, shared by the Signal K plugin
([signalk-noaa-space-weather](https://github.com/mark-brannan/signalk-noaa-space-weather)),
the standalone app and the GitHub Pages demo. Those consumers serve the page
and own the lifecycle; this package owns what the page shows and where the
numbers come from.

## Architecture

```
src/
  index.ts        the package root: re-exports, nothing of its own
  config.ts       JSON schema, typed Settings, normalisation of raw props
  publisher.ts    the publisher contract; the ONLY module that touches fs
  noaa/client.ts  the ONLY outbound network I/O
  paths.ts        every Signal K path a product owns, plus the scale tables
  parse.ts        pure parsing and transformation; no I/O
  endpoints.ts    every NOAA endpoint a product may fetch, with its wire size
  products/       one module per NOAA product; registry.ts is the list
  cache/          on-disk caches: the grids, the advisory, the storm state
  browser/        the page's data layer with no server under it:
                  live.ts runs the products in a tab, seam.ts serves the page
                  out of the document they publish
public/
  index.html      the page. It ships three ways and none is a fork of it
  signalk.js      the ONLY module the page reaches a server through
  projection.js   the two projections, and the viewport that turns one to pixels
  mapRaster.js    grid samplers, and the destination-pixel rasteriser
  spaceMap.js     the drawing: raster, contours, graticule, coastline, marks
  drap-colors.js  NOAA's D-RAP colorbar
  geo.js          the coastline, decoded and drawn
  config-panel.js the plugin's configuration form; pinned to config.ts
```

The package root is server-side (`publisher.ts` imports `fs`). `src/browser/`
is the browser entry and `test/browser-closure.test.ts` walks it: nothing in
that closure may import a Node builtin or a bare package. The map modules
are exported as subpaths (`./projection`, `./mapRaster`, `./spaceMap`,
`./geo`) so a later split is a rename, and `./public/*` exposes the page for
a consumer to serve.

**To add a data source: write `src/products/<name>.ts` implementing
`Product`, add it to `PRODUCTS` in `src/products/registry.ts`.** Nothing else.

**Every endpoint a product fetches is declared in `src/endpoints.ts`, with its
measured wire size**, and the client refuses to fetch anything else. That table
is what `config.ts`'s form descriptions and `public/config-panel.js`'s daily
bill are computed from, so a new endpoint is priced by adding it and nothing
else -- and an undeclared one is a test failure rather than traffic nobody was
told about. `test/endpoints.test.ts` holds the declarations against
`docs/noaa-products.md` byte for byte, so re-measuring means updating both.

A `Product` declares `schedule` (`observations` or `notifications`), optional
`enabled(settings)` if the user can switch it off, optional `metadata(settings)`
published once per start, and `refresh(ctx)`. Keep parsing in `parse.ts` and
pure -- it is what makes the fixtures useful.

## Non-obvious constraints

Settled, not obvious, and has cost a release when violated. The argument for
each is in the plugin's
[docs/design-decisions.md](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md)
(`[↳]`); this list is the rule only.

- Tests run with no network, inside 60s (`test/offline.test.ts`) -- the
  Signal K plugin registry scores the consumer under `firejail --net=none`,
  and the parsers and fixtures are here. Fixture new payload shapes into
  `examples/` before writing a parser.
- `main` requires signed commits; cloud sessions have no key -- run
  `resign-branch.sh <branch>` from a keyed machine, or flag it in the PR body.
- NOAA changes payload shapes with no notice -- accept old and new shapes
  (`parseSolarWind`, `kpRows`). [↳](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md#noaa-changes-payload-shapes-without-notice)
- Measured NOAA behaviour lives only in
  [docs/noaa-products.md](docs/noaa-products.md) -- re-measure with
  `scripts/measure-noaa.mjs`, don't guess or restate it elsewhere.
- `firstJsonValue`/`readJson` recover a torn payload's complete leading
  value, never a truncated one.
- `/products/alerts.json` is a rolling archive, not current conditions -- one
  path per message code (`currentAlertNotifications`), never per-message.
  [↳](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md#alerts-are-keyed-by-message-code-not-serial-number)
- The collapsed storm notification (`STORM_BASE`) transitions both
  directions, six-hour hold to stand down; watches never raise it.
  [↳](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md#the-storm-notification-collapses-by-level-and-rides-a-six-hour-hold)
- Loudness is only three ordered thresholds (`alarmLevel`/`popupLevel`/
  `listLevel`) via `methodForState`; default 3=alert(silent), 4=warn(visual),
  5=alarm(sound) -- don't go louder without a frequency argument.
  [↳](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md#loudness-is-three-ordered-thresholds-not-one)
- `meta.zones` raises notifications via a half-open matcher -- top zone
  omits `upper`, never sets `Infinity`.
  [↳](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md#zone-metadata-is-what-turns-a-reading-into-a-notification)
- Config-panel thresholds are lines on a ladder, not dropdowns.
  [↳](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md#thresholds-are-lines-on-the-ladder-not-dropdowns)
- SI units only: m/s, Tesla, 0–1 `ratio`; G/S/R/Kp carry **no** `units` key.
  Never publish `NaN` -- return `null` instead.
- The grid fetches regardless of vessel position; retries go through
  `publishFromCache()`, never `refresh()`.
  [↳](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md#a-global-grid-is-worth-fetching-before-there-is-anywhere-to-index-it)
- `auroraEnabled`/`drapEnabled` gate the schedule, not a manual refresh,
  which always fetches and defers the next scheduled run.
  [↳](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md#auroraenabled-and-drapenabled-govern-the-schedule-not-the-capability)
- The advisory outlook publishes as data regardless of
  `sendAdvisoryOutlook`; `expireIfStale` gates both expiry and re-raising.
  [↳](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md#the-advisory-outlook-is-also-published-as-plain-data)
- Predicted-vs-measured (webapp): ±50%/endpoint, ±25%/total, not judged
  until a 24h window fills; `estimated`-bytes rows compare against nothing.
  [↳](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md#predicted-vs-measured-has-two-thresholds-and-one-window-gate)
- The Kp chart is one time axis at two spans -- a daily bar max must never
  read as a 3-hourly sample; summary from `outlookAhead`, not `…maxKp`.
  [↳](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md#the-kp-chart-is-one-time-axis-at-two-spans-not-two-charts)
- The map draws through `mapRaster.js`; projection is a parameter, ground
  is dark in both themes, D-RAP bands are contours over NOAA's colorbar.
  [↳1](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md#one-map-the-products-are-layers-the-projection-is-a-control)
  [↳2](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md#the-map-draws-on-its-own-dark-ground)
  [↳3](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md#both-d-rap-surfaces-draw-noaas-colorbar-the-bands-are-contours-over-it)
- The page is three views over one state object; renderers take their
  container as a parameter, never look one up by id.
  [↳](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md#the-page-is-three-views-over-one-state-object-not-three-copies-of-it)
- `radiusDeg` is honoured on the map's shorter axis, clip at the antipode.
  [↳](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md#on-the-map-radiusdeg-is-honoured-on-the-shorter-axis-the-clip-is-at-the-antipode)
- Map geography comes only from `geo.js`; no other module draws a coastline.
  [↳](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md#every-webapp-map-draws-its-own-coastline-the-chart-overlay-draws-none)
- `public/index.html` is the one page. Every consumer copies it through a
  seam (`test/webapp-seam.test.ts` pins that it reaches a server only through
  `signalk.js`); never fork it or hand-list its files.
  [↳](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md#the-demo-is-the-shipping-page-not-a-copy-of-it)
- `public/drap-colors.js` and `public/aurora.js` carry colour tables the
  plugin's `tiles.ts` copies; the plugin's own test pins the copies against
  these. Change a table here and that test is what fails.
- `main` must stay in `package.json` -- `require()` on an absolute path
  ignores `exports`
  ([↳](https://github.com/mark-brannan/signalk-noaa-space-weather/blob/main/docs/design-decisions.md#main-must-stay-in-packagejson)).
  `public/coastline.js` and `public/vendor/` are generated and gitignored --
  never commit a copy.

## Conventions

No semicolons, two-space indent, single quotes -- `npm run format`
(`npm run format:check` verifies). Comments explain *why*, not what.

- **Scope.** YAGNI/DRY/KISS. No error handling for cases that can't happen;
  validate at the boundaries (NOAA payload, saved config) only.
- **Docs.** Measured facts live only in `docs/noaa-products.md`, never in a
  comment. Docs describe current state, not history -- that's `CHANGELOG.md`.
- **Type safety.** `tsconfig.json` has `strict: false` for historical
  reasons -- treat it as a convention anyway: no `any` in new code, narrow
  over cast. `declaration: true` is load-bearing: the consumers type their
  subpath imports from the emitted `.d.ts`.
- **Performance.** The consumers run on a Pi 3-5, often on battery. Guard
  `debug()` arguments; publish deltas only when a value changed
  ([signalk-noaa-space-weather#45](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/45)).
- **Configuration.** A setting earns its place only when a sensible default
  would be wrong for someone who can tell the difference. Measure bandwidth
  (gzipped wire bytes, not fixture size on disk) and loudness (notifications
  actually raised) before adding or defending one; `settingsFrom` is the real
  validation, not the schema.
- **Commits.** `<type>(<scope>): <subject>`,
  `feat|fix|docs|style|refactor|test|chore|perf`, imperative, ≤50 chars. One
  logical change per commit.

## Pull requests

`main` is branch-protected -- every change lands via a PR, never a draft,
never handed over red.

- Branch from latest `main`; `npm run format` and `npm test` must pass.
- One logical change per PR. Title as the release note -- it becomes one.
  Rebase onto `main`, never merge it in.
- A PR touching `public/` carries pictures from the mock rig
  ([docs/development.md](docs/development.md)), both themes.
- **Never touch version numbers.** `release-please` owns them (see
  Releasing). Commit `type` is the only input; `bump-patch-for-minor-pre-major`
  makes the anti-minor bias a config setting -- decline a reviewer's
  strict-semver argument and point at the config.

## Local development

```shell
npm install && npm run build && npm test
```

The mock rig, the capture and measurement scripts, and what a session can
and cannot show from this repo are in
[docs/development.md](docs/development.md). There is no Signal K rig here:
that runs the plugin's `index.ts`, which lives in the plugin repo.

## Releasing

`release-please` owns the version, the changelog and the tag; merging its
standing `chore: release` PR is the release. Squash-merge it (its commits are
unsigned; a squash gets GitHub's signature, a merge commit doesn't).
`publish.yml` runs only by explicit dispatch, which `release-please.yml` does
once the tag exists; read its header before changing that.
