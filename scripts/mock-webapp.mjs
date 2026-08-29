// Serves public/ against fabricated Signal K data, so the webapp's UI can be
// worked on without a server, a plugin, or NOAA.
//
//   node scripts/mock-webapp.mjs [port]     # default 8731
//   node scripts/mock-webapp.mjs --upstream http://127.0.0.1:3010 [port]
//   node scripts/mock-webapp.mjs --host 127.0.0.1 [port]   # loopback only
//
// index.html ships unmodified except for a strip appended to it. Everything
// fake is on the wire: every path ROUTES understands is answered here (and
// anything else refresh() polls falls through to the same 404 a real server
// gives an unpublished path), so what renders is the real
// heroState/renderTimer/renderKp/hfCard against data whose shape this file
// has to keep honest. The switcher sets a cookie and reloads, which is why
// the webapp itself needs to know nothing about any of this.
//
// The map's Fetch button is the one thing that doesn't fit that story: a
// fabricated aurora/D-RAP grid would mean mocking tiles.ts, not the webapp.
// Its four routes (aurora-grid, drap-grid, aurora-refresh, drap-refresh) fall
// through to the real products instead -- see loadRealProducts below -- so
// clicking Fetch does a real NOAA request and caches a real grid on disk,
// with or without --upstream.
//
// The states are the things the header has to be able to say. They exist
// because most of them are awkward to reach against a live server -- a real
// G4 happens a few times a solar cycle, and "no data since the plugin
// started" means breaking the plugin on purpose. Add a state here rather than
// hand-editing the DOM in devtools: the point is that the app's own code
// decides what to render.
//
// --upstream trades the fabricated states for a real one: the same ROUTES
// are proxied verbatim to a running Signal K server instead of going
// through payload(), so a branch's public/ (new markup, new copy, a changed
// card) can be viewed against genuine data without repointing
// ~/.signalk/node_modules/signalk-noaa-space-weather at this worktree --
// which would move every other session on that shared server onto this
// branch's build too. The mock states and --upstream are mutually exclusive:
// there is nothing to switch when the numbers are real.
//
// No dependencies, and nothing here is imported by src/ or test/ -- the
// registry clones this repo and runs `npm ci && npm run build && npm test`
// under `firejail --net=none` with a 60 second cap, and this file must stay
// invisible to all three.
import http from 'node:http'
import fs from 'node:fs/promises'
import fssync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public'
)
const REPO_ROOT = path.resolve(ROOT, '..')

// Aurora and D-RAP are the two products the mock states above deliberately
// don't fake (see the `status` and `default` cases in payload() below): both
// buy a global grid, and a fabricated one would be mocking tiles.ts rather
// than the webapp. Real ones are cheap to get -- the products are already
// decoupled from the Signal K `app` object behind the Publisher interface --
// so this pulls in the built plugin (`npm run build`'s dist/) and lets
// aurora-grid/drap-grid/aurora-refresh/drap-refresh fall through to a real
// NOAA fetch, cached on disk exactly the way the real plugin caches it. This
// is why dev:webapp needs a `npm run build` first and needs the network for
// these two buttons -- everything else here stays fabricated and offline.
//
// A real refresh() also publishes the point value at the vessel (probability
// at position, highest affected frequency) via publisher.values() -- the
// same call a real Signal K app object turns into a delta. There's no app
// object here, so this captures those calls into a plain map instead, keyed
// by path, and the swpc/aurora and swpc/drap routes below read it back. Until
// the first real fetch nothing is captured and those two routes keep
// answering from payload()'s fabricated, state-driven value, same as before.
const publishedValues = new Map()
const AURORA_BASE = 'environment.noaa.swpc.aurora'
const DRAP_BASE = 'environment.noaa.swpc.drap'

let realProducts = null
async function loadRealProducts() {
  if (realProducts) return realProducts
  const distIndex = path.join(REPO_ROOT, 'dist', 'index.js')
  if (!fssync.existsSync(distIndex)) {
    throw new Error('dist/ missing -- run `npm run build` first')
  }
  const [
    { aurora },
    { drap },
    { readAuroraCache, writeAuroraCache },
    { readDrapCache },
    { createClient }
  ] = await Promise.all([
    import(path.join(REPO_ROOT, 'dist', 'products', 'aurora.js')),
    import(path.join(REPO_ROOT, 'dist', 'products', 'drap.js')),
    import(path.join(REPO_ROOT, 'dist', 'cache', 'auroraCache.js')),
    import(path.join(REPO_ROOT, 'dist', 'cache', 'drapCache.js')),
    import(path.join(REPO_ROOT, 'dist', 'noaa', 'client.js'))
  ])

  // A scratch data dir standing in for the real plugin's
  // app.getDataDirPath() -- same write-then-rename cache files, just under
  // the OS temp dir instead of ~/.signalk/plugin-config-data/.
  const dataDirPath = path.join(
    os.tmpdir(),
    'signalk-noaa-space-weather-mock-webapp'
  )
  fssync.mkdirSync(dataDirPath, { recursive: true })

  // Fixed vessel position, matching payload()'s 'position' case above, so a
  // real refresh can publish a point value at the same coordinates the
  // webapp's position tile already shows.
  const FIXED_POSITION = { latitude: 47.6578, longitude: -122.3773 }

  const publisher = {
    meta() {},
    values(vals, timestamp) {
      for (const { path: p, value } of vals)
        publishedValues.set(p, { value, timestamp })
    },
    value(p, value, timestamp) {
      this.values([{ path: p, value }], timestamp)
    },
    selfPath(p) {
      if (p.startsWith('navigation.position')) return { value: FIXED_POSITION }
      return null
    },
    status(message) {
      console.log(`[aurora/drap] ${message}`)
    },
    fail(message) {
      console.error(`[aurora/drap] ${message}`)
    },
    error(message, ...args) {
      console.error(`[aurora/drap] ${message}`, ...args)
    },
    debug() {},
    dataDirPath: () => dataDirPath
  }
  const client = createClient(publisher)
  const settings = {
    sendAdvisoryOutlook: false,
    auroraEnabled: false,
    auroraInterval: 900,
    drapEnabled: false,
    alarmLevel: 4,
    popupLevel: 3,
    updateInterval: 15
  }
  const ctx = { client, publisher, settings, stopped: () => false }

  realProducts = {
    aurora,
    drap,
    readAuroraCache,
    writeAuroraCache,
    readDrapCache,
    ctx,
    dataDirPath
  }
  return realProducts
}

// name is 'aurora' or 'drap' -- both index real[name] (the Product) and
// real[`read${Aurora,Drap}Cache`] (its cache reader), so one function covers
// both grid and refresh handling for either product.
const READ_CACHE = { aurora: 'readAuroraCache', drap: 'readDrapCache' }
const NOT_CACHED = {
  aurora:
    "No aurora data cached yet. Fetch one on demand from this plugin's webapp, or turn on automatic aurora updates in the plugin configuration.",
  drap: "No D-RAP data cached yet. Fetch one on demand from this plugin's webapp, or turn on HF absorption in the plugin configuration."
}

// Mirrors refreshHandler in src/index.ts closely enough for the webapp's
// button to behave the same: only answer 200 once a new grid has actually
// landed. There is no scheduler here to defer a next run against, so that
// half of the real handler is just dropped.
async function handleRefresh(name, res) {
  let real
  try {
    real = await loadRealProducts()
  } catch (err) {
    // The full error (e.g. "dist/ missing -- run npm run build first") goes
    // to this process's own console, not the response: this is the same
    // machine either way, but CodeQL flags any error text reaching an HTTP
    // response on principle, and there's no cost to keeping the habit here.
    console.error(err)
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        error:
          'Could not load the real NOAA products -- see the server console.'
      })
    )
    return
  }
  const readCache = real[READ_CACHE[name]]
  const before = readCache(real.dataDirPath)
  try {
    await real[name].refresh(real.ctx)
  } catch (err) {
    console.error(err)
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        error: `${name} refresh failed -- see the server console.`
      })
    )
    return
  }
  const cached = readCache(real.dataDirPath)
  if (!cached || cached.fetchedAt === before?.fetchedAt) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        error: `Refreshed, but no new ${name} grid came back from NOAA.`
      })
    )
    return
  }
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(cached))
}

async function handleGrid(name, res) {
  let real
  try {
    real = await loadRealProducts()
  } catch (err) {
    // The full error (e.g. "dist/ missing -- run npm run build first") goes
    // to this process's own console, not the response: this is the same
    // machine either way, but CodeQL flags any error text reaching an HTTP
    // response on principle, and there's no cost to keeping the habit here.
    console.error(err)
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        error:
          'Could not load the real NOAA products -- see the server console.'
      })
    )
    return
  }
  const cached = real[READ_CACHE[name]](real.dataDirPath)
  if (!cached) {
    // no-store: a browser caching "nothing yet" would keep saying so after
    // the next refresh actually lands one.
    res.writeHead(404, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    })
    res.end(JSON.stringify({ error: NOT_CACHED[name] }))
    return
  }
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(cached))
}

const argv = process.argv.slice(2)
let upstreamArg = null
let portArg = null
let hostArg = null
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--upstream') upstreamArg = argv[++i]
  else if (argv[i].startsWith('--upstream='))
    upstreamArg = argv[i].slice('--upstream='.length)
  else if (argv[i] === '--host') hostArg = argv[++i]
  else if (argv[i].startsWith('--host='))
    hostArg = argv[i].slice('--host='.length)
  else if (portArg === null) portArg = argv[i]
}
const PORT = Number(portArg || 8731)
// Binds every interface by default: the point of this rig is to put a change in
// front of somebody on another device, and 127.0.0.1 only resolves on the
// machine running it. --host narrows it back for a hostile network.
const HOST = hostArg || '0.0.0.0'

// Printed rather than guessed at, so the URL to paste into a phone is in the
// output instead of requiring an `ip addr` on the side.
function listenUrls() {
  // An IPv6 literal is only a valid authority in brackets, and --host takes
  // one verbatim.
  const authority = (addr) => (addr.includes(':') ? `[${addr}]` : addr)
  if (HOST !== '0.0.0.0' && HOST !== '::')
    return [`http://${authority(HOST)}:${PORT}/`]
  // Node 18.0.x reports `family` as the number 4 rather than 'IPv4' (and 6
  // rather than 'IPv6'), and package.json still supports >=18, so a string
  // compare alone would print nothing but loopback there -- exactly the case
  // this function exists for.
  const six = HOST === '::'
  const wanted = six ? ['IPv6', 6] : ['IPv4', 4]
  // Link-local is not internal, but it is not shareable either: an fe80::/10
  // URL needs a zone identifier, and this machine's zone is meaningless on
  // the device the link is being pasted into. Same for 169.254/16.
  const linkLocal = (a) =>
    /^fe[89ab][0-9a-f]:/i.test(a) || a.startsWith('169.254.')
  const addrs = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && wanted.includes(n.family) && !n.internal)
    .map((n) => n.address)
    .filter((a) => !linkLocal(a))
  return [
    `http://${six ? '[::1]' : '127.0.0.1'}:${PORT}/`,
    ...addrs.map((a) => `http://${authority(a)}:${PORT}/`)
  ]
}
// Trailing slash stripped once here so every proxied request can just concatenate
// base + path without re-checking for a double slash.
const UPSTREAM = upstreamArg ? upstreamArg.replace(/\/+$/, '') : null

const iso = (offsetMin) =>
  new Date(Date.now() + offsetMin * 60000).toISOString()
// The published F10.7 zone ladder, mirroring `zonesForF107` in src/parse.ts.
const F107_ZONES = [
  {
    lower: 0,
    upper: 70,
    state: 'normal',
    message: 'High bands essentially closed'
  },
  { lower: 70, upper: 90, state: 'normal', message: 'Poor HF conditions' },
  { lower: 90, upper: 120, state: 'normal', message: 'Fair HF conditions' },
  { lower: 120, upper: 150, state: 'nominal', message: 'Good HF conditions' },
  { lower: 150, state: 'nominal', message: 'Excellent HF conditions' }
]

const leaf = (value, offsetMin = -6) => ({
  value,
  timestamp: iso(offsetMin),
  $source: 'mock'
})

// Matches NOAA's own ":Issued:" line (e.g. "2026 Aug 18 0341 UTC") so the
// mock advisory's header and its parsed `issued` field can share one instant.
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]
const fmtIssued = (offsetMin) => {
  const d = new Date(Date.now() + offsetMin * 60000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}${pad(d.getUTCMinutes())} UTC`
}

/**
 * A Kp forecast from now to +72h, three-hourly, peaking where told. The
 * timer reads this and nothing else, so `peakInMin` is what actually decides
 * whether the hero says "until G3 window", "until easing", or "no storm
 * inbound" -- not the observed levels.
 */
function series({ peakKp, peakInMin, base = 2 }) {
  const out = []
  for (let m = 0; m <= 72 * 60; m += 180) {
    let kp = base + Math.sin(m / 900) * 0.6
    if (peakKp != null) {
      const d = Math.abs(m - peakInMin) / 600
      kp = Math.max(kp, peakKp - d * 2.2)
    }
    out.push({
      time: iso(m),
      kp: Math.round(Math.max(0.33, Math.min(9, kp)) * 3) / 3,
      forecast: true
    })
  }
  return out
}

/** A watch body, in NOAA's layout -- the list renders this verbatim. */
function watchText(level, firstDay, stormDay) {
  const cell = (d) => d.toUTCString().slice(5, 11).replace(/^0/, '')
  return [
    'Space Weather Message Code: WATA30',
    'Serial Number: 279',
    `Issue Time: ${fmtIssued(0)}`,
    '',
    `WATCH: Geomagnetic Storm Category G${level} Predicted`,
    '',
    'Highest Storm Level Predicted by Day:',
    `${cell(firstDay)}:  None (Below G1)   ${cell(stormDay)}:  G${level} (Moderate)`,
    '',
    'THIS SUPERSEDES ANY/ALL PRIOR WATCHES IN EFFECT',
    '',
    'NOAA Space Weather Scale descriptions can be found at',
    'www.swpc.noaa.gov/noaa-scales-explanation',
    '',
    `Potential Impacts: Area of impact primarily poleward of 55 degrees Geomagnetic Latitude.`,
    'Induced Currents - Power grid fluctuations can occur. High-latitude power systems',
    'may experience voltage alarms.',
    'Aurora - Aurora may be seen as low as New York to Wisconsin to Washington state.'
  ].join('\n')
}

const ADVISORY_ISSUED_MIN = -1140
const ADVISORY = {
  idLine: 'Product: Weekly Highlights and 27-Day Forecast',
  issued: iso(ADVISORY_ISSUED_MIN),
  teaser:
    'Solar activity is expected to be at very low to low levels, with a chance for M-class flares.',
  text: [
    ':Product: Weekly Highlights and 27-Day Forecast',
    `:Issued: ${fmtIssued(ADVISORY_ISSUED_MIN)}`,
    '# Prepared by the U.S. Dept. of Commerce, NOAA, Space Weather Prediction Center',
    '',
    'Solar activity is expected to be at very low to low levels, with a chance',
    'for M-class flares throughout the outlook period. No proton events are',
    'expected. The greater than 2 MeV electron flux is expected to reach high',
    'levels on 20-22 Aug due to recurrent coronal hole high speed stream',
    'influence.',
    '',
    'Geomagnetic field activity is expected to reach G1 (Minor) storm levels on',
    '21 Aug, with unsettled to active levels on 20 and 22 Aug.'
  ].join('\n')
}

const STATES = {
  quiet: {
    // Genuinely nothing: the only combination that reaches the quiet banner,
    // since a level NOAA put a name to is a level the page describes (#126).
    label: 'Quiet',
    observed: { G: 0, S: 0, R: 0 },
    peak24h: { G: 0, S: 0, R: 0 },
    kpObserved: 2.33,
    series: series({ peakKp: 3.67, peakInMin: 1800 }),
    sfi: 96 // Fair (90-119)
  },
  recent: {
    // Live on 2026-08-25, and the case that showed the banner was wrong: the
    // instantaneous sample reads R0 while NOAA's 24-hour maximum and the WWV
    // bulletin both say R2, moderate. Below the alert floor, so nothing here
    // makes a sound -- which is the point. Impractical to wait for, like the
    // rest of these.
    label: 'R2 in the past 24h',
    observed: { G: 0, S: 0, R: 0 },
    peak24h: { G: 1, S: 0, R: 2 },
    kpObserved: 3.33,
    series: series({ peakKp: 4.0, peakInMin: 1500 }),
    sfi: 78 // Poor (70-89)
  },
  brewing: {
    label: 'G3 forecast',
    observed: { G: 0, S: 0, R: 1 },
    peak24h: { G: 1, S: 0, R: 1 },
    kpObserved: 3.0,
    series: series({ peakKp: 7.0, peakInMin: 860 }),
    sfi: 118 // Fair, near the Good boundary
  },
  watch: {
    // The 2026-08-28 case: a CME left the sun, NOAA issued a G2 watch for the
    // day it arrives, and the Kp forecast has not moved yet. Everything the
    // page reads except the watch says quiet, which is exactly why this state
    // has to exist -- it is unreachable by waiting, since the interesting
    // window is the two days *before* anything happens.
    label: 'G2 watch, quiet series',
    observed: { G: 0, S: 0, R: 0 },
    peak24h: { G: 0, S: 0, R: 0 },
    kpObserved: 2.0,
    series: series({ peakKp: 3.0, peakInMin: 1800 }),
    watchDayInMin: 2400,
    watchLevel: 2,
    // The watch above plus the one it superseded, which the plugin stood down
    // rather than deleted -- the pair is what the messages list has to get
    // right, since a withdrawn watch shown as live is the same failure as a
    // live one shown as nothing.
    messages: [
      {
        code: 'WATA20',
        alertLevel: 'WATCH',
        scale: 'G1 - Minor',
        issuedMin: -2160,
        state: 'normal',
        serialNumber: '278',
        message: 'WATCH: Geomagnetic Storm Category G1 Predicted',
        // Matches the body text below -- a stood-down watch still carries the
        // table it was superseded with, so its day chips are reachable too.
        predictedByDay: [
          { date: iso(-2160), letter: 'G', level: 1 },
          { date: iso(-2160 + 24 * 60), letter: 'G', level: 0 }
        ],
        body: [
          'Highest Storm Level Predicted by Day:',
          'Aug 28:  G1 (Minor)   Aug 29:  None (Below G1)',
          '',
          'THIS SUPERSEDES ANY/ALL PRIOR WATCHES IN EFFECT'
        ]
      }
    ]
  },
  eased: {
    // A real storm (G3, above NOTABLE) ended, but a quieter G1 is still
    // running under it. Unreachable against a live sky on demand, and the
    // one all-clear shape where chip, headline and sub must all name the
    // level still in force rather than claiming quiet.
    label: 'G3 eased to G1, still in force',
    observed: { G: 1, S: 0, R: 0 },
    peak24h: { G: 3, S: 0, R: 0 },
    kpObserved: 4.0,
    series: series({ peakKp: 5.0, peakInMin: 1200 }),
    sfi: 135 // Good (120-149)
  },
  storm: {
    // Two scales at once, so the hero has to fold an "Also S4:" clause into
    // the impact sentence -- the longest string the layout ever carries.
    label: 'G4 + S4 in force',
    // What a real storm's messages look like: the alert that fired, the
    // warning still running under it, and the summary of the burst that has
    // already passed. Three verbs, three states, one story.
    messages: [
      {
        code: 'ALTK08',
        alertLevel: 'ALERT',
        scale: 'G4 - Severe',
        issuedMin: -95,
        state: 'warn',
        serialNumber: '4051',
        message: 'ALERT: Geomagnetic K-index of 8, Severe',
        body: [
          'Threshold Reached: 2026 Aug 29 1804 UTC',
          'Synoptic Period: 1800-2100 UTC',
          '',
          'Active Warning: Yes',
          'Potential Impacts: Area of impact primarily poleward of 45 degrees',
          'Geomagnetic Latitude. Induced Currents - Possible widespread voltage',
          'control problems. Aurora - Aurora may be seen as low as Alabama and',
          'northern California.'
        ]
      },
      {
        code: 'WARK07',
        alertLevel: 'WARNING',
        scale: 'G3 - Strong',
        issuedMin: -260,
        validUntilMin: 160,
        state: 'warn',
        serialNumber: '2210',
        message: 'WARNING: Geomagnetic K-index of 7 expected',
        body: [
          'Valid From: 2026 Aug 29 1500 UTC',
          'Valid To: 2026 Aug 30 0000 UTC',
          'Warning Condition: Persistence'
        ]
      },
      {
        code: 'SUM10R',
        alertLevel: 'SUMMARY',
        scale: 'R2 - Moderate',
        issuedMin: -640,
        state: 'normal',
        serialNumber: '1877',
        message: 'SUMMARY: X-ray Event exceeded M5',
        body: [
          'Begin Time: 2026 Aug 29 0712 UTC',
          'Maximum Time: 2026 Aug 29 0741 UTC',
          'End Time: 2026 Aug 29 0759 UTC',
          'X-ray Class: M6.4',
          'Optical Class: 2n',
          'Location: S14W38'
        ]
      }
    ],
    observed: { G: 4, S: 4, R: 2 },
    peak24h: { G: 4, S: 4, R: 3 },
    kpObserved: 8.0,
    series: series({ peakKp: 8.33, peakInMin: 180, base: 5 }),
    sfi: 187 // Excellent (>=150) -- also the longest quality word, on the state
    // with the widest MUF/headline text, so the SFI badge's flex-middle
    // spacing gets checked against the tile's most crowded layout too.
  },
  stale: {
    label: 'Stale data',
    observed: { G: 1, S: 0, R: 0 },
    peak24h: { G: 1, S: 0, R: 0 },
    kpObserved: 2.0,
    series: series({ peakKp: 3.0, peakInMin: 1200 }),
    ageMin: -400, // older than the webapp's STALE_MS
    sfi: 65 // High bands essentially closed (<70)
  },
  nodata: {
    // Nothing published at all, with the plugin up long enough that silence
    // has stopped meaning "starting up".
    label: 'No data since start',
    observed: null,
    peak24h: null,
    kpObserved: null,
    series: null,
    startedMin: -60
  }
}

function payload(name, s) {
  const age = s.ageMin ?? -6
  const scales = (levels) =>
    levels === null
      ? null
      : {
          G: leaf(levels.G, age),
          S: leaf(levels.S, age),
          R: leaf(levels.R, age),
          time: leaf(iso(age), age)
        }

  switch (name) {
    case 'latest':
      return scales(s.observed)
    case '24h':
      return scales(s.peak24h)
    case 'forecast': {
      if (s.observed === null) return null
      // The day() arguments below are whole percents, the way NOAA states
      // them and the way they are readable here. Signal K carries ratios, so
      // serve ratios: handing the card a percent made it draw "1500%".
      const ratio = (pct) => leaf(pct / 100)
      const day = (n, g, sp, rMin, rMaj) => ({
        time: leaf(iso(n * 1440)),
        G: leaf(g),
        S: { probability: ratio(sp) },
        R: { minorProbability: ratio(rMin), majorProbability: ratio(rMaj) }
      })
      const lead = s.observed.G
      return {
        '1day': day(1, Math.max(lead, 2), 15, 25, 5),
        '2day': day(2, Math.max(lead - 1, 1), 10, 20, 1),
        '3day': day(3, 1, 5, 15, 1)
      }
    }
    case 'kp':
      if (s.kpObserved === null) return null
      return {
        observed: leaf(s.kpObserved, s.ageMin ?? -6),
        forecast: {
          max24h: leaf(Math.max(...s.series.slice(0, 8).map((p) => p.kp))),
          max72h: leaf(Math.max(...s.series.map((p) => p.kp))),
          maxNoaaScale: leaf(s.observed?.G ?? 0),
          series: leaf(s.series)
        }
      }
    case 'alerts': {
      // The whole subtree, one leaf per NOAA message code -- what the hero's
      // `watchAhead` and the messages list both read. A state's `messages`
      // are written the way NOAA writes them, because the list renders
      // NOAA's own words and a paraphrase would not show what it looks like.
      const out = {}
      if (s.watchLevel) {
        const day = new Date(Date.now() + s.watchDayInMin * 60000)
        day.setUTCHours(0, 0, 0, 0)
        const yesterday = new Date(day.getTime() - 24 * 60 * 60 * 1000)
        out.WATA30 = leaf({
          id: 'noaa_swpc_alert_WATA30',
          serialNumber: '279',
          issued: new Date().toISOString(),
          validUntil: null,
          message: `WATCH: Geomagnetic Storm Category G${s.watchLevel} Predicted`,
          description: watchText(s.watchLevel, yesterday, day),
          alertLevel: 'WATCH',
          scale: `G${s.watchLevel} - Moderate`,
          state: 'alert',
          method: [],
          predictedByDay: [
            { date: yesterday.toISOString(), letter: 'G', level: 0 },
            { date: day.toISOString(), letter: 'G', level: s.watchLevel }
          ]
        })
      }
      for (const m of s.messages ?? []) {
        out[m.code] = leaf({
          id: `noaa_swpc_alert_${m.code}`,
          serialNumber: m.serialNumber ?? '1000',
          issued: iso(m.issuedMin),
          validUntil: m.validUntilMin != null ? iso(m.validUntilMin) : null,
          message: m.message,
          description: [
            `Space Weather Message Code: ${m.code}`,
            `Serial Number: ${m.serialNumber ?? '1000'}`,
            `Issue Time: ${fmtIssued(m.issuedMin)}`,
            '',
            m.message,
            ...(m.scale ? [`NOAA Scale: ${m.scale}`] : []),
            '',
            ...(m.body ?? [])
          ].join('\n'),
          alertLevel: m.alertLevel,
          scale: m.scale ?? '',
          state: m.state,
          method: [],
          predictedByDay: m.predictedByDay ?? []
        })
      }
      return out
    }
    case 'wind':
      if (s.observed === null) return null
      // Tesla, not the nT an operator quotes: Signal K carries SI and the tile
      // converts on the way out, so nT here rendered as "5000000000.0 nT".
      return {
        speed: leaf(s.observed.G >= 3 ? 720000 : 412000),
        Bt: leaf((s.observed.G >= 3 ? 24 : 5) * 1e-9),
        Bz: leaf((s.observed.G >= 3 ? -18 : -2) * 1e-9)
      }
    // The vessel-position point value the ring tile draws. publishedValues
    // is only populated once a real aurora-refresh has actually landed one
    // (see loadRealProducts above); until then this stays the empty state
    // it always was -- there is no fabricated grid to derive a number from.
    case 'aurora': {
      const probability = publishedValues.get(`${AURORA_BASE}.probability`)
      if (!probability) return null
      const obsTime = publishedValues.get(`${AURORA_BASE}.observationTime`)
      const fcTime = publishedValues.get(`${AURORA_BASE}.forecastTime`)
      const asLeaf = (entry) => ({
        value: entry.value,
        timestamp: entry.timestamp,
        $source: 'mock'
      })
      return {
        probability: asLeaf(probability),
        ...(obsTime ? { observationTime: asLeaf(obsTime) } : {}),
        ...(fcTime ? { forecastTime: asLeaf(fcTime) } : {})
      }
    }
    case 'xray':
      return s.observed === null
        ? null
        : {
            class: leaf(s.observed.R >= 2 ? 'M4.2' : 'C1.8'),
            max24h: { class: leaf(s.peak24h.R >= 2 ? 'M6.9' : 'C2.4') }
          }
    // The HF paths, keyed off the levels the state already declares, so a
    // state stays a couple of numbers to write -- unless a real drap-refresh
    // has already landed a real value (see the aurora case above), in which
    // case that takes precedence over the fabricated one.
    case 'drap': {
      const real = publishedValues.get(
        `${DRAP_BASE}.highest_affected_frequency`
      )
      if (real) {
        const validTime = publishedValues.get(`${DRAP_BASE}.validTime`)
        return {
          highest_affected_frequency: {
            value: real.value,
            timestamp: real.timestamp,
            $source: 'mock'
          },
          validTime: validTime
            ? {
                value: validTime.value,
                timestamp: validTime.timestamp,
                $source: 'mock'
              }
            : leaf(iso(age), age)
        }
      }
      if (s.observed === null) return null
      // Off the worse of R and S, not R alone: both scales raise the same
      // absorption floor -- flare X-rays on the sunlit side, solar protons
      // over the polar caps -- so an S4 with a quiet R still shuts the low
      // bands. It is also what gives the strip a nearly-full state to draw.
      // Cutoffs chosen to land between the band edges rather than on them.
      const mhz = [0, 5, 12, 18, 23, 30][Math.max(s.observed.R, s.observed.S)]
      return {
        highest_affected_frequency: leaf(mhz * 1e6, age),
        validTime: leaf(iso(age), age)
      }
    }
    case 'xrayFlux': {
      if (s.observed === null) return null
      // A leaf that also carries a child, which is what the plugin publishes:
      // `trend` is derived from the same series `xray_flux` samples, so it
      // hangs off it rather than beside it. A rising floor while a blackout is
      // in force, clearing once the instantaneous R has fallen below the day's
      // peak -- the two words the tile has to be able to say, and steady in
      // between.
      const trend =
        s.observed.R >= 2 ? 2.4 : s.observed.R < s.peak24h.R ? 0.6 : 1.02
      return {
        ...leaf(s.observed.R >= 2 ? 4.2e-5 : 1.8e-6, age),
        trend: leaf(trend, age)
      }
    }
    case 'protonFlux':
      // In pfu the S levels are decades from 10, and the path carries SI.
      return s.observed === null
        ? null
        : leaf(Math.pow(10, s.observed.S) * 1e4, age)
    case 'f107':
      // Walks the convention's five bands across the states rather than
      // tracking the storm: solar flux is a solar-cycle number, and whether
      // today has a flare in it says nothing about this month's flux. Each
      // state's own `sfi` field carries its band -- keyed by R instead, the
      // dial only ever reached Fair or Excellent, since `observed.R` never
      // goes past 2 across these seven states.
      //
      // Carries `meta.zones` because the HF tile's solar-flux gauge is drawn
      // from the published ladder, not a webapp copy of it -- without the
      // metadata here the mock would only ever exercise the fallback. Mirrors
      // `zonesForF107` in src/parse.ts.
      return s.observed === null
        ? null
        : {
            ...leaf(s.sfi, -300),
            meta: { zones: F107_ZONES }
          }
    case 'aIndex':
      return s.observed === null ? null : leaf(s.peak24h.G >= 3 ? 48 : 6, -300)
    case 'sunspotNumber':
      return s.observed === null ? null : leaf(112, -300)
    case 'position':
      return leaf({ latitude: 47.6578, longitude: -122.3773 }, -1)
    case 'advisory':
      return s.observed === null ? null : ADVISORY
    case 'status':
      // auroraEnabled/drapEnabled stay false: they govern the schedule, not
      // the capability, and this mock never runs one -- the map's Fetch
      // button drives a real refresh regardless (see loadRealProducts).
      return {
        startedAt: iso(s.startedMin ?? -720),
        settings: {
          auroraEnabled: false,
          auroraInterval: 900,
          drapEnabled: false,
          updateInterval: 15
        }
      }
    default:
      return null
  }
}

const ROUTES = [
  [/scales\/observations\/latest$/, 'latest'],
  [/scales\/observations\/24_hours_maximums$/, '24h'],
  [/scales\/forecast$/, 'forecast'],
  [/swpc\/kp$/, 'kp'],
  [/swpc\/solar_wind$/, 'wind'],
  [/swpc\/aurora$/, 'aurora'],
  [/swpc\/xray_flare$/, 'xray'],
  [/swpc\/xray_flux$/, 'xrayFlux'],
  [/swpc\/proton_flux$/, 'protonFlux'],
  [/swpc\/drap$/, 'drap'],
  [/swpc\/f107$/, 'f107'],
  [/swpc\/a_index$/, 'aIndex'],
  [/swpc\/sunspot_number$/, 'sunspotNumber'],
  [/noaa\/swpc\/alerts$/, 'alerts'],
  [/navigation\/position$/, 'position'],
  [/advisory-outlook$/, 'advisory'],
  [/space-weather\/status$/, 'status']
]

const SWITCHER = (current) => `
<div data-mock-strip style="position:fixed;left:0;right:0;bottom:0;z-index:9999;display:flex;gap:8px;
  align-items:center;flex-wrap:wrap;padding:8px 14px;background:#000;border-top:1px solid #444;
  font:12px/1.4 ui-monospace,monospace;color:#888;">
  <span style="letter-spacing:.12em;text-transform:uppercase;">Mock data</span>
  ${Object.entries(STATES)
    .map(
      ([k, v]) =>
        `<a href="/mock/${k}" style="padding:4px 10px;border:1px solid ${k === current ? '#ffb238' : '#444'};
          border-radius:4px;color:${k === current ? '#ffb238' : '#ccc'};text-decoration:none;">${v.label}</a>`
    )
    .join('')}
  <span style="margin-left:auto;">This strip is 44px tall &mdash; discount it when judging the 800&times;480 budget</span>
</div>
<div data-mock-strip style="height:44px"></div>`

// --upstream's equivalent of SWITCHER: there is no state to pick, so this says
// instead which half of what's on screen is this branch's and which is the live
// server's -- the confusion the state switcher never has to guard against, since
// every state there is equally fake.
const LIVE_BANNER = (base) => `
<div data-mock-strip style="position:fixed;left:0;right:0;bottom:0;z-index:9999;display:flex;gap:8px;
  align-items:center;flex-wrap:wrap;padding:8px 14px;background:#000;border-top:1px solid #2a5;
  font:12px/1.4 ui-monospace,monospace;color:#8f8;">
  <span style="letter-spacing:.12em;text-transform:uppercase;">Live upstream</span>
  <span style="color:#ccc;">${base}</span>
  <span style="margin-left:auto;">public/ is this branch's; the data paths are ${base}'s</span>
</div>
<div data-mock-strip style="height:44px"></div>`

// Proxies one of the ROUTES verbatim: same pathname and query, upstream's
// status and body passed straight through, so a 404 (nothing published on that
// path yet) reaches the webapp exactly as it would from that server directly.
async function proxyToUpstream(url, res) {
  const target = UPSTREAM + url.pathname + url.search
  let upstreamRes
  try {
    upstreamRes = await fetch(target, {
      headers: { Accept: 'application/json' }
    })
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `Upstream fetch failed: ${err.message}` }))
    return
  }
  const body = Buffer.from(await upstreamRes.arrayBuffer())
  res.writeHead(upstreamRes.status, {
    'Content-Type':
      upstreamRes.headers.get('content-type') || 'application/json',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

// index.html carries no <meta charset>, so the header has to supply one: a
// real Signal K server does, and without it every curly quote in the hero
// copy renders as mojibake.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    let state = 'quiet'
    if (!UPSTREAM) {
      const cookie = /mockstate=([a-z]+)/.exec(req.headers.cookie || '')
      state = STATES[cookie?.[1]] ? cookie[1] : 'quiet'

      const pick = /^\/mock\/([a-z]+)$/.exec(url.pathname)
      if (pick) {
        const next = STATES[pick[1]] ? pick[1] : 'quiet'
        res
          .writeHead(302, {
            'Set-Cookie': `mockstate=${next}; Path=/`,
            Location: '/'
          })
          .end()
        return
      }
    }

    // Aurora and D-RAP's grid/refresh routes fall through to a real NOAA
    // fetch and a real on-disk cache (see loadRealProducts above) rather than
    // going through payload() or the upstream proxy -- so a branch's public/
    // can be checked against a real fetch with no running plugin and no
    // --upstream server at all. Everything else stays proxied/fabricated.
    if (/aurora-grid$/.test(url.pathname)) return handleGrid('aurora', res)
    if (/drap-grid$/.test(url.pathname)) return handleGrid('drap', res)
    if (/aurora-refresh$/.test(url.pathname))
      return handleRefresh('aurora', res)
    if (/drap-refresh$/.test(url.pathname)) return handleRefresh('drap', res)

    const route = ROUTES.find(([re]) => re.test(url.pathname))
    if (route) {
      if (UPSTREAM) {
        await proxyToUpstream(url, res)
        return
      }
      const body = payload(route[1], STATES[state])
      if (body === null) {
        // What a Signal K server does for a path no product has published --
        // the state the webapp's null handling is written against.
        res.writeHead(404).end('{}')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      })
      res.end(JSON.stringify(body))
      return
    }
    if (url.pathname.startsWith('/signalk/')) {
      res.writeHead(404).end('{}')
      return
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    const file = path.join(ROOT, rel)
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end()
      return
    }
    try {
      let buf = await fs.readFile(file)
      const type = MIME[path.extname(file)] || 'application/octet-stream'
      if (rel === 'index.html') {
        // index.html is tag soup -- no <html>, <head> or <body> -- so there is
        // no closing tag to inject before. Append.
        const strip = UPSTREAM ? LIVE_BANNER(UPSTREAM) : SWITCHER(state)
        buf = Buffer.from(buf.toString('utf8') + strip, 'utf8')
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
      res.end(buf)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  .listen(PORT, HOST, () => {
    for (const url of listenUrls())
      console.log(`mock signalk + webapp on ${url}`)
    if (UPSTREAM)
      console.log(`proxying ${ROUTES.length} data paths to ${UPSTREAM}`)
    else console.log(`states: ${Object.keys(STATES).join(', ')}`)
  })
