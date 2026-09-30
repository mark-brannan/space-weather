// The shell only. NOAA's responses stay out of the Cache API: the products
// already cache them through site/store.js, and a second copy of a ~900 KB grid
// would double what a phone holds with neither copy authoritative on its age.
// snapshot.json stays out too: it is data, the ?snapshot layer's, and a reader
// who never asks for the saved capture should not carry 800 KB of it.
//
// SHELL and VERSION are written by scripts/build-site.mjs from the site's own
// file list -- a hand-kept list would be a second, quietly wrong answer.
const VERSION = '__VERSION__'
const SHELL = __SHELL__

const CACHE_PREFIX = 'noaa-space-weather-shell-'
const CACHE = `${CACHE_PREFIX}${VERSION}`

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      // Don't sit in `waiting` behind a tab the reader has already left.
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          // Our own prefix only. A worker's scope is a path but the Cache API
          // is origin-wide, and this app may well be served from a path under
          // a site that has its own.
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Anything that is not this app's own origin is NOAA, and NOAA is the one
  // thing here that must always be the live answer.
  if (url.origin !== self.location.origin) return
  // Same origin, but data rather than shell: straight to the network, never
  // into the cache the shell's cache-first read would then serve forever.
  if (url.pathname.endsWith('/snapshot.json')) return

  // Any path is the shell: an installed app restores to its own start URL.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches
        .match('./index.html')
        .then((hit) => hit ?? fetch(request))
        .catch(() =>
          caches.match('./index.html').then((hit) => hit ?? Response.error())
        )
    )
    return
  }

  // Cache-first: a new build is a new cache, so a hit is never stale.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          // Cloned before the body is read: a response is consumed once.
          if (response.ok && response.type === 'basic') {
            const copy = response.clone()
            // Held open: the worker may be killed the moment `respondWith`
            // settles, which is before a bare `.then` would have run.
            event.waitUntil(
              caches.open(CACHE).then((cache) => cache.put(request, copy))
            )
          }
          return response
        })
    )
  )
})
