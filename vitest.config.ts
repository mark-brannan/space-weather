import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Git worktrees live under .claude/ and each holds a full copy of this
    // repo, so the default globs collect their test files too: `npm test`
    // reports two trees at once and a failure in the other one looks like a
    // failure here.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
    // Vitest's 5s default is an x64 number, and CI runs this suite under QEMU
    // armv7 emulation for the Cerbo GX -- where the whole run takes ~34s
    // against ~2s here, so anything above roughly 300ms locally is already
    // near the limit and contention decides the rest. That produced a timeout
    // on a test doing no more work than it did the day before, which is a
    // false failure: it says "your plugin may not work on 32-bit ARM" about a
    // pure function over three fixtures.
    //
    // Deliberately not larger. The plugin registry scores this repo with a 60
    // second cap on install, build and test together, so a genuinely hung test
    // still has to fail well inside it rather than eat the whole budget.
    testTimeout: 15000
  }
})
