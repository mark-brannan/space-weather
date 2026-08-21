# Security Policy

## Supported versions

This plugin is maintained as a single moving line. Only the latest version
published to npm gets fixes; there are no maintenance branches for older
releases.

| Version | Supported |
| ------- | --------- |
| latest `0.x` on [npm](https://www.npmjs.com/package/signalk-noaa-space-weather) | yes |
| anything older | no — upgrade first |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Report it
privately through GitHub:

1. Go to
   [Security → Report a vulnerability](https://github.com/mark-brannan/signalk-noaa-space-weather/security/advisories/new).
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

The plugin runs inside somebody's navigation server, often on a boat with no
reliable connectivity, so the interesting surfaces are:

- **Parsing of NOAA payloads.** Everything under `src/parse.ts` and
  `src/noaa/client.ts` treats the payload as untrusted input. A crafted or
  truncated response that crashes the server, hangs the event loop, or causes
  the plugin to publish a value it should not is in scope.
- **The HTTP routes** the plugin registers under
  `/signalk/v1/api/signalk-noaa-space-weather/`, including the aurora tile
  endpoint — path traversal, unbounded work triggered by an unauthenticated
  request, or a route exposing more than the webapp needs.
- **The bundled webapp** in `public/` — injection of NOAA-sourced or
  Signal K-sourced text into the page.
- **The published tarball** — anything shipped in `files` that should not be
  there.

## What is out of scope

- Signal K server itself, its authentication, or its permission model. Report
  those to [SignalK/signalk-server](https://github.com/SignalK/signalk-server).
- NOAA SWPC's own services and the accuracy of their data.
- The fact that a Signal K server with `allow_readonly` enabled serves this
  plugin's data unauthenticated. That is the server's setting and the
  operator's decision.
- Denial of service against your own instance by configuring a very short poll
  interval.

## Notes on how this package is built

- The plugin has **no runtime dependencies**. Everything in `node_modules` is a
  build- or test-time devDependency, and Dependabot moves them monthly
  (`.github/dependabot.yml`).
- Releases are published from CI using npm OIDC trusted publishing. No npm
  token exists on a developer machine, so a stolen laptop cannot publish a
  release.
- The vessel's position is used locally to decide aurora visibility. It is
  never sent to NOAA or anywhere else — requests to NOAA are unauthenticated
  GETs for files that are the same for every caller.
