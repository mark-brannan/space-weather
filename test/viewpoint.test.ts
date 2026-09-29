import { describe, expect, it } from 'vitest'
import {
  canLocate,
  parseCoords,
  readChosen,
  resolveViewpoint,
  writeChosen
} from '../public/viewpoint.js'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    data,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value
    },
    removeItem: (key: string) => {
      delete data[key]
    }
  }
}

describe('parseCoords', () => {
  it.each([
    ['60.4, 5.3', { latitude: 60.4, longitude: 5.3 }],
    ['60.4 5.3', { latitude: 60.4, longitude: 5.3 }],
    ['-33.9,151.2', { latitude: -33.9, longitude: 151.2 }],
    ['33.9S 151.2E', { latitude: -33.9, longitude: 151.2 }],
    ['47.6 N, 122.3 W', { latitude: 47.6, longitude: -122.3 }],
    ['0°N 0°E', { latitude: 0, longitude: 0 }]
  ])('reads %s', (text, expected) => {
    expect(parseCoords(text)).toEqual(expected)
  })

  it.each([
    '',
    '60.4',
    '91, 0',
    '0, 181',
    '60.4E 5.3N',
    '-33.9S 151E',
    'Bergen',
    '1, 2, 3'
  ])('refuses %j rather than guess', (text) => {
    expect(parseCoords(text)).toBeNull()
  })
})

describe('resolveViewpoint', () => {
  const vessel = { latitude: 60.4, longitude: 5.3 }
  const chosen = { latitude: 47.6, longitude: -122.3, source: 'entered' }

  it('prefers what the reader chose over the vessel', () => {
    expect(resolveViewpoint(chosen, vessel)).toEqual({
      ...chosen,
      source: 'entered'
    })
    expect(
      resolveViewpoint({ ...chosen, source: 'device' }, vessel)?.source
    ).toBe('device')
  })

  it('falls back to the vessel, then to nothing', () => {
    expect(resolveViewpoint(null, vessel)).toEqual({
      ...vessel,
      source: 'vessel'
    })
    expect(resolveViewpoint(null, null)).toBeNull()
  })

  it('ignores a remembered choice that is not a place', () => {
    expect(
      resolveViewpoint({ latitude: 'x', longitude: 5 }, vessel)?.source
    ).toBe('vessel')
  })
})

describe('readChosen', () => {
  it('takes ?at= over what was remembered, and remembers it', () => {
    const storage = memoryStorage()
    writeChosen(storage, { latitude: 1, longitude: 2, source: 'entered' })
    expect(readChosen('?at=60.4,5.3', storage)).toEqual({
      latitude: 60.4,
      longitude: 5.3,
      source: 'entered'
    })
    expect(readChosen('', storage)?.latitude).toBe(60.4)
  })

  it('does not remember a device fix, and it replaces an older entry', () => {
    const storage = memoryStorage()
    writeChosen(storage, { latitude: 1, longitude: 2, source: 'entered' })
    writeChosen(storage, { latitude: 3, longitude: 4, source: 'device' })
    expect(readChosen('', storage)).toBeNull()
  })

  it('forgets on null', () => {
    const storage = memoryStorage()
    writeChosen(storage, { latitude: 1, longitude: 2, source: 'entered' })
    writeChosen(storage, null)
    expect(readChosen('', storage)).toBeNull()
  })

  it('survives storage that throws or holds junk', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {}
    }
    expect(readChosen('', throwing)).toBeNull()
    expect(readChosen('?at=1,2', throwing)?.latitude).toBe(1)
    expect(
      readChosen('', memoryStorage({ 'space-weather.viewpoint': '{' }))
    ).toBeNull()
    expect(readChosen('', null)).toBeNull()
  })
})

describe('canLocate', () => {
  it('offers location only in a secure context that has it', () => {
    const navigator = { geolocation: {} }
    expect(canLocate({ isSecureContext: true, navigator })).toBe(true)
    // A Signal K server on the LAN over plain http.
    expect(canLocate({ isSecureContext: false, navigator })).toBe(false)
    expect(canLocate({ isSecureContext: true, navigator: {} })).toBe(false)
  })
})
