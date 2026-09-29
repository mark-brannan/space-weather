// Starts, stops, or lists mock-webapp.mjs processes without a pidfile.
//
//   node scripts/webapp-ctl.mjs start [port]   # default 8731
//   node scripts/webapp-ctl.mjs stop [port]
//   node scripts/webapp-ctl.mjs list
//   node scripts/webapp-ctl.mjs orphans
//   node scripts/webapp-ctl.mjs urls        # rigs serving this checkout, one URL per line
//
// A pidfile can't be the source of truth for "is the mock rig running on
// this port" -- it goes stale the moment the rig was started some other way
// (plain `npm run dev:webapp`, a different shell, a reboot), and then the
// tool can't even see the thing it's meant to manage. So every action here
// re-derives state live: `lsof` for who's listening on the port, `ps` for
// whether that pid is actually running mock-webapp.mjs. Matching is done on
// the process's real command (`comm`), not a substring of its full argv --
// argv can contain "mock-webapp.mjs" as plain text inside an unrelated
// wrapper command (a shell that's about to run it, a shell history replay)
// without the process itself being one.
//
// No dependencies -- only node:child_process, node:os -- matching the rest
// of scripts/.
import { execFileSync } from 'node:child_process'
import { existsSync, readlinkSync, realpathSync } from 'node:fs'
import os from 'node:os'

const SIGNATURE = 'mock-webapp.mjs'
const DEFAULT_PORT = 8731

// stderr is dropped: lsof warns about every filesystem it can't stat (WSL's
// 9p mounts, for one), once per call, and this script calls it per rig.
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return ''
  }
}

function pidOnPort(port) {
  const out = run('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'])
  return out.split('\n')[0].trim() || null
}

function commOf(pid) {
  return run('ps', ['-o', 'comm=', '-p', String(pid)]).trim()
}

function argsOf(pid) {
  return run('ps', ['-o', 'args=', '-p', String(pid)]).trim()
}

function isOurs(pid) {
  return commOf(pid) === 'node' && argsOf(pid).includes(SIGNATURE)
}

// The rig's working directory -- /proc is universal on Linux; lsof's `cwd`
// fd entry is the macOS fallback (Linux lsof supports it too, but /proc is
// cheaper and doesn't need lsof at all).
function cwdOf(pid) {
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    const out = run('lsof', ['-p', String(pid), '-d', 'cwd', '-Fn'])
    const line = out.split('\n').find((l) => l.startsWith('n'))
    return line ? line.slice(1) : null
  }
}

// Every currently-running mock-webapp.mjs pid, with its port if it's
// listening yet and the directory it was started from.
function listRigs() {
  const psOut = run('ps', ['-eo', 'pid=,comm=,args='])
  const rigs = []
  for (const line of psOut.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    const [, pid, comm, args] = m
    if (comm !== 'node' || !args.includes(SIGNATURE)) continue
    const lsofOut = run('lsof', ['-aiTCP', '-sTCP:LISTEN', '-p', pid, '-Fn'])
    const portLine = lsofOut.split('\n').find((l) => /^n.*:\d+$/.test(l))
    const port = portLine ? portLine.replace(/^n.*:/, '') : null
    rigs.push({ pid, port, cwd: cwdOf(pid) })
  }
  return rigs
}

function cmdList() {
  const rigs = listRigs()
  if (rigs.length === 0) {
    console.log('no mock-webapp.mjs processes running')
    return
  }
  for (const { pid, port, cwd } of rigs) {
    const where = cwd || 'cwd unknown'
    console.log(
      port
        ? `port ${port}  running (pid ${pid})  http://127.0.0.1:${port}/  ${where}`
        : `pid ${pid}  running, not yet listening on any port  ${where}`
    )
  }
}

// Is `cwd` inside a live worktree of the repo it sits in? Ask that repo, not
// the repo this script happens to run from -- a rig started from a
// different checkout answers against its own `git worktree list`. Both
// sides are resolved through realpath: /proc reports the canonical path,
// git reports the path the worktree was registered under, and a symlink in
// either would otherwise read as an orphan and get the rig killed.
function isLiveWorktree(cwd) {
  const top = run('git', ['-C', cwd, 'rev-parse', '--show-toplevel']).trim()
  if (!top) return false
  const real = (p) => {
    try {
      return realpathSync(p)
    } catch {
      return null
    }
  }
  const out = run('git', ['-C', top, 'worktree', 'list', '--porcelain'])
  return out
    .split('\n\n')
    .map((block) => block.match(/^worktree (.+)$/m)?.[1])
    .filter(Boolean)
    .map(real)
    .includes(real(top))
}

function cmdOrphans() {
  const rigs = listRigs()
  if (rigs.length === 0) {
    console.log('no mock-webapp.mjs processes running')
    return
  }
  let stopped = 0
  for (const { pid, port, cwd } of rigs) {
    if (!isOurs(pid)) {
      console.error(
        `pid ${pid} no longer looks like a ${SIGNATURE} process -- not touching it. cmdline: ${argsOf(pid)}`
      )
      continue
    }
    const orphaned = !cwd || !existsSync(cwd) || !isLiveWorktree(cwd)
    if (!orphaned) continue
    // One rig we can't signal (another user's, or gone between list and
    // kill) must not abort the sweep for the rest.
    try {
      process.kill(Number(pid))
    } catch (e) {
      console.error(`pid ${pid}: could not stop (${e.code || e.message})`)
      process.exitCode = 1
      continue
    }
    stopped++
    console.log(
      `stopped orphaned rig (pid ${pid}, cwd ${cwd || 'unknown'}${port ? `, port ${port}` : ''})`
    )
  }
  if (stopped === 0) console.log('no orphaned rigs')
}

function cmdStop(port) {
  const pid = pidOnPort(port)
  if (!pid) {
    console.log(`port ${port}: nothing listening, nothing to stop`)
    return
  }
  if (!isOurs(pid)) {
    console.error(
      `port ${port} is held by pid ${pid}, which isn't a ${SIGNATURE} process -- not touching it. cmdline: ${argsOf(pid)}`
    )
    process.exitCode = 1
    return
  }
  process.kill(Number(pid))
  console.log(`stopped mock webapp on port ${port} (pid ${pid})`)
}

async function cmdStart(port) {
  const existing = pidOnPort(port)
  if (existing) {
    if (isOurs(existing)) {
      console.log(
        `already running on port ${port} (pid ${existing}) — http://127.0.0.1:${port}/`
      )
      return
    }
    console.error(
      `port ${port} is already in use by pid ${existing}, which isn't a ${SIGNATURE} process. cmdline: ${argsOf(existing)}. Pick another port.`
    )
    process.exitCode = 1
    return
  }

  const { spawn } = await import('node:child_process')
  const child = spawn(
    process.execPath,
    ['scripts/mock-webapp.mjs', String(port)],
    {
      cwd: new URL('..', import.meta.url).pathname,
      detached: true,
      stdio: 'ignore'
    }
  )
  child.unref()
  await new Promise((r) => setTimeout(r, 1000))

  const pid = pidOnPort(port)
  if (!pid || !isOurs(pid)) {
    console.error(`failed to start on port ${port}`)
    process.exitCode = 1
    return
  }

  const addrs = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)
  console.log(`mock webapp rig on port ${port} (pid ${pid}):`)
  console.log(`  http://127.0.0.1:${port}/`)
  for (const addr of addrs) console.log(`  http://${addr}:${port}/`)
  console.log(`  stop with: node scripts/webapp-ctl.mjs stop ${port}`)
}

// The rigs whose cwd is this checkout -- `start` spawns with cwd at the repo
// root and `npm run dev:webapp` runs there too, so cwd is the worktree a rig
// serves. Prints every reachable form of each one, loopback first, so a
// caller (the Stop hook, a closing message) never has to work out which
// address the phone resolves. Exits 1 with nothing printed when none serves
// this checkout, which is what makes it usable as a test in `sh`.
function urlsFor(root) {
  const real = (p) => {
    try {
      return realpathSync(p)
    } catch {
      return null
    }
  }
  const here = real(root)
  const addrs = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)
  const urls = []
  for (const { port, cwd } of listRigs()) {
    if (!port || !cwd || real(cwd) !== here) continue
    urls.push(`http://localhost:${port}/`)
    for (const addr of addrs) urls.push(`http://${addr}:${port}/`)
  }
  return urls
}

function cmdUrls() {
  const root = run('git', ['rev-parse', '--show-toplevel']).trim() || process.cwd()
  const urls = urlsFor(root)
  if (urls.length === 0) {
    process.exitCode = 1
    return
  }
  for (const u of urls) console.log(u)
}

const [cmd, arg] = process.argv.slice(2)
const port = Number(arg) || DEFAULT_PORT

switch (cmd) {
  case 'list':
    cmdList()
    break
  case 'stop':
    cmdStop(port)
    break
  case 'orphans':
    cmdOrphans()
    break
  case 'urls':
    cmdUrls()
    break
  case 'start':
  case undefined:
    await cmdStart(port)
    break
  default:
    console.error(
      `unknown command "${cmd}" -- expected start, stop, list, orphans, or urls`
    )
    process.exitCode = 1
}
