#!/usr/bin/env node
// Screenshots the page off the mock rig for a PR: a whole view, or one or
// more of its tiles. Dark only: a PR's pictures carry one theme, so there is
// no --theme flag to forget.
//
//   node scripts/shots.mjs --state storm                     # the dashboard
//   node scripts/shots.mjs --state storm --view advisories   # another view
//   node scripts/shots.mjs --state storm --tile kp --tile hf --span 27d
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'

const SPANS = { '72h': 'near', '27d': 'rotation' }
const OUT_DIR = 'shots'

const { values: opts } = parseArgs({
  options: {
    state: { type: 'string', default: 'quiet' },
    view: { type: 'string', default: 'dashboard' },
    tile: { type: 'string', multiple: true, default: [] },
    span: { type: 'string' }
  }
})
if (opts.span && !SPANS[opts.span]) {
  console.error(`--span is 72h or 27d, not "${opts.span}"`)
  process.exit(1)
}

// A free port rather than a fixed one: two worktrees shooting at once would
// otherwise screenshot each other's rig.
const port = await new Promise((resolve, reject) => {
  const probe = createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})
const base = `http://127.0.0.1:${port}`

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base)).ok) return
    } catch {
      // not up yet
    }
    await sleep(100)
  }
  throw new Error(`mock rig did not answer at ${base}`)
}

const server = spawn(
  'node',
  ['scripts/mock-webapp.mjs', String(port), '--host', '127.0.0.1'],
  { stdio: 'inherit' }
)

let browser
try {
  await waitForServer()

  browser = await chromium.launch()
  const page = await browser.newPage({
    colorScheme: 'dark',
    viewport: { width: 1280, height: 900 }
  })
  await page.goto(`${base}/mock/${opts.state}#${opts.view}`)
  // The rig falls back to `quiet` for a name it doesn't know, and the page
  // to the dashboard for a view it doesn't: either would be a plausible
  // picture of the wrong thing.
  const picked = await page.evaluate(
    () => /mockstate=([a-z]+)/.exec(document.cookie)?.[1]
  )
  if (picked !== opts.state)
    throw new Error(`mock rig has no state "${opts.state}"`)
  const view = page.locator(`#view-${opts.view}`)
  if (!(await view.count())) throw new Error(`page has no view "${opts.view}"`)
  await page.waitForLoadState('networkidle')
  // The rig's state switcher is fixed to the bottom edge; a PR picture is of
  // the page, not the rig.
  await page.addStyleTag({ content: '[data-mock-strip] { display: none !important }' })

  if (opts.span) {
    // A state with no 27-day outlook draws no toggle: 72h is all it has.
    const toggle = view.locator(
      `.kp-span button[data-span="${SPANS[opts.span]}"]`
    )
    if (await toggle.count()) await toggle.click()
    else if (opts.span !== '72h')
      throw new Error(`no 27-day Kp outlook in "${opts.state}"/${opts.view}`)
    await page.waitForTimeout(200)
  }

  await mkdir(OUT_DIR, { recursive: true })
  const shots = opts.tile.length
    ? opts.tile.map((name) => ({
        name,
        target: view
          .locator(`[data-slot="${name}"]`)
          .first()
          .locator(
            'xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " tile ")][1]'
          )
      }))
    : [{ name: opts.view, target: page }]

  for (const { name, target } of shots) {
    if (target !== page && !(await target.count())) {
      const slots = await view
        .locator('[data-slot]')
        .evaluateAll((els) => [...new Set(els.map((el) => el.dataset.slot))])
      throw new Error(
        `no tile "${name}" in ${opts.view}; it has: ${slots.join(', ')}`
      )
    }
    // The span only names a shot the Kp chart is in.
    const suffix =
      opts.span && (name === 'kp' || target === page) ? `-${opts.span}` : ''
    const out = `${OUT_DIR}/${opts.state}-${name}${suffix}-dark.png`
    await target.screenshot(
      target === page ? { path: out, fullPage: true } : { path: out }
    )
    console.log(out)
  }
} finally {
  await browser?.close()
  server.kill()
}
