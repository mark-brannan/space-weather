// Assembles the browser site -- the Pages demo and the installable app, one
// site -- into site-dist/, gitignored.
//
//   npm install && npm run build && npm run site:build
//   python3 -m http.server -d site-dist 8740   # or any static server
//
// The site is the shipping page, not a copy of it: public/index.html itself,
// with exactly one substitution -- site/signalk.js lands as signalk.js, so the
// page and every module it imports resolve their './signalk.js' to the site's
// data layer and run unchanged against NOAA from the tab, or (on ?snapshot) a
// saved capture, instead of a Signal K server. The site's own framing is
// appended as one script tag rather than edited in, which keeps index.html
// unforked.
//
// The file list is the page's transitive import closure, never hand-written,
// so a module added to index.html cannot go missing from the site. The live
// layer is this repo's own dist/, copied under plugin/ and loaded unbundled.
import fssync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MODULE_PATH = fileURLToPath(import.meta.url)
export const REPO = path.resolve(path.dirname(MODULE_PATH), '..')
export const PUBLIC = path.join(REPO, 'public')
export const SITE = path.join(REPO, 'site')
// This repo's own build, never an installed copy of the package: the site
// ships the core as it stands in this checkout.
export const DIST = path.join(REPO, 'dist')
export const OUT = path.join(REPO, 'site-dist')

// Where the compiled core lands in the site. A prefix rather than a flat copy,
// because dist/ has its own subdirectories and the emitted imports between
// them are relative -- so the closure walker follows them with no special case.
export const PLUGIN_PREFIX = 'plugin/'

export const ENTRY = 'index.html'

// Loaded after the page's own script, so it inserts into a built page rather
// than racing it.
const CHROME_TAG = '\n<script type="module" src="./site-chrome.js"></script>\n'

// Files site/ supplies, keyed by the name they land under. signalk.js is the
// substitution the whole site turns on.
const FILES = {
  'signalk.js': 'signalk.js',
  'store.js': 'store.js',
  'site-chrome.js': 'chrome.js',
  'sw.js': 'sw.js',
  'manifest.webmanifest': 'manifest.webmanifest',
  'snapshot.json': 'snapshot.json',
  'icon.svg': 'icon.svg'
}

// The page is the root, and the framing module is the only other one. The
// admin UI's config screen (remoteEntry.js, config-panel.js) stays out
// because nothing on the page imports it.
const ROOTS = [ENTRY, 'site-chrome.js']

// Reached by no import, so they have to be named: the snapshot is fetched by
// URL, the worker registered by URL, the manifest and icon linked at runtime.
const ASSETS = ['snapshot.json', 'sw.js', 'manifest.webmanifest', 'icon.svg']

// Never precached: the worker itself (a worker that precaches itself pins the
// old one and makes the next update fight it) and the snapshot, which is data
// only a ?snapshot reader wants.
const NOT_SHELL = new Set(['sw.js', 'snapshot.json'])

// `import ... from`, `export ... from` and `import(...)`, relative only. A
// bare specifier would be a bug on a page with no bundler. The lookbehind is
// what keeps `transform` and friends from matching.
const RELATIVE_IMPORT = /(?<![\w$])(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g

/** Where the build reads the file that lands in the site under `name`. */
export const sourceOf = (name) =>
  name.startsWith(PLUGIN_PREFIX)
    ? path.join(DIST, name.slice(PLUGIN_PREFIX.length))
    : FILES[name]
      ? path.join(SITE, FILES[name])
      : path.join(PUBLIC, name)

function readSite(name) {
  const source = sourceOf(name)
  // Named rather than left as ENOENT: a missing plugin/ file means dist/ is
  // not built, which is one command away and nothing like a broken import.
  if (name.startsWith(PLUGIN_PREFIX) && !fssync.existsSync(source)) {
    throw new Error(
      `${name} is missing from ${DIST} -- run \`npm run build\` first; the ` +
        "site's live data layer is this repo's compiled core"
    )
  }
  return fssync.readFileSync(source, 'utf8')
}

/**
 * The site-relative names one file imports. Exported, and taking `source`,
 * so the tests check the closure with the build's own reader rather than a
 * second copy of the pattern.
 */
export function resolveImports(name, source = readSite(name)) {
  const dirname = path.posix.dirname(name)
  const targets = []
  for (const [, specifier] of source.matchAll(RELATIVE_IMPORT)) {
    const target = path.posix.normalize(path.posix.join(dirname, specifier))
    // A specifier that climbs out of the site would be copied to a path
    // outside the output directory -- silently, over whatever is there.
    if (target.startsWith('..')) {
      throw new Error(
        `${name} imports '${specifier}', which resolves outside the site ` +
          `(${target}) -- the build cannot copy a file it would have to ` +
          'write above site-dist/'
      )
    }
    targets.push(target)
  }
  return targets
}

/**
 * Every file the site needs, found by following imports from the roots
 * through whatever actually lands -- so the closure is over the site's own
 * signalk.js, not public's.
 */
function importClosure(entries) {
  const site = []
  const seen = new Set()
  const queue = [...entries]
  while (queue.length) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    site.push(name)
    queue.push(...resolveImports(name))
  }
  return site
}

export const SITE_FILES = [
  ...new Set([...importClosure(ROOTS), ...ASSETS])
].sort()

/** The subset copied out of public/, the vendored coast-wright included. */
export const PUBLIC_MODULES = SITE_FILES.filter(
  (name) => !FILES[name] && !name.startsWith(PLUGIN_PREFIX)
)

/** The compiled core the live layer pulls in: live.js's closure, no more. */
export const PLUGIN_MODULES = SITE_FILES.filter((name) =>
  name.startsWith(PLUGIN_PREFIX)
)

/** What the worker precaches: the shell, as the site's own file list. */
export const SHELL = SITE_FILES.filter((name) => !NOT_SHELL.has(name)).map(
  (name) => `./${name}`
)

export const formatPosition = ({ latitude, longitude }) =>
  `${Math.abs(latitude)}°${latitude >= 0 ? 'N' : 'S'} ` +
  `${Math.abs(longitude)}°${longitude >= 0 ? 'E' : 'W'}`

// site/chrome.js's build-time blanks: the note's stand-in position, one per
// data layer. Live runs at the core's DEMO_POSITION; the snapshot was captured
// wherever DEMO_POSITION stood then, which a core change can move without a
// recapture, so its label comes from the snapshot itself. Filled here, in
// Node -- a runtime import of DEMO_POSITION in chrome.js would pull the live
// closure into a page a ?snapshot visitor loads to avoid exactly that.
const PLACEHOLDERS = {
  __DEMO_POSITION__: 'live',
  __SNAPSHOT_POSITION__: 'snapshot'
}

/**
 * Takes its template and positions, so the test can check the substitution
 * without an assembled site. Throws rather than ship a literal placeholder: a
 * chrome.js that lost one is the regression this exists to catch.
 */
export function fillChrome(template, positions) {
  let filled = template
  for (const [blank, layer] of Object.entries(PLACEHOLDERS)) {
    if (!filled.includes(blank)) {
      throw new Error(
        `site/chrome.js: ${blank} not found -- the stand-in position note ` +
          'may have been hand-typed again'
      )
    }
    filled = filled.replaceAll(blank, formatPosition(positions[layer]))
  }
  return filled
}

/** The position site/snapshot.json was captured at, as its data records it. */
export function snapshotPosition() {
  const saved = JSON.parse(readSite('snapshot.json'))
  return saved.values['navigation.position'].value
}

/**
 * The worker's two blanks, filled from the site's own file list. A blank left
 * behind is a worker that precaches the string "__SHELL__" and fails its
 * install, offline, on someone's phone -- silently.
 */
export function fillWorker(template, version) {
  const filled = template
    .replace('__SHELL__', JSON.stringify(SHELL, null, 2))
    .replace('__VERSION__', version)
  if (filled.includes('__SHELL__') || filled.includes('__VERSION__')) {
    throw new Error('site/sw.js: a build placeholder was left unfilled')
  }
  return filled
}

/**
 * The cache key: a digest of everything the shell holds, not the package
 * version -- which would be unchanged across a rebuilt page and changed by a
 * release that touched only the server half.
 */
async function shellVersion() {
  const digest = createHash('sha256')
  for (const name of SITE_FILES.filter((n) => !NOT_SHELL.has(n))) {
    digest.update(name)
    digest.update(await fs.readFile(path.join(OUT, name)))
  }
  return digest.digest('hex').slice(0, 12)
}

async function build() {
  if (!fssync.existsSync(path.join(PUBLIC, 'coastline.js'))) {
    console.error('public/coastline.js missing -- run `npm install` first')
    process.exit(1)
  }

  await fs.rm(OUT, { recursive: true, force: true })
  await fs.mkdir(OUT, { recursive: true })
  for (const name of SITE_FILES) {
    const to = path.join(OUT, name)
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.copyFile(sourceOf(name), to)
  }
  await fs.appendFile(path.join(OUT, ENTRY), CHROME_TAG)

  // The built core, not src/: the same DEMO_POSITION the copied live.js runs.
  const { DEMO_POSITION } = await import(
    pathToFileURL(path.join(DIST, 'browser', 'live.js')).href
  )
  const chrome = path.join(OUT, 'site-chrome.js')
  await fs.writeFile(
    chrome,
    fillChrome(await fs.readFile(chrome, 'utf8'), {
      live: DEMO_POSITION,
      snapshot: snapshotPosition()
    })
  )

  // Last: the digest is over the shell as it ships, chrome filled in.
  const worker = path.join(OUT, 'sw.js')
  const version = await shellVersion()
  await fs.writeFile(
    worker,
    fillWorker(await fs.readFile(worker, 'utf8'), version)
  )

  console.log(
    `assembled site-dist/ (${SITE_FILES.length} files, ` +
      `${PLUGIN_MODULES.length} of them the compiled core); service worker ` +
      `precaches ${SHELL.length} (shell ${version})`
  )
}

// Only when run, never on import: the tests read SITE_FILES out of this
// module, and parallel workers importing it would race each other's rm -rf.
if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  await build()
}
