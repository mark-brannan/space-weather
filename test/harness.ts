import { settingsFrom } from '../src/config'
import { Client } from '../src/noaa/client'
import { ValueUpdate } from '../src/parse'
import { Meta, Publisher } from '../src/publisher'
import { ProductContext } from '../src/products/types'

/**
 * A product's real refresh path over a captured payload, with no server, no
 * timers and no network.
 *
 * The stubs satisfy Client and Publisher rather than being cast at the call
 * site: a cast accepts whatever the stubs happen to be, so a product reaching
 * for something they don't have surfaces as an undefined at runtime instead
 * of failing `npm run typecheck`.
 */
export function harness(responses: Record<string, unknown>) {
  const published: { values: ValueUpdate[]; timestamp: string }[] = []
  const metas: Meta[] = []
  const errors: string[] = []

  const publisher: Publisher = {
    meta: (m) => metas.push(...m),
    values: (values, timestamp) => published.push({ values, timestamp }),
    value(path, value, timestamp) {
      this.values([{ path, value }], timestamp)
    },
    // Answers what this harness has already published, so a product that
    // checks the tree before republishing sees what a server would show it:
    // the newest update for that path, not the first, and the `.timestamp`
    // leaf alongside the `.value` one.
    selfPath: (path: string) => {
      for (let i = published.length - 1; i >= 0; i--) {
        const { values, timestamp } = published[i]
        for (const update of values) {
          if (`${update.path}.value` === path) return update.value
          if (`${update.path}.timestamp` === path) return timestamp
        }
      }
      return undefined
    },
    status: () => {},
    fail: () => {},
    error: (m, ...a) => errors.push(`${m} ${a.join(' ')}`),
    debug: () => {},
    // No product exercised here persists a file; a real directory would let
    // one start doing so unnoticed.
    dataDirPath: () => {
      throw new Error('dataDirPath is not stubbed')
    }
  }

  const client: Client = {
    json: async (subPath) => {
      if (!(subPath in responses)) throw new Error(`unstubbed ${subPath}`)
      return responses[subPath]
    },
    // Narrowed rather than cast, so a stub handing a parsed object to a
    // product that asked for text fails here rather than in the parser.
    text: async (subPath) => {
      if (!(subPath in responses)) throw new Error(`unstubbed ${subPath}`)
      const body = responses[subPath]
      if (typeof body !== 'string')
        throw new Error(`stub for ${subPath} is not text`)
      return body
    }
  }

  const ctx: ProductContext = {
    client,
    publisher,
    settings: settingsFrom({}),
    stopped: () => false
  }

  const flat = () => published.flatMap((p) => p.values)
  return {
    publisher,
    client,
    metas,
    errors,
    published,
    ctx,
    valueAt: (path: string) => flat().find((v) => v.path === path)?.value,
    paths: () => flat().map((v) => v.path)
  }
}
