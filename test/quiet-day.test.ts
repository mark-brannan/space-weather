import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsFrom } from '../src/settings'
import { NotificationStates } from '../src/parse'
import { ADVISORY_BASE } from '../src/paths'
import { PRODUCTS } from '../src/products/registry'
import { DEMO_POSITION, DEMO_PROPS } from '../src/browser/live'
import { harness } from './harness'
import { QUIET_DAY, fixture, matchZone } from './fixtures'

const QUIET = new Set<string>([
  NotificationStates.NOMINAL,
  NotificationStates.NORMAL
])

/**
 * Every product over one real quiet sky, at the moment it was captured, with
 * the demo's viewpoint so the per-vessel readings publish too. A sky with
 * nothing in it must raise nothing: neither a `notifications.*` value nor a
 * reading that lands in a zone louder than normal.
 */
async function runQuietDay() {
  const responses: Record<string, unknown> = {}
  for (const [subPath, file] of Object.entries(QUIET_DAY.responses)) {
    responses[subPath] = file.endsWith('.json')
      ? JSON.parse(fixture(file))
      : fixture(file)
  }
  const h = harness(responses, {})
  h.ctx.settings = settingsFrom(DEMO_PROPS)
  h.publisher.value('navigation.position', DEMO_POSITION, QUIET_DAY.now)

  vi.useFakeTimers({ now: new Date(QUIET_DAY.now), toFake: ['Date'] })
  for (const product of PRODUCTS) {
    if (product.metadata) h.publisher.meta(product.metadata(h.ctx.settings))
    await product.refresh(h.ctx)
  }
  return h
}

describe('a real quiet day, two days after a G2', () => {
  afterEach(() => vi.useRealTimers())

  it('runs every product without an error', async () => {
    const h = await runQuietDay()
    expect(h.errors).toEqual([])
  })

  // The weekly bulletin is raised, silently, whatever it forecasts: it is
  // news that a bulletin was issued, not a reading of the sky.
  it('raises no notification but the weekly advisory bulletin', async () => {
    const h = await runQuietDay()
    const raised = h.published
      .flatMap((p) => p.values)
      .filter((v) => v.path.startsWith('notifications.'))
      .filter((v) => v.path !== ADVISORY_BASE)
      .filter((v) => v.value !== null && !QUIET.has((v.value as any).state))
      .map((v) => `${v.path}: ${(v.value as any).state}`)
    expect(raised).toEqual([])
  })

  it('puts no reading in a zone louder than normal', async () => {
    const h = await runQuietDay()
    const zones = new Map<string, any[]>()
    for (const { path, value } of h.metas) {
      if ((value as any)?.zones) zones.set(path, (value as any).zones)
    }
    const loud: string[] = []
    let judged = 0
    for (const { path, value } of h.published.flatMap((p) => p.values)) {
      const ladder = zones.get(path)
      if (!ladder || typeof value !== 'number') continue
      judged++
      const zone = ladder[matchZone(ladder, value)]
      if (zone && !QUIET.has(zone.state))
        loud.push(`${path} = ${value}: ${zone.state}`)
    }
    expect(judged).toBeGreaterThan(0)
    expect(loud).toEqual([])
  })
})
