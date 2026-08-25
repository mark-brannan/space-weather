// Which of the two observed scale readings the page shows as conditions.
//
// NOAA's `noaa-scales.json` carries both: index "0" is an instantaneous
// sample and index "-1" is the rolling 24-hour observed maximum. NOAA's own
// front page and WWV's "past 24 hours" sentence both report the second one,
// and it is the only one that is ever non-zero in practice -- the
// instantaneous field reads 0 in every payload in `examples/`, including the
// day whose 24-hour maximum was G4. A badge wired to it shows R0 through an
// R2 and G0 through a G4, which is issue #120.
//
// Both surfaces that draw the G/S/R badges -- this webapp and the admin
// widget in remoteEntry.js -- resolve the path through here so they cannot
// drift apart again.
export const SCALES_OBSERVED =
  'environment/noaa/swpc/scales/observations/24_hours_maximums'

/**
 * The instantaneous reading. Still published, and the hero still asks it the
 * one question it can answer: whether a storm is running now or has passed,
 * which is the difference between "storm" and "all clear". Never the badge.
 */
export const SCALES_NOW = 'environment/noaa/swpc/scales/observations/latest'
