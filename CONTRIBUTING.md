# Contributing

Thanks for looking. This is a Signal K server plugin that publishes NOAA Space
Weather Prediction Center data to a boat. Bug reports from people actually
sailing with it are the most useful thing here, and small pull requests are
welcome.

## Where the documentation lives

Three files, and they do not overlap:

- **[README.md](README.md)** — what the plugin does, for the boat owner
  installing it.
- **[CLAUDE.md](CLAUDE.md)** — what the codebase *is*: the architecture, and
  the non-obvious constraints that will bite you (offline tests, NOAA changing
  payload shapes, notification loudness, the icon living in two places). Read
  it before changing anything; most of the surprises in this repo are written
  down there.
- **[AGENTS.md](AGENTS.md)** — how to work here: scope, comments, type safety,
  tests, performance, the bar a new config setting has to clear, commit format,
  and pull request rules. **This is the contribution guide.** What follows is
  the short version and the setup steps.

`docs/noaa-products.md` holds dated measurements of how NOAA's endpoints
actually behave. It is the source of truth for those numbers — re-run
`scripts/measure-noaa.mjs` rather than reasoning about them.

## Reporting a bug

Open an [issue](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/new/choose)
using the bug form. The fields it asks for are the ones that have been needed
every previous time: plugin version, Signal K server version, what hardware it
runs on, and the server log around the failure. "Space weather stopped working"
without those cannot be acted on.

Security problems go through [SECURITY.md](SECURITY.md) instead — privately, not
as an issue.

## Suggesting a feature

Use the feature form. Two things carry more weight than anything else in it:

- **A new data source** is cheap here by design. One module under
  `src/products/`, added to `PRODUCTS` in `src/index.ts`. Say which NOAA
  endpoint and what it would mean to a skipper.
- **A new setting is expensive.** The bar is a decision only the boat owner can
  make, where a sensible default would be wrong for someone and they can tell
  the difference. AGENTS.md's *Configuration* section explains what to measure
  before proposing one.

## Setting up

```shell
git clone https://github.com/mark-brannan/signalk-noaa-space-weather.git
cd signalk-noaa-space-weather
npm install
npm run build
npm test
```

Node 18 or newer. There are no runtime dependencies.

To see the webapp without a Signal K server at all — including the states that
are impractical to reproduce live, such as a G4 storm:

```shell
npm run dev:webapp
```

To run against a real server, symlink this checkout into your Signal K config
directory's `node_modules/` (the server finds plugins by scanning that
directory, not by reading `package.json`), then rebuild and restart. CLAUDE.md's
*Local development* section has the details.

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
  this package under `firejail --net=none`, so a parser is tested against a
  captured fixture in `examples/`, never the live service. Capture a dated
  fixture before writing the parser.
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
`!` or a `BREAKING CHANGE:` footer is what escalates it.

## Code of Conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

Contributions are licensed under the [ISC licence](LICENSE) that covers this
project.
