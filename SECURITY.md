# Security Policy

## Supported versions

This package is maintained as a single moving line. Only the latest version
published to npm gets fixes; there are no maintenance branches for older
releases.

| Version | Supported |
| ------- | --------- |
| latest `0.x` on [npm](https://www.npmjs.com/package/space-weather) | yes |
| anything older | no — upgrade first |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Report it
privately through GitHub:

1. Go to
   [Security → Report a vulnerability](https://github.com/mark-brannan/space-weather/security/advisories/new).
2. Describe what you found, which version you saw it in, and how to reproduce
   it. A failing test or a captured payload is worth more than a description.

You should get an acknowledgement within a week. This is a spare-time project
maintained by one person, so a fix may take longer than that — you will be told
where it stands rather than left waiting. If a report is valid and you want
credit, you will be named in the advisory and the changelog entry.

If you get no response at all within two weeks, open a public issue saying only
that you are waiting on a private report — no details — and it will be picked
up.

## What is in scope

This code runs inside somebody's navigation server, or in a browser on the
boat, often with no reliable connectivity, so the interesting surfaces are:

- **Parsing of NOAA payloads.** Everything under `src/parse.ts` and
  `src/noaa/client.ts` treats the payload as untrusted input. A crafted or
  truncated response that crashes the process, hangs the event loop, or causes
  a product to publish a value it should not is in scope.
- **The webapp** in `public/` — injection of NOAA-sourced or Signal K-sourced
  text into the page, in any of the three forms it ships in.
- **The browser data layer** in `src/browser/` — anything it fetches, stores
  or reads back that it should not.
- **The published tarball** — anything shipped in `files` that should not be
  there.

## What is out of scope

- The Signal K plugin's HTTP routes and chart tiles, its lifecycle, and its
  packaging. Report those to
  [signalk-noaa-space-weather](https://github.com/mark-brannan/signalk-noaa-space-weather/security/advisories/new).
- Signal K server itself, its authentication, or its permission model. Report
  those to [SignalK/signalk-server](https://github.com/SignalK/signalk-server).
- NOAA SWPC's own services and the accuracy of their data.
- The fact that a Signal K server with `allow_readonly` enabled serves this
  data unauthenticated. That is the server's setting and the operator's
  decision.
- Denial of service against your own instance by configuring a very short poll
  interval.

## Notes on how this package is built

- The two runtime dependencies, `coastlines` and `coast-wright`, are data
  and a renderer for the map's coastline, vendored into `public/` at build
  time; nothing else in `node_modules` ships. Dependabot moves dependencies
  monthly (`.github/dependabot.yml`).
- Releases are published from CI using npm OIDC trusted publishing. No npm
  token exists on a developer machine, so a stolen laptop cannot publish a
  release.
- The vessel's position is used locally to decide aurora visibility. It is
  never sent to NOAA or anywhere else — requests to NOAA are unauthenticated
  GETs for files that are the same for every caller.
