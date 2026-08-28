# NOAA SWPC products: measured behaviour

**This file is the source of truth for how NOAA's endpoints actually behave.**
Nothing here is inferred from documentation, a header, or a plausible-sounding
argument — every number was produced by `scripts/measure-noaa.mjs` against the
live service, and carries the date it was taken.

Two rules that exist because breaking them cost a day:

- **Don't restate these numbers in a source comment.** They are dated
  observations, and a comment cannot carry a date that anyone will update. Code
  comments get to hold invariants ("a truncated payload must not be recovered")
  and point here for the rest.
- **Don't cite this file as proof of something it doesn't say.** Measuring one
  endpoint is not measuring nine. Where a row is missing, the answer is
  "unmeasured", not "presumably the same".

Re-measure with:

```shell
node scripts/measure-noaa.mjs            # sizes and conditional GET, ~6 min
node scripts/measure-noaa.mjs --cadence  # adds a 15-minute content watch
```

## Endpoints

| Endpoint | Product | Notes |
| --- | --- | --- |
| `/products/noaa-scales.json` | `scales` | G/S/R observed + 3-day forecast |
| `/json/goes/primary/xray-flares-latest.json` | `scales` | flare class, e.g. `B5.7` |
| `/json/goes/primary/xray-flares-7-day.json` | `scales` | one record per flare, for the 24-hour peak |
| `/products/noaa-planetary-k-index-forecast.json` | `kp` | shape alternates, see below |
| `/products/summary/solar-wind-speed.json` | `solarWind` | shape changed once, see below |
| `/products/summary/solar-wind-mag-field.json` | `solarWind` | shape changed once, see below |
| `/json/goes/primary/xrays-6-hour.json` | `goesFlux` | X-ray flux time series, both channels |
| `/json/goes/primary/integral-protons-6-hour.json` | `goesFlux` | integral proton flux time series |
| `/products/alerts.json` | `alerts` | rolling 30-day archive, see below |
| `/json/f107_cm_flux.json` | `f107` | three readings a day; only "Noon" is used |
| `/json/ovation_aurora_latest.json` | `aurora` | the largest single payload |
| `/text/drap_global_frequencies.txt` | `drap` | global HF absorption grid, plain text |
| `/text/advisory-outlook.txt` | `advisory` | weekly bulletin, plain text |
| `/text/27-day-outlook.txt` | `outlook27` | daily rows for one solar rotation, plain text |
| `/text/wwv.txt` | `aIndex` | the WWV geophysical alert bulletin, plain text |
| `/text/daily-solar-indices.txt` | `sunspot` | last 30 daily rows (DSD.txt), plain text |

## Payload size

Measured 2026-08-28, every endpoint the plugin fetches, in one run of
`scripts/measure-noaa.mjs`. Wire size is the bytes off the socket with
`Accept-Encoding: gzip`, which is what the plugin actually costs. The decoded
size is what a fixture on disk shows, and quoting it overstates the cost by
roughly ten times.

**Read the wire column off a raw socket, not off `content-length`.** NOAA
serves the gzipped endpoints chunked, so most of them state no length at all;
`wireBytes` counts raw chunks through `node:https` for that reason. An earlier
version asked `fetch` for the header and reported "unknown" for every endpoint
that mattered, which is part of how the totals below went stale unnoticed.

| Endpoint | Product | Interval | Wire | Decoded |
| --- | --- | --- | --- | --- |
| `/products/noaa-scales.json` | `scales` | `updateInterval` | 211 B | 1.1 KB |
| `/json/goes/primary/xray-flares-latest.json` | `scales` | `updateInterval` | 452 B | 452 B |
| `/json/goes/primary/xray-flares-7-day.json` | `scales` | `updateInterval` | 3.2 KB | 16.9 KB |
| `/products/noaa-planetary-k-index-forecast.json` | `kp` | `updateInterval` | 496 B | 6.7 KB |
| `/products/summary/solar-wind-speed.json` | `solarWind` | `updateInterval` | 59 B | 59 B |
| `/products/summary/solar-wind-mag-field.json` | `solarWind` | `updateInterval` | 60 B | 60 B |
| `/json/goes/primary/xrays-6-hour.json` | `goesFlux` | `updateInterval` | 24.4 KB | 159.5 KB |
| `/json/goes/primary/integral-protons-6-hour.json` | `goesFlux` | `updateInterval` | 7.9 KB | 58.5 KB |
| `/products/alerts.json` | `alerts` | `updateInterval` | 5.3 KB | 50.3 KB |
| `/json/ovation_aurora_latest.json` | `aurora` | `auroraInterval` | 143.7 KB | 898.9 KB |
| `/text/drap_global_frequencies.txt` | `drap` | `drapInterval` | 2.1 KB | 41.5 KB |
| `/json/f107_cm_flux.json` | `f107` | 4 h | 1.2 KB | 22.3 KB |
| `/text/wwv.txt` | `aIndex` | 3 h | 346 B | 0.5 KB |
| `/text/daily-solar-indices.txt` | `sunspot` | 4 h | 845 B | 2.9 KB |
| `/text/advisory-outlook.txt` | `advisory` | adaptive | 768 B | 1.5 KB |
| `/text/27-day-outlook.txt` | `outlook27` | 24 h | 442 B | 1.6 KB |

**One `updateInterval` poll is about 42 KB on the wire** — the nine rows marked
`updateInterval`, summed. At the hourly default that is roughly 1.0 MB a day.

**`goesFlux` is three quarters of it.** Its two time-series windows are 32.3 KB
of the 42, against 9.7 KB for the other seven endpoints put together. It is
also the only product on that interval with no `enabled` toggle
([#112](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/112)).

The rest of the bill, at the defaults: D-RAP 2.1 KB hourly, about 50 KB a day;
the fixed-cadence bulletins and indices about 18 KB a day between them; aurora,
if switched on, 143.7 KB every two hours — about 1.7 MB a day.

**Consequence.** None of the fixed-cadence rows gets a setting. `outlook27` is
442 B a day, `aIndex` 2.7 KB, `sunspot` 5.0 KB, `f107` 7.2 KB and `advisory`
about 3.4 KB — 18 KB a day between the five, against 1.0 MB for the poll. A
switch that saves under 2% of the bill is a dial, not a decision.

Earlier figures this run supersedes: the payload table dated 2026-08-09 and its
"about 5 KB per poll", D-RAP's 3.3 KB from 2026-08-20, and the 7-day flare
list's 4.9 KB from 2026-08-26. The flare list is the one that genuinely moves
with the sky rather than with measurement error — it is one record per flare,
so its size tracks how busy the week was. The rest of the gap is `goesFlux`
having been added to the poll without the total being re-taken.

### The sunspot number is much cheaper from DSD.txt than from its own products

Measured 2026-08-20, same method, on the two SWPC endpoints that carry a
sunspot number directly. Both serve the whole record — back to 1749 and to 1996
respectively — for the one current value, and there is no shorter form of
either.

| Endpoint | Wire | Decoded |
| --- | --- | --- |
| `/json/solar-cycle/observed-solar-cycle-indices.json` | 34 KB | 512 KB |
| `/json/solar-cycle/swpc_observed_ssn.json` | 44 KB | 474 KB |

**Consequence.** `sunspot` reads the daily number out of
`/text/daily-solar-indices.txt` instead, at roughly a fortieth of the wire. The
monthly *smoothed* number, which is the truer cycle-context figure, is only in
the first of these and is not published on its own — so it is not published by
this plugin either.

**Consequence.** Two products have a setting, and the 2026-08-28 re-measure
moved the ground under both arguments. Aurora (`auroraEnabled`,
`auroraInterval`) is about 1.7 MB a day at the default two-hour interval; that
is still the largest single line, but it is now about 1.6× everything else
combined rather than the thirty times the older figures supported, because the
non-aurora bill grew to roughly 1.1 MB a day. D-RAP (`drapEnabled`,
`drapInterval`) measures 2.1 KB, about 50 KB a day at the hourly default —
5% of the poll it used to ride, not the two thirds recorded here before. Its
switch is not doing the bandwidth job it was given; it stays because it also
governs whether the product runs at all, and because it shipped.

## How often the content changes

Measured 2026-08-09, 15 samples one minute apart, comparing a hash of each body.

| Endpoint | Changes in 15 min |
| --- | --- |
| `/products/noaa-scales.json` | 13 |
| `/json/goes/primary/xray-flares-latest.json` | 12 |
| `/products/summary/solar-wind-speed.json` | 7 |
| `/products/alerts.json` | 0 |
| `/products/noaa-planetary-k-index-forecast.json` | 0 |
| `/json/f107_cm_flux.json` | 0 |

**Consequence.** Polling faster than NOAA publishes is harmless and polling
slower only means staler data, so the interval is not worth explaining to a
user. `updateInterval`'s description says what it covers and what it costs, and
nothing about cadence.

## `/text/27-day-outlook.txt` is issued weekly, not daily

Observed 2026-08-13. The endpoint served `:Issued: 2026 Aug 10 0153 UTC`
unchanged from 2026-08-12 through 2026-08-13, and `/text/weekly.txt` ("Weekly
Highlights and Forecasts") carries the **identical** issue timestamp — the
27-day table is part of that bulletin. 2026 Aug 10 was a Monday, which matches
the independent note in `src/products/advisory.ts` that every captured advisory
fixture is issued on a Monday between 0100 and 0400 UTC.

**This is one issue, seen twice.** It establishes that the product is weekly
rather than daily; it does *not* establish that Monday ~0153 UTC holds week to
week. A separate watch outside this repo is collecting that, one issue per
week; [#55](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/55)
tracks it, and the Unmeasured list below says what is still open.

**Consequence.** `outlook27` polls once a day and does not chase the issue
time. Sleeping until just before it and then polling tightly, the way
`advisory` does, costs roughly four times the bytes to buy same-morning pickup
of a product whose value is entirely at the far end of its window. Consecutive
issues overlap by 20 of their 27 days, and the first three days — where being
a day late would actually matter — are covered far better by `kp` and
`scales`.

## Conditional GET never saves anything

Measured 2026-08-09, except `/text/27-day-outlook.txt` on 2026-08-12 by the
same method. Baseline `ETag` and `Last-Modified` echoed back as
`If-None-Match` / `If-Modified-Since`, probed twice.

| Endpoint | +150s | +300s |
| --- | --- | --- |
| `/products/alerts.json` | 200, content identical, new ETag | 200, content identical, new ETag |
| `/products/noaa-scales.json` | 200, content changed, new ETag | 200, content changed, new ETag |
| `/products/noaa-planetary-k-index-forecast.json` | 200, content identical, new ETag | 200, content identical, new ETag |
| `/products/summary/solar-wind-speed.json` | 200, content changed, new ETag | 200, content changed, new ETag |
| `/products/summary/solar-wind-mag-field.json` | 200, content changed, new ETag | 200, content changed, new ETag |
| `/json/f107_cm_flux.json` | 200, content identical, new ETag | 200, content identical, new ETag |
| `/json/goes/primary/xray-flares-latest.json` | 200, content changed, new ETag | 200, content changed, new ETag |
| `/json/goes/primary/xray-flares-7-day.json` | 200, content identical, new ETag | 200, content identical, new ETag |
| `/json/goes/primary/xrays-6-hour.json` | 200, content changed, new ETag | 200, content changed, new ETag |
| `/json/goes/primary/integral-protons-6-hour.json` | 200, content changed, new ETag | 200, content changed, new ETag |
| `/json/ovation_aurora_latest.json` | 200, content changed, new ETag | 200, content changed, new ETag |
| `/text/drap_global_frequencies.txt` | 200, content changed, new ETag | 200, content changed, new ETag |
| `/text/advisory-outlook.txt` | 200, content identical, new ETag | 200, content identical, new ETag |
| `/text/27-day-outlook.txt` | 200, content identical, new ETag | 200, content identical, new ETag |
| `/text/wwv.txt` | 200, content identical, new ETag | 200, content identical, new ETag |
| `/text/daily-solar-indices.txt` | 200, content identical, new ETag | 200, content identical, new ETag |

`/text/wwv.txt` and `/text/daily-solar-indices.txt` are from a 2026-08-20
re-run of the same script; the four GOES rows and D-RAP are from a 2026-08-28
run, the first with every endpoint the plugin fetches in `ENDPOINTS`. Every one
of the three runs found zero 304s on every endpoint; which bodies happened to
be byte-identical differed between them, as the cadence table above says it
would.

**Zero 304s, on any endpoint, at either gap** — including four whose bodies were
byte-identical to the baseline. The ETag is shaped `<size>-<mtime>`:

```
W/"d0ef-658a2be791f5f"        alerts.json
"3b-658a2c008a530"            solar-wind-speed.json   (strong, small body)
"4d4-658a2c1f9fc17-gzip"      advisory-outlook.txt    (gzip suffix)
```

The size half is stable while the body is; the mtime half moves on every
rewrite. `Last-Modified` behaves the same way — every endpoint reports an age of
0–2 minutes, including `f107_cm_flux.json`, whose content moves once a day. So
**neither header is a freshness signal**, and the cache in `noaa/client.ts`
never hits at a realistic poll interval.

Back-to-back requests *do* return 304, which is what makes this easy to get
wrong: probe twice in a row and conditional GET looks like it works.

**Consequence.** Every poll pays full price. That price is small, so this stays a
note rather than a bug, and the conditional headers stay in place — they cost
nothing and NOAA could start honouring them. Do not claim a 304 offsets a poll.

Also recorded in the 0.6.0 changelog when conditional GET was added, then
contradicted on 2026-08-09 by an argument from plausibility. Hence this file.

## Files are rewritten in place, and a read can land mid-write

Observed 2026-08-09 on `/json/goes/primary/xray-flares-latest.json`:

```
Failed to fetch X-ray flare class: SyntaxError:
Unexpected non-whitespace character after JSON at position 364
```

The body was a complete JSON array followed by the tail of the previous,
longer version. NOAA rewrites these files about once a minute (see the cadence
table), so any endpoint can do this; the flare product hit it first because it
is one of the fastest-changing.

`firstJsonValue` in `src/parse.ts` recovers the complete leading value, and
`readJson` in `src/noaa/client.ts` uses it as a fallback after a strict parse
fails. **A merely truncated payload must keep throwing** — there is no complete
value to recover, and publishing half a payload as though it were whole is worse
than skipping a poll.

## Payload shapes change without notice

Twice, and both times it silently broke published data:

- solar wind summaries went from `{"Bt": 5, "Bz": -3}` to
  `[{"bt": 4, "bz_gsm": -1}]`, which made the plugin publish `NaN` for months
- the planetary K-index forecast alternates between a header-row table and a
  list of records

So capture a dated fixture into `examples/` before writing a parser, and make
the parser accept the old shape as well as the new one. `parseSolarWind` and
`kpRows` in `src/parse.ts` are the pattern.

## `/products/alerts.json` is an archive, not current conditions

118 to 200 messages per payload, nearly all describing events that ended weeks
ago, and NOAA mints a fresh serial number every time it extends or continues one
condition — one ongoing K-index warning became 19 separate notification paths in
a month. See [#45](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/45).

Counted 2026-08-13 over the three captured fixtures — `alerts.2025_04_11.json`
(180 messages), `alerts.2025_04_17.json` (200) and `alerts.2026_08_01.json`
(118). Re-count when a fixture is added; every figure below moved the last time
one was.

| At the default alarm level | In force | Audible |
| --- | --- | --- |
| At each fixture's capture time | 4, in all three | 0 |
| Peak over each fixture's whole span | 8 / 9 / 11 | 0 |

**Nothing in any captured payload is audible at the default**, including both
April 2025 storms: they peaked at an observed G4, which is `warn` — visual only
— until `alarmLevel` is lowered to 4. `test/alerts.test.ts` pins that at the
16 April peak, where the default raises one visual notification and no sound.

The busiest payload is `alerts.2026_08_01.json` at 11 simultaneous conditions,
not either April storm; `MAX_ALERT_NOTIFICATIONS` is set well above it.

NOAA also writes a scale as `G3 or greater` when it will not say how bad a storm
will get. That is the level it stated, and grading it as 5 makes an uncertain
forecast louder than a confirmed G4.

## Event frequency by scale

**Not measured here.** Unlike everything else in this file, these are NOAA's
published counts read off their page. They are useful for comparing the three
scales against each other, which is the only thing this section is for. They are
not a rate: dividing a per-cycle count by 11 runs about twice what an ordinary
year sees, which is why nothing in the UI quotes them. The measured figures are
in [What the dropdown actually quotes](#what-the-dropdown-actually-quotes)
below. Don't propagate these into new copies, and don't cite this table as a
measurement.

Read from [NOAA's scales page](https://www.swpc.noaa.gov/noaa-scales-explanation)
on 2026-08-09. One cycle is 11 years. G and R are quoted as days per cycle; S is
quoted as events per cycle only.

NOAA quotes events per cycle for all three, and days per cycle for G and R only.
Compare like with like: events against events.

| Level | G events / days | R events / days | S events | R vs G, by days | G ÷ S, by events |
| --- | --- | --- | --- | --- | --- |
| 1 Minor | 1700 / 900 | 2000 / 950 | 50 | +6% | 34× |
| 2 Moderate | 600 / 360 | 350 / 300 | 25 | −17% | 24× |
| 3 Strong | 200 / 130 | 175 / 140 | 10 | +8% | 20× |
| 4 Severe | 100 / 60 | 8 / 8 | 3 | **−87%** | 33× |
| 5 Extreme | 4 / 4 | 1 / 1 | 1 | **−75%** | 4× |

**They are not interchangeable, and not comparable in one direction either.** R
runs slightly ahead of G at levels 1 and 3, 17% behind at level 2, and 87%
behind at level 4 — the single biggest gap, on one of the two options the
dropdown puts at the top. S is 20–34× rarer than G by event count at levels 1–4
and only 4× rarer at level 5.

`alarmLevel` governs all three scales plus Kp, so no single cadence can label an
option correctly. Its dropdown quotes the G figures and its description says so.
Don't quote one scale's rate as though it covered the others.

### What the dropdown actually quotes

Not the table above. Those are per-cycle totals, and dividing by 11 assumes an
average cycle — which is a real thing, but not the thing a user experiences.
Storm days cluster into a five-year active stretch, and the stretch is bigger in
some cycles than the whole of others.

So the dropdown quotes the measured record instead: geomagnetic storm days per
year, counted from GFZ's Kp archive, 1932–2025, 94 complete years. Regenerate
with `node scripts/measure-kp.mjs`.

| Level and above | Median year | p10 | p90 | Worst year | Dropdown says |
| --- | --- | --- | --- | --- | --- |
| G1+ | 72 | 30 | 133 | 164 | most weeks |
| G2+ | 27 | 8 | 61 | 85 | a couple of times a month |
| G3+ | 10 | 1 | 25 | 39 | several times a year |
| G4+ | 3 | 0 | 9 | 18 | once or twice a year |
| G5+ | 0 | 0 | 3 | 7 | several times a decade |

p90 sits at roughly twice the median at every level, which is the "active
stretch" the description mentions. Cycle 25's started around 2023 and should run
to about 2028.

**Don't fit this to one cycle.** Cycle 24 is the trap: its median year had 30
G1+ days against the record's 72, so labels derived from it come out about half
as loud as the truth. Cycle 22's median year had 104. Any window shorter than
the full record is a cycle-strength sample, not a rate.

The measured medians still run a little over half NOAA's per-cycle figures —
52–57% of them, against about 40% under the old banding — comparing each row
with NOAA's days summed from that level up and divided by 11. Banding is no
longer part of that — the plugin bands where NOAA's scale page bands — so what
is left is that NOAA's long-run average includes cycles stronger than any since.
Both numbers are honest; they answer different questions.

**These count storm *days*, and a label says "times".** A storm running across
two UTC dates counts twice here and is one thing a boat experiences; several
transitions inside one date count once. The error runs in the safe direction —
days over-count occasions, so a label promises slightly more noise than the
plugin will actually make — and it washes out in the rounding at G1+ and G2+.
At G4+ (median 3) and G5+ (median 0, worst year 7) it is the same order as the
number itself, which is why those two labels are deliberately vague.

**The bands are NOAA's, on Kp thirds.** Kp is reported in thirds and NOAA's
`G4 = Kp 8` names the whole 8 band — 8−, 8o, 8+ — so G4 opens at 7.667 and G5
at 8.667. `kpFloorForG` in `src/parse.ts` is the single definition; `zonesForKp`
and `gScaleForKp` both ask it, so a value graded G4 here is graded G4 on
spaceweather.gov. G5 still carries no `upper` key, for the reason given in
`zonesForKp`.

The floors are exact thirds rather than the 7.667 NOAA prints, because the same
value arrives spelled 7.67 from the JSON products and 7.667 from the GFZ
archive, and a floor rounded to either precision drops the other.

## Candidate endpoints for the ham-radio initiative (#81, #83, #84)

Measured 2026-08-20, before any parser exists for these — the repo rule for
adding a data source. None of these are in `ENDPOINTS` in
`scripts/measure-noaa.mjs` yet; they were probed one-off, same method (wire
size with `Accept-Encoding: gzip`, a conditional-GET pair at +150s/+300s).
Dated fixtures are captured into `examples/`.

### D-RAP global frequencies (#81)

`/text/drap_global_frequencies.txt` is a fixed ASCII grid: 90 latitude rows
(89° to −89°, step −2°) by 90 longitude columns (−178° to 178°, step 4°) —
8100 points, each the highest-affected frequency in MHz. Wire 3.3 KB, decoded
41.5 KB, gzip. Conditional GET: content changed and a new ETag at both +150s
and +300s — no 304 was returned at either measured gap, matching the
realistic-interval behaviour documented above, and it changes faster than the
15-minute cadence watch above would even resolve.
Fixture: `examples/drap-global-frequencies.2026_08_20.txt`.

### WWV geophysical alert (#84)

`/text/wwv.txt` is tiny — wire 0.3 KB, decoded 0.6 KB — and already carries
the exact phrase the issue asks for: solar flux, "estimated planetary
A-index", and the current planetary K-index, plus a plain-English 24h-past /
24h-next summary. Conditional GET: content identical, new ETag, at both
probes — consistent with its own text stating one issue time, and unlike
D-RAP nothing here moves inside a 5-minute window. No separate A-index product
is needed; `wwv.txt` covers it. Fixture: `examples/wwv.2026_08_20.txt`.

### Sunspot number (#84)

The issue's own candidates turned out not to fit. `/json/solar-cycle/observed-solar-cycle-indices.json`
and `/json/solar-cycle/sunspots.json` are **monthly**, not daily —
`"time-tag": "2026-07"`, not a date — so neither answers "today's sunspot
number". `/json/solar-cycle/swpc_observed_ssn.json` is genuinely daily, back
to 1996, but has no windowed variant: 9822 records, ~474 KB decoded, the
whole history on every poll for one number.

`/text/daily-solar-indices.txt` (NOAA's `DSD.txt`) is the right fit: the last
30 days only, plain text, wire 0.8 KB / decoded 2.9 KB, with a "SESC Sunspot
Number" column alongside the 10.7cm flux already published as `f107`. Same
shape and cadence as `advisory-outlook.txt`, so the existing text-parsing
pattern applies directly. Conditional GET: content identical, new ETag, at
both probes — issued once daily (`:Issued: 0225 UT 20 Aug 2026`), matching
`f107`'s and `kp`'s own no-change-in-15-minutes result above. Fixture:
`examples/daily-solar-indices.2026_08_20.txt`.

### GOES X-ray and proton flux time series (#83)

Both products are published in matching `-6-hour`, `-1-day` and `-3-day`
windows, one satellite (18, the current GOES primary) at capture time.

| Endpoint | Wire (gzip) | Decoded | Records |
| --- | --- | --- | --- |
| `xrays-6-hour.json` | 26.0 KB | 159.7 KB | ~716 |
| `xrays-1-day.json` | 103.9 KB | 642.0 KB | 2876 |
| `xrays-3-day.json` | 308.8 KB | 1928.0 KB | 8636 |
| `integral-protons-6-hour.json` | 7.9 KB | 58.6 KB | ~568 |
| `integral-protons-1-day.json` | 30.7 KB | 236.7 KB | 2296 |
| `integral-protons-3-day.json` | 91.8 KB | 711.6 KB | 6904 |

### The 7-day flare list, beside the latest-flare endpoint (#122)

Measured 2026-08-26.

| Endpoint | Wire (gzip) | Decoded | Records |
| --- | --- | --- | --- |
| `xray-flares-latest.json` | 449 B | 451 B | 1 |
| `xray-flares-7-day.json` | 4.9 KB | 27,860 B | 72 |

One record per flare over the trailing week rather than a time series, which
is why it stays smaller on the wire than every flux window above — from 1.6x
against the six-hour proton window to 63x against the three-day X-ray one —
despite covering seven days rather than six hours. The latest endpoint is a
single record and too small to compress — its wire and decoded sizes are the
same figure. 72 records is what a week carried on the capture date, not a
rate: flare count is the thing being measured, and it varies by more than an
order of magnitude across a solar cycle.

The fixture is `examples/xray-flares-7-day.2026_08_26.json`, whose 27,860 bytes
are the *decoded* size — the figure to quote for the cost of a poll is the 4.9 KB
wire size, as everywhere else in this file.

**Consequence.** `scales` fetches both: `-latest` answers "is anything
happening now" and `-7-day` is where the strongest flare of the last 24 hours
comes from. At roughly ten times the latest endpoint's bytes and still under
5 KB on the wire, the second fetch is cheap enough that narrowing it was not
worth a NOAA endpoint that does not exist.

X-ray records interleave two energy channels (`0.05-0.4nm`, `0.1-0.8nm`) at
roughly 1-minute cadence each; proton records interleave eight (`>=1 MeV`
through `>=500 MeV`) at roughly 5-minute cadence each. Conditional GET on the
`-6-hour` variants: content changed and a new ETag at both +150s and +300s —
expected, since the series is still being appended to at 1-minute cadence.

**Consequence.** The `-6-hour` variant is the right poll target, as the issue
guessed: `-1-day` is ~4× the bytes for the same latest value, `-3-day` is
~12×. A Signal K path publishes only the newest record per channel, so the
window only needs to be wide enough to seed a web app sparkline, not to answer
"what is it now" — that argues for `-6-hour` over either wider variant.
Fixtures are `examples/xrays-6-hour.2026_08_20.json` and
`examples/integral-protons-6-hour.2026_08_20.json`; the `-1-day`/`-3-day`
variants were measured for wire cost only, not fixture-captured — they are
overlapping windows of the same data, not a different shape to pin.

## Unmeasured

Named so nobody cites this file for them:

- whether any endpoint ever returns 304 at a longer gap than 300s — being
  collected at a twelve-hour gap for `/text/27-day-outlook.txt` under
  [#55](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/55)
- whether `Cache-Control: max-age=60` is honoured by any intermediary
- content cadence for `/json/ovation_aurora_latest.json`,
  `/text/advisory-outlook.txt`, `/text/27-day-outlook.txt`, `/text/wwv.txt` and
  `/text/daily-solar-indices.txt` — all five were in the size and
  conditional-GET runs but not the 15-minute cadence watch
- whether `/text/wwv.txt` is reissued on the hour it claims (NOAA documents it
  as three-hourly, and `aIndex` polls on that documented cadence rather than a
  measured one); the daily A index it carries moves once a day either way
- whether `/text/27-day-outlook.txt` is issued on a Monday *every* week, and
  how tightly the issue time clusters. One issue observed so far; see
  [#55](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/55)
- how much two consecutive weekly issues differ across the 20 days their
  windows overlap; also
  [#55](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/55)
