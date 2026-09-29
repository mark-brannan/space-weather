// The Claude Code hooks that make "show it running" mechanical.
//
//   node scripts/rig-hook.mjs stop    # Stop hook: the rig line, every turn
//   node scripts/rig-hook.mjs edit    # PostToolUse on Edit/Write: start it now
//
// Why a hook and not a rule: CLAUDE.md and docs/development.md already said
// to show any reader-visible change running, and a session still answered
// with a diff until told twice. A rule is advice; this fires. The Stop
// hook prints one fixed line on every stop, repeats included -- ruled
// 2026-09-28 (Solace): a repeat costs nothing, a missing line costs a
// prompt -- and blocks the turn while a UI path is touched and no rig
// serves this worktree. The edit hook is the same test at the first edit,
// so the rig is up before anyone asks. Wired in .claude/settings.json.
//
// The line, one of:
//
//   rig  http://localhost:8731/  http://192.168.x.x:8731/  http://100.x.x.x:8731/
//   rig  none for this worktree
//   rig  unreachable from here (cloud VM)
//
// No dependencies -- node builtins only, like the rest of scripts/.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// What "might have a UI effect" means, as paths rather than judgment: the
// page and its modules, the browser data layer under them, and the rig that
// serves them. Over-firing is the cheap side.
export const UI_PATHS = /^(public\/|src\/browser\/|scripts\/mock-webapp\.mjs$)/

const CTL = fileURLToPath(new URL('./webapp-ctl.mjs', import.meta.url))

function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

function repoRoot() {
  if (process.env.RIG_HOOK_ROOT) return process.env.RIG_HOOK_ROOT
  const from = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  return run('git', ['rev-parse', '--show-toplevel'], from).trim() || from
}

// A cloud session checks the repo out under one of these; a rig there has
// no address the user's browser can reach, so the line says so and the hook
// never blocks -- a gate that can trap a session is worse than no gate.
function reachable(root) {
  if (process.env.RIG_HOOK_REACHABLE) return process.env.RIG_HOOK_REACHABLE === '1'
  return !/^\/(home\/user|workspace)\//.test(root)
}

function rigUrls(root) {
  if (process.env.RIG_HOOK_URLS !== undefined) {
    return process.env.RIG_HOOK_URLS.split('\n').filter(Boolean)
  }
  return run(process.execPath, [CTL, 'urls'], root).split('\n').filter(Boolean)
}

// Everything the branch and the working tree change against the default
// branch: committed, staged, unstaged and untracked. A stacked branch counts
// its base's changes too, which is over-firing, which is fine.
function touched(root) {
  if (process.env.RIG_HOOK_TOUCHED !== undefined) {
    return process.env.RIG_HOOK_TOUCHED.split('\n').filter(Boolean)
  }
  const base = ['origin/main', 'main'].find((b) =>
    run('git', ['rev-parse', '--verify', '-q', b], root).trim()
  )
  const committed = base ? run('git', ['diff', '--name-only', `${base}...HEAD`], root) : ''
  const working = run('git', ['status', '--porcelain', '--untracked-files=all'], root)
    .split('\n')
    .map((l) => l.slice(3).replace(/^.* -> /, ''))
  return [...committed.split('\n'), ...working].filter(Boolean)
}

function uiTouched(root) {
  return touched(root).some((f) => UI_PATHS.test(f))
}

function line(urls, isReachable) {
  if (urls.length) return `rig  ${urls.join('  ')}`
  return isReachable
    ? 'rig  none for this worktree'
    : 'rig  unreachable from here (cloud VM)'
}

function stopCommand(urls) {
  const ports = [...new Set(urls.map((u) => u.match(/:(\d+)\/$/)?.[1]).filter(Boolean))]
  return ports.map((p) => `stop: node scripts/webapp-ctl.mjs stop ${p}`).join('\n')
}

const START =
  'Start the mock rig for this worktree now: `npm run build` if dist/ is stale, ' +
  'then `node scripts/webapp-ctl.mjs start` (backgrounded, per docs/development.md), ' +
  'then print `node scripts/webapp-ctl.mjs urls` as the rig line, both forms, before anything else.'

export function stopHook(input, root = repoRoot()) {
  const isReachable = reachable(root)
  const urls = rigUrls(root)
  const message = urls.length ? `${line(urls, true)}\n${stopCommand(urls)}` : line(urls, isReachable)
  const out = { systemMessage: message }
  if (!input.stop_hook_active && isReachable && urls.length === 0 && uiTouched(root)) {
    out.decision = 'block'
    out.reason =
      'A path under public/, src/browser/ or scripts/mock-webapp.mjs is touched and no mock rig ' +
      `serves this worktree (${root}). ${START} Then end the turn again.`
  }
  return out
}

export function editHook(input, root = repoRoot()) {
  const file = input.tool_input?.file_path
  if (!file) return null
  const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/')
  if (!UI_PATHS.test(rel)) return null
  if (!reachable(root)) return null
  if (rigUrls(root).length) return null
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `${rel} may change what a reader sees and no mock rig serves this worktree. ${START}`
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { readFileSync } = await import('node:fs')
  let input = {}
  try {
    const raw = readFileSync(0, 'utf8')
    input = raw.trim() ? JSON.parse(raw) : {}
  } catch {
    input = {}
  }
  const root = repoRoot()
  if (!existsSync(root)) process.exit(0)
  const out = process.argv[2] === 'edit' ? editHook(input, root) : stopHook(input, root)
  if (out) process.stdout.write(JSON.stringify(out) + '\n')
}
