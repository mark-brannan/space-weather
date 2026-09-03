# Contributing

Thanks for looking. This is the core of a NOAA Space Weather Prediction
Center stack for boats: the parsers, the products and the map webapp that the
[Signal K plugin](https://github.com/mark-brannan/signalk-noaa-space-weather),
the standalone app and the demo all share. Bug reports from people actually
sailing with one of those are the most useful thing here, and small pull
requests are welcome.

## Where the documentation lives

Two files, and they do not overlap:

- **[README.md](README.md)** — what the package is and how a consumer uses
  it.
- **[CLAUDE.md](CLAUDE.md)** — what the codebase *is* and how to work here:
  the architecture, the non-obvious constraints that will bite you (offline
  tests, NOAA changing payload shapes, notification loudness, the page that
  ships three ways), and the conventions and pull request rules. **This is the
  contribution guide.** Read it before changing anything; what follows is the
  short version and the setup steps.

`docs/noaa-products.md` holds dated measurements of how NOAA's endpoints
actually behave. It is the source of truth for those numbers — re-run
`scripts/measure-noaa.mjs` rather than reasoning about them.

## Reporting a bug

Open an [issue](https://github.com/mark-brannan/space-weather/issues/new/choose)
using the bug form. The fields it asks for are the ones that have been needed
every previous time: which consumer you saw it in and its version, what it
runs on, and the log around the failure. "Space weather stopped working"
without those cannot be acted on. A problem in how the Signal K plugin
starts, its routes or its chart tiles belongs in
[the plugin's tracker](https://github.com/mark-brannan/signalk-noaa-space-weather/issues);
if you are not sure, file it here and it will be moved.

Security problems go through [SECURITY.md](SECURITY.md) instead — privately, not
as an issue.

## Suggesting a feature

Use the feature form. Two things carry more weight than anything else in it:

- **A new data source** is cheap here by design. One module under
  `src/products/`, added to `PRODUCTS` in `src/products/registry.ts`. Say which NOAA
  endpoint and what it would mean to a skipper.
- **A new setting is expensive.** The bar is a decision only the boat owner can
  make, where a sensible default would be wrong for someone and they can tell
  the difference. CLAUDE.md's *Configuration* section explains what to measure
  before proposing one.

## Setting up

```shell
git clone https://github.com/mark-brannan/space-weather.git
cd space-weather
npm install
npm run build
npm test
```

Node 18 or newer. The two runtime dependencies are the coastline data and
its renderer, vendored into `public/` at build time.

To see the webapp without a server at all — including the states that are
impractical to reproduce live, such as a G4 storm:

```shell
npm run dev:webapp
```

Running against a real Signal K server means running the plugin; see its
repository. [docs/development.md](docs/development.md) has the rest.

## Before you open a pull request

```shell
npm run format      # prettier: no semicolons, two-space indent, single quotes
npm test            # vitest
npm run build       # tsc
```

All three must pass. Then:

- **Branch from latest `main`**, and rebase onto it rather than merging it in.
- **Tests are required for new code**, and they assert behaviour — values,
  states, paths, unit conversions, boundaries — never display strings.
- **Tests must run with no network, inside 60 seconds.** The
  [plugin registry](https://github.com/SignalK/signalk-plugin-registry) scores
  the Signal K plugin under `firejail --net=none`, and the parsers and
  fixtures it runs are these, so a parser is tested against a captured
  fixture in `examples/`, never the live service. Capture a dated fixture
  before writing the parser.
- **One logical change per pull request.** If it would produce two changelog
  entries, it is two pull requests.
- **Commits are conventional**: `<type>(<scope>): <subject>`, imperative,
  50 characters or fewer.
- **Title the pull request as if it were the release note**, because it becomes
  one.

**Never put a version bump in a pull request.** `release-please` owns the
number, the CHANGELOG and the tag: don't edit `package.json`'s version,
`.release-please-manifest.json` or `CHANGELOG.md`, and don't create a tag
locally. Your commit subject is the whole input — `fix` and `feat` earn a
release, `chore`/`docs`/`test`/`refactor` ride along in the next one, and a
`!` or a `BREAKING CHANGE:` footer is what escalates it. The one exception is
`CHANGELOG.md` on the standing `chore: release` pull request itself —
release-please's own PR, not yours — which may be hand-edited before merging
when a release deserves notes written rather than assembled (see CLAUDE.md's
*Releasing* section).

## Code of Conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence and the CLA

Contributions are licensed under the plain [AGPL-3.0-or-later licence](LICENSE)
that covers this project. README.md's *Licence* section says why there is no
section 7 permission here yet.

They also need the [contributor licence agreement](CLA.md), which is one line
in the description of your first pull request:

> I have read CLA.md and I agree to it.

You sign it once and it covers everything you send afterwards. You keep the
copyright in your own work; the grant is what lets this code be offered under
other terms later without your patch having to be torn back out. CLA.md says
what you are granting and why, in full.
