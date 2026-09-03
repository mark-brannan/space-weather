#!/usr/bin/env node
/**
 * Re-measures the storm-day rates quoted by the alarmLevel dropdown.
 *
 *   node scripts/measure-kp.mjs
 *
 * Deliberately outside the test suite: it needs the network, and the plugin
 * registry scores this package with `npm test` under --net=none.
 *
 * Prints a markdown table. Paste it into docs/noaa-products.md; do not
 * paraphrase the numbers into a source comment. See CLAUDE.md.
 *
 * Rows are cumulative: a day counts at every level it reached, so a Kp 9 day is
 * in G1+ through G5+ alike. That is what the "and above" in each dropdown label
 * means, and it is why each row is >= the one below it.
 *
 * Band floors are NOAA's, and `kpFloorForG` in src/parse.ts is the same rule:
 * G_n opens a third below the Kp it is named after, so `G4 = Kp 8` starts at
 * 8- = 7.667. Keep the two in step, because the point of these rates is to
 * quote what the plugin will do.
 */

const SOURCE = 'https://kp.gfz.de/app/files/Kp_ap_Ap_SN_F107_since_1932.txt'

/** Columns 8-15 of each row are the eight three-hourly Kp values for the day. */
const KP_COLUMNS = [7, 15]

/** A day counts at level n if its worst Kp reached the bottom of that band. */
const bandFloor = (level) => level + 4 - 1 / 3

const quantile = (sorted, q) => sorted[Math.floor(sorted.length * q)]

async function main() {
  const res = await fetch(SOURCE)
  if (!res.ok) throw new Error(`${SOURCE} -> ${res.status}`)

  const years = new Map()
  for (const line of (await res.text()).split('\n')) {
    if (!line || line.startsWith('#')) continue
    const cells = line.trim().split(/\s+/)
    const kp = cells.slice(...KP_COLUMNS).map(Number).filter((n) => n >= 0)
    if (kp.length === 0) continue

    const year = Number(cells[0])
    if (!years.has(year)) years.set(year, { days: 0, atLevel: [0, 0, 0, 0, 0] })
    const bucket = years.get(year)
    bucket.days++

    const worst = Math.max(...kp)
    for (let level = 1; level <= 5; level++) {
      if (worst >= bandFloor(level)) bucket.atLevel[level - 1]++
    }
  }

  // Partial years would read as quiet ones.
  const complete = [...years.entries()]
    .filter(([, bucket]) => bucket.days >= 365)
    .map(([year, bucket]) => ({ year, ...bucket }))

  const first = complete[0].year
  const last = complete[complete.length - 1].year
  console.log(`# ${complete.length} complete years, ${first}-${last}\n`)
  console.log('| Level and above | Median year | p10 | p90 | Worst year |')
  console.log('| --- | --- | --- | --- | --- |')

  for (let level = 1; level <= 5; level++) {
    const counts = complete.map((y) => y.atLevel[level - 1]).sort((a, b) => a - b)
    console.log(
      `| G${level}+ | ${quantile(counts, 0.5)} | ${quantile(counts, 0.1)} |` +
        ` ${quantile(counts, 0.9)} | ${counts[counts.length - 1]} |`
    )
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
