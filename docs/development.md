# Development environment

How to see the page without a server, and the scripts that keep the fixtures
and the measurements honest. [`CLAUDE.md`](../CLAUDE.md) keeps the handful of
things that bite before you get this far.

## What a session here can show

Whenever a change is likely to affect the page, show it running, as bare
URLs in a list:

- mock rig on `localhost`
- mock rig on a LAN- or Tailscale-reachable URL

Windows and phone disagree on which URL resolves -- `localhost` works from the
server's own machine but not the phone, and the LAN/Tailscale URL is the
reverse on Windows -- so give both forms rather than picking one. Find this
machine's addresses with `hostname -I` (LAN is usually the `192.168.x.x` one;
Tailscale is the `100.x.x.x` one) and substitute directly into the URL --
don't paste `127.0.0.1` and call it done.

**There is no Signal K rig in this repo.** That rig runs the plugin's
`index.ts` in a real server through the symlink in `~/.signalk/node_modules/`,
and `index.ts` lives in
[signalk-noaa-space-weather](https://github.com/mark-brannan/signalk-noaa-space-weather).
Until that rig can follow a linked checkout of this package (`npm link` or a
`file:` dependency), rebuild both and restart, a session here can offer the
mock rig and nothing else. Say so plainly rather than offering the mock as if
it were both.

Share it before re-running the test suite, not after. Start it the way this
file documents, with the flags this file documents -- a port or `--upstream`
when the situation calls for one, never an ad hoc proxy or wrapper.

## Working on the webapp ("rig") without a server

```shell
npm run dev:webapp        # http://127.0.0.1:8731, or pass a port
```

It binds every interface, and prints one URL per address it can be reached
at -- loopback, LAN, Tailscale. Showing a change on another device is a
matter of pasting the right line of that output; no proxy, and nothing to
look up with `hostname -I`. To narrow it back to loopback on a network you
don't trust, `npm run dev:webapp -- --host 127.0.0.1` -- the `--` is not
optional, npm swallows the flag without it and leaves the server bound to
every interface, which is the one mistake this option exists to prevent.
Kill it when done; don't leave stray listeners behind.

**In a sandboxed agent session, background it with `&` and `disown` in the
same shell call, and don't use `pkill` to manage it.** `pkill` gets killed
by the sandbox itself the instant it runs -- even `pkill -f
some-pattern-that-matches-nothing` dies with exit 144 -- so any command chain
that runs it can take the whole chain down, including a freshly backgrounded
server. `pgrep -f mock-webapp` to find the pid and plain `kill` to stop it
both work fine; so do `npm run dev:webapp:list` and `npm run dev:webapp:stop`.

`scripts/mock-webapp.mjs` serves `public/` with a state switcher appended and
answers the Signal K paths it understands with fabricated data, so the real
`heroState`/`renderTimer`/`renderKp` decide what renders. A strip at the
bottom of the page switches between the states in `STATES`: quiet, an R2 in
the past 24h, a G3 forecast, a G3 eased to G1 and still in force, a G4+S4 in
force, stale data, and no-data-since-start. Most are impractical to reach
against a live server -- a G4 happens a few times a solar cycle, and the last
one means breaking the plugin on purpose -- which is the whole reason the
file exists. **The switcher strip is part of this harness, not the product**
-- a synthetic click meant for the map can land on it instead (it's fixed at
the bottom of the viewport and a tall expanded tile scrolls underneath it),
which navigates the page and looks exactly like the app misbehaving. Verify
a synthetic click's target with `elementFromPoint` before trusting what it
did.

Reach for it instead of hand-editing the DOM in devtools, and add a state
there rather than faking one in the console.

It has no dependencies and nothing imports it. Keep it that way -- it has to
stay invisible to the offline `npm ci`, build and test run.

The map's grids are the one thing here that is not fabricated: a made-up
aurora or D-RAP grid would be mocking the tile renderer rather than the
webapp. The four routes behind them -- `aurora-grid`, `drap-grid`,
`aurora-refresh`, `drap-refresh` -- fall through to the real products, loaded
out of `dist/`, so pressing **Fetch** on the map does a real NOAA request and
caches a real grid on disk under the OS temp dir, with or without
`--upstream`. Those buttons are therefore the one part of this that needs
`npm run build` first and needs the network; everything else stays
fabricated and offline. Until a real fetch has landed, the map renders its
own empty state and the aurora and D-RAP readings come from `payload()` like
every other path. A real `refresh()` also publishes the point value at the
vessel, which the mock captures in place of an `app` object and serves back
on those paths.

`--upstream <base-url>` trades the fabricated states for a running Signal K
server's real numbers: the same paths are proxied there verbatim instead of
going through `payload()`, so a branch's `public/` -- a changed card, new
copy -- can be checked against genuine data without repointing that server's
plugin at anything.

```shell
node scripts/mock-webapp.mjs --upstream http://127.0.0.1:3010
```

Check the server's lock file (the plugin repo's `docs/development.md`
describes the shared instances and `~/.signalk/locks/`) before relying on it
being idle. `--upstream` and the state switcher are mutually exclusive;
passing it replaces the switcher strip with one naming the upstream instead.

## Fixtures and measurements

Every parser runs against a dated capture in `examples/`, never the live
service, so a new payload shape is fixtured before it is parsed.

- `scripts/capture.mjs` fetches the endpoints and files a capture under
  `examples/captures/` (gitignored) when its "interest key" is new. Promote
  one into `examples/` with `mv` and `git add`. The header comment carries
  the cron lines that keep a capture box running.
- `scripts/measure-noaa.mjs` re-measures wire sizes and cadences for
  `docs/noaa-products.md`; `scripts/check-noaa-live.mjs` compares the live
  service against that document through `dist/noaa/client.js`, and is what
  `.github/workflows/noaa-drift.yml` runs weekly.
- `scripts/measure-kp.mjs` and `scripts/watch-drap.mjs` are the longer
  observations behind the Kp and D-RAP cadence notes in the same document.
- `scripts/sync-coastline.mjs` regenerates `public/coastline.js` and
  `public/vendor/` from the `coastlines` and `coast-wright` packages; it
  runs on `prebuild` and `prepare`, so a clone is complete after
  `npm install`.

Measured facts go into `docs/noaa-products.md` and nowhere else.
