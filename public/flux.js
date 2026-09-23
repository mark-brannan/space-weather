// Where an X-ray or proton flux reading sits on the ladder the Kp chart
// already draws, so the two can share one plot area without a second axis
// gutter -- issue #108.
//
// The three series are measured in units that have nothing to do with each
// other: Kp is a linear 0-9 index, X-ray flux is W/m^2 over four decades,
// proton flux is particles over five. What they do share is NOAA's own 0-5
// severity scale, which is defined on all three -- G on Kp, R on the X-ray
// channel, S on the proton channel. So each series keeps its own axis and the
// axes are pinned to each other at the levels: the row that says "G1 starts
// here" also says "R1 starts here" and "S1 starts here", and one dotted ladder
// reads for all three at once.
//
// The consequence, said plainly because it is the cost: between two levels the
// mapping is linear in log(flux), which is not the same curve a free log axis
// would draw. Nothing is read off the gaps -- the question a glance asks is
// which level a trace is above, and that is exactly what the pinning makes
// exact.
import { kpFloorForG } from './hero.js'

/**
 * NOAA's R thresholds as long-channel X-ray flux, W/m^2: R1 = M1, R2 = M5,
 * R3 = X1, R4 = X10, R5 = X20.
 */
export const R_THRESHOLDS = [1e-5, 5e-5, 1e-4, 1e-3, 2e-3]

/**
 * NOAA's S thresholds as >=10 MeV integral proton flux, in the SI units the
 * path publishes (m^-2.s^-1.sr^-1): 10 pfu through 10^5 pfu, times 10^4.
 */
export const S_THRESHOLDS = [1e5, 1e6, 1e7, 1e8, 1e9]

/**
 * Where each trace sits when nothing is happening -- the baseline of the plot,
 * not zero, which has no place on a log axis. A1 for the X-ray channel and
 * 0.1 pfu for the proton channel are both about a decade under a quiet day, so
 * a quiet trace rides just off the floor rather than pinned flat to it.
 */
export const XRAY_FLOOR = 1e-9
export const PROTON_FLOOR = 1e3

/** The top of the Kp axis, and so of the plot. */
const MAX_KP = 9

/**
 * A reading's position expressed as the Kp that draws at the same height, so
 * the caller reuses the chart's own `y()` and cannot end up with two
 * definitions of where the plot's top is.
 *
 * Returns null for a non-positive or missing reading: a log axis has no answer
 * for one, and a break in the line is the honest way to draw it.
 */
export function ladderScale(thresholds, floor) {
  const knots = [[Math.log10(floor), 0]]
  thresholds.forEach((value, i) => knots.push([Math.log10(value), kpFloorForG(i + 1)]))
  // One decade of headroom above the top threshold. NOAA's scale stops at 5
  // and the flux does not: an X28 has happened, and without this it would draw
  // at the same height as the X20 that opens R5.
  knots.push([knots[knots.length - 1][0] + 1, MAX_KP])

  return (value) => {
    if (!Number.isFinite(value) || value <= 0) return null
    const l = Math.log10(value)
    if (l <= knots[0][0]) return 0
    for (let i = 1; i < knots.length; i++) {
      const [l0, k0] = knots[i - 1]
      const [l1, k1] = knots[i]
      if (l <= l1) return k0 + ((l - l0) / (l1 - l0)) * (k1 - k0)
    }
    return MAX_KP
  }
}

export const xrayLadder = ladderScale(R_THRESHOLDS, XRAY_FLOOR)
export const protonLadder = ladderScale(S_THRESHOLDS, PROTON_FLOOR)

/**
 * The two overlay series out of the polled document, as `{time, kp}` already
 * on the Kp chart's scale -- so the drawing code has one kind of point to
 * draw and the units conversion happens once, here.
 *
 * Null rather than an empty array when a channel has published nothing: the
 * legend and the caveat under the chart only appear for a channel that has
 * something to say, and "no series yet" is the state a fresh install is in
 * for its first poll.
 */
export function fluxOverlay(data) {
  const series = (node, ladder) => {
    const points = node && typeof node === 'object' ? node.series?.value : null
    if (!Array.isArray(points) || points.length === 0) return null
    const mapped = points
      .map((point) => ({ time: Date.parse(point?.time), kp: ladder(point?.value) }))
      .filter((point) => Number.isFinite(point.time))
    return mapped.length > 0 ? mapped : null
  }
  return {
    xray: series(data?.xrayFlux, xrayLadder),
    proton: series(data?.protonFlux, protonLadder)
  }
}
