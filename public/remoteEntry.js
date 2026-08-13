// The plugin's configuration screen, as the admin UI's own React tree.
//
// Signal K opts a package in with the `signalk-plugin-configurator` keyword;
// signalk-server's Configuration.tsx reads it and then renders *only* this
// component, so every setting has to be here or it becomes unreachable. The
// JSON schema in src/config.ts stays as it is: a server that predates the
// keyword, or one where this fails to load, still gets a working form out of
// it, and it remains where defaults and the migration of superseded keys live.
//
// What the server does with this file, all of it read out of signalk-server
// rather than assumed:
//
//   - It is served from public/ at /<package name>/, and the *filename* is the
//     contract -- serverroutes.ts injects `<script src="/<pkg>/remoteEntry.js">`
//     into the admin UI's index.html for every configurator it finds.
//   - That tag carries `type="module"` because this package is `"type":
//     "module"`, which puts the loader on its ESM path: it `import()`s this
//     file and requires `init` and `get` as named exports. A classic webpack
//     UMD container would never be looked for.
//   - `get('./PluginConfigurationPanel')` must resolve to a factory returning
//     `{ default: Component }`, and the component is handed exactly two props.
//   - The tag is undeferred and unconditional, so this file is fetched and
//     evaluated on every admin page load whether or not anyone opens this
//     plugin. Hence no bundle and no dependencies: the top level of this
//     module defines functions and does nothing else.
//
// React is the host's own instance, taken from the module-federation share
// scope it hands to `init`. Sharing it is not optional -- two React copies in
// one tree break hooks -- and it is why the admin UI's error boundary names
// React 19 compatibility. Taking it from the scope means this file has no
// opinion about the version at all.
import {
  DEFAULTS,
  ALARM_LEVEL_OPTIONS,
  SCALE_NAMES,
  currentConditions,
  dailyKb,
  formatKb,
  ladderFor,
  panelSettings,
  settingsDiffer,
  verdictFor,
  DAYS_PER_MONTH
} from './config-panel.js'

const EXPOSED = './PluginConfigurationPanel'
const API = '/signalk/v1/api'
const STATUS_URL = `${API}/signalk-noaa-space-weather/status`
// The two paths the plugin already publishes that say what the sky is doing.
const SCALES_URL = `${API}/vessels/self/environment/noaa/swpc/scales/observations/latest`
const KP_URL = `${API}/vessels/self/environment/noaa/swpc/kp`
// The human-readable page behind the bulletin this setting forwards, so the
// checkbox can show what it is offering rather than only naming it.
const ADVISORY_OUTLOOK_URL =
  'https://www.spaceweather.gov/products/space-weather-advisory-outlook'
// NOAA's own explanation of the G/S/R scales the ladder is built on, and of
// the aurora forecast behind the grid. Both are the human-facing
// spaceweather.gov pages rather than the machine feeds under services.*.
const NOAA_SCALES_URL = 'https://www.spaceweather.gov/noaa-scales-explanation'
const AURORA_URL =
  'https://www.spaceweather.gov/communities/aurora-dashboard-experimental'

let React = null

/**
 * Resolve a shared module from one share-scope entry. Both shapes the loader
 * can produce are accepted: `lib()` when the host has already loaded it, and
 * `get()` -- which may hand back the module or a factory for it -- when it has
 * not. Its own fallback scope (used when the host is not itself federated)
 * only implements the second.
 */
async function moduleFrom(entry) {
  if (!entry) return null
  if (typeof entry.lib === 'function') {
    const loaded = entry.lib()
    if (loaded) return loaded
  }
  if (typeof entry.get === 'function') {
    const factory = await entry.get()
    return typeof factory === 'function' ? factory() : factory
  }
  return null
}

/** A resolved module as React itself, whether it arrives as ESM or CJS. */
function asReact(module) {
  if (!module) return null
  if (typeof module.createElement === 'function') return module
  if (module.default && typeof module.default.createElement === 'function') {
    return module.default
  }
  return null
}

async function resolveReact(shareScope) {
  const entries = (shareScope && shareScope.react) || {}
  for (const version of Object.keys(entries)) {
    try {
      const react = asReact(await moduleFrom(entries[version]))
      if (react) return react
    } catch {
      // Try the next version rather than failing on one bad entry.
    }
  }
  return null
}

export async function init(shareScope) {
  React = await resolveReact(shareScope)
}

export async function get(module) {
  if (module !== EXPOSED) return undefined
  if (!React) {
    // Reaches the user as the admin UI's "configuration panel could not be
    // loaded" boundary, with this line under "Technical details". The schema
    // form is the way out, and it is still in package.json.
    throw new Error(
      'No shared React in the host share scope; cannot render the panel.'
    )
  }
  const Panel = createPanel(React)
  return () => ({ default: Panel })
}

function createPanel(React) {
  const h = React.createElement
  const { useCallback, useEffect, useMemo, useRef, useState } = React

  /** A labelled block, spaced like the fields the generated form produces. */
  const Field = ({ label, htmlFor, help, children }) =>
    h(
      'div',
      { className: 'mb-4' },
      label &&
        h('label', { className: 'form-label fw-semibold', htmlFor }, label),
      children,
      help && h('div', { className: 'form-text' }, help)
    )

  /** A link out to NOAA, opened away from the admin UI. */
  const NoaaLink = ({ href, text }) =>
    h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text)

  const Check = ({ id, checked, onChange, label, help }) =>
    h(
      'div',
      { className: 'form-check mb-4' },
      h('input', {
        className: 'form-check-input',
        type: 'checkbox',
        id,
        checked,
        onChange: (event) => onChange(event.target.checked)
      }),
      h(
        'label',
        { className: 'form-check-label fw-semibold', htmlFor: id },
        label
      ),
      help && h('div', { className: 'form-text' }, help)
    )

  /** Bootstrap's own row tints, so the ladder reads in either theme. */
  const ROW_CLASS = {
    alarm: 'table-danger',
    warn: 'table-warning',
    alert: '',
    // Green for the rows that do nothing but get written down. It reads as
    // "fine" rather than as "greyed out", which is what these levels are: a
    // storm the plugin saw and deliberately stayed quiet about.
    normal: 'table-success',
    nominal: 'table-success'
  }

  /**
   * The whole consequence of the setting above, redrawn as it changes: one
   * setting decides four outcomes across five levels, and read as a sentence
   * that has to be reassembled in the head before it can be judged.
   *
   * Rows are geomagnetic because the rates are, and no single cadence can
   * label all three scales -- see docs/noaa-products.md. The states and the
   * methods do apply to all of them, which is what the note underneath says.
   */
  const Ladder = ({ alarmLevel }) =>
    h(
      'table',
      { className: 'table table-sm align-middle small mb-2' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { scope: 'col' }, 'Level'),
          h('th', { scope: 'col' }, 'Notification'),
          h('th', { scope: 'col' }, 'What you get'),
          h('th', { scope: 'col', className: 'text-end' }, 'Days a year')
        )
      ),
      h(
        'tbody',
        null,
        ladderFor(alarmLevel).map((row) =>
          h(
            'tr',
            { key: row.level, className: ROW_CLASS[row.state] },
            h(
              'th',
              { scope: 'row', className: 'fw-semibold' },
              `G${row.level} ${row.name}`
            ),
            h('td', { className: 'font-monospace' }, row.state),
            h('td', null, row.effect),
            h(
              'td',
              { className: 'text-end font-monospace' },
              row.stormDaysPerYear
            )
          )
        )
      )
    )

  /**
   * Where the sky is on the ladder above, right now. "Extreme (5)" is an
   * abstraction; "this is a G2, and at your setting that is recorded only" is
   * the same choice with today's answer attached, on the screen where the
   * choice is being made.
   *
   * Absent when the plugin has published nothing yet, rather than reading as
   * quiet: the card header immediately above this carries the plugin's status
   * and last error, which is the better place to learn that it is not working.
   */
  const RightNow = ({ conditions, alarmLevel }) => {
    if (!conditions) return null
    const { levels, worst, observedKp, forecast } = conditions
    const observed = Object.keys(levels)
      .map((letter) => `${letter}${levels[letter]}`)
      .join(' · ')
    // Nothing is "in force" at level 0, and the verdict there is `nominal` --
    // nothing whatever the alarm level, so quoting it says nothing about the
    // setting. On a quiet day the forecast below is the part worth reading.
    const inForce = worst && worst.level > 0
    const verdict = inForce && verdictFor(worst.level, alarmLevel)
    return h(
      'div',
      { className: 'small mb-3' },
      h('span', { className: 'fw-semibold me-2' }, 'Right now'),
      observed && h('span', { className: 'font-monospace me-2' }, observed),
      observedKp !== null && `Kp ${observedKp.toFixed(2)}. `,
      worst && !inForce && 'No storm in force.',
      verdict &&
        h(
          'span',
          null,
          `The worst in force is ${worst.letter}${worst.level}, which at this`,
          ' setting is ',
          h('span', { className: 'fw-semibold' }, verdict.state),
          ` — ${verdict.effect}.`
        ),
      forecast &&
        ` Forecast to reach Kp ${forecast.kp.toFixed(2)}` +
          `${forecast.level > 0 ? ` (G${forecast.level})` : ''} in the next` +
          ' 24 hours.'
    )
  }

  /**
   * What the two intervals cost, per day and per month, at the values in the
   * form right now. The schema description this replaces could only quote the
   * figure for the default interval, and quietly stayed at that figure when
   * the interval moved -- which is the defect this panel exists to fix.
   */
  const Budget = ({ settings }) => {
    const day = dailyKb(settings)
    const row = (label, kb, rule) =>
      h(
        'div',
        {
          className:
            'd-flex justify-content-between' +
            (rule ? ' border-top pt-1 mt-1' : '') +
            (label === 'Per day' ? ' fw-semibold' : '')
        },
        h('span', null, label),
        h('span', { className: 'font-monospace' }, formatKb(kb))
      )
    return h(
      'div',
      { className: 'bg-body-tertiary border rounded p-3 small' },
      row('Observations, forecasts and alerts', day.other),
      row(
        settings.auroraEnabled ? 'Aurora grid' : 'Aurora grid (off)',
        day.aurora
      ),
      row(
        settings.sendAdvisoryOutlook
          ? 'Weekly and daily bulletins'
          : 'Daily bulletin',
        day.fixed
      ),
      row('Per day', day.total, true),
      row('Per month', day.total * DAYS_PER_MONTH),
      h(
        'div',
        { className: 'form-text mt-2 mb-0' },
        'Gzipped transfer sizes, measured in docs/noaa-products.md.'
      )
    )
  }

  return function PluginConfigurationPanel({ configuration, save }) {
    const [settings, setSettings] = useState(() => panelSettings(configuration))
    const [running, setRunning] = useState(null)
    const [conditions, setConditions] = useState(null)
    const [saved, setSaved] = useState(false)
    const savedTimer = useRef(null)

    // Read once, on mount. Re-reading after a save would race the restart the
    // save triggers and could answer with the settings being replaced; the
    // save itself is the more reliable signal, and updates `running` below.
    // Nothing here polls: a configuration screen is open for a minute, and the
    // slowest thing behind these paths moves on an hour.
    useEffect(() => {
      let current = true
      const read = (url) =>
        fetch(url, { credentials: 'include' })
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null)

      read(STATUS_URL).then((body) => {
        if (current) setRunning(body?.settings ?? null)
      })
      Promise.all([read(SCALES_URL), read(KP_URL)]).then(([scales, kp]) => {
        if (current) setConditions(currentConditions(scales, kp))
      })
      return () => {
        current = false
      }
    }, [])

    useEffect(
      () => () => {
        if (savedTimer.current) clearTimeout(savedTimer.current)
      },
      []
    )

    const set = useCallback((key, value) => {
      setSaved(false)
      setSettings((previous) => ({ ...previous, [key]: value }))
    }, [])

    const onSubmit = useCallback(
      (event) => {
        event.preventDefault()
        // Normalised on the way out, not just on the way in: a number field
        // hands back a string, and the schema says these are numbers. The
        // plugin would coerce it either way, but the saved configuration is
        // also what the generated form reads on a server without this panel.
        const next = panelSettings(settings)
        // Everything the panel knows, every time: the schema's five keys are
        // written explicitly so a configuration still carrying a superseded
        // one stops depending on the migration to mean what it says.
        save({ ...configuration, ...next })
        // All five were just written explicitly, and `settingsFrom` reads those
        // back unchanged, so there is nothing left for it to supply -- which is
        // what the notice above is about.
        setRunning(next)
        setSaved(true)
        if (savedTimer.current) clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setSaved(false), 4000)
      },
      [configuration, save, settings]
    )

    const differs = useMemo(
      () => settingsDiffer(panelSettings(configuration), running),
      [configuration, running]
    )

    return h(
      'form',
      { onSubmit },

      differs &&
        h(
          'div',
          { className: 'alert alert-warning py-2 small' },
          'This plugin is running values that were never saved \u2014 defaults,' +
            ' or a setting carried over from an older release. Saving writes' +
            ' what is shown below, and the two will agree from then on.'
        ),

      h(Check, {
        id: 'noaa-advisory',
        checked: settings.sendAdvisoryOutlook,
        onChange: (value) => set('sendAdvisoryOutlook', value),
        label: 'Send the weekly Advisory Outlook',
        help: h(
          'span',
          null,
          'One notification a week, never audible. ',
          h(NoaaLink, {
            href: ADVISORY_OUTLOOK_URL,
            text: 'See what NOAA publishes'
          })
        )
      }),

      h(
        Field,
        {
          label: 'Sound an alarm at…',
          htmlFor: 'noaa-alarm-level',
          help: h(
            'span',
            null,
            'The states and methods apply to the G, S and R scales and to Kp.' +
              ' The rates are geomagnetic storm days in a median year,' +
              ' measured over 1932–2025; the other two scales differ, sharply' +
              ' at 4 and 5, and every rate roughly doubles during the active' +
              ' stretch of a solar cycle. ',
            h(NoaaLink, {
              href: NOAA_SCALES_URL,
              text: 'How NOAA defines the scales'
            })
          )
        },
        h(
          'div',
          null,
          h(
            'select',
            {
              className: 'form-select mb-3',
              id: 'noaa-alarm-level',
              value: settings.alarmLevel,
              onChange: (event) => set('alarmLevel', Number(event.target.value))
            },
            ALARM_LEVEL_OPTIONS.map((option) =>
              h(
                'option',
                { key: option.value, value: option.value },
                `${SCALE_NAMES[option.value]} (${option.value})` +
                  `${option.value < 5 ? ' and above' : ''} — ${option.rate}`
              )
            )
          ),
          h(Ladder, { alarmLevel: settings.alarmLevel }),
          h(RightNow, {
            conditions,
            alarmLevel: settings.alarmLevel
          })
        )
      ),

      h(Check, {
        id: 'noaa-aurora-enabled',
        checked: settings.auroraEnabled,
        onChange: (value) => set('auroraEnabled', value),
        label: "Fetch NOAA's aurora forecast grid",
        help: h(
          'span',
          null,
          'Draws the aurora map in this plugin\u2019s webapp, serves it as chart' +
            ' overlay tiles, and publishes the probability at the vessel' +
            ' position. Off by default on bandwidth: it is the one large' +
            ' payload this plugin fetches. Nothing is fetched until the' +
            ' vessel has a position. ',
          h(NoaaLink, { href: AURORA_URL, text: "NOAA's aurora forecast" })
        )
      }),

      h(
        'div',
        { className: 'row g-3 mb-3' },
        h(
          'div',
          { className: 'col-sm-6' },
          h(Field, {
            label: 'Aurora, every (minutes)',
            htmlFor: 'noaa-aurora-interval',
            children: h('input', {
              className: 'form-control',
              id: 'noaa-aurora-interval',
              type: 'number',
              // `min` is the whole of the validation, and `step` has to stay
              // off it: a step of 5 from a base of 1 makes 60 and 120 -- the
              // two defaults -- step mismatches, and an invalid control blocks
              // the form silently. Nothing here submitted at all.
              min: 1,
              step: 'any',
              disabled: !settings.auroraEnabled,
              value: settings.auroraInterval,
              onChange: (event) => set('auroraInterval', event.target.value)
            })
          })
        ),
        h(
          'div',
          { className: 'col-sm-6' },
          h(Field, {
            label: 'Everything else, every (minutes)',
            htmlFor: 'noaa-update-interval',
            children: h('input', {
              className: 'form-control',
              id: 'noaa-update-interval',
              type: 'number',
              min: 1,
              step: 'any',
              value: settings.updateInterval,
              onChange: (event) => set('updateInterval', event.target.value)
            })
          })
        )
      ),

      h(Field, { children: h(Budget, { settings }) }),

      h(
        'div',
        { className: 'd-flex align-items-center gap-3' },
        h('button', { className: 'btn btn-primary', type: 'submit' }, 'Submit'),
        saved && h('span', { className: 'text-success small' }, 'Saved.')
      )
    )
  }
}
