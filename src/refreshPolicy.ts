/**
 * What a manual "fetch now" is allowed to cost, wherever one is offered.
 *
 * Its own module because there are now two places that offer the button and
 * only one of them has a filesystem: the plugin's refresh routes (index.ts)
 * and the browser demo, which runs the same products against NOAA from a
 * public page (#239). A second copy of this number in the demo would be a
 * looser limit on the more exposed of the two.
 */

/**
 * Floor between fetches a manual "refresh now" is allowed to start. The aurora
 * interval defaults to two hours to bound what that ~900 KB payload costs, so
 * a button a user can mash has to bound it too, independent of the configured
 * interval.
 *
 * Measured against the last fetch rather than the last press, so a scheduled
 * fetch holds it down as well -- a press seconds after one would buy the same
 * grid twice. One number for both cases: it is the same NOAA traffic whether
 * or not a schedule is running, and a second, longer floor for the unscheduled
 * case would be a rule nobody could predict from the setting they changed.
 */
export const FORCE_REFRESH_COOLDOWN_MS = 60 * 1000
