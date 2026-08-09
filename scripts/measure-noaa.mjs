#!/usr/bin/env node
/**
 * Re-measures everything in docs/noaa-products.md.
 *
 *   node scripts/measure-noaa.mjs            # sizes + conditional GET (~6 min)
 *   node scripts/measure-noaa.mjs --cadence  # adds a 15-minute content watch
 *
 * Deliberately outside the test suite: it needs the live service, and the
 * plugin registry scores this package with `npm test` under --net=none.
 *
 * Prints a markdown table. Paste it into the doc with today's date; do not
 * paraphrase the numbers into a source comment. See AGENTS.md.
 */
import { createHash } from 'crypto'

const API = 'https://services.swpc.noaa.gov'

/** Every endpoint the plugin fetches, and the product that owns it. */
const ENDPOINTS = [
  ['/products/noaa-scales.json', 'scales'],
  ['/json/goes/primary/xray-flares-latest.json', 'scales (flare class)'],
  ['/products/noaa-planetary-k-index-forecast.json', 'kp'],
  ['/products/summary/solar-wind-speed.json', 'solarWind'],
  ['/products/summary/solar-wind-mag-field.json', 'solarWind'],
  ['/products/alerts.json', 'alerts'],
  ['/json/f107_cm_flux.json', 'f107'],
  ['/json/ovation_aurora_latest.json', 'aurora'],
  ['/text/advisory-outlook.txt', 'advisory']
]

/** Gap between conditional probes. Longer than any observed rewrite cycle. */
const PROBE_GAP_MS = 150_000
const CADENCE_SAMPLES = 15
const CADENCE_INTERVAL_MS = 60_000

const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 10)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Bytes actually crossing the wire, which is not the decoded size. */
async function wireBytes(path) {
  const response = await fetch(API + path, {
    headers: { 'Accept-Encoding': 'gzip' }
  })
  const buffer = await response.arrayBuffer()
  // Node's fetch decompresses transparently, so ask for the compressed length
  // via the header when the server states it, and fall back to the decoded
  // size with a marker rather than silently reporting the wrong number.
  const stated = response.headers.get('content-length')
  return {
    wire: stated ? Number(stated) : null,
    decoded: buffer.byteLength,
    encoding: response.headers.get('content-encoding')
  }
}

async function baseline() {
  const rows = {}
  for (const [path] of ENDPOINTS) {
    const response = await fetch(API + path)
    const body = await response.text()
    const sizes = await wireBytes(path)
    rows[path] = {
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      hash: hash(body),
      ...sizes
    }
  }
  return rows
}

async function probe(rows, label) {
  console.log(`\n### Conditional GET, ${label}\n`)
  console.log('| Endpoint | Status | Content | ETag |')
  console.log('| --- | --- | --- | --- |')
  for (const [path] of ENDPOINTS) {
    const before = rows[path]
    const headers = {}
    if (before.etag) headers['If-None-Match'] = before.etag
    if (before.lastModified) headers['If-Modified-Since'] = before.lastModified

    const response = await fetch(API + path, { headers })
    let content = '—'
    let etag = '—'
    if (response.status === 200) {
      content = hash(await response.text()) === before.hash ? 'identical' : 'changed'
      etag = response.headers.get('etag') === before.etag ? 'same' : 'new'
    }
    console.log(`| \`${path}\` | ${response.status} | ${content} | ${etag} |`)
  }
}

async function cadence() {
  const last = {}
  const changes = Object.fromEntries(ENDPOINTS.map(([p]) => [p, 0]))
  for (let i = 0; i < CADENCE_SAMPLES; i++) {
    for (const [path] of ENDPOINTS) {
      try {
        const h = hash(await (await fetch(API + path)).text())
        if (last[path] && last[path] !== h) changes[path]++
        last[path] = h
      } catch {
        // A transient failure must not abandon the run.
      }
    }
    if (i < CADENCE_SAMPLES - 1) await sleep(CADENCE_INTERVAL_MS)
  }
  console.log(`\n### Content changes over ${CADENCE_SAMPLES} minutes\n`)
  console.log('| Endpoint | Changes | Roughly |')
  console.log('| --- | --- | --- |')
  for (const [path] of ENDPOINTS) {
    const n = changes[path]
    const rate =
      n === 0 ? 'no change' : `every ${(CADENCE_SAMPLES / n).toFixed(1)} min`
    console.log(`| \`${path}\` | ${n} | ${rate} |`)
  }
}

const rows = await baseline()
console.log(`## Measured ${new Date().toISOString().slice(0, 10)}\n`)
console.log('| Endpoint | Product | Wire | Decoded | Encoding | ETag shape |')
console.log('| --- | --- | --- | --- | --- | --- |')
for (const [path, product] of ENDPOINTS) {
  const r = rows[path]
  const kb = (n) => (n === null ? '?' : `${(n / 1024).toFixed(1)} KB`)
  console.log(
    `| \`${path}\` | ${product} | ${kb(r.wire)} | ${kb(r.decoded)} | ${
      r.encoding ?? 'none'
    } | \`${r.etag ?? 'none'}\` |`
  )
}

await sleep(PROBE_GAP_MS)
await probe(rows, `${PROBE_GAP_MS / 1000}s later`)
await sleep(PROBE_GAP_MS)
await probe(rows, `${(PROBE_GAP_MS * 2) / 1000}s later`)

if (process.argv.includes('--cadence')) await cadence()
