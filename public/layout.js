// The dashboard's tile order and which tiles are folded, decided separately
// from the DOM that shows it -- the same split as hero.js and scales.js.
//
// A layout is a list of `{ slot, collapsed }` in display order. It lives in
// localStorage, so what comes back is whatever an older page, a hand edit or
// a different build left there: mergeLayout is the boundary that turns that
// into something the page can apply, and it is the only reader of the raw
// value. A slot the page no longer has is dropped; a slot the saved list has
// never heard of is appended, expanded, in the default order, so a tile added
// in a release is seen rather than silently missing. The hero is not a slot
// here: it is the verdict, and it stays where it is.

export const LAYOUT_KEY = 'noaa-space-weather.dashboard.layout'

/** Display order the page ships with: severity first, so a phone scrolling
 *  down leaves the least urgent for last. */
export const DEFAULT_SLOTS = ['scales', 'kp', 'solar', 'hf']

export const defaultLayout = (slots = DEFAULT_SLOTS) =>
  slots.map((slot) => ({ slot, collapsed: false }))

/**
 * A saved list, however malformed, against the slots the page has. Order is
 * the saved order for the slots it names; everything else follows in default
 * order, expanded. A slot named twice keeps its first mention.
 */
export function mergeLayout(saved, slots = DEFAULT_SLOTS) {
  const layout = []
  const seen = new Set()
  for (const entry of Array.isArray(saved) ? saved : []) {
    const slot = entry && typeof entry.slot === 'string' ? entry.slot : null
    if (!slot || !slots.includes(slot) || seen.has(slot)) continue
    seen.add(slot)
    layout.push({ slot, collapsed: entry.collapsed === true })
  }
  for (const slot of slots) {
    if (!seen.has(slot)) layout.push({ slot, collapsed: false })
  }
  return layout
}

/** The saved value as a layout, or the default when there is none or it is
 *  not JSON. */
export function layoutFromText(text, slots = DEFAULT_SLOTS) {
  if (typeof text !== 'string') return defaultLayout(slots)
  try {
    return mergeLayout(JSON.parse(text), slots)
  } catch {
    return defaultLayout(slots)
  }
}

/**
 * The layout with the tiles in `slots` lifted out and put back together, in
 * the order given, at `index` of what is left; everything else keeps its
 * order. This is how a whole row moves -- a tile and its row-mate travel as
 * one run, so a move never splits a pair -- and how row-mates swap, by
 * naming the same run in the other order at the same place. Unchanged when
 * the result is the same order, or when a slot is not in the layout.
 */
export function placeRun(layout, slots, index) {
  const run = slots.map((slot) => layout.find((entry) => entry.slot === slot))
  if (run.length === 0 || run.some((entry) => !entry)) return layout
  const rest = layout.filter((entry) => !slots.includes(entry.slot))
  const at = Math.max(0, Math.min(rest.length, index))
  const next = [...rest.slice(0, at), ...run, ...rest.slice(at)]
  return next.every((entry, i) => entry === layout[i]) ? layout : next
}

/** The layout with `slot` folded or unfolded. */
export const toggleSlot = (layout, slot) =>
  layout.map((entry) =>
    entry.slot === slot ? { ...entry, collapsed: !entry.collapsed } : entry
  )
