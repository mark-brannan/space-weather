// The band-conditions panel: per band group, day and night, Good / Fair /
// Poor -- the shape of N0NBH's hamqsl.com panel, which is the most-embedded
// ham widget there is, and NOT its formula. hamqsl's mapping is unpublished
// (https://www.hamqsl.com/FAQ.html describes inputs, not the mapping), so
// cloning its output would be cloning a black box. What follows is our own
// mapping, every step of it traceable to a published input, and the panel
// labels itself an estimate.
//
// The derivation, in full. A band is judged at its lower edge against the
// same two-edged window the HF gauge draws (docs/hf-operator-view.md in the
// plugin repo: absorption is the floor, the MUF is the ceiling):
//
//   Poor  the D-RAP absorption cutoff has reached the band (measured,
//         >=1 dB), or the band is above the MUF (nothing comes back down).
//   Fair  under the MUF but above FOT_RATIO x MUF -- the top of the window,
//         where the ceiling's day-to-day scatter decides whether it opens.
//   Good  above the floor and at or under FOT_RATIO x MUF.
//
// The ceiling is `estimateMufHz` from hf.js -- the same model, the same
// anchors, the same Kp storm term the gauge's MUF mark is drawn from -- taken
// at the vessel's local solar noon for the Day column and local midnight for
// the Night one. The floor is D-RAP at the vessel, which is a *now* reading,
// so it is applied only to the column the vessel is in now; the other column
// is ceiling-only and the panel says so. A measured MUF, the day one is
// published, likewise replaces the estimate in the current column only.
//
// X-ray flares and polar-cap absorption both reach the verdicts through the
// D-RAP floor, which models both; Kp reaches them through the ceiling's storm
// term. Protons get one more line of their own: at S1 and up NOAA's own S
// scale says HF is degraded through the polar regions, which is a claim about
// *paths* crossing the caps, not about the vessel's own sky, so it is a note
// under the table rather than a change to any cell.
import {
  MARINE_SSB_BAND_EDGES_HZ,
  S1_PFU,
  cosSolarZenith,
  estimateMufHz,
  toPfu
} from './hf.js'
import { leafTime, leafValue } from './signalk.js'

/**
 * The frequency of optimum traffic as a fraction of the MUF. Convention, not
 * ours and not derived here: the long-standing propagation rule of thumb
 * (FOT / OWF ~= 0.85 MUF) for the frequency that holds up on most days of the
 * month, where the MUF itself holds on about half of them.
 */
export const FOT_RATIO = 0.85

/**
 * hamqsl's four groups, judged at each band's lower edge (Hz). The lower edges
 * are the same in all three ITU regions for these bands. A group reads as its
 * best band: the question the row answers is "is this pair worth trying", and
 * an operator facing a dead 80 m and an open 40 m will be on 40.
 */
export const HAM_BAND_GROUPS = [
  {
    label: '80–40 m',
    bands: [
      ['80 m', 3_500_000],
      ['40 m', 7_000_000]
    ]
  },
  {
    label: '30–20 m',
    bands: [
      ['30 m', 10_100_000],
      ['20 m', 14_000_000]
    ]
  },
  {
    label: '17–15 m',
    bands: [
      ['17 m', 18_068_000],
      ['15 m', 21_000_000]
    ]
  },
  {
    label: '12–10 m',
    bands: [
      ['12 m', 24_890_000],
      ['10 m', 28_000_000]
    ]
  }
]

/**
 * The marine SSB bands a boat actually works -- 4/6/8/12/16/22 MHz -- looked
 * up in `MARINE_SSB_BAND_EDGES_HZ` rather than copied, so these rows are
 * judged at exactly the edges the gauge ticks and the D-RAP zone ladder use.
 */
const MARINE_ROW_MHZ = [4, 6, 8, 12, 16, 22]
export const MARINE_BANDS = MARINE_ROW_MHZ.map((mhz) => {
  const hz = MARINE_SSB_BAND_EDGES_HZ.find(
    (edge) => Math.floor(edge / 1e6) === mhz
  )
  return { label: `${mhz} MHz`, bands: [[`${mhz} MHz`, hz]] }
})

const RANK = { poor: 0, fair: 1, good: 2 }
export const VERDICT_LABEL = { good: 'Good', fair: 'Fair', poor: 'Poor' }

/**
 * One band against one window. Null where no claim can be made: with no
 * ceiling there is nothing to judge "usable" against, and saying "Good" on
 * the floor alone is the unbacked claim the gauge refuses to make.
 */
export function bandVerdict(hz, { floorHz, ceilingHz }) {
  if (!Number.isFinite(hz) || !Number.isFinite(ceilingHz)) return null
  if (Number.isFinite(floorHz) && floorHz >= hz)
    return { verdict: 'poor', reason: 'absorbed' }
  if (hz > ceilingHz) return { verdict: 'poor', reason: 'above-muf' }
  if (hz > FOT_RATIO * ceilingHz) return { verdict: 'fair', reason: 'near-muf' }
  return { verdict: 'good', reason: 'window' }
}

/** A group reads as its best band; null only when no band could be judged. */
export function groupVerdict(group, window) {
  let best = null
  for (const [name, hz] of group.bands) {
    const judged = bandVerdict(hz, window)
    if (judged && (!best || RANK[judged.verdict] > RANK[best.verdict]))
      best = { ...judged, band: name }
  }
  return best
}

/**
 * The instants the two columns are taken at: local solar noon and local
 * midnight at the vessel's longitude, on the UTC day of `at`. Only the hour
 * angle matters to the zenith term; the declination moves by a fraction of a
 * degree across the day and is far inside the estimate's own error.
 */
export function noonAndMidnight(longitude, at) {
  const time = at instanceof Date ? at : new Date(at)
  const dayStart = Date.UTC(
    time.getUTCFullYear(),
    time.getUTCMonth(),
    time.getUTCDate()
  )
  const noon = dayStart + (12 - longitude / 15) * 3_600_000
  return { noon: new Date(noon), midnight: new Date(noon + 12 * 3_600_000) }
}

const numberOrNull = (node) => {
  const value = leafValue(node)
  return Number.isFinite(value) ? value : null
}

/**
 * The whole panel, from the same Signal K tree `hfCard` reads. Pure: `at` is
 * a parameter so a fixture decides which column is "now".
 */
export function bandConditions(data, at = new Date()) {
  const sfu = numberOrNull(data?.f107)
  const kp = numberOrNull(data?.kp?.observed)
  const cutoffHz = numberOrNull(data?.drap?.highest_affected_frequency)
  const measuredMufHz = numberOrNull(data?.muf)
  const protonPfu = toPfu(numberOrNull(data?.protonFlux))
  const position = leafValue(data?.position)
  const latitude = position?.latitude
  const longitude = position?.longitude
  const hasPosition = Number.isFinite(latitude) && Number.isFinite(longitude)
  const now = at instanceof Date ? at : new Date(at)

  const estimateAt = (when) =>
    hasPosition
      ? estimateMufHz({ sfu, latitude, longitude, at: when, kp })
      : null

  let columns = []
  if (hasPosition) {
    const { noon, midnight } = noonAndMidnight(longitude, now)
    // Day or night at the vessel now: which column the measured floor reads.
    const isDay = cosSolarZenith(latitude, longitude, now) > 0
    columns = [
      { key: 'day', label: 'Day', at: noon, current: isDay },
      { key: 'night', label: 'Night', at: midnight, current: !isDay }
    ].map((column) => {
      const measured = column.current && measuredMufHz !== null
      const ceilingHz = measured ? measuredMufHz : estimateAt(column.at)
      return {
        ...column,
        ceilingHz,
        ceilingEstimated: !measured && ceilingHz !== null,
        floorHz: column.current ? cutoffHz : null,
        floorMeasured: column.current && cutoffHz !== null
      }
    })
  }

  const rows = (groups) =>
    groups.map((group) => ({
      label: group.label,
      cells: columns.map((column) => groupVerdict(group, column))
    }))

  // The oldest input the estimate rests on, so the panel can say it is
  // reading from a cache rather than letting a stale F10.7 pass as today's.
  const times = [
    leafTime(data?.f107),
    leafTime(data?.kp?.observed),
    leafTime(data?.drap?.highest_affected_frequency)
  ].filter(Boolean)
  const oldestInputAt = times.length
    ? times.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b))
    : null

  const judged = columns.some((column) => column.ceilingHz !== null)
  return {
    available: judged,
    missing: judged
      ? []
      : [
          ...(sfu === null ? ['solar flux'] : []),
          ...(hasPosition ? [] : ['a position fix'])
        ],
    columns,
    ham: rows(HAM_BAND_GROUPS),
    marine: rows(MARINE_BANDS),
    polarPathsDegraded: protonPfu !== null && protonPfu >= S1_PFU,
    oldestInputAt
  }
}

const REASON = {
  absorbed: 'absorbed by D-RAP (measured)',
  'above-muf': 'above the MUF',
  'near-muf': `within ${Math.round((1 - FOT_RATIO) * 100)}% under the MUF`,
  window: 'inside the window'
}

const mhz = (hz) => (hz / 1e6).toFixed(1)

function cellMarkup(cell, column) {
  if (!cell) return '<td class="bc-none">&mdash;</td>'
  const title =
    `${cell.band}: ${REASON[cell.reason]}; ` +
    `MUF ${mhz(column.ceilingHz)} MHz${column.ceilingEstimated ? ' est' : ''}` +
    (column.floorMeasured
      ? `, absorbed below ${mhz(column.floorHz)} MHz`
      : ', floor not measured')
  return `<td class="bc-${cell.verdict}" title="${title}">${VERDICT_LABEL[cell.verdict]}</td>`
}

function tableMarkup(caption, rows, columns) {
  const head = columns
    .map(
      (c) =>
        `<th scope="col"${c.current ? ' class="bc-now"' : ''}>${c.label}${c.current ? ' <span class="bc-now-tag">now</span>' : ''}</th>`
    )
    .join('')
  const body = rows
    .map(
      (r) =>
        `<tr><th scope="row">${r.label}</th>${r.cells.map((cell, i) => cellMarkup(cell, columns[i])).join('')}</tr>`
    )
    .join('')
  return `<table class="bc-table"><caption>${caption}</caption><thead><tr><td></td>${head}</tr></thead><tbody>${body}</tbody></table>`
}

/**
 * The panel as markup. `asOf` is the page's own formatting of
 * `oldestInputAt` and whether it is stale, so this module needs no clock
 * policy of its own.
 */
export function bandPanelMarkup(conditions, asOf = null) {
  const info =
    '<span class="info" tabindex="0">i<span class="bubble">Our own mapping, not ' +
    'hamqsl&rsquo;s (theirs is unpublished). Each band is judged at its lower edge. ' +
    '<b>Poor</b>: under the D-RAP absorption cutoff, or above the MUF. ' +
    `<b>Fair</b>: in the top ${Math.round((1 - FOT_RATIO) * 100)}% under the MUF. ` +
    `<b>Good</b>: below that (the conventional optimum working frequency, ${FOT_RATIO}&times;MUF) ` +
    'and above the cutoff. The MUF is the same estimate the gauge marks &mdash; F10.7, ' +
    'position, time of day and Kp &mdash; at local noon and midnight. D-RAP is a reading for ' +
    'now, so it only applies to the column marked now. A group shows its best band.</span></span>'
  const head = `<div class="bc-head"><span class="bc-title">Band conditions</span><span class="bc-est">estimate</span>${info}</div>`
  if (!conditions.available) {
    return `<div class="bc">${head}<div class="bc-empty">Needs ${conditions.missing.join(' and ') || 'solar flux and a position fix'}.</div></div>`
  }
  const { columns } = conditions
  const other = columns.find((c) => !c.current)
  const notes = [
    other
      ? `${other.label}: ceiling only &mdash; D-RAP is read for the half you are in now.`
      : '',
    conditions.polarPathsDegraded
      ? '<span class="bc-warn">Proton event (S1+): paths crossing the polar caps are degraded whatever the rows say.</span>'
      : '',
    asOf
      ? `<span${asOf.stale ? ' class="stale"' : ''}>Oldest input ${asOf.text}${asOf.stale ? ' (stale)' : ''}.</span>`
      : ''
  ].filter(Boolean)
  return `<div class="bc">${head}
    <div class="bc-tables">${tableMarkup('Amateur', conditions.ham, columns)}${tableMarkup('Marine SSB', conditions.marine, columns)}</div>
    <div class="bc-notes">${notes.map((n) => `<div>${n}</div>`).join('')}</div>
  </div>`
}
