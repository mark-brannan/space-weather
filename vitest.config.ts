import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Git worktrees live under .claude/ and each holds a full copy of this
    // repo, so the default globs collect their test files too: `npm test`
    // reports two trees at once and a failure in the other one looks like a
    // failure here.
    exclude: [...configDefaults.exclude, '**/.claude/**']
  }
})
