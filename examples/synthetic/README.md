# Invented fixtures

Everything in this directory was **written by hand**. Nothing here came off the
wire. The dated files one level up in `examples/` are the real captures.

The split matters because the two answer different questions. A real capture
proves what NOAA *does* send — it is the only honest evidence of the wire
format, and CLAUDE.md's "capture a dated fixture before writing a parser" rule
exists because our belief about that format has been wrong twice. These files
prove the plugin survives what NOAA *might* send, and carry value combinations
a real sky does not produce often enough to wait for.

## Why they exist

A real capture cannot catch a surface reading the wrong slot, because the
slots that get confused hold the same value on an ordinary day. The
instantaneous scale field and the 24-hour observed maximum agree at `0`
whenever nothing is happening; the forecast probabilities repeat across days 1,
2 and 3 whenever NOAA has nothing to distinguish them by. Correct output and
broken output are then the same bytes, which is what #120 shipped through.
Waiting for a storm does not close that gap — the agreement is what a quiet sky
*is*.

So the rule these files follow: **every slot a surface reads carries a
different value**, and a wrong slot therefore produces a wrong number rather
than a coincidentally right one.

`test/synthetic-fixtures.test.ts` drives all of them and asserts this list is
complete, so a fixture added here and never read cannot go unnoticed.

## What each one is for

### Scales — value combinations a quiet sky never produces

| File | The case it makes testable |
| --- | --- |
| `noaa-scales.all-slots-distinct.json` | All five slots differ, and all three forecast days differ in G, S and R. Any slot or day mix-up shows up as a wrong number. |
| `noaa-scales.storm-in-progress.json` | Peaked at G4, still running at G2. The pair is the only thing separating "storm running" from "storm passed". |
| `noaa-scales.quiet-with-forecast.json` | Nothing observed, 55% chance of R1–R2 tomorrow. "Quiet now" and "worth watching" must not collapse together. |
| `noaa-scales.solar-radiation-only.json` | S3 with G0 and R0. Says so if a surface is quietly reading G where it means S. |
| `noaa-scales.extreme-all.json` | Level 5 across the board. No real capture goes above G4/S1/R1, so nothing has exercised the top of a colour table or a zone boundary. |

### Scales — shapes NOAA has not sent, and might

| File | The case it makes testable |
| --- | --- |
| `noaa-scales.hostile-types.json` | Levels as JSON numbers rather than strings, a `null` `Text`, an absent `MinorProb`, an unknown extra key. Both historical NOAA breaks were type or shape changes of exactly this kind. |
| `noaa-scales.hostile-missing-observed.json` | The 24-hour slot is simply gone. Publishing `0` for "we do not know" is #120 by another route. |
| `noaa-scales.hostile-out-of-range.json` | A `7` on a five-level scale, a `-1`, a level that is not a number, and empty-string probabilities. |
| `noaa-scales.hostile-torn-with-tail.json` | A read that landed mid-rewrite. NOAA rewrites these files in place, so a shorter new payload leaves the tail of the longer old one behind — a complete leading value followed by bytes that are not part of it. |
| `noaa-scales.hostile-truncated.json` | Truncated with no complete value in it at all. `firstJsonValue` must return `null` here, never half a payload. |

### Flares

`xray-flares-latest.x-class-peaked.json` has decayed to M2.1 from a max of
X1.8; `xray-flares-latest.x-class-rising.json` is at X2.4 and still climbing,
so current equals max. The only real capture is a single B3.3 nothing-day,
where the two are equal and a tile drawing either reads the same. Nothing in
`src/` or `public/` reads `max_class` yet — these two are the payloads a fix
for #122 would need, not evidence that one exists.
`xray-flares-latest.hostile-empty.json` is `[]` (NOAA serves this between
flares) and `xray-flares-latest.hostile-nulls.json` has null classes with
numbers as strings.

### Text bulletins

`wwv.no-storms.txt` is a bulletin with no storms at all. The quiet-day argument
for a live cross-source check rests on WWV stating quiet *positively* rather
than going silent, and no capture of that wording has come past yet — so this
is our best guess at it and a real capture should replace it.
`wwv.all-three-storms.txt` carries G5, S3 and R3 at once.

`drap-global-frequencies.warning-in-force.txt` takes its frequency grid
verbatim from the 2026-08-20 capture and substitutes the header: an X-ray
warning, a proton event, an estimated recovery time, and a valid-at date of its
own so nothing mistakes it for that capture. Both warning lines are blank and
both message lines read "Normal" in every capture we hold, so that branch of
the parser has never run against anything.
