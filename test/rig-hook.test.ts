import { afterEach, describe, expect, it } from 'vitest'
import { UI_PATHS, editHook, stopHook } from '../scripts/rig-hook.mjs'

/**
 * The hooks that print the rig line on every Stop and block the turn while a
 * UI path is touched with no rig serving the worktree. The probes -- which
 * rigs run, what the branch touches, whether this box is reachable -- are
 * replaced through the env seams the script reads, so the test is offline
 * and independent of whatever rigs happen to be up on the machine running it.
 */
const ROOT = '/tmp/rig-hook-test-root'
const URLS = 'http://localhost:8731/\nhttp://192.168.1.9:8731/'

function seams(o: { urls?: string; touched?: string; reachable?: '0' | '1' }) {
  process.env.RIG_HOOK_URLS = o.urls ?? ''
  process.env.RIG_HOOK_TOUCHED = o.touched ?? ''
  process.env.RIG_HOOK_REACHABLE = o.reachable ?? '1'
}

afterEach(() => {
  delete process.env.RIG_HOOK_URLS
  delete process.env.RIG_HOOK_TOUCHED
  delete process.env.RIG_HOOK_REACHABLE
})

describe('UI_PATHS', () => {
  it.each([
    'public/hero.js',
    'public/index.html',
    'src/browser/seam.ts',
    'scripts/mock-webapp.mjs'
  ])('counts %s', (f) => expect(UI_PATHS.test(f)).toBe(true))
  it.each([
    'src/parse.ts',
    'scripts/webapp-ctl.mjs',
    'docs/development.md',
    'test/hero.test.ts'
  ])('ignores %s', (f) => expect(UI_PATHS.test(f)).toBe(false))
})

describe('stop', () => {
  it('prints one URL per line and the stop command when a rig serves the worktree', () => {
    seams({ urls: URLS, touched: 'public/hero.js' })
    const out = stopHook({}, ROOT)
    expect(out.systemMessage).toBe(
      'rig  http://localhost:8731/\nrig  http://192.168.1.9:8731/\nstop: node scripts/webapp-ctl.mjs stop 8731'
    )
    expect(out.decision).toBeUndefined()
  })

  it('prints "none" and does not block when nothing UI is touched', () => {
    seams({ touched: 'src/parse.ts' })
    const out = stopHook({}, ROOT)
    expect(out).toEqual({ systemMessage: 'rig  none for this worktree' })
  })

  it('blocks when a UI path is touched and no rig serves the worktree', () => {
    seams({ touched: 'src/parse.ts\npublic/hero.js' })
    const out = stopHook({}, ROOT)
    expect(out.systemMessage).toBe('rig  none for this worktree')
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('webapp-ctl.mjs start')
    expect(out.reason).toContain(ROOT)
  })

  it('blocks again on the next stop -- no once-per-session throttle', () => {
    seams({ touched: 'public/index.html' })
    expect(stopHook({}, ROOT).decision).toBe('block')
    expect(stopHook({}, ROOT).decision).toBe('block')
  })

  it('never blocks while a stop hook is already being answered', () => {
    seams({ touched: 'public/index.html' })
    const out = stopHook({ stop_hook_active: true }, ROOT)
    expect(out.decision).toBeUndefined()
    expect(out.systemMessage).toBe('rig  none for this worktree')
  })

  it('says unreachable and never blocks on a cloud VM', () => {
    seams({ touched: 'public/index.html', reachable: '0' })
    expect(stopHook({}, ROOT)).toEqual({
      systemMessage: 'rig  unreachable from here (cloud VM)'
    })
  })
})

describe('edit', () => {
  const edit = (file_path: string) =>
    editHook({ tool_input: { file_path } }, ROOT)

  it('asks for the rig at the first UI edit with none running', () => {
    seams({})
    const out = edit(`${ROOT}/public/hero.js`)
    expect(out?.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    expect(out?.hookSpecificOutput.additionalContext).toContain(
      'public/hero.js'
    )
    expect(out?.hookSpecificOutput.additionalContext).toContain(
      'webapp-ctl.mjs start'
    )
  })

  it('is silent for a non-UI edit', () => {
    seams({})
    expect(edit(`${ROOT}/src/parse.ts`)).toBeNull()
  })

  it('is silent once a rig serves the worktree', () => {
    seams({ urls: URLS })
    expect(edit(`${ROOT}/public/hero.js`)).toBeNull()
  })

  it('is silent on a cloud VM', () => {
    seams({ reachable: '0' })
    expect(edit(`${ROOT}/public/hero.js`)).toBeNull()
  })

  it('is silent for a tool call without a path', () => {
    seams({})
    expect(editHook({}, ROOT)).toBeNull()
  })
})
