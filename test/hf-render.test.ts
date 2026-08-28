import { describe, expect, it } from 'vitest'
import {
  F107_BANDS,
  MARINE_SSB_BAND_EDGES_HZ as WEBAPP_BAND_EDGES_HZ,
  drapCellColor,
  S1_PFU,
  bandStrip,
  f107Band,
  f107Gauge,
  f107Zones,
  hfGauge,
  HF_SCALE_MAX_MHZ,
  cosSolarZenith,
  estimateFoF2,
  estimateMufHz,
  FOF2_NIGHT_RATIO,
  FOF2_NOON_MHZ,
  MUF_M_FACTOR,
  hfCard,
  solarCard,
  trendWord
} from '../public/hf.js'
import { ENDPOINTS, leafMeta } from '../public/signalk.js'
import { LEGEND_MAX_MHZ } from '../public/drapMap.js'
import {
  MARINE_SSB_BAND_EDGES_HZ,
  zonesForF107,
  parseGoesFlux,
  xrayFluxTrend
} from '../src/parse.js'
import {
  A_INDEX_BASE,
  DRAP_BASE,
  F107_BASE,
  PROTON_FLUX_BASE,
  SUNSPOT_BASE,
  XRAY_FLUX_BASE
} from '../src/paths.js'
import { fixtureJson } from './fixtures.js'

const leaf = (value: unknown) => ({ value, timestamp: '2026-08-26T12:00:00Z' })

describe('the band-ladder ramp', () => {
  // No longer a copy of anything in src/tiles.ts: #170 moved both D-RAP maps
  // onto NOAA's own colorbar (public/drap-colors.js, pinned against the tile
  // renderer by drap-colors.test.ts), leaving this ramp to the HF tile's band
  // strip -- one stop per marine SSB band the cutoff has passed.
  it('draws nothing below the lowest marine band', () => {
    expect(drapCellColor(0)).toBeNull()
    expect(drapCellColor(1_000_000)).toBeNull()
    expect(drapCellColor(MARINE_SSB_BAND_EDGES_HZ[0])).not.toBeNull()
  })

  it('gets more opaque as more bands go under', () => {
    const alpha = (hz: number) =>
      Number(drapCellColor(hz)!.split(',')[3].replace(')', ''))
    expect(alpha(30_000_000)).toBeGreaterThan(alpha(5_000_000))
  })
})

describe('the band strip is the same list as the D-RAP zone ladder', () => {
  // A browser cannot import the TypeScript, so the list is copied. If the copy
  // drifts, the strip disagrees with the notification the same cutoff raises.
  it('copies MARINE_SSB_BAND_EDGES_HZ exactly', () => {
    expect(WEBAPP_BAND_EDGES_HZ).toEqual(MARINE_SSB_BAND_EDGES_HZ)
  })
})

describe('what the band strip claims', () => {
  // Issue #82: absorption bounds the window from below and nothing here
  // measures the ceiling, so `absorbed` is the only property a band carries.
  it('marks a band absorbed only when the cutoff has reached its lower edge', () => {
    const [twoMHz, fourMHz, sixMHz] = MARINE_SSB_BAND_EDGES_HZ
    const strip = bandStrip(fourMHz)
    expect(strip.find((b) => b.hz === twoMHz)?.absorbed).toBe(true)
    expect(strip.find((b) => b.hz === fourMHz)?.absorbed).toBe(true)
    expect(strip.find((b) => b.hz === sixMHz)?.absorbed).toBe(false)
  })

  it('says nothing at all about a band above the cutoff', () => {
    for (const band of bandStrip(8_100_000)) {
      expect(Object.keys(band).sort()).toEqual(['absorbed', 'hz', 'label'])
    }
  })

  it('absorbs nothing when there is no reading, and nothing at zero', () => {
    expect(bandStrip(null).some((b) => b.absorbed)).toBe(false)
    expect(bandStrip(0).some((b) => b.absorbed)).toBe(false)
  })

  it('absorbs every band once the cutoff passes the top edge', () => {
    const top = MARINE_SSB_BAND_EDGES_HZ[MARINE_SSB_BAND_EDGES_HZ.length - 1]
    expect(bandStrip(top).every((b) => b.absorbed)).toBe(true)
  })

  it('draws one cell per band, in ascending frequency', () => {
    const strip = bandStrip(null)
    expect(strip).toHaveLength(MARINE_SSB_BAND_EDGES_HZ.length)
    expect(strip.map((b) => b.hz)).toEqual(
      [...strip.map((b) => b.hz)].sort((a, b) => a - b)
    )
  })
})

describe('the solar flux bands', () => {
  // Convention, not derivation -- so the one thing worth pinning is that the
  // webapp and the published zone ladder put a reading in the same band.
  it('start where zonesForF107 changes message', () => {
    const zoneEdges = zonesForF107().map((zone) => zone.lower)
    expect(F107_BANDS.map((band) => band.from)).toEqual(zoneEdges)
  })

  it('is half-open at the bottom of each band, like the zone matcher', () => {
    expect(f107Band(69)?.key).toBe('closed')
    expect(f107Band(70)?.key).toBe('poor')
    expect(f107Band(89.9)?.key).toBe('poor')
    expect(f107Band(90)?.key).toBe('fair')
    expect(f107Band(120)?.key).toBe('good')
    expect(f107Band(150)?.key).toBe('excellent')
    expect(f107Band(400)?.key).toBe('excellent')
  })

  it('has no band for a missing reading', () => {
    expect(f107Band(null)).toBeNull()
  })
})

describe('the X-ray trend word', () => {
  // The threshold is a chosen number; what is asserted is that it is
  // symmetric in the ratio, so a rise and the fall undoing it are the same
  // size, and that the unchanged case is never called a direction.
  it('calls a flat ratio steady', () => {
    expect(trendWord(1)).toBe('steady')
  })

  it('is symmetric: a rise and its reciprocal are both named', () => {
    for (const factor of [1.2, 1.5, 3, 40]) {
      expect(trendWord(factor)).toBe('rising')
      expect(trendWord(1 / factor)).toBe('clearing')
    }
  })

  it('leaves a small move unnamed in both directions', () => {
    expect(trendWord(1.05)).toBe('steady')
    expect(trendWord(1 / 1.05)).toBe('steady')
  })

  it('has no word without a ratio', () => {
    expect(trendWord(null)).toBeNull()
  })
})

describe('the HF card, from the paths the plugin publishes', () => {
  const dotted = (endpoint: string) =>
    endpoint
      .slice(endpoint.indexOf('vessels/self/') + 'vessels/self/'.length)
      .replace(/\//g, '.')

  it('reads the paths the products publish on', () => {
    expect(dotted(ENDPOINTS.drap)).toBe(DRAP_BASE)
    expect(dotted(ENDPOINTS.f107)).toBe(F107_BASE)
    expect(dotted(ENDPOINTS.xrayFlux)).toBe(XRAY_FLUX_BASE)
    expect(dotted(ENDPOINTS.protonFlux)).toBe(PROTON_FLUX_BASE)
    expect(dotted(ENDPOINTS.aIndex)).toBe(A_INDEX_BASE)
    expect(dotted(ENDPOINTS.sunspotNumber)).toBe(SUNSPOT_BASE)
  })

  it('converts the published SI proton flux back to the pfu the S scale uses', () => {
    // S1 begins at 10 pfu; the plugin publishes m^-2.s^-1.sr^-1.
    const card = hfCard({ protonFlux: leaf(10 * 1e4) })
    expect(card.protonPfu).toBe(S1_PFU)
    expect(card.protonElevated).toBe(true)
    expect(hfCard({ protonFlux: leaf(9.9 * 1e4) }).protonElevated).toBe(false)
  })

  it('takes the cutoff from the D-RAP child leaf, not the parent node', () => {
    const card = hfCard({
      drap: {
        highest_affected_frequency: leaf(12_500_000),
        validTime: leaf('x')
      }
    })
    expect(card.cutoffHz).toBe(12_500_000)
    expect(card.bandsAbsorbed).toBe(5)
  })

  it('reads the trend off the child of the xray_flux leaf', () => {
    const card = hfCard({ xrayFlux: { ...leaf(4.2e-5), trend: leaf(2.4) } })
    expect(card.trendRatio).toBe(2.4)
    expect(card.trendWord).toBe('rising')
  })

  it('is all nulls with nothing published, and absorbs nothing', () => {
    const card = hfCard({})
    expect(card.cutoffHz).toBeNull()
    expect(card.sfu).toBeNull()
    expect(card.protonPfu).toBeNull()
    expect(card.trendRatio).toBeNull()
    expect(card.bandsAbsorbed).toBe(0)
  })
})

describe('the HF card against a captured NOAA payload', () => {
  // The published values, not hand-built ones: what the parser produces has to
  // land in the tile in the units the tile draws.
  const xrayJson = fixtureJson('xrays-6-hour.2026_08_20.json')
  const protonJson = fixtureJson('integral-protons-6-hour.2026_08_20.json')

  it('draws the flux the product would publish', () => {
    const flux = parseGoesFlux(xrayJson, protonJson)
    const trend = xrayFluxTrend(xrayJson)
    const card = hfCard({
      protonFlux: leaf(flux.protonFlux),
      xrayFlux: { ...leaf(flux.xrayFlux), trend: leaf(trend?.ratio ?? null) }
    })
    expect(card.protonPfu).toBeCloseTo(flux.protonFlux! / 1e4, 6)
    expect(card.trendWord).not.toBeNull()
    expect(['rising', 'steady', 'clearing']).toContain(card.trendWord)
  })
  // What `goesFluxEnabled: false` leaves behind. The two rows those paths feed
  // go to a dash, and everything the tile draws from D-RAP and F10.7 -- the
  // gauge, the band strip, the solar flux row -- is untouched, so the tile
  // degrades to two dashes rather than to its empty state. Absence reads as
  // null through `getJson`, so a path that is never published and a path whose
  // first fetch has not landed are the same case here.
  it('keeps every other row when the GOES flux paths are not published', () => {
    const withFlux = hfCard({
      drap: { highest_affected_frequency: leaf(9.9e6) },
      f107: leaf(142),
      protonFlux: leaf(1e5),
      xrayFlux: { ...leaf(1e-6), trend: leaf(1.4) }
    })
    const withoutFlux = hfCard({
      drap: { highest_affected_frequency: leaf(9.9e6) },
      f107: leaf(142)
    })
    expect(withoutFlux.protonPfu).toBeNull()
    expect(withoutFlux.trendRatio).toBeNull()
    expect(withoutFlux.trendWord).toBeNull()
    expect(withoutFlux.cutoffHz).toBe(withFlux.cutoffHz)
    expect(withoutFlux.sfu).toBe(withFlux.sfu)
    expect(withoutFlux.bands).toEqual(withFlux.bands)
    expect(withoutFlux.gauge).toEqual(withFlux.gauge)
  })
})

describe('the Solar Activity card', () => {
  // The one deviation from the #110 design comment, recorded so reversing it
  // is a one-line change: the Storm Scales card takes `max24h.class` because
  // it sits beside NOAA's own 24-hour maximum badge, and this tile takes the
  // latest flare because it is answering "what is the Sun doing now".
  it('takes the latest flare class, not the 24-hour peak', () => {
    const card = solarCard({
      xrayFlare: { class: leaf('C1.8'), max24h: { class: leaf('M6.9') } }
    })
    expect(card.flareClass).toBe('C1.8')
  })

  it('carries the two daily indices and the wind in SI', () => {
    const card = solarCard({
      solarWind: { speed: leaf(412_000), Bt: leaf(5e-9), Bz: leaf(-2e-9) },
      aIndex: leaf(6),
      sunspotNumber: leaf(112)
    })
    expect(card.speed).toBe(412_000)
    expect(card.bz).toBe(-2e-9)
    expect(card.aIndex).toBe(6)
    expect(card.sunspotNumber).toBe(112)
  })

  it('is all nulls with nothing published', () => {
    expect(Object.values(solarCard({})).every((v) => v === null)).toBe(true)
  })
})

describe('the HF gauge', () => {
  // The band chips became a linear frequency axis. What is pinned is that it
  // is the *same* axis the map legend and NOAA's colorbar use -- a reader
  // moving between the two surfaces must not have to re-learn the scale --
  // and that the ceiling is never claimed.
  it('is drawn against the same 0-35 MHz scale as the map legend', () => {
    expect(HF_SCALE_MAX_MHZ).toBe(35)
    expect(LEGEND_MAX_MHZ).toBe(HF_SCALE_MAX_MHZ)
  })

  it('places a cutoff at its true fraction of the axis, not at a band ordinal', () => {
    expect(hfGauge(17_500_000).absorbedFraction).toBeCloseTo(0.5, 6)
    expect(hfGauge(0).absorbedFraction).toBe(0)
  })

  it('clamps a cutoff past the top of the scale rather than overflowing it', () => {
    expect(hfGauge(60_000_000).absorbedFraction).toBe(1)
  })

  it('keeps the marine SSB edges as ticks, in the same list as the zone ladder', () => {
    const edges = hfGauge(null).bandEdges
    expect(edges.map((e) => e.hz)).toEqual(MARINE_SSB_BAND_EDGES_HZ)
    // At their real positions now: 2 MHz sits near the bottom of the axis,
    // where a chip put it a ninth of the way along.
    expect(edges[0].fraction).toBeCloseTo(2.045 / 35, 6)
  })

  it('never draws an open window without a measured ceiling', () => {
    const gauge = hfGauge(8_100_000)
    expect(gauge.ceilingUnmeasured).toBe(true)
    expect(gauge.openFrom).toBeNull()
    expect(gauge.openTo).toBeNull()
    // Everything above the cutoff is unknown, all the way to the top.
    expect(gauge.unknownFrom).toBeCloseTo(8.1 / 35, 6)
    expect(gauge.unknownTo).toBe(1)
  })

  it('opens the window between the two ends once a MUF exists', () => {
    const gauge = hfGauge(8_100_000, 24_000_000)
    expect(gauge.ceilingUnmeasured).toBe(false)
    expect(gauge.openFrom).toBeCloseTo(8.1 / 35, 6)
    expect(gauge.openTo).toBeCloseTo(24 / 35, 6)
    expect(gauge.unknownFrom).toBeNull()
  })

  it('paints above a known MUF as closed, not as unknown', () => {
    const gauge = hfGauge(8_100_000, 24_000_000)
    expect(gauge.aboveFrom).toBeCloseTo(24 / 35, 6)
    expect(gauge.aboveTo).toBe(1)
    expect(gauge.windowClosed).toBe(false)
  })

  it('has no open window when the cutoff has passed the MUF', () => {
    // Not an error: absorption climbing past the ceiling is the blackout
    // case, and both closed regions are still true.
    const gauge = hfGauge(23_000_000, 17_000_000)
    expect(gauge.windowClosed).toBe(true)
    expect(gauge.openTo).toBe(gauge.openFrom)
  })

  it('is unknown end to end with no reading at either end', () => {
    const gauge = hfGauge(null)
    expect(gauge.absorbedFraction).toBeNull()
    expect(gauge.unknownFrom).toBe(0)
    expect(gauge.unknownTo).toBe(1)
  })

  it('closes the unknown span at the MUF when the floor is unmeasured', () => {
    // D-RAP silent while F10.7/position still let hfCard derive a MUF: the
    // span below it must hatch, not vanish -- `to > from` in the renderer's
    // `seg()` draws nothing against a null `to`.
    const gauge = hfGauge(null, 24_000_000)
    expect(gauge.floorUnmeasured).toBe(true)
    expect(gauge.ceilingUnmeasured).toBe(false)
    expect(gauge.unknownFrom).toBe(0)
    expect(gauge.unknownTo).toBeCloseTo(24 / 35, 6)
    expect(gauge.openFrom).toBeNull()
  })
})

describe('the solar flux gauge', () => {
  const meta = { zones: zonesForF107() }

  it('takes its bands from the published meta.zones when the server sends them', () => {
    const bands = f107Zones(meta)
    expect(bands.map((b) => b.from)).toEqual(zonesForF107().map((z) => z.lower))
    // The zone message is a notification sentence; the gauge tick is not.
    expect(bands.map((b) => b.label)).toEqual([
      'High bands closed',
      'Poor',
      'Fair',
      'Good',
      'Excellent'
    ])
  })

  it('falls back to the webapp copy when there is no metadata', () => {
    expect(f107Zones(null).map((b) => b.from)).toEqual(
      F107_BANDS.map((b) => b.from)
    )
    expect(f107Zones({}).map((b) => b.key)).toEqual(
      F107_BANDS.map((b) => b.key)
    )
  })

  it('gives the top band a finite top so it can be drawn', () => {
    const top = f107Zones(meta).at(-1)!
    expect(top.to).toBe(250)
    expect(top.width).toBeGreaterThan(0)
  })

  it('keys each zone to the right band even if the server sends them out of order', () => {
    // Sorted by `from` before `key`/`label` are assigned by position, not
    // after -- assigning first would pair whichever zone arrived first with
    // the lowest band regardless of its actual threshold.
    const shuffled = { zones: [...zonesForF107()].reverse() }
    expect(f107Zones(shuffled).map((b) => b.label)).toEqual(
      f107Zones(meta).map((b) => b.label)
    )
  })

  it('puts the needle where the reading is, and names the same band', () => {
    const gauge = f107Gauge(125, meta)
    expect(gauge.fraction).toBeCloseTo(125 / 250, 6)
    expect(gauge.band?.key).toBe('good')
    expect(gauge.overflow).toBe(false)
  })

  it('clamps rather than drops a reading past the top of the scale', () => {
    const gauge = f107Gauge(400, meta)
    expect(gauge.fraction).toBe(1)
    expect(gauge.overflow).toBe(true)
    expect(gauge.band?.key).toBe('excellent')
  })

  it('has no needle and no band without a reading', () => {
    const gauge = f107Gauge(null, meta)
    expect(gauge.fraction).toBeNull()
    expect(gauge.band).toBeNull()
  })
})

describe('the HF card carries both gauges and the MUF stub', () => {
  it('reads meta off the f107 node, so the gauge follows the published ladder', () => {
    const node = { ...leaf(125), meta: { zones: zonesForF107() } }
    expect(leafMeta(node)).not.toBeNull()
    expect(hfCard({ f107: node }).sfuGauge.band?.label).toBe('Good')
  })

  it('has no MUF until something publishes one, and says so in the gauge', () => {
    const card = hfCard({
      drap: { highest_affected_frequency: leaf(8_100_000) }
    })
    expect(card.mufHz).toBeNull()
    expect(card.gauge.ceilingUnmeasured).toBe(true)
  })

  it('draws the ceiling the moment the path appears', () => {
    const card = hfCard({
      drap: { highest_affected_frequency: leaf(8_100_000) },
      muf: leaf(24_000_000)
    })
    expect(card.mufHz).toBe(24_000_000)
    expect(card.gauge.ceilingUnmeasured).toBe(false)
  })

  it('reads the MUF off the path the webapp asks for', () => {
    expect(ENDPOINTS.muf).toContain('environment/noaa/swpc/muf')
  })
})

describe('the derived MUF', () => {
  // A model, not a measurement, so what is pinned is the shape and the two
  // anchors it is built on -- not a number nobody can check.
  const seattle = { latitude: 47.6, longitude: -122.4 }

  it('puts the sun overhead at local noon on the equator at an equinox', () => {
    const cos = cosSolarZenith(0, 0, new Date('2026-03-20T12:00:00Z'))!
    expect(cos).toBeGreaterThan(0.99)
  })

  it('puts it under the horizon at local midnight', () => {
    expect(
      cosSolarZenith(0, 0, new Date('2026-03-20T00:00:00Z'))!
    ).toBeLessThan(-0.9)
  })

  it('hits its stated noon anchor: 10 MHz at F10.7 150, sun overhead', () => {
    const foF2 = estimateFoF2({
      sfu: 150,
      latitude: 0,
      longitude: 0,
      at: new Date('2026-03-20T12:00:00Z'),
      kp: 0
    })!
    expect(foF2).toBeCloseTo(FOF2_NOON_MHZ, 1)
  })

  it('falls to its stated night floor rather than to zero', () => {
    // The whole reason a bare cos term will not do: the F2 layer survives the
    // night, and the low bands open in the evening.
    const night = estimateFoF2({
      sfu: 150,
      latitude: 0,
      longitude: 0,
      at: new Date('2026-03-20T00:00:00Z'),
      kp: 0
    })!
    expect(night).toBeCloseTo(FOF2_NOON_MHZ * FOF2_NIGHT_RATIO, 1)
    expect(night).toBeGreaterThan(0)
  })

  it('rises with solar flux, at the quarter power', () => {
    const at = new Date('2026-03-20T12:00:00Z')
    const low = estimateFoF2({ sfu: 70, latitude: 0, longitude: 0, at, kp: 0 })!
    const high = estimateFoF2({
      sfu: 200,
      latitude: 0,
      longitude: 0,
      at,
      kp: 0
    })!
    expect(high).toBeGreaterThan(low)
    expect(high / low).toBeCloseTo((200 / 70) ** 0.25, 3)
  })

  it('is depressed by a storm, and more so at high latitude', () => {
    const at = new Date('2026-03-20T20:00:00Z')
    const quiet = estimateFoF2({ sfu: 120, ...seattle, at, kp: 0 })!
    const stormy = estimateFoF2({ sfu: 120, ...seattle, at, kp: 8 })!
    expect(stormy).toBeLessThan(quiet)
    const tropicalQuiet = estimateFoF2({
      sfu: 120,
      latitude: 5,
      longitude: -122.4,
      at,
      kp: 0
    })!
    const tropicalStormy = estimateFoF2({
      sfu: 120,
      latitude: 5,
      longitude: -122.4,
      at,
      kp: 8
    })!
    expect(tropicalStormy / tropicalQuiet).toBeGreaterThan(stormy / quiet)
  })

  it('never annihilates the layer, however bad the storm', () => {
    const at = new Date('2026-03-20T20:00:00Z')
    const quiet = estimateFoF2({
      sfu: 120,
      latitude: 80,
      longitude: 0,
      at,
      kp: 0
    })!
    const wrecked = estimateFoF2({
      sfu: 120,
      latitude: 80,
      longitude: 0,
      at,
      kp: 9
    })!
    expect(wrecked / quiet).toBeGreaterThanOrEqual(0.5)
  })

  it('is M x foF2, in the Hz the measured path would carry', () => {
    const inputs = {
      sfu: 150,
      latitude: 0,
      longitude: 0,
      at: new Date('2026-03-20T12:00:00Z'),
      kp: 0
    }
    expect(estimateMufHz(inputs)!).toBeCloseTo(
      estimateFoF2(inputs)! * MUF_M_FACTOR * 1e6,
      -3
    )
  })

  it('has no estimate without a flux or without a position', () => {
    const at = new Date('2026-03-20T12:00:00Z')
    expect(estimateMufHz({ sfu: null, ...seattle, at, kp: 0 })).toBeNull()
    expect(
      estimateMufHz({
        sfu: 120,
        latitude: undefined,
        longitude: undefined,
        at,
        kp: 0
      })
    ).toBeNull()
  })
})

describe('the HF card takes the measured MUF over the modelled one', () => {
  const at = new Date('2026-03-20T20:00:00Z')
  const data = {
    f107: leaf(120),
    position: leaf({ latitude: 47.6, longitude: -122.4 }),
    kp: { observed: leaf(2) }
  }

  it('estimates when nothing publishes a MUF, and says it estimated', () => {
    const card = hfCard(data, at)
    expect(card.mufHz).toBeGreaterThan(0)
    expect(card.mufEstimated).toBe(true)
    expect(card.gauge.ceilingUnmeasured).toBe(false)
  })

  it('drops the estimate the moment a real one is published', () => {
    const card = hfCard({ ...data, muf: leaf(21_000_000) }, at)
    expect(card.mufHz).toBe(21_000_000)
    expect(card.mufEstimated).toBe(false)
  })

  it('has no ceiling at all with no position to put the sun over', () => {
    const card = hfCard({ f107: leaf(120) }, at)
    expect(card.mufHz).toBeNull()
    expect(card.gauge.ceilingUnmeasured).toBe(true)
  })
})
