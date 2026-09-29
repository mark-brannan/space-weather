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

/** The layout with `slot` moved `step` places (-1 up, +1 down); unchanged at
 *  either end, or when the slot is not in it. */
export function moveSlot(layout, slot, step) {
  const from = layout.findIndex((entry) => entry.slot === slot)
  const to = from + step
  if (from < 0 || to < 0 || to >= layout.length) return layout
  const next = layout.slice()
  ;[next[from], next[to]] = [next[to], next[from]]
  return next
}

/** The layout with `slot` folded or unfolded. */
export const toggleSlot = (layout, slot) =>
  layout.map((entry) =>
    entry.slot === slot ? { ...entry, collapsed: !entry.collapsed } : entry
  )
