// What the plugin has actually fetched from NOAA, next to what its own
// declarations said it would -- surface 3 of docs/instrumentation-design.md's
// "Four surfaces, one source". Reads `GET .../telemetry` and computes nothing
// the plugin could have computed: the route serves the measured half and the
// predicted half keyed by the same `subPath`, and this joins them.
//
// The one thing decided here rather than there is where the line is. What
// counts as a divergence worth saying out loud is a presentation decision --
// a scraper reading the same route is free to draw its own -- and it is the
// decision this whole design exists for, so the argument is written out at
// THRESHOLDS below and in docs/design-decisions.md.
//
// Pure: takes the route body and a clock, returns a view and a string of
// markup. The same split as hero.js and scales.js, and for the same reason --
// it is what lets the thresholds be tested without a browser or a server.

const HOUR_MS = 60 * 60 * 1000

/**
 * THRESHOLDS. Two comparisons, two numbers, because they have different noise
 * floors and answer different questions.
 *
 * `SIZE_DIVERGENCE` (a row): the mean wire size of one endpoint's fetches
 * against the size `src/endpoints.ts` declares for it. Needs no time window --
 * it is valid from the first fetch -- and it is the comparison that would have
 * caught #223 fastest: 42 KB arriving where 5 KB was declared is visible
 * immediately. Set loose, at 50%, because a single endpoint carries real
 * variance: `xray-flares-7-day.json` is one record per flare and
 * `alerts.json` is a rolling 30-day archive, so both genuinely swell by a
 * factor over an active week. A tighter line would light up during exactly
 * the storm a reader opened this page for, and a panel that cries wolf during
 * storms is a panel nobody reads during storms.
 *
 * `TOTAL_DIVERGENCE` (the banner): every endpoint's measured bytes against
 * `predictedBytesPerDay`. Set tight, at 25%, because the total's noise floor
 * is far lower than any single row's -- the two weather-dependent endpoints
 * are a few KB against a prediction in the megabytes, so even at three times
 * their declared size they move the total by a fraction of a percent. What
 * does move the total is structural: an endpoint that grew a sibling, a
 * cadence that is not what the settings say, a payload that changed shape.
 * 25% is comfortably above the noise and catches a 1.3x drift long before it
 * becomes the 8x that #223 was. The design doc offered 25% as an explicit
 * placeholder; it survives as the number for the *total* on that argument,
 * not on having been the placeholder.
 *
 * `MIN_SIZE_SAMPLES`: a torn read is a short body, and one of them is not a
 * drift. Three fetches before a row's size is allowed to accuse anything.
 */
export const SIZE_DIVERGENCE = 0.5
export const TOTAL_DIVERGENCE = 0.25
export const MIN_SIZE_SAMPLES = 3

/**
 * The window tier 2 covers, and the gate on the banner.
 *
 * The meter starts empty at every plugin start and fills for a day. Judging a
 * day's traffic against a partly-filled window would mean an alarm after every
 * restart: the aurora grid alone is 147 KB arriving in lumps two hours apart,
 * so three hours in, the measured total sits somewhere between a twelfth and a
 * fifth of a day's prediction depending only on whether a lump has landed yet.
 * Pro-rating does not fix that -- it is the lumpiness, not the scale. So the
 * banner says nothing until the window has actually filled, and until then the
 * panel says how far along it is. The per-fetch size comparison above is live
 * throughout, which is what keeps the panel useful on day one.
 */
export const WINDOW_HOURS = 24

/** How many hours of the 24 the meter's buckets actually cover, as of `nowMs`. */
export function hoursCovered(hourly, nowMs) {
  let oldest = Infinity
  for (const buckets of Object.values(hourly || {})) {
    for (const bucket of buckets) {
      if (bucket.hourStart < oldest) oldest = bucket.hourStart
    }
  }
  if (!Number.isFinite(oldest)) return 0
  // Bucket starts are floored to the hour, so the span from the oldest start
  // to now counts the whole hours behind the current one; the partial hour
  // being filled right now is the +1. A full window therefore reads 24 and
  // never 25 -- tier 2 prunes to 24 buckets, so the oldest start is at most
  // 23 hours behind the newest.
  const spanHours = Math.floor((nowMs - oldest) / HOUR_MS) + 1
  return Math.max(0, Math.min(WINDOW_HOURS, spanHours))
}

/**
 * One endpoint's measured totals over the trailing 24 hours of `nowMs`.
 *
 * The window is applied here rather than trusted from the bucket list, for the
 * reason `meterTotals` in src/meter.ts gives: a list is pruned relative to that
 * endpoint's own newest fetch, so an endpoint that has stopped being fetched
 * can still be carrying buckets older than `now - 24h`. Counting those would
 * report yesterday's traffic as today's -- and would hide the very thing an
 * endpoint going quiet should show.
 */
function measuredFor(buckets, nowMs) {
  const oldest = Math.floor(nowMs / HOUR_MS) * HOUR_MS - (WINDOW_HOURS - 1) * HOUR_MS
  const total = {
    fetches: 0,
    wireBytes: 0,
    errors: 0,
    notModified: 0,
    estimated: 0
  }
  for (const bucket of buckets || []) {
    if (bucket.hourStart < oldest) continue
    total.fetches += bucket.fetches
    total.wireBytes += bucket.wireBytes
    total.errors += bucket.errors
    total.notModified += bucket.notModified
    total.estimated += bucket.estimated || 0
  }
  return total
}

/** True for an outcome that did not come back with a usable body. */
const failed = (outcome) => outcome !== 'ok' && outcome !== 'notModified'

/**
 * The endpoints that are failing *now*, as opposed to the ones that logged an
 * error at some point in the window: an endpoint whose most recent record in
 * the ring did not succeed. This is the only thing in the panel that is a
 * statement about the present rather than about the last 24 hours, which is
 * why it is drawn separately from the table.
 */
export function currentErrors(ring) {
  const latest = new Map()
  for (const record of ring || []) latest.set(record.subPath, record)
  return [...latest.values()]
    .filter((record) => failed(record.outcome))
    .sort((a, b) => b.startedAt - a.startedAt)
}

/** How far a ratio is from 1, or null when there is nothing to compare. */
const drift = (ratio) => (ratio === null ? null : Math.abs(ratio - 1))

/**
 * The whole view, from the route body and a clock. `null` telemetry -- the
 * plugin is stopped, or the reader is on a page with no plugin behind it --
 * comes back as `{ok: false}` rather than throwing, the same way every other
 * surface on this page reads a missing value.
 */
export function diagnosticsView(telemetry, nowMs) {
  if (!telemetry || !telemetry.predicted) {
    return { ok: false, rows: [], errors: [], recent: [] }
  }
  const hourly = telemetry.hourly || {}
  const covered = hoursCovered(hourly, nowMs)
  const windowComplete = covered >= WINDOW_HOURS

  // Every declared endpoint gets a row whether or not it has been fetched: a
  // product that should be polling and is not is exactly what an empty row
  // says, and a table that only lists what happened cannot show an absence.
  const rows = telemetry.predicted.endpoints.map((endpoint) =>
    rowFor(endpoint, measuredFor(hourly[endpoint.subPath], nowMs), windowComplete)
  )
  // An endpoint the meter saw and the declarations do not carry should be
  // impossible -- the client refuses an undeclared fetch and a test walks the
  // registry -- so if one ever appears it is the single most interesting line
  // on the page, not something to drop on the floor.
  const declared = new Set(rows.map((row) => row.subPath))
  for (const subPath of Object.keys(hourly)) {
    if (declared.has(subPath)) continue
    rows.push(rowFor({ subPath, productName: null }, measuredFor(hourly[subPath], nowMs), windowComplete))
  }

  const measuredBytes = rows.reduce((sum, row) => sum + row.measuredBytes, 0)
  const predictedBytes = telemetry.predicted.total
  const totalRatio = predictedBytes > 0 ? measuredBytes / predictedBytes : null
  // One estimated endpoint poisons the total, not just its own row: its
  // decoded bytes are in this sum. Suppressing the whole verdict is the only
  // honest reading -- a partial total against a full-day prediction would
  // understate, and an inflated one would over-report.
  const estimated = rows.some((row) => row.estimated)

  return {
    ok: true,
    startedAt: telemetry.startedAt || null,
    hoursCovered: covered,
    windowComplete,
    // Predicted first, so the order is a property of the settings and not of
    // the weather: a table that resorts itself under the reader every poll is
    // harder to read than one whose big rows simply stay at the top.
    rows: rows.sort(
      (a, b) =>
        b.predictedBytes - a.predictedBytes ||
        b.measuredBytes - a.measuredBytes ||
        a.subPath.localeCompare(b.subPath)
    ),
    measuredBytes,
    predictedBytes,
    totalRatio,
    estimated,
    verdict: verdictFor(totalRatio, windowComplete, covered, estimated),
    errors: currentErrors(telemetry.ring),
    // The last few fetches, newest first. The ring holds 200; this is the
    // "what has it been doing" glance, not the log.
    recent: (telemetry.ring || []).slice(-12).reverse()
  }
}

function rowFor(endpoint, measured, windowComplete) {
  const declaredBytes = endpoint.wireBytes ?? null
  const predictedBytes = endpoint.bytesPerDay ?? 0
  // A 304 costs a request and almost no body, and an error may carry none at
  // all -- so neither belongs in the denominator of "what does one of these
  // weigh". Without this, an endpoint that started erroring would read as one
  // that got smaller.
  const bodyFetches = Math.max(
    0,
    measured.fetches - measured.notModified - measured.errors
  )
  const perFetch = bodyFetches > 0 ? measured.wireBytes / bodyFetches : null
  // No `content-length` on the wire, so `wireBytes` is the decoded size --
  // roughly ten times what the fetch cost. Nothing on this row may be compared
  // against a declared, measured wire size while that is true: the answer
  // would be a tenfold over-fetch on a plugin doing exactly what it should.
  const estimated = measured.estimated > 0
  const sizeRatio =
    perFetch !== null && declaredBytes > 0 ? perFetch / declaredBytes : null
  const dayRatio =
    predictedBytes > 0 ? measured.wireBytes / predictedBytes : null
  return {
    subPath: endpoint.subPath,
    productName: endpoint.productName ?? null,
    measuredOn: endpoint.measuredOn ?? null,
    fetches: measured.fetches,
    errors: measured.errors,
    notModified: measured.notModified,
    bodyFetches,
    measuredBytes: measured.wireBytes,
    perFetch,
    declaredBytes,
    predictedFetches: endpoint.fetchesPerDay ?? 0,
    predictedBytes,
    sizeRatio,
    // Valid from the first fetches, with no window to wait for -- see
    // SIZE_DIVERGENCE.
    estimated,
    sizeDiverged:
      !estimated &&
      bodyFetches >= MIN_SIZE_SAMPLES &&
      drift(sizeRatio) > SIZE_DIVERGENCE,
    dayRatio,
    // A day's worth of bytes can only be judged against a day's worth of
    // window. `predictedBytes === 0` with traffic on the row is the exception:
    // that is a fetch the settings say should not be happening at all, which
    // needs no window to be wrong.
    // The zero-predicted case survives an estimated size: the finding there is
    // that a fetch happened at all, and how many bytes it weighed does not
    // come into it.
    dayDiverged: predictedBytes > 0
      ? !estimated && windowComplete && drift(dayRatio) > SIZE_DIVERGENCE
      : measured.fetches > 0,
    // Declared but never seen. Only says anything once a full window has gone
    // by without one, and only for an endpoint the settings expect to be
    // fetched.
    silent: windowComplete && predictedBytes > 0 && measured.fetches === 0
  }
}

/**
 * What the banner says. `over` is the config UI understating what the plugin
 * costs, which is #223's failure and the one this design was built to catch.
 * `under` is the opposite and usually means something is broken rather than
 * expensive -- fetches erroring, a product not scheduled, NOAA unreachable --
 * so it gets its own wording rather than being folded into "diverged".
 */
export function verdictFor(totalRatio, windowComplete, covered, estimated) {
  if (totalRatio === null) return { kind: 'nothing' }
  if (estimated) return { kind: 'estimated' }
  if (!windowComplete) return { kind: 'collecting', hours: covered }
  if (drift(totalRatio) <= TOTAL_DIVERGENCE) {
    return { kind: 'agrees', ratio: totalRatio }
  }
  return { kind: totalRatio > 1 ? 'over' : 'under', ratio: totalRatio }
}

// --- rendering -------------------------------------------------------------

// For anything that did not originate in this file. Every string below comes
// from the plugin's own declarations or from NOAA-derived error text on the
// ring, and the latter is not ours to trust with markup.
function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (ch) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[ch]
  )
}

/**
 * Bytes as this panel quotes them. Never a decoded size -- every figure that
 * reaches here is `content-length`, which with gzip is a tenth of the body and
 * the only one of the two that is a cost.
 */
export function formatBytes(bytes) {
  if (bytes === null || !Number.isFinite(bytes)) return '–'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 10 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${Math.round(bytes)} B`
}

/**
 * A ratio as a multiple, which is how a divergence reads to a person: "3.1x"
 * is a size of error, "210%" is arithmetic the reader has to do. Under 1 it
 * inverts, so the number is always the one bigger than one and the word beside
 * it carries the direction.
 */
export function formatRatio(ratio) {
  if (ratio === null || !Number.isFinite(ratio)) return '–'
  if (ratio === 0) return 'none'
  return ratio >= 1 ? `${ratio.toFixed(1)}×` : `1/${(1 / ratio).toFixed(1)}`
}

/** One short sentence per verdict, and the class the banner is painted with. */
export function verdictWording(view) {
  const { verdict } = view
  switch (verdict.kind) {
    case 'estimated':
      return {
        tone: 'collecting',
        headline: 'Transfer sizes are not being reported',
        detail:
          'This runtime does not expose a Content-Length for a compressed' +
          ' response, so the figures below are decoded sizes — roughly ten' +
          ' times what a fetch really costs. They cannot be compared against' +
          ' the declared wire sizes, so nothing here is being judged.'
      }
    case 'collecting':
      return {
        tone: 'collecting',
        headline: `Collecting — ${verdict.hours} of ${WINDOW_HOURS} hours`,
        detail:
          'A day of traffic can only be compared against a day of' +
          ' measurement, so the comparison below waits for the window to' +
          ' fill. The per-fetch sizes in the table are already good.'
      }
    case 'agrees':
      return {
        tone: 'agrees',
        headline: `Measured ${formatBytes(view.measuredBytes)}/day against ${formatBytes(view.predictedBytes)} predicted`,
        detail:
          'What this plugin is costing agrees with what its configuration' +
          ' screen promised, within a quarter.'
      }
    case 'over':
      return {
        tone: 'diverged',
        headline: `Fetching ${formatRatio(view.totalRatio)} what the settings predict`,
        detail:
          'The configuration screen is understating what this plugin costs.' +
          ' The endpoints marked below are where the difference is; a' +
          ' declared size that has gone stale is the usual cause.'
      }
    case 'under':
      return {
        tone: 'diverged',
        headline: `Fetching ${formatRatio(view.totalRatio)} what the settings predict`,
        detail:
          'Less traffic than predicted usually means something is not' +
          ' running rather than something is cheap — a product erroring, a' +
          ' schedule that never started, or NOAA unreachable.'
      }
    default:
      return {
        tone: 'collecting',
        headline: 'Nothing measured yet',
        detail: 'No fetch has been recorded since the plugin started.'
      }
  }
}

/**
 * The short form for the footstrip: the panel's headline finding in a few
 * words, so a page nobody opens the panel on still says when the numbers have
 * parted company. `null` when there is nothing worth interrupting for.
 */
export function footstripNote(view) {
  if (!view.ok) return null
  if (view.errors.length) {
    return {
      tone: 'diverged',
      text: `${view.errors.length} endpoint${view.errors.length === 1 ? '' : 's'} failing`
    }
  }
  if (view.estimated) return null
  if (view.verdict.kind === 'over' || view.verdict.kind === 'under') {
    return { tone: 'diverged', text: `${formatRatio(view.totalRatio)} predicted bandwidth` }
  }
  if (view.rows.some((row) => row.sizeDiverged || row.dayDiverged)) {
    return { tone: 'diverged', text: 'endpoint sizes have drifted' }
  }
  return null
}

const OUTCOME_WORDS = {
  ok: 'ok',
  notModified: 'not modified',
  httpError: 'HTTP error',
  timeout: 'timeout',
  networkError: 'network error',
  torn: 'torn read',
  parseError: 'parse error'
}

const clock = (ms) =>
  Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 19) + 'Z' : '–'

function rowMarkup(row) {
  const flags = []
  if (row.sizeDiverged) flags.push('size')
  if (row.dayDiverged) flags.push('rate')
  if (row.silent) flags.push('silent')
  const marked = flags.length ? ' diverged' : ''
  // Marks a decoded size standing in for a wire size, wherever one is quoted.
  // The same asterisk the fetch list below uses.
  const est = row.estimated ? '<span class="diag-est">*</span>' : ''
  // The declaration's own measurement date, and only on a row that has
  // diverged: "this was declared true on a day in August" is exactly what a
  // reader needs when the declaration is the thing under suspicion, and is
  // sixteen identical dates of noise when it is not.
  const measured =
    flags.length && row.measuredOn
      ? `<span class="diag-measured">declared ${escapeHtml(row.measuredOn)}</span>`
      : ''
  return `<tr class="diag-row${marked}">
    <td class="diag-path">
      <code>${escapeHtml(row.subPath)}</code>
      <span class="diag-product">${escapeHtml(row.productName || 'undeclared')}</span>
    </td>
    <td class="diag-num">${row.fetches}<span class="diag-sub">of ${round(row.predictedFetches)}</span></td>
    <td class="diag-num">${formatBytes(row.perFetch)}${est}<span class="diag-sub">vs ${formatBytes(row.declaredBytes)}</span></td>
    <td class="diag-num">${formatBytes(row.measuredBytes)}${est}<span class="diag-sub">vs ${formatBytes(row.predictedBytes)}</span></td>
    <td class="diag-num${row.errors ? ' diag-bad' : ''}">${row.errors || '–'}</td>
    <td class="diag-flags">${measured}${flags.length ? `<span class="diag-flag">${flags.join(' · ')}</span>` : ''}</td>
  </tr>`
}

const round = (n) => (Number.isFinite(n) ? Math.round(n) : '–')

/** The whole panel body. Returns markup; the page owns where it goes. */
export function diagnosticsMarkup(view) {
  if (!view.ok) {
    return `<div class="empty-state">No fetch telemetry from this server. The
      plugin publishes it while it is running; a page with no plugin behind it
      has none.</div>`
  }
  const wording = verdictWording(view)
  const errors = view.errors.length
    ? `<div class="diag-errors">
        <span class="label">Failing now</span>
        ${view.errors
          .map(
            (record) => `<div class="diag-error">
              <code>${escapeHtml(record.subPath)}</code>
              <span>${escapeHtml(OUTCOME_WORDS[record.outcome] || record.outcome)}${
                record.status ? ` · HTTP ${escapeHtml(record.status)}` : ''
              } · last tried ${clock(record.startedAt)}</span>
            </div>`
          )
          .join('')}
      </div>`
    : ''
  const recent = view.recent.length
    ? `<div class="diag-recent">
        <span class="label">Last ${view.recent.length} fetches</span>
        ${view.recent
          .map(
            (record) => `<div class="diag-fetch${failed(record.outcome) ? ' diag-bad' : ''}">
              <span class="diag-fetch-time">${clock(record.startedAt)}</span>
              <code>${escapeHtml(record.subPath)}</code>
              <span class="diag-fetch-meta">${escapeHtml(record.trigger)} · ${formatBytes(
                record.wireBytes
              )}${record.wireBytesEstimated ? '*' : ''} · ${round(record.durationMs)} ms · ${escapeHtml(
                OUTCOME_WORDS[record.outcome] || record.outcome
              )}</span>
            </div>`
          )
          .join('')}
      </div>`
    : ''

  return `<div class="diag-verdict ${wording.tone}">
      <div class="diag-headline">${escapeHtml(wording.headline)}</div>
      <div class="diag-detail">${escapeHtml(wording.detail)}</div>
    </div>
    ${errors}
    <div class="diag-table-wrap">
      <table class="diag-table">
        <thead><tr>
          <th>Endpoint</th><th>Fetches/day</th><th>Per fetch</th>
          <th>Bytes/day</th><th>Errors</th><th></th>
        </tr></thead>
        <tbody>${view.rows.map(rowMarkup).join('')}</tbody>
      </table>
    </div>
    ${recent}`
}
