#!/usr/bin/env node
// Screenshots the Kp tile off the mock rig for a PR. Dark only: a PR's
// pictures carry one theme, so there is no --theme flag to forget.
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

const SPANS = { '72h': 'near', '27d': 'rotation' }
const OUT_DIR = 'shots'

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : process.argv[i + 1]
}

const state = arg('state')
const span = arg('span')
if (!state || !SPANS[span]) {
  console.error(
    'usage: node scripts/shots.mjs --state <mock-webapp state> --span <72h|27d>'
  )
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
  const page = await browser.newPage({ colorScheme: 'dark' })
  await page.goto(`${base}/mock/${state}#dashboard`)
  // The rig falls back to `quiet` for a name it doesn't know, which would
  // be a plausible picture of the wrong state.
  const picked = await page.evaluate(
    () => /mockstate=([a-z]+)/.exec(document.cookie)?.[1]
  )
  if (picked !== state) throw new Error(`mock rig has no state "${state}"`)
  await page.waitForSelector('div[data-slot="kp"] #kpChart', {
    state: 'attached'
  })
  // A state with no 27-day outlook draws no span toggle: 72h is all it has.
  const toggle = page.locator(`.kp-span button[data-span="${SPANS[span]}"]`)
  if (await toggle.count()) await toggle.click()
  else if (span !== '72h')
    throw new Error(`state "${state}" has no 27-day outlook to show`)
  await page.waitForTimeout(200)

  const tile = page
    .locator('div[data-slot="kp"]')
    .locator('xpath=ancestor::div[contains(@class, "tile")][1]')
  await mkdir(OUT_DIR, { recursive: true })
  const out = `${OUT_DIR}/kp-${state}-${span}-dark.png`
  await tile.screenshot({ path: out })
  console.log(out)
} finally {
  await browser?.close()
  server.kill()
}
