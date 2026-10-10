# Agent decisions

Append-only. Each entry is a call an agent made in pencil: a default it took
under the one-way-door test, with its undo. Written by `agent-decision`; the
heading is the UTC stamp, so `agent_decisions.md#<stamp>` links one entry.

### 20261010t204015z
- Coastline is Natural Earth 50m, not 10m: on a 4x-throttled Chromium canvas 50m parses in 32 ms and draws in 30 ms per map, 10m in 166 ms and 153 ms. Undo: swap data/ to ne_10m_coastline.geojson and its sha256 pin, re-measure ([#45](https://github.com/mark-brannan/space-weather/pull/45))
