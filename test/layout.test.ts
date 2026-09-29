import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SLOTS,
  defaultLayout,
  layoutFromText,
  mergeLayout,
  moveSlot,
  placeSlot,
  toggleSlot
} from '../public/layout.js'

/**
 * The saved layout is the one value on the dashboard that an older page, a
 * different build or a hand edit can leave in localStorage, so the merge is
 * the boundary and these pin what it does with each shape it can meet.
 */
describe('the dashboard layout, read back from storage', () => {
  it('is the default order, all expanded, when nothing was saved', () => {
    expect(layoutFromText(null)).toEqual(defaultLayout())
    expect(layoutFromText(undefined)).toEqual(defaultLayout())
  })

  it('is the default when the saved value is not JSON or not a list', () => {
    expect(layoutFromText('{oops')).toEqual(defaultLayout())
    expect(layoutFromText('{"slot":"kp"}')).toEqual(defaultLayout())
    expect(layoutFromText('42')).toEqual(defaultLayout())
  })

  it('keeps the saved order and fold for the slots the page has', () => {
    const saved = [
      { slot: 'hf', collapsed: true },
      { slot: 'scales', collapsed: false },
      { slot: 'kp', collapsed: true },
      { slot: 'solar', collapsed: false }
    ]
    expect(mergeLayout(saved)).toEqual(saved)
  })

  it('ignores a slot the page does not have', () => {
    const saved = [
      { slot: 'aurora', collapsed: true },
      { slot: 'kp', collapsed: false }
    ]
    expect(mergeLayout(saved).map((e) => e.slot)).toEqual([
      'kp',
      'scales',
      'solar',
      'hf'
    ])
  })

  it('appends a slot the saved list is missing, expanded, in default order', () => {
    const saved = [{ slot: 'hf', collapsed: true }]
    expect(mergeLayout(saved)).toEqual([
      { slot: 'hf', collapsed: true },
      { slot: 'scales', collapsed: false },
      { slot: 'kp', collapsed: false },
      { slot: 'solar', collapsed: false }
    ])
  })

  it('reads anything but a true `collapsed` as expanded', () => {
    const saved = [
      { slot: 'kp', collapsed: 'yes' },
      { slot: 'hf', collapsed: 1 },
      { slot: 'solar' }
    ]
    expect(mergeLayout(saved).every((e) => e.collapsed === false)).toBe(true)
  })

  it('keeps the first mention of a slot named twice, and skips junk entries', () => {
    const saved = [
      { slot: 'kp', collapsed: true },
      null,
      'kp',
      { slot: 'kp', collapsed: false },
      { collapsed: true }
    ]
    expect(mergeLayout(saved)).toEqual([
      { slot: 'kp', collapsed: true },
      { slot: 'scales', collapsed: false },
      { slot: 'solar', collapsed: false },
      { slot: 'hf', collapsed: false }
    ])
  })
})

describe('moving and folding a tile', () => {
  const order = (layout: { slot: string }[]) => layout.map((e) => e.slot)

  it('swaps with its neighbour in the direction asked', () => {
    expect(order(moveSlot(defaultLayout(), 'kp', -1))).toEqual([
      'kp',
      'scales',
      'solar',
      'hf'
    ])
    expect(order(moveSlot(defaultLayout(), 'kp', 1))).toEqual([
      'scales',
      'solar',
      'kp',
      'hf'
    ])
  })

  it('stays put at either end, and for a slot it does not have', () => {
    const layout = defaultLayout()
    expect(moveSlot(layout, 'scales', -1)).toBe(layout)
    expect(moveSlot(layout, 'hf', 1)).toBe(layout)
    expect(moveSlot(layout, 'hero', 1)).toBe(layout)
  })

  it('drops a slot at an index and keeps the rest in order', () => {
    expect(order(placeSlot(defaultLayout(), 'hf', 0))).toEqual([
      'hf',
      'scales',
      'kp',
      'solar'
    ])
    expect(order(placeSlot(defaultLayout(), 'scales', 2))).toEqual([
      'kp',
      'solar',
      'scales',
      'hf'
    ])
    expect(order(placeSlot(defaultLayout(), 'kp', 99))).toEqual([
      'scales',
      'solar',
      'hf',
      'kp'
    ])
    const layout = defaultLayout()
    expect(placeSlot(layout, 'kp', 1)).toBe(layout)
    expect(placeSlot(layout, 'hero', 0)).toBe(layout)
  })

  it('never changes the list it was given', () => {
    const layout = defaultLayout()
    moveSlot(layout, 'kp', -1)
    toggleSlot(layout, 'kp')
    expect(layout).toEqual(defaultLayout())
  })

  it('folds and unfolds one slot and leaves the rest alone', () => {
    const folded = toggleSlot(defaultLayout(), 'solar')
    expect(folded.find((e) => e.slot === 'solar')?.collapsed).toBe(true)
    expect(folded.filter((e) => e.collapsed)).toHaveLength(1)
    expect(toggleSlot(folded, 'solar')).toEqual(defaultLayout())
  })

  it('round-trips through the text it is saved as', () => {
    const layout = toggleSlot(moveSlot(defaultLayout(), 'hf', -1), 'kp')
    expect(layoutFromText(JSON.stringify(layout))).toEqual(layout)
    expect(DEFAULT_SLOTS).toHaveLength(layout.length)
  })
})
