## What and why

<!--
Motivation and approach, not mechanics — the diff shows what changed. If this
closes an issue, say so here: closes #123
-->

## Changelog line

<!--
One line, as it would read in CHANGELOG.md, and say whether it is a patch or a
minor. Minor is what a boat owner can observe: a new path, a new product, a
change in what gets published or how loudly, or a change in what the webapp
tells its reader. A fix, or plumbing only this plugin's own webapp consumes, is
a patch. See AGENTS.md → Versions.
-->

- [ ] patch
- [ ] minor
- [ ] major (breaking — describe the break above)

## Checks

- [ ] `npm run format:check` passes
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] Branched from latest `main` (rebased, not merged)
- [ ] One logical change — a refactor and a behaviour change are two pull requests

## Tests

<!--
What the new tests assert: values, states, paths, unit conversions, boundaries.
If a parser changed, name the fixture in examples/ it runs against, and say
whether you captured a new dated one.
-->

## Anything the maintainer should look at

<!--
A design choice you were unsure about, a constraint in CLAUDE.md you think this
brushes against, or a screenshot if the UI changed. Delete if there is nothing.
-->
