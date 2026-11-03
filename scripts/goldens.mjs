#!/usr/bin/env node
// Screenshot goldens: the page off the mock rig and the shipping site on its
// saved capture, clocks pinned, compared pixel for pixel against
// screenshots/goldens/. Modelled on searoom's.
//
//   node scripts/goldens.mjs update [--rig URL] [--site URL]  rewrite screenshots/goldens/
//   node scripts/goldens.mjs check  [--rig URL] [--site URL]  compare; exit 1 if any shot
//                                                             differs by more than 0.1% of pixels
//
// Two rigs. The mock (`--mock --now NOW`) fabricates its states, so a G4
// storm is a picture anyone can take; the site (`--noaa`, the output of
// scripts/build-site.mjs) is shot on ?snapshot, the one source with real
// grids under the map, which the mock cannot fabricate. Without a URL the
// script starts a rig itself on a free port. With one (CI starts them) the
// mock rig must have been started with `--now NOW`, or every timer differs.
// The page's clock is pinned to match: NOW on the mock, the capture's moment
// on the site. `check` writes the actual renders and a red-mask diff-*.png
// for each miss to goldens-out/ (CI uploads it). Comparison runs in the
// browser on a canvas, so no image dependency is added.
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

const { values: opts, positionals } = parseArgs({
  options: { rig: { type: 'string' }, site: { type: 'string' } },
  allowPositionals: true
})
const mode = positionals[0] ?? 'check'
if ((mode !== 'check' && mode !== 'update') || positionals.length > 1) {
  console.error('usage: goldens.mjs check|update [--rig URL] [--site URL]')
  process.exit(1)
}
const goldenDir = 'screenshots/goldens'
const outDir = 'goldens-out'
const NOW = '2026-03-20T12:00:00Z'
const MAX_DIFF_FRACTION = 0.001 // 0.1% of pixels
const CHANNEL_TOLERANCE = 16 // per-channel delta below this is anti-aliasing noise
const MAX_HEIGHT = 3000 // px; a long phone page stays a reviewable PNG

// ?snapshot runs the page on the capture's clock, so that is the instant to
// pin it at: the countdown, the greyline and every "updated" stamp are then
// the capture's own on every run.
const { capturedAt } = JSON.parse(readFileSync('site/snapshot.json', 'utf8'))

// Off the mock: a quiet and a stormy dashboard, the other three views on the
// storm, and the empty page; dark at both widths, light on the two dashboards
// only -- the light theme is the same layout with other tokens, so one width
// shows it.
const mockShots = [
  ['quiet', 'dashboard', ['dark', 'light']],
  ['storm', 'dashboard', ['dark', 'light']],
  ['storm', 'advisories', ['dark']],
  ['storm', 'map', ['dark']],
  ['storm', 'diagnostics', ['dark']],
  ['nodata', 'dashboard', ['dark']]
]
// Off the site on its saved capture: the map with real grids under it, and
// the day the other two views show. README.md's pictures are files from here.
const siteShots = [
  ['snapshot', 'map', ['dark']],
  ['snapshot', 'dashboard', ['dark']],
  ['snapshot', 'advisories', ['dark']]
]
const widths = [
  [1280, 900],
  [360, 740]
]

const rigs = []
// A free port rather than a fixed one, like shots.mjs: two worktrees shooting
// at once would otherwise screenshot each other's rig. The site rig assembles
// site-dist/ before it listens, which is most of the wait.
async function startRig(args) {
  const port = await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
  const base = `http://127.0.0.1:${port}`
  rigs.push(
    spawn(
      'node',
      ['scripts/mock-webapp.mjs', String(port), '--host', '127.0.0.1', ...args],
      { stdio: ['ignore', 'ignore', 'inherit'] }
    )
  )
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(base)).ok) return base
    } catch {
      await sleep(100)
    }
  }
  throw new Error(`rig did not answer at ${base} (${args.join(' ')})`)
}

// Returns { fraction, diffPng (base64) } for two PNG buffers.
async function compare(cmp, goldenPng, actualPng) {
  return cmp.evaluate(
    async ([g, a, tol]) => {
      const load = (b64) =>
        new Promise((res, rej) => {
          const im = new Image()
          im.onload = () => res(im)
          im.onerror = rej
          im.src = 'data:image/png;base64,' + b64
        })
      const [gi, ai] = await Promise.all([load(g), load(a)])
      const w = Math.max(gi.width, ai.width)
      const h = Math.max(gi.height, ai.height)
      const px = (im) => {
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        const x = c.getContext('2d', { willReadFrequently: true })
        x.drawImage(im, 0, 0)
        return x.getImageData(0, 0, w, h)
      }
      const gd = px(gi)
      const ad = px(ai)
      const out = new ImageData(w, h)
      const sizeMiss = gi.width !== ai.width || gi.height !== ai.height
      let bad = 0
      for (let i = 0; i < gd.data.length; i += 4) {
        const d = Math.max(
          Math.abs(gd.data[i] - ad.data[i]),
          Math.abs(gd.data[i + 1] - ad.data[i + 1]),
          Math.abs(gd.data[i + 2] - ad.data[i + 2])
        )
        if (d > tol || sizeMiss) {
          bad++
          out.data.set([255, 0, 64, 255], i)
        } else {
          const v = ad.data[i] * 0.3
          out.data.set([v, ad.data[i + 1] * 0.3, ad.data[i + 2] * 0.3, 255], i)
        }
      }
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      c.getContext('2d').putImageData(out, 0, 0)
      return {
        fraction: bad / (w * h),
        diffPng: c.toDataURL('image/png').split(',')[1]
      }
    },
    [
      goldenPng.toString('base64'),
      actualPng.toString('base64'),
      CHANNEL_TOLERANCE
    ]
  )
}

let browser
let failed = 0
try {
  const rig = (opts.rig ?? (await startRig(['--mock', '--now', NOW]))).replace(
    /\/$/,
    ''
  )
  const site = (opts.site ?? (await startRig(['--noaa']))).replace(/\/$/, '')

  mkdirSync(mode === 'update' ? goldenDir : outDir, { recursive: true })

  browser = await chromium.launch()
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    timezoneId: 'UTC',
    locale: 'en-US',
    // The site's worker precaches its whole shell on first load: traffic
    // that races networkidle and changes no pixel.
    serviceWorkers: 'block'
  })
  const page = await context.newPage()
  const cmp = await context.newPage()

  // Each source is checked the way shots.mjs does, state and view both: a
  // fallback would be a plausible picture of the wrong thing. /mock/<state>
  // sets the mock's cookie and bounces to /; the hash rides along and picks
  // the view. The site keeps ?snapshot in its URL.
  const sources = [
    {
      name: 'mock rig',
      shots: mockShots,
      now: NOW,
      url: (state, view) => `${rig}/mock/${state}#${view}`,
      picked: () => /mockstate=([a-z]+)/.exec(document.cookie)?.[1]
    },
    {
      name: 'site',
      shots: siteShots,
      now: capturedAt,
      url: (state, view) => `${site}/?${state}#${view}`,
      picked: () => new URLSearchParams(location.search).keys().next().value
    }
  ]

  for (const { name, shots, now, url, picked } of sources) {
    await page.clock.setFixedTime(new Date(now))
    for (const [w, h] of widths) {
      await page.setViewportSize({ width: w, height: h })
      for (const [state, view, themes] of shots) {
        for (const theme of themes) {
          if (theme === 'light' && w !== widths[0][0]) continue
          const file = `${state}-${view}-${theme}-${w}.png`
          await page.emulateMedia({ colorScheme: theme })
          await page.goto(url(state, view), { waitUntil: 'networkidle' })
          if ((await page.evaluate(picked)) !== state)
            throw new Error(`${name} did not show "${state}"`)
          if (!(await page.locator(`#view-${view}:not([hidden])`).count()))
            throw new Error(`page did not show view "${view}"`)
          // The mock's state switcher is fixed to the bottom edge; a golden
          // is of the page, not the rig.
          await page.addStyleTag({
            content: '[data-mock-strip] { display: none !important }'
          })
          await page.waitForTimeout(600)
          const height = await page.evaluate(
            () => document.documentElement.scrollHeight
          )
          const shot = await page.screenshot({
            fullPage: true,
            clip: { x: 0, y: 0, width: w, height: Math.min(height, MAX_HEIGHT) }
          })
          if (mode === 'update') {
            writeFileSync(`${goldenDir}/${file}`, shot)
            console.log('wrote', file)
            continue
          }
          writeFileSync(`${outDir}/${file}`, shot)
          if (!existsSync(`${goldenDir}/${file}`)) {
            console.log('MISSING', file)
            failed++
            continue
          }
          const { fraction, diffPng } = await compare(
            cmp,
            readFileSync(`${goldenDir}/${file}`),
            shot
          )
          const pct = (fraction * 100).toFixed(3)
          if (fraction > MAX_DIFF_FRACTION) {
            writeFileSync(
              `${outDir}/diff-${file}`,
              Buffer.from(diffPng, 'base64')
            )
            console.log(`FAIL ${file} ${pct}% differs`)
            failed++
          } else {
            console.log(`ok   ${file} ${pct}%`)
          }
        }
      }
    }
  }
} finally {
  await browser?.close()
  for (const server of rigs) server.kill()
}

if (failed) {
  console.error(`${failed} golden(s) over ${MAX_DIFF_FRACTION * 100}%`)
  process.exit(1)
}
