/**
 * The core's settings: the typed `Settings`, and the normalisation of the raw
 * props a consumer saved into them. Everything in the core that reads a
 * setting imports this module. The form that edits them -- the Signal K
 * plugin's JSON schema -- is `schema.ts`, and nothing here depends on it.
 */
import { ALARM_NEVER, NoaaScaleValues } from './parse.js'

export interface Settings {
  sendAdvisoryOutlook: boolean
  stormAlertsEnabled: boolean
  auroraEnabled: boolean
  auroraInterval: number
  drapEnabled: boolean
  drapInterval: number
  goesFluxEnabled: boolean
  goesFluxInterval: number
  alarmLevel: number
  popupLevel: number
  listLevel: number
  updateInterval: number
}

/**
 * A NOAA scale value is one of five integers. Anything else falls back, which
 * matters more than it looks: the admin form renders an out-of-range saved
 * value as a blank select with no error and writes it back untouched, so this
 * is the only thing between a hand-edited config and a level nothing can reach.
 */
function scaleValue(raw: any, fallback: number): number {
  const parsed = Number(raw)
  // ALARM_NEVER is one past the scale on purpose; see src/parse.ts.
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= ALARM_NEVER
    ? parsed
    : fallback
}

function minutes(raw: any, fallback: number): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function settingsFrom(props: any): Settings {
  const p = props ?? {}
  const alarmLevel = scaleValue(
    // `zoneAlertThreshold` (and `minScaleAlert` before it) named the lowest
    // level worth the user's attention, and the loud states derived upward from
    // it. This anchors on the alarm and derives down instead, so a saved value
    // means a different thing and has to be moved: the old pivot put `alarm`
    // two levels up, which is exactly the offset applied here. An old default
    // of 3 therefore lands on 5 and behaves identically. Old values of 4 and 5
    // clamp to 5 -- they were the dead settings that could never sound at all,
    // and there is no honest way to preserve "silent" through a rename of the
    // thing that makes noise.
    p.alarmLevel ?? shiftUp(p.zoneAlertThreshold ?? p.minScaleAlert),
    NoaaScaleValues.EXTREME
  )
  // `observationsInterval` and `notificationsInterval` are the two settings
  // this replaced. Both are still read so a saved config keeps its cadence
  // instead of silently snapping back to 60, and the smaller wins, since that
  // is the rate the install was already polling at. Resolved once, up front,
  // because drapInterval's own fallback needs the *normalised* value below --
  // reading `p.updateInterval` raw there would skip this migration and land a
  // legacy observations/notifications-only config back on the 60-minute
  // default instead of the cadence it was actually polling at.
  const updateInterval = minutes(
    p.updateInterval ??
      smaller(p.observationsInterval, p.notificationsInterval),
    60
  )
  const popupLevel = popupBand(p.popupLevel, alarmLevel)
  return {
    sendAdvisoryOutlook: p.sendAdvisoryOutlook !== false,
    stormAlertsEnabled: p.stormAlertsEnabled !== false,
    auroraEnabled: p.auroraEnabled === true,
    auroraInterval: minutes(p.auroraInterval, 120),
    // On by default, unlike aurora: it is the same order of size as the poll
    // it rides along with, and a config saved before this setting existed was
    // already fetching it, so defaulting off would silently stop publishing a
    // path that install already had.
    drapEnabled: p.drapEnabled !== false,
    // A config saved before this split existed was fetching D-RAP on
    // `updateInterval`, so that's what a pre-existing install keeps -- the
    // resolved value, not the raw prop, so it also carries a legacy
    // observations/notifications-only config's cadence across. An explicit
    // but invalid `drapInterval` still falls back to 60 rather than borrowing
    // `updateInterval`: it names its own setting, wrong value and all.
    drapInterval:
      p.drapInterval === undefined
        ? updateInterval
        : minutes(p.drapInterval, 60),
    // Off by default, the way aurora is and D-RAP is not: fetching this at
    // all is opt-in. It is three quarters of what the poll used to cost, and
    // the person the switch exists for -- a boat on metered airtime who never
    // opens this screen -- is exactly the person a default of `true` would
    // charge. That has a cost of its own, and it is not hidden: an install
    // upgrading across this release stops publishing `xray_flux`, its trend
    // and `proton_flux` until the box is ticked. Deliberate, and stated in
    // the README rather than papered over with a migration.
    goesFluxEnabled: p.goesFluxEnabled === true,
    // Same migration as drapInterval: a config saved before this split was
    // fetching the two series on `updateInterval`, so that is the cadence it
    // keeps -- the resolved value, so a legacy observations/notifications
    // config carries across too. An explicit but invalid `goesFluxInterval`
    // falls back to 60 rather than borrowing `updateInterval`: it names its
    // own setting, wrong value and all.
    goesFluxInterval:
      p.goesFluxInterval === undefined
        ? updateInterval
        : minutes(p.goesFluxInterval, 60),
    alarmLevel,
    popupLevel,
    listLevel: listBand(p.listLevel, popupLevel),
    updateInterval
  }
}

/**
 * The popup threshold, which is never louder than the alarm. Above the alarm it
 * would name levels the alarm has already claimed, so it would be inert while
 * still reading as a choice, and it is pulled back down.
 *
 * `ALARM_NEVER` is exempt, because it is the one value above the alarm that is
 * not a mistake: the others are inert by accident, this one asks for no popup
 * band at all. Clamping it would relabel a deliberate "Never" as whatever the
 * alarm happened to be on the next load -- a control that does not read as what
 * was chosen, which is the bug the two thresholds exist to fix.
 *
 * Nor is it only the label. Below `listLevel` a clamped "Never" would also
 * start listing a level the user had asked nothing of.
 */
function popupBand(raw: any, alarmLevel: number): number {
  const level = scaleValue(
    raw,
    // One below the alarm is the band this had when there was only one
    // setting, so a config saved before the split keeps the ladder it already
    // had -- including a saved ALARM_NEVER, which used to slide G5 down into
    // the popup band and now says so outright.
    Math.max(NoaaScaleValues.MINOR, alarmLevel - 1)
  )
  return level === ALARM_NEVER ? level : Math.min(level, alarmLevel)
}

/**
 * The list threshold, which is never louder than the popup level. Above it,
 * it would name levels the popup band has already claimed, so it is pulled
 * back down -- same shape as `popupBand` clamping against the alarm.
 *
 * `ALARM_NEVER` is exempt for the same reason it is on `popupLevel`: it is
 * the one value above the popup level that is not a mistake, and clamping it
 * would relabel a deliberate "never list anything silently" as whatever the
 * popup level happened to be on the next load.
 */
function listBand(raw: any, popupLevel: number): number {
  const level = scaleValue(
    raw,
    // One below the popup is this setting's own default ladder, mirroring
    // popupBand's fallback -- a config saved before this threshold existed
    // (there is no old key to migrate) lands one below whatever popup was
    // already computed to.
    Math.max(NoaaScaleValues.MINOR, popupLevel - 1)
  )
  return level === ALARM_NEVER ? level : Math.min(level, popupLevel)
}

/** An old attention-threshold as the equivalent alarm level. */
function shiftUp(raw: any): any {
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 1
    ? Math.min(parsed + 2, NoaaScaleValues.EXTREME)
    : undefined
}

/** The lower of two possibly-absent minute values. */
function smaller(a: any, b: any): any {
  const values = [a, b].map(Number).filter((n) => Number.isFinite(n) && n > 0)
  return values.length > 0 ? Math.min(...values) : undefined
}
