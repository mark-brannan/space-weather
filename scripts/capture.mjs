#!/usr/bin/env node
/**
 * Captures NOAA payloads into `examples/` as test fixtures.
 *
 *   node scripts/capture.mjs slow --commit    # daily, small, tracked
 *   node scripts/capture.mjs fast             # 3-hourly, into examples/captures/
 *   node scripts/capture.mjs fast --only-if-active   # 15-minutely, storms only
 *
 * Deliberately outside the test suite: it needs the live service, and the
 * plugin registry scores this package with `npm test` under --net=none.
 *
 * Cron. The script names its own files, so there is no date(1) call and so
 * nothing for crontab's `%` handling to break -- an unescaped `%` becomes a
 * newline and the rest of the line is fed to the command as stdin, which is
 * how a capture line can silently produce nothing for weeks:
 *
 *   *\/15 * * * * cd ~/signalk-noaa-space-weather && /usr/bin/node scripts/capture.mjs fast --only-if-active >> /tmp/noaa-capture.log 2>&1
 *   0 *\/3 * * *  cd ~/signalk-noaa-space-weather && /usr/bin/node scripts/capture.mjs fast >> /tmp/noaa-capture.log 2>&1
 *   17 6 * * *    cd ~/signalk-noaa-space-weather && /usr/bin/node scripts/capture.mjs slow --commit >> /tmp/noaa-capture.log 2>&1
 *
 * The three are not redundant. A storm is short and a 3-hourly capture lands on
 * its peak by luck, so the 15-minute run exists to catch the peak -- gated on
 * something actually happening, because an ungated one would be 96 fetches a day
 * of a quiet sky. The 3-hourly run is what keeps *quiet* cases coming in, which
 * the gate deliberately excludes.
 *
 * The point is a corpus with *variety* in it. Issue #120 shipped a badge wired
 * to a field that reads 0 in every fixture we had, and the whole suite stayed
 * green because nothing in `examples/` disagreed with it. A fixture set where
 * every capture says the same thing makes every test that reads it vacuous.
 *
 * So this does not keep everything it fetches. Each endpoint declares an
 * "interest key" -- the handful of values that decide whether a payload is a
 * new *case* rather than a new *moment* -- and a capture is written only when
 * its key has never been seen before. Without that, dedupe is impossible:
 * every one of these payloads carries an issue time or a `time_tag`, so a
 * content hash marks a dead-quiet wwv bulletin as new eight times a day and
 * the corpus becomes a log.
 */
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const API = 'https://services.swpc.noaa.gov'
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Timeout per fetch. NOAA is usually fast; a hung socket must not wedge cron. */
const FETCH_TIMEOUT_MS = 30_000

const sha = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12)

/**
 * Interest keys.
 *
 * Each returns the values that make a payload a distinct case. Anything not in
 * the key is a detail we are happy to have only one example of. A key that
 * throws (NOAA sent a shape we don't recognise) falls back to a content hash,
 * so an unparseable payload is always kept rather than silently dropped -- a
 * shape change is the most interesting capture there is.
 */

/**
 * wwv: the severity words and the storm sentences, not the issue time.
 *
 * `are predicted` and `were observed` are in the list because that is how the
 * bulletin says *nothing* is happening ("No space weather storms are predicted
 * for the next 24 hours"). Without them a quiet forecast contributes nothing to
 * the key and two different ways of saying "quiet" collapse into one case.
 */
const wwvKey = (body) =>
  body
    .split('\n')
    .filter((line) => /has been|predicted to be|reaching the|are likely|are predicted|were observed/.test(line))
    .map((line) => line.trim())
    .join(' | ')

/** noaa-scales: all five slots, which is exactly what #120 confused. */
const scalesKey = (body) => {
  const data = JSON.parse(body)
  return ['-1', '0', '1', '2', '3']
    .map((index) => {
      const slot = data[index] ?? {}
      return ['G', 'S', 'R']
        .map((letter) => {
          const cell = slot[letter] ?? {}
          // Forecast rows carry probabilities where observations carry a level.
          return cell.Scale ?? `${cell.Prob ?? ''}/${cell.MinorProb ?? ''}/${cell.MajorProb ?? ''}`
        })
        .join(',')
    })
    .join(' ')
}

/**
 * Flares: the flare's own begin and max class at full resolution, because that
 * pair is what identifies the event -- plus only the *letter* of the current
 * reading. The current class drifts within its letter every few minutes (B7.6
 * to B7.5), and keying on it would file every one of those as a new case.
 */
const flareKey = (body) => {
  const [flare] = JSON.parse(body)
  const letter = String(flare?.current_class ?? '').charAt(0)
  return `${letter} ${flare?.begin_class} ${flare?.max_class}`
}

/** Protons: the order of magnitude per channel, not the exact flux. */
const protonKey = (body) => {
  const latest = {}
  for (const row of JSON.parse(body)) latest[row.energy] = row.flux
  return Object.entries(latest)
    .sort()
    .map(([energy, flux]) => `${energy}:${Math.floor(Math.log10(Math.max(flux, 1e-6)))}`)
    .join(' ')
}

/** Solar wind: 50 km/s and 1 nT buckets. Finer than that is the same weather. */
const windSpeedKey = (body) => {
  const [row] = JSON.parse(body)
  return String(Math.round((row?.proton_speed ?? 0) / 50) * 50)
}
const windMagKey = (body) => {
  const [row] = JSON.parse(body)
  return `${Math.round(row?.bt ?? 0)} ${Math.round(row?.bz_gsm ?? 0)}`
}

/** DRAP: the two message lines and whether a warning or recovery time is set. */
const drapKey = (body) =>
  body
    .split('\n')
    .filter((line) => /X-RAY Message|X-RAY Warning|Proton Message|Recovery Time/.test(line))
    .map((line) => line.trim())
    .join(' | ')

/**
 * The 27-day outlook: the worst day in the window, not the window itself.
 *
 * The table rolls forward one row a day, so hashing its body marks every
 * capture as new whatever the sun is doing -- the "new moment, not new case"
 * failure this whole file exists to avoid, landing in the *tracked* tree. What
 * makes one outlook a different case is whether it forecasts a storm and how
 * big: the peak A index and Kp across the 27 rows, with F10.7 in 10 sfu bands.
 */
const outlook27Key = (body) => {
  const rows = [...body.matchAll(/^\d{4} \w{3} +\d{1,2} +(\d+) +(\d+) +(\d+)\s*$/gm)]
  if (!rows.length) return null
  const column = (index) => rows.map((row) => Number(row[index]))
  const band = (value) => Math.round(value / 10) * 10
  const flux = column(1)
  return `f${band(Math.min(...flux))}-${band(Math.max(...flux))} ap${Math.max(...column(2))} kp${Math.max(...column(3))}`
}

/**
 * Daily solar indices: the newest row only, in bands.
 *
 * Same rolling-window problem -- the feed is the last 30 days, so yesterday
 * drops off the top every night. The case is today's reading: F10.7 in 5 sfu
 * bands and the sunspot number in 10s, which is the resolution at which two
 * days are actually different weather rather than different days.
 */
const dailyIndicesKey = (body) => {
  const rows = [...body.matchAll(/^(\d{4} \d{2} \d{2}) +(\d+) +(\d+)\b/gm)]
  if (!rows.length) return null
  const newest = rows.reduce((best, row) => (row[1] > best[1] ? row : best))
  return `f${Math.round(Number(newest[2]) / 5) * 5} ssn${Math.round(Number(newest[3]) / 10) * 10}`
}

/**
 * Narrative bulletins: the body with the issue timestamp lines removed.
 *
 * Only for feeds that are genuinely re-written per issue rather than rolled
 * forward per day -- the advisory outlook is irregular prose, so distinct text
 * really does mean a distinct case. Do not reach for this for a table.
 */
const bulletinKey = (body) =>
  sha(
    body
      .split('\n')
      .filter((line) => !/^:(Issued|Product)|^#/.test(line))
      .join('\n')
      .trim()
  )

/** Alerts: the set of message codes in force, not the 30-day archive's churn. */
const alertsKey = (body) => {
  const codes = new Set()
  for (const alert of JSON.parse(body)) {
    const match = /Space Weather Message Code:\s*(\S+)/i.exec(alert.message ?? '')
    if (match) codes.add(match[1])
  }
  return [...codes].sort().join(',')
}

/** Kp forecast: the peak Kp and which G levels appear, not the rolling window. */
const kpForecastKey = (body) => {
  const rows = JSON.parse(body)
  const peak = Math.max(...rows.map((row) => Number(row.kp) || 0))
  const scales = [...new Set(rows.map((row) => row.noaa_scale).filter(Boolean))].sort()
  return `${peak} ${scales.join(',')}`
}

/** X-ray flux: the peak per band as a flare class, which is what a reader sees. */
const xrayFluxKey = (body) => {
  const peak = {}
  for (const row of JSON.parse(body)) {
    peak[row.energy] = Math.max(peak[row.energy] ?? 0, Number(row.flux) || 0)
  }
  return Object.entries(peak)
    .sort()
    .map(([band, flux]) => `${band}:${Math.floor(Math.log10(Math.max(flux, 1e-12)))}`)
    .join(' ')
}

/**
 * F10.7 in 10 sfu bands -- a few units of drift is the same solar activity.
 * Narrower than that and the daily reading crosses a boundary most days, which
 * files a new case for what is really the same sun.
 *
 * Picks the newest "Noon" entry rather than trusting the array's order, the
 * same way `parseF107` does: the feed is not sorted, and its last element is
 * routinely weeks old.
 */
const f107Key = (body) => {
  let latest = null
  for (const row of JSON.parse(body)) {
    if (row?.reporting_schedule !== 'Noon') continue
    if (!latest || row.time_tag > latest.time_tag) latest = row
  }
  // No Noon reading at all is a shape change, not a flux of zero: returning a
  // number here would file every such payload under one key and drop all but
  // the first. `null` sends it to the content hash, which keeps them.
  if (!latest) return null
  return String(Math.round(Number(latest.flux) / 10) * 10)
}

/** JSON payloads with no better key: every value except the timestamps. */
const jsonKey = (body) =>
  sha(JSON.stringify(JSON.parse(body), (key, value) => (/time_tag|time_stamp/i.test(key) ? undefined : value)))

/**
 * `slow` lands in `examples/` and is committed: daily or slower, and small
 * enough that a year of them is a rounding error in the repo.
 *
 * `fast` lands in `examples/captures/`, which is gitignored: sub-daily, or
 * large enough that tracking every distinct case would bloat the tree. These are
 * untracked, so promote an interesting one with plain `mv` into `examples/` and
 * then `git add` it -- `git mv` refuses a source git does not know about.
 */
const ENDPOINTS = [
  // --- slow: daily, tracked -------------------------------------------------
  ['slow', '/text/27-day-outlook.txt', '27-day-outlook', 'txt', outlook27Key],
  ['slow', '/text/advisory-outlook.txt', 'advisory-outlook', 'txt', bulletinKey],
  ['slow', '/text/daily-solar-indices.txt', 'daily-solar-indices', 'txt', dailyIndicesKey],
  ['slow', '/json/f107_cm_flux.json', 'f107_cm_flux', 'json', f107Key],
  ['slow', '/json/goes/primary/xray-flares-latest.json', 'xray-flares-latest', 'json', flareKey],

  // --- fast: 3-hourly, gitignored -------------------------------------------
  ['fast', '/text/wwv.txt', 'wwv', 'txt', wwvKey],
  ['fast', '/products/noaa-scales.json', 'noaa-scales', 'json', scalesKey],
  ['fast', '/products/noaa-planetary-k-index-forecast.json', 'noaa-planetary-k-index-forecast', 'json', kpForecastKey],
  ['fast', '/products/summary/solar-wind-speed.json', 'solar-wind-speed', 'json', windSpeedKey],
  ['fast', '/products/summary/solar-wind-mag-field.json', 'solar-wind-mag-field', 'json', windMagKey],
  ['fast', '/products/alerts.json', 'alerts', 'json', alertsKey],
  ['fast', '/text/drap_global_frequencies.txt', 'drap-global-frequencies', 'txt', drapKey],
  ['fast', '/json/goes/primary/integral-protons-6-hour.json', 'integral-protons-6-hour', 'json', protonKey],
  ['fast', '/json/goes/primary/xrays-6-hour.json', 'xrays-6-hour', 'json', xrayFluxKey]
]

/** Where a group's captures land, and whether they are tracked. */
const GROUPS = {
  slow: { dir: 'examples', tracked: true },
  fast: { dir: join('examples', 'captures'), tracked: false }
}

/**
 * Is anything happening worth spending a full capture on?
 *
 * Two cheap fetches (~2.5 KB together) against the two endpoints that answer
 * it: any non-zero observed G/S/R level, or a flare at M or above. Deliberately
 * not a threshold on "interesting" -- G1 and an M1 are common, and the point of
 * the 15-minute run is to be already capturing when a common event turns into
 * an uncommon one.
 */
async function somethingIsHappening() {
  const reasons = []
  try {
    const scales = JSON.parse(await fetchText('/products/noaa-scales.json'))
    for (const index of ['-1', '0']) {
      for (const letter of ['G', 'S', 'R']) {
        const level = Number(scales?.[index]?.[letter]?.Scale)
        if (level > 0) reasons.push(`${letter}${level}`)
      }
    }
  } catch (error) {
    // A probe that cannot be read is itself a reason to capture: either NOAA is
    // broken or the shape moved, and both are worth a fixture.
    return ['scales probe failed: ' + error.message]
  }
  try {
    const [flare] = JSON.parse(await fetchText('/json/goes/primary/xray-flares-latest.json'))
    const current = String(flare?.current_class ?? '')
    if (/^[MX]/.test(current)) reasons.push(current)
  } catch (error) {
    return ['flare probe failed: ' + error.message]
  }
  return reasons
}

async function fetchText(path) {
  const response = await fetch(API + path, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  // Without this an error page is written to disk as though it were a fixture,
  // which is worse than capturing nothing: it looks like data until it is read.
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  return response.text()
}

/** Keys already represented in `dir`, so a case is captured once and not again. */
function seenKeys(dir, prefix, key) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return new Set()
  }
  const seen = new Set()
  for (const name of names) {
    if (!name.startsWith(prefix + '.')) continue
    // A file named `<prefix>.<date>.<ext>` for a *different* product would be
    // caught by the dot: `wwv.` never prefixes `wwv-something`.
    let body
    try {
      body = readFileSync(join(dir, name), 'utf8')
    } catch {
      continue
    }
    seen.add(safeKey(key, body))
  }
  return seen
}

/** A key function that throws means an unrecognised shape -- always interesting. */
function safeKey(key, body) {
  try {
    const value = key(body)
    return value === undefined || value === null ? sha(body) : String(value)
  } catch {
    return 'unparseable:' + sha(body)
  }
}

/** `<prefix>.YYYY_MM_DD.<ext>`, matching the fixtures already in `examples/`. */
function fileName(prefix, ext, existing) {
  const now = new Date()
  const stamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0')
  ].join('_')
  let name = `${prefix}.${stamp}.${ext}`
  // Two distinct cases can land on one UTC day -- a storm arriving is exactly
  // when that happens, and it is the day we least want to overwrite.
  let suffix = 2
  while (existing.has(name)) name = `${prefix}.${stamp}_${suffix++}.${ext}`
  return name
}

function git(args, cwd = REPO) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/**
 * Commits only the paths just written, named explicitly.
 *
 * Cron runs this in a working tree somebody is also using. A bare `git commit`
 * or a `git add .` there would sweep up work in progress, so every path is
 * passed to both `add` and `commit`. `--no-verify` skips `.husky/pre-commit`,
 * which auto-patch-bumps `package.json` -- without it every nightly capture
 * would tag and publish a release.
 */
function commit(paths) {
  if (!paths.length) return
  const gitDir = resolve(REPO, git(['rev-parse', '--git-dir']))
  const inProgress = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD'].find(
    (marker) => existsSync(join(gitDir, marker))
  )
  if (inProgress) {
    console.error(`skipping commit: ${inProgress} in progress`)
    return
  }
  git(['add', '--', ...paths])
  // A capture can be byte-identical to one already committed -- the key said
  // it was a new case, the bytes disagreed. `git commit` treats an empty
  // pathspec as an error, and cron should not get a stack trace for it.
  try {
    git(['diff', '--cached', '--quiet', '--', ...paths])
    console.log('nothing staged: captures matched what is already committed')
    return
  } catch {
    // Non-zero from `--quiet` means there *are* staged changes. Carry on.
  }
  const subject = `test: capture NOAA fixtures (${paths.length} new case${paths.length === 1 ? '' : 's'})`
  git(['commit', '--no-verify', '-m', subject, '--', ...paths])
  console.log(`committed ${paths.length} file(s)`)
}

async function main() {
  const [group, ...flags] = process.argv.slice(2)
  const config = GROUPS[group]
  if (!config) {
    console.error(`usage: capture.mjs <${Object.keys(GROUPS).join('|')}> [--commit]`)
    process.exit(2)
  }

  if (flags.includes('--only-if-active')) {
    const reasons = await somethingIsHappening()
    if (!reasons.length) {
      console.log('quiet: nothing to capture')
      return
    }
    console.log(`active (${[...new Set(reasons)].join(' ')}): capturing`)
  }

  const dir = join(REPO, config.dir)
  mkdirSync(dir, { recursive: true })
  const existing = new Set(readdirSync(dir))
  const written = []
  let failures = 0

  for (const [endpointGroup, path, prefix, ext, key] of ENDPOINTS) {
    if (endpointGroup !== group) continue
    let body
    try {
      body = await fetchText(path)
    } catch (error) {
      // One bad endpoint must not cost us the rest of the run.
      console.error(`${prefix}: fetch failed -- ${error.message}`)
      failures++
      continue
    }

    const thisKey = safeKey(key, body)
    if (seenKeys(dir, prefix, key).has(thisKey)) {
      console.log(`${prefix}: no new case (${thisKey.slice(0, 40)})`)
      continue
    }

    const name = fileName(prefix, ext, existing)
    writeFileSync(join(dir, name), body)
    existing.add(name)
    written.push(join(config.dir, name))
    console.log(`${prefix}: NEW ${name} (${thisKey.slice(0, 40)})`)
  }

  if (config.tracked && flags.includes('--commit')) {
    try {
      commit(written)
    } catch (error) {
      console.error(`commit failed: ${error.message.split('\n')[0]}`)
      process.exit(1)
    }
  }
  // Exit non-zero only if nothing worked, so cron mail means something.
  if (failures && !written.length) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
