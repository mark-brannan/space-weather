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
  ALARM_NEVER,
  BOUNDARIES,
  DEFAULTS,
  MINOR,
  currentConditions,
  dailyKb,
  formatKb,
  gripLabel,
  ladderFor,
  lineUnder,
  nearestLevel,
  panelSettings,
  quietRule,
  settingsDiffer,
  stepLevel,
  verdictFor,
  withLevel,
  DAYS_PER_MONTH
} from './config-panel.js'
import { ENDPOINTS } from './signalk.js'

const EXPOSED = './PluginConfigurationPanel'
const STATUS_URL = ENDPOINTS.status
// The two paths that say what the sky is doing, read from the webapp's own
// table so a moved path is one edit rather than two.
const SCALES_URL = ENDPOINTS.scalesObserved
const KP_URL = ENDPOINTS.kp
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
// NOAA's own page for the D-RAP model, for the same reason: the checkbox can
// show what it is offering rather than only naming a four-letter product.
const DRAP_URL = 'https://www.swpc.noaa.gov/products/d-region-absorption-predictions-d-rap'

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

  /** The colours the two lines and their grips are drawn in. */
  const EDGE = {
    sound: 'var(--bs-danger)',
    popup: 'var(--bs-warning-text-emphasis)'
  }

  /**
   * One boundary's grip: a slider whose value is a NOAA level.
   *
   * It is `role="slider"` rather than a button because that is what it is --
   * the value is on a scale, the arrow keys move it, and a screen reader reads
   * out where the line sits instead of "button, sound". `aria-valuetext` is
   * what makes that legible: 5 on its own says nothing about what happens at 5.
   */
  const Grip = ({ kind, level, above, onStep, onDragStart }) =>
    h(
      'span',
      {
        role: 'slider',
        tabIndex: 0,
        'aria-label': kind === 'sound' ? 'Sound an alarm at' : 'Show a popup at',
        'aria-valuemin': MINOR,
        'aria-valuemax': ALARM_NEVER,
        'aria-valuenow': level,
        // 5 on its own says nothing about what happens at 5, so the grip
        // announces the sentence rather than the number.
        'aria-valuetext': gripLabel(kind, level),
        title: gripLabel(kind, level),
        className:
          'badge rounded-pill bg-body border border-2 position-absolute' +
          ' user-select-none',
        style: {
          borderColor: EDGE[kind],
          color: EDGE[kind],
          cursor: 'grab',
          // The grip straddles the line, so half of it hangs into the next row.
          // Table row backgrounds paint in document order and would cover that
          // half; a positioned element with a z-index paints above all of them.
          zIndex: 2,
          // Otherwise a vertical drag on a touchscreen scrolls the page, and
          // the browser cancels the pointer sequence out from under the drag.
          touchAction: 'none',
          // A lane per kind, so two lines landing on one row sit side by side
          // instead of on top of each other, and neither grip moves sideways
          // as it moves up and down.
          left: kind === 'sound' ? '0.25rem' : '5.25rem',
          // Centred on the line, which is the row edge it is drawn against.
          ...(above
            ? { top: 0, transform: 'translateY(-50%)' }
            : { bottom: 0, transform: 'translateY(50%)' })
        },
        onKeyDown: (event) => {
          const next = stepLevel(level, event.key)
          // Anything the grip does not claim -- Tab above all -- has to keep
          // working, or the boundary becomes a keyboard trap.
          if (next === null) return
          event.preventDefault()
          onStep(next)
        },
        onPointerDown: onDragStart
      },
      kind
    )

  /**
   * The ladder, and the control. Every row is a consequence of the two lines
   * drawn across it, so the table that showed the setting now *is* the setting:
   * there is nothing on screen that is not either a decision or its result.
   *
   * A line rests on the bottom edge of the row its band opens at, drawn as that
   * row's bottom border -- so the browser places it, and nothing here measures
   * a row height or listens for a resize. `ALARM_NEVER` has no row, so its line
   * is the top border of the first one, where the band above it is empty.
   *
   * Rows are geomagnetic because the rates are, and no single cadence can label
   * all three scales -- see docs/noaa-products.md. The states and the methods
   * do apply to all of them, which is what the note underneath says.
   */
  const Ladder = ({ settings, onChange }) => {
    const body = useRef(null)

    /**
     * Drag: snap the line to whichever edge the pointer is nearest. The row
     * geometry is read once, at pointerdown, because the ladder redraws under
     * the cursor as the value changes and re-measuring mid-drag would chase
     * its own tail.
     */
    const onDragStart = useCallback(
      (kind, key) => (event) => {
        if (event.button !== undefined && event.button !== 0) return
        event.preventDefault()
        const rows = [...(body.current?.children ?? [])]
        if (rows.length === 0) return
        const edges = {}
        for (const row of rows) {
          const box = row.getBoundingClientRect()
          const level = Number(row.dataset.level)
          edges[level] = box.bottom
          if (level === 5) edges[ALARM_NEVER] = box.top
        }
        const move = (moved) => onChange(key, nearestLevel(edges, moved.clientY))
        const done = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', done)
          window.removeEventListener('pointercancel', done)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', done)
        window.addEventListener('pointercancel', done)
      },
      [onChange]
    )

    const { alarmLevel, popupLevel } = settings
    return h(
      'table',
      { className: 'table table-sm align-middle small mb-2' },
      // The instruction goes in the caption rather than in the gutter's own
      // header, where it would set that column's width from its longest word
      // and wrap the whole header row to two lines.
      h(
        'caption',
        { className: 'caption-top pt-0' },
        'Drag a line, or focus one and use the arrow keys.'
      ),
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          // The gutter the grips sit in: wide enough for two lanes of pill.
          // Its name is there but not drawn -- a column reached by header
          // navigation needs one, and on screen the grips are self-evidently
          // what the column is for.
          h(
            'th',
            { scope: 'col', style: { width: '11rem' } },
            h('span', { className: 'visually-hidden' }, 'Thresholds')
          ),
          h('th', { scope: 'col' }, 'Level'),
          h('th', { scope: 'col' }, 'Notification'),
          h('th', { scope: 'col' }, 'What you get'),
          h('th', { scope: 'col' }, 'How often')
        )
      ),
      h(
        'tbody',
        { ref: body },
        ladderFor(alarmLevel, popupLevel).map((row) => {
          // A line rests under the row its band opens at. ALARM_NEVER has no
          // row, so it rests above the top one, where the band is empty.
          const under = BOUNDARIES.filter(
            (b) => lineUnder(settings[b.key]) === row.level
          )
          const over =
            row.level === 5
              ? BOUNDARIES.filter((b) => settings[b.key] === ALARM_NEVER)
              : []
          // The border goes on the cells rather than the row: Bootstrap draws
          // table borders cell by cell, and a border on the `tr` loses to it.
          const cell = {
            borderBottom:
              under.length > 0 ? `2px solid ${EDGE[under[0].kind]}` : undefined,
            borderTop:
              over.length > 0 ? `2px solid ${EDGE[over[0].kind]}` : undefined
          }
          return h(
            'tr',
            {
              key: row.level,
              'data-level': row.level,
              className: ROW_CLASS[row.state]
            },
            h(
              'td',
              { className: 'position-relative', style: cell },
              [...under, ...over].map((boundary) =>
                h(Grip, {
                  key: boundary.kind,
                  kind: boundary.kind,
                  level: settings[boundary.key],
                  above: settings[boundary.key] === ALARM_NEVER,
                  onStep: (next) => onChange(boundary.key, next),
                  onDragStart: onDragStart(boundary.kind, boundary.key)
                })
              )
            ),
            h(
              'th',
              { scope: 'row', className: 'fw-semibold', style: cell },
              `G${row.level} ${row.name}`
            ),
            h('td', { className: 'font-monospace', style: cell }, row.state),
            h('td', { style: cell }, row.effect),
            h('td', { style: cell }, row.rate)
          )
        })
      )
    )
  }

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
  const RightNow = ({ conditions, alarmLevel, popupLevel }) => {
    if (!conditions) return null
    const { levels, worst, observedKp, forecast } = conditions
    const observed = Object.keys(levels)
      .map((letter) => `${letter}${levels[letter]}`)
      .join(' · ')
    // Nothing is "in force" at level 0, and the verdict there is `nominal` --
    // nothing whatever the alarm level, so quoting it says nothing about the
    // setting. On a quiet day the forecast below is the part worth reading.
    const inForce = worst && worst.level > 0
    const verdict = inForce && verdictFor(worst.level, alarmLevel, popupLevel)
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
      // Zero a day, but not zero, for either grid: switched off, the webapp
      // can still be asked for one, and a bill that reads "off" would be
      // understating what a press costs.
      row(
        settings.drapEnabled
          ? 'HF absorption (D-RAP)'
          : 'HF absorption (D-RAP, on demand only)',
        day.drap
      ),
      row(
        settings.auroraEnabled ? 'Aurora grid' : 'Aurora grid (on demand only)',
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

    /**
     * The popup band cannot be louder than the alarm, so moving either one past
     * the other takes it along rather than refusing the change. Refusing would
     * leave the select showing a value the plugin does not hold: `settingsFrom`
     * clamps this same pair on the way in, whatever the panel saved.
     *
     * A popup of "Never" is exempt, in both directions, because it is quieter
     * than every level rather than louder than the alarm. Dragging the alarm up
     * to meet it would silence a plugin nobody asked to silence: turning off
     * the silent popups would take the sound with it.
     */
    const setLevel = useCallback((key, value) => {
      setSaved(false)
      setSettings((previous) => withLevel(previous, key, value))
    }, [])

    const onSubmit = useCallback(
      (event) => {
        event.preventDefault()
        // Normalised on the way out, not just on the way in: a number field
        // hands back a string, and the schema says these are numbers. The
        // plugin would coerce it either way, but the saved configuration is
        // also what the generated form reads on a server without this panel.
        const next = panelSettings(settings)
        // The whole configuration, not a patch over the saved one. Every key in
        // the schema is written explicitly here, which is what makes dropping
        // the rest safe: a superseded key only ever spoke for one of these, and
        // the key that superseded it is now saying so itself, so `settingsFrom`
        // reads the same settings either way. Carrying them forward kept a dead
        // key in the file for the life of the install, where the next person to
        // open it cannot tell it from a setting in force.
        save(next)
        // All of them were just written explicitly, and `settingsFrom` reads
        // those back unchanged, so there is nothing left for it to supply --
        // which is what the notice above is about.
        setRunning(next)
        setSaved(true)
        if (savedTimer.current) clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setSaved(false), 4000)
      },
      [save, settings]
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
          label: 'When to interrupt you',
          help: h(
            'span',
            null,
            quietRule(settings.alarmLevel, settings.popupLevel),
            ' Strong (3) and above is listed whatever the two lines are set' +
              ' to — a storm that size should leave a trace even with the' +
              ' plugin turned all the way down. The states and methods apply' +
              ' to the G, S and R scales and to Kp. How often is geomagnetic,' +
              ' counted from the Kp archive over 1932–2025; the other two' +
              ' scales differ, sharply at 4 and 5, and every rate roughly' +
              ' doubles during the active stretch of a solar cycle. ',
            h(NoaaLink, {
              href: NOAA_SCALES_URL,
              text: 'How NOAA defines the scales'
            })
          )
        },
        h(
          'div',
          null,
          h(Ladder, { settings, onChange: setLevel }),
          h(RightNow, {
            conditions,
            alarmLevel: settings.alarmLevel,
            popupLevel: settings.popupLevel
          })
        )
      ),

      h(Check, {
        id: 'noaa-aurora-enabled',
        checked: settings.auroraEnabled,
        onChange: (value) => set('auroraEnabled', value),
        label: "Keep NOAA's aurora forecast grid up to date",
        help: h(
          'span',
          null,
          'Fetches the grid on the interval below, publishing the probability' +
            ' at the vessel position and keeping the chart overlay tiles' +
            ' current. Off by default on bandwidth: it is the one large' +
            ' payload this plugin fetches. With it off the webapp can still' +
            ' fetch the grid once, when you ask it to. ',
          h(NoaaLink, { href: AURORA_URL, text: "NOAA's aurora forecast" })
        )
      }),

      h(Check, {
        id: 'noaa-drap-enabled',
        checked: settings.drapEnabled,
        onChange: (value) => set('drapEnabled', value),
        label: 'Publish HF absorption (NOAA D-RAP)',
        help: h(
          'span',
          null,
          'The highest radio frequency D-region absorption is blocking.' +
            ' Frequencies below it are absorbed; those above it should get' +
            ' through, barring other factors. NOAA serves one grid covering' +
            ' the whole globe, so it costs the same everywhere: about 3.3 KB' +
            ' on each fetch of the "everything else" interval below, hourly' +
            ' by default. With it off the webapp can still fetch the grid' +
            ' once, when you ask it to. ',
          h(NoaaLink, { href: DRAP_URL, text: "NOAA's D-RAP model" })
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
