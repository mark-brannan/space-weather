/**
 * The `./config` subpath as it was before `settings.ts` and `schema.ts` were
 * split out of it, kept so a consumer importing `space-weather/config` still
 * resolves. Nothing in the core imports this file.
 */
export * from './settings.js'
export { schema } from './schema.js'
