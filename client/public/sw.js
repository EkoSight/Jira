/* TaskFlow service worker — app shell caching + offline reads. */
// bumped to clear payroll copies cached by earlier versions, then for the new icons and branding,
// then so no copy of call data from before the calling screens is kept
const VERSION = 'taskflow-v4';
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;
// a recording shared to TaskFlow from the phone waits here for "Which call is this?"
// (the same names as src/lib/sharedFiles.js)
const SHARE_CACHE = 'taskflow-shared-recordings';
const sharedKey = (id) => `/__shared/recording/${encodeURIComponent(id)}`;

const SHELL_ASSETS = ['/', '/index.html', '/manifest.webmanifest', '/brand/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS).catch(() => undefined)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION) && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

const isApiRequest = (url) => url.pathname.includes('/api/');

/**
 * A recording shared from the phone (the manifest's share target): kept for a
 * moment, then the "Which call is this?" page opens. Nothing is sent to the
 * server until the person picks the call there.
 */
async function receiveShare(request) {
  let id = 'none';
  try {
    const form = await request.formData();
    const file = form.getAll('recording').find((f) => f && typeof f === 'object' && f.size > 0);
    if (file) {
      id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const cache = await caches.open(SHARE_CACHE);
      // only the latest share is kept
      for (const key of await cache.keys()) await cache.delete(key);
      await cache.put(new Request(sharedKey(id)), new Response(file, {
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name || 'recording'),
          'X-Last-Modified': String(file.lastModified || ''),
        },
      }));
    }
  } catch {
    id = 'none';
  }
  return Response.redirect(`/sales/share-recording?shared=${id}`, 303);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method === 'POST' && url.origin === self.location.origin && url.pathname === '/share-recording') {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET') return;

  if (url.origin !== self.location.origin) return;
  // public pages (enquiry forms, the privacy notice) and short-lived links to call
  // recordings and the Android app: never kept on a device
  if (/\/api\/[^/]+\/s\//.test(url.pathname)) return;
  // calls on company phones: what is going on now, recordings and phone settings are
  // always fresh, and never kept by the offline copy
  if (/\/api\/[^/]+\/(sales\/calls|sales\/calling|device)(\/|$)/.test(url.pathname)) return;
  // email marketing's public pages and tracking (unsubscribe, forms, opens,
  // clicks) are for recipients: never cached on a colleague's device
  if (/\/api\/[^/]+\/m\//.test(url.pathname)) return;
  // pay estimates are never kept on a device, and never shown from an old copy
  if (/\/api\/[^/]+\/payroll(\/|$)/.test(url.pathname)) return;
  // profile photos (and the private originals) are never kept by the offline copy:
  // a deleted photo must not linger on a shared device
  if (/\/api\/[^/]+\/photos(\/|$)/.test(url.pathname)) return;

  // API: network first, fall back to the last good response so the board still
  // renders something useful when the phone drops off the network.
  if (isApiRequest(url)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(DATA_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) {
            const headers = new Headers(cached.headers);
            headers.set('X-Taskflow-Offline', 'true');
            return new Response(await cached.blob(), { status: 200, headers });
          }
          return new Response(JSON.stringify({ error: 'You are offline' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }),
    );
    return;
  }

  // Navigations: serve the cached shell when offline so the PWA opens.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))),
    );
    return;
  }

  // Static assets: cache first, refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
