#!/usr/bin/env node
// Screenshots the Kp tile off the mock rig, dark theme only -- CLAUDE.md's
// "the ground is dark in both themes" note is about the map, not this repo's
// PR pictures, which are dark-only by standing preference.
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const SPANS = { '72h': 'near', '27d': 'rotation' }

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : process.argv[i + 1]
}

const state = arg('state')
const span = arg('span')
if (!state || !SPANS[span]) {
  console.error('usage: node scripts/shots.mjs --state <mock-webapp state> --span <72h|27d>')
  process.exit(1)
}

const PORT = 8799
const base = `http://127.0.0.1:${PORT}`

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
  ['scripts/mock-webapp.mjs', String(PORT), '--host', '127.0.0.1'],
  { stdio: 'inherit' }
)

try {
  await waitForServer()

  const browser = await chromium.launch()
  const page = await browser.newPage({ colorScheme: 'dark' })
  await page.goto(`${base}/mock/${state}#kpview`)
  await page.click(`.kp-span button[data-span="${SPANS[span]}"]`)
  await page.waitForTimeout(200)

  const tile = page
    .locator('div[data-slot="kp"]')
    .locator('xpath=ancestor::div[contains(@class, "tile")][1]')
  const out = `kp-${span}-dark.png`
  await tile.screenshot({ path: out })
  console.log(out)

  await browser.close()
} finally {
  server.kill()
}
