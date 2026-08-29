#!/usr/bin/env node
/**
 * A standing watch on NOAA's D-RAP grid, for the questions one measurement
 * can't answer.
 *
 *   node scripts/watch-drap.mjs               # one burst, appends one row
 *   node scripts/watch-drap.mjs --samples 3   # shorter burst
 *   node scripts/watch-drap.mjs --report      # markdown over everything logged
 *
 * At M1 or above the burst becomes a ~50-minute continuous watch on its own,
 * so the same hourly cron line covers both regimes; `--samples` opts back out.
 *
 * NOAA rewrites `/text/drap_global_frequencies.txt` about once a minute, and
 * the animation on their radio dashboard visibly pulses between frames. The
 * plugin polls it on an interval measured in tens of minutes, so every value
 * it publishes is one arbitrary frame out of that flicker. Whether that
 * matters is an empirical question with four parts, and this answers all of
 * them off one log:
 *
 *  1. Does a single sample represent its hour? Each run takes a *burst* --
 *     several fetches a minute apart -- and records every sample plus the
 *     burst's spread. If the spread within five minutes is small, one poll is
 *     fine and the plugin needs no change; if it is large, the poll should
 *     average a burst (`trimmedMean` here is the candidate), and a live view
 *     is worth building because there is something to watch.
 *
 *     Two things the first version of this got wrong, both fixed here. A
 *     five-minute burst measures whether one minute looks like the next; it
 *     does not measure how far the field has moved by the time the *next*
 *     poll replaces the value, which is the staleness a reader actually sees.
 *     `--report` now pairs consecutive bursts for that. And an hourly
 *     four-minute burst is a 7% duty cycle, so it will almost never land on a
 *     flare's ten-to-thirty-minute ramp -- see `FLARE_FLUX_WM2`, which turns
 *     the run into a continuous minute-cadence watch when the cause is
 *     actually present.
 *  2. How often is anything absorbed at all? Every run scores the whole grid
 *     against the marine SSB band edges, so the base rate behind the zone
 *     ladder's thresholds -- and behind "is a stormy demo snapshot rare?" --
 *     comes out of the same rows.
 *  3. Where does it happen? The worst cell's position and its angular
 *     distance from the subsolar point, per sample, against the map's
 *     assumption that absorption is a dayside phenomenon.
 *  4. Does the payload behave? Wire bytes, ETag, and how many distinct bodies
 *     a five-minute burst actually sees -- docs/noaa-products.md measured that
 *     once, on 2026-08-20, over two probes.
 *
 * GOES X-ray flux is fetched once per run alongside, because a flare is the
 * cause the absorption is the effect of, and the lag between the two is only
 * visible if both are on the same row at the same timestamp.
 *
 * Deliberately outside the test suite: it needs the live service, and the
 * plugin registry scores this package with `npm test` under --net=none.
 *
 * Not scripts/capture.mjs, which runs on its own cron beside this one: that
 * one builds a *fixture corpus*, deduped by interest key so a payload is kept
 * only when it is a new case. This one is a *log* -- every burst kept, quiet
 * ones included, because "how often is it quiet" is one of the questions and a
 * deduped corpus cannot answer it.
 *
 * The log is JSONL under examples/captures/, which is gitignored -- raw
 * material, not a fixture. Promote an interesting capture into examples/ by
 * hand, the same as the other captures there.
 *
 * Cron, hourly, in the style of capture.mjs's own lines (no date(1), nothing
 * for crontab's `%` handling to mangle):
 *
 *   41 * * * * cd ~/signalk-noaa-space-weather && /usr/bin/node scripts/watch-drap.mjs >> /tmp/drap-watch.log 2>&1
 */
import fs from 'node:fs/promises'
import fssync from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const API = 'https://services.swpc.noaa.gov'
const DRAP_PATH = '/text/drap_global_frequencies.txt'
const XRAY_PATH = '/json/goes/primary/xrays-6-hour.json'

const OUT_DIR = path.join(REPO, 'examples', 'captures')
const LOG = path.join(OUT_DIR, 'drap-watch.jsonl')
const RAW_DIR = path.join(OUT_DIR, 'drap-raw')

// Five samples a minute apart: long enough to see the pulse NOAA's own
// animation shows, short enough that an hourly cron never overlaps itself.
const DEFAULT_SAMPLES = 5
const DEFAULT_GAP_S = 60

// A quiet hour is sampled for four minutes of it -- a 7% duty cycle, which is
// fine for "does one minute look like the next" and useless for catching an
// event. A flare's D-region rise and decay runs ten to thirty minutes, so an
// hourly burst has to be lucky to land on the ramp at all, and every burst
// logged so far is a B-class quiet day.
//
// So the trigger is the cause, not the effect: GOES long-channel X-ray flux
// is already fetched every run, and at M1 or above the run stops being a
// burst and becomes a continuous minute-cadence watch until the flux decays.
// 100% duty cycle exactly when the physics is moving, at a cost of one 42 KB
// fetch a minute for the few hours a year it fires.
// `--flare-flux 1e-9` forces the branch on a quiet day, which is the only way
// to exercise it before a flare obliges.
const FLARE_FLUX_WM2 = 1e-5
// Fifty minutes at a minute apart, leaving the hourly cron ten minutes of
// headroom so a flare run never overlaps the next one.
const FLARE_MAX_SAMPLES = 50
// Below this the run would end the moment the flux dipped under M1, and the
// decay is half of what there is to see: absorption outlives the flare.
const FLARE_MIN_SAMPLES = 15
// How often the flux is re-read while a flare run is going, in samples.
const FLARE_RECHECK_EVERY = 5

// The grid's own vocabulary comes from the plugin, not from a second copy
// here: `parseDrapGrid` is what the product runs, so a row in this log is
// what the plugin would have published rather than a lookalike.
const distParse = path.join(REPO, 'dist', 'parse.js')
if (!fssync.existsSync(distParse)) {
  console.error('dist/ missing -- run `npm run build` first')
  process.exit(1)
}
const { MARINE_SSB_BAND_EDGES_HZ, drapFrequencyAt, parseDrapGrid } =
  await import(distParse)
// Pure geometry, and the same functions the webapp's map draws with.
const { distanceKm, gridSummary, subsolarPoint } = await import(
  path.join(REPO, 'public', 'drapMap.js')
)

const BAND_EDGES_MHZ = MARINE_SSB_BAND_EDGES_HZ.map((hz) => hz / 1e6)

// Fixed probes rather than one vessel: the question "would an hourly poll
// have been noisy *for a boat*" has a different answer at the equator under
// the sun than at 60N, and a single point cannot show that. Longitudes are
// deliberately spread so at least one is on the dayside whenever the script
// runs.
const PROBES = [
  { name: 'equator-0E', latitude: 0, longitude: 0 },
  { name: 'equator-120W', latitude: 0, longitude: -120 },
  { name: 'midlat-40N-40W', latitude: 38.5, longitude: -40 },
  { name: 'midlat-40S-100E', latitude: -38.5, longitude: 100 },
  { name: 'high-60N-20E', latitude: 60, longitude: 20 }
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const hash = (text) =>
  createHash('sha1').update(text).digest('hex').slice(0, 10)
const round = (n, places = 2) =>
  n === null || !Number.isFinite(n) ? null : Number(n.toFixed(places))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const value = Number(process.argv[i + 1])
  return Number.isFinite(value) ? value : fallback
}

// --- statistics --------------------------------------------------------------

const mean = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null

/**
 * The mean with the extreme sample at each end dropped. The candidate for
 * what a burst-averaging poll would publish: a single frame of the animation
 * can be an outlier (a torn read, or one minute's model spike), and the point
 * of sampling several is not to be dragged by one of them. Below four samples
 * there is nothing to trim and this is the plain mean.
 */
function trimmedMean(values) {
  if (values.length < 4) return mean(values)
  const sorted = [...values].sort((a, b) => a - b)
  return mean(sorted.slice(1, -1))
}

function stddev(values) {
  const m = mean(values)
  if (m === null || values.length < 2) return null
  return Math.sqrt(
    values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1)
  )
}

/** min/max/mean/trimmed/spread for one series within a burst. */
function spread(values) {
  const clean = values.filter((v) => Number.isFinite(v))
  if (!clean.length) return null
  const min = Math.min(...clean)
  const max = Math.max(...clean)
  return {
    n: clean.length,
    min: round(min),
    max: round(max),
    range: round(max - min),
    mean: round(mean(clean)),
    trimmedMean: round(trimmedMean(clean)),
    stddev: round(stddev(clean), 3)
  }
}

// --- one sample --------------------------------------------------------------

/** What the whole grid says, scored the way the plugin and the map score it. */
function gridStats(grid) {
  const summary = gridSummary(grid)
  const cells = grid.frequenciesMHz.flat().filter(Number.isFinite)
  const sorted = [...cells].sort((a, b) => a - b)
  const quantile = (q) => round(sorted[Math.floor((sorted.length - 1) * q)])
  const sun = subsolarPoint(
    grid.validTime ? new Date(grid.validTime) : new Date()
  )

  // Cells above each marine band edge, not just the global max: "the worst
  // cell clears 12 MHz" and "a tenth of the planet does" are different
  // weather, and only the second is a blackout anyone will notice.
  const cellsOverBand = {}
  for (const edge of BAND_EDGES_MHZ)
    cellsOverBand[edge] = cells.filter((v) => v >= edge).length

  return {
    validTime: grid.validTime,
    cells: cells.length,
    maxMHz: round(summary?.maxMHz ?? null),
    worstAt: summary?.at ?? null,
    // The dayside claim the map's sun mark makes, as a number: how far the
    // worst cell actually is from the subsolar point.
    subsolar: {
      latitude: round(sun.latitude),
      longitude: round(sun.longitude)
    },
    worstFromSubsolarKm: summary?.at
      ? Math.round(distanceKm(summary.at, sun))
      : null,
    nonZeroFraction: round(cells.filter((v) => v > 0).length / cells.length, 4),
    p50: quantile(0.5),
    p90: quantile(0.9),
    p99: quantile(0.99),
    cellsOverBand,
    probes: Object.fromEntries(
      PROBES.map((p) => [
        p.name,
        round(drapFrequencyAt(grid, p.latitude, p.longitude))
      ])
    )
  }
}

async function sampleOnce() {
  const startedAt = Date.now()
  const res = await fetch(API + DRAP_PATH, {
    headers: { 'Accept-Encoding': 'gzip' }
  })
  const text = await res.text()
  const latencyMs = Date.now() - startedAt
  const sample = {
    at: new Date(startedAt).toISOString(),
    status: res.status,
    latencyMs,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    wireBytes: Number(res.headers.get('content-length')) || null,
    decodedBytes: Buffer.byteLength(text),
    bodySha: hash(text)
  }
  const grid = res.ok ? parseDrapGrid(text) : null
  // A parse failure is data, not a crash: a torn read mid-rewrite is one of
  // the things this watch exists to count.
  if (!grid) return { ...sample, parsed: false, text }
  return { ...sample, parsed: true, text, ...gridStats(grid) }
}

// --- one burst ---------------------------------------------------------------

async function burst(samples, gapS, stopAfter = null) {
  const taken = []
  for (let i = 0; i < samples; i++) {
    if (i > 0) await sleep(gapS * 1000)
    try {
      taken.push(await sampleOnce())
    } catch (error) {
      taken.push({
        at: new Date().toISOString(),
        parsed: false,
        error: String(error?.message || error)
      })
    }
    if (stopAfter && (await stopAfter(taken))) break
  }
  return taken
}

/** GOES long-channel X-ray flux, and the flare class it works out to. */
async function xrayNow() {
  try {
    const res = await fetch(API + XRAY_PATH)
    if (!res.ok) return { status: res.status }
    const rows = await res.json()
    const long = rows.filter((row) => row.energy === '0.1-0.8nm')
    const latest = long[long.length - 1]
    if (!latest) return { status: res.status }
    const flux = Number(latest.flux)
    // NOAA nulls flux rows during eclipses and detector swaps.
    if (!Number.isFinite(flux))
      return { status: res.status, time: latest.time_tag }
    // NOAA's own letters: each is a decade of W/m^2 from A at 1e-8.
    const letters = ['A', 'B', 'C', 'M', 'X']
    const decade = Math.min(4, Math.max(0, Math.floor(Math.log10(flux) + 8)))
    return {
      status: res.status,
      time: latest.time_tag,
      flux,
      class: `${letters[decade]}${round(flux / 10 ** (decade - 8), 1)}`
    }
  } catch (error) {
    return { error: String(error?.message || error) }
  }
}

// --- the row -----------------------------------------------------------------

async function run() {
  const samples = arg('samples', DEFAULT_SAMPLES)
  const gapS = arg('gap', DEFAULT_GAP_S)
  await fs.mkdir(OUT_DIR, { recursive: true })

  const startedAt = new Date().toISOString()
  // The flux is read *before* the burst rather than beside it, because it is
  // what decides how long the burst runs.
  const xray = await xrayNow()
  const trigger = arg('flare-flux', FLARE_FLUX_WM2)
  const flare = Number.isFinite(xray?.flux) && xray.flux >= trigger
  // An explicit --samples always wins: the flare mode is what an unattended
  // cron does, not something that overrides a human asking for three samples.
  const asked = process.argv.includes('--samples')
  const plannedSamples = flare && !asked ? FLARE_MAX_SAMPLES : samples
  let endedXray = null
  const taken = await burst(
    plannedSamples,
    gapS,
    flare && !asked
      ? async (sofar) => {
          if (sofar.length < FLARE_MIN_SAMPLES) return false
          if (sofar.length % FLARE_RECHECK_EVERY !== 0) return false
          endedXray = await xrayNow()
          return !(
            Number.isFinite(endedXray?.flux) && endedXray.flux >= trigger
          )
        }
      : null
  )
  const good = taken.filter((s) => s.parsed)

  const row = {
    startedAt,
    // Which regime this row was logged under. A report that pools a 50-sample
    // flare run with a 5-sample quiet burst and takes a median of the two is
    // averaging different questions, so the mode has to travel with the row.
    mode: flare && !asked ? 'flare' : 'hourly',
    samples: taken.length,
    gapS,
    parsed: good.length,
    xray,
    // The flux at the end as well as the start: a flare run's whole point is
    // that the driver moved while it was sampling.
    xrayEnded: endedXray,
    // Distinct bodies and distinct model timestamps: a burst that sees five
    // ETags but one validTime is NOAA rewriting the same frame, which is a
    // different fact from the model advancing five times.
    distinctBodies: new Set(good.map((s) => s.bodySha)).size,
    distinctValidTimes: new Set(good.map((s) => s.validTime)).size,
    validTimes: [...new Set(good.map((s) => s.validTime))],
    wireBytes: spread(taken.map((s) => s.wireBytes)),
    latencyMs: spread(taken.map((s) => s.latencyMs)),
    // The headline question: how much does the global peak move inside five
    // minutes, and what would a burst-averaging poll have published instead
    // of the single frame an hourly poll happens to land on.
    maxMHz: spread(good.map((s) => s.maxMHz)),
    nonZeroFraction: spread(good.map((s) => s.nonZeroFraction)),
    p99: spread(good.map((s) => s.p99)),
    worstFromSubsolarKm: spread(good.map((s) => s.worstFromSubsolarKm)),
    probes: Object.fromEntries(
      PROBES.map((p) => [p.name, spread(good.map((s) => s.probes?.[p.name]))])
    ),
    cellsOverBand: Object.fromEntries(
      BAND_EDGES_MHZ.map((edge) => [
        edge,
        spread(good.map((s) => s.cellsOverBand?.[edge]))
      ])
    ),
    // Every sample kept whole as well as aggregated: the aggregate answers
    // the question this was built for, and the per-sample series is what
    // answers the next one without re-running a week of watching.
    series: taken.map(({ text, ...rest }) => rest)
  }

  // A grid with any marine band absorbed is the case every fixture here is
  // missing, and the reason the demo's snapshot shows a blank map. Keep the
  // raw text when one turns up: it is one 41 KB file, and it cannot be
  // re-fetched later. capture.mjs keeps D-RAP too, but its interest key is the
  // bulletin's message lines -- a grid can climb well past a band edge without
  // any of those changing, so the storm this watch exists to catch is exactly
  // the case that key can miss.
  const worst = good.reduce(
    (best, s) =>
      best === null || (s.maxMHz ?? 0) > best ? (s.maxMHz ?? 0) : best,
    null
  )
  if (worst !== null && worst >= BAND_EDGES_MHZ[0]) {
    await fs.mkdir(RAW_DIR, { recursive: true })
    const pick = good.reduce((a, b) =>
      (b.maxMHz ?? 0) > (a.maxMHz ?? 0) ? b : a
    )
    const stamp = pick.at.replace(/[:.]/g, '-')
    const file = path.join(
      RAW_DIR,
      `drap-global-frequencies.${stamp}.${pick.maxMHz}MHz.txt`
    )
    await fs.writeFile(file, pick.text)
    row.rawKept = path.relative(REPO, file)
  }

  await fs.appendFile(LOG, `${JSON.stringify(row)}\n`)
  console.log(
    `${startedAt} max ${row.maxMHz?.min ?? '-'}..${row.maxMHz?.max ?? '-'} MHz` +
      ` (trimmed ${row.maxMHz?.trimmedMean ?? '-'}), ${row.distinctBodies} bodies /` +
      ` ${row.distinctValidTimes} valid times in ${row.samples} ${row.mode} samples` +
      `${row.rawKept ? `, kept ${row.rawKept}` : ''}`
  )
}

// --- the report --------------------------------------------------------------

async function report() {
  const raw = await fs.readFile(LOG, 'utf8').catch(() => '')
  const rows = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  if (!rows.length) {
    console.error(`no rows in ${path.relative(REPO, LOG)} -- run it first`)
    process.exit(1)
  }
  const withGrid = rows.filter((r) => r.maxMHz)
  // A 50-sample flare run and a 5-sample quiet burst answer different
  // questions; pooling them into one median lets the rarer, larger run
  // dominate a statistic that reads as "the ordinary hourly case".
  const hourlyGrid = withGrid.filter((r) => r.mode !== 'flare')
  const flareGrid = withGrid.filter((r) => r.mode === 'flare')
  const first = rows[0].startedAt
  const last = rows[rows.length - 1].startedAt

  const line = (label, value) => `| ${label} | ${value} |`
  const flareRuns = rows.filter((r) => r.mode === 'flare').length
  const out = []
  out.push(
    `### D-RAP watch, ${rows.length} bursts, ${first} to ${last}`,
    '',
    flareRuns
      ? `${flareRuns} of them flare-triggered continuous runs.`
      : 'No flare-triggered run yet -- every row here is a quiet-hour burst, ' +
          'so nothing below says anything about an event.',
    ''
  )
  out.push('| Question | Answer |', '| --- | --- |')

  // 1. Does the field move faster than the poll? Two different questions, and
  //    the second is the one the plugin actually risks.
  //
  //    Within a burst: does one minute look like the next -- five minutes of
  //    evidence. Across bursts: what the plugin published at the top of one
  //    hour against what was true at the top of the next, which is how long a
  //    value actually sits on a reader's screen. A field can be perfectly
  //    steady over five minutes and still be wrong an hour later, so a small
  //    within-burst spread is not on its own a licence to keep publishing one
  //    frame.
  const hours = consecutiveHours(hourlyGrid)
  const drift = hours
    .map(([a, b]) => Math.abs(b.maxMHz.trimmedMean - a.maxMHz.trimmedMean))
    .filter(Number.isFinite)

  // 2. The probes before the global peak. The global max is one cell out of
  //    8,100 picked for being extreme, so it is the noisiest estimator in the
  //    log and it is nowhere any boat is. What a vessel would have seen is
  //    the probe rows, which is why they lead now.
  const probeRanges = []
  for (const probe of PROBES) {
    const ranges = hourlyGrid
      .map((r) => r.probes?.[probe.name]?.range)
      .filter(Number.isFinite)
    const hourly = hours
      .map(([a, b]) =>
        Math.abs(
          (b.probes?.[probe.name]?.trimmedMean ?? NaN) -
            (a.probes?.[probe.name]?.trimmedMean ?? NaN)
        )
      )
      .filter(Number.isFinite)
    if (!ranges.length) continue
    probeRanges.push(...ranges)
    out.push(
      line(
        `${probe.name}: spread in 5 min / change in 1 h (MHz)`,
        `worst ${round(Math.max(...ranges))} / ${hourly.length ? round(Math.max(...hourly)) : '-'}`
      )
    )
  }
  if (drift.length)
    out.push(
      line(
        'Global max change from one hour to the next (MHz)',
        `median ${round(median(drift))}, worst ${round(Math.max(...drift))} over ${drift.length} pairs`
      )
    )
  if (probeRanges.length)
    out.push(
      line(
        'Worst spread at any probe inside one burst (MHz)',
        round(Math.max(...probeRanges))
      )
    )

  // 3. The global peak, kept but demoted.
  const ranges = hourlyGrid.map((r) => r.maxMHz.range).filter(Number.isFinite)
  const worstCase = Math.max(0, ...ranges)
  const singleVsTrimmed = hourlyGrid
    .map((r) =>
      Math.abs(
        (r.series.find((s) => s.parsed)?.maxMHz ?? 0) - r.maxMHz.trimmedMean
      )
    )
    .filter(Number.isFinite)
  out.push(
    line(
      'Global max spread inside one hourly burst (MHz)',
      `median ${round(median(ranges))}, worst ${round(worstCase)}`
    ),
    line(
      'First sample vs the burst trimmed mean (MHz)',
      `median ${round(median(singleVsTrimmed))}, worst ${round(Math.max(0, ...singleVsTrimmed))}`
    )
  )
  // A flare run samples continuously for as long as thirty minutes -- its
  // internal spread is a different quantity from a five-minute quiet burst's,
  // so it earns its own row rather than joining the hourly median above.
  if (flareGrid.length) {
    const flareRanges = flareGrid
      .map((r) => r.maxMHz.range)
      .filter(Number.isFinite)
    out.push(
      line(
        'Global max spread inside one flare-triggered run (MHz)',
        `median ${round(median(flareRanges))}, worst ${round(Math.max(0, ...flareRanges))} over ${flareGrid.length} runs`
      )
    )
  }

  // 2. How often is anything absorbed?
  const maxima = withGrid.map((r) => r.maxMHz.max)
  for (const edge of BAND_EDGES_MHZ.slice(0, 4)) {
    const hits = maxima.filter((m) => m >= edge).length
    out.push(
      line(
        `Bursts whose worst cell reached ${edge} MHz`,
        `${hits}/${maxima.length} (${round((hits / maxima.length) * 100, 1)}%)`
      )
    )
  }
  out.push(
    line('Highest cell seen anywhere (MHz)', round(Math.max(0, ...maxima)))
  )

  // 3. Geometry.
  const fromSun = withGrid
    .map((r) => r.worstFromSubsolarKm?.mean)
    .filter(Number.isFinite)
  if (fromSun.length)
    out.push(
      line(
        'Worst cell from the subsolar point (km)',
        `median ${Math.round(median(fromSun))}, max ${Math.round(Math.max(...fromSun))}`
      )
    )

  // 4. Payload.
  const bodies = rows.map((r) => r.distinctBodies).filter(Number.isFinite)
  const times = rows.map((r) => r.distinctValidTimes).filter(Number.isFinite)
  const torn = rows.reduce((n, r) => n + (r.samples - r.parsed), 0)
  out.push(
    line(
      'Distinct bodies per burst',
      `median ${median(bodies)} of a median ${median(rows.map((r) => r.samples))} samples`
    ),
    line('Distinct model valid times per burst', `median ${median(times)}`),
    line(
      'Samples that failed to parse',
      `${torn} of ${rows.reduce((n, r) => n + r.samples, 0)}`
    )
  )

  // Flare correlation, as pairs rather than a claim: a coefficient over a
  // handful of quiet days would be noise dressed as a finding.
  const flares = rows
    .filter((r) => r.xray?.flux && r.maxMHz)
    .map((r) => ({ class: r.xray.class, flux: r.xray.flux, mhz: r.maxMHz.max }))
  if (flares.length) {
    const byClass = new Map()
    for (const f of flares) {
      const letter = f.class[0]
      if (!byClass.has(letter)) byClass.set(letter, [])
      byClass.get(letter).push(f.mhz)
    }
    out.push(
      '',
      '| X-ray class | bursts | median peak MHz | max |',
      '| --- | --- | --- | --- |'
    )
    for (const [letter, values] of [...byClass].sort())
      out.push(
        `| ${letter} | ${values.length} | ${round(median(values))} | ${round(Math.max(...values))} |`
      )
  }
  console.log(out.join('\n'))
}

/**
 * Rows that are one poll interval apart, as pairs. Anything from half an hour
 * to two hours counts as "the next poll" -- the cron is hourly, but a missed
 * run should not silently drop out of the sample, and a pair four hours apart
 * is not measuring the poll interval any more. Callers pass a single-mode
 * slice (hourly or flare); pairing across modes would measure a burst-length
 * change, not a poll-interval one.
 */
function consecutiveHours(rows) {
  const pairs = []
  for (let i = 1; i < rows.length; i++) {
    const gapMin =
      (Date.parse(rows[i].startedAt) - Date.parse(rows[i - 1].startedAt)) /
      60000
    if (gapMin >= 30 && gapMin <= 120) pairs.push([rows[i - 1], rows[i]])
  }
  return pairs
}

function median(values) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

if (process.argv.includes('--report')) await report()
else await run()
