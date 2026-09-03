# space-weather

NOAA [Space Weather Prediction Center](https://www.swpc.noaa.gov/) products,
fetched, parsed and published: the G/S/R storm scales, alerts and warnings,
the Kp index and its forecast, the 27-day outlook, solar wind, X-ray flares,
the four numbers HF operators read conditions in, and the two global grids --
D-region absorption (D-RAP) and aurora probability (OVATION) -- with the map
webapp that draws them.

This is the core that
[signalk-noaa-space-weather](https://github.com/mark-brannan/signalk-noaa-space-weather)
is built on. The plugin adds the Signal K lifecycle, its HTTP routes and the
chart-plotter tiles; the standalone app and the GitHub Pages demo add a data
layer that runs the same products in a browser tab with no server under it.
Everything the three share lives here, so a parser is written once and a
NOAA payload change is fixed once.

**Status:** extracted from the plugin and not yet published to npm. The
plugin still carries its own copy of this code until it is repointed here.

## What's here

```
src/
  parse.ts        pure parsing and transformation; no I/O
  paths.ts        every Signal K path the products own, plus the scale tables
  config.ts       JSON schema, typed Settings, normalisation of raw props
  endpoints.ts    every NOAA endpoint a product may fetch, with its wire size
  publisher.ts    the publisher contract, and a file-backed store for caches
  noaa/client.ts  the ONLY outbound network I/O
  products/       one module per NOAA product; registry.ts lists them
  cache/          the on-disk caches the grids and the outlook survive on
  browser/        the products running in a tab: live.ts, and the seam that
                  serves the page out of the document they publish
public/
  index.html      the page; the three shipping forms are copies of it
  signalk.js      the ONLY module the page reaches a server through
  projection.js   the two projections, and the viewport
  mapRaster.js    grid samplers, and the destination-pixel rasteriser
  spaceMap.js     the drawing: raster, contours, graticule, coastline, marks
  geo.js          the coastline, decoded and drawn
examples/         dated NOAA captures every parser is tested against
docs/noaa-products.md
                  measured behaviour of every endpoint: bytes, cadence, quirks
```

**To add a data source: write `src/products/<name>.ts` implementing
`Product`, add it to `PRODUCTS` in `src/products/registry.ts`, declare its
endpoint in `src/endpoints.ts`.** Nothing else.

## Using it

The package root is the server-side entry -- the parsers, the products and
the publisher contract. The map modules and the browser layer are subpaths,
so a consumer can take the page without the filesystem:

```js
import { PRODUCTS, parseKpForecast, settingsFrom } from 'space-weather'
import { createDocumentSeam } from 'space-weather/browser/seam'
import { drawSpaceMap } from 'space-weather/spaceMap'
```

| Subpath                     | What it is                                       |
| --------------------------- | ------------------------------------------------ |
| `.`                         | parsers, paths, config, endpoints, products      |
| `./parse`, `./paths`, ...   | the individual server-side modules               |
| `./products/*`, `./cache/*` | one product or cache module                      |
| `./browser/*`               | the products running in a browser tab            |
| `./projection`, `./mapRaster`, `./spaceMap`, `./geo` | the map stack |
| `./public/*`                | the page and its assets, for a consumer to serve |

### A consumer serves the page itself

Nothing here serves HTTP. Signal K serves a webapp out of the plugin package's
own `public/` directory, so the plugin copies this package's `public/` into
its own at build time -- the same idiom as its `sync-icon.mjs`: generated,
gitignored, run on `prebuild` and `prepare`. Two files in `public/` are
themselves generated here, from the `coastlines` and `coast-wright`
packages, by `scripts/sync-coastline.mjs`; they ship in the tarball because
a browser loads the page unbundled and cannot reach `node_modules`.

## Development

```shell
npm install && npm run build && npm test
```

Tests run with no network, inside 60 seconds; every parser runs against a
dated capture in `examples/`. [docs/development.md](docs/development.md) has
the mock rig that stands the page up without a server, and the scripts that
capture fixtures and re-measure NOAA. [CLAUDE.md](CLAUDE.md) is the
contribution guide: the constraints that bite, the conventions, the pull
request and release rules.

## Licence

[AGPL-3.0-or-later](LICENSE), plain. Copyright (c) 2025-2026 Mark Brannan.

The plugin this was extracted from carries an additional permission under
section 7 of the AGPL for programs that merely load it. This package
deliberately does not, yet: what the permission should say for a library
that is loaded by a plugin, an app and a static site is a live question, and
starting strict is the safe direction -- the copyright is held in one place,
so a permission can be added to a later version, while one given in a
published version cannot be withdrawn from it.

Patches are welcome and are licensed the same way, with one extra step: the
[CLA](CLA.md) is a one-line statement in your first pull request. It keeps
the copyright in one place so the code can also be offered under other terms
later.
