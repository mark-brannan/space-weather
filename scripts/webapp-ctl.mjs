// Starts, stops, or lists mock-webapp.mjs processes without a pidfile.
//
//   node scripts/webapp-ctl.mjs start [port]   # default 8731
//   node scripts/webapp-ctl.mjs stop [port]
//   node scripts/webapp-ctl.mjs list
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
import os from 'node:os'

const SIGNATURE = 'mock-webapp.mjs'
const DEFAULT_PORT = 8731

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' })
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

// Every currently-running mock-webapp.mjs pid, with its port if it's
// listening yet.
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
    rigs.push({ pid, port })
  }
  return rigs
}

function cmdList() {
  const rigs = listRigs()
  if (rigs.length === 0) {
    console.log('no mock-webapp.mjs processes running')
    return
  }
  for (const { pid, port } of rigs) {
    console.log(
      port
        ? `port ${port}  running (pid ${pid})  http://127.0.0.1:${port}/`
        : `pid ${pid}  running, not yet listening on any port`
    )
  }
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

const [cmd, arg] = process.argv.slice(2)
const port = Number(arg) || DEFAULT_PORT

switch (cmd) {
  case 'list':
    cmdList()
    break
  case 'stop':
    cmdStop(port)
    break
  case 'start':
  case undefined:
    await cmdStart(port)
    break
  default:
    console.error(`unknown command "${cmd}" -- expected start, stop, or list`)
    process.exitCode = 1
}
