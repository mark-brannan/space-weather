// The site's own framing, and the only thing on the page that is not the
// shipping webapp. scripts/build-site.mjs appends one script tag for this
// module to a verbatim copy of public/index.html: the page a visitor gets is
// the page a boat owner gets, so nothing here may edit what that page draws.
// It says what the page is, when a saved capture was taken, where to get the
// real thing -- and installs the title, icon, manifest and service worker.
import { LIVE, onPosition, position, snapshot } from './signalk.js'

const REPO = 'https://github.com/mark-brannan/signalk-noaa-space-weather'

// The two data layers are one URL apart, and the link between them is the
// honest way to say what each is.
const LIVE_URL = './'
const SNAPSHOT_URL = './?snapshot'

// Sized and ruled like the page's own footstrip, which it sits under.
const STYLE = `
.demo-note {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--grid);
  color: var(--text-dim);
  font-size: 0.68rem;
  line-height: 1.5;
}
.demo-note a { color: var(--amber); }
.demo-note b { color: var(--text); font-weight: 600; }
.demo-note .demo-links { white-space: nowrap; margin-left: 6px; }
`

/**
 * UTC, to the minute: NOAA publishes in UTC and the capture is one moment, so
 * the reader's own zone would only suggest the page knows when they are.
 */
const captured = (iso) => {
  const date = new Date(iso)
  return isNaN(date)
    ? String(iso)
    : date.toUTCString().replace(/:\d\d GMT$/, ' UTC')
}

const formatPosition = ({ latitude, longitude }) =>
  `${Math.abs(latitude)}°${latitude >= 0 ? 'N' : 'S'} ` +
  `${Math.abs(longitude)}°${longitude >= 0 ? 'E' : 'W'}`

document.title = 'Space Weather'

const link = (rel, href, type) => {
  const el = document.createElement('link')
  el.rel = rel
  el.href = href
  if (type) el.type = type
  document.head.append(el)
}
link('icon', './icon.svg', 'image/svg+xml')
link('manifest', './manifest.webmanifest')

const style = document.createElement('style')
style.textContent = STYLE
document.head.append(style)

const plugin = `<a href="${REPO}">signalk-noaa-space-weather</a>`
const install = `<a href="${REPO}#installation">Run it on your boat</a>`
const links = (other) => `<span class="demo-links">${other} · ${install}</span>`

// The position is the one thing on the page a reader would otherwise take as
// theirs. The two blanks are filled by scripts/build-site.mjs's fillChrome --
// live from the core's DEMO_POSITION, the snapshot from the position it was
// captured at -- not hand-typed here, so neither can drift from its data.
const where = (fix) =>
  fix
    ? `at your device's position, ${formatPosition(fix)}`
    : 'for a stand-in position at __DEMO_POSITION__'

const note = document.createElement('p')
note.className = 'demo-note'
const liveNote = (fix) =>
  `Live NOAA data, fetched from your browser by the ${plugin} plugin's own` +
  ` code ${where(fix)}.` +
  links(`<a href="${SNAPSHOT_URL}">Saved snapshot</a>`)
note.innerHTML = LIVE
  ? liveNote(position())
  : `<span id="demoCaptured">A saved NOAA snapshot — not live data.</span>` +
    ` From the ${plugin} plugin, for a stand-in position at __SNAPSHOT_POSITION__.` +
    links(`<a href="${LIVE_URL}">Live data</a>`)

document.querySelector('.shell').append(note)

if (LIVE) {
  onPosition((fix) => {
    note.innerHTML = liveNote(fix)
  })
} else {
  // Unawaited: a snapshot that fails to load still leaves the note saying
  // what this is, without a date.
  snapshot()
    .then((data) => {
      document.getElementById('demoCaptured').innerHTML =
        `A saved NOAA snapshot, captured <b>${captured(data.capturedAt)}</b> — not live data.`
    })
    .catch(() => {})
}

// Last, and failure-tolerant: a site that cannot register a worker still
// works online. After load, to keep the install off the first paint.
// ?snapshot's top-level await can hold this module past `load`, so a page
// already loaded registers now rather than waiting for an event that is gone.
if ('serviceWorker' in navigator) {
  const register = () =>
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  if (document.readyState === 'complete') register()
  else addEventListener('load', register)
}
