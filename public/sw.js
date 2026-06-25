// Offline service worker — registered ONLY for users the admin has granted the
// offline-play entitlement (see main.ts applyOffline). It caches the app shell and
// assets as they load (runtime stale-while-revalidate), so Skirmish vs AI launches
// and runs with no network. Asset filenames are content-hashed, so there's no fixed
// precache list — whatever the game fetches online is cached for the next offline run.
const CACHE = 'fe-offline-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// "unregister" message from the client (entitlement revoked) → drop caches + self-destruct
self.addEventListener('message', (e) => {
  if (e.data === 'fe-offline-off') {
    e.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      await self.registration.unregister();
    })());
  }
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                 // same-origin only (skip GA, MP relays, etc.)
  // never cache dynamic/API endpoints — always go to the network for those
  if (/^\/(auth|admin|features|intel|replay|replays|room|rooms|ws|api|stats|sw\.js$)/.test(url.pathname)) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok && (res.type === 'basic' || res.type === 'default')) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    // stale-while-revalidate: serve cache instantly + refresh in the background; on a
    // cold miss go to the network; if that fails (offline) fall back to the app shell.
    if (cached) { network; return cached; }
    const net = await network;
    if (net) return net;
    if (req.mode === 'navigate') {
      const shell = (await cache.match('/')) || (await cache.match('/index.html'));
      if (shell) return shell;
    }
    return new Response('offline', { status: 503, statusText: 'offline' });
  })());
});
