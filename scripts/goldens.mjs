#!/usr/bin/env node
// Screenshot goldens: the page off the mock rig, pinned clock, compared pixel
// for pixel against screenshots/goldens/. Modelled on searoom's.
//
//   node scripts/goldens.mjs update [baseUrl]   rewrite screenshots/goldens/
//   node scripts/goldens.mjs check  [baseUrl]   compare; exit 1 if any shot
//                                               differs by more than 0.1% of pixels
//
// Without a baseUrl the script starts its own rig on a free port, with
// `--now NOW` so that the fabricated data is the same every run; the page's
// clock is pinned to the same instant. With one (CI starts the rig itself)
// the rig must have been started with that flag, or every timer differs.
// `check` writes the actual renders and a red-mask diff-*.png for each miss
// to goldens-out/ (CI uploads it). Comparison runs in the browser on a
// canvas, so no image dependency is added.
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const mode = process.argv[2] ?? 'check'
if (mode !== 'check' && mode !== 'update') {
  console.error(`usage: goldens.mjs check|update [baseUrl]`)
  process.exit(1)
}
const goldenDir = 'screenshots/goldens'
const outDir = 'goldens-out'
const NOW = '2026-03-20T12:00:00Z'
const MAX_DIFF_FRACTION = 0.001 // 0.1% of pixels
const CHANNEL_TOLERANCE = 16 // per-channel delta below this is anti-aliasing noise
const MAX_HEIGHT = 3000 // px; a long phone page stays a reviewable PNG

// A quiet and a stormy dashboard, the other three views on the storm, and the
// empty page; dark at both widths, light on the two dashboards only -- the
// light theme is the same layout with other tokens, so one width shows it.
const shots = [
  ['quiet', 'dashboard', ['dark', 'light']],
  ['storm', 'dashboard', ['dark', 'light']],
  ['storm', 'advisories', ['dark']],
  ['storm', 'map', ['dark']],
  ['storm', 'diagnostics', ['dark']],
  ['nodata', 'dashboard', ['dark']]
]
const widths = [
  [1280, 900],
  [360, 740]
]

let base = process.argv[3]
let server
if (!base) {
  // A free port rather than a fixed one, like shots.mjs: two worktrees
  // shooting at once would otherwise screenshot each other's rig.
  const port = await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
  base = `http://127.0.0.1:${port}`
  server = spawn(
    'node',
    [
      'scripts/mock-webapp.mjs',
      String(port),
      '--host',
      '127.0.0.1',
      '--now',
      NOW
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  )
  let up = false
  for (let i = 0; i < 50 && !up; i++) {
    try {
      up = (await fetch(base)).ok
    } catch {
      await sleep(100)
    }
  }
  if (!up) {
    server.kill()
    throw new Error(`mock rig did not answer at ${base}`)
  }
}
base = base.replace(/\/$/, '')

mkdirSync(mode === 'update' ? goldenDir : outDir, { recursive: true })

const browser = await chromium.launch()
const context = await browser.newContext({
  reducedMotion: 'reduce',
  deviceScaleFactor: 1,
  timezoneId: 'UTC',
  locale: 'en-US'
})
const page = await context.newPage()
const cmp = await context.newPage()
await page.clock.setFixedTime(new Date(NOW))

// Returns { fraction, diffPng (base64) } for two PNG buffers.
async function compare(goldenPng, actualPng) {
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

let failed = 0
try {
  for (const [w, h] of widths) {
    await page.setViewportSize({ width: w, height: h })
    for (const [state, view, themes] of shots) {
      for (const theme of themes) {
        if (theme === 'light' && w !== widths[0][0]) continue
        const file = `${state}-${view}-${theme}-${w}.png`
        await page.emulateMedia({ colorScheme: theme })
        // /mock/<state> sets the rig's cookie and bounces to /; the hash
        // rides along and picks the view. Both are checked the way
        // shots.mjs does: a fallback would be a plausible picture of the
        // wrong thing.
        await page.goto(`${base}/mock/${state}#${view}`, {
          waitUntil: 'networkidle'
        })
        const picked = await page.evaluate(
          () => /mockstate=([a-z]+)/.exec(document.cookie)?.[1]
        )
        if (picked !== state)
          throw new Error(`mock rig has no state "${state}"`)
        if (!(await page.locator(`#view-${view}:not([hidden])`).count()))
          throw new Error(`page did not show view "${view}"`)
        // The rig's state switcher is fixed to the bottom edge; a golden is
        // of the page, not the rig.
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
} finally {
  await browser.close()
  server?.kill()
}

if (failed) {
  console.error(`${failed} golden(s) over ${MAX_DIFF_FRACTION * 100}%`)
  process.exit(1)
}
