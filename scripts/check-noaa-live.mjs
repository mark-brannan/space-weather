#!/usr/bin/env node
/**
 * Checks the live service against docs/noaa-products.md, using the plugin's
 * own client to do the fetching.
 *
 *   npm run build && node scripts/check-noaa-live.mjs
 *
 * Run weekly by .github/workflows/noaa-drift.yml. Never part of `npm test`:
 * the plugin registry scores this package under `firejail --net=none`, and
 * `test/offline.test.ts` pins that property. `test/endpoints.test.ts`
 * is the offline half of this pair -- it catches an endpoint that was never
 * measured; this catches one whose measured cost has moved.
 *
 * Two things are checked, and one of them is not a number: every endpoint is
 * fetched through dist/noaa/client.js, so a run also exercises the conditional
 * headers, the timeout and the torn-payload recovery against real NOAA. What
 * the payload *means* is out of scope -- the parsers are pinned offline
 * against captured fixtures.
 *
 * Sizes are asserted as a band, not a value. NOAA's own content moves: the
 * 7-day flare list went 4.9 -> 3.2 KB (-35%) in three days with no code
 * change. The miss this exists to catch was 5 KB against a real 42 KB, an
 * eightfold error. So the band sits between those.
 *
 * Exit codes: 0 measured and in band, or could not measure; 1 drift.
 */
import { appendFileSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { ENDPOINTS, wireBytes } from './measure-noaa.mjs'

/** A single endpoint may move this far from the doc before it is drift. */
const ENDPOINT_BAND = 2.0
/**
 * The total is held tighter: it is the number the config panel promises the
 * user, and summing sixteen endpoints averages out the per-endpoint churn
 * that forces the band above wide.
 */
const TOTAL_BAND = 1.25

const doc = fileURLToPath(
  new URL('../docs/noaa-products.md', import.meta.url)
)
const clientModule = new URL('../dist/noaa/client.js', import.meta.url)

const KB = 1024
const SIZE = /^([\d.]+)\s*(B|KB|MB)$/
const UNITS = { B: 1, KB: KB, MB: KB * KB }

function bytesFrom(text) {
  const match = SIZE.exec(text.trim())
  return match ? Number(match[1]) * UNITS[match[2]] : null
}

const show = (bytes) =>
  bytes < KB ? `${Math.round(bytes)} B` : `${(bytes / KB).toFixed(1)} KB`

/** The documented figures: the payload-size table is the thing being checked. */
function documented() {
  const text = readFileSync(doc, 'utf8')
  const measured = text.match(/Measured (\d{4}-\d{2}-\d{2})/)
  const rows = {}
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim())
    // | `/path` | `product` | interval | wire | decoded |
    if (cells.length !== 7 || !cells[1].startsWith('`/')) continue
    const wire = bytesFrom(cells[4])
    if (wire === null) continue
    rows[cells[1].replace(/`/g, '')] = {
      interval: cells[3].replace(/`/g, ''),
      wire
    }
  }
  return { date: measured ? measured[1] : 'unknown', rows }
}

/** Enough of a Publisher for the client; nothing here reaches a Signal K app. */
function quietPublisher(log) {
  return {
    meta: () => {},
    values: () => {},
    value: () => {},
    selfPath: () => undefined,
    status: () => {},
    fail: (message) => log.push(message),
    error: (message) => log.push(message),
    debug: () => {},
    dataDirPath: () => '.'
  }
}

async function measure(client) {
  const results = []
  for (const [path, product] of ENDPOINTS) {
    let wire = null
    let status = null
    let failure = null

    // Two requests on purpose: `fetch` decompresses transparently, so the
    // bytes on the wire can only be counted off a raw socket, while the
    // client is what proves the plugin's own path still works.
    try {
      const raw = await wireBytes(path)
      wire = raw.wire
      status = raw.status
      if (status !== 200) failure = `HTTP ${status}`
    } catch (err) {
      failure = `request failed: ${err.message}`
    }

    if (!failure) {
      const isJson = path.endsWith('.json')
      try {
        const body = await (isJson
          ? client.json(path, product)
          : client.text(path, product))
        if (body === null || body === undefined || body === '') {
          failure = 'empty payload'
        }
      } catch (err) {
        failure = `client threw: ${err.message}`
      }
    }

    results.push({ path, product, wire, status, failure })
  }
  return results
}

function verdicts(results, expected) {
  let drift = false
  let unmeasured = 0
  const rows = []

  for (const result of results) {
    const doc = expected.rows[result.path]
    let change = '—'
    let verdict

    if (result.failure) {
      unmeasured++
      verdict = `could not measure (${result.failure})`
    } else if (!doc) {
      // The offline coverage test cannot see this one: the endpoint is in
      // ENDPOINTS but was never written into the doc.
      drift = true
      verdict = 'DRIFT: not in docs/noaa-products.md'
    } else {
      const ratio = result.wire / doc.wire
      change = `${ratio >= 1 ? '+' : ''}${((ratio - 1) * 100).toFixed(0)}%`
      const out = ratio > ENDPOINT_BAND || ratio < 1 / ENDPOINT_BAND
      if (out) drift = true
      verdict = out ? `DRIFT: outside ±${ENDPOINT_BAND}x` : 'in band'
    }

    rows.push({
      path: result.path,
      product: result.product,
      status: result.status ?? '—',
      wire: result.failure ? '—' : show(result.wire),
      documented: doc ? show(doc.wire) : '—',
      change,
      verdict
    })
  }

  return { rows, drift, unmeasured }
}

/** The per-poll figure the config panel quotes: the `updateInterval` rows. */
function pollTotal(results, expected) {
  const rows = results.filter(
    (result) => expected.rows[result.path]?.interval === 'updateInterval'
  )
  if (rows.length === 0) return null
  if (rows.some((result) => result.failure)) return { incomplete: true }

  const measured = rows.reduce((sum, result) => sum + result.wire, 0)
  const documented = rows.reduce(
    (sum, result) => sum + expected.rows[result.path].wire,
    0
  )
  const ratio = measured / documented
  return {
    measured,
    documented,
    ratio,
    drift: ratio > TOTAL_BAND || ratio < 1 / TOTAL_BAND
  }
}

function report(lines) {
  const text = lines.join('\n')
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
  }
}

function output(pairs) {
  if (!process.env.GITHUB_OUTPUT) return
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(pairs)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n'
  )
}

const { createClient } = await import(clientModule).catch(() => {
  console.error('dist/noaa/client.js is missing; run `npm run build` first.')
  process.exit(2)
})

const expected = documented()
const clientLog = []
const results = await measure(createClient(quietPublisher(clientLog)))
const { rows, drift: rowDrift, unmeasured } = verdicts(results, expected)
const total = pollTotal(results, expected)
const totalDrift = Boolean(total && !total.incomplete && total.drift)
const drift = rowDrift || totalDrift

const lines = [
  `## NOAA wire sizes, ${new Date().toISOString().slice(0, 10)}`,
  '',
  `Against \`docs/noaa-products.md\`, measured ${expected.date}. ` +
    `Endpoint band ±${ENDPOINT_BAND}x, per-poll total ±${TOTAL_BAND}x.`,
  '',
  '| Endpoint | Product | HTTP | Wire now | In docs | Change | Verdict |',
  '| --- | --- | --- | --- | --- | --- | --- |'
]
for (const row of rows) {
  lines.push(
    `| \`${row.path}\` | ${row.product} | ${row.status} | ${row.wire} | ` +
      `${row.documented} | ${row.change} | ${row.verdict} |`
  )
}
lines.push('')
if (!total || total.incomplete) {
  lines.push(
    '**Per-poll total: could not measure** — an `updateInterval` endpoint ' +
      'did not answer, so the sum would understate the cost.'
  )
} else {
  lines.push(
    `**One \`updateInterval\` poll: ${show(total.measured)}** against ` +
      `${show(total.documented)} in the doc ` +
      `(${total.ratio >= 1 ? '+' : ''}${((total.ratio - 1) * 100).toFixed(0)}%)` +
      `${total.drift ? ' — **DRIFT**' : '.'}`
  )
}
if (unmeasured > 0) {
  lines.push(
    '',
    `${unmeasured} of ${results.length} endpoints could not be measured. ` +
      'That is a NOAA outage or a network failure, not drift, and is never ' +
      'asserted on.'
  )
}
if (clientLog.length > 0) {
  lines.push('', '### What the client reported', '')
  for (const message of [...new Set(clientLog)]) lines.push(`- ${message}`)
}
if (drift) {
  lines.push(
    '',
    'Re-run `node scripts/measure-noaa.mjs`, update the payload-size table ' +
      'in `docs/noaa-products.md` and the `updateInterval` description in ' +
      '`src/config.ts`, then close this. See ' +
      'https://github.com/mark-brannan/signalk-noaa-space-weather/issues/112.'
  )
}

report(lines)
output({ drift: String(drift), unmeasured: String(unmeasured) })
process.exit(drift ? 1 : 0)
