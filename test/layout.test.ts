import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SLOTS,
  defaultLayout,
  layoutFromText,
  mergeLayout,
  placeRun,
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

  it('drops a lone tile at an index of the rest, keeping their order', () => {
    expect(order(placeRun(defaultLayout(), ['hf'], 0))).toEqual([
      'hf',
      'scales',
      'kp',
      'solar'
    ])
    expect(order(placeRun(defaultLayout(), ['scales'], 1))).toEqual([
      'kp',
      'scales',
      'solar',
      'hf'
    ])
  })

  it('moves a row as one run, so the pair is never split', () => {
    // The Solar + HF row, dragged to the top: both come, in their order.
    expect(order(placeRun(defaultLayout(), ['solar', 'hf'], 0))).toEqual([
      'solar',
      'hf',
      'scales',
      'kp'
    ])
    // Between the two full-width tiles.
    expect(order(placeRun(defaultLayout(), ['solar', 'hf'], 1))).toEqual([
      'scales',
      'solar',
      'hf',
      'kp'
    ])
    // A full-width tile dragged below the pair lands after it, not inside.
    expect(order(placeRun(defaultLayout(), ['kp'], 3))).toEqual([
      'scales',
      'solar',
      'hf',
      'kp'
    ])
  })

  it('swaps row-mates by naming the run in the other order', () => {
    expect(order(placeRun(defaultLayout(), ['hf', 'solar'], 2))).toEqual([
      'scales',
      'kp',
      'hf',
      'solar'
    ])
  })

  it('carries each tile whole, fold and all', () => {
    const folded = toggleSlot(defaultLayout(), 'hf')
    const moved = placeRun(folded, ['solar', 'hf'], 0)
    expect(moved.find((e) => e.slot === 'hf')?.collapsed).toBe(true)
  })

  it('clamps the index, and is unchanged when nothing moves', () => {
    const layout = defaultLayout()
    expect(order(placeRun(layout, ['scales'], 99))).toEqual([
      'kp',
      'solar',
      'hf',
      'scales'
    ])
    expect(order(placeRun(layout, ['hf'], -5))[0]).toBe('hf')
    expect(placeRun(layout, ['kp'], 1)).toBe(layout)
    expect(placeRun(layout, ['solar', 'hf'], 2)).toBe(layout)
    expect(placeRun(layout, ['hero'], 0)).toBe(layout)
    expect(placeRun(layout, [], 0)).toBe(layout)
  })

  it('never changes the list it was given', () => {
    const layout = defaultLayout()
    placeRun(layout, ['solar', 'hf'], 0)
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
    const layout = toggleSlot(
      placeRun(defaultLayout(), ['solar', 'hf'], 0),
      'kp'
    )
    expect(layoutFromText(JSON.stringify(layout))).toEqual(layout)
    expect(DEFAULT_SLOTS).toHaveLength(layout.length)
  })
})
