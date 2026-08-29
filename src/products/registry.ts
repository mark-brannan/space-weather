/**
 * The list of NOAA products this plugin runs. Adding a data source means
 * adding one module here and nothing else.
 *
 * It lives beside the products rather than in index.ts because two callers now
 * need it and only one of them has a filesystem. index.ts owns the plugin
 * lifecycle, the HTTP routes and the tile renderer, so its import closure
 * reaches `fs` and `path`; the browser demo (#239) drives these same products
 * against NOAA directly and cannot load any of that. Re-exported from index.ts,
 * so `PRODUCTS` is still one list and every existing importer is unchanged.
 *
 * test/browser-closure.test.ts walks this file the way a browser resolves
 * imports, which is what keeps that split from quietly closing again.
 */
import { advisory } from './advisory.js'
import { aIndex } from './aIndex.js'
import { alerts } from './alerts.js'
import { aurora } from './aurora.js'
import { drap } from './drap.js'
import { f107 } from './f107.js'
import { goesFlux } from './goesFlux.js'
import { kp } from './kp.js'
import { outlook27 } from './outlook27.js'
import { scales } from './scales.js'
import { solarWind } from './solarWind.js'
import { sunspot } from './sunspot.js'
import type { Product } from './types.js'

export const PRODUCTS: Product[] = [
  scales,
  kp,
  outlook27,
  solarWind,
  f107,
  goesFlux,
  aIndex,
  sunspot,
  aurora,
  drap,
  advisory,
  alerts
]
