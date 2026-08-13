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
| `/products/noaa-planetary-k-index-forecast.json` | `kp` | shape alternates, see below |
| `/products/summary/solar-wind-speed.json` | `solarWind` | shape changed once, see below |
| `/products/summary/solar-wind-mag-field.json` | `solarWind` | shape changed once, see below |
| `/products/alerts.json` | `alerts` | rolling 30-day archive, see below |
| `/json/f107_cm_flux.json` | `f107` | three readings a day; only "Noon" is used |
| `/json/ovation_aurora_latest.json` | `aurora` | the only large payload |
| `/text/advisory-outlook.txt` | `advisory` | weekly bulletin, plain text |
| `/text/27-day-outlook.txt` | `outlook27` | daily rows for one solar rotation, plain text |

## Payload size

Measured 2026-08-09. Wire size is with `Accept-Encoding: gzip`, which Node's
`fetch` sends by default — so it is what the plugin actually costs. The decoded
size is what a fixture on disk shows, and quoting it overstates the cost by
roughly ten times.

| Endpoint | Wire | Decoded |
| --- | --- | --- |
| `/products/alerts.json` | ~5 KB | 53 KB |
| `/json/ovation_aurora_latest.json` | ~145 KB | ~898 KB |
| `/text/advisory-outlook.txt` | ~1.6 KB | — |
| `/text/27-day-outlook.txt` | 451 B | 1606 B |

Everything else is small enough that it has never mattered; the remaining
observation and forecast endpoints together come to about 5 KB per poll.

`/text/27-day-outlook.txt` was measured 2026-08-12, separately from the run
above and after it, by the same method. At `outlook27`'s daily interval that is
451 B a day, about 3 KB a week, which is why it has no setting.

**Consequence.** Only aurora is worth a setting (`auroraEnabled`,
`auroraInterval`). At the default two-hour interval it is about 1.7 MB a day,
against roughly 120 KB a day for everything else combined.

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
| `/json/ovation_aurora_latest.json` | 200, content changed, new ETag | 200, content changed, new ETag |
| `/text/advisory-outlook.txt` | 200, content identical, new ETag | 200, content identical, new ETag |
| `/text/27-day-outlook.txt` | 200, content identical, new ETag | 200, content identical, new ETag |

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

**These counts are one banding behind and read low.** They were taken while
the plugin banded G on integer Kp; it now bands on NOAA's thirds, so every
level takes in a third of a step more of the scale than the run below assumed
and the true rates are higher. The gap was put at about 30% at the top levels
while it was still open. Re-run the script and paste its table in; don't
adjust these by hand, and don't quote them as current until you have.

| Level and above | Median year | p10 | p90 | Worst year | Dropdown says |
| --- | --- | --- | --- | --- | --- |
| G1+ | 53 | 19 | 103 | 141 | most weeks |
| G2+ | 20 | 4 | 44 | 62 | a couple of times a month |
| G3+ | 7 | 0 | 18 | 27 | several times a year |
| G4+ | 2 | 0 | 6 | 13 | once or twice a year |
| G5+ | 0 | 0 | 1 | 3 | once or twice a decade |

p90 sits at roughly twice the median at every level, which is the "active
stretch" the description mentions. Cycle 25's started around 2023 and should run
to about 2028.

**Don't fit this to one cycle.** Cycle 24 is the trap: its median year had 23
G1+ days against the record's 53, so labels derived from it come out about half
as loud as the truth. Cycle 22's median year had 81. Any window shorter than the
full record is a cycle-strength sample, not a rate.

The measured medians also run about half NOAA's per-cycle figures. Banding is
no longer part of that — the plugin bands where NOAA's scale page bands — so
what is left is that NOAA's long-run average includes cycles stronger than any
since, plus however much of the gap the pending re-measure closes. Both numbers
are honest; they answer different questions.

**These count storm *days*, and a label says "times".** A storm running across
two UTC dates counts twice here and is one thing a boat experiences; several
transitions inside one date count once. The error runs in the safe direction —
days over-count occasions, so a label promises slightly more noise than the
plugin will actually make — and it washes out in the rounding at G1+ and G2+.
At G4+ (median 2) and G5+ (median 0, worst year 3) it is the same order as the
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

## Unmeasured

Named so nobody cites this file for them:

- the storm-day rates under the G banding the plugin now uses. The table above
  was counted under the old integer banding and is an undercount. Re-run
  `scripts/measure-kp.mjs` somewhere `kp.gfz.de` is reachable
- whether any endpoint ever returns 304 at a longer gap than 300s — being
  collected at a twelve-hour gap for `/text/27-day-outlook.txt` under
  [#55](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/55)
- whether `Cache-Control: max-age=60` is honoured by any intermediary
- content cadence for `/json/ovation_aurora_latest.json`,
  `/text/advisory-outlook.txt` and `/text/27-day-outlook.txt` — all three were
  in the size and conditional-GET runs but not the 15-minute cadence watch
- whether `/text/27-day-outlook.txt` is issued on a Monday *every* week, and
  how tightly the issue time clusters. One issue observed so far; see
  [#55](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/55)
- how much two consecutive weekly issues differ across the 20 days their
  windows overlap; also
  [#55](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/55)
