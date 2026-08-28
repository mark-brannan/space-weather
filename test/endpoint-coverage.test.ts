import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every path the plugin fetches has to be a row in `ENDPOINTS`, because that
 * list is what `scripts/measure-noaa.mjs` measures, and the doc and the
 * `updateInterval` config description are written from its output. Four of
 * sixteen endpoints had never been in a run, so the panel told users a poll
 * cost 5 KB when it cost 42 KB
 * ([#112](https://github.com/mark-brannan/signalk-noaa-space-weather/issues/112)).
 * Nothing noticed for weeks: an unmeasured endpoint is invisible by
 * construction — it cannot appear in the output that would show it missing.
 *
 * Static analysis, not execution. The registry runs this suite under
 * `firejail --net=none`, and the point is to catch the endpoint before it is
 * ever fetched.
 */
const srcDir = fileURLToPath(new URL('../src', import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

const sources = sourceFiles(srcDir).map((path) => ({
  path: path.slice(srcDir.length + 1),
  text: readFileSync(path, 'utf8')
}))

const CALL = /\bclient\s*\.\s*(json|text)\s*\(\s*/g

interface Call {
  file: string
  literal: string | null
}

/** The first argument of every `client.json(...)` / `client.text(...)` call. */
function calls(): Call[] {
  const found: Call[] = []
  for (const { path, text } of sources) {
    for (const match of text.matchAll(CALL)) {
      const rest = text.slice(match.index + match[0].length)
      // A computed path cannot be checked against the list, so it is reported
      // as a failure rather than skipped.
      const literal = rest.match(/^'([^']*)'/) ?? rest.match(/^"([^"]*)"/)
      found.push({ file: path, literal: literal?.[1] ?? null })
    }
  }
  return found
}

/**
 * `ENDPOINTS` is read out of the script rather than imported from it: a
 * Windows checkout leaves CRLF line endings on the `.mjs`, which vitest's
 * transform rejects outright. Reading the paths is also all this needs.
 */
const paths = [
  ...readFileSync(
    fileURLToPath(new URL('../scripts/measure-noaa.mjs', import.meta.url)),
    'utf8'
  )
    .replace(/\r\n/g, '\n')
    .split(/const ENDPOINTS = \[/)[1]
    .split(']\n')[0]
    .matchAll(/'(\/[^']+)'/g)
].map((match) => match[1])

describe('every endpoint the plugin fetches is measured', () => {
  it('finds the list and the fetches at all', () => {
    // A refactor that broke either scan would otherwise pass this file
    // silently: two empty lists agree with each other.
    expect(paths.length).toBeGreaterThan(10)
    expect(calls().length).toBeGreaterThanOrEqual(paths.length)
  })

  it('passes a string literal, so the path is readable off the source', () => {
    expect(calls().filter((call) => call.literal === null)).toEqual([])
  })

  it('fetches nothing missing from measure-noaa.mjs', () => {
    const measured = new Set(paths)
    const fetched = new Set(
      calls()
        .map((call) => call.literal)
        .filter((path): path is string => path !== null)
    )
    expect([...fetched].filter((path) => !measured.has(path))).toEqual([])
  })

  it('measures nothing the plugin no longer fetches', () => {
    const fetched = new Set(calls().map((call) => call.literal))
    expect(paths.filter((path: string) => !fetched.has(path))).toEqual([])
  })

  it('makes no outbound request outside the client', () => {
    // The scan above only sees paths that go through the client. That is the
    // rule anyway — noaa/client.ts is the only outbound I/O — but unenforced
    // it is also the hole in this check.
    const offenders = sources
      .filter(({ path }) => path !== 'noaa/client.ts')
      .filter(({ text }) => /(?<![.\w])fetch\s*\(/.test(text))
      .map(({ path }) => path)
    expect(offenders).toEqual([])
  })
})
